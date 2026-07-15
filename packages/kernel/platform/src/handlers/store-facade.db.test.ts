/**
 * Store-facade DB tests (the serializable-shaped HandlerDb over TenantDb).
 *
 * FAIL-THE-FIX, against a REAL Postgres isolated schema with a product table built by the SAME
 * `buildProductTables` a deployment uses + registered in the REAL deny-by-default Set. These prove the
 * facade is not a parallel DB path: it delegates to the TenantDb chokepoint, so the tenant predicate
 * is STRUCTURAL (cross-tenant rows are invisible), an undeclared store fail-closes, snake↔camel maps
 * correctly, and `transaction()` populates the app.current_tenant GUC (RLS-ready).
 *
 * Skips when DATABASE_URL is absent (turbo passes it in CI; a credential-free run self-skips).
 */
import { forTenant, INJECTED_COLUMN_NAMES } from '@rayspec/db';
import {
  buildProductTables,
  injectedColumnLinesSql,
  makeDbWithSchema,
  parseCreateTableColumnNames,
  registerScopedTables,
} from '@rayspec/db/testing';
import type { StoreSpec } from '@rayspec/spec';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeHandlerDb, StoreInputError } from './store-facade.js';

const SCHEMA = 'rayspec_test_handlerdb';
const TENANT_A = '00000000-0000-0000-0000-0000000000aa';
const TENANT_B = '00000000-0000-0000-0000-0000000000bb';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed SECURITY suite (the TenantDb chokepoint) must never silently
// self-skip to a false green. When the DB is REQUIRED but absent, hard-fail at collection, never skip.
if (requireDb && !hasDb) {
  throw new Error(
    'store-facade.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a security-load-bearing suite.',
  );
}

// Ran-counter for the un-skippable ran-guard at the BOTTOM of this file. Every DB `it()` in the main
// (skipIf-gated) describe increments it; a SEPARATE, never-skipped describe then asserts `testsRan > 0`
// when the DB is required. This closes the false-green the collection-throw above does NOT catch: if a
// future edit turned every `it()` into `it.skip()` WHILE `hasDb` is true, the collection-throw never
// fires (DATABASE_URL is present) and the suite would go green with ZERO DB assertions. (An `afterAll`
// inside the main describe would NOT catch it: vitest marks a suite whose tests are ALL skipped as a
// skipped FILE and does not run its afterAll — empirically verified, vitest 4.1.9 — so the guard must
// live in an independent, always-run describe, exactly as store-soft-delete.db.test.ts does it.)
let testsRan = 0;

// A throwaway product store (declared OUTSIDE the platform — this is a TEST fixture, not platform src).
const meetingsStore: StoreSpec = {
  name: 'meetings',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: false },
    { name: 'completed', type: 'boolean', nullable: false, unique: false },
    // A nullable timestamp business column — exercises the SF-2 ISO-string → Date coercion.
    { name: 'scheduled_at', type: 'timestamp', nullable: true, unique: false },
    // A nullable jsonb business column — exercises the SF1-JSONB-REGRESSION fix (object/array allowed).
    { name: 'metadata', type: 'jsonb', nullable: true, unique: false },
    // A nullable business column carrying a GLOBAL (non-tenant-scoped) UNIQUE in the DDL below — the
    // worst-case upsert conflict target (the cross-tenant-write attack surface C1's setWhere guards).
    { name: 'business_key', type: 'text', nullable: true, unique: false },
  ],
  foreignKeys: [],
};

// ensure-exists fixture — a store whose ONLY business column is the conflict target, so an ensure-exists upsert
// (`upsert('tags',['name'],{name})`) yields a genuinely EMPTY DO-UPDATE SET (the empty-set crash case).
const tagsStore: StoreSpec = {
  name: 'tags',
  columns: [{ name: 'name', type: 'text', nullable: false, unique: true }],
  foreignKeys: [],
};

// multi-unique fixture — TWO INDIVIDUAL global uniques (business_key AND vendor). A conflict on `vendor` while
// the ON CONFLICT target is `business_key` is the "DIFFERENT unique" 23505 the sanitizer must neutralize.
const gizmosStore: StoreSpec = {
  name: 'gizmos',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: false },
    { name: 'business_key', type: 'text', nullable: true, unique: true },
    { name: 'vendor', type: 'text', nullable: true, unique: true },
  ],
  foreignKeys: [],
};

// composite-unique fixture — a COMPOSITE global unique (business_key, vendor), no individual uniques.
const pairsStore: StoreSpec = {
  name: 'pairs',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: false },
    { name: 'business_key', type: 'text', nullable: false, unique: false },
    { name: 'vendor', type: 'text', nullable: false, unique: false },
  ],
  foreignKeys: [],
};

// tenant-scoped-unique fixture — a TENANT-SCOPED unique (tenant_id, business_key): the RECOMMENDED secure pattern, where
// two tenants may each hold the same business_key and a foreign key never conflicts.
const scopedStore: StoreSpec = {
  name: 'scoped',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: false },
    { name: 'business_key', type: 'text', nullable: false, unique: false },
  ],
  foreignKeys: [],
};

// SOFT-DELETE fixture — a store that OPTS INTO soft delete. buildProductTables marks its runtime table
// in the soft-delete registry, so the facade folds `deleted_at IS NULL` into reads/updates + stamps the
// tombstone on delete (the richer read/write surface — views/workflows/handlers — matching the CRUD routes).
const notesStore: StoreSpec = {
  name: 'notes',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: false },
    { name: 'done', type: 'boolean', nullable: false, unique: false },
  ],
  foreignKeys: [],
  softDelete: true,
};

// SOFT-DELETE + UNIQUE fixture — a softDelete store that ALSO carries a `unique` column (`code`), backed
// by a TENANT-SCOPED, NON-partial unique index `(tenant_id, code)` in the DDL below (the SAME shape the
// platform generates for a `unique: true` store column, mirroring store-soft-delete.db.test.ts's
// `articles`). This exercises the write-path (insert/upsert / store_write) over a tombstoned unique key —
// the documented `unique`-vs-tombstone limitation the facade upsert path deliberately does NOT special-case
// (the non-partial index still counts the tombstone). Pinned, not "fixed": changing the behavior is a
// deliberate, visible decision (a partial index), never an accident.
const docsStore: StoreSpec = {
  name: 'docs',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: false },
    { name: 'code', type: 'text', nullable: false, unique: true },
  ],
  foreignKeys: [],
  softDelete: true,
};

// ENUM-WHITELIST fixture — a store with a declared column `enum` value whitelist. build-product-tables
// records the whitelist in the enum-whitelist registry, so the facade rejects an out-of-whitelist write
// value on the low-level insert/upsert/update funnel (parity with the HTTP route + workflow store.write).
// `status` is a non-nullable whitelisted column; `priority` is a NULLABLE whitelisted column (null is a
// nullability concern, not an out-of-whitelist value — so it must be accepted). The DDL is a plain `text`
// column with NO CHECK constraint (the whitelist is enforced app-side, not by the DB), so an illegal value
// writes fine at the DB level — i.e. WITHOUT the facade check these inserts SUCCEED (RED before the fix).
const ticketsStore: StoreSpec = {
  name: 'tickets',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: false },
    { name: 'status', type: 'text', nullable: false, unique: false, enum: ['open', 'closed'] },
    { name: 'priority', type: 'text', nullable: true, unique: false, enum: ['low', 'high'] },
  ],
  foreignKeys: [],
};

/** Every PRODUCT store this suite creates in the isolated schema, paired with its business columns. */
const productStores = [
  meetingsStore,
  tagsStore,
  gizmosStore,
  pairsStore,
  scopedStore,
  notesStore,
  docsStore,
  ticketsStore,
];

/**
 * The isolated-schema DDL. Each product table's injected tenancy/GDPR columns are DERIVED from the
 * single-source generator descriptor (`injectedColumnLinesSql`) and interpolated around the still-
 * explicit business columns + the still-explicit attack-surface constraints (global/composite/
 * tenant-scoped UNIQUEs the generator would NOT emit), so a NEW injected column can never silently
 * drift these fixtures while the bespoke constraints stay verbatim.
 */
function buildFacadeSchemaSql(): string {
  const { before, after } = injectedColumnLinesSql({
    tenantFkRef: 'REFERENCES orgs(id) ON DELETE CASCADE',
  });
  return `
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      SET search_path TO ${SCHEMA};
      CREATE TABLE orgs (id uuid PRIMARY KEY, name text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE meetings (
        ${before},
        title text NOT NULL,
        completed boolean NOT NULL,
        scheduled_at timestamptz,
        metadata jsonb,
        business_key text,
        ${after},
        -- GLOBAL (NOT tenant-scoped) unique — the worst case for an upsert conflict target: two tenants
        -- can collide on the SAME business_key, so C1's tenant-scoped DO-UPDATE setWhere is what stops a
        -- cross-tenant overwrite. (Multiple NULL business_keys are allowed — Postgres NULLs are distinct.)
        CONSTRAINT meetings_business_key_global_unique UNIQUE (business_key)
      );
      -- F1 ensure-exists fixture: only business column is the conflict target → empty DO-UPDATE SET.
      CREATE TABLE tags (
        ${before},
        name text NOT NULL,
        ${after},
        CONSTRAINT tags_name_global_unique UNIQUE (name)
      );
      -- XT-1 fixture: TWO individual global uniques (a conflict on vendor while the ON CONFLICT target
      -- is business_key is the "DIFFERENT unique" 23505 the sanitizer must neutralize).
      CREATE TABLE gizmos (
        ${before},
        title text NOT NULL,
        business_key text,
        vendor text,
        ${after},
        CONSTRAINT gizmos_business_key_unique UNIQUE (business_key),
        CONSTRAINT gizmos_vendor_unique UNIQUE (vendor)
      );
      -- TQ-3 fixture: a COMPOSITE global unique (business_key, vendor).
      CREATE TABLE pairs (
        ${before},
        title text NOT NULL,
        business_key text NOT NULL,
        vendor text NOT NULL,
        ${after},
        CONSTRAINT pairs_bk_vendor_unique UNIQUE (business_key, vendor)
      );
      -- TQ-4 fixture: a TENANT-SCOPED unique (tenant_id, business_key) — the recommended secure pattern.
      CREATE TABLE scoped (
        ${before},
        title text NOT NULL,
        business_key text NOT NULL,
        ${after},
        CONSTRAINT scoped_tenant_bk_unique UNIQUE (tenant_id, business_key)
      );
      -- SOFT-DELETE fixture: the facade folds deleted_at IS NULL on reads/updates + stamps on delete.
      CREATE TABLE notes (
        ${before},
        title text NOT NULL,
        done boolean NOT NULL,
        ${after}
      );
      -- SOFT-DELETE + UNIQUE fixture: a softDelete store with a TENANT-SCOPED, NON-partial unique
      -- (tenant_id, code) — NOT a partial (no WHERE deleted_at IS NULL), so a tombstoned row STILL occupies
      -- its unique value (the documented unique-vs-tombstone limitation exercised by the write-path test).
      CREATE TABLE docs (
        ${before},
        title text NOT NULL,
        code text NOT NULL,
        ${after},
        CONSTRAINT docs_tenant_code_unique UNIQUE (tenant_id, code)
      );
      -- ENUM-WHITELIST fixture: plain text columns with NO DB CHECK — the enum whitelist is enforced
      -- app-side (the facade), so an illegal value would write fine here without the facade check.
      CREATE TABLE tickets (
        ${before},
        title text NOT NULL,
        status text NOT NULL,
        priority text,
        ${after}
      );
      INSERT INTO orgs (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
    `;
}

// Drift guard (no DB): every PRODUCT table's CREATE TABLE must carry EXACTLY the injected columns
// ∪ its declared business columns (the test-specific UNIQUE constraints are skipped, not counted).
// Interpolating `injectedColumnLinesSql` makes drift impossible; this fails the fix RED if a future
// edit re-hardcodes a product table and forgets an injected column.
describe('store-facade schema — injected-column drift guard', () => {
  const sql = buildFacadeSchemaSql();
  for (const productStore of productStores) {
    it(`${productStore.name} carries exactly the injected + its business columns`, () => {
      const columns = new Set(parseCreateTableColumnNames(sql, productStore.name));
      const expected = new Set([
        ...INJECTED_COLUMN_NAMES,
        ...productStore.columns.map((c) => c.name),
      ]);
      expect(columns).toEqual(expected);
    });
  }
});

describe.skipIf(!hasDb)('makeHandlerDb — over the real TenantDb chokepoint', () => {
  let db: ReturnType<typeof makeDbWithSchema>;
  let productTables: Map<string, PgTable>;
  let unregister: () => void;

  beforeAll(async () => {
    db = makeDbWithSchema(process.env.DATABASE_URL as string, SCHEMA);
    await db.$client.unsafe(buildFacadeSchemaSql());
    productTables = buildProductTables([
      meetingsStore,
      tagsStore,
      gizmosStore,
      pairsStore,
      scopedStore,
      notesStore,
      docsStore,
      ticketsStore,
    ]);
    unregister = registerScopedTables([...productTables.values()]);
  });

  afterAll(async () => {
    unregister?.();
    await db?.$client.end();
  });

  beforeEach(async () => {
    await db.$client.unsafe(
      `SET search_path TO ${SCHEMA}; TRUNCATE meetings, tags, gizmos, pairs, scoped, notes, docs, tickets CASCADE;`,
    );
  });

  it('insert auto-stamps tenant_id; select is tenant-scoped (cross-tenant invisible)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const bDb = makeHandlerDb(forTenant(db, TENANT_B), productTables);
    const inserted = await aDb.insert('meetings', { title: 'A-only', completed: false });
    // The returned row is snake_case-keyed (the declared shape) + carries the injected tenant_id.
    expect(inserted.title).toBe('A-only');
    expect(inserted.tenant_id).toBe(TENANT_A);
    expect(typeof inserted.id).toBe('string');

    // A sees its row; B sees NOTHING (the tenant predicate is structural — not a facade filter).
    expect(await aDb.select('meetings')).toHaveLength(1);
    expect(await bDb.select('meetings')).toHaveLength(0);
  });

  it('insert stamps created_by from the route actor un-spoofably (the actor is the sole writer)', async () => {
    testsRan += 1;
    const actor = 'user:11111111-1111-1111-1111-111111111111';
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables, actor);
    const inserted = await aDb.insert('meetings', { title: 'stamped', completed: false });
    // The injected created_by column carries the server-derived caller identity (RED before the stamp:
    // it was left NULL — nobody wrote it on the handler path).
    expect(inserted.created_by).toBe(actor);
    // UN-SPOOFABLE: a handler can NEVER supply created_by — it is a server-controlled column, rejected
    // fail-closed — so a bogus value never survives; the actor stamp is the only path to the column.
    await expect(
      aDb.insert('meetings', { title: 'x', completed: false, created_by: 'user:evil' }),
    ).rejects.toThrow(/may not set server-controlled column 'created_by'/);
  });

  it('an api-key principal stamps created_by as key:<apiKeyId>', async () => {
    testsRan += 1;
    const actor = 'key:22222222-2222-2222-2222-222222222222';
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables, actor);
    const inserted = await aDb.insert('meetings', { title: 'k', completed: false });
    expect(inserted.created_by).toBe(actor);
  });

  it('ADDITIVE: with NO route actor bound (a tool handler / any 2-arg caller) created_by stays NULL', async () => {
    testsRan += 1;
    // The pre-existing 2-arg facade — no actor threaded — must behave byte-identically: created_by NULL.
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const inserted = await aDb.insert('meetings', { title: 'noactor', completed: false });
    expect(inserted.created_by).toBeNull();
  });

  it('upsert stamps created_by on insert; a conflict-update keeps the ORIGINAL creator (create-only)', async () => {
    testsRan += 1;
    const actor1 = 'user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const actor2 = 'user:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const db1 = makeHandlerDb(forTenant(db, TENANT_A), productTables, actor1);
    // First upsert → INSERT arm → created_by stamped with actor1 (RED before the stamp: NULL).
    const first = await db1.upsert('meetings', ['business_key'], {
      title: 'first',
      completed: false,
      business_key: 'K-created-by',
    });
    expect(first?.created_by).toBe(actor1);
    // A second upsert by a DIFFERENT actor on the SAME (tenant, business_key) → DO-UPDATE arm.
    const db2 = makeHandlerDb(forTenant(db, TENANT_A), productTables, actor2);
    const second = await db2.upsert('meetings', ['business_key'], {
      title: 'second',
      completed: true,
      business_key: 'K-created-by',
    });
    // The row was UPDATED (title changed) …
    expect(second?.title).toBe('second');
    // … but created_by is CREATE-ONLY: it stays the ORIGINAL creator, never overwritten by actor2
    // (RED without excluding created_by from the DO-UPDATE SET: it would flip to actor2).
    expect(second?.created_by).toBe(actor1);
  });

  it('select honors a snake_case column-equality filter (mapped to the camel Drizzle key)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await aDb.insert('meetings', { title: 'done', completed: true });
    await aDb.insert('meetings', { title: 'pending', completed: false });
    const done = await aDb.select('meetings', { completed: true });
    expect(done).toHaveLength(1);
    expect(done[0]?.title).toBe('done');
  });

  it('TEN-1 count: tenant-scoped SELECT count(*) honoring the filter; fail-closed on unknown store/column', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const bDb = makeHandlerDb(forTenant(db, TENANT_B), productTables);
    await aDb.insert('meetings', { title: 'a1', completed: true });
    await aDb.insert('meetings', { title: 'a2', completed: false });
    await bDb.insert('meetings', { title: 'b1', completed: true });
    // Unfiltered: exactly THIS tenant's rows (the structural predicate — B's row is invisible).
    expect(await aDb.count?.('meetings')).toBe(2);
    expect(await bDb.count?.('meetings')).toBe(1);
    // Filtered: the same snake_case equality-filter resolution select uses.
    expect(await aDb.count?.('meetings', { completed: true })).toBe(1);
    // Fail-closed: an undeclared store / unknown column throws (same as select).
    await expect(aDb.count?.('orgs')).rejects.toThrow(/not a declared product store/);
    await expect(aDb.count?.('meetings', { ghost_col: 1 })).rejects.toThrow(/not a column/);
  });

  it('update is tenant-scoped + returns the updated rows; delete returns the count', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const row = await aDb.insert('meetings', { title: 'x', completed: false });
    const updated = await aDb.update('meetings', { id: row.id }, { completed: true });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.completed).toBe(true);
    const count = await aDb.delete('meetings', { id: row.id });
    expect(count).toBe(1);
    expect(await aDb.select('meetings')).toHaveLength(0);
  });

  it("B cannot update/delete A's row (tenant predicate AND-combined → zero affected)", async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const bDb = makeHandlerDb(forTenant(db, TENANT_B), productTables);
    const aRow = await aDb.insert('meetings', { title: 'A', completed: false });
    expect(await bDb.update('meetings', { id: aRow.id }, { completed: true })).toHaveLength(0);
    expect(await bDb.delete('meetings', { id: aRow.id })).toBe(0);
    // A's row is untouched.
    const stillThere = await aDb.select('meetings', { id: aRow.id });
    expect(stillThere[0]?.completed).toBe(false);
  });

  it('#1 FAILS CLOSED on an undeclared store name (a handler cannot reach an unlisted table)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await expect(aDb.select('not_a_store')).rejects.toThrow(/not a declared product store/);
    await expect(aDb.insert('also_missing', { x: 1 })).rejects.toThrow(
      /not a declared product store/,
    );
  });

  it('#1 FAILS CLOSED on every auth/core table name (orgs/users/sessions/runs/journal_steps/…)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const coreTables = [
      'orgs',
      'users',
      'sessions',
      'api_keys',
      'memberships',
      'runs',
      'run_events',
      'journal_steps',
      'conversation_items',
      'idempotency_keys',
      'auth_audit',
      'oidc_models',
    ];
    // None of these are in productTables (built from spec.stores only), so each is unreachable.
    for (const t of coreTables) {
      await expect(aDb.select(t)).rejects.toThrow(/not a declared product store/);
    }
  });

  it('#3 REJECTS a server-controlled column in insert/update VALUES (fail-closed throw)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // A handler may NEVER set tenant_id / id / created_at / region in values — fail-closed throw.
    await expect(
      aDb.insert('meetings', { title: 'x', completed: false, tenant_id: TENANT_B }),
    ).rejects.toThrow(/may not set server-controlled column 'tenant_id'/);
    await expect(
      aDb.insert('meetings', {
        title: 'x',
        completed: false,
        id: '00000000-0000-0000-0000-000000000001',
      }),
    ).rejects.toThrow(/may not set server-controlled column 'id'/);
    const row = await aDb.insert('meetings', { title: 'ok', completed: false });
    await expect(aDb.update('meetings', { id: row.id }, { region: 'us' })).rejects.toThrow(
      /may not set server-controlled column 'region'/,
    );
  });

  it('input-validation guards reject with a StoreInputError carrying a generic, non-leaking public message', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // Capture the thrown error so we can inspect its TYPE + the client-facing public message (a plain
    // `.rejects.toThrow` only sees the internal message).
    const capture = async (p: Promise<unknown>): Promise<unknown> => {
      try {
        await p;
      } catch (e) {
        return e;
      }
      throw new Error('expected the guard to throw');
    };
    const unknownColumn = await capture(
      aDb.insert('meetings', { title: 'x', completed: false, ghost_col: 1 }),
    );
    const serverControlled = await capture(
      aDb.insert('meetings', { title: 'x', completed: false, tenant_id: TENANT_B }),
    );
    const injection = await capture(
      aDb.insert('meetings', {
        title: sql`(SELECT secret FROM other_tenant)` as unknown as string,
        completed: false,
      }),
    );
    const badEnum = await capture(aDb.insert('tickets', { title: 't', status: 'not_a_status' }));

    for (const err of [unknownColumn, serverControlled, injection, badEnum]) {
      // TYPED as an input error → the api layer classifies it as HTTP 400 (RED before: a plain Error →
      // it fell through onError to an INTERNAL 500).
      expect(err).toBeInstanceOf(StoreInputError);
      const publicMessage = (err as StoreInputError).publicMessage;
      expect(publicMessage.length).toBeGreaterThan(0);
      // NO-LEAK: the client-facing message never carries an internal — not the facade prefix, a store or
      // column name, the offending value, a DB/SQL/constraint term, or the enum member.
      expect(publicMessage).not.toMatch(
        /HandlerDb|ghost_col|tenant_id|meetings|tickets|not_a_status|secret|SELECT|SQL|constraint/i,
      );
    }
  });

  it('#2 defense-in-depth: even at the TenantDb layer a foreign tenant_id lands under the run tenant', async () => {
    testsRan += 1;
    // The facade rejects tenant_id in values (#3 above). #2 proves the LAYER BENEATH — TenantDb —
    // would ALSO stamp the run's tenant if a tenant_id ever reached it (belt-and-suspenders): a raw
    // forTenant(A).insert with tenant_id=B lands under A (TenantDb auto-stamps, overwriting B).
    const aTdb = forTenant(db, TENANT_A);
    const meetings = productTables.get('meetings') as PgTable;
    const inserted = (await aTdb
      .insert(meetings as never, { title: 'dd', completed: false, tenantId: TENANT_B })
      .returning()) as Array<{ tenantId: string }>;
    expect(inserted[0]?.tenantId).toBe(TENANT_A);
  });

  it('#4 FAILS CLOSED on an unknown column key in a filter AND in values', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // Unknown filter column → throw (not silently ignored → would return ALL rows otherwise).
    await expect(aDb.select('meetings', { nonexistent: 'x' })).rejects.toThrow(
      /column 'nonexistent' is not a column/,
    );
    // Unknown column in insert values → throw.
    await expect(
      aDb.insert('meetings', { title: 'x', completed: false, bogus: 1 }),
    ).rejects.toThrow(/column 'bogus', which is not a declared column/);
  });

  it('#4 a FILTER may use an injected column (read-by-id) — injected cols allowed in filters', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const row = await aDb.insert('meetings', { title: 'byid', completed: false });
    // Filtering by the injected `id` is legitimate (the throwaway lookup tool does exactly this).
    const found = await aDb.select('meetings', { id: row.id });
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe('byid');
  });

  it('SF-1 REJECTS a non-plain-scalar VALUE (object/array/SQL-ish) in insert/update/filter', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // A crafted object value (the shape a Drizzle SQL object / injection payload would take) → throw.
    const sqlish = { queryChunks: ['; DROP TABLE meetings; --'] };
    await expect(
      aDb.insert('meetings', { title: sqlish as unknown as string, completed: false }),
    ).rejects.toThrow(/must be a plain scalar/);
    // An array value → throw.
    await expect(
      aDb.insert('meetings', { title: ['x'] as unknown as string, completed: false }),
    ).rejects.toThrow(/must be a plain scalar/);
    // A non-scalar in a FILTER value → throw (the read path is guarded too).
    await expect(aDb.select('meetings', { title: sqlish as unknown as string })).rejects.toThrow(
      /must be a plain scalar/,
    );
    // A non-scalar in an UPDATE patch → throw.
    const row = await aDb.insert('meetings', { title: 'ok', completed: false });
    await expect(
      aDb.update('meetings', { id: row.id }, { title: sqlish as unknown as string }),
    ).rejects.toThrow(/must be a plain scalar/);
  });

  it('SF-1 ACCEPTS plain scalars (string/number/boolean/null/Date) — not over-broad', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // A Date value is a plain scalar (allowed); null is allowed (nullable column).
    const row = await aDb.insert('meetings', {
      title: 'scalars',
      completed: true,
      scheduled_at: new Date('2026-07-01T10:00:00Z'),
    });
    expect(row.title).toBe('scalars');
    const cleared = await aDb.update('meetings', { id: row.id }, { scheduled_at: null });
    expect(cleared[0]?.scheduled_at).toBeNull();
  });

  it('SF1-JSONB: a jsonb column ACCEPTS a JSON object/array (parity with the api write path)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // The SF-1 fix is column-type-aware: a jsonb column takes free-form JSON (object/array), matching
    // the api path's z.unknown() for jsonb — the facade is no longer stricter than the api path.
    const obj = await aDb.insert('meetings', {
      title: 'j-obj',
      completed: false,
      metadata: { tags: ['a', 'b'], nested: { n: 1 } },
    });
    expect(obj.metadata).toEqual({ tags: ['a', 'b'], nested: { n: 1 } });
    const arr = await aDb.insert('meetings', {
      title: 'j-arr',
      completed: false,
      metadata: [1, 2, 3],
    });
    expect(arr.metadata).toEqual([1, 2, 3]);
    // A jsonb column still takes a scalar / null too.
    const scal = await aDb.insert('meetings', { title: 'j-scal', completed: false, metadata: 'x' });
    expect(scal.metadata).toBe('x');
  });

  it('SF1-JSONB: a REAL Drizzle SQL object is STILL rejected on a jsonb AND a non-jsonb column', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const injection = sql`(SELECT secret FROM other_tenant)`; // a genuine Drizzle SQL object
    // Even though `metadata` is jsonb (objects allowed), a SQL OBJECT is the injection vector SF-1
    // blocks — rejected fail-closed (the jsonb relaxation did NOT reopen the injection hole).
    await expect(
      aDb.insert('meetings', {
        title: 'x',
        completed: false,
        metadata: injection as unknown as object,
      }),
    ).rejects.toThrow(/forbidden non-data value/);
    // And still rejected on a non-jsonb column.
    await expect(
      aDb.insert('meetings', { title: injection as unknown as string, completed: false }),
    ).rejects.toThrow(/forbidden non-data value/);
  });

  it('SF1-JSONB: a function / class instance is STILL rejected on a jsonb column', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // A function value → forbidden everywhere.
    await expect(
      aDb.insert('meetings', {
        title: 'x',
        completed: false,
        metadata: (() => 1) as unknown as object,
      }),
    ).rejects.toThrow(/forbidden non-data value/);
    // A class instance (prototype is not Object/Array.prototype) → forbidden even on jsonb.
    class Evil {
      x = 1;
    }
    await expect(
      aDb.insert('meetings', {
        title: 'x',
        completed: false,
        metadata: new Evil() as unknown as object,
      }),
    ).rejects.toThrow(/forbidden non-data value/);
  });

  it('SF1: a plain OBJECT is still rejected on a NON-jsonb column (text)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await expect(
      aDb.insert('meetings', { title: { not: 'a string' } as unknown as string, completed: false }),
    ).rejects.toThrow(/must be a plain scalar.*non-jsonb/s);
  });

  it('SF-2 coerces an ISO-STRING timestamp value to a Date on insert (plain-row contract)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // The SDK contract is "plain serializable rows" → an ISO string for a timestamp column must work
    // (drizzle's timestamp mapper wants a Date; the facade coerces). Before SF-2 this crashed.
    const row = await aDb.insert('meetings', {
      title: 'iso',
      completed: false,
      scheduled_at: '2026-07-01T10:00:00.000Z',
    });
    expect(typeof row.scheduled_at).toBe('string'); // serialized back to ISO on read
    expect(new Date(row.scheduled_at as string).toISOString()).toBe('2026-07-01T10:00:00.000Z');
  });

  it('SF-2 REJECTS an invalid date string for a timestamp column (fail-closed)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await expect(
      aDb.insert('meetings', { title: 'bad', completed: false, scheduled_at: 'not-a-date' }),
    ).rejects.toThrow(/not a valid date/);
  });

  it('an invalid timestamp value is TYPED as an input error carrying a generic, non-leaking public message (a client 400, not a server 500)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // Capture the thrown error to inspect its TYPE + the client-facing public message.
    let err: unknown;
    try {
      await aDb.insert('meetings', {
        title: 'bad',
        completed: false,
        scheduled_at: 'not-a-real-date',
      });
      throw new Error('expected the invalid-date guard to reject');
    } catch (e) {
      err = e;
    }
    // TYPED as an input error → the api layer classifies it as HTTP 400 (RED before: a plain Error fell
    // through onError to an INTERNAL 500, misreporting a bad request as a server incident).
    expect(err).toBeInstanceOf(StoreInputError);
    const publicMessage = (err as StoreInputError).publicMessage;
    expect(publicMessage.length).toBeGreaterThan(0);
    // NO-LEAK: the client-facing message never carries an internal — not the column name, the offending
    // value, the facade prefix, the column type, or the store name.
    expect(publicMessage).not.toMatch(
      /HandlerDb|scheduled_at|not-a-real-date|timestamp|meetings|JSON/i,
    );
    // The DETAILED text stays available server-side (log / throw-site), never sent to the client.
    expect((err as StoreInputError).message).toMatch(/not a valid date/);
  });

  it('TenantDb backstop: update with tenantId in the SET does NOT move the row', async () => {
    testsRan += 1;
    // The facade rejects a server-controlled key (#3); this proves the LAYER BENEATH — a RAW
    // TenantDb.update with a tenantId in the SET is stripped, so the row's tenant is UNCHANGED (no
    // caller — run-core/api-auth/the facade — can move a row across tenants via update).
    const aTdb = forTenant(db, TENANT_A);
    const meetings = productTables.get('meetings') as PgTable;
    const inserted = (await aTdb
      .insert(meetings as never, { title: 'stay', completed: false })
      .returning()) as Array<{ id: string; tenantId: string }>;
    const id = inserted[0]?.id as string;
    const idCol = (getTableColumns(meetings) as Record<string, PgColumn>).id as PgColumn;
    // Attempt to move it to B via the update SET — TenantDb strips tenantId from the SET.
    await aTdb
      .update(meetings as never, { completed: true, tenantId: TENANT_B })
      .where(eq(idCol, id));
    // The row is STILL under A (its tenant did not move); B sees nothing.
    const bTdb = forTenant(db, TENANT_B);
    const underB = (await bTdb.select(meetings as never).all()) as unknown[];
    expect(underB).toHaveLength(0);
    const underA = (await aTdb.select(meetings as never).all()) as Array<{ tenantId: string }>;
    expect(underA).toHaveLength(1);
    expect(underA[0]?.tenantId).toBe(TENANT_A);
  });

  it('transaction() runs the body in a tenant tx that COMMITS its writes (the GUC seam, A3)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await aDb.transaction(async (tx) => {
      await tx.insert('meetings', { title: 'in-tx', completed: false });
    });
    // The row was committed inside the facade's transaction (which delegates to TenantDb.transaction,
    // populating the app.current_tenant GUC — the SAME-transaction GUC read-back is the authoritative
    // api-auth A3 test; here we prove the facade's tx actually wraps + commits the write).
    expect(await aDb.select('meetings', { title: 'in-tx' })).toHaveLength(1);
  });

  it('transaction() ROLLS BACK on a throw (no partial write escapes the tx)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await expect(
      aDb.transaction(async (tx) => {
        await tx.insert('meetings', { title: 'rolled-back', completed: false });
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
    expect(await aDb.select('meetings', { title: 'rolled-back' })).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // C1 — ATOMIC upsert (INSERT … ON CONFLICT DO UPDATE), structurally tenant-safe.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('C1 CROSS-TENANT GUARD: A.upsert on a GLOBAL-unique conflict NEVER overwrites B (the setWhere line)', async () => {
    testsRan += 1;
    // THE critical fail-the-fix test. business_key carries a GLOBAL (non-tenant-scoped) UNIQUE. B owns
    // business_key='K' with title='B'. A upserts the SAME key with title='A'. The INSERT collides with
    // B's row globally; the tenant-scoped DO-UPDATE setWhere (tenant_id = A) matches ZERO rows on B's
    // row → fail-closed no-op. B's row MUST be unchanged. (Remove `setWhere` from store-facade.ts and
    // this goes RED: the DO-UPDATE would set title='A' on B's row — a cross-tenant write — and A would
    // receive B's row back. PM-verified RED-without-setWhere.)
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const bDb = makeHandlerDb(forTenant(db, TENANT_B), productTables);
    await bDb.insert('meetings', { title: 'B', completed: false, business_key: 'K' });

    const result = await aDb.upsert('meetings', ['business_key'], {
      title: 'A',
      completed: false,
      business_key: 'K',
    });

    // Foreign-tenant conflict → the documented fail-closed no-op (undefined, NOT B's row, NOT a throw).
    expect(result).toBeUndefined();
    // B's row is UNTOUCHED — value still 'B' (the cross-tenant write was blocked).
    const bRows = await bDb.select('meetings', { business_key: 'K' });
    expect(bRows).toHaveLength(1);
    expect(bRows[0]?.title).toBe('B');
    expect(bRows[0]?.tenant_id).toBe(TENANT_B);
    // A wrote nothing (the upsert was a no-op for A) — A sees zero rows.
    expect(await aDb.select('meetings')).toHaveLength(0);
  });

  it('C1 SAME-TENANT: upsert INSERTS then UPDATES this tenant’s row on the same key (returns it)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // First upsert → INSERT path (no conflict). Returns the inserted row.
    const first = await aDb.upsert('meetings', ['business_key'], {
      title: 'first',
      completed: false,
      business_key: 'K1',
    });
    expect(first?.title).toBe('first');
    expect(first?.tenant_id).toBe(TENANT_A);
    const id = first?.id;
    expect(typeof id).toBe('string');

    // Second upsert on the SAME key → DO-UPDATE path (setWhere tenant_id=A matches). Updates in place.
    const second = await aDb.upsert('meetings', ['business_key'], {
      title: 'second',
      completed: true,
      business_key: 'K1',
    });
    expect(second?.title).toBe('second');
    expect(second?.completed).toBe(true);
    expect(second?.id).toBe(id); // SAME row updated, not a 2nd row inserted.

    // Exactly one row for A under that key, with the updated value.
    const rows = await aDb.select('meetings', { business_key: 'K1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('second');
  });

  it('C1 upsert runs the SF-1 / server-controlled guards (no new trust surface)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // A server-controlled column in values → fail-closed (same as insert).
    await expect(
      aDb.upsert('meetings', ['business_key'], {
        title: 'x',
        completed: false,
        business_key: 'K2',
        tenant_id: TENANT_B,
      }),
    ).rejects.toThrow(/may not set server-controlled column 'tenant_id'/);
    // A non-data injection value → fail-closed.
    await expect(
      aDb.upsert('meetings', ['business_key'], {
        title: { queryChunks: ['; DROP TABLE meetings; --'] } as unknown as string,
        completed: false,
        business_key: 'K3',
      }),
    ).rejects.toThrow(/must be a plain scalar/);
    // An unknown conflict column → fail-closed (resolveColumn).
    await expect(
      aDb.upsert('meetings', ['not_a_column'], { title: 'x', completed: false }),
    ).rejects.toThrow(/column 'not_a_column' is not a column/);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // C11 — read-opts: batched inArray (column-type-aware) + orderBy/limit/offset.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('C11 jsonb-vs-inArray: an ARRAY value is set-membership on a SCALAR col, EQUALITY on a jsonb col', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await aDb.insert('meetings', { title: 'alpha', completed: false });
    await aDb.insert('meetings', { title: 'beta', completed: false });
    await aDb.insert('meetings', { title: 'gamma', completed: false });
    // SCALAR column (title text) + array filter → inArray (IN-membership): matches alpha + beta only.
    const inSet = await aDb.select('meetings', { title: ['alpha', 'beta'] });
    expect(inSet.map((r) => r.title).sort()).toEqual(['alpha', 'beta']);

    // jsonb column + array filter → EQUALITY (the array IS the value), NOT inArray, NOT a crash.
    await aDb.insert('meetings', { title: 'j-eq', completed: false, metadata: [1, 2, 3] });
    await aDb.insert('meetings', { title: 'j-other', completed: false, metadata: [9] });
    const jEq = await aDb.select('meetings', { metadata: [1, 2, 3] });
    expect(jEq).toHaveLength(1);
    expect(jEq[0]?.title).toBe('j-eq'); // matched by jsonb equality, NOT membership in [1,2,3]
  });

  it('C11 inArray elements are SF-1 guarded (a crafted non-data element is rejected fail-closed)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // One element is a Drizzle-SQL-ish object → the whole filter is rejected (no injection via the batch).
    await expect(
      aDb.select('meetings', {
        title: ['ok', { queryChunks: ['; DROP TABLE meetings; --'] } as unknown as string],
      }),
    ).rejects.toThrow(/forbidden non-data value|must be a plain scalar/);
  });

  it('C11 orderBy + limit + offset: server-side ordering/paging, still tenant-scoped', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const bDb = makeHandlerDb(forTenant(db, TENANT_B), productTables);
    // A's rows out of order; a B row with a title that would SORT FIRST (must never leak into A's read).
    await aDb.insert('meetings', { title: 'c', completed: false });
    await aDb.insert('meetings', { title: 'a', completed: false });
    await aDb.insert('meetings', { title: 'b', completed: false });
    await bDb.insert('meetings', { title: 'a', completed: false, business_key: 'B-a' });

    // ASC order = a,b,c; offset 1 limit 2 → ['b','c']. The B 'a' row is structurally invisible.
    const page = await aDb.select(
      'meetings',
      {},
      { orderBy: [{ column: 'title', dir: 'asc' }], limit: 2, offset: 1 },
    );
    expect(page.map((r) => r.title)).toEqual(['b', 'c']);
    for (const r of page) expect(r.tenant_id).toBe(TENANT_A);

    // DESC order, limit 1 → just 'c'.
    const top = await aDb.select(
      'meetings',
      {},
      { orderBy: [{ column: 'title', dir: 'desc' }], limit: 1 },
    );
    expect(top.map((r) => r.title)).toEqual(['c']);
  });

  it('C11 orderBy FAILS CLOSED on an unknown column (resolveColumn)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await expect(
      aDb.select('meetings', {}, { orderBy: [{ column: 'nonexistent', dir: 'asc' }] }),
    ).rejects.toThrow(/column 'nonexistent' is not a column/);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // Store-facade hardening — empty DO-UPDATE SET, sanitized unique-violation,
  // limit/offset guard, concurrency, composite/tenant-scoped/empty-IN edge cases.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('ensure-exists: an upsert whose values ARE the conflict columns uses DO NOTHING (no crash)', async () => {
    testsRan += 1;
    // values == the conflict column ONLY → setValues is genuinely EMPTY. onConflictDoUpdate({set:{}})
    // throws drizzle's synchronous "No values to set"; the facade uses onConflictDoNothing instead.
    // (Fail-the-fix: revert FIX 1 and the 1st upsert RAISES "No values to set" — this test goes RED.)
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const first = await aDb.upsert('tags', ['name'], { name: 'EX' });
    expect(first?.name).toBe('EX'); // 1st call INSERTS → returns the row
    expect(first?.tenant_id).toBe(TENANT_A);
    // 2nd call: conflict on the named target → DO NOTHING → RETURNING empty → undefined (ensure-exists).
    const second = await aDb.upsert('tags', ['name'], { name: 'EX' });
    expect(second).toBeUndefined();
    // Exactly ONE row, no crash.
    expect(await aDb.select('tags', { name: 'EX' })).toHaveLength(1);
  });

  it('sanitizes a unique-violation on a DIFFERENT global unique (no constraint name leaks)', async () => {
    testsRan += 1;
    // B holds vendor='V'. A upserts a FRESH business_key (the named target → no conflict there) but
    // vendor='V' (held by B) → the INSERT hits the DIFFERENT global unique (gizmos_vendor_unique) →
    // 23505. The facade SANITIZES it to a neutral message (the raw pg constraint name = a cross-tenant
    // existence oracle). Fail-the-fix: WITHOUT FIX 2 the raw 'duplicate key value violates unique
    // constraint "gizmos_vendor_unique"' would cross to the model.
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const bDb = makeHandlerDb(forTenant(db, TENANT_B), productTables);
    await bDb.insert('gizmos', { title: 'B', business_key: 'K', vendor: 'V' });

    let caught: unknown;
    try {
      await aDb.upsert('gizmos', ['business_key'], {
        title: 'A',
        business_key: 'KA',
        vendor: 'V',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toBe('unique constraint violation'); // the NEUTRAL message
    // No constraint name, no column name, no raw pg text crosses the boundary.
    expect(msg).not.toContain('gizmos');
    expect(msg).not.toContain('vendor');
    expect(msg).not.toContain('business_key');
    expect(msg).not.toContain('duplicate key');
    // insert() is sanitized the SAME way (a direct insert hitting B's vendor='V').
    let caught2: unknown;
    try {
      await aDb.insert('gizmos', { title: 'A2', business_key: 'KB', vendor: 'V' });
    } catch (e) {
      caught2 = e;
    }
    expect((caught2 as Error).message).toBe('unique constraint violation');
  });

  it('select limit/offset fail-closed on a non-negative-integer guard (no silent over-read)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await aDb.insert('meetings', { title: 'a', completed: false });
    await aDb.insert('meetings', { title: 'b', completed: false });
    // A negative/NaN limit would SILENTLY drop the LIMIT (return ALL rows) — must THROW instead.
    await expect(aDb.select('meetings', {}, { limit: -1 })).rejects.toThrow(/non-negative integer/);
    await expect(aDb.select('meetings', {}, { limit: Number.NaN })).rejects.toThrow(
      /non-negative integer/,
    );
    await expect(aDb.select('meetings', {}, { offset: -5 })).rejects.toThrow(
      /non-negative integer/,
    );
    // limit:0 is VALID — returns 0 rows (never "all rows").
    expect(await aDb.select('meetings', {}, { limit: 0 })).toHaveLength(0);
  });

  it('an out-of-range limit/offset is TYPED as an input error carrying a generic, non-leaking public message (a client 400, not a server 500)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // Every out-of-range pagination value (negative limit, NaN limit, negative offset) is a CLIENT bad
    // request, not a server fault — assert the WHOLE invariant (each rejects TYPED + leaks nothing).
    const cases = [{ limit: -1 }, { limit: Number.NaN }, { offset: -5 }];
    for (const opts of cases) {
      let err: unknown;
      try {
        await aDb.select('meetings', {}, opts);
        throw new Error(`expected the pagination guard to reject ${JSON.stringify(opts)}`);
      } catch (e) {
        err = e;
      }
      // TYPED as an input error → HTTP 400 (RED before: a plain Error fell through onError to a 500).
      expect(err).toBeInstanceOf(StoreInputError);
      const publicMessage = (err as StoreInputError).publicMessage;
      expect(publicMessage.length).toBeGreaterThan(0);
      // NO-LEAK: never the field name, the offending value, the facade prefix, or DB text.
      expect(publicMessage).not.toMatch(/HandlerDb|\blimit\b|\boffset\b|non-negative|meetings/i);
      // The DETAILED text stays available server-side only.
      expect((err as StoreInputError).message).toMatch(/non-negative integer/);
    }
  });

  it('concurrent same-key upserts: exactly ONE row, neither rejects with a 23505', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // The ON CONFLICT DO UPDATE makes the race a no-crash upsert: one INSERTs, the other UPDATEs the
    // same row — neither raises a 23505. (Promise.all REJECTS if either throws → the fail-the-fix.)
    const results = await Promise.allSettled([
      aDb.upsert('meetings', ['business_key'], { title: 'x', completed: false, business_key: 'R' }),
      aDb.upsert('meetings', ['business_key'], { title: 'y', completed: true, business_key: 'R' }),
    ]);
    for (const r of results) expect(r.status).toBe('fulfilled');
    // Exactly ONE row for 'R'.
    expect(await aDb.select('meetings', { business_key: 'R' })).toHaveLength(1);
  });

  it('composite conflict target: insert-then-update the SAME row (both conflict cols excluded from SET)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const first = await aDb.upsert('pairs', ['business_key', 'vendor'], {
      title: 'first',
      business_key: 'BK',
      vendor: 'VEN',
    });
    expect(first?.title).toBe('first');
    const id = first?.id;
    // Same composite key, new title → DO UPDATE on the composite; SAME row updated (id unchanged).
    const second = await aDb.upsert('pairs', ['business_key', 'vendor'], {
      title: 'second',
      business_key: 'BK',
      vendor: 'VEN',
    });
    expect(second?.title).toBe('second');
    expect(second?.id).toBe(id);
    expect(await aDb.select('pairs', { business_key: 'BK' })).toHaveLength(1);
  });

  it('tenant-scoped unique (the secure pattern): per-tenant keys, scoped update, foreign key never conflicts', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const bDb = makeHandlerDb(forTenant(db, TENANT_B), productTables);
    // (i) A and B can EACH hold business_key='K' simultaneously (UNIQUE is (tenant_id, business_key)).
    const aRow = await aDb.upsert('scoped', ['tenant_id', 'business_key'], {
      title: 'A',
      business_key: 'K',
    });
    const bRow = await bDb.upsert('scoped', ['tenant_id', 'business_key'], {
      title: 'B',
      business_key: 'K',
    });
    expect(aRow?.tenant_id).toBe(TENANT_A);
    expect(bRow?.tenant_id).toBe(TENANT_B);
    // (ii) A.upsert updates ONLY A's row when A already holds it (B untouched).
    const aUpd = await aDb.upsert('scoped', ['tenant_id', 'business_key'], {
      title: 'A2',
      business_key: 'K',
    });
    expect(aUpd?.id).toBe(aRow?.id);
    expect(aUpd?.title).toBe('A2');
    const bStill = await bDb.select('scoped', { business_key: 'K' });
    expect(bStill).toHaveLength(1);
    expect(bStill[0]?.title).toBe('B'); // B's row untouched
    // (iii) a FOREIGN key never conflicts: only B holds 'K2'; A.upsert('K2') INSERTS a fresh A row
    // (returns it, NOT undefined — the tenant-scoped unique means (A,'K2') never collides with (B,'K2')).
    await bDb.upsert('scoped', ['tenant_id', 'business_key'], {
      title: 'B-only',
      business_key: 'K2',
    });
    const aFresh = await aDb.upsert('scoped', ['tenant_id', 'business_key'], {
      title: 'A-fresh',
      business_key: 'K2',
    });
    expect(aFresh).toBeDefined();
    expect(aFresh?.tenant_id).toBe(TENANT_A);
    expect(aFresh?.title).toBe('A-fresh');
    // Two distinct rows now hold business_key='K2' (one per tenant).
    expect(await aDb.select('scoped', { business_key: 'K2' })).toHaveLength(1);
    expect(await bDb.select('scoped', { business_key: 'K2' })).toHaveLength(1);
  });

  it('an empty-array IN filter matches NOTHING (never everything)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await aDb.insert('meetings', { title: 'a', completed: false });
    await aDb.insert('meetings', { title: 'b', completed: false });
    // title: [] → inArray(title, []) → drizzle emits `false` → 0 rows (NOT all rows). Pins the
    // 'empty IN matches nothing' invariant (a fail-OPEN bug would return every row).
    expect(await aDb.select('meetings', { title: [] })).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // SOFT DELETE on the FACADE (the richer read/write surface — declarative views, workflow
  // store_read/store_write nodes, tool/route/trigger handlers). The CRUD store routes already fold
  // `deleted_at IS NULL` + stamp the tombstone on delete; these prove `makeHandlerDb` enforces the SAME
  // "a tombstoned row is uniformly invisible" contract, so a view/workflow/handler read never resurfaces
  // a tombstoned row and a facade delete never HARD-deletes a softDelete store. A NON-softDelete store is
  // byte-behaviourally unchanged (physical delete). Fail-the-fix: disable the `visiblePredicate` fold in
  // `select` and the 'omits the tombstoned row' assertion goes RED.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('softDelete: facade delete STAMPS deleted_at (row physically survives) and hides it from select/count', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const keep = await aDb.insert('notes', { title: 'keep', done: false });
    const gone = await aDb.insert('notes', { title: 'soft-me', done: false });
    expect(await aDb.count?.('notes')).toBe(2);

    // Soft delete → returns 1 (one row tombstoned), NOT a hard delete.
    expect(await aDb.delete('notes', { id: gone.id })).toBe(1);

    // select OMITS the tombstoned row; count EXCLUDES it; the surviving row is untouched.
    const rows = await aDb.select('notes');
    expect(rows.map((r) => r.title)).toEqual(['keep']);
    expect(rows[0]?.id).toBe(keep.id);
    expect(await aDb.count?.('notes')).toBe(1);
    // A direct filter for the tombstoned row also returns nothing (a caller cannot widen back to a tombstone).
    expect(await aDb.select('notes', { id: gone.id })).toHaveLength(0);

    // The row PHYSICALLY survives at the DB level with deleted_at stamped (schema-qualified raw read,
    // bypassing the facade filter entirely — this is what "not a hard delete" means).
    const raw = (await db.$client.unsafe(`SELECT id, deleted_at FROM ${SCHEMA}.notes;`)) as Array<{
      id: string;
      deleted_at: Date | null;
    }>;
    expect(raw).toHaveLength(2); // BOTH rows physically present
    expect(raw.find((r) => r.id === gone.id)?.deleted_at).not.toBeNull(); // tombstoned
    expect(raw.find((r) => r.id === keep.id)?.deleted_at).toBeNull(); // alive
  });

  it('softDelete: update on a tombstoned row is a no-op (0 rows); a 2nd delete is a no-op (0)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const n = await aDb.insert('notes', { title: 'x', done: false });
    expect(await aDb.delete('notes', { id: n.id })).toBe(1);
    // update on the tombstoned row matches ZERO rows (uniform with the CRUD PATCH-on-tombstoned → 404).
    expect(await aDb.update('notes', { id: n.id }, { done: true })).toHaveLength(0);
    // a 2nd delete of the SAME row is a no-op (`deleted_at IS NULL` folded in → 0 rows tombstoned).
    expect(await aDb.delete('notes', { id: n.id })).toBe(0);
    // Still exactly ONE physical row, still tombstoned, done still false (the no-op update never applied).
    const raw = (await db.$client.unsafe(
      `SELECT done, deleted_at FROM ${SCHEMA}.notes;`,
    )) as Array<{
      done: boolean;
      deleted_at: Date | null;
    }>;
    expect(raw).toHaveLength(1);
    expect(raw[0]?.done).toBe(false);
    expect(raw[0]?.deleted_at).not.toBeNull();
  });

  it("softDelete: delete is still tenant-scoped (B cannot tombstone A's row)", async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const bDb = makeHandlerDb(forTenant(db, TENANT_B), productTables);
    const aRow = await aDb.insert('notes', { title: 'A', done: false });
    // B's soft-delete affects ZERO rows (the structural tenant predicate is AND-combined BENEATH the
    // tombstone filter by the TenantDb chokepoint — the soft-delete change never touched it).
    expect(await bDb.delete('notes', { id: aRow.id })).toBe(0);
    // A's row is untouched + still visible to A.
    expect(await aDb.select('notes', { id: aRow.id })).toHaveLength(1);
    const raw = (await db.$client.unsafe(`SELECT deleted_at FROM ${SCHEMA}.notes;`)) as Array<{
      deleted_at: Date | null;
    }>;
    expect(raw).toHaveLength(1);
    expect(raw[0]?.deleted_at).toBeNull(); // never tombstoned by B
  });

  it('positive control: a NON-softDelete store facade delete PHYSICALLY removes (byte-behaviourally unchanged)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const row = await aDb.insert('meetings', { title: 'hard', completed: false });
    expect(await aDb.count?.('meetings')).toBe(1);
    expect(await aDb.delete('meetings', { id: row.id })).toBe(1);
    // select + count show it gone AND it is PHYSICALLY removed (no tombstone semantics on a default store).
    expect(await aDb.select('meetings')).toHaveLength(0);
    expect(await aDb.count?.('meetings')).toBe(0);
    const raw = (await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM ${SCHEMA}.meetings;`,
    )) as Array<{ c: number }>;
    expect(raw[0]?.c).toBe(0); // PHYSICALLY gone — not tombstoned
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // SOFT DELETE + UNIQUE column (the write path over a tombstoned key). The facade `delete` tombstones,
  // but the facade `upsert`/`insert` write path was deliberately left soft-delete-UNAWARE: it resolves
  // ON CONFLICT against the physical, NON-partial `(tenant_id, code)` unique index, which still counts a
  // tombstoned row. This PINS the resulting `unique`-vs-tombstone behavior (a documented limitation, NOT
  // a bug to "fix" in production here) so a future regression — or a deliberate change to a partial index
  // — is a visible decision, and so the write path doubles as a read-path uniform-invisibility guard.
  // Consistent with store-soft-delete.db.test.ts, which names the same limitation for the CRUD path.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('softDelete + unique: upsert/insert over a TOMBSTONED unique key PINS the non-partial-index limitation (write updates the tombstone in place / a plain insert collides; the row stays invisible)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);

    // (1) Insert a row holding unique code='DOC-1', then soft-delete it: the tombstone SURVIVES physically
    //     still holding code='DOC-1' (the tenant-scoped unique (tenant_id, code) is NON-partial — it does
    //     NOT exclude tombstones). Read-path guard: it is invisible to a plain select (uniform invisibility).
    const original = await aDb.insert('docs', { title: 'v1', code: 'DOC-1' });
    expect(await aDb.delete('docs', { id: original.id })).toBe(1);
    expect(await aDb.select('docs')).toHaveLength(0);
    expect(await aDb.select('docs', { code: 'DOC-1' })).toHaveLength(0);

    // (2) WRITE PATH — facade `upsert` (the store_write conflict path) on the SAME unique key. The conflict
    //     target is the tenant-scoped compound unique (tenant_id, code); the tombstone occupies it, so the
    //     INSERT collides and the tenant-scoped DO-UPDATE (setWhere tenant_id = A) MATCHES the tombstone.
    //     PINNED ACTUAL BEHAVIOR: the upsert DO-UPDATEs the tombstoned row IN PLACE (same id, title→'v2')
    //     but does NOT clear `deleted_at` (the DO-UPDATE SET carries only the business columns; the facade
    //     upsert is soft-delete-UNAWARE) — so the row STAYS tombstoned/INVISIBLE. i.e. an upsert against a
    //     tombstoned key silently WRITES INTO the tombstone: it neither resurrects it nor inserts a fresh
    //     visible row. This is the documented unique-vs-tombstone limitation, pinned (not changed).
    const upserted = await aDb.upsert('docs', ['tenant_id', 'code'], {
      title: 'v2',
      code: 'DOC-1',
    });
    expect(upserted).toBeDefined(); // the tenant-scoped DO-UPDATE matched the tombstone → a row is returned
    expect(upserted?.id).toBe(original.id); // it updated the SAME physical (tombstoned) row, not a new one
    expect(upserted?.title).toBe('v2'); // the business column WAS updated…
    expect(upserted?.deleted_at).not.toBeNull(); // …but deleted_at is UNTOUCHED — the row is still a tombstone
    // Read-path guard AGAIN: still invisible after the upsert (the silent write did NOT resurface it).
    expect(await aDb.select('docs')).toHaveLength(0);
    expect(await aDb.select('docs', { code: 'DOC-1' })).toHaveLength(0);
    // Exactly ONE physical row survives, updated in place + still tombstoned (no 2nd row was inserted).
    const rawAfterUpsert = (await db.$client.unsafe(
      `SELECT title, deleted_at FROM ${SCHEMA}.docs;`,
    )) as Array<{ title: string; deleted_at: Date | null }>;
    expect(rawAfterUpsert).toHaveLength(1);
    expect(rawAfterUpsert[0]?.title).toBe('v2');
    expect(rawAfterUpsert[0]?.deleted_at).not.toBeNull();

    // (3) WRITE PATH — a PLAIN facade `insert` on the SAME tombstoned unique key. The tombstone still
    //     occupies the non-partial (tenant_id, code) index, so the INSERT COLLIDES → the facade sanitizes
    //     the 23505 to the neutral 'unique constraint violation' (no constraint name leaks). A plain insert
    //     CANNOT reuse a tombstoned unique value — mirrors the CRUD "re-create a unique value after a soft
    //     delete → 409" limitation (store-soft-delete.db.test.ts).
    await expect(aDb.insert('docs', { title: 'v3', code: 'DOC-1' })).rejects.toThrow(
      'unique constraint violation',
    );
    // The failed insert wrote nothing new: still exactly the one tombstoned row.
    const rawAfterInsert = (await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM ${SCHEMA}.docs;`,
    )) as Array<{ c: number }>;
    expect(rawAfterInsert[0]?.c).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // ENUM WHITELIST on the FACADE write funnels. A store column may declare an `enum` value whitelist;
  // the HTTP create/update route (a `z.enum`) and the workflow store.write node already reject an
  // out-of-whitelist value. These prove the low-level `HandlerDb` facade — the escape-hatch write
  // surface a tool/route/trigger handler holds — rejects the SAME out-of-whitelist value on EVERY write
  // funnel (insert / upsert / update), so a handler cannot persist a value the declared whitelist
  // forbids. Fail-the-fix: the `tickets` DDL is a plain `text` column with NO CHECK, so without the
  // facade check the illegal value writes fine at the DB level and these assertions go RED.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('enum: insert REJECTS an out-of-whitelist value; a whitelisted value SUCCEEDS; null on a nullable enum col is allowed', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // A whitelisted value writes (positive control — the check is not "reject everything").
    const ok = await aDb.insert('tickets', { title: 't1', status: 'open', priority: 'high' });
    expect(ok.status).toBe('open');
    expect(ok.priority).toBe('high');
    // A nullable enum column accepts null (a nullability concern, NOT an out-of-whitelist value) + omission.
    const nullable = await aDb.insert('tickets', { title: 't2', status: 'closed', priority: null });
    expect(nullable.priority).toBeNull();
    const omitted = await aDb.insert('tickets', { title: 't3', status: 'open' });
    expect(omitted.priority).toBeNull();
    // An out-of-whitelist value is rejected fail-closed (WITHOUT the fix this silently writes 'archived').
    await expect(aDb.insert('tickets', { title: 'bad', status: 'archived' })).rejects.toThrow(
      /not one of the declared allowed values/,
    );
    // The rejection names the store + column but NEVER the offending value (no cross-tenant value oracle).
    let caught: unknown;
    try {
      await aDb.insert('tickets', { title: 'bad2', status: 'leaked-secret-value' });
    } catch (e) {
      caught = e;
    }
    const msg = (caught as Error).message;
    expect(msg).toContain('tickets');
    expect(msg).toContain('status');
    expect(msg).not.toContain('leaked-secret-value');
    // Only the three legal rows landed — nothing illegal was persisted.
    expect((await aDb.select('tickets')).map((r) => r.status).sort()).toEqual([
      'closed',
      'open',
      'open',
    ]);
  });

  it('enum: a NON-STRING scalar on a whitelisted column is rejected (closes the scalar-non-string SF-1 bypass)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // SF-1 (assertValidValue) ACCEPTS a plain scalar number/boolean; the enum check must still reject it,
    // because a non-string value is by definition not a whitelisted member (parity with store.write).
    await expect(
      aDb.insert('tickets', { title: 'num', status: 5 as unknown as string }),
    ).rejects.toThrow(/not one of the declared allowed values/);
  });

  it('enum: update REJECTS an out-of-whitelist value (a whitelisted patch still applies)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const row = await aDb.insert('tickets', { title: 't', status: 'open' });
    await expect(aDb.update('tickets', { id: row.id }, { status: 'archived' })).rejects.toThrow(
      /not one of the declared allowed values/,
    );
    // A whitelisted update still applies (the check is value-specific, not column-blanket).
    const updated = await aDb.update('tickets', { id: row.id }, { status: 'closed' });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.status).toBe('closed');
  });

  it('enum: upsert REJECTS an out-of-whitelist value (the store.write conflict path is covered too)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // The enum check fires in the shared value-mapper BEFORE any DB conflict logic, so it rejects
    // regardless of the conflict target (no real unique index is needed to prove the rejection).
    await expect(
      aDb.upsert('tickets', ['title'], { title: 't-up', status: 'archived' }),
    ).rejects.toThrow(/not one of the declared allowed values/);
    // Nothing was written by the rejected upsert.
    expect(await aDb.select('tickets')).toHaveLength(0);
  });

  it('enum: a store with NO enum column is byte-behaviourally unchanged (any string status writes)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // `meetings` declares no enum column → no whitelist recorded → the facade never adds a check. A
    // free-form text value writes exactly as before (proves the check is opt-in, not global).
    const row = await aDb.insert('meetings', { title: 'anything-goes', completed: false });
    expect(row.title).toBe('anything-goes');
  });
});

/**
 * Un-skippable ran-guard (mirrors store-soft-delete.db.test.ts): a SEPARATE, NEVER-skipped describe that
 * FAILS when the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the main (skipIf-gated) DB arms did NOT
 * actually run — closing the false-green the collection-throw at the top does NOT catch: a future edit that
 * turns every `it()` above into `it.skip()` WHILE `hasDb` is true (DATABASE_URL present) would otherwise go
 * green with ZERO DB assertions. Because this describe is NOT skipIf-gated it always runs its `it()`, so the
 * FILE is never "all skipped" and the assertion below is always evaluated — the robust equivalent of the
 * requested guard. (An `afterAll` inside the main describe would NOT catch this: vitest treats a suite whose
 * tests are ALL skipped as a skipped FILE and never runs its afterAll — empirically verified on vitest 4.1.9.)
 */
describe('makeHandlerDb ran-guard (must not silently skip in CI)', () => {
  it('the facade DB arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBeGreaterThan(0);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
