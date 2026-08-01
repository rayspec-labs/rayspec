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
import { DEFAULT_POLICIES } from '@rayspec/auth-core';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';
import { DEFAULT_ROUTE_RATE_TIERS } from './route-rate-limit.js';

/** The registered allowance for a tier — fail loudly rather than silently testing nothing. */
function policyMax(bucket: string): number {
  const policy = DEFAULT_POLICIES[bucket];
  if (!policy) throw new Error(`bucket '${bucket}' has no registered policy`);
  return policy.max;
}

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

// Read the budgets off the SAME registered policy table the middleware consults, rather than
// restating them. A retune there then retunes this suite with it; a hardcoded copy would instead go
// red in a way that reads like a throttle bug.
const SOURCE_MAX = policyMax(DEFAULT_ROUTE_RATE_TIERS.source);
const PRINCIPAL_MAX = policyMax(DEFAULT_ROUTE_RATE_TIERS.principal);

// The DECLARED per-route budget the second half of this suite drives. Small enough to exhaust in a
// handful of calls, and read off the fixture rather than restated, so the two cannot drift.
const ROUTE_MAX = 3;

// A self-contained throwaway backend-profile spec (product-free platform): one store and four declared
// read routes — one unbudgeted (the tier fixture), two carrying the SAME small declared budget (so one
// route's exhaustion can be shown not to touch the other's), and one whose declared budget is far above
// the shared tier ceiling (so the tier can be shown to still bind).
const THROTTLE_YAML = `
version: '1.0'
metadata:
  name: throttle-backend
  description: A backend fixture whose declared routes exercise the throttle tiers and per-route budgets.
stores:
  - name: pings
    columns:
      - { name: label, type: text }
api:
  - { method: GET, path: '/pings', action: { kind: store, store: pings, op: list } }
  - method: GET
    path: /tight
    action: { kind: store, store: pings, op: list }
    rateLimit: { windowSeconds: 60, max: ${ROUTE_MAX} }
  - method: GET
    path: /tight-b
    action: { kind: store, store: pings, op: list }
    rateLimit: { windowSeconds: 60, max: ${ROUTE_MAX} }
  - method: GET
    path: /loose
    action: { kind: store, store: pings, op: list }
    rateLimit: { windowSeconds: 60, max: 1000000 }
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

  /** GET a declared route over HTTP from `ip`, optionally presenting `bearer` / an `Origin`. */
  async function ping(opts: {
    ip: string;
    bearer?: string;
    origin?: string;
    path?: string;
  }): Promise<Response> {
    const headers: Record<string, string> = { 'x-forwarded-for': opts.ip };
    if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.origin !== undefined) headers.origin = opts.origin;
    return fetch(`${base}${opts.path ?? '/pings'}`, { method: 'GET', headers });
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

  /** Register → org → switch → mint: a real org-scoped API key secret (`key:<id>` principal). */
  async function ownerApiKey(email: string, orgName: string): Promise<string> {
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
    const token = (await sw.json()).accessToken as string;
    const mint = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      body: { scopes: ['store:read'] },
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await mint.json()) as { plaintext?: string };
    // The plaintext is shown exactly once, on the original mint.
    if (!body.plaintext) throw new Error('api-key mint returned no plaintext secret');
    return body.plaintext;
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
    // Cycle the three shapes across exactly SOURCE_MAX calls without assuming the budget divides by
    // three — the count is what matters, not that it splits evenly.
    const shapes = [undefined, FORGED_JWT, FORGED_API_KEY];
    for (let i = 0; i < SOURCE_MAX; i++) {
      const bearer = shapes[i % shapes.length];
      expect((await ping(bearer === undefined ? { ip } : { ip, bearer })).status).toBe(401);
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
    // The series has to stay inside the generous budget, or this arm would be proving the wrong thing.
    expect(SOURCE_MAX + 10).toBeLessThan(PRINCIPAL_MAX);
    for (let i = 0; i < SOURCE_MAX + 10; i++) {
      expect((await ping({ ip, bearer: token })).status).toBe(200);
    }
  });

  it('reaches the generous tier with a real API KEY, not only a user token', async () => {
    testsRan++;
    // The issue is worded around "a valid key". A user token and an api key resolve to DIFFERENT
    // principal shapes (`user:<id>` vs `key:<id>`), and only the token shape was driven end to end —
    // so this arm presents an actually-issued key over the wire and requires the same outcome.
    const secret = await ownerApiKey('throttle-key@example.test', 'Throttle Key Org');
    const ip = '203.0.113.60';
    for (let i = 0; i < SOURCE_MAX; i++) {
      expect((await ping({ ip, bearer: FORGED_API_KEY })).status).toBe(401);
    }
    expect((await ping({ ip, bearer: FORGED_API_KEY })).status).toBe(429);

    // Same source, same bearer SHAPE — the only difference is that this credential validates.
    expect(SOURCE_MAX + 10).toBeLessThan(PRINCIPAL_MAX);
    for (let i = 0; i < SOURCE_MAX + 10; i++) {
      expect((await ping({ ip, bearer: secret })).status).toBe(200);
    }
  });

  // -------------------------------------------------------------------------------------------
  // The DECLARED per-route budget (`api[].rateLimit`) — enforced ON TOP of the two shared tiers.
  //
  // Everything below drives a real validated credential over the same real socket, because the two
  // properties that matter most are only observable end to end: the budget is keyed on tenant AND
  // principal, and it is enforced only AFTER authentication — a fact with a visible consequence in
  // both directions (an unauthenticated call spends nothing, an authenticated call that lacks the
  // permission spends anyway).
  // -------------------------------------------------------------------------------------------

  /** Register → org → switch → mint: a user token AND an api key for the SAME organization. */
  async function ownerTokenAndKey(
    email: string,
    orgName: string,
    scopes: string[] = ['store:read'],
  ): Promise<{ token: string; secret: string }> {
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
    const token = (await sw.json()).accessToken as string;
    const mint = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      body: { scopes },
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await mint.json()) as { plaintext?: string };
    if (!body.plaintext) throw new Error('api-key mint returned no plaintext secret');
    return { token, secret: body.plaintext };
  }

  /** One user, TWO organizations: two org-scoped tokens for the SAME principal. */
  async function twoOrgTokens(
    email: string,
    firstOrg: string,
    secondOrg: string,
  ): Promise<{ inFirst: string; inSecond: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const tokens: string[] = [];
    for (const name of [firstOrg, secondOrg]) {
      const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
        body: { name },
        headers: { authorization: `Bearer ${t0}` },
      });
      const orgId = (await orgRes.json()).id as string;
      const sw = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
        headers: { authorization: `Bearer ${t0}` },
      });
      tokens.push((await sw.json()).accessToken as string);
    }
    const [inFirst, inSecond] = tokens;
    if (!inFirst || !inSecond) throw new Error('expected two org-scoped tokens');
    return { inFirst, inSecond };
  }

  it('ENFORCES a declared per-route budget, and refuses with the same 429 shape as a tier', async () => {
    testsRan++;
    const { token } = await ownerTokenAndKey('budget-owner@example.test', 'Budget Org');
    const ip = '203.0.113.70';
    // The declared allowance is far BELOW the generous tier, so nothing but the route's own budget can
    // explain a refusal this early — the tier would still permit hundreds of calls.
    expect(ROUTE_MAX).toBeLessThan(PRINCIPAL_MAX);
    for (let i = 0; i < ROUTE_MAX; i++) {
      expect((await ping({ ip, bearer: token, path: '/tight' })).status).toBe(200);
    }
    const throttled = await ping({ ip, bearer: token, path: '/tight' });
    expect(throttled.status).toBe(429);
    const body = await throttled.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    // The retry advice on BOTH channels, exactly as a tiered refusal carries it — the per-route
    // throttle goes through the SAME refusal path, so its 429 is identical in shape.
    expect(typeof body.error.details.retryAfterMs).toBe('number');
    expect(body.error.details.retryAfterMs).toBeGreaterThan(0);
    const retryAfter = Number(throttled.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // The UNBUDGETED route is untouched: this is a per-route budget, not a per-principal kill switch.
    expect((await ping({ ip, bearer: token, path: '/pings' })).status).toBe(200);
  });

  it('spends NO route budget on an unauthenticated call (the budget sits behind requireAuth)', async () => {
    testsRan++;
    const ip = '203.0.113.71';
    // Unauthenticated calls to the budgeted route meet their usual 401 and must not consume it.
    for (let i = 0; i < SOURCE_MAX; i++) {
      expect((await ping({ ip, path: '/tight' })).status).toBe(401);
    }
    // A validated credential then still finds the FULL declared budget waiting for it.
    const { token } = await ownerTokenAndKey('budget-401@example.test', 'Budget 401 Org');
    for (let i = 0; i < ROUTE_MAX; i++) {
      expect((await ping({ ip, bearer: token, path: '/tight' })).status).toBe(200);
    }
    expect((await ping({ ip, bearer: token, path: '/tight' })).status).toBe(429);
  });

  it('SPENDS route budget on a call that authenticates but lacks the permission', async () => {
    testsRan++;
    // The documented consequence of putting the budget before requirePermission (which does a live
    // membership lookup): an over-budget caller costs no DB round trip, at the price that a 403 costs
    // budget. The throttle bounds load; it does not authorize.
    const { secret } = await ownerTokenAndKey('budget-403@example.test', 'Budget 403 Org', [
      'agent:run',
    ]);
    const ip = '203.0.113.72';
    for (let i = 0; i < ROUTE_MAX; i++) {
      expect((await ping({ ip, bearer: secret, path: '/tight' })).status).toBe(403);
    }
    // Budget spent — the next call is refused BEFORE the permission check runs at all.
    expect((await ping({ ip, bearer: secret, path: '/tight' })).status).toBe(429);
  });

  it('KEYS the budget per principal — two principals of one tenant do not share it', async () => {
    testsRan++;
    const { token, secret } = await ownerTokenAndKey('budget-two@example.test', 'Budget Two Org');
    const ip = '203.0.113.73';
    for (let i = 0; i < ROUTE_MAX; i++) {
      expect((await ping({ ip, bearer: token, path: '/tight' })).status).toBe(200);
    }
    expect((await ping({ ip, bearer: token, path: '/tight' })).status).toBe(429);
    // The api key is a DIFFERENT principal (`key:<id>` vs `user:<id>`) in the SAME organization, and
    // it arrives from the same client source — so only per-principal keying can explain it passing.
    for (let i = 0; i < ROUTE_MAX; i++) {
      expect((await ping({ ip, bearer: secret, path: '/tight' })).status).toBe(200);
    }
    expect((await ping({ ip, bearer: secret, path: '/tight' })).status).toBe(429);
  });

  it('KEYS the budget per tenant — one principal in two organizations is counted twice', async () => {
    testsRan++;
    const { inFirst, inSecond } = await twoOrgTokens(
      'budget-multi@example.test',
      'Budget Org One',
      'Budget Org Two',
    );
    const ip = '203.0.113.74';
    for (let i = 0; i < ROUTE_MAX; i++) {
      expect((await ping({ ip, bearer: inFirst, path: '/tight' })).status).toBe(200);
    }
    expect((await ping({ ip, bearer: inFirst, path: '/tight' })).status).toBe(429);
    // Same user, same route, same source — only the tenant segment of the key differs.
    for (let i = 0; i < ROUTE_MAX; i++) {
      expect((await ping({ ip, bearer: inSecond, path: '/tight' })).status).toBe(200);
    }
    expect((await ping({ ip, bearer: inSecond, path: '/tight' })).status).toBe(429);
  });

  it('KEYS the budget per ROUTE — exhausting one budgeted route leaves the other intact', async () => {
    testsRan++;
    const { token } = await ownerTokenAndKey('budget-routes@example.test', 'Budget Routes Org');
    const ip = '203.0.113.75';
    for (let i = 0; i < ROUTE_MAX; i++) {
      expect((await ping({ ip, bearer: token, path: '/tight' })).status).toBe(200);
    }
    expect((await ping({ ip, bearer: token, path: '/tight' })).status).toBe(429);
    // A second route declaring the very same budget counts separately — distinct per-route buckets.
    for (let i = 0; i < ROUTE_MAX; i++) {
      expect((await ping({ ip, bearer: token, path: '/tight-b' })).status).toBe(200);
    }
    expect((await ping({ ip, bearer: token, path: '/tight-b' })).status).toBe(429);
  });

  it('is ADDITIVE, not substitutive — a declared max above the tier cannot make a route more permissive', async () => {
    testsRan++;
    // `/loose` declares a budget of a million per minute. If the declared limit REPLACED the shared
    // tier, this route would answer far past the tier ceiling; because it is applied IN ADDITION, the
    // effective allowance is the smaller of the two and the tier still binds at exactly its own max.
    const { token } = await ownerTokenAndKey('budget-loose@example.test', 'Budget Loose Org');
    const ip = '203.0.113.76';
    for (let i = 0; i < PRINCIPAL_MAX; i++) {
      const res = await ping({ ip, bearer: token, path: '/loose' });
      expect(res.status, `call ${i + 1} of ${PRINCIPAL_MAX} was refused early`).toBe(200);
    }
    const throttled = await ping({ ip, bearer: token, path: '/loose' });
    expect(throttled.status).toBe(429);
    expect((await throttled.json()).error.code).toBe('RATE_LIMITED');
  }, 120_000);
});

// Un-skippable ran-guard: when the DB is REQUIRED, this suite must actually have run its arms —
// a silently skipped throttle acceptance would be a false green on the load-bearing property.
describe('declared-route throttle suite ran', () => {
  it('executed its arms when the DB is required', () => {
    if (requireDb) expect(testsRan).toBeGreaterThanOrEqual(13);
    else expect(true).toBe(true);
  });
});
