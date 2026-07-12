/**
 * Unit oracle for the ATOMIC member-upsert (no DB).
 *
 * Proves `addMember` emits a SINGLE `INSERT … ON CONFLICT (user_id, org_id) DO UPDATE` statement
 * rather than a read-then-branch-then-insert. Reverting to the old read-then-insert shape makes the
 * store call `.transaction`/`.select`/`.insert` (never the captured `.execute`), so this test turns
 * RED — the deterministic fail-the-fix oracle for the concurrency-race fix (two concurrent fresh
 * adds → duplicate INSERT → UNIQUE(user_id, org_id) 23505 → HTTP 500).
 */
import type { Db } from '@rayspec/db';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { OrgStore } from './org-store.js';

describe('OrgStore.addMember — atomic upsert (SQL-emission oracle)', () => {
  it('emits one INSERT … ON CONFLICT (user_id, org_id) DO UPDATE (not a read-then-insert)', async () => {
    let captured: SQL | undefined;
    // A fake Db that only implements `.execute`: the atomic upsert routes through it. The old
    // read-then-insert used `.transaction`/`.select`/`.insert` (absent here) → it would throw, so
    // this test is a genuine fail-the-fix guard, not merely a shape assertion.
    const fakeDb = {
      execute: (q: SQL) => {
        captured = q;
        return Promise.resolve([{ role: 'member', activated: true }]);
      },
    } as unknown as Db;
    const store = new OrgStore(fakeDb);

    const out = await store.addMember(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );
    expect(out).toEqual({ role: 'member', activated: true });

    expect(captured).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(captured as SQL).sql.toLowerCase();
    expect(rendered).toContain('insert into');
    expect(rendered).toContain('on conflict (user_id, org_id)');
    expect(rendered).toContain('do update');
    // The role CASE that never demotes an already-active owner/admin on re-add.
    expect(rendered).toContain('case');
  });
});
