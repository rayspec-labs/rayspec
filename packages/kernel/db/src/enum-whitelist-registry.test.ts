/**
 * Column enum-whitelist registry unit tests (no DB): the identity map `buildProductTables` records a
 * store's declared column value whitelists into + the handler-db facade consults. Fail-the-fix: the
 * facade's enum enforcement resolves the whitelist by TABLE IDENTITY, so an unmarked table must read
 * `undefined` (no accidental enforcement) and a marked table must read back exactly what was recorded.
 */

import type { PgTable } from 'drizzle-orm/pg-core';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { enumWhitelistFor, markEnumWhitelist } from './enum-whitelist-registry.js';

/** A fresh runtime table per case (each `pgTable` mints a distinct object → per-object identity keying). */
function table(name: string): PgTable {
  return pgTable(name, { id: text('id'), status: text('status') }) as unknown as PgTable;
}

describe('enum-whitelist-registry', () => {
  it('returns undefined for an unmarked table (no accidental enforcement)', () => {
    expect(enumWhitelistFor(table('unmarked'))).toBeUndefined();
  });

  it('records + reads back a whitelist by TABLE IDENTITY', () => {
    const t = table('tickets');
    const whitelist = new Map([['status', new Set(['open', 'closed'])]]);
    markEnumWhitelist(t, whitelist);
    expect(enumWhitelistFor(t)).toBe(whitelist);
    expect(enumWhitelistFor(t)?.get('status')).toEqual(new Set(['open', 'closed']));
  });

  it('is keyed per object — a DIFFERENT table with the same name is unaffected', () => {
    const marked = table('same_name');
    markEnumWhitelist(marked, new Map([['status', new Set(['a'])]]));
    // A separate object built for the same store name carries no record (each build mints a fresh table).
    expect(enumWhitelistFor(table('same_name'))).toBeUndefined();
  });
});
