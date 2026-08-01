/**
 * Unit oracle for the ATOMIC member-upsert (no DB).
 *
 * Proves `addMember` emits a SINGLE `INSERT … ON CONFLICT (user_id, org_id) DO UPDATE` statement
 * rather than a read-then-branch-then-insert. Reverting to the old read-then-insert shape makes the
 * store call `.transaction`/`.select`/`.insert` (never the captured `.execute`), so this test turns
 * RED — the deterministic fail-the-fix oracle for the concurrency-race fix (two concurrent fresh
 * adds → duplicate INSERT → UNIQUE(user_id, org_id) 23505 → HTTP 500).
 *
 * Plus the CHOSEN-ORG-ID posture on `createOrgWithOwner`: the default store must emit an INSERT that
 * names NO id (the database generates it, as it always has), and must REFUSE an explicit id outright
 * — the store, not the caller, is the single point where the operator posture is enforced, so a route
 * that forgot to check can never smuggle an id past it.
 */
import type { Db } from '@rayspec/db';
import { schema } from '@rayspec/db';
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

/**
 * A fake Db whose `transaction` hands out an insert builder that only RECORDS the values object. The
 * memberships insert is awaited directly (no `.returning()`), so the builder is thenable as well.
 */
function capturingDb(captured: {
  org?: Record<string, unknown>;
  member?: Record<string, unknown>;
}): Db {
  const tx = {
    insert(table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          if (table === schema.orgs) captured.org = v;
          else captured.member = v;
          const rows = [{ id: (v.id as string) ?? 'db-generated-id', name: v.name, slug: v.slug }];
          const builder = {
            returning: async () => rows,
            onConflictDoNothing: () => builder,
            // biome-ignore lint/suspicious/noThenProperty: the real drizzle insert builder IS thenable — the memberships insert is awaited without `.returning()`, so the fake must be too.
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
          };
          return builder;
        },
      };
    },
  };
  return {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
}

describe('OrgStore.createOrgWithOwner — the chosen-org-id posture', () => {
  it('without an id: the org INSERT names name+slug ONLY (the database generates the id, as before)', async () => {
    const captured: { org?: Record<string, unknown>; member?: Record<string, unknown> } = {};
    const store = new OrgStore(capturingDb(captured));

    const org = await store.createOrgWithOwner({
      name: 'Acme',
      slug: 'acme',
      ownerUserId: '22222222-2222-2222-2222-222222222222',
    });

    expect(captured.org).toEqual({ name: 'Acme', slug: 'acme' });
    expect(captured.org).not.toHaveProperty('id');
    expect(captured.member).toEqual({
      orgId: 'db-generated-id',
      userId: '22222222-2222-2222-2222-222222222222',
      role: 'owner',
      status: 'active',
    });
    expect(org.id).toBe('db-generated-id');
  });

  it('with an id and the bootstrap posture ON: the id is written on the org row', async () => {
    const captured: { org?: Record<string, unknown>; member?: Record<string, unknown> } = {};
    const store = new OrgStore(capturingDb(captured), { tenantBootstrapEnabled: true });

    const org = await store.createOrgWithOwner({
      name: 'Acme',
      slug: 'acme',
      ownerUserId: '22222222-2222-2222-2222-222222222222',
      id: '11111111-1111-4111-8111-111111111111',
    });

    expect(captured.org).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Acme',
      slug: 'acme',
    });
    // The owner membership is written against the CHOSEN id inside the SAME transaction — never a
    // memberless org (invites are owner-only, so a memberless org is a permanent dead end).
    expect(captured.member?.orgId).toBe('11111111-1111-4111-8111-111111111111');
    expect(org.id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('with an id but the posture OFF: refused by the store, nothing is inserted', async () => {
    const captured: { org?: Record<string, unknown>; member?: Record<string, unknown> } = {};
    const store = new OrgStore(capturingDb(captured));

    await expect(
      store.createOrgWithOwner({
        name: 'Acme',
        slug: 'acme',
        ownerUserId: '22222222-2222-2222-2222-222222222222',
        id: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toThrow(/RAYSPEC_TENANT_BOOTSTRAP_ENABLED/);
    expect(captured.org).toBeUndefined();
    expect(captured.member).toBeUndefined();
  });
});
