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
import { hashApiKey } from '@rayspec/auth-core';
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
    expect(mint.plaintext).toMatch(/^rk_.+\..+/);
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

  it('N CONCURRENT same-key+body mints → EXACTLY ONE key (reserve-before-mint, exactly-once)', async () => {
    const t0 = await registerUser('idem-conc@example.com');
    const orgId = await createOrg(t0, 'IdemConcCo');
    const orgToken = await switchOrg(t0, orgId);
    const hdr = { authorization: `Bearer ${orgToken}`, 'idempotency-key': 'idem-conc-key' };

    // Fire N same-key + same-body mints AT ONCE. A non-atomic find-then-act mint lets all N miss the
    // pre-check and each mints a DISTINCT key → multiple 201s + N api_keys rows, only one of which is
    // replayable (the exactly-once violation). With the atomic reserve-before-mint, EXACTLY ONE caller
    // wins the reservation and mints; the rest replay (200) or 409 in-progress — never a second key.
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
          body: { scopes: ['agent:run'] },
          headers: hdr,
        }),
      ),
    );
    const statuses = results.map((r) => r.status);
    const bodies = await Promise.all(results.map((r) => r.json()));

    // EXACTLY ONE 201 (the winner); every other response is a 200 replay or a 409 in-progress.
    const created = bodies.filter((_, i) => statuses[i] === 201);
    expect(created.length).toBe(1);
    expect(statuses.every((s) => s === 201 || s === 200 || s === 409)).toBe(true);
    // No two 201s carrying distinct key ids (the orphaned-second-key bug).
    expect(new Set(created.map((b) => b.id)).size).toBe(1);
    // Any 200 replay carries the SAME id as the winner (never a divergent key).
    const winnerId = created[0].id as string;
    for (let i = 0; i < N; i++) {
      if (statuses[i] === 200) expect(bodies[i].id).toBe(winnerId);
    }

    // EXACTLY ONE api_keys row for the org (the structural exactly-once guarantee).
    const keys = await (
      await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
        headers: { authorization: `Bearer ${orgToken}` },
      })
    ).json();
    expect(keys.keys.length).toBe(1);
  });

  it('reserve on the apikey:mint scope is atomic: 50 CONCURRENT reserves → EXACTLY ONE wins', async () => {
    const t0 = await registerUser('idem-stress@example.com');
    const orgId = await createOrg(t0, 'IdemStressCo');
    // A direct-store atomicity backstop for the mint path: the reserve is a single INSERT ... ON
    // CONFLICT DO NOTHING RETURNING on UNIQUE(tenant,scope,key), so exactly one of N concurrent callers
    // gets a RETURNING row. The reserved placeholder snapshot is NON-SECRET (never plaintext).
    const N = 50;
    const reservations = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        h.deps.idempotency.reserve(orgId, 'apikey:mint', 'stress-key', 'body-hash-x', {
          status: 'pending',
          candidate: i,
        }),
      ),
    );
    expect(reservations.filter((r) => r.won).length).toBe(1);
    expect(reservations.filter((r) => !r.won).length).toBe(N - 1);
    // Exactly one row physically exists.
    const rows = await h.db.$client.unsafe(
      "SELECT id FROM idempotency_keys WHERE scope = 'apikey:mint' AND idem_key = 'stress-key'",
    );
    expect(rows.length).toBe(1);
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

describe('API-key prefix: rk_ mint + permanent dual-accept', () => {
  /**
   * Seed an api-key row directly with a chosen prefix + secret (bypassing HTTP mint) so a legacy-
   * form prefix and a multi-segment secret can be exercised. Returns the presented `<prefix>.<secret>`
   * plaintext. The hash uses the same pepper the app resolves with (the suite sets it globally).
   */
  async function seedKey(
    orgId: string,
    prefix: string,
    secret: string,
    scopes: string[],
  ): Promise<string> {
    await h.deps.apiKeyStore.mint({
      orgId,
      keyPrefix: prefix,
      keyHash: hashApiKey(secret),
      scopes,
    });
    return `${prefix}.${secret}`;
  }

  it('a freshly minted key carries the rk_ prefix and authenticates a scope-guarded route', async () => {
    const t0 = await registerUser('prefix-rk@example.com');
    const orgId = await createOrg(t0, 'PrefixRkCo');
    const orgToken = await switchOrg(t0, orgId);
    const mint = await (
      await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
        body: { scopes: ['apikey:read'] },
        headers: { authorization: `Bearer ${orgToken}` },
      })
    ).json();
    expect((mint.keyPrefix as string).startsWith('rk_')).toBe(true);
    expect((mint.plaintext as string).startsWith('rk_')).toBe(true);
    // The rk_ key authenticates + is scope-authorized on the list route (never mis-routed to JWT).
    const list = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${mint.plaintext}` },
    });
    expect(list.status).toBe(200);
  });

  it('an rk_ key whose opaque secret contains a dot is resolved as an api-key, not verified as a JWT', async () => {
    // The prefix is authoritative: a bearer carrying the rk_ prefix must resolve as an api-key even
    // when its secret makes the whole credential 3 dot-separated segments (the JWT shape). Removing
    // the rk_ guard in the auth middleware routes this to JWT verification → no principal → 401, so
    // this is the guard's fail-the-fix oracle.
    const t0 = await registerUser('prefix-dot@example.com');
    const orgId = await createOrg(t0, 'PrefixDotCo');
    const cred = await seedKey(orgId, 'rk_dotcarrier', 'first.second', ['apikey:read']);
    expect(cred.split('.').length).toBe(3); // JWT-shaped segment count
    const list = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${cred}` },
    });
    expect(list.status).toBe(200); // authenticated as the api-key (guard prevents the JWT mis-route)
  });

  it('a legacy mk_-form key still authenticates (permanent dual-accept)', async () => {
    const t0 = await registerUser('prefix-mk@example.com');
    const orgId = await createOrg(t0, 'PrefixMkCo');
    const cred = await seedKey(orgId, 'mk_legacyform', 'legacy-secret-value', ['apikey:read']);
    const list = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${cred}` },
    });
    expect(list.status).toBe(200);
  });

  it('a legacy mk_ key whose opaque secret contains a dot is resolved as an api-key, not a JWT', async () => {
    // Mirror of the rk_ dotted-secret guard: an mk_-prefixed bearer whose secret makes the whole
    // credential 3 dot-separated segments (the JWT shape) must still resolve as an api-key. Removing
    // the `!bearer.startsWith('mk_')` clause in the auth middleware routes this to JWT verification →
    // no principal → 401, so this is the mk_ guard's fail-the-fix oracle (dual-accept parity with rk_).
    const t0 = await registerUser('prefix-mk-dot@example.com');
    const orgId = await createOrg(t0, 'PrefixMkDotCo');
    const cred = await seedKey(orgId, 'mk_dotcarrier', 'first.second', ['apikey:read']);
    expect(cred.split('.').length).toBe(3); // JWT-shaped segment count
    const list = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${cred}` },
    });
    expect(list.status).toBe(200); // authenticated as the api-key (guard prevents the JWT mis-route)
  });
});

describe('org membership: owner-gated add + list', () => {
  /** POST a member add; returns the raw Response so a test can assert status + body. */
  function addMember(orgId: string, token: string, email: string): Promise<Response> {
    return jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/members`, {
      body: { email },
      headers: { authorization: `Bearer ${token}` },
    });
  }

  /** Count ACTIVE memberships of a user in an org (direct DB read; the source of truth). */
  async function activeMembershipCount(orgId: string, userId: string): Promise<number> {
    const rows = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS n FROM rayspec_test_apiauth_orgs.memberships
         WHERE org_id = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL`,
      [orgId, userId],
    )) as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
  }

  /** The userId behind a token (via /v1/auth/me). */
  async function userIdOf(token: string): Promise<string> {
    const me = await (
      await jsonRequest(h.app, 'GET', '/v1/auth/me', {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    return me.userId as string;
  }

  it('owner adds an EXISTING user → 201 member; a second identical add is an idempotent no-op', async () => {
    const t0 = await registerUser('add-owner@example.com');
    const orgId = await createOrg(t0, 'AddCo');
    const ownerToken = await switchOrg(t0, orgId);
    // A pre-existing account with no membership in this org.
    const existingUserToken = await registerUser('add-existing@example.com');
    const existingUserId = await userIdOf(existingUserToken);

    const first = await addMember(orgId, ownerToken, 'add-existing@example.com');
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.role).toBe('member');
    expect(firstBody.userId).toBe(existingUserId);
    expect(firstBody.oneTimePassword).toBeUndefined(); // an existing user gets no provisioned password
    expect(await activeMembershipCount(orgId, existingUserId)).toBe(1);

    // A second identical add is idempotent: 200, still exactly ONE membership row (no duplicate).
    const second = await addMember(orgId, ownerToken, 'add-existing@example.com');
    expect(second.status).toBe(200);
    expect(await activeMembershipCount(orgId, existingUserId)).toBe(1);
  });

  it('owner adds a NEW email → user provisioned with a one-time password that actually logs in', async () => {
    const t0 = await registerUser('prov-owner@example.com');
    const orgId = await createOrg(t0, 'ProvCo');
    const ownerToken = await switchOrg(t0, orgId);

    const res = await addMember(orgId, ownerToken, 'brand-new@example.com');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.role).toBe('member');
    expect(typeof body.oneTimePassword).toBe('string');
    const otp = body.oneTimePassword as string;

    // The one-time password authenticates the freshly provisioned account.
    const login = await jsonRequest(h.app, 'POST', '/v1/auth/login', {
      body: { email: 'brand-new@example.com', password: otp },
    });
    expect(login.status).toBe(200);
    expect((await login.json()).accessToken).toBeTruthy();
  });

  it('an API-key principal is REJECTED (403) and creates no membership', async () => {
    const t0 = await registerUser('apikey-add@example.com');
    const orgId = await createOrg(t0, 'ApiKeyAddCo');
    const ownerToken = await switchOrg(t0, orgId);
    // A broadly-scoped api-key still cannot add members (org:member:add is not api-key-grantable).
    const mint = await (
      await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
        body: { scopes: ['org:read', 'store:write', 'apikey:read'] },
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).json();

    const res = await addMember(orgId, mint.plaintext as string, 'apikey-victim@example.com');
    expect(res.status).toBe(403);
    // Denied at the authorization chokepoint (org:member:add is not api-key-grantable), not merely at
    // a downstream handler guard — the missing_permission hint pins the permission gate as the layer
    // that rejected, so weakening the route's permission to an api-key-grantable one turns this red.
    const denied = await res.json();
    expect(denied.error.details.missing_permission).toBe('org:member:add');
    // No user was provisioned for the rejected request.
    const users = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS n FROM rayspec_test_apiauth_orgs.users WHERE lower(email) = $1`,
      ['apikey-victim@example.com'],
    )) as unknown as { n: number }[];
    expect(users[0]?.n).toBe(0);
  });

  it('a non-owner member is REJECTED (403)', async () => {
    const t0 = await registerUser('nonowner-owner@example.com');
    const orgId = await createOrg(t0, 'NonOwnerCo');
    const ownerToken = await switchOrg(t0, orgId);
    // Provision a plain member and let them obtain an org-scoped (role=member) token.
    const memberToken0 = await registerUser('nonowner-member@example.com');
    await addMember(orgId, ownerToken, 'nonowner-member@example.com');
    const memberToken = await switchOrg(memberToken0, orgId);

    const res = await addMember(orgId, memberToken, 'nonowner-victim@example.com');
    expect(res.status).toBe(403); // member lacks org:member:add (live check, claim not trusted)
  });

  it('cross-org isolation: an org-A owner cannot add to / list org B (resolveTenant 404s)', async () => {
    const ta = await registerUser('mem-a@example.com');
    const orgA = await createOrg(ta, 'MemOrgA');
    const tokenA = await switchOrg(ta, orgA);
    const tb = await registerUser('mem-b@example.com');
    const orgB = await createOrg(tb, 'MemOrgB');

    const crossAdd = await addMember(orgB, tokenA, 'cross-victim@example.com');
    expect(crossAdd.status).toBe(404);
    const crossList = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgB}/members`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(crossList.status).toBe(404);
  });

  it('GET lists the org’s members with their roles', async () => {
    const t0 = await registerUser('list-owner@example.com');
    const orgId = await createOrg(t0, 'ListMembersCo');
    const ownerToken = await switchOrg(t0, orgId);
    const ownerId = await userIdOf(ownerToken);
    await registerUser('list-member@example.com');
    const addRes = await addMember(orgId, ownerToken, 'list-member@example.com');
    const memberId = (await addRes.json()).userId as string;

    const list = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/members`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(list.status).toBe(200);
    const members = (await list.json()).members as {
      userId: string;
      email: string;
      role: string;
    }[];
    const byId = new Map(members.map((m) => [m.userId, m]));
    expect(byId.get(ownerId)?.role).toBe('owner');
    expect(byId.get(memberId)?.role).toBe('member');
    expect(byId.get(memberId)?.email).toBe('list-member@example.com');
  });

  it('a removed (soft-deleted) member is NOT returned by GET /members (active-only filter)', async () => {
    const t0 = await registerUser('active-only-owner@example.com');
    const orgId = await createOrg(t0, 'ActiveOnlyCo');
    const ownerToken = await switchOrg(t0, orgId);
    await registerUser('kept-member@example.com');
    await registerUser('removed-member@example.com');
    const keptId = (await (await addMember(orgId, ownerToken, 'kept-member@example.com')).json())
      .userId as string;
    const removedId = (
      await (await addMember(orgId, ownerToken, 'removed-member@example.com')).json()
    ).userId as string;

    // Soft-delete (tombstone) one member.
    const del = await jsonRequest(h.app, 'DELETE', `/v1/orgs/${orgId}/members/${removedId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(del.status).toBe(204);

    const list = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/members`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(list.status).toBe(200);
    const ids = ((await list.json()).members as { userId: string }[]).map((m) => m.userId);
    expect(ids).toContain(keptId);
    // Dropping the status='active' / deleted_at IS NULL filter in listMembers turns this RED.
    expect(ids).not.toContain(removedId);
  });

  it('adding the SAME brand-new email twice is idempotent (no duplicate user, no 500)', async () => {
    const t0 = await registerUser('idem-prov-owner@example.com');
    const orgId = await createOrg(t0, 'IdemProvCo');
    const ownerToken = await switchOrg(t0, orgId);

    const first = await addMember(orgId, ownerToken, 'idem-new@example.com');
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(typeof firstBody.oneTimePassword).toBe('string'); // provisioned once
    const newUserId = firstBody.userId as string;

    const second = await addMember(orgId, ownerToken, 'idem-new@example.com');
    expect(second.status).toBe(200); // idempotent no-op (the user now exists)
    const secondBody = await second.json();
    expect(secondBody.userId).toBe(newUserId);
    expect(secondBody.oneTimePassword).toBeUndefined(); // existing user → no OTP re-issued

    const users = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS n FROM rayspec_test_apiauth_orgs.users
         WHERE lower(email) = $1 AND deleted_at IS NULL`,
      ['idem-new@example.com'],
    )) as unknown as { n: number }[];
    expect(users[0]?.n).toBe(1);
    expect(await activeMembershipCount(orgId, newUserId)).toBe(1);
  });

  it('CONCURRENT adds of the same brand-new email provision exactly one user (no 23505/500)', async () => {
    const t0 = await registerUser('conc-prov-owner@example.com');
    const orgId = await createOrg(t0, 'ConcProvCo');
    const ownerToken = await switchOrg(t0, orgId);

    // Several concurrent adds of a NEW email: each misses findUserByEmail, then races createUser on
    // the users email-unique index → the losers hit 23505. The FIX 2 catch re-reads and proceeds as
    // the existing-user path; WITHOUT it a loser returns HTTP 500. All must be 200/201, and exactly
    // ONE user + ONE one-time password (the single provisioner that won the index).
    const email = 'conc-new@example.com';
    const results = await Promise.all(
      Array.from({ length: 5 }, () => addMember(orgId, ownerToken, email)),
    );
    for (const r of results) expect([200, 201]).toContain(r.status);
    const bodies = await Promise.all(results.map((r) => r.json()));
    const otpCount = bodies.filter((b) => typeof b.oneTimePassword === 'string').length;
    expect(otpCount).toBe(1);
    const userIds = new Set(bodies.map((b) => b.userId as string));
    expect(userIds.size).toBe(1);
    const users = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS n FROM rayspec_test_apiauth_orgs.users
         WHERE lower(email) = $1 AND deleted_at IS NULL`,
      [email],
    )) as unknown as { n: number }[];
    expect(users[0]?.n).toBe(1);
    expect(await activeMembershipCount(orgId, [...userIds][0] as string)).toBe(1);
  });
});

describe('OrgStore.addMember — atomicity + role invariants (store-level, fail-the-fix)', () => {
  const SCHEMA = 'rayspec_test_apiauth_orgs';

  /** Insert a bare user (no membership) and return its id. */
  async function seedUser(email: string): Promise<string> {
    const rows = (await h.db.$client.unsafe(
      `INSERT INTO ${SCHEMA}.users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [email],
    )) as unknown as { id: string }[];
    return rows[0]?.id as string;
  }

  /** Seed a membership row directly, optionally as a soft-deleted tombstone. */
  async function seedMembership(
    orgId: string,
    userId: string,
    role: string,
    opts: { tombstone?: boolean } = {},
  ): Promise<void> {
    if (opts.tombstone) {
      await h.db.$client.unsafe(
        `INSERT INTO ${SCHEMA}.memberships (org_id, user_id, role, status, deleted_at)
           VALUES ($1, $2, $3, 'revoked', now())`,
        [orgId, userId, role],
      );
    } else {
      await h.db.$client.unsafe(
        `INSERT INTO ${SCHEMA}.memberships (org_id, user_id, role, status)
           VALUES ($1, $2, $3, 'active')`,
        [orgId, userId, role],
      );
    }
  }

  async function membershipRow(
    orgId: string,
    userId: string,
  ): Promise<{ role: string; status: string; deleted_at: string | null } | undefined> {
    const rows = (await h.db.$client.unsafe(
      `SELECT role, status, deleted_at FROM ${SCHEMA}.memberships WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    )) as unknown as { role: string; status: string; deleted_at: string | null }[];
    return rows[0];
  }

  async function activeCount(orgId: string, userId: string): Promise<number> {
    const rows = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.memberships
         WHERE org_id = $1 AND user_id = $2 AND status = 'active' AND deleted_at IS NULL`,
      [orgId, userId],
    )) as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
  }

  /** A fresh org owned by a fresh user — returns its id. */
  async function freshOrg(name: string, ownerEmail: string): Promise<string> {
    const token = await registerUser(ownerEmail);
    return createOrg(token, name);
  }

  it('CONCURRENCY: many concurrent adds of the same fresh (user, org) all resolve; exactly one active row (no 23505/500)', async () => {
    const orgId = await freshOrg('AtomicCo', 'atomic-owner@example.com');
    const targetId = await seedUser('atomic-target@example.com');

    // Under a read-then-insert, concurrent readers all observe "no row" then INSERT → the losers
    // violate UNIQUE(user_id, org_id) → 23505 (rejected promise). The atomic upsert makes them all
    // converge. Every add must fulfill and exactly ONE active membership must remain.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => h.deps.orgStore.addMember(orgId, targetId)),
    );
    for (const r of results) expect(r.status).toBe('fulfilled');
    expect(await activeCount(orgId, targetId)).toBe(1);
  });

  it('FTF-1 reactivation: a tombstoned membership re-added is reactivated as MEMBER (anti-escalation reset)', async () => {
    const orgId = await freshOrg('ReactivateCo', 'reactivate-owner@example.com');
    const targetId = await seedUser('reactivate-target@example.com');
    // Tombstone a PRIOR OWNER membership. A naive reactivation that kept the old role would restore
    // owner; the CASE resets a reactivated tombstone to member (the privilege reset the fix asserts).
    await seedMembership(orgId, targetId, 'owner', { tombstone: true });

    const out = await h.deps.orgStore.addMember(orgId, targetId);
    expect(out.role).toBe('member'); // reset to member, NOT restored as owner
    expect(out.activated).toBe(true); // a reactivation IS an activation (→ 201 at the route)
    const row = await membershipRow(orgId, targetId);
    expect(row?.status).toBe('active');
    expect(row?.deleted_at).toBeNull();
    expect(row?.role).toBe('member');
    expect(await activeCount(orgId, targetId)).toBe(1);
  });

  it('FTF-2 no-demote: re-adding an ACTIVE owner keeps them owner (idempotent no-op, never demoted)', async () => {
    const orgId = await freshOrg('NoDemoteCo', 'nodemote-owner@example.com');
    // A SECOND active owner (so this is purely about addMember, independent of the last-owner rule).
    const secondOwnerId = await seedUser('second-owner@example.com');
    await seedMembership(orgId, secondOwnerId, 'owner');

    const out = await h.deps.orgStore.addMember(orgId, secondOwnerId);
    expect(out.role).toBe('owner'); // the CASE preserves an active row's role — NOT demoted to member
    expect(out.activated).toBe(false); // already active → idempotent no-op (→ 200 at the route)
    const row = await membershipRow(orgId, secondOwnerId);
    expect(row?.role).toBe('owner');
    expect(row?.status).toBe('active');
    expect(await activeCount(orgId, secondOwnerId)).toBe(1);
  });

  it('a sequential second add returns the idempotent row without error (fresh → member, then no-op)', async () => {
    const orgId = await freshOrg('SeqIdemCo', 'seq-idem-owner@example.com');
    const targetId = await seedUser('seq-idem-target@example.com');

    const first = await h.deps.orgStore.addMember(orgId, targetId);
    expect(first).toEqual({ role: 'member', activated: true });
    const second = await h.deps.orgStore.addMember(orgId, targetId);
    expect(second).toEqual({ role: 'member', activated: false });
    expect(await activeCount(orgId, targetId)).toBe(1);
  });
});
