/**
 * The product migration ledger and the product delta, without a database: the ledger is read
 * through a query that answers with rows, so every way a row can fail to hold together is reached.
 *
 *  - A row round-trips: the declared stores of a backend spec and of a product document (with the
 *    conflict keys its unique indexes follow) come back as they were recorded.
 *  - A row of a newer ledger format, a DDL that does not hash to its digest, a description that does
 *    not hash to the digest after, and declared stores the grammar refuses each make the ledger
 *    unreadable.
 *  - Drift is named table by table and column by column.
 *  - A destructive statement names the store and column it touches, and the refusal names the review
 *    step; a first materialization regenerates byte for byte what the legacy deploy generates.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseBundleSpec } from '@rayspec/bundle-closure';
import {
  normalizeProductSchema,
  type ProductTable,
  productSchemaDigest,
} from '@rayspec/bundle-contract';
import { generateProductSql, scanMigrationSql } from '@rayspec/db';
import { describe, expect, it } from 'vitest';
import {
  type DeclaredProductStores,
  declaredStoresJson,
  describeProductDrift,
  ledgerDrift,
  readProductLedger,
} from './product-ledger.js';
import {
  affectedObject,
  declaredStoresOf,
  productDelta,
  uncoveredDestructiveMessage,
} from './product-schema-plan.js';
import type { CatalogQuery } from './schema-head.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const BACKEND = `version: '1.0'
metadata:
  name: ledger-unit
stores:
  - name: notes
    columns:
      - { name: body, type: text }
      - { name: slug, type: text, unique: true }
`;

function declared(source: string): DeclaredProductStores {
  const parsed = parseBundleSpec(Buffer.from(source));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return declaredStoresOf(parsed.value);
}

const TABLE: ProductTable = {
  name: 'notes',
  columns: [
    { name: 'body', type: 'text', nullable: false, default: null },
    { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
  ],
  primaryKey: ['id'],
  uniques: [],
  indexes: [],
  foreignKeys: [],
};

interface RowOverrides {
  ledger_format_version?: unknown;
  ddl?: unknown;
  ddl_sha256?: unknown;
  schema_after?: unknown;
  product_schema_after?: unknown;
  declared_stores?: unknown;
}

/** A query answering like a database whose ledger holds the given rows. */
function ledgerOf(rows: RowOverrides[], stores: DeclaredProductStores): CatalogQuery {
  const ddl = 'CREATE TABLE "notes" ("id" uuid PRIMARY KEY)';
  return async (sql) => {
    if (sql.includes('to_regclass')) return [{ present: true }];
    return rows.map((overrides, i) => ({
      id: String(i + 1),
      ledger_format_version: 1,
      operation_id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
      migration_name: `m${i}.sql`,
      ddl,
      ddl_sha256: sha256(ddl),
      product_schema_before: productSchemaDigest([]),
      product_schema_after: productSchemaDigest([TABLE]),
      schema_after: normalizeProductSchema([TABLE]),
      // What the database hands back for a jsonb column: the parsed JSON.
      declared_stores: JSON.parse(JSON.stringify(declaredStoresJson(stores))),
      ...overrides,
    }));
  };
}

describe('reading the ledger', () => {
  it('is empty without the table or without rows', async () => {
    expect(await readProductLedger(async () => [{ present: false }])).toEqual({ state: 'empty' });
    expect(await readProductLedger(ledgerOf([], declared(BACKEND)))).toEqual({ state: 'empty' });
  });

  it('gives back the declared stores of a backend spec as they were recorded', async () => {
    const stores = declared(BACKEND);
    const ledger = await readProductLedger(ledgerOf([{}, {}], stores));
    expect(ledger.state).toBe('ledgered');
    if (ledger.state !== 'ledgered') return;
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.head.migrationName).toBe('m1.sql');
    expect(ledger.head.declared).toEqual(stores);
    expect(ledger.head.tablesAfter).toEqual(normalizeProductSchema([TABLE]).tables);
  });

  it('gives back the stores and conflict keys of a product document', async () => {
    const source = readFileSync(
      new URL('./__fixtures__/non-audio-intake.product.yaml', import.meta.url),
      'utf8',
    );
    const stores = declared(source);
    expect(stores.stores.length).toBeGreaterThan(0);
    const ledger = await readProductLedger(ledgerOf([{}], stores));
    expect(ledger.state).toBe('ledgered');
    if (ledger.state !== 'ledgered') return;
    expect(ledger.head.declared.stores).toEqual(stores.stores);
    expect(declaredStoresJson(ledger.head.declared)).toEqual(declaredStoresJson(stores));
    // Regenerating from what the ledger gives back is regenerating from the spec itself.
    expect(productDelta(ledger.head.declared, stores).migrationSql).toBe('');
  });

  it.each<[string, RowOverrides, string]>([
    ['a newer ledger format', { ledger_format_version: 2 }, 'a newer runtime applied'],
    [
      'a DDL that does not hash to its digest',
      { ddl: 'DROP TABLE "notes"' },
      'does not hold together',
    ],
    [
      'a description that does not hash to the digest after',
      { product_schema_after: productSchemaDigest([]) },
      'does not hold together',
    ],
    [
      'a description of an unknown format',
      { schema_after: { productSchemaFormatVersion: 2, tables: [] } },
      'does not hold together',
    ],
    [
      'declared stores the grammar refuses',
      {
        declared_stores: { stores: [{ name: 'Not An Identifier', columns: [] }], conflictKeys: {} },
      },
      'does not hold together',
    ],
    ['declared stores that are not an object', { declared_stores: [] }, 'does not hold together'],
  ])('is unreadable with %s', async (_label, overrides, message) => {
    const ledger = await readProductLedger(ledgerOf([{}, overrides], declared(BACKEND)));
    expect(ledger.state).toBe('unreadable');
    expect(ledger.state === 'unreadable' && ledger.message).toContain(message);
  });
});

describe('drift', () => {
  it('names each table and column that differs, and nothing when they agree', () => {
    const changed: ProductTable = {
      ...TABLE,
      columns: [
        { name: 'body', type: 'character varying(64)', nullable: true, default: null },
        { name: 'extra', type: 'integer', nullable: true, default: null },
      ],
      indexes: [{ name: 'notes_body_idx', columns: ['body'], unique: false }],
    };
    const other: ProductTable = { ...TABLE, name: 'other' };
    expect(describeProductDrift([TABLE], [TABLE])).toEqual([]);
    expect(describeProductDrift([TABLE, other], [changed])).toEqual([
      'column notes.body is character varying(64), not text not null',
      'column notes.extra exists but no applied change added it',
      'column notes.id is missing',
      'table notes has different indexes',
      'table other is missing',
    ]);
  });

  it('reports drift against the latest row only when the digests differ', async () => {
    const ledger = await readProductLedger(ledgerOf([{}], declared(BACKEND)));
    if (ledger.state !== 'ledgered') throw new Error('not ledgered');
    expect(ledgerDrift(ledger.head, [TABLE])).toBeNull();
    const drift = ledgerDrift(ledger.head, [TABLE, { ...TABLE, name: 'added' }]);
    expect(drift).toContain('table added exists but no applied change created it');
    expect(drift).toContain('(m0.sql)');
  });
});

describe('the delta and its destructive statements', () => {
  it('regenerates a first materialization byte for byte as the legacy deploy generates it', () => {
    const stores = declared(BACKEND);
    expect(productDelta({ stores: [] }, stores).migrationSql).toBe(
      generateProductSql(stores.stores),
    );
  });

  it('names the store, the column or the index a statement touches', () => {
    expect(affectedObject('ALTER TABLE "notes" DROP COLUMN "body"')).toBe('notes.body');
    expect(affectedObject('ALTER TABLE "notes" ALTER COLUMN "tag" SET NOT NULL')).toBe('notes.tag');
    expect(affectedObject('DROP TABLE "notes"')).toBe('notes');
    expect(affectedObject('DROP TABLE IF EXISTS "notes" CASCADE')).toBe('notes');
    expect(affectedObject('DROP INDEX "notes_slug_idx"')).toBe('index notes_slug_idx');
    expect(affectedObject('TRUNCATE something')).toBe('an unnamed object');
  });

  it('refuses every uncovered finding by what it touches and names the review step', () => {
    const next = declared(BACKEND.replace('      - { name: body, type: text }\n', ''));
    const delta = productDelta(declared(BACKEND), next);
    expect(delta.destructive).toBe(true);
    const scan = scanMigrationSql(delta.migrationSql);
    const message = uncoveredDestructiveMessage(scan.findings);
    expect(message).toContain('drop-column on notes.body');
    expect(message).toContain(
      'rayspec plan <new-spec> --against <spec of the running application>',
    );
    expect(message).toContain('--allowlist <file.json>');
    // A covered finding is not named.
    const covered = scanMigrationSql(delta.migrationSql, delta.proposedAllowlist);
    expect(covered.pass).toBe(true);
    expect(uncoveredDestructiveMessage(covered.findings)).not.toContain('notes.body');
  });
});
