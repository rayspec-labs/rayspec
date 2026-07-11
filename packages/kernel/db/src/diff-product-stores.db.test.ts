/**
 * The delta-diff core — DB-BACKED apply proofs.
 *
 * The pure golden tests pin the emitted BYTES; these prove the emitted statements ACTUALLY APPLY on a
 * real Postgres and reach the intended end-state — the applicability blind spot the review flagged (a
 * byte-correct migration that still fails on a real DB, e.g. an FK ADD-before-DROP → 42710
 * duplicate_object when old and new constraint names are identical).
 *
 * Isolation: each scenario CREATEs a uniquely-named THROWAWAY database on the DATABASE_URL server,
 * seeds the minimal `orgs` FK root, materializes the OLD spec (via `emitStoreSql` — the same building
 * block `generateProductSql` concatenates), applies the diff statements IN ORDER, asserts the
 * end-state via `pg_catalog`, and DROPs the throwaway DB in a `finally`. Never the shared `public`
 * schema of the app DB — a fresh database per scenario.
 *
 * UN-SKIPPABLE RAN-GUARD (the DB-required false-green class): a separate,
 * NON-skipped describe hard-FAILS when the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the
 * apply scenarios did not run, so a DATABASE_URL-less CI run can never silently skip the proof.
 */
import { randomBytes } from 'node:crypto';
import { StoreSpec } from '@rayspec/spec';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { diffProductStores } from './diff-product-stores.js';
import { emitStoreSql } from './generated/generate-product-sql.js';

/** Parse a raw store object through the REAL Zod grammar so defaults (nullable/unique/onDelete) apply. */
function store(raw: unknown): StoreSpec {
  return StoreSpec.parse(raw);
}

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let scenariosRan = 0;

/** Point a URL at the admin `postgres` database (to CREATE/DROP the throwaway). */
function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

/** Point a URL at a specific database name (the throwaway this run created). */
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** A fresh, unique throwaway DB name (lowercase + hex → a safe SQL identifier, collision-proof). */
function throwawayName(): string {
  return `rayspec_db_diff_${process.pid}_${randomBytes(6).toString('hex')}`;
}

/** The minimal `orgs` FK root the injected `tenant_id -> orgs(id)` FK needs (mirrors shadow-dryrun.sh). */
const ORGS_ROOT_SQL = `
CREATE TABLE orgs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL DEFAULT 'x',
  region text NOT NULL DEFAULT 'eu',
  retention_days integer,
  external_idp_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);`;

/**
 * Run `fn` against a fresh throwaway DB seeded with `orgs` + the materialized OLD spec. `fn` receives a
 * connection scoped to the throwaway DB and applies the diff itself, so a failing statement's real
 * error (e.g. 42710) surfaces to the test. The throwaway DB is always dropped in the `finally`.
 */
async function withMaterializedOld(
  oldStores: StoreSpec[],
  fn: (sql: postgres.Sql) => Promise<void>,
): Promise<void> {
  const name = throwawayName();
  const admin = postgres(adminUrl(baseUrl as string), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const sql = postgres(withDbName(baseUrl as string, name), { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(ORGS_ROOT_SQL);
    // Materialize the OLD spec in DECLARED order (a parent table exists before a child's FK is added).
    for (const s of oldStores) {
      for (const stmt of emitStoreSql(s)) await sql.unsafe(stmt);
    }
    await fn(sql);
  } finally {
    await sql.end();
    const admin2 = postgres(adminUrl(baseUrl as string), { max: 1, onnotice: () => {} });
    try {
      await admin2.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin2.end();
    }
  }
}

describe.skipIf(!baseUrl)(
  'diffProductStores — DB apply (real Postgres, throwaway DB per scenario)',
  () => {
    const parent = { name: 'meetings', columns: [{ name: 'title', type: 'text' }] };
    const childFk = (onDelete: 'cascade' | 'restrict') =>
      store({
        name: 'transcripts',
        columns: [
          { name: 'meeting_id', type: 'uuid' },
          { name: 'body', type: 'text' },
        ],
        foreignKeys: [{ column: 'meeting_id', references: 'meetings', onDelete }],
      });

    it('FIX-1: an onDelete change applies drop-then-add and ENDS with the new policy (no 42710)', async () => {
      const withFk = [store(parent), childFk('cascade')];
      const restrictFk = [store(parent), childFk('restrict')];
      await withMaterializedOld(withFk, async (sql) => {
        const r = diffProductStores(withFk, restrictFk);
        // Apply each diff statement IN ORDER — the UNFIXED order (ADD before DROP of the SAME-named
        // constraint) throws 42710 duplicate_object right here.
        for (const stmt of r.statements) await sql.unsafe(stmt);
        // confdeltype: 'r' = restrict, 'c' = cascade, 'a' = no action, 'n' = set null, 'd' = set default.
        const rows = await sql.unsafe(
          `SELECT confdeltype FROM pg_constraint WHERE conname = 'transcripts_meeting_id_meetings_id_fk'`,
        );
        expect(rows.length).toBe(1);
        expect((rows[0] as { confdeltype: string }).confdeltype).toBe('r');
      });
      scenariosRan++;
    }, 60_000);

    it('FIX-2 (PC-2): a newly-added unique column materializes a REAL unique index', async () => {
      const before = [store({ name: 'items', columns: [{ name: 'a', type: 'text' }] })];
      const after = [
        store({
          name: 'items',
          columns: [
            { name: 'a', type: 'text' },
            { name: 'b', type: 'text', nullable: true, unique: true },
          ],
        }),
      ];
      await withMaterializedOld(before, async (sql) => {
        const r = diffProductStores(before, after);
        for (const stmt of r.statements) await sql.unsafe(stmt);
        // The UNFIXED code never emits CREATE UNIQUE INDEX → this index is ABSENT (rows.length === 0).
        const rows = await sql.unsafe(
          `SELECT i.indisunique FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid ` +
            `WHERE c.relname = 'items_b_unique'`,
        );
        expect(rows.length).toBe(1);
        expect((rows[0] as { indisunique: boolean }).indisunique).toBe(true);
      });
      scenariosRan++;
    }, 60_000);
  },
);

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the two apply scenarios did not run — so a CI run that lost
 * DATABASE_URL can never silently skip these DB-backed apply proofs.
 */
describe('diffProductStores DB apply — ran-guard (the apply proofs must not silently skip in CI)', () => {
  it('the apply scenarios ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(scenariosRan).toBe(2);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
