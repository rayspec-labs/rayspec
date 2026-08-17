/**
 * Out-of-band org-invite flow — integration tests, driven through the REAL Hono app against Postgres.
 *
 * Covers the issue → redeem flow + the security teeth (RED→GREEN, fail-the-fix):
 *  - single-use: a token redeems at most once (sequential AND concurrent);
 *  - expiry: an expired invite is rejected;
 *  - tenant-scoped: the org is resolved FROM the token (never a URL); B never sees A's invite;
 *  - NO account-existence oracle on ISSUE: the response shape is identical whether or not the email
 *    already has an account;
 *  - the two accept auth models: provision-a-new-account vs authenticate-as-an-existing-account.
 */
import { mintInviteToken } from '@rayspec/auth-core';
import { forTenant, schema } from '@rayspec/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ schema: 'rayspec_test_apiauth_invites' });
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

/** Register a user; return its initial Bearer token + userId (no org yet). */
async function registerUser(email: string): Promise<{ token: string; userId: string }> {
  const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-sufficiently-long-password' },
  });
  expect(res.status).toBe(201);
  const token = (await res.json()).accessToken as string;
  const me = await (
    await jsonRequest(h.app, 'GET', '/v1/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  return { token, userId: me.userId as string };
}

/** Register an owner + create an org + switch → an org-scoped owner token. */
async function ownerWithOrg(
  email = 'owner@example.com',
  orgName = 'Acme',
): Promise<{ ownerToken: string; orgId: string; ownerUserId: string }> {
  const { token, userId } = await registerUser(email);
  const orgId = (
    await (
      await jsonRequest(h.app, 'POST', '/v1/orgs', {
        body: { name: orgName },
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()
  ).id as string;
  const ownerToken = (
    await (
      await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()
  ).accessToken as string;
  return { ownerToken, orgId, ownerUserId: userId };
}

/** Issue an invite (returns the Response so a caller can assert status too). */
function issueInvite(
  ownerToken: string,
  orgId: string,
  body: { email: string; role?: string; expiresInSeconds?: number },
): Promise<Response> {
  return jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/invites`, {
    body,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
}

/** Owner's view of the org's member emails. */
async function memberEmails(ownerToken: string, orgId: string): Promise<string[]> {
  const res = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/members`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()).members as { email: string }[]).map((m) => m.email);
}

describe('issue invite (owner-only)', () => {
  it('owner issues an invite and receives the opaque token ONCE', async () => {
    const { ownerToken, orgId } = await ownerWithOrg();
    const res = await issueInvite(ownerToken, orgId, {
      email: 'invitee@example.com',
      role: 'admin',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.email).toBe('invitee@example.com');
    expect(body.role).toBe('admin');
    expect(typeof body.expiresAt).toBe('string');
    // The response never carries a hash / password / account signal.
    expect(JSON.stringify(body)).not.toMatch(
      /token_hash|tokenHash|password|oneTimePassword|\$argon2/,
    );
  });

  it('a non-owner MEMBER cannot issue an invite (403, org:member:add is owner-only)', async () => {
    const { ownerToken, orgId } = await ownerWithOrg();
    // Bring in a plain member via the invite flow, then have them try to issue.
    const invite = await (
      await issueInvite(ownerToken, orgId, { email: 'member@example.com', role: 'member' })
    ).json();
    const accept = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: invite.inviteToken, password: 'member-sets-a-password-xx' },
    });
    expect(accept.status).toBe(201);
    const memberToken = (await accept.json()).accessToken as string;
    // The member (role=member) attempts to issue → authz denies (org:member:add not granted to member).
    const denied = await issueInvite(memberToken, orgId, { email: 'x@example.com' });
    expect(denied.status).toBe(403);
  });

  it('another org’s owner cannot issue for THIS org (404, URL orgId != server tenant)', async () => {
    const { orgId: orgA } = await ownerWithOrg('a@example.com', 'OrgA');
    const { ownerToken: bToken } = await ownerWithOrg('b@example.com', 'OrgB');
    const res = await issueInvite(bToken, orgA, { email: 'x@example.com' });
    expect(res.status).toBe(404); // cross-tenant, no existence leak
  });
});

describe('NO account-existence oracle on ISSUE (teeth)', () => {
  it('the issue response shape + status are IDENTICAL whether or not the email has an account', async () => {
    const { ownerToken, orgId } = await ownerWithOrg();
    // One email HAS a global account (registered, no org); one does NOT.
    await registerUser('has-account@example.com');

    const withAccount = await issueInvite(ownerToken, orgId, { email: 'has-account@example.com' });
    const withoutAccount = await issueInvite(ownerToken, orgId, {
      email: 'no-account@example.com',
    });

    // Same status.
    expect(withAccount.status).toBe(201);
    expect(withoutAccount.status).toBe(201);

    const a = await withAccount.json();
    const b = await withoutAccount.json();
    // IDENTICAL key set — the response never branches on account existence (a differing branch = RED).
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    // Both mint a usable token; neither leaks an account-existence field (e.g. oneTimePassword).
    expect(a.inviteToken).toBeTruthy();
    expect(b.inviteToken).toBeTruthy();
    expect(a).not.toHaveProperty('oneTimePassword');
    expect(b).not.toHaveProperty('oneTimePassword');
    // The role field is present + equal on both; only the token + email + expiry differ.
    expect(a.role).toBe(b.role);
  });
});

describe('accept — provision a NEW account', () => {
  it('an invitee with no account sets a password, joins, and is logged in', async () => {
    const { ownerToken, orgId } = await ownerWithOrg();
    const invite = await (
      await issueInvite(ownerToken, orgId, { email: 'newbie@example.com', role: 'admin' })
    ).json();

    const res = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: invite.inviteToken, password: 'newbie-picks-a-password-xx' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.activeOrgId).toBe(orgId);
    expect(body.role).toBe('admin'); // the invited role is honored on a fresh join
    expect(body.accessToken).toBeTruthy();
    expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);

    // The owner now sees the invitee as a member.
    expect(await memberEmails(ownerToken, orgId)).toContain('newbie@example.com');

    // The provisioned account can log in with the password it set.
    const login = await jsonRequest(h.app, 'POST', '/v1/auth/login', {
      body: { email: 'newbie@example.com', password: 'newbie-picks-a-password-xx' },
    });
    expect(login.status).toBe(200);
  });

  it('a new-account accept WITHOUT a password is rejected (400)', async () => {
    const { ownerToken, orgId } = await ownerWithOrg();
    const invite = await (
      await issueInvite(ownerToken, orgId, { email: 'nopass@example.com' })
    ).json();
    const res = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: invite.inviteToken },
    });
    expect(res.status).toBe(400);
    // The invite was NOT consumed (no membership, and it can still be redeemed with a password).
    expect(await memberEmails(ownerToken, orgId)).not.toContain('nopass@example.com');
    const retry = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: invite.inviteToken, password: 'now-with-a-password-xx' },
    });
    expect(retry.status).toBe(201);
  });
});

describe('accept — join an EXISTING account (authenticated-invitee model)', () => {
  it('the invitee must be AUTHENTICATED as the invited account; anonymous accept is refused', async () => {
    const { ownerToken, orgId } = await ownerWithOrg();
    const existing = await registerUser('existing@example.com');
    const invite = await (
      await issueInvite(ownerToken, orgId, { email: 'existing@example.com', role: 'member' })
    ).json();

    // Anonymous accept (a token bearer who is NOT signed in as the account) → 403, invite NOT consumed.
    const anon = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: invite.inviteToken },
    });
    expect(anon.status).toBe(403);

    // A DIFFERENT authenticated user cannot claim it either → 403.
    const other = await registerUser('other@example.com');
    const wrongUser = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: invite.inviteToken },
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(wrongUser.status).toBe(403);

    // The RIGHT authenticated user joins → 200 (still consumable because neither 403 consumed it).
    const ok = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: invite.inviteToken },
      headers: { authorization: `Bearer ${existing.token}` },
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.userId).toBe(existing.userId);
    expect(body.activeOrgId).toBe(orgId);
    expect(await memberEmails(ownerToken, orgId)).toContain('existing@example.com');
  });
});

describe('SINGLE-USE (teeth)', () => {
  it('a token cannot be redeemed twice (sequential)', async () => {
    const { ownerToken, orgId } = await ownerWithOrg();
    const invite = await (
      await issueInvite(ownerToken, orgId, { email: 'once@example.com' })
    ).json();

    const first = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: invite.inviteToken, password: 'first-accept-password-xx' },
    });
    expect(first.status).toBe(201);

    // Second redeem of the SAME token → rejected (consumed). Removing the consume ⇒ this succeeds = RED.
    const second = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: invite.inviteToken, password: 'second-accept-password-xx' },
    });
    expect(second.status).toBe(400);
  });

  it('concurrent redeems of one token → exactly ONE wins (the atomic consume gate)', async () => {
    const { ownerToken, orgId } = await ownerWithOrg();
    // Existing-account path avoids a createUser race, isolating the consume gate.
    const existing = await registerUser('concurrent@example.com');
    const invite = await (
      await issueInvite(ownerToken, orgId, { email: 'concurrent@example.com' })
    ).json();

    const fire = () =>
      jsonRequest(h.app, 'POST', '/v1/invites/accept', {
        body: { token: invite.inviteToken },
        headers: { authorization: `Bearer ${existing.token}` },
      });
    const results = await Promise.all([fire(), fire(), fire()]);
    const statuses = results.map((r) => r.status);
    const wins = statuses.filter((s) => s === 200).length;
    expect(wins).toBe(1); // exactly one redeem consumes the invite
    expect(statuses.filter((s) => s === 400).length).toBe(2);
  });
});

describe('EXPIRY (teeth)', () => {
  it('an expired invite is rejected', async () => {
    const { ownerToken, orgId, ownerUserId } = await ownerWithOrg();
    // Seed an already-expired invite directly (the route clamps a requested TTL to a 5-min floor, so an
    // expired one is created via the store). resolveByToken hashes the plaintext to match the stored hash.
    const { token, hash } = mintInviteToken();
    await h.deps.inviteStore.create(orgId, {
      tokenHash: hash,
      email: 'expired@example.com',
      role: 'member',
      expiresAt: new Date(Date.now() - 60_000), // 1 minute in the past
      createdBy: ownerUserId,
    });

    const res = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token, password: 'trying-an-expired-invite-1' },
    });
    // Removing the route's expiry check ⇒ this would 201 = RED.
    expect(res.status).toBe(400);
    expect(await memberEmails(ownerToken, orgId)).not.toContain('expired@example.com');
  });
});

describe('TENANT-SCOPED (teeth)', () => {
  it('the org is resolved FROM the token — an invite issued by A joins A, and B never sees it', async () => {
    const a = await ownerWithOrg('owner-a@example.com', 'OrgA');
    const b = await ownerWithOrg('owner-b@example.com', 'OrgB');
    const invite = await (
      await issueInvite(a.ownerToken, a.orgId, { email: 'joiner@example.com', role: 'member' })
    ).json();

    // The redeemer never supplies an org — it is resolved from the token. The join lands in org A.
    const res = await jsonRequest(h.app, 'POST', '/v1/invites/accept', {
      body: { token: invite.inviteToken, password: 'joiner-sets-a-password-xx' },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).activeOrgId).toBe(a.orgId); // A, not B

    // A sees the new member; B does NOT.
    expect(await memberEmails(a.ownerToken, a.orgId)).toContain('joiner@example.com');
    expect(await memberEmails(b.ownerToken, b.orgId)).not.toContain('joiner@example.com');
  });

  it('the invites table is tenant-isolated: forTenant(B) cannot see A’s invite row', async () => {
    const a = await ownerWithOrg('iso-a@example.com', 'IsoA');
    const b = await ownerWithOrg('iso-b@example.com', 'IsoB');
    await issueInvite(a.ownerToken, a.orgId, { email: 'secret-invitee@example.com' });

    // Through the chokepoint, B sees NONE of A's invites; A sees its own.
    const bRows = await forTenant(h.db, b.orgId).select(schema.invites).all();
    expect(bRows.length).toBe(0);
    const aRows = await forTenant(h.db, a.orgId).select(schema.invites).all();
    expect(aRows.length).toBe(1);
    expect((aRows[0] as { email: string }).email).toBe('secret-invitee@example.com');
    // The stored row holds only the HASH, never a reversible token.
    expect((aRows[0] as { tokenHash: string }).tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
