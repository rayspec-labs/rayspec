/**
 * DOC-FIRST pin for check 4 (the doc-first rule): `getTableConfig().foreignKeys[].reference()` is a less-stable
 * drizzle introspection surface than `getTableColumns`. This suite asserts the EXACT shape
 * `composition.ts` reads against the pinned drizzle-orm 0.45.2, so a future bump that changes the FK
 * introspection contract (rename `reference()` / drop `foreignTable` / move `onDelete`) FAILS LOUDLY
 * here instead of silently weakening the tenant-FK check to a no-op.
 */

import { getTableName } from 'drizzle-orm';
import { getTableConfig, pgTable, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { orgs } from './schema.js';

describe('drizzle 0.45.2 FK introspection contract (composition.ts check 4 depends on this)', () => {
  const probe = pgTable('fk_probe', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
  });

  it('getTableConfig(table).foreignKeys is a non-empty array', () => {
    const cfg = getTableConfig(probe);
    expect(Array.isArray(cfg.foreignKeys)).toBe(true);
    expect(cfg.foreignKeys.length).toBe(1);
  });

  it('each FK exposes .onDelete and .reference() → { columns, foreignTable, foreignColumns }', () => {
    const [fk] = getTableConfig(probe).foreignKeys;
    expect(fk).toBeDefined();
    expect(fk?.onDelete).toBe('cascade');
    const ref = fk?.reference();
    expect(ref).toBeDefined();
    // local column(s)
    expect(ref?.columns.map((c) => c.name)).toEqual(['tenant_id']);
    // target table + column(s)
    expect(getTableName(ref!.foreignTable)).toBe(getTableName(orgs));
    expect(ref?.foreignColumns.map((c) => c.name)).toEqual(['id']);
  });

  it('a uuid column reports columnType PgUUID and notNull as a boolean (checks 3b/3c)', () => {
    const cfg = getTableConfig(probe);
    const tenant = cfg.columns.find((c) => c.name === 'tenant_id');
    expect(tenant?.columnType).toBe('PgUUID');
    expect(tenant?.notNull).toBe(true);
  });
});
