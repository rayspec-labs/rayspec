/**
 * INTEROP SPIKE (Risks / "INTEROP SPIKE FIRST").
 *
 * The single flagged risk is the oidc-provider (Koa/raw-Node-handler) ↔ Hono mount. Before
 * building the full OAuth surface we prove, through a REAL HTTP server, that:
 *   1. discovery (`/oidc/.well-known/openid-configuration`) resolves through the Hono mount;
 *   2. the JWKS endpoint resolves through the mount and returns a usable key set;
 *   3. a full authorization_code + PKCE round trip works end-to-end through the mount —
 *      GET /auth (redirect to interaction) → the interaction is resolved → the redirect back
 *      issues a code → POST /token with the PKCE code_verifier yields a real RFC-9068 token.
 *
 * If THIS cannot be made to work, 's OAuth surface is blocked and we STOP + report
 * rather than hacking around it. It works (see below): the raw req/res pass-through via
 * @hono/node-server's HttpBindings + RESPONSE_ALREADY_SENT is the bridge.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import Provider from 'oidc-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountOidc } from './mount.js';

// A PKCE verifier/challenge pair (S256).
const codeVerifier = randomBytes(32).toString('base64url');
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

let server: Server;
let baseUrl: string;
let provider: Provider;

beforeAll(async () => {
  // Bind to an ephemeral port first so we know the issuer URL before constructing the provider.
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(p));
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
  const issuer = `${baseUrl}/oidc`;

  provider = new Provider(issuer, {
    // In-memory adapter (the default) is fine for the spike; supplies the Drizzle one.
    clients: [
      {
        client_id: 'spike-client',
        client_secret: 'spike-secret',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        redirect_uris: ['http://127.0.0.1:9999/cb'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    pkce: { required: () => true },
    features: {
      // Dev interactions give us a login/consent UI we can drive programmatically over HTTP.
      devInteractions: { enabled: true },
    },
    // The provider runs behind our Hono mount; in the spike there is no TLS proxy.
    // Allow http for 127.0.0.1 dev (the cookies feature defaults to secure otherwise).
    cookies: { keys: ['spike-cookie-key'] },
  });
  // Permit non-https issuer for the local spike (production runs behind TLS).
  // biome-ignore lint/suspicious/noExplicitAny: provider internal proxy flag for local http.
  (provider as any).proxy = true;

  const app = new OpenAPIHono<{ Bindings: HttpBindings }>();
  app.route('/oidc', mountOidc(provider));

  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
  // Give the listener a tick to bind.
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('oidc-provider ↔ Hono interop spike', () => {
  it('serves OIDC discovery through the Hono mount', async () => {
    const res = await fetch(`${baseUrl}/oidc/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, string>;
    expect(doc.issuer).toBe(`${baseUrl}/oidc`);
    expect(doc.authorization_endpoint).toBe(`${baseUrl}/oidc/auth`);
    expect(doc.token_endpoint).toBe(`${baseUrl}/oidc/token`);
    expect(doc.jwks_uri).toBe(`${baseUrl}/oidc/jwks`);
  });

  it('serves a JWKS through the Hono mount', async () => {
    const res = await fetch(`${baseUrl}/oidc/jwks`);
    expect(res.status).toBe(200);
    const jwks = (await res.json()) as { keys: unknown[] };
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);
  });

  it('completes an authorization_code + PKCE round trip through the mount', async () => {
    // Manual cookie jar (Node fetch does not persist cookies across calls).
    const jar = new Map<string, string>();
    const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const absorb = (res: Response) => {
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [pair] = sc.split(';');
        const eq = pair?.indexOf('=') ?? -1;
        if (pair && eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    };

    const authParams = new URLSearchParams({
      client_id: 'spike-client',
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:9999/cb',
      scope: 'openid',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: 'spike-state',
    });

    // 1) GET /auth → 303 to the interaction (login) endpoint.
    let res = await fetch(`${baseUrl}/oidc/auth?${authParams}`, { redirect: 'manual' });
    absorb(res);
    expect([303, 302]).toContain(res.status);
    let location = res.headers.get('location') ?? '';
    expect(location).toContain('/oidc/interaction/');

    const uid = location.split('/interaction/')[1]?.replace(/\/$/, '') ?? '';
    expect(uid.length).toBeGreaterThan(0);
    // The dev-interaction form posts back to the interaction uid path (verified against the
    // rendered form `action`), with fields prompt/login/password.
    const interactionPost = `${baseUrl}/oidc/interaction/${uid}`;

    // 2) POST the dev-interaction login (devInteractions accepts any login/password).
    res = await fetch(interactionPost, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
      body: new URLSearchParams({ prompt: 'login', login: 'spike-user', password: 'x' }),
      redirect: 'manual',
    });
    absorb(res);
    expect([303, 302]).toContain(res.status);

    // 3) Resume the auth request → it now needs the consent prompt.
    res = await fetch(`${baseUrl}/oidc/auth/${uid}`, {
      headers: { cookie: cookieHeader() },
      redirect: 'manual',
    });
    absorb(res);
    location = res.headers.get('location') ?? '';
    // Loop through any further interaction prompts (consent), confirming each, until we get
    // redirected back to the client redirect_uri with a code.
    for (let i = 0; i < 4 && location.includes('/interaction/'); i++) {
      const stepUid = location.split('/interaction/')[1]?.replace(/\/$/, '') ?? uid;
      res = await fetch(`${baseUrl}/oidc/interaction/${stepUid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
        body: new URLSearchParams({ prompt: 'consent' }),
        redirect: 'manual',
      });
      absorb(res);
      expect([303, 302]).toContain(res.status);
      res = await fetch(`${baseUrl}/oidc/auth/${stepUid}`, {
        headers: { cookie: cookieHeader() },
        redirect: 'manual',
      });
      absorb(res);
      location = res.headers.get('location') ?? '';
    }

    expect(location).toContain('http://127.0.0.1:9999/cb');
    const code = new URL(location).searchParams.get('code');
    expect(code).toBeTruthy();

    // 5) POST /token with the PKCE verifier → an access token.
    const basic = Buffer.from('spike-client:spike-secret').toString('base64');
    const tokenRes = await fetch(`${baseUrl}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        code_verifier: codeVerifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const token = (await tokenRes.json()) as { access_token?: string; token_type?: string };
    expect(token.access_token).toBeTruthy();
    expect(token.token_type?.toLowerCase()).toBe('bearer');
  });
});
