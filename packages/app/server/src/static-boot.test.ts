/**
 * Static-profile boot — end-to-end proofs over `assembleStaticServer` (no DB, no network, NO secrets).
 *
 * A mkdtemp fixture directory (built `index.html` + a nested asset) is served by a real static boot and
 * driven with `app.request(...)`. The load-bearing SECURITY assertion is that the auth surface is NOT
 * mounted — a well-known auth/OIDC path returns 404 because the code that mounts it is never reached,
 * not because a spec happened to be empty.
 *
 * Fail-the-fix teeth (verified by mutation + reported, not left as pass-the-shape):
 *   - the security-header test asserts the EXACT CSP + Permissions-Policy values, so removing the
 *     header-set in `staticSecurityHeaders` turns them null and the assertions go RED;
 *   - the auth-route-404 test asserts 404 for `/v1/auth/me`; the normal path (`assembleServer` →
 *     `createAuthApp`) mounts `GET /v1/auth/me` behind `requireAuth()`, so it would answer 401 there —
 *     the 404 here is the surface being ABSENT, and mounting any auth route makes it non-404 (RED).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrontendSpec } from '@rayspec/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleStaticServer,
  DEFAULT_FRONTEND_CSP,
  DEFAULT_PERMISSIONS_POLICY,
  loadStaticServerConfig,
  type StaticBootedServer,
  type StaticServerConfig,
} from './composition-root.js';

const INDEX_SENTINEL = 'INDEX-HTML-SENTINEL-static-boot';
const ASSET_SENTINEL = 'ASSET-JS-SENTINEL-static-boot';

let root = ''; // the temp root; the spec "lives" at root/rayspec.yaml, assets under root/web/dist
const SPA_MOUNT: FrontendSpec = { route: '/', dir: 'web/dist', spa: true };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rayspec-static-boot-'));
  mkdirSync(join(root, 'web', 'dist', 'assets'), { recursive: true });
  writeFileSync(
    join(root, 'web', 'dist', 'index.html'),
    `<!doctype html><title>${INDEX_SENTINEL}</title>`,
    'utf8',
  );
  writeFileSync(
    join(root, 'web', 'dist', 'assets', 'app.js'),
    `console.log('${ASSET_SENTINEL}');`,
    'utf8',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Assemble a static boot over the fixture, with an optional config override (defaults otherwise). */
function buildStatic(override: Partial<StaticServerConfig> = {}): StaticBootedServer {
  const config: StaticServerConfig = { ...loadStaticServerConfig({}), ...override };
  return assembleStaticServer(config, {
    specPath: join(root, 'rayspec.yaml'),
    frontend: [SPA_MOUNT],
  });
}

describe('static boot — DB-less / secret-less assembly', () => {
  it('assembles with NO DATABASE_URL / JWT signing key / api-key pepper set', () => {
    // These are simply never read on this path — construction must not touch them.
    const server = buildStatic();
    expect(typeof server.app.fetch).toBe('function');
    expect(server.frontendMounts).toHaveLength(1);
  });

  it('close() is a no-op (no DB pool / no durable worker to drain)', async () => {
    const server = buildStatic();
    await expect(server.close()).resolves.toBeUndefined();
  });
});

describe('static boot — serves the frontend', () => {
  it('GET / → 200 served index.html (text/html + sentinel)', async () => {
    const { app } = buildStatic();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain(INDEX_SENTINEL);
  });

  it('GET /assets/app.js → 200 served asset', async () => {
    const { app } = buildStatic();
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(ASSET_SENTINEL);
  });

  it('a deep link (spa:true) → 200 index.html shell', async () => {
    const { app } = buildStatic();
    const res = await app.request('/dashboard/deep/link');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_SENTINEL);
  });
});

describe('static boot — /health is liveness-only (no database)', () => {
  it('GET /health → 200 {status:"ok"} with the db field OMITTED (never a lie, never a 503)', async () => {
    const { app } = buildStatic();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'ok' });
    expect(body).not.toHaveProperty('db');
  });
});

describe('static boot — the auth surface is NOT mounted (load-bearing security assertion)', () => {
  // On the normal path createAuthApp mounts each of these; here the code that mounts them is never
  // reached, so every one is a uniform 404 — the surface is absent, not merely unauthenticated.
  const authPaths = [
    '/v1/auth/me',
    '/v1/auth/login',
    '/v1/orgs',
    '/v1/openapi.json',
    '/oidc/.well-known/openid-configuration',
  ];
  for (const path of authPaths) {
    it(`GET ${path} → 404 (auth/OIDC/runs surface not mounted)`, async () => {
      const { app } = buildStatic();
      const res = await app.request(path);
      expect(res.status).toBe(404);
    });
  }
});

describe('static boot — security-header parity (net-new fail-the-fix coverage)', () => {
  it('GET / carries CSP + Permissions-Policy AND the four base headers', async () => {
    const { app } = buildStatic();
    const res = await app.request('/');
    // The two headers the normal chain leaves to nginx — a native (nginx-less) serve must add them.
    expect(res.headers.get('content-security-policy')).toBe(DEFAULT_FRONTEND_CSP);
    expect(res.headers.get('permissions-policy')).toBe(DEFAULT_PERMISSIONS_POLICY);
    // The four the normal chain already emits — full parity.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('a served asset ALSO carries CSP + Permissions-Policy', async () => {
    const { app } = buildStatic();
    const res = await app.request('/assets/app.js');
    expect(res.headers.get('content-security-policy')).toBe(DEFAULT_FRONTEND_CSP);
    expect(res.headers.get('permissions-policy')).toBe(DEFAULT_PERMISSIONS_POLICY);
  });

  it('an operator CSP / Permissions-Policy override is emitted verbatim', async () => {
    const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'";
    const permissionsPolicy = 'camera=(), microphone=(), geolocation=(self)';
    const { app } = buildStatic({ frontendCsp: csp, permissionsPolicy });
    const res = await app.request('/');
    expect(res.headers.get('content-security-policy')).toBe(csp);
    expect(res.headers.get('permissions-policy')).toBe(permissionsPolicy);
  });
});

describe('static boot — a custom 404.html page carries the security-header chain', () => {
  // A DEDICATED fixture (spa:false, an index.html + a 404.html) proves the boot-level composition:
  // the post-`next` static security chain wraps the custom 404 response the same as a served 200, so a
  // native (nginx-less) serve still emits nosniff + CSP on the not-found page.
  const NOTFOUND_SENTINEL = 'STATIC-BOOT-404-PAGE-SENTINEL';
  let customRoot = '';

  beforeAll(() => {
    customRoot = mkdtempSync(join(tmpdir(), 'rayspec-static-boot-404-'));
    mkdirSync(join(customRoot, 'web', 'dist'), { recursive: true });
    writeFileSync(
      join(customRoot, 'web', 'dist', 'index.html'),
      `<!doctype html><title>${INDEX_SENTINEL}</title>`,
      'utf8',
    );
    writeFileSync(
      join(customRoot, 'web', 'dist', '404.html'),
      `<!doctype html><title>${NOTFOUND_SENTINEL}</title>`,
      'utf8',
    );
  });

  afterAll(() => {
    rmSync(customRoot, { recursive: true, force: true });
  });

  it('a genuine miss → 404 with the 404.html bytes AND the static security headers', async () => {
    const config: StaticServerConfig = loadStaticServerConfig({});
    const { app } = assembleStaticServer(config, {
      specPath: join(customRoot, 'rayspec.yaml'),
      frontend: [{ route: '/', dir: 'web/dist', spa: false }],
    });
    const res = await app.request('/no/such/deep/link');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain(NOTFOUND_SENTINEL);
    // The post-`next` static security chain wraps the custom 404 response, not only served 200s.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(DEFAULT_FRONTEND_CSP);
  });
});
