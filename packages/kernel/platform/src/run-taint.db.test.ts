/**
 * The run-taint SECURITY PRIMITIVE proven DETERMINISTICALLY, decoupled from the DBOS path.
 *
 * `markRunTainted` / `isRunTainted` are the durable quarantine primitive every automated re-run path
 * consults (the in-request transient-release, the worker's at-least-once retry). The end-to-end behavior
 * is exercised by the DBOS integration tests, but those launch a real engine and are slower/heavier. This
 * unit-proves the primitive directly against a REAL Postgres ISOLATED schema (no DBOS, no engine) so a
 * regression in the security gate is caught fast and deterministically:
 *
 *  (a) IDEMPOTENT — marking the same runId twice yields EXACTLY ONE run_taint row (ON CONFLICT DO NOTHING).
 *  (b) TENANT-SCOPED — mark under tenant A; a tenant-B read reads false, a tenant-A read reads true (the
 *      TenantDb chokepoint predicate is structural — no cross-tenant taint leak).
 *  (c) NO SCOPE COLLISION — a run_started / agent_run / trigger row under the SAME runId does NOT make the
 *      run read as tainted (the run_taint scope is distinct), and vice-versa.
 *
 * Self-isolating: its OWN schema (never the shared rayspec_test_platform), so it never races another
 * platform db suite under the CI vitest-run path. Skips when DATABASE_URL is absent.
 */
import { forTenant } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isRunTainted, markRunTainted, RUN_TAINT_SCOPE } from './run-taint.js';

const SCHEMA = 'rayspec_test_runtaint';
const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b2';
const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed SECURITY suite (the taint/quarantine primitive) must never
// silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail at collection.
if (requireDb && !hasDb) {
  throw new Error(
    'run-taint.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a security-load-bearing suite.',
  );
}

describe.skipIf(!hasDb)('run-taint primitive (markRunTainted / isRunTainted)', () => {
  let db: ReturnType<typeof makeDbWithSchema>;

  beforeAll(async () => {
    db = makeDbWithSchema(process.env.DATABASE_URL as string, SCHEMA);
    // Minimal isolated DDL: orgs (the FK target) + the idempotency_keys store with its real
    // UNIQUE(tenant_id, scope, idem_key) index (mirrors schema.ts / test-db.ts).
    await db.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      SET search_path TO ${SCHEMA};
      CREATE TABLE orgs (id uuid PRIMARY KEY, name text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE idempotency_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        scope text NOT NULL, idem_key text NOT NULL, body_hash text NOT NULL, snapshot jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idem_tenant_scope_key_idx ON idempotency_keys (tenant_id, scope, idem_key);
      INSERT INTO orgs (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
    `);
  }, 30_000);

  beforeEach(async () => {
    // The pool's startup search_path already pins ${SCHEMA}, public — no bare SET (would poison the pool).
    await db.$client.unsafe('TRUNCATE idempotency_keys CASCADE');
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('(a) markRunTainted is IDEMPOTENT: marking the same runId twice yields exactly ONE row', async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'run-idem-1';
    await markRunTainted(tdb, runId);
    await markRunTainted(tdb, runId); // second mark is a no-op (ON CONFLICT DO NOTHING)

    const rows = await db.$client.unsafe(
      'SELECT 1 FROM idempotency_keys WHERE tenant_id = $1 AND scope = $2 AND idem_key = $3',
      [TENANT_A, RUN_TAINT_SCOPE, runId],
    );
    expect(rows).toHaveLength(1);
    expect(await isRunTainted(tdb, runId)).toBe(true);
  });

  it('(b) isRunTainted is TENANT-SCOPED: mark under A → A reads true, B reads false (no cross-tenant leak)', async () => {
    const runId = 'run-tenant-scope-1';
    await markRunTainted(forTenant(db, TENANT_A), runId);

    expect(await isRunTainted(forTenant(db, TENANT_A), runId)).toBe(true);
    // The SAME runId under tenant B is invisible — the TenantDb predicate is structural.
    expect(await isRunTainted(forTenant(db, TENANT_B), runId)).toBe(false);
  });

  it('(c) a run with NO taint marker reads false (safely re-runnable)', async () => {
    expect(await isRunTainted(forTenant(db, TENANT_A), 'never-tainted')).toBe(false);
  });

  it('(c) NO SCOPE COLLISION: run_started / agent_run / trigger rows under the same runId do NOT taint the run', async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'run-scope-collision-1';
    // Seed OTHER-scope rows under the same (tenant, idemKey=runId) — these must NOT read as taint.
    for (const scope of ['run_started', 'agent_run', 'trigger']) {
      await db.$client.unsafe(
        'INSERT INTO idempotency_keys (tenant_id, scope, idem_key, body_hash, snapshot) VALUES ($1,$2,$3,$4,$5)',
        [TENANT_A, scope, runId, `${scope}_marker`, JSON.stringify({ runId })],
      );
    }
    // No run_taint row yet → not tainted, despite the three other-scope rows sharing the runId.
    expect(await isRunTainted(tdb, runId)).toBe(false);

    // Now add the run_taint row → tainted true; the other-scope rows still coexist untouched.
    await markRunTainted(tdb, runId);
    expect(await isRunTainted(tdb, runId)).toBe(true);

    // The run_taint marker did NOT collide with / overwrite any other-scope row (4 distinct scope rows).
    const allRows = await db.$client.unsafe(
      'SELECT scope FROM idempotency_keys WHERE tenant_id = $1 AND idem_key = $2 ORDER BY scope',
      [TENANT_A, runId],
    );
    expect(allRows.map((r: { scope: string }) => r.scope)).toEqual([
      'agent_run',
      'run_started',
      'run_taint',
      'trigger',
    ]);
  });
});
