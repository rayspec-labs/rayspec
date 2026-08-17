/**
 * integration tests — a refreshed access token carries the SAME `mship_role` claim the
 * login token carries, on BOTH refresh paths (the normal rotation and the grace-window
 * double-submit re-issue). Without the role claim, every claim-trusted permission
 * (`org:read`, `store:read`, …) answers 403 after the first refresh while the SENSITIVE
 * permissions (live-membership recheck) keep working — an inverted state where writes
 * succeed and reads fail. Regression tests for #311.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REFRESH_COOKIE_NAME } from '../http/cookies.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

let h: Harness;

beforeAll(async () => {
  // Fake clock: the grace-window double-submit is driven deterministically (advance within the
  // 30ms harness grace), never a wall-clock sleep.
  h = await createHarness({ schema: 'rayspec_test_apiauth_refresh_role', useFakeClock: true });
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

/** Pull the refresh cookie value out of a Set-Cookie header. */
function refreshFromSetCookie(res: Response): string | undefined {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    if (sc.startsWith(`${REFRESH_COOKIE_NAME}=`)) {
      const v = sc.slice(REFRESH_COOKIE_NAME.length + 1).split(';')[0];
      return v && v.length > 0 ? v : undefined;
    }
  }
  return undefined;
}

/** Decode a JWT's payload (claims) — no signature verification; the wire-claim names. */
function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

/** Register a user WITH a first org (owner) → the org-scoped token + orgId + refresh cookie. */
async function registerWithOrg(
  email: string,
): Promise<{ accessToken: string; orgId: string; refreshSecret: string }> {
  const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-very-long-password', orgName: 'Refresh Role Test Org' },
  });
  expect(reg.status).toBe(201);
  const body = await reg.json();
  const refreshSecret = refreshFromSetCookie(reg) as string;
  expect(refreshSecret).toBeTruthy();
  return { accessToken: body.accessToken, orgId: body.activeOrgId, refreshSecret };
}

/** POST /v1/auth/refresh with the cookie-sourced secret (same-origin). */
async function refresh(secret: string): Promise<Response> {
  return jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
    headers: { cookie: `${REFRESH_COOKIE_NAME}=${secret}`, 'sec-fetch-site': 'same-origin' },
  });
}

describe('refresh preserves the mship_role claim (rotation path)', () => {
  it('decode(refreshedToken).mship_role === decode(loginToken).mship_role', async () => {
    await registerWithOrg('refresh-role-decode@example.com');
    // Login (sole active org → the token carries the live role) + its refresh cookie.
    const login = await jsonRequest(h.app, 'POST', '/v1/auth/login', {
      body: { email: 'refresh-role-decode@example.com', password: 'a-very-long-password' },
    });
    expect(login.status).toBe(200);
    const loginToken = (await login.json()).accessToken as string;
    const r0 = refreshFromSetCookie(login) as string;

    const ref = await refresh(r0);
    expect(ref.status).toBe(200);
    const refreshedToken = (await ref.json()).accessToken as string;

    const loginClaims = decodeClaims(loginToken);
    expect(loginClaims.mship_role).toBe('owner');
    expect(decodeClaims(refreshedToken).mship_role).toBe(loginClaims.mship_role);
  });

  it('a claim-trusted read answers 200 after refresh; a sensitive write works before AND after', async () => {
    const {
      accessToken: t0,
      orgId,
      refreshSecret: r0,
    } = await registerWithOrg('refresh-role-split@example.com');

    // Controls BEFORE the refresh: the claim-trusted read (org:read) and the sensitive write
    // (apikey:mint — live-membership recheck) both work on the login-time token.
    const readBefore = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/members`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    expect(readBefore.status).toBe(200);
    const writeBefore = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${t0}` },
      body: {},
    });
    expect(writeBefore.status).toBe(201);

    const ref = await refresh(r0);
    expect(ref.status).toBe(200);
    const t1 = (await ref.json()).accessToken as string;

    // The sensitive write keeps working on the refreshed token (live recheck — the accept control).
    const writeAfter = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${t1}` },
      body: {},
    });
    expect(writeAfter.status).toBe(201);

    // The claim-trusted read must ALSO keep working — without the role claim this was the
    // inverted 403 (writes succeed, reads fail).
    const readAfter = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/members`, {
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(readAfter.status).toBe(200);
  });
});

describe('refresh preserves the mship_role claim (grace-window double-submit path)', () => {
  it('the re-issued token carries the role claim and claim-trusted reads answer 200', async () => {
    const {
      accessToken: t0,
      orgId,
      refreshSecret: r0,
    } = await registerWithOrg('refresh-role-grace@example.com');

    // First rotation, then re-present r0 strictly INSIDE the 30ms harness grace window (a benign
    // double-submit) — the re-issue path mints from the replacement row.
    const ref1 = await refresh(r0);
    expect(ref1.status).toBe(200);
    h.clock?.advance(10);
    const ref1b = await refresh(r0);
    expect(ref1b.status).toBe(200);
    const graceToken = (await ref1b.json()).accessToken as string;

    // The sensitive write works on the grace-issued token (live recheck — the accept control).
    const write = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      headers: { authorization: `Bearer ${graceToken}` },
      body: {},
    });
    expect(write.status).toBe(201);

    // The grace-issued token carries the SAME role claim the registration token carries …
    expect(decodeClaims(graceToken).mship_role).toBe(decodeClaims(t0).mship_role);

    // … so the claim-trusted read keeps answering 200.
    const read = await jsonRequest(h.app, 'GET', `/v1/orgs/${orgId}/members`, {
      headers: { authorization: `Bearer ${graceToken}` },
    });
    expect(read.status).toBe(200);
  });
});
