/**
 * integration tests — orgs + API keys + LIVE-membership authz + the middleware chain,
 * driven through the REAL Hono app against Postgres.
 *
 * Covers the back half of the exit gate + the revocation-bypass closure:
 *  - full flow: register → create org (owner) → mint API key → authenticate a follow-up with
 *    BOTH the JWT and the API key on a scope-guarded route → revoke → 401;
 *  - REVOCATION-BYPASS: revoke membership, then within the JWT TTL attempt apikey:mint with the
 *    still-valid JWT → 403 (live membership check, claim not trusted);
 *  - authz matrix, api-key uniformity, idempotency (tenant-scoped), membership invariants.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ schema: 'rayspec_test_apiauth_orgs' });
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

/** Register a user and return its initial Bearer access token (no org yet). */
async function registerUser(email: string): Promise<string> {
  const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-sufficiently-long-password' },
  });
  expect(res.status).toBe(201);
  return (await res.json()).accessToken as string;
}

/** Create an org (owner) and return its id. Uses a Bearer token (mutating). */
async function createOrg(token: string, name: string): Promise<string> {
  const res = await jsonRequest(h.app, 'POST', '/v1/orgs', {
    body: { name },
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

/** Switch the token's active org → re-minted JWT scoped to orgId. */
async function switchOrg(token: string, orgId: string): Promise<string> {
  const res = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()).accessToken as string;
}

describe('full flow (the exit gate back half)', () => {
  it('register → create org → mint key → auth with BOTH JWT and API key → revoke → 401', async () => {
    const t0 = await registerUser('owner@example.com');
    const orgId = await createOrg(t0, 'Acme');
    const orgToken = await switchOrg(t0, orgId);

    // Mint an API key with agent:run scope (LIVE-membership authz: owner may mint).
    const mintRes = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      body: { name: 'ci', scopes: ['agent:run', 'org:read'] },
      headers: { authorization: `Bearer ${orgToken}` },
    });
    expect(mintRes.status).toBe(201);
    const mint = await mintRes.json();
    expect(mint.plaintext).toMatch(/^mk_.+\..+/);
    expect(JSON.stringify(mint)).not.toMatch(/key_hash|keyHash|\$argon2/);
    const apiKey = mint.plaintext as string;
    const keyId = mint.id as string;

    // Authenticate a follow-up with the JWT on the scope-guarded LIST route.
    const listByJwt = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${orgToken}` },
    });
    expect(listByJwt.status).toBe(200);
    expect((await listByJwt.json()).keys.length).toBe(1);

    // Authenticate the SAME route with the API KEY (apikey:read is granted via org:read? No —
    // listing needs apikey:read; the key has org:read + agent:run). Use the org:read-guarded
    // GET /v1/orgs is not org-scoped; instead hit the api-key list which requires apikey:read.
    // The key does NOT have apikey:read scope → 403 (scope-gated). Prove the key authenticates
    // (not 401) but is scope-denied (403).
    const listByKey = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(listByKey.status).toBe(403); // authenticated as the key, but lacks apikey:read scope

    // Revoke the key (JWT, owner authz).
    const del = await jsonRequest(h.app, 'DELETE', `/v1/orgs/${orgId}/api-keys/${keyId}`, {
      headers: { authorization: `Bearer ${orgToken}` },
    });
    expect(del.status).toBe(204);

    // The revoked key no longer authenticates → 401 (uniform).
    const afterRevoke = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it('a key WITH apikey:read scope can list (scope enforcement positive case)', async () => {
    const t0 = await registerUser('reader@example.com');
    const orgId = await createOrg(t0, 'ReadCo');
    const orgToken = await switchOrg(t0, orgId);
    const mint = await (
      await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
        body: { scopes: ['apikey:read'] },
        headers: { authorization: `Bearer ${orgToken}` },
      })
    ).json();
    const list = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${mint.plaintext}` },
    });
    expect(list.status).toBe(200);
  });
});

describe('REVOCATION-BYPASS closure (live membership, claim not trusted)', () => {
  it('revoke membership, then mint with the still-valid JWT → 403 (live check)', async () => {
    const t0 = await registerUser('victim@example.com');
    const orgId = await createOrg(t0, 'BypassCo');
    const orgToken = await switchOrg(t0, orgId); // a JWT scoped to orgId with role=owner

    // Out-of-band, revoke the owner's membership (simulating an admin removing them).
    await h.db.$client.unsafe(
      `UPDATE rayspec_test_apiauth_orgs.memberships SET status = 'revoked' WHERE org_id = $1`,
      [orgId],
    );

    // The JWT is STILL VALID (within its 8-min TTL) and claims role=owner — but the live
    // membership check denies the sensitive mint.
    const mint = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      body: { scopes: ['agent:run'] },
      headers: { authorization: `Bearer ${orgToken}` },
    });
    expect(mint.status).toBe(403);
  });

  it('demote owner→member, then attempt an owner-only mint within TTL → 403', async () => {
    const t0 = await registerUser('demoted@example.com');
    const orgId = await createOrg(t0, 'DemoteCo');
    const orgToken = await switchOrg(t0, orgId);
    // Demote live (the JWT still says owner).
    await h.db.$client.unsafe(
      `UPDATE rayspec_test_apiauth_orgs.memberships SET role = 'member' WHERE org_id = $1`,
      [orgId],
    );
    const mint = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      body: { scopes: ['agent:run'] },
      headers: { authorization: `Bearer ${orgToken}` },
    });
    // member lacks apikey:mint → 403.
    expect(mint.status).toBe(403);
  });
});

describe('cross-tenant authz: a JWT for org A cannot act in org B', () => {
  it('a token scoped to org A is 404 on org B’s api-keys (URL orgId != server tenant)', async () => {
    const ta = await registerUser('a-user@example.com');
    const orgA = await createOrg(ta, 'OrgA');
    const tokenA = await switchOrg(ta, orgA);

    const tb = await registerUser('b-user@example.com');
    const orgB = await createOrg(tb, 'OrgB');

    // tokenA (scoped to orgA) tries to mint in orgB → 404 (resolveTenant asserts URL==server org).
    const cross = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgB}/api-keys`, {
      body: { scopes: ['agent:run'] },
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(cross.status).toBe(404);
  });
});

describe('org-switch cross-tenant denial is audited', () => {
  it('switching into an org the caller is NOT a member of → 404 + a cross_tenant_denied audit row', async () => {
    const ta = await registerUser('switch-a@example.com');
    const orgA = await createOrg(ta, 'SwitchA');
    const tokenA = await switchOrg(ta, orgA); // A's JWT, member of orgA only

    const tb = await registerUser('switch-b@example.com');
    const orgB = await createOrg(tb, 'SwitchB'); // B's org; A is NOT a member

    // A attempts to switch INTO orgB (no live membership) → 404, no existence leak.
    const res = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgB}/switch`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(404);

    // The denial was audited OUT-OF-BAND: actor=A's org (authoritative), target=opaque hash (NOT orgB).
    const rows = (await h.db.$client.unsafe(
      `SELECT actor_org_id, target_hash, event FROM rayspec_test_apiauth_orgs.auth_audit WHERE event = 'cross_tenant_denied'`,
    )) as unknown as { actor_org_id: string; target_hash: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const denial = rows[0];
    expect(denial?.actor_org_id).toBe(orgA);
    expect(denial?.target_hash).toBeTruthy();
    expect(denial?.target_hash).not.toBe(orgB);
  });
});

describe('API-key auth-path uniformity', () => {
  it('missing-prefix, unknown-prefix, revoked, and wrong-secret all return the same generic 401', async () => {
    const t0 = await registerUser('uniform@example.com');
    const orgId = await createOrg(t0, 'UniformCo');
    const orgToken = await switchOrg(t0, orgId);
    const mint = await (
      await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
        body: { scopes: ['agent:run'] },
        headers: { authorization: `Bearer ${orgToken}` },
      })
    ).json();
    const realPrefix = mint.keyPrefix as string;

    // Revoke it.
    await jsonRequest(h.app, 'DELETE', `/v1/orgs/${orgId}/api-keys/${mint.id}`, {
      headers: { authorization: `Bearer ${orgToken}` },
    });

    const cases = [
      'no-dot-no-prefix', // missing prefix shape
      'mk_unknownprefix.somesecret', // unknown prefix
      `${realPrefix}.wrong-secret-value`, // known prefix, wrong secret
      `${mint.plaintext}`, // revoked key (correct secret)
    ];
    const statuses: number[] = [];
    for (const cred of cases) {
      const res = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
        headers: { authorization: `Bearer ${cred}` },
      });
      statuses.push(res.status);
    }
    // Every failure mode is a uniform 401 (no observable branch on prefix existence/revocation).
    expect(statuses).toEqual([401, 401, 401, 401]);
  });
});

describe('Idempotency-Key on mint (tenant-scoped)', () => {
  it('same key + same body → same response (no duplicate); same key + diff body → 409', async () => {
    const t0 = await registerUser('idem@example.com');
    const orgId = await createOrg(t0, 'IdemCo');
    const orgToken = await switchOrg(t0, orgId);
    const hdr = { authorization: `Bearer ${orgToken}`, 'idempotency-key': 'idem-123' };

    const first = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      body: { scopes: ['agent:run'] },
      headers: hdr,
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    // Same key + same body → replay the SAME snapshot (200), no new key created.
    const replay = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      body: { scopes: ['agent:run'] },
      headers: hdr,
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe(firstBody.id);

    // Same key + DIFFERENT body → 409 IDEMPOTENCY_CONFLICT.
    const conflict = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      body: { scopes: ['org:read'] },
      headers: hdr,
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');

    // Exactly ONE key persisted for this org.
    const keys = await (
      await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
        headers: { authorization: `Bearer ${orgToken}` },
      })
    ).json();
    expect(keys.keys.length).toBe(1);
  });

  it('a cross-tenant Idempotency-Key reuse MISSES (tenant-scoped lookup)', async () => {
    const ta = await registerUser('idem-a@example.com');
    const orgA = await createOrg(ta, 'IdemA');
    const tokenA = await switchOrg(ta, orgA);
    const tb = await registerUser('idem-b@example.com');
    const orgB = await createOrg(tb, 'IdemB');
    const tokenB = await switchOrg(tb, orgB);

    const sharedKey = 'shared-idem-key';
    const a = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgA}/api-keys`, {
      body: { scopes: ['agent:run'] },
      headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': sharedKey },
    });
    expect(a.status).toBe(201);
    // Org B uses the SAME idempotency key — it must MISS (tenant-scoped) and mint a NEW key (201),
    // not replay org A's snapshot.
    const b = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgB}/api-keys`, {
      body: { scopes: ['agent:run'] },
      headers: { authorization: `Bearer ${tokenB}`, 'idempotency-key': sharedKey },
    });
    expect(b.status).toBe(201);
    expect((await b.json()).id).not.toBe((await a.json()).id);
  });
});

describe('CSRF: a cookie-only request to a mutating endpoint is rejected', () => {
  it('POST /v1/orgs with NO Bearer (cookie principal only) → 403', async () => {
    // Register to get a cookie session, then attempt to create an org with ONLY the cookie.
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'cookieonly@example.com', password: 'a-long-enough-password' },
    });
    let cookie = '';
    for (const sc of reg.headers.getSetCookie?.() ?? []) {
      if (sc.startsWith('__Host-rayspec_refresh=')) cookie = sc.split(';')[0] ?? '';
    }
    const res = await jsonRequest(h.app, 'POST', '/v1/orgs', {
      body: { name: 'CookieCo' },
      headers: { cookie },
    });
    // The cookie authenticates the principal, but a mutating endpoint REQUIRES a Bearer → 403.
    expect(res.status).toBe(403);
  });
});

describe('member-change route + last-owner invariant', () => {
  /** Seed a second ACTIVE membership for a fresh user in `orgId` with `role`; returns the userId. */
  async function seedMember(orgId: string, email: string, role: string): Promise<string> {
    const rows = (await h.db.$client.unsafe(
      `INSERT INTO rayspec_test_apiauth_orgs.users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [email],
    )) as unknown as { id: string }[];
    const userId = rows[0]?.id as string;
    await h.db.$client.unsafe(
      `INSERT INTO rayspec_test_apiauth_orgs.memberships (org_id, user_id, role, status)
         VALUES ($1, $2, $3, 'active')`,
      [orgId, userId, role],
    );
    return userId;
  }

  it('owner changes a member’s role; the change persists', async () => {
    const t0 = await registerUser('mc-owner@example.com');
    const orgId = await createOrg(t0, 'MemberChangeCo');
    const ownerToken = await switchOrg(t0, orgId);
    const memberId = await seedMember(orgId, 'mc-member@example.com', 'member');

    const res = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/members/${memberId}/role`, {
      body: { role: 'admin' },
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(200);
    const role = (await h.db.$client.unsafe(
      `SELECT role FROM rayspec_test_apiauth_orgs.memberships WHERE org_id = $1 AND user_id = $2`,
      [orgId, memberId],
    )) as unknown as { role: string }[];
    expect(role[0]?.role).toBe('admin');
  });

  it('demoting the LAST owner is blocked → 409 (invariant)', async () => {
    const t0 = await registerUser('lastowner@example.com');
    const orgId = await createOrg(t0, 'LastOwnerCo');
    const ownerToken = await switchOrg(t0, orgId);
    // The creator is the sole owner. Find their userId.
    const me = await (
      await jsonRequest(h.app, 'GET', '/v1/auth/me', {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).json();
    const res = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/members/${me.userId}/role`, {
      body: { role: 'member' },
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(409);
    // Still an owner (the demotion did not apply).
    const role = (await h.db.$client.unsafe(
      `SELECT role FROM rayspec_test_apiauth_orgs.memberships WHERE org_id = $1 AND user_id = $2`,
      [orgId, me.userId],
    )) as unknown as { role: string }[];
    expect(role[0]?.role).toBe('owner');
  });

  it('removing the LAST owner is blocked → 409; removing a non-last member succeeds → 204', async () => {
    const t0 = await registerUser('rm-owner@example.com');
    const orgId = await createOrg(t0, 'RemoveCo');
    const ownerToken = await switchOrg(t0, orgId);
    const me = await (
      await jsonRequest(h.app, 'GET', '/v1/auth/me', {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).json();
    // Removing the sole owner → 409.
    const rmOwner = await jsonRequest(h.app, 'DELETE', `/v1/orgs/${orgId}/members/${me.userId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(rmOwner.status).toBe(409);

    // A second (member) user CAN be removed → 204, and the live-membership check then denies them.
    const memberId = await seedMember(orgId, 'rm-member@example.com', 'member');
    const rmMember = await jsonRequest(h.app, 'DELETE', `/v1/orgs/${orgId}/members/${memberId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(rmMember.status).toBe(204);
    const remaining = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS n FROM rayspec_test_apiauth_orgs.memberships
         WHERE org_id = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL`,
      [orgId, memberId],
    )) as unknown as { n: number }[];
    expect(remaining[0]?.n).toBe(0);
  });

  it('an admin (not the JWT claim — LIVE) may change roles; a demoted-to-member caller is denied within TTL', async () => {
    const t0 = await registerUser('mc-authz@example.com');
    const orgId = await createOrg(t0, 'MCAuthzCo');
    const ownerToken = await switchOrg(t0, orgId);
    const me = await (
      await jsonRequest(h.app, 'GET', '/v1/auth/me', {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).json();
    const memberId = await seedMember(orgId, 'mc-victim@example.com', 'member');
    // Demote the OWNER (caller) to member out-of-band — the JWT still says owner, but the LIVE
    // check (org:member:change is sensitive) must deny.
    await h.db.$client.unsafe(
      `UPDATE rayspec_test_apiauth_orgs.memberships SET role = 'member' WHERE org_id = $1 AND user_id = $2`,
      [orgId, me.userId],
    );
    const res = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/members/${memberId}/role`, {
      body: { role: 'admin' },
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(403); // member lacks org:member:change (live check, claim not trusted)
  });

  it('UNIQUE(user_id, org_id) is enforced (no duplicate membership)', async () => {
    const t0 = await registerUser('uniq@example.com');
    const orgId = await createOrg(t0, 'UniqCo');
    const me = await (
      await jsonRequest(h.app, 'GET', '/v1/auth/me', {
        headers: { authorization: `Bearer ${await switchOrg(t0, orgId)}` },
      })
    ).json();
    // A second membership for the SAME (user, org) violates the unique index → throws.
    await expect(
      h.db.$client.unsafe(
        `INSERT INTO rayspec_test_apiauth_orgs.memberships (org_id, user_id, role, status)
           VALUES ($1, $2, 'member', 'active')`,
        [orgId, me.userId],
      ),
    ).rejects.toThrow();
  });
});

describe('membership invariants', () => {
  it('GET /v1/orgs lists only the caller’s orgs', async () => {
    const ta = await registerUser('list-a@example.com');
    const orgA = await createOrg(ta, 'ListA');
    const tb = await registerUser('list-b@example.com');
    await createOrg(tb, 'ListB');

    const aOrgs = await (
      await jsonRequest(h.app, 'GET', '/v1/orgs', { headers: { authorization: `Bearer ${ta}` } })
    ).json();
    expect(aOrgs.orgs.length).toBe(1);
    expect(aOrgs.orgs[0].id).toBe(orgA);
    expect(aOrgs.orgs[0].role).toBe('owner');
  });
});
