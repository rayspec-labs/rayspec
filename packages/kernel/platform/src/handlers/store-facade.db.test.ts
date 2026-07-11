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
import { forTenant } from '@rayspec/db';
import { buildProductTables, makeDbWithSchema, registerScopedTables } from '@rayspec/db/testing';
import type { StoreSpec } from '@rayspec/spec';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeHandlerDb } from './store-facade.js';

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

// F1 fixture — a store whose ONLY business column is the conflict target, so an ensure-exists upsert
// (`upsert('tags',['name'],{name})`) yields a genuinely EMPTY DO-UPDATE SET (the empty-set crash case).
const tagsStore: StoreSpec = {
  name: 'tags',
  columns: [{ name: 'name', type: 'text', nullable: false, unique: true }],
  foreignKeys: [],
};

// XT-1 fixture — TWO INDIVIDUAL global uniques (business_key AND vendor). A conflict on `vendor` while
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

// TQ-3 fixture — a COMPOSITE global unique (business_key, vendor), no individual uniques.
const pairsStore: StoreSpec = {
  name: 'pairs',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: false },
    { name: 'business_key', type: 'text', nullable: false, unique: false },
    { name: 'vendor', type: 'text', nullable: false, unique: false },
  ],
  foreignKeys: [],
};

// TQ-4 fixture — a TENANT-SCOPED unique (tenant_id, business_key): the RECOMMENDED secure pattern, where
// two tenants may each hold the same business_key and a foreign key never conflicts.
const scopedStore: StoreSpec = {
  name: 'scoped',
  columns: [
    { name: 'title', type: 'text', nullable: false, unique: false },
    { name: 'business_key', type: 'text', nullable: false, unique: false },
  ],
  foreignKeys: [],
};

describe.skipIf(!hasDb)('makeHandlerDb — over the real TenantDb chokepoint', () => {
  let db: ReturnType<typeof makeDbWithSchema>;
  let productTables: Map<string, PgTable>;
  let unregister: () => void;

  beforeAll(async () => {
    db = makeDbWithSchema(process.env.DATABASE_URL as string, SCHEMA);
    await db.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      SET search_path TO ${SCHEMA};
      CREATE TABLE orgs (id uuid PRIMARY KEY, name text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE meetings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        title text NOT NULL,
        completed boolean NOT NULL,
        scheduled_at timestamptz,
        metadata jsonb,
        business_key text,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz, retention_days integer, region text NOT NULL DEFAULT 'eu',
        -- GLOBAL (NOT tenant-scoped) unique — the worst case for an upsert conflict target: two tenants
        -- can collide on the SAME business_key, so C1's tenant-scoped DO-UPDATE setWhere is what stops a
        -- cross-tenant overwrite. (Multiple NULL business_keys are allowed — Postgres NULLs are distinct.)
        CONSTRAINT meetings_business_key_global_unique UNIQUE (business_key)
      );
      -- F1 ensure-exists fixture: only business column is the conflict target → empty DO-UPDATE SET.
      CREATE TABLE tags (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz, retention_days integer, region text NOT NULL DEFAULT 'eu',
        CONSTRAINT tags_name_global_unique UNIQUE (name)
      );
      -- XT-1 fixture: TWO individual global uniques (a conflict on vendor while the ON CONFLICT target
      -- is business_key is the "DIFFERENT unique" 23505 the sanitizer must neutralize).
      CREATE TABLE gizmos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        title text NOT NULL,
        business_key text,
        vendor text,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz, retention_days integer, region text NOT NULL DEFAULT 'eu',
        CONSTRAINT gizmos_business_key_unique UNIQUE (business_key),
        CONSTRAINT gizmos_vendor_unique UNIQUE (vendor)
      );
      -- TQ-3 fixture: a COMPOSITE global unique (business_key, vendor).
      CREATE TABLE pairs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        title text NOT NULL,
        business_key text NOT NULL,
        vendor text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz, retention_days integer, region text NOT NULL DEFAULT 'eu',
        CONSTRAINT pairs_bk_vendor_unique UNIQUE (business_key, vendor)
      );
      -- TQ-4 fixture: a TENANT-SCOPED unique (tenant_id, business_key) — the recommended secure pattern.
      CREATE TABLE scoped (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        title text NOT NULL,
        business_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz, retention_days integer, region text NOT NULL DEFAULT 'eu',
        CONSTRAINT scoped_tenant_bk_unique UNIQUE (tenant_id, business_key)
      );
      INSERT INTO orgs (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
    `);
    productTables = buildProductTables([
      meetingsStore,
      tagsStore,
      gizmosStore,
      pairsStore,
      scopedStore,
    ]);
    unregister = registerScopedTables([...productTables.values()]);
  });

  afterAll(async () => {
    unregister?.();
    await db?.$client.end();
  });

  beforeEach(async () => {
    await db.$client.unsafe(
      `SET search_path TO ${SCHEMA}; TRUNCATE meetings, tags, gizmos, pairs, scoped CASCADE;`,
    );
  });

  it('insert auto-stamps tenant_id; select is tenant-scoped (cross-tenant invisible)', async () => {
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

  it('select honors a snake_case column-equality filter (mapped to the camel Drizzle key)', async () => {
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await aDb.insert('meetings', { title: 'done', completed: true });
    await aDb.insert('meetings', { title: 'pending', completed: false });
    const done = await aDb.select('meetings', { completed: true });
    expect(done).toHaveLength(1);
    expect(done[0]?.title).toBe('done');
  });

  it('TEN-1 count: tenant-scoped SELECT count(*) honoring the filter; fail-closed on unknown store/column', async () => {
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
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await expect(aDb.select('not_a_store')).rejects.toThrow(/not a declared product store/);
    await expect(aDb.insert('also_missing', { x: 1 })).rejects.toThrow(
      /not a declared product store/,
    );
  });

  it('#1 FAILS CLOSED on every auth/core table name (orgs/users/sessions/runs/journal_steps/…)', async () => {
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

  it('#2 defense-in-depth: even at the TenantDb layer a foreign tenant_id lands under the run tenant', async () => {
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
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    const row = await aDb.insert('meetings', { title: 'byid', completed: false });
    // Filtering by the injected `id` is legitimate (the throwaway lookup tool does exactly this).
    const found = await aDb.select('meetings', { id: row.id });
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe('byid');
  });

  it('SF-1 REJECTS a non-plain-scalar VALUE (object/array/SQL-ish) in insert/update/filter', async () => {
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
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await expect(
      aDb.insert('meetings', { title: { not: 'a string' } as unknown as string, completed: false }),
    ).rejects.toThrow(/must be a plain scalar.*non-jsonb/s);
  });

  it('SF-2 coerces an ISO-STRING timestamp value to a Date on insert (plain-row contract)', async () => {
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
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await expect(
      aDb.insert('meetings', { title: 'bad', completed: false, scheduled_at: 'not-a-date' }),
    ).rejects.toThrow(/not a valid date/);
  });

  it('TenantDb backstop: update with tenantId in the SET does NOT move the row', async () => {
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
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    // One element is a Drizzle-SQL-ish object → the whole filter is rejected (no injection via the batch).
    await expect(
      aDb.select('meetings', {
        title: ['ok', { queryChunks: ['; DROP TABLE meetings; --'] } as unknown as string],
      }),
    ).rejects.toThrow(/forbidden non-data value|must be a plain scalar/);
  });

  it('C11 orderBy + limit + offset: server-side ordering/paging, still tenant-scoped', async () => {
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
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await expect(
      aDb.select('meetings', {}, { orderBy: [{ column: 'nonexistent', dir: 'asc' }] }),
    ).rejects.toThrow(/column 'nonexistent' is not a column/);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // FIX ROUND (C1/C11 hardening) — empty DO-UPDATE SET (F1), sanitized unique-violation (XT-1),
  // limit/offset guard (F2), concurrency (TQ-1), composite/tenant-scoped/empty-IN edge cases.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('F1 ensure-exists: an upsert whose values ARE the conflict columns uses DO NOTHING (no crash)', async () => {
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

  it('XT-1 sanitizes a unique-violation on a DIFFERENT global unique (no constraint name leaks)', async () => {
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

  it('F2 select limit/offset fail-closed on a non-negative-integer guard (no silent over-read)', async () => {
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
    // TQ-5: limit:0 is VALID — returns 0 rows (never "all rows").
    expect(await aDb.select('meetings', {}, { limit: 0 })).toHaveLength(0);
  });

  it('TQ-1 concurrent same-key upserts: exactly ONE row, neither rejects with a 23505', async () => {
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

  it('TQ-3 composite conflict target: insert-then-update the SAME row (both conflict cols excluded from SET)', async () => {
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

  it('TQ-4 tenant-scoped unique (the secure pattern): per-tenant keys, scoped update, foreign key never conflicts', async () => {
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

  it('TQ-2 an empty-array IN filter matches NOTHING (never everything)', async () => {
    const aDb = makeHandlerDb(forTenant(db, TENANT_A), productTables);
    await aDb.insert('meetings', { title: 'a', completed: false });
    await aDb.insert('meetings', { title: 'b', completed: false });
    // title: [] → inArray(title, []) → drizzle emits `false` → 0 rows (NOT all rows). Pins the
    // 'empty IN matches nothing' invariant (a fail-OPEN bug would return every row).
    expect(await aDb.select('meetings', { title: [] })).toHaveLength(0);
  });
});
