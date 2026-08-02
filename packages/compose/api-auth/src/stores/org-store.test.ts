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
 *
 * Plus the same posture on `reserveOrgById` — the operator provisioning path's create-or-resolve. It
 * writes NO membership, so what keeps it from leaving an unclaimable org behind is the REQUIRED
 * `claim` callback: the arms below pin that the callback runs exactly once on both the created and the
 * resolved path, and ZERO times when the posture refuses the call.
 */
import type { Db, TenantDb } from '@rayspec/db';
import { schema } from '@rayspec/db';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { OrgStore, OrgTombstonedError } from './org-store.js';

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
 *
 * `state` models what the RESERVATION path finds when the database already holds the chosen id: an
 * `existingOrg` makes the org INSERT return zero rows (`ON CONFLICT (id) DO NOTHING` swallowed it) and
 * is what the locking `SELECT … FOR UPDATE` reads back, while `owners` is the active-owner count read
 * under that same lock. Omitted — which is how the `createOrgWithOwner` arms above call it — every
 * builder answers exactly as it did before, which is why those arms need no change.
 *
 * `select` is modelled because the reservation reads twice inside its transaction, and `execute`
 * because `TenantDb.transaction` sets the tenant GUC before handing the callback its handle. Neither
 * is reachable from `createOrgWithOwner`, which uses the raw `db.transaction` + inserts only.
 */
function capturingDb(
  captured: {
    org?: Record<string, unknown>;
    member?: Record<string, unknown>;
    locked?: boolean;
  },
  state: {
    existingOrg?: { id: string; name: string; slug: string; deletedAt: Date | null };
    owners?: number;
  } = {},
): Db {
  const existing = state.existingOrg;
  const tx = {
    execute: async () => [],
    insert(table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          if (table === schema.orgs) captured.org = v;
          else captured.member = v;
          const rows = [{ id: (v.id as string) ?? 'db-generated-id', name: v.name, slug: v.slug }];
          // The id is already taken ⇒ DO NOTHING swallows the insert and RETURNING is empty. Only the
          // orgs insert has a conflict target, so the memberships builder is untouched.
          const swallowed = {
            returning: async () => [] as typeof rows,
            onConflictDoNothing: () => swallowed,
          };
          const builder = {
            returning: async () => rows,
            onConflictDoNothing: () =>
              existing !== undefined && table === schema.orgs ? swallowed : builder,
            // biome-ignore lint/suspicious/noThenProperty: the real drizzle insert builder IS thenable — the memberships insert is awaited without `.returning()`, so the fake must be too.
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
          };
          return builder;
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          const rows =
            table === schema.orgs
              ? existing === undefined
                ? []
                : [existing]
              : Array.from({ length: state.owners ?? 0 }, () => ({ role: 'owner' }));
          const q = {
            limit: () => q,
            for: () => {
              captured.locked = true;
              return q;
            },
            // biome-ignore lint/suspicious/noThenProperty: the real drizzle select builder IS thenable — both reads are awaited without a terminal method, so the fake must be too.
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
          };
          return { where: () => q };
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

describe('OrgStore.reserveOrgById — create-or-resolve under a chosen id', () => {
  const CHOSEN = '11111111-1111-4111-8111-111111111111';

  it('without the bootstrap posture: refused before anything is inserted, and claim never runs', async () => {
    const captured: { org?: Record<string, unknown>; member?: Record<string, unknown> } = {};
    let claims = 0;
    const store = new OrgStore(capturingDb(captured));

    await expect(
      store.reserveOrgById({ id: CHOSEN, name: 'Acme', slug: 'acme' }, async () => {
        claims += 1;
      }),
    ).rejects.toThrow(/RAYSPEC_TENANT_BOOTSTRAP_ENABLED/);
    // The refusal is the FIRST thing the method does, so the caller is never asked what makes the org
    // claimable for an org that was never reserved.
    expect(claims).toBe(0);
    expect(captured.org).toBeUndefined();
    expect(captured.member).toBeUndefined();
  });

  it('created path: the INSERT names id+name+slug, NO membership is written, claim runs once', async () => {
    const captured: { org?: Record<string, unknown>; member?: Record<string, unknown> } = {};
    const seen: { created?: boolean; owners?: number; orgId?: string; tenantId?: string } = {};
    let claims = 0;
    const store = new OrgStore(capturingDb(captured), { tenantBootstrapEnabled: true });

    const out = await store.reserveOrgById(
      { id: CHOSEN, name: 'Acme', slug: 'acme' },
      async (ttx: TenantDb, org, state) => {
        claims += 1;
        seen.created = state.created;
        seen.owners = state.owners;
        seen.orgId = org.id;
        seen.tenantId = ttx.tenantId;
      },
    );

    expect(captured.org).toEqual({ id: CHOSEN, name: 'Acme', slug: 'acme' });
    // The reservation writes the org row and NOTHING else — the owner arrives by redeeming the invite
    // the claim callback writes, so no membership exists at this point by construction.
    expect(captured.member).toBeUndefined();
    expect(claims).toBe(1);
    expect(seen).toEqual({ created: true, owners: 0, orgId: CHOSEN, tenantId: CHOSEN });
    expect(out).toEqual({
      org: { id: CHOSEN, name: 'Acme', slug: 'acme' },
      created: true,
      owners: 0,
    });
  });

  it('resolved path: the taken row is read back UNDER A ROW LOCK and claim still runs once', async () => {
    const captured: {
      org?: Record<string, unknown>;
      member?: Record<string, unknown>;
      locked?: boolean;
    } = {};
    let claims = 0;
    const store = new OrgStore(
      capturingDb(captured, {
        existingOrg: { id: CHOSEN, name: 'Acme Stored', slug: 'acme-stored', deletedAt: null },
        owners: 0,
      }),
      { tenantBootstrapEnabled: true },
    );

    const out = await store.reserveOrgById(
      { id: CHOSEN.toUpperCase(), name: 'Acme', slug: 'acme' },
      async () => {
        claims += 1;
      },
    );

    // A resolve must still be able to reconcile a missing invite, so the callback is not a
    // create-only hook.
    expect(claims).toBe(1);
    expect(captured.locked).toBe(true);
    expect(out.created).toBe(false);
    // The row the DATABASE returned, never the operator's spelling of the id or the name they passed.
    expect(out.org).toEqual({ id: CHOSEN, name: 'Acme Stored', slug: 'acme-stored' });
  });

  it('a tombstoned id is its own refusal, not a resolve, and claim never runs', async () => {
    const captured: { org?: Record<string, unknown>; member?: Record<string, unknown> } = {};
    let claims = 0;
    const store = new OrgStore(
      capturingDb(captured, {
        existingOrg: { id: CHOSEN, name: 'Gone', slug: 'gone', deletedAt: new Date() },
      }),
      { tenantBootstrapEnabled: true },
    );

    await expect(
      store.reserveOrgById({ id: CHOSEN, name: 'Acme', slug: 'acme' }, async () => {
        claims += 1;
      }),
    ).rejects.toThrow(OrgTombstonedError);
    expect(claims).toBe(0);
  });

  it('owners already on the org are reported to claim, which is what makes a resolve safe', async () => {
    const captured: { org?: Record<string, unknown>; member?: Record<string, unknown> } = {};
    let owners = -1;
    const store = new OrgStore(
      capturingDb(captured, {
        existingOrg: { id: CHOSEN, name: 'Acme', slug: 'acme', deletedAt: null },
        owners: 2,
      }),
      { tenantBootstrapEnabled: true },
    );

    const out = await store.reserveOrgById(
      { id: CHOSEN, name: 'Acme', slug: 'acme' },
      async (_ttx, _org, state) => {
        owners = state.owners;
      },
    );
    expect(owners).toBe(2);
    expect(out.owners).toBe(2);
  });
});
