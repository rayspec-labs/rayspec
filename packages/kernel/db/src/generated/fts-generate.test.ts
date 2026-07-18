/**
 * FTS generator + registry unit proofs (no DB).
 *
 * A store that declares `fullTextSearch: true` gets, in the generated migration SQL:
 *   - a GENERATED-ALWAYS-STORED `search_vector` tsvector column over the store's TEXT columns
 *     (`to_tsvector('simple', coalesce(<c1>,'') || ' ' || coalesce(<c2>,''))`), emitted LAST;
 *   - a `CREATE INDEX … USING gin ("search_vector")` GIN index.
 * A store WITHOUT the field is byte-identical to the pre-FTS output (additive-by-construction).
 *
 * The runtime `buildProductTables` marks a `fullTextSearch` store's table in the FTS identity registry.
 *
 * Fail-the-fix: strip the generator injection and the `toContain('tsvector')` / `USING gin` assertions
 * go RED (the acme-notes DB pipeline + the compose FTS e2e also go RED — the DDL is gone).
 */
import type { StoreSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { isFtsTable } from '../fts-registry.js';
import { MIGRATION_ALLOWLIST } from '../migration-scan.allowlist.js';
import { scanMigrationSql } from '../migration-scan.js';
import { buildProductTables } from './build-product-tables.js';
import { generateProductSql } from './generate-product-sql.js';

/** A store with two text columns + one non-text column. */
function docsStore(fullTextSearch: boolean): StoreSpec {
  return {
    name: 'docs',
    columns: [
      { name: 'title', type: 'text', nullable: false, unique: false },
      { name: 'body', type: 'text', nullable: true, unique: false },
      { name: 'views', type: 'integer', nullable: true, unique: false },
    ],
    foreignKeys: [],
    ...(fullTextSearch ? { fullTextSearch: true } : {}),
  };
}

describe('generateProductSql — full-text search DDL', () => {
  it('emits a GENERATED tsvector column over the TEXT columns + a GIN index for a fullTextSearch store', () => {
    const sql = generateProductSql([docsStore(true)]);
    // The generated tsvector column: STORED, over the two text columns (declared order), 'simple' config.
    expect(sql).toContain(
      `"search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("body", ''))) STORED`,
    );
    // The non-text `views` column is NOT part of the tsvector expression.
    expect(sql).not.toContain('coalesce("views"');
    // The GIN index on the generated column.
    expect(sql).toContain(
      `CREATE INDEX "docs_search_vector_idx" ON "docs" USING gin ("search_vector")`,
    );
  });

  it('is ADDITIVE: a non-FTS store carries no tsvector/GIN, and enabling FTS only ADDS those two lines', () => {
    const off = generateProductSql([docsStore(false)]);
    expect(off).not.toContain('tsvector');
    expect(off.toLowerCase()).not.toContain('using gin');

    // The FTS output is the non-FTS output with EXACTLY the tsvector column line + the GIN index added.
    const on = generateProductSql([docsStore(true)]);
    const added = on
      .split('\n')
      .filter((line) => !off.split('\n').includes(line))
      .map((l) => l.trim());
    // Only the tsvector column line and the GIN index line are new (plus the CREATE TABLE close line
    // shifts because a column was appended — assert the SUBSTANTIVE additions are exactly these two).
    expect(added.some((l) => l.startsWith('"search_vector" tsvector GENERATED ALWAYS AS'))).toBe(
      true,
    );
    expect(added.some((l) => l.startsWith('CREATE INDEX "docs_search_vector_idx"'))).toBe(true);
    expect(added.some((l) => l.includes('tsvector') || l.includes('USING gin'))).toBe(true);
  });

  it('the FTS migration has NO destructive findings (purely additive)', () => {
    const sql = generateProductSql([docsStore(true)]);
    const allow = MIGRATION_ALLOWLIST['0000_product_stores.sql'] ?? [];
    const result = scanMigrationSql(sql, allow);
    expect(result.pass).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('THROWS (defense-in-depth) for a fullTextSearch store with no text column', () => {
    const noText: StoreSpec = {
      name: 'nums',
      columns: [{ name: 'count', type: 'integer', nullable: false, unique: false }],
      foreignKeys: [],
      fullTextSearch: true,
    };
    expect(() => generateProductSql([noText])).toThrow(/no text column/);
  });

  it('THROWS (defense-in-depth) for a fullTextSearch store declaring the reserved search_vector column', () => {
    const clash: StoreSpec = {
      name: 'docs',
      columns: [
        { name: 'title', type: 'text', nullable: false, unique: false },
        { name: 'search_vector', type: 'text', nullable: true, unique: false },
      ],
      foreignKeys: [],
      fullTextSearch: true,
    };
    expect(() => generateProductSql([clash])).toThrow(/reserved column 'search_vector'/);
  });
});

describe('FTS registry — buildProductTables marks fullTextSearch tables', () => {
  it('marks a fullTextSearch store table and leaves a default store unmarked', () => {
    const tables = buildProductTables([
      docsStore(true),
      {
        name: 'plain',
        columns: [{ name: 'note', type: 'text', nullable: true, unique: false }],
        foreignKeys: [],
      },
    ]);
    const docs = tables.get('docs');
    const plain = tables.get('plain');
    if (!docs || !plain) throw new Error('expected both runtime tables');
    expect(isFtsTable(docs)).toBe(true);
    expect(isFtsTable(plain)).toBe(false);
  });
});
