/**
 * Single-tenant mode through the real Hono app against Postgres: the runtime holds one organization.
 *
 *  - open registration creates the first organization and then closes: a second account (with or
 *    without an organization name) is refused, and no account row is left behind;
 *  - an authenticated user cannot create a second organization;
 *  - two registrations racing for the first organization produce exactly one;
 *  - an invite still brings a new account into the one organization;
 *  - the org store refuses a second organization on the operator path too, while resolving the one
 *    that exists stays idempotent;
 *  - the operator bootstrap route creates the first organization and then refuses, before any
 *    account row is written;
 *  - with the mode off, nothing changes: a second organization is created as before.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthApp } from '../app.js';
import { OrgStore, SingleTenantLimitError } from '../stores/org-store.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const PASSWORD = 'a-sufficiently-long-password';
const REFUSAL = 'This deployment holds a single organization; new accounts join it by invitation.';

async function orgCount(h: Harness): Promise<number> {
  const rows = (await h.db.$client.unsafe('SELECT count(*)::int AS n FROM orgs')) as unknown as {
    n: number;
  }[];
  return rows[0]?.n ?? -1;
}

async function userExists(h: Harness, email: string): Promise<boolean> {
  const rows = await h.db.$client.unsafe('SELECT 1 FROM users WHERE email = $1', [email]);
  return rows.length > 0;
}

describe('single-tenant mode', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ schema: 'rayspec_test_apiauth_single_tenant', singleTenant: true });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  async function registerFirstOwner(): Promise<{ token: string; orgId: string }> {
    const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'owner@example.com', password: PASSWORD, orgName: 'The One' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accessToken: string; activeOrgId: string };
    return { token: body.accessToken, orgId: body.activeOrgId };
  }

  it('registration creates the first organization, then refuses every other account', async () => {
    await registerFirstOwner();
    expect(await orgCount(h)).toBe(1);

    for (const body of [
      { email: 'second@example.com', password: PASSWORD },
      { email: 'third@example.com', password: PASSWORD, orgName: 'Another' },
    ]) {
      const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', { body });
      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string; message: string } };
      expect(err.error.code).toBe('FORBIDDEN');
      expect(err.error.message).toBe(REFUSAL);
      // Refused before an account was created, not after.
      expect(await userExists(h, body.email)).toBe(false);
    }
    expect(await orgCount(h)).toBe(1);
  });

  it('registration without an organization name is refused even before the first organization', async () => {
    const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'loose@example.com', password: PASSWORD },
    });
    expect(res.status).toBe(403);
    expect(await userExists(h, 'loose@example.com')).toBe(false);
  });

  it('an authenticated owner cannot create a second organization', async () => {
    const { token } = await registerFirstOwner();
    const res = await jsonRequest(h.app, 'POST', '/v1/orgs', {
      body: { name: 'Second' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(REFUSAL);
    expect(await orgCount(h)).toBe(1);
  });

  it('two registrations racing for the first organization create exactly one', async () => {
    const results = await Promise.all(
      // Four: under the per-source register rate limit, so every refusal is the tenant limit's.
      Array.from({ length: 4 }, (_, i) =>
        jsonRequest(h.app, 'POST', '/v1/auth/register', {
          body: { email: `racer${i}@example.com`, password: PASSWORD, orgName: `Racer ${i}` },
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 403)).toHaveLength(3);
    expect(await orgCount(h)).toBe(1);
  });

  it('an invite still brings a new account into the one organization', async () => {
    const { token, orgId } = await registerFirstOwner();
    const sw = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const ownerToken = ((await sw.json()) as { accessToken: string }).accessToken;
    const issued = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/invites`, {
      body: { email: 'invited@example.com', role: 'member' },
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(issued.status).toBe(201);
    const inviteToken = ((await issued.json()) as { inviteToken: string }).inviteToken;
    const accepted = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: inviteToken, password: PASSWORD },
    });
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as { activeOrgId: string }).activeOrgId).toBe(orgId);
    expect(await orgCount(h)).toBe(1);
  });

  it('the bootstrap route creates the first organization, then refuses before creating an account', async () => {
    const gated = createAuthApp({
      ...h.deps,
      orgStore: new OrgStore(h.db, { tenantBootstrapEnabled: true, singleTenant: true }),
    });
    const first = await jsonRequest(gated, 'POST', '/v1/auth/bootstrap-tenant', {
      body: {
        email: 'operator@example.com',
        password: PASSWORD,
        orgName: 'The One',
        orgId: randomUUID(),
      },
    });
    expect(first.status).toBe(201);
    expect(await orgCount(h)).toBe(1);
    const second = await jsonRequest(gated, 'POST', '/v1/auth/bootstrap-tenant', {
      body: {
        email: 'second-operator@example.com',
        password: PASSWORD,
        orgName: 'Second',
        orgId: randomUUID(),
      },
    });
    expect(second.status).toBe(403);
    expect(((await second.json()) as { error: { message: string } }).error.message).toBe(REFUSAL);
    expect(await userExists(h, 'second-operator@example.com')).toBe(false);
    expect(await orgCount(h)).toBe(1);
  });

  it('the operator path refuses a second id and still resolves the one that exists', async () => {
    const store = new OrgStore(h.db, { tenantBootstrapEnabled: true, singleTenant: true });
    const first = randomUUID();
    const reserved = await store.reserveOrgById(
      { id: first, name: 'Provisioned', slug: `p-${first.slice(0, 8)}` },
      async () => {},
    );
    expect(reserved.created).toBe(true);
    const again = await store.reserveOrgById(
      { id: first, name: 'Provisioned', slug: `p-${first.slice(0, 8)}` },
      async () => {},
    );
    expect(again.created).toBe(false);
    const second = randomUUID();
    await expect(
      store.reserveOrgById(
        { id: second, name: 'Second', slug: `s-${second.slice(0, 8)}` },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(SingleTenantLimitError);
    await expect(
      store.createOrgWithOwner({ name: 'Third', slug: 'third', ownerUserId: randomUUID() }),
    ).rejects.toBeInstanceOf(SingleTenantLimitError);
    expect(await orgCount(h)).toBe(1);
  });
});

describe('without single-tenant mode', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ schema: 'rayspec_test_apiauth_multi_tenant' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('registration and organization creation are unchanged: a second organization is created', async () => {
    for (const [email, orgName] of [
      ['a@example.com', 'A'],
      ['b@example.com', 'B'],
    ] as const) {
      const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
        body: { email, password: PASSWORD, orgName },
      });
      expect(res.status).toBe(201);
    }
    const loose = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'c@example.com', password: PASSWORD },
    });
    expect(loose.status).toBe(201);
    const token = ((await loose.json()) as { accessToken: string }).accessToken;
    const created = await jsonRequest(h.app, 'POST', '/v1/orgs', {
      body: { name: 'C' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(created.status).toBe(201);
    expect(await orgCount(h)).toBe(3);
  });
});
