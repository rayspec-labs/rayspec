/**
 * DB-backed: a BUSINESS-KEY foreign key (`referencesColumn` → a unique column) materializes as a
 * TENANT-SCOPED COMPOUND FK `(tenant_id, col) REFERENCES parent(tenant_id, refcol)`, and:
 *   - the DDL applies cleanly onto a compound-unique-INDEX target (Postgres accepts a unique index as an
 *     FK target; a single-column FK onto it would be 42830 — that is why the FK is compound);
 *   - the compound FK STRUCTURALLY forbids a cross-tenant reference (a child row can only point at a
 *     same-tenant parent) — a cross-tenant insert is 23503;
 *   - `detectDrift` over the freshly-materialized schema returns NO drift — proving the drift detector's
 *     tenant-FK check is not fooled by the compound FK's own `tenant_id` FK row (the fail-the-fix: the
 *     pre-fix bare `column_name === 'tenant_id'` match would bind to the meetings FK and false-report
 *     `missing_tenant_fk`).
 *
 * Isolated per-suite schema — never `public`. Skips without DATABASE_URL; HARD-FAILS when the DB is
 * required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent (un-skippable ran-guard at the bottom).
 */
import { type StoreSpec, StoreSpec as StoreSpecSchema } from '@rayspec/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../client.js';
import { makeDbWithSchema } from '../testing.js';
import { detectDrift, type QueryFn } from './drift-detect.js';
import { generateProductSql } from './generate-product-sql.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'business-key-fk.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the business-key FK materialization + drift acceptance.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_business_key_fk';
const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b1';

const parse = (raw: unknown): StoreSpec => StoreSpecSchema.parse(raw);
const STORES: StoreSpec[] = [
  parse({ name: 'meetings', columns: [{ name: 'slug', type: 'text', unique: true }] }),
  parse({
    name: 'transcripts',
    columns: [{ name: 'meeting_slug', type: 'text' }],
    foreignKeys: [{ column: 'meeting_slug', references: 'meetings', referencesColumn: 'slug' }],
  }),
];

const ORGS_DDL = `CREATE TABLE orgs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);`;

function forSchema(sql: string, schema: string): string {
  return sql.replace(/-->\s*statement-breakpoint/g, '').replace(/"public"\./g, `"${schema}".`);
}

let db: Db;
let query: QueryFn;
let testsRan = 0;

describeDb('business-key FK — materialize + drift', () => {
  beforeAll(async () => {
    if (!hasDb) return;
    const url = process.env.DATABASE_URL as string;
    db = makeDbWithSchema(url, SCHEMA);
    query = (sql, params) =>
      db.$client.unsafe(sql, params as never[]) as unknown as Promise<Record<string, unknown>[]>;
    await db.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      SET search_path TO ${SCHEMA};
      ${ORGS_DDL}
    `);
    await db.$client.unsafe(`INSERT INTO ${SCHEMA}.orgs (id, name) VALUES ($1,'A'), ($2,'B')`, [
      TENANT_A,
      TENANT_B,
    ]);
    // MIGRATE: the compound business-key FK DDL applies cleanly onto the compound unique index.
    await db.$client.unsafe(
      `SET search_path TO ${SCHEMA}; ${forSchema(generateProductSql(STORES), SCHEMA)}`,
    );
  });

  afterAll(async () => {
    if (!hasDb) return;
    await db.$client.end();
  });

  it('the FK is a COMPOUND (tenant_id, meeting_slug) -> meetings(tenant_id, slug) constraint', async () => {
    testsRan += 1;
    const rows = (await db.$client.unsafe(
      `SELECT kcu.column_name, ccu.column_name AS ref_column, ccu.table_name AS ref_table
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
          AND tc.constraint_name = 'transcripts_meeting_slug_meetings_slug_fk'
        ORDER BY kcu.column_name, ccu.column_name`,
      [SCHEMA],
    )) as unknown as Array<{ column_name: string; ref_column: string; ref_table: string }>;
    const localCols = [...new Set(rows.map((r) => r.column_name))].sort();
    const refCols = [...new Set(rows.map((r) => r.ref_column))].sort();
    expect(localCols).toEqual(['meeting_slug', 'tenant_id']); // compound local key
    expect(refCols).toEqual(['slug', 'tenant_id']); // compound referenced key
    expect([...new Set(rows.map((r) => r.ref_table))]).toEqual(['meetings']);
  });

  it('a same-tenant reference inserts (201-equivalent); a cross-tenant reference is 23503 (structurally forbidden)', async () => {
    testsRan += 1;
    await db.$client.unsafe(`INSERT INTO ${SCHEMA}.meetings (tenant_id, slug) VALUES ($1, 'm1')`, [
      TENANT_A,
    ]);
    // same-tenant → ok
    await db.$client.unsafe(
      `INSERT INTO ${SCHEMA}.transcripts (tenant_id, meeting_slug) VALUES ($1, 'm1')`,
      [TENANT_A],
    );
    // cross-tenant (B references A's slug) → 23503 foreign_key_violation
    let code: string | undefined;
    try {
      await db.$client.unsafe(
        `INSERT INTO ${SCHEMA}.transcripts (tenant_id, meeting_slug) VALUES ($1, 'm1')`,
        [TENANT_B],
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23503');
  });

  it('detectDrift over the materialized schema reports NO drift (no false-positive tenant/product FK)', async () => {
    testsRan += 1;
    const findings = await detectDrift(STORES, SCHEMA, query);
    // The load-bearing assertion: the compound FK's own tenant_id FK row does NOT trip missing_tenant_fk,
    // and the business-key product FK is recognized. Zero drift.
    expect(findings).toEqual([]);
  });
});

describe('business-key FK acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the materialize + drift arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(3);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
