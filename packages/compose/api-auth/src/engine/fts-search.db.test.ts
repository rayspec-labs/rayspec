/**
 * FULL-TEXT SEARCH end-to-end on a REAL Postgres (isolated per-suite schema — never `public`).
 *
 * Proves the WHOLE declarative chain for a store that opts into `fullTextSearch: true`:
 *   generator → migration applies → the GENERATED `search_vector` tsvector column + the GIN index EXIST →
 *   a ranked `?__search=` query (buildListQuery → TenantDb chokepoint) returns rows ranked by relevance
 *   (a denser match ranks above a weaker one), excludes non-matching rows, and stays tenant-scoped.
 *
 * Fail-the-fix (the ranking tooth): flip the `ts_rank … DESC` order in store-query.ts and the
 * "denser match first" assertion goes RED. Strip the generator injection and the migration has no
 * `search_vector` column → the ranked query errors (column absent) = RED.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when a DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS).
 */

import type { Db } from '@rayspec/db';
import { forTenant, generateProductSql } from '@rayspec/db';
import { buildProductTables, makeDbWithSchema, registerScopedTables } from '@rayspec/db/testing';
import { parseSpec, type StoreSpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildListQuery } from './store-query.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'fts-search.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the full-text-search end-to-end.',
  );
}

const SCHEMA = 'rayspec_test_fts_search';
const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b1';

const FTS_YAML = `
version: '1.0'
metadata:
  name: fts-e2e
stores:
  - name: docs
    fullTextSearch: true
    columns:
      - { name: title, type: text }
      - { name: body, type: text, nullable: true }
`;

const ORGS_DDL = `CREATE TABLE orgs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);`;

/** Strip drizzle statement-breakpoints + retarget the `"public".` FK qualifier to the test schema. */
function forSchema(sql: string, schema: string): string {
  return sql.replace(/-->\s*statement-breakpoint/g, '').replace(/"public"\./g, `"${schema}".`);
}

let db: Db;
let store: StoreSpec;
let table: PgTable;
let unregister: () => void;

describe.skipIf(!hasDb)('full-text search end-to-end (real DB, isolated schema)', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    const parsed = parseSpec(FTS_YAML);
    if (!parsed.ok) throw new Error(`fts spec invalid: ${JSON.stringify(parsed.errors)}`);
    const stores = parsed.value.stores;
    store = stores[0];

    db = makeDbWithSchema(url, SCHEMA);
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
    await db.$client.unsafe(
      `SET search_path TO ${SCHEMA}; ${forSchema(generateProductSql(stores), SCHEMA)}`,
    );

    table = buildProductTables(stores).get('docs') as PgTable;
    unregister = registerScopedTables([table]);

    // Seed tenant A: two matching rows of DIFFERENT relevance + one non-matching row.
    await forTenant(db, TENANT_A).transaction(async (tx) => {
      await tx
        .insert(table as never, {
          title: 'database database database',
          body: 'a deep dive on the database internals — database, database, database',
        })
        .returning();
      await tx
        .insert(table as never, { title: 'weekly notes', body: 'a passing mention of a database' })
        .returning();
      await tx
        .insert(table as never, { title: 'unrelated', body: 'nothing to see here' })
        .returning();
    });
    // Seed tenant B: a strongly-matching row that tenant A must NEVER see.
    await forTenant(db, TENANT_B).transaction(async (tx) => {
      await tx
        .insert(table as never, { title: 'database database database', body: 'tenant B database' })
        .returning();
    });
  });

  afterAll(async () => {
    unregister?.();
    await db.$client.end();
  });

  it('the migration created the GENERATED search_vector tsvector column', async () => {
    const cols = (await db.$client.unsafe(
      `SELECT data_type, is_generated FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'docs' AND column_name = 'search_vector'`,
      [SCHEMA],
    )) as unknown as { data_type: string; is_generated: string }[];
    expect(cols).toHaveLength(1);
    expect(cols[0].data_type).toBe('tsvector');
    expect(cols[0].is_generated).toBe('ALWAYS');
  });

  it('the migration created a GIN index on search_vector', async () => {
    const idx = (await db.$client.unsafe(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'docs'
         AND indexname = 'docs_search_vector_idx'`,
      [SCHEMA],
    )) as unknown as { indexdef: string }[];
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef.toLowerCase()).toContain('using gin');
    expect(idx[0].indexdef).toContain('search_vector');
  });

  it('ranks a denser match above a weaker one, excludes non-matching rows, and never leaks the vector', async () => {
    const q = buildListQuery(store, table, new URLSearchParams({ __search: 'database' }));
    expect(q.rankedSearch).toBe(true);
    const rows = (await forTenant(db, TENANT_A).transaction(
      async (tx) =>
        (await tx
          .select(table as never)
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)) as Record<string, unknown>[],
    )) as Record<string, unknown>[];

    // Exactly the two matching rows (the non-matching 'unrelated' row is excluded by the @@ predicate).
    expect(rows).toHaveLength(2);
    // Ranked: the density-3-title row ranks ABOVE the single-mention row (the ranking tooth).
    expect(rows[0].title).toBe('database database database');
    expect(rows[1].title).toBe('weekly notes');
    // The generated tsvector column is DB-level (not an ORM twin column) → never selected/returned.
    expect(rows[0]).not.toHaveProperty('searchVector');
    expect(rows[0]).not.toHaveProperty('search_vector');
  });

  it('is tenant-scoped: tenant A never sees tenant B rows via __search (structural tenant predicate)', async () => {
    const q = buildListQuery(store, table, new URLSearchParams({ __search: 'database' }));
    const rowsA = (await forTenant(db, TENANT_A).transaction(
      async (tx) =>
        (await tx
          .select(table as never)
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)) as Record<string, unknown>[],
    )) as Record<string, unknown>[];
    // Tenant A has exactly 2 matches; tenant B's strongly-matching row is invisible (tenant chokepoint).
    expect(rowsA).toHaveLength(2);
    for (const r of rowsA) expect(r.tenantId).toBe(TENANT_A);
  });
});
