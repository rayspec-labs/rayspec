/**
 * integration tests — register/login/me/refresh/logout + CSRF + enumeration resistance,
 * driven through the REAL Hono app against Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REFRESH_COOKIE_NAME } from '../http/cookies.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ schema: 'rayspec_test_apiauth_auth' });
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

/** Whether the response sets the refresh cookie AT ALL (value irrelevant) — the
 * body path must NOT set it; the cookie path must. */
function hasRefreshSetCookie(res: Response): boolean {
  return (res.headers.getSetCookie?.() ?? []).some((sc) =>
    sc.startsWith(`${REFRESH_COOKIE_NAME}=`),
  );
}

/**
 * Assert an auth response body leaks neither the plaintext password nor its stored hash.
 *
 * The `accessToken` is an OPAQUE bearer credential — a JWT whose base64url signature is random, so it
 * can coincidentally spell a dictionary word (`hash` at ~(2/64)^4 ≈ 0.3% per token), which made a
 * blanket `JSON.stringify(body).not.toMatch(/…hash…/)` flake. Scan the real leak surface instead: the
 * NON-token fields, plus the token's DECODED claims (a JWT payload is readable, so a secret smuggled
 * into a claim IS a leak) — never the random signature. Also assert the literal password never appears,
 * so the invariant is the actual "no password / no argon2 hash", not a proxy for it.
 */
function assertNoSecretLeak(body: Record<string, unknown>, plaintextPassword: string): void {
  const { accessToken, ...rest } = body as { accessToken?: unknown };
  const restJson = JSON.stringify(rest);
  expect(restJson).not.toMatch(/password|hash|\$argon2/i);
  expect(restJson).not.toContain(plaintextPassword);
  if (typeof accessToken === 'string') {
    const claims = Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8');
    expect(claims).not.toMatch(/password|hash|\$argon2/i);
    expect(claims).not.toContain(plaintextPassword);
  }
}

describe('register / login / me happy path', () => {
  it('registers, logs in, and returns the user via /me; never leaks the password hash', async () => {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'Alice@Example.com', password: 'correct horse battery' },
    });
    expect(reg.status).toBe(201);
    const regBody = await reg.json();
    expect(regBody.accessToken).toBeTruthy();
    expect(regBody.tokenType).toBe('Bearer');
    assertNoSecretLeak(regBody, 'correct horse battery');
    // The refresh cookie is host-prefixed, HttpOnly, Secure, SameSite=Strict.
    const setCookie = reg.headers.getSetCookie?.() ?? [];
    const refreshSc = setCookie.find((s) => s.startsWith(REFRESH_COOKIE_NAME));
    expect(refreshSc).toBeTruthy();
    expect(refreshSc).toContain('HttpOnly');
    expect(refreshSc).toContain('Secure');
    expect(refreshSc).toContain('SameSite=Strict');
    expect(refreshSc).toContain('Path=/');

    const login = await jsonRequest(h.app, 'POST', '/v1/auth/login', {
      body: { email: 'alice@example.com', password: 'correct horse battery' },
    });
    expect(login.status).toBe(200);
    const loginBody = await login.json();
    assertNoSecretLeak(loginBody, 'correct horse battery');
    const token = loginBody.accessToken as string;

    const me = await jsonRequest(h.app, 'GET', '/v1/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const meBody = await me.json();
    expect(meBody.email).toBe('alice@example.com');
    expect(meBody.memberships).toEqual([]);
    assertNoSecretLeak(meBody, 'correct horse battery');
  });

  it('collapses confusable/whitespace email variants to one row (register-then-login)', async () => {
    await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'bob@example.com', password: 'a-very-long-password' },
    });
    // A fullwidth-variant email NFKC-folds to the same address → duplicate → CONFLICT.
    const dup = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'ＢＯＢ@example.com', password: 'another-long-password' },
    });
    expect(dup.status).toBe(409);
  });
});

describe('request-body byte cap (413 before any side effect)', () => {
  it('rejects an over-cap register/login body with a 413 PAYLOAD_TOO_LARGE envelope', async () => {
    // A tiny cap makes an ordinary auth body exceed it — the read is bounded BEFORE the argon2id work.
    const capped = await createHarness({
      schema: 'rayspec_test_apiauth_bodycap',
      maxJsonBodyBytes: 16,
    });
    try {
      const reg = await jsonRequest(capped.app, 'POST', '/v1/auth/register', {
        body: { email: 'toobig@example.com', password: 'a-very-long-password-way-over-16-bytes' },
      });
      expect(reg.status).toBe(413);
      expect((await reg.json()).error.code).toBe('PAYLOAD_TOO_LARGE');

      const login = await jsonRequest(capped.app, 'POST', '/v1/auth/login', {
        body: { email: 'toobig@example.com', password: 'a-very-long-password-way-over-16-bytes' },
      });
      expect(login.status).toBe(413);
      expect((await login.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
    } finally {
      await capped.close();
    }
  });
});

describe('user-enumeration resistance', () => {
  it('login(unknown email) and login(wrong password) are indistinguishable (status + envelope)', async () => {
    await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'carol@example.com', password: 'the-right-password' },
    });
    const unknown = await jsonRequest(h.app, 'POST', '/v1/auth/login', {
      body: { email: 'nobody@example.com', password: 'whatever-password' },
    });
    const wrong = await jsonRequest(h.app, 'POST', '/v1/auth/login', {
      body: { email: 'carol@example.com', password: 'the-wrong-password' },
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const ub = await unknown.json();
    const wb = await wrong.json();
    expect(ub.error.code).toBe('UNAUTHENTICATED');
    expect(wb.error.code).toBe('UNAUTHENTICATED');
    expect(ub.error.message).toBe(wb.error.message);
  });

  it('register(existing email) returns a generic CONFLICT, not a distinct existence signal', async () => {
    await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'dave@example.com', password: 'password-one-here' },
    });
    const again = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'dave@example.com', password: 'password-two-here' },
    });
    expect(again.status).toBe(409);
  });
});

describe('refresh rotation + family-bound reuse-detection', () => {
  it('rotates twice (chain ok) and yields fresh tokens each time', async () => {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'erin@example.com', password: 'erin-password-123' },
    });
    const r0 = refreshFromSetCookie(reg) as string;
    expect(r0).toBeTruthy();

    const ref1 = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${r0}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(ref1.status).toBe(200);
    const r1 = refreshFromSetCookie(ref1) as string;
    expect(r1).toBeTruthy();
    expect(r1).not.toBe(r0);

    const ref2 = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${r1}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(ref2.status).toBe(200);
    const r2 = refreshFromSetCookie(ref2) as string;
    expect(r2).not.toBe(r1);
  });

  it('a FOREIGN/unknown refresh secret is rejected WITHOUT touching state (no confused-deputy revoke)', async () => {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'grace@example.com', password: 'grace-password-12' },
    });
    const good = refreshFromSetCookie(reg) as string;
    // Present a totally unknown secret.
    const foreign = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
      headers: {
        cookie: `${REFRESH_COOKIE_NAME}=not-a-real-secret`,
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(foreign.status).toBe(401);
    // grace's real token still works (the unknown token did not revoke her family).
    const stillGood = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${good}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(stillGood.status).toBe(200);
  });

  // The grace-window boundary is exercised over a DETERMINISTIC injected clock (harness.clock)
  // instead of a wall-clock sleep: a real elapsed-time delta between the rotate and the replay flakes
  // under CI CPU load (a benign double-submit could exceed the 30ms harness grace and false-trip the
  // reuse lockout). These still drive the REAL auth-service refresh/replay path end-to-end — only the
  // TIME source is controlled.
  describe('grace window (deterministic injected clock)', () => {
    let gh: Harness;
    beforeAll(async () => {
      gh = await createHarness({ schema: 'rayspec_test_apiauth_auth_grace', useFakeClock: true });
    });
    beforeEach(async () => {
      await gh.reset();
    });
    afterAll(async () => {
      await gh.close();
    });

    it('replaying an ALREADY-rotated token (beyond grace) revokes the family + 401 + audit + lock', async () => {
      const reg = await jsonRequest(gh.app, 'POST', '/v1/auth/register', {
        body: { email: 'frank@example.com', password: 'frank-password-12' },
      });
      const r0 = refreshFromSetCookie(reg) as string;
      // Rotate once → r0 is now rotated (rotatedAt is stamped from the injected clock).
      const ref1 = await jsonRequest(gh.app, 'POST', '/v1/auth/refresh', {
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${r0}`, 'sec-fetch-site': 'same-origin' },
      });
      const r1 = refreshFromSetCookie(ref1) as string;
      expect(ref1.status).toBe(200);

      // Advance the clock WELL past the 30ms grace window, then REPLAY the old r0 → reuse detected.
      gh.clock?.advance(1000);
      const replay = await jsonRequest(gh.app, 'POST', '/v1/auth/refresh', {
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${r0}`, 'sec-fetch-site': 'same-origin' },
      });
      // Reuse → 401.
      expect(replay.status).toBe(401);

      // The reuse triggered the per-source anti-DoS lock: an immediate refresh is 429 (locked).
      const locked = await jsonRequest(gh.app, 'POST', '/v1/auth/refresh', {
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${r1}`, 'sec-fetch-site': 'same-origin' },
      });
      expect(locked.status).toBe(429);

      // Clear ONLY the rate-limit lock (not the DB) and prove the FAMILY itself is genuinely
      // revoked — r1 (the latest good token) is now 401, not merely rate-limited.
      gh.deps.rateLimiter.clearAll();
      const afterRevoke = await jsonRequest(gh.app, 'POST', '/v1/auth/refresh', {
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${r1}`, 'sec-fetch-site': 'same-origin' },
      });
      expect(afterRevoke.status).toBe(401);

      // An audit row recorded the reuse.
      const audits = await gh.db.$client.unsafe(
        `SELECT event FROM rayspec_test_apiauth_auth_grace.auth_audit WHERE event = 'refresh_reuse_detected'`,
      );
      expect((audits as unknown as unknown[]).length).toBeGreaterThan(0);
    });

    it('a benign concurrent double-submit within the grace window does NOT lock out', async () => {
      const reg = await jsonRequest(gh.app, 'POST', '/v1/auth/register', {
        body: { email: 'heidi@example.com', password: 'heidi-password-1' },
      });
      const r0 = refreshFromSetCookie(reg) as string;
      // First rotation.
      const ref1 = await jsonRequest(gh.app, 'POST', '/v1/auth/refresh', {
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${r0}`, 'sec-fetch-site': 'same-origin' },
      });
      expect(ref1.status).toBe(200);
      // Advance the injected clock 10ms — strictly INSIDE the 30ms harness grace window — then
      // re-present r0 → still a benign re-issue (no rotation, no family revoke, no lock). This gives
      // the test a POSITIVE window-width delta: if the grace window ever collapses (graceMs→0 or
      // `<=`→`<`), this re-submit would correctly go 401 instead of 200. Deterministic: the injected
      // clock controls the delta, zero wall-clock dependence.
      gh.clock?.advance(10);
      const ref1b = await jsonRequest(gh.app, 'POST', '/v1/auth/refresh', {
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${r0}`, 'sec-fetch-site': 'same-origin' },
      });
      expect(ref1b.status).toBe(200);
    });
  });
});

describe('CSRF on cookie-authenticated endpoints', () => {
  it('rejects a cross-site form POST to /refresh (Sec-Fetch-Site: cross-site, no allowlisted Origin)', async () => {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'ivan@example.com', password: 'ivan-password-12' },
    });
    const r0 = refreshFromSetCookie(reg) as string;
    const cross = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
      headers: {
        cookie: `${REFRESH_COOKIE_NAME}=${r0}`,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
    });
    expect(cross.status).toBe(403);
  });

  it('accepts a same-origin refresh and an allowlisted Origin', async () => {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'judy@example.com', password: 'judy-password-12' },
    });
    const r0 = refreshFromSetCookie(reg) as string;
    const allow = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
      headers: {
        cookie: `${REFRESH_COOKIE_NAME}=${r0}`,
        'sec-fetch-site': 'cross-site',
        origin: 'https://app.rayspec.test',
      },
    });
    expect(allow.status).toBe(200);
  });
});

describe('logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'ken@example.com', password: 'ken-password-123' },
    });
    const r0 = refreshFromSetCookie(reg) as string;
    const out = await jsonRequest(h.app, 'POST', '/v1/auth/logout', {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${r0}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(out.status).toBe(204);
    // The session is revoked → refresh now 401.
    const after = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${r0}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(after.status).toBe(401);
  });

  it('a benign post-logout stale-cookie refresh is a uniform 401 — NOT classified as reuse', async () => {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'leo@example.com', password: 'leo-password-1234' },
    });
    const r0 = refreshFromSetCookie(reg) as string;
    await jsonRequest(h.app, 'POST', '/v1/auth/logout', {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${r0}`, 'sec-fetch-site': 'same-origin' },
    });

    // The (now logged-out) client's leftover cookie refreshes → uniform 401, NO reuse handling.
    const stale = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${r0}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(stale.status).toBe(401);

    // NO refresh_reuse_detected audit row was written (logout != theft); the per-test reset means
    // any such row would be from THIS flow.
    const reuseRows = (await h.db.$client.unsafe(
      `SELECT id FROM rayspec_test_apiauth_auth.auth_audit WHERE event = 'refresh_reuse_detected'`,
    )) as unknown as unknown[];
    expect(reuseRows.length).toBe(0);

    // And the per-source anti-DoS lock did NOT fire — an immediate (valid) subsequent attempt
    // is rejected with a uniform 401, never a 429 lock.
    const again = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${r0}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(again.status).toBe(401);
    expect(again.status).not.toBe(429);
  });
});

describe('JWKS endpoint', () => {
  it('serves the first-party public JWKS', async () => {
    const res = await jsonRequest(h.app, 'GET', '/v1/oauth/jwks');
    expect(res.status).toBe(200);
    const jwks = await res.json();
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);
    // No private-key components in the published JWKS.
    expect(JSON.stringify(jwks)).not.toMatch(/"d":/);
    // The cacheable verification-key header SURVIVES securityHeaders (which must not clobber a
    // deliberate route Cache-Control) — resource servers cache the JWKS rather than refetch it
    // on every token verify.
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('a normal (non-JWKS) endpoint still gets the no-store default', async () => {
    // /v1/auth/me with no credential → 401, but securityHeaders still applies the no-store default
    // for any route that does NOT set its own Cache-Control.
    const res = await jsonRequest(h.app, 'GET', '/v1/auth/me');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('WorkOS SSO stub', () => {
  it('returns 501 NOT_IMPLEMENTED and performs no partial auth', async () => {
    const res = await jsonRequest(h.app, 'POST', '/v1/oauth/sso/workos', { body: {} });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_IMPLEMENTED');
  });
});

describe('access-token expiresIn reflects the configured TTL (TTL)', () => {
  it('the DEFAULT harness reports expiresIn=480 (8min) on register + login', async () => {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email: 'ttl-default@example.com', password: 'a-very-long-password' },
    });
    expect(reg.status).toBe(201);
    expect((await reg.json()).expiresIn).toBe(480);

    const login = await jsonRequest(h.app, 'POST', '/v1/auth/login', {
      body: { email: 'ttl-default@example.com', password: 'a-very-long-password' },
    });
    expect(login.status).toBe(200);
    expect((await login.json()).expiresIn).toBe(480);
  });

  it('a harness with a CUSTOM TTL (3600) reports expiresIn=3600 on register + login', async () => {
    const custom = await createHarness({
      schema: 'rayspec_test_apiauth_auth_ttl',
      accessTokenTtlSeconds: 3600,
    });
    try {
      const reg = await jsonRequest(custom.app, 'POST', '/v1/auth/register', {
        body: { email: 'ttl-custom@example.com', password: 'a-very-long-password' },
      });
      expect(reg.status).toBe(201);
      expect((await reg.json()).expiresIn).toBe(3600);

      const login = await jsonRequest(custom.app, 'POST', '/v1/auth/login', {
        body: { email: 'ttl-custom@example.com', password: 'a-very-long-password' },
      });
      expect(login.status).toBe(200);
      expect((await login.json()).expiresIn).toBe(3600);
    } finally {
      await custom.close();
    }
  });
});

describe('gated + opt-in body delivery of the rotated refresh secret', () => {
  // INV-1 uses the DEFAULT (gate-OFF) harness `h` — opting in must change NOTHING.
  it('INV-1 default-OFF: opting in on a DISABLED deployment yields NO body secret + the cookie IS set', async () => {
    const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: {
        email: 'br-off@example.com',
        password: 'a-very-long-password',
        deliverRefreshTokenInBody: true, // opt-in IGNORED because the operator gate is off
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // The secret must NEVER appear in the body when the gate is OFF (fail-the-fix: if default-OFF
    // ever leaks the secret, this goes red).
    expect(body.refreshToken).toBeUndefined();
    // Byte-posture preserved: the host-prefixed refresh cookie is still set, exactly as today.
    expect(hasRefreshSetCookie(res)).toBe(true);
    expect(refreshFromSetCookie(res)).toBeTruthy();
  });

  describe('with the operator gate ENABLED', () => {
    const SCHEMA = 'rayspec_test_apiauth_bodyrefresh';
    let be: Harness;
    beforeAll(async () => {
      be = await createHarness({ schema: SCHEMA, bodyRefreshEnabled: true });
    });
    beforeEach(async () => {
      await be.reset();
    });
    afterAll(async () => {
      await be.close();
    });

    /** Register a user on the enabled harness (NO opt-in) so subsequent logins can run. */
    async function register(email: string): Promise<void> {
      const reg = await jsonRequest(be.app, 'POST', '/v1/auth/register', {
        body: { email, password: 'a-very-long-password' },
      });
      expect(reg.status).toBe(201);
    }

    it('INV-2 browser-never: ENABLED but NOT opted in ⇒ NO body secret; the cookie is set (browser flow)', async () => {
      const reg = await jsonRequest(be.app, 'POST', '/v1/auth/register', {
        body: { email: 'br-browser@example.com', password: 'a-very-long-password' },
      });
      expect(reg.status).toBe(201);
      const body = await reg.json();
      // A browser flow never sets the opt-in field → it must never receive the secret in the body.
      expect(body.refreshToken).toBeUndefined();
      expect(hasRefreshSetCookie(reg)).toBe(true);
    });

    it('body round-trip: login(opt-in) returns the secret in the body + NO cookie; refresh(body) rotates it', async () => {
      await register('br-roundtrip@example.com');

      // Login with opt-in → the rotated secret in the body, NO Set-Cookie (one channel).
      const login = await jsonRequest(be.app, 'POST', '/v1/auth/login', {
        body: {
          email: 'br-roundtrip@example.com',
          password: 'a-very-long-password',
          deliverRefreshTokenInBody: true,
        },
      });
      expect(login.status).toBe(200);
      const lb = await login.json();
      const s0 = lb.refreshToken as string;
      expect(s0).toBeTruthy();
      expect(hasRefreshSetCookie(login)).toBe(false); // body-only: the secret is NOT in a cookie

      // Refresh by the BODY (no cookie header at all) → 200 + a NEW rotated secret in the body.
      const ref = await jsonRequest(be.app, 'POST', '/v1/auth/refresh', {
        body: { refreshToken: s0, deliverRefreshTokenInBody: true },
      });
      expect(ref.status).toBe(200);
      const rb = await ref.json();
      const s1 = rb.refreshToken as string;
      expect(s1).toBeTruthy();
      expect(s1).not.toBe(s0); // rotated
      expect(hasRefreshSetCookie(ref)).toBe(false);
    });

    // INV-3 crosses the grace boundary via the BODY path, so — like the cookie-path grace tests — it
    // runs on a DETERMINISTIC injected clock (advance past grace) rather than a wall-clock sleep.
    describe('reuse beyond grace via the body path (deterministic injected clock)', () => {
      const GRACE_SCHEMA = 'rayspec_test_apiauth_bodyrefresh_grace';
      let ge: Harness;
      beforeAll(async () => {
        ge = await createHarness({
          schema: GRACE_SCHEMA,
          bodyRefreshEnabled: true,
          useFakeClock: true,
        });
      });
      beforeEach(async () => {
        await ge.reset();
      });
      afterAll(async () => {
        await ge.close();
      });

      it('INV-3 reuse-via-body: replaying a stale body secret beyond grace ⇒ family revoked + 401 + audit', async () => {
        const reg = await jsonRequest(ge.app, 'POST', '/v1/auth/register', {
          body: { email: 'br-reuse@example.com', password: 'a-very-long-password' },
        });
        expect(reg.status).toBe(201);
        const login = await jsonRequest(ge.app, 'POST', '/v1/auth/login', {
          body: {
            email: 'br-reuse@example.com',
            password: 'a-very-long-password',
            deliverRefreshTokenInBody: true,
          },
        });
        const s0 = (await login.json()).refreshToken as string;
        expect(s0).toBeTruthy();

        // Rotate s0 → s1 via the body path.
        const ref1 = await jsonRequest(ge.app, 'POST', '/v1/auth/refresh', {
          body: { refreshToken: s0, deliverRefreshTokenInBody: true },
        });
        expect(ref1.status).toBe(200);
        const s1 = (await ref1.json()).refreshToken as string;
        expect(s1).toBeTruthy();

        // Advance the clock past the (30ms harness) grace window, then REPLAY the stale s0 → reuse.
        ge.clock?.advance(1000);
        const replay = await jsonRequest(ge.app, 'POST', '/v1/auth/refresh', {
          body: { refreshToken: s0, deliverRefreshTokenInBody: true },
        });
        expect(replay.status).toBe(401);

        // The family is genuinely revoked: s1 (the latest good secret) is now 401 too — clear ONLY the
        // per-source anti-DoS lock first so this asserts the DB revoke, not merely a rate-limit.
        ge.deps.rateLimiter.clearAll();
        const afterRevoke = await jsonRequest(ge.app, 'POST', '/v1/auth/refresh', {
          body: { refreshToken: s1, deliverRefreshTokenInBody: true },
        });
        expect(afterRevoke.status).toBe(401);

        // A reuse audit row was written (via the BODY path) — and it carries no secret in ANY column
        // (INV-4: the secret never lands in an audit row, not just the `meta` column).
        const audits = (await ge.db.$client.unsafe(
          `SELECT row_to_json(auth_audit) AS r FROM ${GRACE_SCHEMA}.auth_audit WHERE event = 'refresh_reuse_detected'`,
        )) as unknown as { r: unknown }[];
        expect(audits.length).toBeGreaterThan(0);
        expect(JSON.stringify(audits)).not.toContain(s0);
        expect(JSON.stringify(audits)).not.toContain(s1);
      });
    });

    it('BL-1 cookie-sourced refresh never body-delivers: a browser POSTing the httpOnly cookie + opt-in keeps the secret on the cookie', async () => {
      // Register WITHOUT opt-in → the user gets a Set-Cookie (the browser flow).
      const reg = await jsonRequest(be.app, 'POST', '/v1/auth/register', {
        body: { email: 'br-cookie-xss@example.com', password: 'a-very-long-password' },
      });
      expect(reg.status).toBe(201);
      const cookieSecret = refreshFromSetCookie(reg) as string;
      expect(cookieSecret).toBeTruthy();

      // Simulate a browser XSS: the httpOnly cookie auto-attaches; the forged body sets the opt-in
      // flag but presents NO refreshToken in the body. The secret is COOKIE-sourced → must NOT be
      // body-delivered (fail-the-fix: drop the `bodySecret !== undefined` guard and the rotated
      // secret leaks into the JS-readable body + Set-Cookie is skipped → cookie desync).
      const ref = await jsonRequest(be.app, 'POST', '/v1/auth/refresh', {
        headers: {
          cookie: `${REFRESH_COOKIE_NAME}=${cookieSecret}`,
          'sec-fetch-site': 'same-origin',
        },
        body: { deliverRefreshTokenInBody: true },
      });
      expect(ref.status).toBe(200);
      const rb = await ref.json();
      // The secret stayed httpOnly — never echoed into the JS-readable body.
      expect(rb.refreshToken).toBeUndefined();
      // The rotated secret was delivered on the cookie (today's behavior preserved — no desync).
      expect(hasRefreshSetCookie(ref)).toBe(true);
      expect(refreshFromSetCookie(ref)).toBeTruthy();
    });
  });
});
