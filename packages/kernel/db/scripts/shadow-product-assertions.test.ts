/**
 * Non-vacuity meta-test for the generalized shadow-dryrun's PRODUCT assertions
 * (guard against a blind/vacuous dry-run).
 *
 * `runProductAssertions(sql, stores)` THROWS if zero product tables were asserted (a vacuous run).
 * This proves the guard FIRES for an empty spec (no DB needed — the vacuity check short-circuits
 * before any query when stores is empty... actually it seeds an org first, so we use a throwaway DB
 * to exercise the real path) and PASSES non-vacuously for the throwaway's stores.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '@rayspec/spec';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateProductSql } from '../src/generated/generate-product-sql.js';
import { runProductAssertions } from './shadow-product-assertions.js';

const here = dirname(fileURLToPath(import.meta.url));
const YAML_PATH = resolve(here, '../../../../examples/acme-notes-backend/rayspec.yaml');

const ORGS_DDL = `CREATE TABLE orgs (id uuid PRIMARY KEY, name text NOT NULL,
  slug text NOT NULL DEFAULT 'x', created_at timestamptz NOT NULL DEFAULT now());`;

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  sql = postgres(url, { max: 2 });
});
afterAll(async () => {
  await sql.end();
});

async function freshSchema(schema: string, withProductSql: boolean): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};
    SET search_path TO ${schema}; ${ORGS_DDL}`);
  if (withProductSql) {
    const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
    if (!parsed.ok) throw new Error('throwaway invalid');
    const ddl = generateProductSql(parsed.value.stores)
      .replace(/-->\s*statement-breakpoint/g, '')
      .replace(/"public"\./g, `"${schema}".`);
    await sql.unsafe(`SET search_path TO ${schema}; ${ddl}`);
  }
}

describe('shadow product-assertions non-vacuity (deliverable 5 meta-test)', () => {
  it('THROWS on an empty stores set (a vacuous/blind dry-run is refused)', async () => {
    const schema = 'rayspec_test_shadow_vacuous';
    await freshSchema(schema, false);
    const scoped = postgres(process.env.DATABASE_URL as string, {
      max: 1,
      connection: { search_path: `${schema}, public` },
    });
    try {
      await expect(runProductAssertions(scoped, [])).rejects.toThrow(
        /ZERO product-table assertions/,
      );
    } finally {
      await scoped.end();
    }
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  it('PASSES non-vacuously for the throwaway stores (asserts every product table)', async () => {
    const schema = 'rayspec_test_shadow_nonvacuous';
    await freshSchema(schema, true);
    const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
    if (!parsed.ok) throw new Error('throwaway invalid');
    const scoped = postgres(process.env.DATABASE_URL as string, {
      max: 1,
      connection: { search_path: `${schema}, public` },
    });
    try {
      const asserted = await runProductAssertions(scoped, parsed.value.stores);
      expect(asserted).toBe(parsed.value.stores.length);
      expect(asserted).toBeGreaterThan(0);
    } finally {
      await scoped.end();
    }
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });
});
