/**
 * OIDC token-endpoint guard — the SHIPPED pre-mount guard.
 *
 * The /oidc catch-all hands the raw req/res to the provider and bypasses the per-route enforceRate()
 * the first-party auth routes use. A thin Hono middleware on the /oidc prefix (app.ts) throttles the
 * token endpoint AND bounds its body BEFORE the provider sees the request. Earlier this suite drove
 * the app via `h.app.request()`, where `c.env` is undefined so the mount throws a 500 — so the
 * provider was never invoked, the throttle "client-error" assertions were vacuous, and the guard's
 * happy-path passthrough was never proven.
 *
 * This suite now drives the guard against a REAL served app (serve({ fetch: app.fetch })) wired to a
 * provider with a REAL registered client_credentials client, and proves the guard end-to-end:
 *   1. a legitimate under-budget client_credentials request returns 200 THROUGH the guard (correct
 *      ordering: the guard runs, passes, and the provider issues a token);
 *   2. the rate-limit returns a real 429 once the per-source budget is exhausted;
 *   3. an oversized body returns a real 400 (VALIDATION_ERROR) before the provider parses it;
 *   4. the guard cannot be bypassed by a trailing-slash / case path variant the provider still
 *      serves as the token endpoint, nor by a token POST that OMITS Content-Length (chunked /
 *      unbounded body) — all are caught with a real 429/400, never a provider 200.
 */
import { createServer, type Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OAUTH_TOKEN_MAX_BODY_BYTES } from '../app.js';
import { createHarness, type Harness } from '../test-support/harness.js';

const CLIENT = { client_id: 'm2m-guard-client', client_secret: 'm2m-guard-secret' };

let h: Harness;
let server: Server;
let base: string;

beforeAll(async () => {
  // Allocate a free port FIRST so the provider's issuer matches the served origin (client_credentials
  // validation lines up with the real host), then serve the SHIPPED createAuthApp() app on it.
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
    schema: 'rayspec_test_apiauth_ratelimit',
    withOidc: true,
    oidcIssuer: `${base}/oidc`,
    // The served app runs behind the loopback peer; trust it so the request's X-Forwarded-For becomes
    // the throttle identity (the per-source assertions below), exactly as a real deployment trusts its
    // LB. Without this the identity would collapse to the single loopback peer.
    trustedProxies: ['127.0.0.0/8', '::1/128'],
    oidcClients: [
      {
        client_id: CLIENT.client_id,
        client_secret: CLIENT.client_secret,
        grant_types: ['client_credentials'],
        response_types: [],
        redirect_uris: [],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
  });
  server = serve({ fetch: h.app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
  await new Promise((r) => setTimeout(r, 50));
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await h.close();
});

/** A legitimate, well-formed client_credentials request body (small, in-budget). */
function legitBody(): string {
  return new URLSearchParams({ grant_type: 'client_credentials' }).toString();
}

/** POST the token endpoint over HTTP with the given path/headers/body, returning the Response. */
async function tokenRequest(
  path: string,
  opts: { ip?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const body = opts.body ?? legitBody();
  const basic = Buffer.from(`${CLIENT.client_id}:${CLIENT.client_secret}`).toString('base64');
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    authorization: `Basic ${basic}`,
    'x-forwarded-for': opts.ip ?? '203.0.113.7',
    ...(opts.headers ?? {}),
  };
  return fetch(`${base}${path}`, { method: 'POST', headers, body });
}

describe('OIDC token endpoint guard — served, against a real provider', () => {
  it('a legitimate under-budget client_credentials request returns 200 THROUGH the guard', async () => {
    const res = await tokenRequest('/oidc/token', { ip: '198.51.100.1' });
    expect(res.status).toBe(200);
    const tok = (await res.json()) as { access_token?: string; token_type?: string };
    expect(tok.access_token).toBeTruthy();
    expect(tok.token_type?.toLowerCase()).toBe('bearer');
  });

  it('throttles the token endpoint with a uniform 429 once the per-source budget is exhausted', async () => {
    const ip = '203.0.113.7';
    // The 'oauth-token' policy is 30 hits / minute (rate-limit.ts DEFAULT_POLICIES). The first 30
    // hits pass the guard and the provider 200s; the 31st from the same source must be a real 429.
    for (let i = 0; i < 30; i++) {
      const res = await tokenRequest('/oidc/token', { ip });
      expect(res.status).toBe(200);
    }
    const throttled = await tokenRequest('/oidc/token', { ip });
    expect(throttled.status).toBe(429);
    expect((await throttled.json()).error.code).toBe('RATE_LIMITED');

    // A DIFFERENT source is unaffected (per-source bucket) — a real throttle, not a global outage.
    const otherSource = await tokenRequest('/oidc/token', { ip: '198.51.100.9' });
    expect(otherSource.status).toBe(200);
  });

  it('rejects an oversized token body with a real 400 BEFORE it reaches the provider', async () => {
    const oversizedScope = 'x'.repeat(OAUTH_TOKEN_MAX_BODY_BYTES + 100);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: oversizedScope,
    }).toString();
    const res = await tokenRequest('/oidc/token', { ip: '198.51.100.2', body });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('OIDC token guard cannot be bypassed by path variants or an unbounded body', () => {
  it('a trailing-slash variant (/oidc/token/) is still rate-limited (the provider serves it too)', async () => {
    const ip = '198.51.100.3';
    // Exhaust the budget via the trailing-slash variant. If the guard missed this variant, every
    // hit would 200 (the provider's router matches /token/) and we would never see a 429.
    let sawThrottle = false;
    for (let i = 0; i < 40; i++) {
      const res = await tokenRequest('/oidc/token/', { ip });
      if (res.status === 429) {
        sawThrottle = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(sawThrottle).toBe(true);
  });

  it('a case variant (/oidc/Token) is still rate-limited (the provider serves it too)', async () => {
    const ip = '198.51.100.4';
    let sawThrottle = false;
    for (let i = 0; i < 40; i++) {
      const res = await tokenRequest('/oidc/Token', { ip });
      if (res.status === 429) {
        sawThrottle = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(sawThrottle).toBe(true);
  });

  it('a trailing-slash variant with an oversized body is still 400 (size cap, not bypassed)', async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'x'.repeat(OAUTH_TOKEN_MAX_BODY_BYTES + 100),
    }).toString();
    const res = await tokenRequest('/oidc/token/', { ip: '198.51.100.5', body });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('a token POST with NO Content-Length (chunked / unbounded) is rejected with a 400', async () => {
    // Stream the body so undici sends Transfer-Encoding: chunked and omits Content-Length — the
    // attacker path the cap must NOT let through. A ReadableStream body forces chunked encoding.
    const payload = new TextEncoder().encode(legitBody());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const basic = Buffer.from(`${CLIENT.client_id}:${CLIENT.client_secret}`).toString('base64');
    const res = await fetch(`${base}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
        'x-forwarded-for': '198.51.100.6',
      },
      body: stream,
      // @ts-expect-error duplex is required by undici for a streaming request body.
      duplex: 'half',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('OIDC token guard identity cannot be spoofed via X-Forwarded-For (untrusted peer)', () => {
  // A SEPARATE served app that trusts NO proxy — so the socket peer (loopback) is the throttle
  // identity and a forwarding header is ignored. This is the trusted-proxy security property: an
  // attacker rotating X-Forwarded-For must NOT mint a fresh per-source budget on each request.
  let hs: Harness;
  let spoofServer: Server;
  let spoofBase: string;

  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        probe.close(() => resolve(p));
      });
    });
    spoofBase = `http://127.0.0.1:${port}`;
    hs = await createHarness({
      schema: 'rayspec_test_apiauth_ratelimit_spoof',
      withOidc: true,
      oidcIssuer: `${spoofBase}/oidc`,
      // NO trustedProxies → the loopback peer is the identity; X-Forwarded-For is ignored.
      oidcClients: [
        {
          client_id: CLIENT.client_id,
          client_secret: CLIENT.client_secret,
          grant_types: ['client_credentials'],
          response_types: [],
          redirect_uris: [],
          token_endpoint_auth_method: 'client_secret_basic',
        },
      ],
    });
    spoofServer = serve({ fetch: hs.app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
    await new Promise((r) => setTimeout(r, 50));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => spoofServer.close(() => resolve()));
    await hs.close();
  });

  it('rotating X-Forwarded-For does not evade the per-peer throttle (all requests share the peer bucket)', async () => {
    const basic = Buffer.from(`${CLIENT.client_id}:${CLIENT.client_secret}`).toString('base64');
    const hit = (spoofedIp: string) =>
      fetch(`${spoofBase}/oidc/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basic}`,
          'x-forwarded-for': spoofedIp, // a DIFFERENT forged source each call
        },
        body: legitBody(),
      });
    // The 'oauth-token' budget is 30/min. If the guard trusted X-Forwarded-For, 30 distinct forged
    // sources would each get their own budget and none would throttle. Because the untrusted header is
    // ignored, all 30 count against the ONE loopback peer bucket — so the 31st (any forged IP) is 429.
    for (let i = 0; i < 30; i++) {
      expect((await hit(`203.0.113.${i}`)).status).toBe(200);
    }
    const throttled = await hit('8.8.8.8');
    expect(throttled.status).toBe(429);
  });
});
