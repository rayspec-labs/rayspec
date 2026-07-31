/**
 * Declared-route throttling — the tier decision falls AFTER the credential is validated.
 *
 * A fronting reverse proxy can only see WHETHER an `Authorization` header is present, never whether
 * the credential inside it validates. Tiering a throttle there is therefore forgeable: arbitrary junk
 * in the header buys the generous bucket and switches the protection off. The tier this suite pins
 * sits in the backend, behind the global `authenticate` middleware, so the question it asks is "did
 * this credential actually validate", not "was a header sent".
 *
 * What it proves, on the REAL declared-route chain:
 *  1. a FORGED credential — in BOTH shapes `authenticate` distinguishes, a junk three-segment
 *     JWT-looking bearer and a junk opaque api-key-looking bearer — is throttled EXACTLY like an
 *     unauthenticated caller: same bucket, same client-source key, one shared counter;
 *  2. a VALID credential survives a call series that has already exhausted an unauthenticated
 *     caller's budget from the very same source;
 *  3. unauthenticated callers stay strictly throttled, per anti-spoof client source, and one
 *     source's exhaustion never touches another's;
 *  4. the tiering does not weaken the strict bucket: absent and forged credentials from one source
 *     share ONE budget, so alternating credential shapes cannot multiply an anonymous allowance;
 *  5. the `429` hands the caller its retry advice on BOTH channels — `Retry-After` in seconds and
 *     `error.details.retryAfterMs` in the body — and the header is listed in the app's CORS
 *     `Access-Control-Expose-Headers`, so a cross-origin `fetch` client can actually read it.
 *
 * MECHANICS. An in-process `app.request()` has no socket peer, so `clientIpFromContext` collapses
 * every caller to `'unknown'` and a per-source assertion would be vacuous. This suite therefore boots
 * a REAL server (`serve(...)` on 127.0.0.1), trusts the loopback CIDRs, and distinguishes callers by
 * `X-Forwarded-For` — the same pattern the OIDC token-guard suite uses.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * yet absent (un-skippable ran-guard at the bottom).
 */
import { createServer, type Server } from 'node:http';
import { serve } from '@hono/node-server';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'declared-route-rate-limit.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
      'but absent — refusing to silently skip the declared-route throttle acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_declared_route_throttle';

// The declared-route policies (auth-core rate-limit.ts DEFAULT_POLICIES): the strict client-source
// bucket allows 30 hits per minute; the per-principal bucket allows 600.
const SOURCE_MAX = 30;

// A self-contained throwaway backend-profile spec (product-free platform): one store and one
// declared read route, which is all the throttle needs to be observable.
const THROTTLE_YAML = `
version: '1.0'
metadata:
  name: throttle-backend
  description: A backend fixture whose one declared route exercises the throttle tiers.
stores:
  - name: pings
    columns:
      - { name: label, type: text }
api:
  - { method: GET, path: '/pings', action: { kind: store, store: pings, op: list } }
`;

/**
 * A junk bearer with the three-segment JWT shape. `authenticate` routes it to JWKS verification,
 * which throws, so no principal is set — the caller is exactly as unvalidated as one sending nothing.
 */
const FORGED_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJub2JvZHkifQ.bm90LWEtcmVhbC1zaWduYXR1cmU';

/**
 * A junk opaque bearer with the api-key shape (`rk_<prefix>.<secret>`). `authenticate` routes it to
 * the api-key store, which resolves nothing — the other unvalidated shape.
 */
const FORGED_API_KEY = 'rk_ZGVhZGJlZWY.0123456789abcdef0123456789abcdef0123456789abcdef';

let testsRan = 0;

describeDb('declared-route throttling tiers on the validated credential', () => {
  let h: Harness;
  let server: Server;
  let base: string;

  function loadSpec(): RaySpec {
    const parsed = parseSpec(THROTTLE_YAML);
    if (!parsed.ok) throw new Error(`fixture spec invalid: ${JSON.stringify(parsed.errors)}`);
    return parsed.value;
  }

  beforeAll(async () => {
    // Allocate a free port first, then serve the SHIPPED createAuthApp() app on it, so the requests
    // below arrive over a real socket and carry a real peer.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        probe.close(() => resolve(p));
      });
    });
    base = `http://127.0.0.1:${port}`;
    h = await createHarness({
      schema: SCHEMA,
      engineSpec: loadSpec(),
      // The served app runs behind the loopback peer; trust it so each request's X-Forwarded-For
      // becomes the throttle identity, exactly as a real deployment trusts its load balancer.
      trustedProxies: ['127.0.0.0/8', '::1/128'],
    });
    server = serve({ fetch: h.app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
    await new Promise((r) => setTimeout(r, 50));
  });

  beforeEach(async () => {
    // Truncates the tables AND clears the in-process limiter, so no count leaks between tests.
    await h.reset();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await h.close();
  });

  /** GET the declared route over HTTP from `ip`, optionally presenting `bearer` / an `Origin`. */
  async function ping(opts: { ip: string; bearer?: string; origin?: string }): Promise<Response> {
    const headers: Record<string, string> = { 'x-forwarded-for': opts.ip };
    if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.origin !== undefined) headers.origin = opts.origin;
    return fetch(`${base}/pings`, { method: 'GET', headers });
  }

  /** Register → org → switch: an org-scoped owner token (owner holds `store:read`). */
  async function ownerToken(email: string, orgName: string): Promise<string> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
      body: { name: orgName },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    const sw = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    return (await sw.json()).accessToken as string;
  }

  it('throttles an unauthenticated caller per client source once the strict budget is spent', async () => {
    testsRan++;
    const ip = '203.0.113.10';
    // Under budget the route answers with its own 401 — the throttle has not fired.
    for (let i = 0; i < SOURCE_MAX; i++) {
      expect((await ping({ ip })).status).toBe(401);
    }
    const throttled = await ping({ ip });
    expect(throttled.status).toBe(429);
    const body = await throttled.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    // The retry advice reaches the caller on BOTH channels. In the body: `details.retryAfterMs`, the
    // same field every other request-budget throttle emits through the thrown-ApiError path.
    expect(typeof body.error.details.retryAfterMs).toBe('number');
    expect(body.error.details.retryAfterMs).toBeGreaterThan(0);
    // And in the header — Retry-After is SECONDS, and a spent 60s window always advises at least one.
    const retryAfter = Number(throttled.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // The advice is READABLE by a cross-origin browser client. `Retry-After` is not a CORS-safelisted
    // response header, so a `fetch` client sees it only if the app exposes it; the budget is already
    // spent, so this allowlisted-origin call is another 429 and carries the grant.
    const crossOrigin = await ping({ ip, origin: 'https://app.rayspec.test' });
    expect(crossOrigin.status).toBe(429);
    const exposed = (crossOrigin.headers.get('access-control-expose-headers') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase());
    expect(exposed).toContain('retry-after');
    expect(crossOrigin.headers.get('retry-after')).not.toBeNull();

    // A DIFFERENT source is untouched — a real per-source throttle, not a global outage.
    expect((await ping({ ip: '203.0.113.11' })).status).toBe(401);
  });

  it('puts a forged three-segment JWT-shaped bearer in the strict source bucket', async () => {
    testsRan++;
    const ip = '203.0.113.20';
    for (let i = 0; i < SOURCE_MAX; i++) {
      expect((await ping({ ip, bearer: FORGED_JWT })).status).toBe(401);
    }
    const throttled = await ping({ ip, bearer: FORGED_JWT });
    expect(throttled.status).toBe(429);
    expect((await throttled.json()).error.code).toBe('RATE_LIMITED');
  });

  it('puts a forged opaque api-key-shaped bearer in the strict source bucket', async () => {
    testsRan++;
    const ip = '203.0.113.30';
    for (let i = 0; i < SOURCE_MAX; i++) {
      expect((await ping({ ip, bearer: FORGED_API_KEY })).status).toBe(401);
    }
    const throttled = await ping({ ip, bearer: FORGED_API_KEY });
    expect(throttled.status).toBe(429);
    expect((await throttled.json()).error.code).toBe('RATE_LIMITED');
  });

  it('counts absent and forged credentials from one source against ONE budget', async () => {
    testsRan++;
    // The anti-regression arm: if a forged header bought its own bucket, alternating the three
    // shapes would give this source three budgets instead of one, and nothing below would refuse.
    const ip = '203.0.113.40';
    for (let i = 0; i < SOURCE_MAX / 3; i++) {
      expect((await ping({ ip })).status).toBe(401);
      expect((await ping({ ip, bearer: FORGED_JWT })).status).toBe(401);
      expect((await ping({ ip, bearer: FORGED_API_KEY })).status).toBe(401);
    }
    // SOURCE_MAX hits from one source, whatever shape the junk took ⇒ the next one is refused,
    // in every shape.
    expect((await ping({ ip })).status).toBe(429);
    expect((await ping({ ip, bearer: FORGED_JWT })).status).toBe(429);
    expect((await ping({ ip, bearer: FORGED_API_KEY })).status).toBe(429);
  });

  it('lets a validated credential through a series that already throttled the same source', async () => {
    testsRan++;
    const token = await ownerToken('throttle-owner@example.test', 'Throttle Org');
    const ip = '203.0.113.50';
    // Spend the strict budget from this source with junk, and confirm it is spent.
    for (let i = 0; i < SOURCE_MAX; i++) {
      expect((await ping({ ip, bearer: FORGED_JWT })).status).toBe(401);
    }
    expect((await ping({ ip, bearer: FORGED_JWT })).status).toBe(429);

    // The VALID credential from the SAME source is keyed on the principal, not the source, so it is
    // unaffected — and it survives well past the strict budget an unauthenticated caller gets.
    for (let i = 0; i < SOURCE_MAX + 10; i++) {
      expect((await ping({ ip, bearer: token })).status).toBe(200);
    }
  });
});

// Un-skippable ran-guard: when the DB is REQUIRED, this suite must actually have run its arms —
// a silently skipped throttle acceptance would be a false green on the load-bearing property.
describe('declared-route throttle suite ran', () => {
  it('executed its arms when the DB is required', () => {
    if (requireDb) expect(testsRan).toBeGreaterThanOrEqual(5);
    else expect(true).toBe(true);
  });
});
