/**
 * The data categories of a snapshot, without a database: every platform table takes the category of
 * the platform table list, a product store of the application is product data, anything else is
 * unknown and blocks the export; the always-excluded categories and run history under its policy
 * never have their rows exported, and the identity policy is the contract's object.
 */
import { PLATFORM_TABLES, schemaValidator } from '@rayspec/bundle-contract';
import { describe, expect, it } from 'vitest';
import {
  classifyApplicationTables,
  excludedDataCategories,
  identityPolicy,
  SNAPSHOT_TABLE_NAME,
} from './snapshot-source.js';

const live = (...names: string[]) =>
  names.map((n) => {
    const [schema, table] = n.split('.');
    return { schema: schema!, table: table! };
  });

describe('excludedDataCategories', () => {
  it('always lists the four reset or source-only categories, and run history when excluded', () => {
    expect(excludedDataCategories('included')).toEqual([
      'credential-state',
      'request-replay-state',
      'runtime-control-state',
      'security-audit-log',
    ]);
    expect(excludedDataCategories('excluded')).toEqual([
      'credential-state',
      'request-replay-state',
      'run-history',
      'runtime-control-state',
      'security-audit-log',
    ]);
  });
});

describe('classifyApplicationTables', () => {
  const all = PLATFORM_TABLES.map((p) => ({ schema: p.schema, table: p.table }));

  it('classifies every platform table from the list, product stores as product data', () => {
    const { tables, unknown } = classifyApplicationTables(
      [...all, ...live('public.field_notes')],
      new Set(['field_notes']),
      'included',
    );
    expect(unknown).toEqual([]);
    expect(tables).toHaveLength(PLATFORM_TABLES.length + 1);
    for (const p of PLATFORM_TABLES) {
      expect(tables.find((t) => t.schema === p.schema && t.table === p.table)?.category).toBe(
        p.category,
      );
    }
    expect(tables.find((t) => t.table === 'field_notes')).toEqual({
      schema: 'public',
      table: 'field_notes',
      category: 'product-store-data',
      rowsExported: true,
    });
  });

  it('exports the rows of no credential, replay, audit or runtime-control table', () => {
    const { tables } = classifyApplicationTables(all, new Set(), 'included');
    const withoutRows = tables.filter((t) => !t.rowsExported).map((t) => t.table);
    expect(withoutRows.sort()).toEqual(
      [
        'api_keys',
        'auth_audit',
        'idempotency_keys',
        'invites',
        'oidc_models',
        'owner_recovery_tokens',
        'runtime_control_processes',
        'runtime_control_receipts',
        'runtime_control_state',
        'sessions',
      ].sort(),
    );
    expect(tables.find((t) => t.table === 'users')?.rowsExported).toBe(true);
    expect(tables.find((t) => t.table === 'product_migration_ledger')?.rowsExported).toBe(true);
    expect(tables.find((t) => t.table === '__drizzle_migrations')?.rowsExported).toBe(true);
  });

  it('keeps run history rows only under the included policy', () => {
    const runHistory = PLATFORM_TABLES.filter((p) => p.category === 'run-history');
    expect(runHistory.length).toBeGreaterThan(0);
    for (const policy of ['included', 'excluded'] as const) {
      const { tables } = classifyApplicationTables(all, new Set(), policy);
      for (const r of runHistory) {
        expect(tables.find((t) => t.table === r.table)?.rowsExported).toBe(policy === 'included');
      }
    }
  });

  it('reports every other table as unknown: an unlisted table, a store of another schema, a stray schema', () => {
    const { unknown, tables } = classifyApplicationTables(
      live('public.side_ledger', 'reporting.field_notes', 'drizzle.other', 'public.field_notes'),
      new Set(['field_notes']),
      'included',
    );
    expect(unknown).toEqual(['drizzle.other', 'public.side_ledger', 'reporting.field_notes']);
    expect(tables.map((t) => t.table)).toEqual(['field_notes']);
  });

  it('sorts the tables by schema, then name', () => {
    const { tables } = classifyApplicationTables(
      live('public.users', 'drizzle.__drizzle_migrations', 'public.orgs'),
      new Set(),
      'included',
    );
    expect(tables.map((t) => `${t.schema}.${t.table}`)).toEqual([
      'drizzle.__drizzle_migrations',
      'public.orgs',
      'public.users',
    ]);
  });
});

describe('identityPolicy and table names', () => {
  it('is the object the snapshot schema requires, with either password hash value', () => {
    const validate = schemaValidator('snapshot', '/properties/identityPolicy');
    expect(validate(identityPolicy('preserved'))).toBe(true);
    expect(validate(identityPolicy('reset'))).toBe(true);
    expect(identityPolicy('reset')).toMatchObject({
      userIds: 'preserved',
      sessions: 'reset',
      apiKeys: 'reset',
      invites: 'reset',
      apiKeyPepper: 'reissued',
    });
  });

  it('accepts the names snapshot.json can state, and no other', () => {
    for (const p of PLATFORM_TABLES) expect(SNAPSHOT_TABLE_NAME.test(p.table)).toBe(true);
    for (const bad of ['Upper', 'with space', '1leading', 'x'.repeat(64), 'ümlaut']) {
      expect(SNAPSHOT_TABLE_NAME.test(bad), bad).toBe(false);
    }
  });
});
