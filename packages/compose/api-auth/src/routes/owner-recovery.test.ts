/**
 * Owner recovery — the operator issues a one-time token for an owner who holds no password, and the
 * owner redeems it through the real Hono app against Postgres.
 *
 * Covers: the redemption sets the password and signs the owner in; the token redeems once only,
 * sequentially and concurrently; an expired, replaced or unknown token, or one whose account is no
 * longer a password-less active owner, is refused alike; the issue refuses an owner with a password,
 * a non-owner and a fenced environment; only the token's HMAC is stored; both sides are audited.
 */
import { hashOwnerRecoveryToken } from '@rayspec/auth-core';
import { schema } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OwnerRecoveryStore } from '../stores/owner-recovery-store.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

let h: Harness;
let store: OwnerRecoveryStore;
const PEPPER = (): string => process.env.RAYSPEC_API_KEY_PEPPER as string;
const NEW_PASSWORD = ['recovered', 'owner', 'password'].join('-');

beforeAll(async () => {
  h = await createHarness({ schema: 'rayspec_test_apiauth_owner_recovery' });
  store = new OwnerRecoveryStore(h.db);
  // The environment's fence row, in this suite's own schema (the search path finds it first).
  await h.db.$client.unsafe(
    `CREATE TABLE runtime_control_state (id smallint PRIMARY KEY, fence_state text NOT NULL)`,
  );
});
beforeEach(async () => {
  await h.reset();
  await h.db.$client.unsafe('DELETE FROM runtime_control_state');
  await h.db.$client.unsafe(`INSERT INTO runtime_control_state VALUES (1, 'open')`);
});
afterAll(async () => {
  await h.close();
});

/**
 * An organization whose owner holds no password — the owner whose only credential was an API key —
 * and a member who has one.
 */
async function orgWithPasswordlessOwner(email = 'keyholder@example.com'): Promise<{
  orgId: string;
  ownerId: string;
  memberEmail: string;
}> {
  const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-sufficiently-long-password', orgName: 'Acme' },
  });
  expect(reg.status).toBe(201);
  const orgId = (await reg.json()).activeOrgId as string;
  const [owner] = await h.db.select().from(schema.users).where(eq(schema.users.email, email));
  await h.db.update(schema.users).set({ passwordHash: null }).where(eq(schema.users.id, owner!.id));
  const memberEmail = `member-${email}`;
  const member = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email: memberEmail, password: 'member-long-password' },
  });
  expect(member.status).toBe(201);
  const [m] = await h.db.select().from(schema.users).where(eq(schema.users.email, memberEmail));
  await h.db.insert(schema.memberships).values({ orgId, userId: m!.id, role: 'member' });
  return { orgId, ownerId: owner!.id, memberEmail };
}

function redeem(token: string, password = NEW_PASSWORD): Promise<Response> {
  return jsonRequest(h.app, 'POST', '/v1/auth/owner-recovery', { body: { token, password } });
}

function login(email: string, password: string): Promise<Response> {
  return jsonRequest(h.app, 'POST', '/v1/auth/login', { body: { email, password } });
}

const INVALID = 'This recovery token is invalid, expired, or already used.';

describe('redeem', () => {
  it('sets the password, signs the owner in, and works once only', async () => {
    const { orgId, ownerId } = await orgWithPasswordlessOwner();
    // Precondition: the owner has nothing to sign in with.
    expect((await login('keyholder@example.com', NEW_PASSWORD)).status).toBe(401);
    const issued = await store.issue({
      email: 'keyholder@example.com',
      ttlSeconds: 600,
      pepper: PEPPER(),
    });
    expect(issued).toMatchObject({ orgId, userId: ownerId, replaced: 0 });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const first = await redeem(issued.token);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ activeOrgId: orgId, userId: ownerId, role: 'owner' });
    expect(first.headers.getSetCookie().some((c) => c.startsWith('__Host-rayspec_refresh='))).toBe(
      true,
    );
    // The owner's token reaches their organization.
    const members = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/members`, {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(members.status).toBe(200);
    expect((await login('keyholder@example.com', NEW_PASSWORD)).status).toBe(200);

    const second = await redeem(issued.token, 'another-long-password');
    expect(second.status).toBe(400);
    expect((await second.json()).error.message).toBe(INVALID);
    expect((await login('keyholder@example.com', 'another-long-password')).status).toBe(401);

    // Only the HMAC is stored, and both sides are on record without the token.
    const rows = await h.db.select().from(schema.ownerRecoveryTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashOwnerRecoveryToken(issued.token, PEPPER()));
    expect(rows[0]!.consumedAt).not.toBeNull();
    const audit = await h.db.select().from(schema.authAudit);
    expect(audit.map((a) => a.event)).toEqual(
      expect.arrayContaining(['owner_recovery_issued', 'owner_recovery_redeemed', 'login']),
    );
    expect(audit.find((a) => a.event === 'owner_recovery_issued')).toMatchObject({
      actorOrgId: orgId,
      actorUserId: null,
      meta: { recoveryId: issued.recoveryId, targetUserId: ownerId, issuedBy: 'operator' },
    });
    expect(JSON.stringify(audit)).not.toContain(issued.token);
  });

  it('two concurrent redemptions of one token: exactly one wins', async () => {
    await orgWithPasswordlessOwner();
    const { token } = await store.issue({
      email: 'keyholder@example.com',
      ttlSeconds: 600,
      pepper: PEPPER(),
    });
    const results = await Promise.all([redeem(token), redeem(token, 'a-different-password')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('refuses an expired, a replaced and an unknown token alike', async () => {
    await orgWithPasswordlessOwner();
    const expired = await store.issue({
      email: 'keyholder@example.com',
      ttlSeconds: 300,
      pepper: PEPPER(),
      now: new Date(Date.now() - 600_000),
    });
    // Precondition: it really is expired.
    const [row] = await h.db.select().from(schema.ownerRecoveryTokens);
    expect(row!.expiresAt.getTime()).toBeLessThan(Date.now());
    const replacedFirst = await store.issue({
      email: 'keyholder@example.com',
      ttlSeconds: 600,
      pepper: PEPPER(),
    });
    const latest = await store.issue({
      email: 'keyholder@example.com',
      ttlSeconds: 600,
      pepper: PEPPER(),
    });
    expect(latest.replaced).toBe(1);
    for (const token of [expired.token, replacedFirst.token, 'not-a-token']) {
      const res = await redeem(token);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toBe(INVALID);
    }
    expect((await redeem(latest.token)).status).toBe(200);
  });

  it('refuses a token whose owner is no longer an active owner without a password', async () => {
    const { ownerId } = await orgWithPasswordlessOwner();
    const demoted = await store.issue({
      email: 'keyholder@example.com',
      ttlSeconds: 600,
      pepper: PEPPER(),
    });
    await h.db
      .update(schema.memberships)
      .set({ role: 'member' })
      .where(eq(schema.memberships.userId, ownerId));
    expect((await redeem(demoted.token)).status).toBe(400);
    // Nothing was consumed: the refusal changed nothing.
    const [row] = await h.db.select().from(schema.ownerRecoveryTokens);
    expect(row!.consumedAt).toBeNull();
  });

  it('a token minted under another pepper does not redeem', async () => {
    await orgWithPasswordlessOwner();
    const { token } = await store.issue({
      email: 'keyholder@example.com',
      ttlSeconds: 600,
      pepper: `${PEPPER()}-of-another-deployment`,
    });
    expect((await redeem(token)).status).toBe(400);
  });

  it('refuses a password the platform would refuse anywhere else', async () => {
    await orgWithPasswordlessOwner();
    const { token } = await store.issue({
      email: 'keyholder@example.com',
      ttlSeconds: 600,
      pepper: PEPPER(),
    });
    expect((await redeem(token, 'short')).status).toBe(400);
    expect((await redeem(token)).status).toBe(200);
  });
});

describe('issue', () => {
  it('refuses an owner who holds a password, a member, and an unknown address', async () => {
    const { memberEmail } = await orgWithPasswordlessOwner();
    await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'pw-owner@example.com', password: 'owner-long-password', orgName: 'Beta' },
    });
    await expect(
      store.issue({ email: 'pw-owner@example.com', ttlSeconds: 600, pepper: PEPPER() }),
    ).rejects.toMatchObject({ code: 'PASSWORD_PRESENT' });
    await expect(
      store.issue({ email: memberEmail, ttlSeconds: 600, pepper: PEPPER() }),
    ).rejects.toMatchObject({ code: 'NO_SUCH_OWNER' });
    await expect(
      store.issue({ email: 'nobody@example.com', ttlSeconds: 600, pepper: PEPPER() }),
    ).rejects.toMatchObject({ code: 'NO_SUCH_OWNER' });
    expect(await h.db.select().from(schema.ownerRecoveryTokens)).toEqual([]);
  });

  it('refuses while the environment is fenced, and writes nothing', async () => {
    await orgWithPasswordlessOwner();
    await h.db.$client.unsafe(`UPDATE runtime_control_state SET fence_state = 'fenced'`);
    await expect(
      store.issue({ email: 'keyholder@example.com', ttlSeconds: 600, pepper: PEPPER() }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_FENCED' });
    expect(await h.db.select().from(schema.ownerRecoveryTokens)).toEqual([]);
    expect(
      (await h.db.select().from(schema.authAudit)).filter(
        (a) => a.event === 'owner_recovery_issued',
      ),
    ).toEqual([]);
  });
});
