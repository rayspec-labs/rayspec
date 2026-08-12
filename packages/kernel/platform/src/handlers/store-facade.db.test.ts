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
    // worst-case upsert conflict target (the cross-tenant-write attack surface the upsert's setWhere guards).
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

// BIGINT fixture — a 64-bit column. The facade is the OTHER write chokepoint (beside the HTTP body
// validator) and the ONLY read chokepoint for handlers, the workflow `store_read` node, and the
// declarative views interpreter, so the JSON-boundary rule has to hold here too: a value crosses as a
// plain JS number while |v| <= Number.MAX_SAFE_INTEGER, and beyond that it is refused rather than
// rounded. On `main` a BigInt write does not even reach the driver — `assertValidValue` classifies it
// as a forbidden non-data value (SF-1) with a misleading SQL-injection message.
const usageStore: StoreSpec = {
  name: 'usage_totals',
  columns: [{ name: 'bytes_total', type: 'bigint', nullable: false, unique: false }],
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
  usageStore,
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
        -- can collide on the SAME business_key, so the upsert's tenant-scoped DO-UPDATE setWhere is what stops a
        -- cross-tenant overwrite. (Multiple NULL business_keys are allowed — Postgres NULLs are distinct.)
        CONSTRAINT meetings_business_key_global_unique UNIQUE (business_key)
      );
      -- ensure-exists fixture: only business column is the conflict target → empty DO-UPDATE SET.
      CREATE TABLE tags (
        ${before},
        name text NOT NULL,
        ${after},
        CONSTRAINT tags_name_global_unique UNIQUE (name)
      );
      -- two-global-uniques fixture: TWO individual global uniques (a conflict on vendor while the ON CONFLICT target
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
      -- composite-unique fixture: a COMPOSITE global unique (business_key, vendor).
      CREATE TABLE pairs (
        ${before},
        title text NOT NULL,
        business_key text NOT NULL,
        vendor text NOT NULL,
        ${after},
        CONSTRAINT pairs_bk_vendor_unique UNIQUE (business_key, vendor)
      );
      -- tenant-scoped-unique fixture: a TENANT-SCOPED unique (tenant_id, business_key) — the recommended secure pattern.
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
      -- BIGINT fixture: a real int8 column, so the driver hands the facade a value the platform must
      -- either represent exactly or refuse.
      CREATE TABLE usage_totals (
        ${before},
        bytes_total bigint NOT NULL,
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

/**
 * The statements Drizzle actually SENT for the calls made inside `fn`. The session logger is the
 * driver-level seam, so this is the EMITTED SQL — not a re-render of a builder the facade holds
 * privately — which is what lets a test pin the exact `ORDER BY` a facade read compiles to.
 *
 * `db.session.logger` is INTERNAL to Drizzle (TS-private), written against drizzle-orm 0.45.2. It
 * fails closed rather than silently: if a version bump moves the seam, no statement is captured and
 * the assertions below fail on an empty string instead of quietly passing. If that happens, this
 * helper — not the facade — is what needs updating.
 */
async function capturedSql(
  db: ReturnType<typeof makeDbWithSchema>,
  fn: () => Promise<unknown>,
): Promise<string[]> {
  const session = db as unknown as {
    session: { logger: { logQuery(query: string, params: unknown[]): void } };
  };
  const previous = session.session.logger;
  const statements: string[] = [];
  session.session.logger = {
    logQuery: (query) => {
      statements.push(query);
    },
  };
  try {
    await fn();
  } finally {
    session.session.logger = previous;
  }
  return statements;
}

/** The `order by …` tail of an emitted statement (empty when the statement carries none). */
function orderByClause(statement: string): string {
  const at = statement.indexOf('order by ');
  return at === -1 ? '' : statement.slice(at);
}

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
      usageStore,
    ]);
    unregister = registerScopedTables([...productTables.values()]);
  });

  afterAll(async () => {
    unregister?.();
    await db?.$client.end();
  });

  beforeEach(async () => {
    await db.$client.unsafe(
      `SET search_path TO ${SCHEMA}; TRUNCATE meetings, tags, gizmos, pairs, scoped, notes, docs, tickets, usage_totals CASCADE;`,
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
    // A non-scalar in a FILTER value → throw (the read path is guarded too). On a READ filter a
    // plain object is classified against the comparison-operator form (`{ gt/gte/lt/lte }`) first,
    // so THIS reject names the malformed comparison — still a fail-closed StoreInputError before
    // anything reaches the driver (a real Drizzle SQL object is a class instance, never enters the
    // operator path at all, and keeps the plain-scalar SF-1 reject).
    await expect(aDb.select('meetings', { title: sqlish as unknown as string })).rejects.toThrow(
      /not a well-formed comparison/,
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

  it('transaction() runs the body in a tenant tx that COMMITS its writes (the GUC seam)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await aDb.transaction(async (tx) => {
      await tx.insert('meetings', { title: 'in-tx', completed: false });
    });
    // The row was committed inside the facade's transaction (which delegates to TenantDb.transaction,
    // populating the app.current_tenant GUC — the SAME-transaction GUC read-back is the authoritative
    // api-auth GUC-seam test; here we prove the facade's tx actually wraps + commits the write).
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
  // ATOMIC upsert (INSERT … ON CONFLICT DO UPDATE), structurally tenant-safe.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('CROSS-TENANT GUARD: A.upsert on a GLOBAL-unique conflict NEVER overwrites B (the setWhere line)', async () => {
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

  it('SAME-TENANT: upsert INSERTS then UPDATES this tenant’s row on the same key (returns it)', async () => {
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

  it('upsert runs the SF-1 / server-controlled guards (no new trust surface)', async () => {
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
  // Read-opts: batched inArray (column-type-aware) + orderBy/limit/offset.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('jsonb-vs-inArray: an ARRAY value is set-membership on a SCALAR col, EQUALITY on a jsonb col', async () => {
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

  it('inArray elements are SF-1 guarded (a crafted non-data element is rejected fail-closed)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // One element is a Drizzle-SQL-ish object → the whole filter is rejected (no injection via the batch).
    await expect(
      aDb.select('meetings', {
        title: ['ok', { queryChunks: ['; DROP TABLE meetings; --'] } as unknown as string],
      }),
    ).rejects.toThrow(/forbidden non-data value|must be a plain scalar/);
  });

  it('orderBy + limit + offset: server-side ordering/paging, still tenant-scoped', async () => {
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

  it('NO orderBy: the read comes back in `id` asc, not in physical row order', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const bDb = makeHandlerDb(forTenant(db, TENANT_B), productTables);
    const titles = ['t1', 't2', 't3', 't4', 't5'];
    for (const title of titles) await aDb.insert('meetings', { title, completed: false });
    // A B row that would sort FIRST under the default order (its id is rewritten below to the
    // lowest of all) — the default must never widen the read past the tenant predicate.
    await bDb.insert('meetings', { title: 'b-first', completed: false });

    // Make the PHYSICAL order provably differ from `id` order, so the expectation below cannot come
    // out right by coincidence. First rewrite the ids so `id` asc is the REVERSE of the insert order
    // (`id` is server-controlled — a handler may never set one, so this goes around the facade) …
    for (const [i, title] of titles.entries()) {
      await db.$client.unsafe(`UPDATE ${SCHEMA}.meetings SET id = $1 WHERE title = $2`, [
        `00000000-0000-0000-0000-00000000000${titles.length - i}`,
        title,
      ]);
    }
    await db.$client.unsafe(`UPDATE ${SCHEMA}.meetings SET id = $1 WHERE title = 'b-first'`, [
      '00000000-0000-0000-0000-000000000000',
    ]);
    // … then move the row that must come LAST under `id` asc to the END of the heap: an UPDATE
    // writes a NEW tuple version, so a plain scan returns that row last. Physical order is now
    // t2,t3,t4,t5,t1 — neither the insert order nor the `id` order.
    await db.$client.unsafe(`UPDATE ${SCHEMA}.meetings SET completed = true WHERE title = 't1'`);

    const rows = await aDb.select('meetings');
    expect(rows.map((r) => r.title)).toEqual(['t5', 't4', 't3', 't2', 't1']);
    for (const r of rows) expect(r.tenant_id).toBe(TENANT_A); // B's lower-id row stays invisible
    // The same default makes a BOUNDED read deterministic — a `{ limit }`/`{ offset }` caller that
    // declares no ordering now gets a DEFINED window instead of an arbitrary one.
    const page = await aDb.select('meetings', {}, { limit: 2, offset: 1 });
    expect(page.map((r) => r.title)).toEqual(['t4', 't3']);
  });

  it('a caller-supplied orderBy is emitted UNCHANGED (both directions, multi-column, no tiebreaker)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await aDb.insert('meetings', { title: 'b', completed: true });
    await aDb.insert('meetings', { title: 'a', completed: false });
    await aDb.insert('meetings', { title: 'b', completed: false });

    // ROWS — asc, desc, and the multi-column shape, each still exactly the caller's order.
    const up = await aDb.select('meetings', {}, { orderBy: [{ column: 'title', dir: 'asc' }] });
    expect(up.map((r) => r.title)).toEqual(['a', 'b', 'b']);
    const down = await aDb.select(
      'meetings',
      {},
      { orderBy: [{ column: 'title', dir: 'desc' }], limit: 1 },
    );
    expect(down.map((r) => r.title)).toEqual(['b']);
    const twoKeys = await aDb.select(
      'meetings',
      {},
      {
        orderBy: [
          { column: 'title', dir: 'desc' },
          { column: 'completed', dir: 'asc' },
        ],
      },
    );
    expect(twoKeys.map((r) => [r.title, r.completed])).toEqual([
      ['b', false],
      ['b', true],
      ['a', false],
    ]);

    // SQL — the compiled ORDER BY is EXACTLY the caller's columns: the default appends NOTHING to a
    // caller's ordering (no `id` tiebreaker), so a pre-existing ordered read is byte-identical.
    const [ordered] = await capturedSql(db, () =>
      aDb.select(
        'meetings',
        {},
        {
          orderBy: [
            { column: 'title', dir: 'desc' },
            { column: 'completed', dir: 'asc' },
          ],
        },
      ),
    );
    expect(orderByClause(ordered ?? '')).toBe(
      'order by "meetings"."title" desc, "meetings"."completed" asc',
    );
    // … and the default itself is a single `id asc` — the same ordering the HTTP `list` op applies.
    const [unordered] = await capturedSql(db, () => aDb.select('meetings'));
    expect(orderByClause(unordered ?? '')).toBe('order by "meetings"."id" asc');
  });

  // The CONSEQUENCE of "used verbatim, with nothing appended" — the empirical half of the hazard, not
  // only the emitted SQL. Both author-facing statements of it are named here so an edit to either is
  // followed to this case: the handler-facade ordering paragraph in `docs/spec-reference.md` ("That
  // matters for offset paging: … an ordering of your own on a non-unique column is not a total order,
  // and Postgres may break the ties differently between two page queries — a row can then repeat or
  // be skipped. Pair such an ordering with a unique tiebreaker (a trailing `id` column).") and the
  // `offset` docstring on `SelectOptions` in `packages/kernel/handler-sdk/src/index.ts`, which states
  // the same thing to the handler author who reaches for `limit`/`offset`.
  it('offset paging over a NON-UNIQUE orderBy repeats one row and skips another (the documented no-tiebreaker hazard)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // Four rows whose caller-supplied sort key is ALL EQUAL — `title asc` is then a total order over
    // NOTHING, so no part of either page statement decides which tied row lands in which page.
    // `business_key` only labels the rows for the assertions below; it is never ordered on.
    const keys = ['k1', 'k2', 'k3', 'k4'];
    for (const key of keys) {
      await aDb.insert('meetings', { title: 'dup', completed: false, business_key: key });
    }
    const paged = { orderBy: [{ column: 'title', dir: 'asc' as const }], limit: 2 };

    let page1: Awaited<ReturnType<typeof aDb.select>> = [];
    const [page1Sql] = await capturedSql(db, async () => {
      page1 = await aDb.select('meetings', {}, { ...paged, offset: 0 });
    });
    // BETWEEN the two page queries, move a row page 1 ALREADY RETURNED to the end of the heap: an
    // UPDATE writes a NEW tuple version, so the scan reaches that row last from here on (the same
    // technique the `id asc` default case above uses to make physical order differ from the read
    // order). The sort key is untouched — `completed` is not ordered on — so nothing the caller's
    // ORDER BY can see has changed. That is the point: with no unique tiebreaker, ordinary write
    // traffic on an unrelated column between two pages is enough to shuffle the tied rows.
    const moved = page1[0]?.business_key;
    expect(moved).toBeDefined();
    await db.$client.unsafe(
      `UPDATE ${SCHEMA}.meetings SET completed = true WHERE business_key = $1`,
      [moved],
    );

    let page2: Awaited<ReturnType<typeof aDb.select>> = [];
    const [page2Sql] = await capturedSql(db, async () => {
      page2 = await aDb.select('meetings', {}, { ...paged, offset: 2 });
    });

    // ROWS — the outcome is BOTH arms of the documented pair, not one of them: the rewritten row
    // REPEATS on page 2, and one row is SKIPPED, never returned by either page, even though the two
    // pages together span a 4-row table in 2-row windows. WHICH row is skipped follows Postgres'
    // tuple visitation order, so it is derived here rather than named — pinning its identity would
    // pin the storage engine instead of the documented hazard. Both assertions are false under ANY
    // total order: with a unique tiebreaker the two pages partition the four rows, which is exactly
    // what the control below gets from the same rows under the same kind of rewrite.
    const page1Keys = page1.map((r) => r.business_key);
    const page2Keys = page2.map((r) => r.business_key);
    const skipped = keys.filter((k) => !page1Keys.includes(k) && !page2Keys.includes(k));
    expect(page1Keys.filter((k) => page2Keys.includes(k))).toEqual([moved]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).not.toBe(moved);

    // SQL — both page statements carry EXACTLY the caller's single non-unique column and nothing
    // else. Appending a unique tiebreaker to a caller's ordering would make the repeat above
    // unreachable and both documented sentences false, so the assertion guarding the sentence lives
    // in the case that demonstrates it.
    expect(orderByClause(page1Sql ?? '')).toBe('order by "meetings"."title" asc limit $2');
    expect(orderByClause(page2Sql ?? '')).toBe(
      'order by "meetings"."title" asc limit $2 offset $3',
    );

    // CONTROL — the remedy both documents prescribe, over the same rows and the same perturbation:
    // the caller pairs its non-unique column with a trailing `id`. The rewrite still moves the row
    // in the heap — what it no longer moves is the READ order, because the ordering is now total —
    // so the two pages partition the rows and nothing repeats or is skipped.
    // (The `id` here is the CALLER's — the facade still appends nothing, as the compiled statement
    // asserts.)
    const tiebroken = {
      orderBy: [
        { column: 'title', dir: 'asc' as const },
        { column: 'id', dir: 'asc' as const },
      ],
      limit: 2,
    };
    let stable1: Awaited<ReturnType<typeof aDb.select>> = [];
    const [stable1Sql] = await capturedSql(db, async () => {
      stable1 = await aDb.select('meetings', {}, { ...tiebroken, offset: 0 });
    });
    await db.$client.unsafe(
      `UPDATE ${SCHEMA}.meetings SET completed = false WHERE business_key = $1`,
      [stable1[0]?.business_key],
    );
    let stable2: Awaited<ReturnType<typeof aDb.select>> = [];
    const [stable2Sql] = await capturedSql(db, async () => {
      stable2 = await aDb.select('meetings', {}, { ...tiebroken, offset: 2 });
    });
    const stable1Keys = stable1.map((r) => r.business_key);
    const stable2Keys = stable2.map((r) => r.business_key);
    expect(stable1Keys.filter((k) => stable2Keys.includes(k))).toEqual([]);
    expect([...stable1Keys, ...stable2Keys].sort()).toEqual(keys);
    // BOTH control statements are asserted, symmetrically with the hazard arm above: appending a
    // tiebreaker in the facade would red the hazard arm, and dropping the caller's own trailing `id`
    // here would red the control — the two directions of the same sentence.
    expect(orderByClause(stable1Sql ?? '')).toBe(
      'order by "meetings"."title" asc, "meetings"."id" asc limit $2',
    );
    expect(orderByClause(stable2Sql ?? '')).toBe(
      'order by "meetings"."title" asc, "meetings"."id" asc limit $2 offset $3',
    );
  });

  it('orderBy FAILS CLOSED on an unknown column (resolveColumn)', async () => {
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
    // (Fail-the-fix: revert the empty-set DO-NOTHING guard and the 1st upsert RAISES "No values to set" — this test goes RED.)
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
    // existence oracle). Fail-the-fix: WITHOUT the unique-violation sanitizer the raw 'duplicate key value violates unique
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

  it('conditional upsert (updateWhere): overwrites ONLY a row still matching the guard; a row that left the guarded state no-ops (undefined) and is UNTOUCHED', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // A staged row on the GLOBAL-unique business_key (completed=false is the guarded "still staged" state).
    const seeded = await aDb.insert('meetings', {
      title: 'v1',
      completed: false,
      business_key: 'K',
    });
    const id = seeded.id;

    // (i) GUARD MATCHES (row still completed=false): the ON CONFLICT DO UPDATE applies — the SAME row is
    // overwritten (id unchanged) and returned.
    const matched = await aDb.upsert(
      'meetings',
      ['business_key'],
      { title: 'v2', completed: true, business_key: 'K' },
      { updateWhere: { completed: false } },
    );
    expect(matched?.id).toBe(id);
    expect(matched?.title).toBe('v2');
    expect(matched?.completed).toBe(true);

    // (ii) The SAME conditional upsert now MIS-matches (the row is completed=true; the guard wants false)
    // → the tenant-scoped DO-UPDATE + the AND-ed updateWhere match ZERO rows → RETURNING empty →
    // `undefined` (the fail-closed no-op), and the row is UNTOUCHED. This is the state-guarded first-write
    // close. WITHOUT the setWhere guard the DO UPDATE would overwrite the row to 'v3'/completed=false
    // regardless — the RED direction (revert the `updateWhere` → `setWhere` wiring and this goes red).
    const blocked = await aDb.upsert(
      'meetings',
      ['business_key'],
      { title: 'v3', completed: false, business_key: 'K' },
      { updateWhere: { completed: false } },
    );
    expect(blocked).toBeUndefined();
    const after = await aDb.select('meetings', { business_key: 'K' });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id, title: 'v2', completed: true });

    // (iii) A no-`updateWhere` upsert stays UNCONDITIONAL (the pre-existing behavior, byte-unchanged): it
    // DOES overwrite the same row — proving `updateWhere` alone gated (ii), not some other guard.
    const unconditional = await aDb.upsert('meetings', ['business_key'], {
      title: 'v4',
      completed: false,
      business_key: 'K',
    });
    expect(unconditional?.id).toBe(id);
    expect(unconditional?.title).toBe('v4');
  });

  it('conditional upsert (updateWhere): a NO-conflict call still INSERTS (the guard only scopes the DO-UPDATE arm)', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // No row on business_key 'FRESH' → no conflict → the guard is irrelevant and the row INSERTS
    // (returns the row, never undefined). Guards the first-upload happy path: a genuine first write is
    // never blocked by its own updateWhere.
    const inserted = await aDb.upsert(
      'meetings',
      ['business_key'],
      { title: 'fresh', completed: false, business_key: 'FRESH' },
      { updateWhere: { completed: false } },
    );
    expect(inserted).toBeDefined();
    expect(inserted?.title).toBe('fresh');
    expect(inserted?.tenant_id).toBe(TENANT_A);
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

  it('bigint: a BigInt and a safe-integer number both write; a non-safe number is refused', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // On `main` this FIRST line throws: `typeof 1n` is none of string/number/boolean, a BigInt is not
    // a Date and not `typeof 'object'`, so it lands in the forbidden-non-data (SF-1) arm with a
    // SQL-injection message — i.e. the facade cannot write the type at all.
    const asBig = await aDb.insert('usage_totals', { bytes_total: 3000000000n });
    expect(asBig.bytes_total).toBe(3000000000);
    // A plain number is the SDK's "plain serializable rows" shape — it must work too, and it is what
    // a generated handler emits (no generated product source ever contains a BigInt literal).
    const asNum = await aDb.insert('usage_totals', { bytes_total: 4000000000 });
    expect(asNum.bytes_total).toBe(4000000000);

    // The write bound is the SAME boundary the HTTP validator applies, at the other write chokepoint:
    // the platform must never write through one path what a read on another is then obliged to refuse.
    await expect(
      aDb.insert('usage_totals', { bytes_total: 9007199254740993n }),
    ).rejects.toBeInstanceOf(StoreInputError);
    await expect(aDb.insert('usage_totals', { bytes_total: 1.5 })).rejects.toBeInstanceOf(
      StoreInputError,
    );
  });

  it('bigint: a STRING is refused BEFORE the driver, so no row is committed', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // Without a TOTAL bigint arm the write bound is bypassable by a string — and a string is the
    // normal shape a 64-bit value takes when it travels as JSON, so the workflow store_write node
    // hands one straight through from an {event:}/{artifact:} source. postgres.js `inferType` returns
    // OID 0 for a string (an UNTYPED parameter), PostgreSQL resolves that to the int8 column and
    // parses it with `int8in`, and drizzle's PgBigInt64 declares no `mapToDriverValue` — so the value
    // would be stored EXACTLY. `integer` is not a precedent for allowing it: an int4 column is
    // NARROWER than the platform bound, so PostgreSQL raises 22003 itself; an int8 column is WIDER,
    // and the platform is the only thing that can hold the ±9007199254740991 line.
    await expect(aDb.insert('usage_totals', { bytes_total: '3000000000' })).rejects.toBeInstanceOf(
      StoreInputError,
    );
    // The out-of-range string is the case that matters most. This insert is AUTO-COMMIT, so a value
    // that slipped past the guard would COMMIT and only then fail when the RETURNING row is
    // serialized — leaving a committed row that no read on any path can return (every later select
    // through the facade, the workflow store_read node, the views interpreter and the REST list route
    // would refuse it), i.e. exactly what this file's own contract forbids.
    await expect(
      aDb.insert('usage_totals', { bytes_total: '9007199254740993' }),
    ).rejects.toBeInstanceOf(StoreInputError);
    // Refused BEFORE the driver, not after: the table is still empty. This is the half a
    // rejects.toBeInstanceOf assertion alone would NOT catch, because the read-side guard throws the
    // same error class on the RETURNING row of a write that already landed.
    expect(await aDb.select('usage_totals')).toEqual([]);
  });

  it('bigint: a BigInt aimed at a NON-bigint column is still SF-1, not an unmapped driver fault', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // The accepted-scalar early return for a BigInt is narrowed to a BIGINT column on purpose. Its
    // range is checked in `coerceForColumn`, and that check fires ONLY for a bigint column — so a
    // BigInt aimed at any other type would have nothing checking it and would reach the driver, where
    // a `jsonb` column's mapper is `JSON.stringify` and throws an unmapped `TypeError: Do not know
    // how to serialize a BigInt`. The api layer maps StoreInputError to 400 and everything else to
    // 500, so widening the arm would turn a fail-closed 400 on a deny-by-default chokepoint into a
    // 500. Both of these are 400s here and on `main`.
    await expect(
      aDb.insert('meetings', { title: 't', completed: false, metadata: 1n }),
    ).rejects.toBeInstanceOf(StoreInputError);
    await expect(aDb.insert('meetings', { title: 1n, completed: false })).rejects.toBeInstanceOf(
      StoreInputError,
    );
  });

  it('bigint: a select hands back a plain NUMBER, and refuses a row seeded past the bound', async () => {
    testsRan += 1;
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await aDb.insert('usage_totals', { bytes_total: 9007199254740991n });
    const rows = await aDb.select('usage_totals');
    // NOT a BigInt: a handler's JSON response and the workflow journal write both throw on one
    // (`JSON.stringify` cannot serialize a BigInt), and the views interpreter's `matchesLeafType`
    // ('integer' ⇒ typeof 'number') would reject it and silently substitute the leaf default.
    expect(typeof rows[0]?.bytes_total).toBe('number');
    expect(rows[0]?.bytes_total).toBe(9007199254740991);

    // "Arrived by another route": a hand-written migration, a direct SQL write, or a column that was
    // `integer` before a reviewed type change. The literal stays in the SQL text — putting it through
    // a JS number would round it before it reached the column.
    await db.$client.unsafe(
      `SET search_path TO ${SCHEMA}; UPDATE usage_totals SET bytes_total = 9007199254740993`,
    );
    await expect(aDb.select('usage_totals')).rejects.toBeInstanceOf(StoreInputError);
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
