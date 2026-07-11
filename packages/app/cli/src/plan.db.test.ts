/**
 * `rayspec plan` — the SECURITY-LOAD-BEARING DB-backed test (the READ-ONLY proof).
 *
 * `plan` must be READ-ONLY w.r.t. the real/target DB: its ONLY DB mutations happen on a throwaway DB
 * it creates on the SHADOW server. This suite proves that EMPIRICALLY, fail-the-fix:
 *
 *  1. READ-ONLY PROOF (fail-the-fix): stand up a "target" schema (an isolated Postgres schema — never
 *     `public`), snapshot its FULL schema state (every table/column/constraint/index),
 *     run `plan` with SHADOW_DATABASE_URL pointing at a SEPARATE throwaway server-DB, then assert the
 *     TARGET snapshot is BYTE-IDENTICAL afterward. Because `plan` only ever connects to a URL derived
 *     from SHADOW_DATABASE_URL, the target is untouched — and if a regression ever made `plan` write
 *     to the target (e.g. by using DATABASE_URL), the snapshot would differ and this goes RED.
 *
 *  2. NON-VACUITY: the same run asserts shadowApplied:true + ok:true — so the read-only proof is not
 *     vacuously green because the shadow never actually connected/applied. (The shadow's own throwaway
 *     CREATE/apply/FORCE-DROP self-cleanup is proven non-racily in shadow-apply.db.test.ts.)
 *
 * Self-skips when DATABASE_URL is unset (mirrors the other *.db.test.ts). The shadow URL defaults to
 * SHADOW_DATABASE_URL, else it is DERIVED from DATABASE_URL by swapping the db name to the conventional
 * `_shadow` sibling so the suite runs against the standard local docker server.
 */
import { makeDbWithSchema } from '@rayspec/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runPlan } from './plan.js';
import { withDatabaseName } from './shadow-apply.js';

const SCHEMA = 'rayspec_test_cli_plan_target';
const hasDb = Boolean(process.env.DATABASE_URL);
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let scenariosRan = 0;

const VALID_SPEC = `
version: '1.0'
metadata:
  name: cli-plan-db-test
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
      - { name: qty, type: integer }
  - name: parts
    columns:
      - { name: widget_id, type: uuid }
      - { name: sku, type: text, unique: true }
    foreignKeys:
      - { column: widget_id, references: widgets, onDelete: cascade }
`;

/** The shadow server URL: SHADOW_DATABASE_URL if set, else the conventional `_shadow` sibling of DATABASE_URL. */
function shadowUrl(): string {
  if (process.env.SHADOW_DATABASE_URL) return process.env.SHADOW_DATABASE_URL;
  // Derive postgres://…/rayspec_shadow from postgres://…/rayspec (the docker-compose convention).
  const dbUrl = process.env.DATABASE_URL as string;
  const u = new URL(dbUrl);
  const name = u.pathname.replace(/^\//, '');
  return withDatabaseName(dbUrl, `${name}_shadow`);
}

/**
 * A deterministic FULL snapshot of `schema`'s structure (tables, columns, constraints, indexes),
 * stringified so a single equality covers the whole state. Two snapshots are byte-identical iff the
 * schema is structurally unchanged.
 */
async function snapshotSchema(admin: postgres.Sql, schema: string): Promise<string> {
  const cols = await admin.unsafe(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
    [schema],
  );
  const cons = await admin.unsafe(
    `SELECT table_name, constraint_name, constraint_type
       FROM information_schema.table_constraints WHERE table_schema = $1
       ORDER BY table_name, constraint_name`,
    [schema],
  );
  const idx = await admin.unsafe(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`,
    [schema],
  );
  return JSON.stringify({ cols, cons, idx });
}

describe.skipIf(!hasDb)('rayspec plan — READ-ONLY against the target (fail-the-fix)', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    // makeDbWithSchema pins search_path so the isolated schema is created/used (never public).
    const db = makeDbWithSchema(url, SCHEMA);
    // Build the "target": an isolated schema with a representative table the snapshot will cover.
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await db.$client.unsafe(`
      CREATE TABLE ${SCHEMA}.existing_target (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX existing_target_name_idx ON ${SCHEMA}.existing_target (name);
    `);
    await db.$client.end();
    // A plain admin connection (no search_path pin) for snapshots + leftover-DB checks.
    admin = postgres(url, { max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  beforeEach(() => {
    process.chdir(import.meta.dirname);
  });

  it('runs the shadow-apply (ok + shadowApplied:true) yet leaves the TARGET schema byte-identical', async () => {
    // Write the spec where the test runs (a path inside the cwd — the read jail requires it).
    const { writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const specPath = join(import.meta.dirname, '_cli-plan-db-spec.yaml');
    writeFileSync(specPath, VALID_SPEC, 'utf8');

    try {
      const before = await snapshotSchema(admin, SCHEMA);

      const r = await runPlan(['_cli-plan-db-spec.yaml'], { shadowDatabaseUrl: shadowUrl() });

      // NON-VACUITY: the shadow actually ran AND the real generated SQL applied cleanly.
      expect(r.ok).toBe(true);
      expect(r.shadowApplied).toBe(true);
      expect(r.errors).toEqual([]);
      // The plan produced the expected reviewable artifacts (proves it did real work).
      expect(r.stores.map((s) => s.name)).toEqual(['widgets', 'parts']);
      expect(r.migrationSql).toContain('CREATE TABLE "widgets"');

      // READ-ONLY PROOF: the target schema is byte-identical (plan never wrote the widgets/parts
      // tables here — they only ever existed in the throwaway shadow DB, now dropped).
      const after = await snapshotSchema(admin, SCHEMA);
      expect(after).toBe(before);

      // The widgets/parts product tables were NEVER created in the target schema.
      const leaked = await admin.unsafe(
        `SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1 AND table_name IN ('widgets', 'parts')`,
        [SCHEMA],
      );
      expect(leaked.length).toBe(0);

      // ND-2: WHOLE-DB proof — the product tables appear in NO schema of the target DB (not just the
      // isolated test schema). If a regression made plan write to DATABASE_URL/public (instead of the
      // throwaway shadow DB), widgets/parts would show up SOMEWHERE here → RED. This catches an
      // accidental write to the real target's `public` (or any) schema that a schema-scoped check misses.
      const leakedAnywhere = await admin.unsafe(
        `SELECT table_schema, table_name FROM information_schema.tables
           WHERE table_name IN ('widgets', 'parts')`,
      );
      expect(leakedAnywhere.map((r) => `${r.table_schema}.${r.table_name}`)).toEqual([]);
      scenariosRan++;
    } finally {
      rmSync(specPath, { force: true });
    }
  }, 60_000);

  it('UPDATE mode (--against): runs the BASELINE-SEEDED shadow yet leaves the TARGET byte-identical', async () => {
    // An additive 0.1 update (new nullable column). With SHADOW_DATABASE_URL set, plan applies the OLD
    // spec's first-materialization + the DELTA on a THROWAWAY DB and asserts drift-clean vs the NEW spec
    // (updateMode) — while NEVER touching the real target (the read-only proof still holds in update mode).
    const { writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const oldPath = join(import.meta.dirname, '_cli-plan-db-old.yaml');
    const newPath = join(import.meta.dirname, '_cli-plan-db-new.yaml');
    const OLD_SPEC = `
version: '1.0'
metadata:
  name: cli-plan-db-update
stores:
  - name: gadgets
    columns:
      - { name: label, type: text }
      - { name: qty, type: integer }
`;
    const NEW_SPEC = `
version: '1.0'
metadata:
  name: cli-plan-db-update
stores:
  - name: gadgets
    columns:
      - { name: label, type: text }
      - { name: qty, type: integer }
      - { name: note, type: text, nullable: true }
`;
    writeFileSync(oldPath, OLD_SPEC, 'utf8');
    writeFileSync(newPath, NEW_SPEC, 'utf8');
    try {
      const before = await snapshotSchema(admin, SCHEMA);

      const r = await runPlan(['_cli-plan-db-new.yaml'], {
        against: '_cli-plan-db-old.yaml',
        shadowDatabaseUrl: shadowUrl(),
      });

      // NON-VACUITY: the baseline-seeded shadow actually ran, the delta applied, drift-clean vs the new spec.
      expect(r.ok).toBe(true);
      expect(r.updateMode).toBe(true);
      expect(r.shadowApplied).toBe(true);
      expect(r.driftFindings).toEqual([]);
      expect(r.breakingChangeBlocked).toBe(false);
      // The migration is the DELTA (ADD COLUMN), not a first materialization.
      expect(r.migrationSql).toContain('ADD COLUMN "note"');
      expect(r.migrationSql).not.toContain('CREATE TABLE "gadgets"');

      // READ-ONLY PROOF (update mode): the target schema is byte-identical + the product table never leaked.
      const after = await snapshotSchema(admin, SCHEMA);
      expect(after).toBe(before);
      const leakedAnywhere = await admin.unsafe(
        `SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = 'gadgets'`,
      );
      expect(leakedAnywhere.length).toBe(0);
      scenariosRan++;
    } finally {
      rmSync(oldPath, { force: true });
      rmSync(newPath, { force: true });
    }
  }, 60_000);
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the read-only proofs did not run — so a CI run that lost
 * DATABASE_URL can never silently skip this security-load-bearing suite.
 */
describe('rayspec plan — ran-guard (the read-only proofs must not silently skip in CI)', () => {
  it('the READ-ONLY scenarios ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(scenariosRan).toBe(2);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
