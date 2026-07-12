/**
 * CORS middleware invariants (deterministic, NO database required).
 *
 * CORS behaviour is a pure function of `deps.allowedOrigins` + the request headers/method; the
 * relevant requests here (OPTIONS preflights and non-credentialed probes) never touch the DB-backed
 * stores — the `cors()` middleware runs BEFORE `authenticate`, and a preflight short-circuits with a
 * 204 before any route handler. So this suite builds the app with MINIMAL fake deps (no Postgres),
 * which makes it RUN EVERYWHERE (no `DATABASE_URL` gate) — avoiding the self-skip false-green hazard
 * a DB-gated security test carries.
 *
 * It asserts, against the REAL constructed app via `app.request(...)`:
 *   inv.1  unset/empty `allowedOrigins` ⇒ NO `Access-Control-*` header on a normal request OR an
 *          OPTIONS preflight (current same-origin behaviour byte-preserved).
 *   inv.2  with an allowlist set, a NON-allowlisted `Origin` ⇒ NO `Access-Control-Allow-Origin`
 *          (no reflect-any).
 *   inv.4  an allowlisted `Origin` ⇒ `Access-Control-Allow-Origin` ECHOES that exact origin (never
 *          `*`) + `Vary: Origin`.
 *   preflight  an OPTIONS from an allowlisted origin ⇒ 204 whose `Allow-Headers` is EXACTLY the platform
 *          base set plus the deployer-injected header (set equality — no product header may creep into
 *          the base set), AND it did NOT reach the route handler (cors short-circuits before auth).
 *   inv.3  the response NEVER carries `Access-Control-Allow-Credentials: true` (credentials omitted).
 */

import { RateLimiter } from '@rayspec/auth-core';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthApp } from './app.js';
import type { AppDeps } from './app-context.js';

const ALLOWED = 'http://localhost:1420'; // a representative native/dev origin
const OTHER = 'https://evil.example';

/**
 * The platform BASE `allowHeaders` set mounted by `app.ts` — product-free by construction. The preflight
 * suite asserts SET EQUALITY against this plus whatever the deployer injects via
 * `ALLOWED_REQUEST_HEADERS`, so ANY unexpected header (a product-specific one, or a silently widened
 * base set) fails the test. Keep in sync with `app.ts`; a drift here is the point of the assertion.
 */
const BASE_ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'x-request-id',
  'idempotency-key',
  'last-event-id',
];

/**
 * The `exposeHeaders` set `app.ts` mounts: the request-id echo plus the store surface —
 * `X-Next-Cursor` + `X-Result-Truncated` (keyset pagination) and `Idempotency-Replay` (idempotent replay).
 * None is a CORS-safelisted response header, so each must be exposed or a `fetch` client cannot read it.
 * The suite below asserts these are ACTUALLY present in `Access-Control-Expose-Headers` on the REAL app —
 * dropping any one from app.ts turns it RED.
 */
const EXPECTED_EXPOSE_HEADERS = [
  'x-request-id',
  'x-next-cursor',
  'x-result-truncated',
  'idempotency-replay',
];

/** Parse an `Access-Control-Allow-Headers` value into a lowercased Set of header names. */
function parseAllowHeaders(value: string | null): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
}

/**
 * Build an app with MINIMAL fake deps. Only `allowedOrigins` (the CORS allowlist) and `rateLimiter`
 * are real; the DB-backed stores are never reached by the requests in this suite, so they are cast-in
 * placeholders. `assertBootSecrets()` (run inside createAuthApp) is satisfied by the env keys set in
 * beforeAll.
 *
 * `db` carries a `select`/`transaction` stub only so the cast satisfies the `AppDeps` shape; the
 * non-credentialed requests in this suite never reach a DB query path.
 */
function buildApp(
  allowedOrigins: string[],
  allowedRequestHeaders?: string[],
): ReturnType<typeof createAuthApp> {
  const noop = () => {
    throw new Error('fake db must not be queried in the CORS suite');
  };
  const deps = {
    allowedOrigins,
    allowedRequestHeaders,
    rateLimiter: new RateLimiter(),
    db: { select: noop, transaction: noop },
  } as unknown as AppDeps;
  return createAuthApp(deps);
}

let savedKey: string | undefined;
let savedPepper: string | undefined;

beforeAll(() => {
  savedKey = process.env.RAYSPEC_JWT_SIGNING_KEY;
  savedPepper = process.env.RAYSPEC_API_KEY_PEPPER;
  // assertBootSecrets only checks PRESENCE/non-empty at construction — a non-PEM value is fine since
  // this suite never signs/verifies a token (no credentialed request reaches the signer).
  process.env.RAYSPEC_JWT_SIGNING_KEY = 'boot-secret-present-for-cors-suite';
  process.env.RAYSPEC_API_KEY_PEPPER = 'boot-pepper-present-for-cors-suite';
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.RAYSPEC_JWT_SIGNING_KEY;
  else process.env.RAYSPEC_JWT_SIGNING_KEY = savedKey;
  if (savedPepper === undefined) delete process.env.RAYSPEC_API_KEY_PEPPER;
  else process.env.RAYSPEC_API_KEY_PEPPER = savedPepper;
});

/** True if the response carries ANY `Access-Control-*` header. */
function hasAnyCorsHeader(res: Response): boolean {
  for (const key of res.headers.keys()) {
    if (key.toLowerCase().startsWith('access-control-')) return true;
  }
  return false;
}

describe('— fail-closed when no allowlist (inv.1)', () => {
  it('unset/empty allowedOrigins ⇒ NO Access-Control-* on a normal request', async () => {
    const app = buildApp([]);
    const res = await app.request('/health', {
      method: 'GET',
      headers: { origin: ALLOWED },
    });
    expect(hasAnyCorsHeader(res)).toBe(false);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('unset/empty allowedOrigins ⇒ NO Access-Control-* on an OPTIONS preflight', async () => {
    const app = buildApp([]);
    const res = await app.request('/health', {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-custom-client',
      },
    });
    // No cors middleware registered ⇒ the preflight is NOT short-circuited into a 204 with cors
    // headers; the absence of any Access-Control-* header is the invariant (current behaviour).
    expect(hasAnyCorsHeader(res)).toBe(false);
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
    expect(res.headers.get('access-control-allow-headers')).toBeNull();
  });
});

describe('— origin matching (inv.2 / inv.4)', () => {
  it('a NON-allowlisted Origin ⇒ NO Access-Control-Allow-Origin (no reflect-any)', async () => {
    const app = buildApp([ALLOWED]);
    const res = await app.request('/health', {
      method: 'GET',
      headers: { origin: OTHER },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('an allowlisted Origin ⇒ ACAO echoes that EXACT origin (never *) + Vary: Origin', async () => {
    const app = buildApp([ALLOWED]);
    const res = await app.request('/health', {
      method: 'GET',
      headers: { origin: ALLOWED },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    // `Vary: Origin` must be present so a cache keys on the Origin (array origin ⇒ origin !== '*').
    const vary = res.headers.get('vary') ?? '';
    expect(vary.toLowerCase()).toContain('origin');
  });
});

describe('— preflight OPTIONS (allowlisted)', () => {
  it('returns 204 whose Allow-Headers is EXACTLY the base set + the deployer-injected header, WITHOUT reaching a route', async () => {
    // Build the app WITH a deployer-injected extra request header (ALLOWED_REQUEST_HEADERS →
    // deps.allowedRequestHeaders). The platform base set carries no product-specific header; the
    // injected one is echoed additively into Access-Control-Allow-Headers.
    const app = buildApp([ALLOWED], ['X-Custom-Client']);
    // Point the preflight at a path that does NOT exist as a real route. If the preflight were NOT
    // short-circuited by cors, the request would fall through to app.notFound ⇒ 404. A 204 here
    // proves cors answered it BEFORE the route layer (so an OPTIONS can never bypass authenticate).
    const res = await app.request('/v1/runs/does-not-exist', {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,x-custom-client',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    const methods = (res.headers.get('access-control-allow-methods') ?? '').toUpperCase();
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(methods).toContain(m);
    }
    // EXHAUSTIVE set equality — `Access-Control-Allow-Headers` is EXACTLY the platform base set plus the
    // one header this test injected. A `toContain` pair would pass while an extra header rode along, so
    // this is what actually pins "the platform hardcodes NO product-specific header": any unexpected
    // entry — product-named or not — fails, and so does a silently dropped base header.
    const allowHeaders = parseAllowHeaders(res.headers.get('access-control-allow-headers'));
    expect([...allowHeaders].sort()).toEqual([...BASE_ALLOW_HEADERS, 'x-custom-client'].sort());
    expect(res.headers.get('access-control-max-age')).toBe('600');
  });
});

describe('— credentials stay OFF (inv.3)', () => {
  it('never emits Access-Control-Allow-Credentials: true on a normal request OR a preflight', async () => {
    const app = buildApp([ALLOWED]);
    const normal = await app.request('/health', {
      method: 'GET',
      headers: { origin: ALLOWED },
    });
    expect(normal.headers.get('access-control-allow-credentials')).toBeNull();

    const preflight = await app.request('/health', {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('— security headers still applied (inv.8)', () => {
  it('a normal allowlisted request carries BOTH the CORS grant AND the security headers', async () => {
    const app = buildApp([ALLOWED]);
    const res = await app.request('/health', {
      method: 'GET',
      headers: { origin: ALLOWED },
    });
    // CORS grant present...
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    // ...and the securityHeaders middleware is NOT clobbered by cors (distinct header sets).
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
  });
});

describe('— expose-headers: the pagination/replay response headers are readable cross-origin', () => {
  it('an allowlisted response exposes X-Request-Id + X-Next-Cursor + X-Result-Truncated + Idempotency-Replay (fail-the-fix)', async () => {
    // Drive the REAL createAuthApp (not the synthetic mirror), so this pins app.ts directly: dropping any
    // one of the exposed headers from app.ts's `exposeHeaders` makes the set assertion below RED.
    // hono/cors sets `Access-Control-Expose-Headers` on the actual response (before the OPTIONS branch),
    // so a normal allowlisted GET carries it.
    const app = buildApp([ALLOWED]);
    const res = await app.request('/health', { method: 'GET', headers: { origin: ALLOWED } });
    const exposed = parseAllowHeaders(res.headers.get('access-control-expose-headers'));
    for (const h of EXPECTED_EXPOSE_HEADERS) expect(exposed.has(h)).toBe(true);
    // The pagination/replay headers specifically — spelled out so a regression is unmissable.
    expect(exposed.has('x-next-cursor')).toBe(true);
    expect(exposed.has('x-result-truncated')).toBe(true);
    expect(exposed.has('idempotency-replay')).toBe(true);
  });

  it('the preflight (OPTIONS) response ALSO carries the exposed headers (hono sets them before the OPTIONS branch)', async () => {
    const app = buildApp([ALLOWED]);
    const res = await app.request('/health', {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    const exposed = parseAllowHeaders(res.headers.get('access-control-expose-headers'));
    for (const h of EXPECTED_EXPOSE_HEADERS) expect(exposed.has(h)).toBe(true);
  });
});

/**
 * TV-3 / TV-4 — pin the CORS grant on a GENUINE 200 (the `createAuthApp` suite above only probes a
 * non-registered path that 404s) AND on an SSE response (inv.9 — the real cross-origin client path is
 * the runs.ts streamSSE surface). Synthetic + no-DB: a minimal `Hono` with the EXACT `cors({...})`
 * options from `app.ts` (allowlisted origin), a trivial 200 route, and a `streamSSE` route. This
 * isolates the carrier behaviour (hono/cors sets ACAO on `c.res.headers` BEFORE `next()`, and a route
 * that writes via the context — `c.json` / `streamSSE`'s `c.newResponse` — preserves them).
 */
describe('— CORS grant carries on a real 200 + on SSE (TV-3 / TV-4 / inv.9)', () => {
  function buildSyntheticApp(): Hono {
    const app = new Hono();
    // The SAME cors options app.ts mounts (array origin → echo-on-match; bearer-only; no credentials).
    // Mirrors app.ts's platform BASE `allowHeaders` set (no product-specific header — deployer headers
    // are injected) AND its `exposeHeaders` set (X-Request-Id + the pagination headers +
    // the replay signal). KEEP the exposeHeaders list in parity with app.ts; the real fail-the-fix
    // for app.ts's exposeHeaders lives in the `— expose-headers` suite below, which drives the
    // REAL createAuthApp.
    app.use(
      '*',
      cors({
        origin: [ALLOWED],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: [
          'Authorization',
          'Content-Type',
          'X-Request-Id',
          'Idempotency-Key',
          'Last-Event-Id',
        ],
        exposeHeaders: [
          'X-Request-Id',
          'X-Next-Cursor',
          'X-Result-Truncated',
          'Idempotency-Replay',
        ],
        maxAge: 600,
      }),
    );
    app.get('/__probe', (c) => c.json({ ok: true }));
    app.get('/__sse', (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: 'x' });
      }),
    );
    return app;
  }

  it('a real 200 (c.json) carries ACAO: <origin> + Vary: Origin (TV-4)', async () => {
    const app = buildSyntheticApp();
    const res = await app.request('/__probe', { method: 'GET', headers: { origin: ALLOWED } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    expect((res.headers.get('vary') ?? '').toLowerCase()).toContain('origin');
  });

  it('an SSE response carries the SAME CORS grant + Vary, and is text/event-stream (inv.9 / TV-3)', async () => {
    const app = buildSyntheticApp();
    const res = await app.request('/__sse', { method: 'GET', headers: { origin: ALLOWED } });
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect((res.headers.get('vary') ?? '').toLowerCase()).toContain('origin');
    expect((res.headers.get('content-type') ?? '').toLowerCase()).toMatch(/^text\/event-stream/);
  });
});
