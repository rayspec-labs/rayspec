/**
 * The platform table list restates the committed snapshot categories, and files the runtime-control
 * tables, the product migration ledger and the owner recovery tokens under the categories a snapshot
 * treats them by.
 */
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_RECOVERY_TABLES,
  PLATFORM_TABLES,
  PRODUCT_LEDGER_TABLES,
  PUBLIC_PLATFORM_TABLE_NAMES,
  RUNTIME_CONTROL_TABLES,
} from './platform-tables.js';
import { readContractJson } from './test-support/contract-files.js';
import { DATA_CATEGORIES } from './vocabulary.js';

interface Categories {
  tables: { database: string; schema: string; table: string; category: string }[];
}

const categories = readContractJson<Categories>('snapshot-categories.json');

describe('platform tables', () => {
  it('restate the tables of snapshot-categories.json, in order', () => {
    expect(PLATFORM_TABLES).toEqual(
      categories.tables.map(({ database, schema, table, category }) => ({
        database,
        schema,
        table,
        category,
      })),
    );
  });

  it('file the runtime-control tables as runtime-control state, whose rows no snapshot carries', () => {
    expect(RUNTIME_CONTROL_TABLES.map((p) => p.table)).toEqual([
      'runtime_control_processes',
      'runtime_control_receipts',
      'runtime_control_state',
    ]);
    for (const table of RUNTIME_CONTROL_TABLES) {
      expect(table).toMatchObject({ schema: 'public', category: 'runtime-control-state' });
    }
  });

  it('file the product migration ledger with the migration ledgers', () => {
    expect(PRODUCT_LEDGER_TABLES).toEqual([
      {
        database: 'application',
        schema: 'public',
        table: 'product_migration_ledger',
        category: 'platform-migration-ledger',
      },
    ]);
  });

  it('file the owner recovery tokens as credential state, whose rows no snapshot carries', () => {
    expect(IDENTITY_RECOVERY_TABLES).toEqual([
      {
        database: 'application',
        schema: 'public',
        table: 'owner_recovery_tokens',
        category: 'credential-state',
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
    expect(PUBLIC_PLATFORM_TABLE_NAMES.has('owner_recovery_tokens')).toBe(true);
    expect(PUBLIC_PLATFORM_TABLE_NAMES.has('__drizzle_migrations')).toBe(false);
    expect(PUBLIC_PLATFORM_TABLE_NAMES.size).toBe(PLATFORM_TABLES.length - 1);
  });
});
