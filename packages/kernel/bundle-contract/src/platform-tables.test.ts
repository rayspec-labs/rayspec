/**
 * The platform table list restates the committed snapshot categories and adds only the
 * runtime-control tables and the product migration ledger, under the categories the contract
 * reserves for them.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_PLATFORM_TABLES,
  PLATFORM_TABLES,
  PRODUCT_LEDGER_TABLES,
  PUBLIC_PLATFORM_TABLE_NAMES,
  RUNTIME_CONTROL_TABLES,
} from './platform-tables.js';
import { readContractJson } from './test-support/contract-files.js';
import { DATA_CATEGORIES } from './vocabulary.js';

interface Categories {
  tables: { database: string; schema: string; table: string; category: string }[];
  proposedTables: { purpose: string; category: string }[];
}

const categories = readContractJson<Categories>('snapshot-categories.json');

describe('platform tables', () => {
  it('restate the tables of snapshot-categories.json, in order', () => {
    expect(CONTRACT_PLATFORM_TABLES).toEqual(
      categories.tables.map(({ database, schema, table, category }) => ({
        database,
        schema,
        table,
        category,
      })),
    );
  });

  it('add the runtime-control tables under the category the contract reserves for them', () => {
    const reserved = categories.proposedTables
      .filter((p) => p.purpose.includes('runtime control'))
      .map((p) => p.category);
    expect(reserved.length).toBeGreaterThan(0);
    expect(new Set(reserved)).toEqual(new Set(['runtime-control-state']));
    for (const table of RUNTIME_CONTROL_TABLES) {
      expect(table).toMatchObject({ schema: 'public', category: 'runtime-control-state' });
    }
    expect(PLATFORM_TABLES).toEqual([
      ...CONTRACT_PLATFORM_TABLES,
      ...RUNTIME_CONTROL_TABLES,
      ...PRODUCT_LEDGER_TABLES,
    ]);
  });

  it('add the product migration ledger under the category the contract reserves for it', () => {
    const reserved = categories.proposedTables
      .filter((p) => p.purpose.includes('product migration ledger'))
      .map((p) => p.category);
    expect(reserved).toEqual(['platform-migration-ledger']);
    expect(PRODUCT_LEDGER_TABLES).toEqual([
      {
        database: 'application',
        schema: 'public',
        table: 'product_migration_ledger',
        category: 'platform-migration-ledger',
      },
    ]);
  });

  it('name each table once, each under a known category', () => {
    const names = PLATFORM_TABLES.map((p) => `${p.schema}.${p.table}`);
    expect(new Set(names).size).toBe(names.length);
    for (const p of PLATFORM_TABLES) expect(DATA_CATEGORIES).toContain(p.category);
  });

  it('list the public names the product schema head leaves out, the drizzle ledger not among them', () => {
    expect(PUBLIC_PLATFORM_TABLE_NAMES.has('orgs')).toBe(true);
    expect(PUBLIC_PLATFORM_TABLE_NAMES.has('runtime_control_receipts')).toBe(true);
    expect(PUBLIC_PLATFORM_TABLE_NAMES.has('runtime_control_processes')).toBe(true);
    expect(PUBLIC_PLATFORM_TABLE_NAMES.has('product_migration_ledger')).toBe(true);
    expect(PUBLIC_PLATFORM_TABLE_NAMES.has('__drizzle_migrations')).toBe(false);
    expect(PUBLIC_PLATFORM_TABLE_NAMES.size).toBe(PLATFORM_TABLES.length - 1);
  });
});
