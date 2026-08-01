/**
 * Integration tests — the ACTIVE-ORG SELECTION survives the credential lifecycle, driven through
 * the REAL Hono app against Postgres.
 *
 * The selection lives on `sessions.current_org_id`; `refresh` and `login` both report it back as
 * `activeOrgId`. These tests pin the two writers of that column plus the two ways it must NOT move:
 *  - `POST /v1/orgs/:orgId/switch` persists the choice on the caller's OWN session row, so a
 *    refresh (and therefore a browser reload) keeps the tenant;
 *  - `login` pre-fills it when the user is an active member of EXACTLY ONE live org — two or more
 *    is ambiguous and stays `null` (the server never guesses a tenant);
 *  - refresh ROTATION carries the value onto the replacement row;
 *  - a switch that FAILS the live-membership check writes nothing at all.
 * The last test pins the Bearer-only limit: a switch that carries no refresh cookie has no session
 * row to write and must still succeed exactly as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REFRESH_COOKIE_NAME } from '../http/cookies.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ schema: 'rayspec_test_apiauth_orgsel' });
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

const PASSWORD = 'a-sufficiently-long-password';

/** Pull the refresh secret out of a Set-Cookie header (the browser's ambient credential). */
function refreshFromSetCookie(res: Response): string {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    if (sc.startsWith(`${REFRESH_COOKIE_NAME}=`)) {
      return sc.slice(REFRESH_COOKIE_NAME.length + 1).split(';')[0] as string;
    }
  }
  throw new Error('no refresh cookie on the response');
}

/** Register a user; returns the initial Bearer token (no org yet) + the refresh cookie secret. */
async function register(email: string): Promise<{ token: string; refresh: string }> {
  const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: PASSWORD },
  });
  expect(res.status).toBe(201);
  return { token: (await res.json()).accessToken as string, refresh: refreshFromSetCookie(res) };
}

/** Create an org (owner). Bearer required — it is a mutation. */
async function createOrg(token: string, name: string): Promise<string> {
  const res = await jsonRequest(h.app, 'POST', '/v1/orgs', {
    body: { name },
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

/**
 * Switch as a BROWSER does: the Bearer access token in the header AND the httpOnly refresh cookie
 * riding along ambiently (SameSite=Strict, same-origin XHR ⇒ the browser attaches it).
 */
function switchOrg(token: string, orgId: string, refresh?: string): Promise<Response> {
  return jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(refresh ? { cookie: `${REFRESH_COOKIE_NAME}=${refresh}` } : {}),
    },
  });
}

/** Refresh on the cookie path (same-origin ⇒ the CSRF check passes). Returns the JSON body. */
async function refresh(secret: string): Promise<{ activeOrgId: string | null; cookie: string }> {
  const res = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
    headers: { cookie: `${REFRESH_COOKIE_NAME}=${secret}`, 'sec-fetch-site': 'same-origin' },
  });
  expect(res.status).toBe(200);
  return {
    activeOrgId: (await res.json()).activeOrgId as string | null,
    cookie: refreshFromSetCookie(res),
  };
}

/** Log in fresh (a brand-new session row) and return the reported active org. */
async function login(email: string): Promise<string | null> {
  const res = await jsonRequest(h.app, 'POST', '/v1/auth/login', {
    body: { email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return (await res.json()).activeOrgId as string | null;
}

describe('switch persists the selection on the session row', () => {
  it('switch → refresh keeps the org (a reload no longer drops the tenant)', async () => {
    const { token, refresh: r0 } = await register('reload@example.com');
    const orgId = await createOrg(token, 'ReloadCo');

    const switched = await switchOrg(token, orgId, r0);
    expect(switched.status).toBe(200);
    expect((await switched.json()).activeOrgId).toBe(orgId);

    // The refresh response reads `sessions.current_org_id` — the switch must have written it.
    expect((await refresh(r0)).activeOrgId).toBe(orgId);
  });

  it('switch → a NEW login for the same user keeps the org', async () => {
    const { token, refresh: r0 } = await register('relogin@example.com');
    const orgId = await createOrg(token, 'ReloginCo');
    expect((await switchOrg(token, orgId, r0)).status).toBe(200);

    // A fresh login mints a BRAND-NEW session row — the selection must survive into it.
    expect(await login('relogin@example.com')).toBe(orgId);
  });

  it('rotation carries the selection onto the replacement row (two refreshes deep)', async () => {
    const { token, refresh: r0 } = await register('rotate@example.com');
    const orgId = await createOrg(token, 'RotateCo');
    expect((await switchOrg(token, orgId, r0)).status).toBe(200);

    const first = await refresh(r0);
    expect(first.activeOrgId).toBe(orgId);
    // The second refresh rotates the REPLACEMENT row — `rotateSession` carries the value forward,
    // so the selection does not decay after the first rotation.
    expect((await refresh(first.cookie)).activeOrgId).toBe(orgId);
  });

  it('a switch that FAILS the live-membership check writes nothing', async () => {
    const victim = await register('stayer@example.com');
    const mine = await createOrg(victim.token, 'MineCo');
    expect((await switchOrg(victim.token, mine, victim.refresh)).status).toBe(200);

    // A foreign org the caller is not a live member of.
    const stranger = await register('stranger@example.com');
    const theirs = await createOrg(stranger.token, 'TheirsCo');

    const denied = await switchOrg(victim.token, theirs, victim.refresh);
    expect(denied.status).toBe(404); // cross-tenant denial, no existence leak

    // The session row still carries the ORIGINAL selection — the denied switch wrote nothing.
    expect((await refresh(victim.refresh)).activeOrgId).toBe(mine);
  });

  it('a Bearer-only switch (no refresh cookie) still succeeds — it has no session row to write', async () => {
    const { token } = await register('cli@example.com');
    const orgId = await createOrg(token, 'CliCo');

    // The cookie-less shape (a CLI/desktop client, or a cross-origin browser one this API serves
    // bearer-only): Authorization and nothing else. The persistence is a no-op, NOT an error.
    const res = await switchOrg(token, orgId);
    expect(res.status).toBe(200);
    expect((await res.json()).activeOrgId).toBe(orgId);
  });
});

describe('login pre-fills the selection only when it is unambiguous', () => {
  it('a member of exactly ONE org gets it at login', async () => {
    const { token } = await register('solo@example.com');
    const orgId = await createOrg(token, 'SoloCo');

    // No switch anywhere in this flow — login alone resolves the sole membership.
    expect(await login('solo@example.com')).toBe(orgId);
  });

  it('a member of TWO orgs gets null (the server never guesses a tenant)', async () => {
    const { token } = await register('dual@example.com');
    await createOrg(token, 'DualOne');
    await createOrg(token, 'DualTwo');

    expect(await login('dual@example.com')).toBeNull();
  });
});
