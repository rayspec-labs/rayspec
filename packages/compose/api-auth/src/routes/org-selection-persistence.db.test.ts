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
  // The injected clock, not the wall clock, drives the refresh grace window here. One test below
  // presents a ROTATED cookie and needs to be INSIDE that window; on the real clock the 30ms budget
  // is spent by the round trips themselves under load, so the test raced its own setup.
  h = await createHarness({ schema: 'rayspec_test_apiauth_orgsel', useFakeClock: true });
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

/** Register a user WITH an org in one call (the documented onboarding shape). */
async function registerWithOrg(
  email: string,
  orgName: string,
): Promise<{ token: string; refresh: string; orgId: string }> {
  const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: PASSWORD, orgName },
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return {
    token: body.accessToken as string,
    refresh: refreshFromSetCookie(res),
    orgId: body.activeOrgId as string,
  };
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

  it('switch → a NEW login for a sole-org user lands in the same org (via the login rule)', async () => {
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

  it("a cookie from ANOTHER user cannot move that user's tenant", async () => {
    // The one security property of the persistence write: the row is selected by (id AND user_id),
    // and the handler additionally refuses a session that is not the authenticated caller's. Without
    // BOTH guards, B's switch would write B's org onto A's session row — A reloads into B's tenant.
    const victim = await register('victim@example.com');
    const attacker = await register('attacker@example.com');
    const attackerOrg = await createOrg(attacker.token, 'AttackerCo');

    // Attacker's Bearer, victim's ambient cookie, switching into the attacker's OWN org.
    const res = await switchOrg(attacker.token, attackerOrg, victim.refresh);
    expect(res.status).toBe(200);

    // The victim's session is untouched: their reload still lands in no tenant.
    expect((await refresh(victim.refresh)).activeOrgId).toBeNull();
  });

  it('a switch presented with a ROTATED cookie lands on the LIVE session, not the dead one', async () => {
    // Inside the refresh grace window a client still holds the pre-rotation secret. `refresh` already
    // resolves that to the replacement row; the persistence write must land in the same place, or the
    // selection is written onto a superseded row and silently lost at the next refresh.
    const { token, refresh: r0 } = await registerWithOrg('rotate@example.com', 'RotateCo');
    const second = await createOrg(token, 'RotateTwo');
    const r1 = (await refresh(r0)).cookie; // rotates: r0's row is superseded by r1's

    // Spend part of the 30ms grace budget deliberately, on the injected clock: the arm is INSIDE the
    // window because the test says so, not because the round trips happened to be fast enough.
    h.clock?.advance(10);

    const res = await switchOrg(token, second, r0); // the OLD secret, within grace
    expect(res.status).toBe(200);

    // The LIVE session carries the choice.
    expect((await refresh(r1)).activeOrgId).toBe(second);
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

describe('a tombstoned org is absent everywhere, including on the authorization path', () => {
  it('a member of a soft-deleted org cannot switch into it', async () => {
    // Every other reader of "is this a usable tenant" filters `orgs.deleted_at`: the org list, the
    // login pre-fill, and the product boot gate. The live-membership lookup did not — and it is the
    // one the switch and the sensitive-permission re-check consult, so an erased tenant stayed
    // operable for its members while the API behaved everywhere else as if it had forgotten it.
    const { token, refresh: r0 } = await register('tombstone@example.com');
    const orgId = await createOrg(token, 'TombstoneCo');
    await switchOrg(token, orgId, r0);
    expect((await refresh(r0)).activeOrgId).toBe(orgId);

    // No shipped route tombstones an org, so the state is reached the only way it can be.
    await h.db.$client.unsafe('UPDATE orgs SET deleted_at = now() WHERE id = $1', [orgId]);

    const res = await switchOrg(token, orgId, r0);
    expect(res.status).toBe(404); // uniform not-found — no existence leak, as for a foreign org
  });
});

describe('register with an org reports a selection the session actually carries', () => {
  it('register(orgName) → the very next refresh returns that org', async () => {
    // The response advertises `activeOrgId`, so the session row must carry it: otherwise the first
    // reload after the documented onboarding call lands the user in no tenant at all.
    const { refresh: r0, orgId } = await registerWithOrg('onboard@example.com', 'OnboardCo');
    expect(orgId).toBeTruthy();
    expect((await refresh(r0)).activeOrgId).toBe(orgId);
  });
});

describe('login pre-fills the selection only when it is unambiguous', () => {
  it('a member of exactly ONE org gets it at login', async () => {
    const { token } = await register('solo@example.com');
    const orgId = await createOrg(token, 'SoloCo');

    // No switch anywhere in this flow — login alone resolves the sole membership.
    expect(await login('solo@example.com')).toBe(orgId);
  });

  it('a switch does NOT travel across sessions: a two-org user logs in to null', async () => {
    // The counterpart to the arm above, and the reason its name says "via the login rule": a fresh
    // login does not read the previous session's choice — it re-derives one, and only when the
    // answer is unambiguous. With two orgs there is no answer, so the switch does not survive.
    const { token, refresh: r0 } = await register('twoswitch@example.com');
    const first = await createOrg(token, 'TwoSwitchA');
    await createOrg(token, 'TwoSwitchB');
    await switchOrg(token, first, r0);
    expect((await refresh(r0)).activeOrgId).toBe(first); // the switch DID persist
    expect(await login('twoswitch@example.com')).toBeNull(); // ...but a new session re-derives
  });

  it('a member of TWO orgs gets null (the server never guesses a tenant)', async () => {
    const { token } = await register('dual@example.com');
    await createOrg(token, 'DualOne');
    await createOrg(token, 'DualTwo');

    expect(await login('dual@example.com')).toBeNull();
  });
});
