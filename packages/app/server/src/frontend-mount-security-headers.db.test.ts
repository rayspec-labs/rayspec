/**
 * FRONTEND-MOUNT security headers on a FULL-BACKEND boot — the composition root (`assembleServer`)
 * serves a deployed spec's `frontend[]` mounts WITH the same Content-Security-Policy +
 * Permissions-Policy the static (frontend-only) profile emits, honouring the SAME env overrides
 * (RAYSPEC_FRONTEND_CSP / RAYSPEC_PERMISSIONS_POLICY) — while the API/auth surface stays exactly as
 * it is (the global `securityHeaders` chain, NO CSP). Drives the REAL composition root against a
 * throwaway DATABASE with the `examples/notes-ui` document (a `notes` store + `/api/notes` CRUD + a
 * `/` SPA frontend), asserting END-TO-END on ground truth (fail-the-fix, not pass-the-shape):
 *
 *   (a) MOUNT DEFAULTS: `GET /` (the served index.html) carries Content-Security-Policy +
 *       Permissions-Policy with the EXACT static-profile default values (the shared DEFAULT_*
 *       constants — remove the header-set in the mount handler and both go null → RED).
 *   (b) SPA FALLBACK: `GET /dashboard` (an unmatched deep link) carries the same two headers — the
 *       fallback response is a mount response too.
 *   (c) API UNCHANGED: `GET /health` carries NEITHER header and STILL the four base headers of the
 *       global `securityHeaders` chain — the fix must not leak the frontend headers onto the
 *       API/auth surface (which deliberately leaves CSP to the fronting proxy).
 *   (d) AUTH UNCHANGED: a `/v1` response (`GET /v1/auth/me` → 401) carries neither header either.
 *   (e) ENV OVERRIDES: a re-boot (same DB → `deployMode 'mounted'`) with RAYSPEC_FRONTEND_CSP +
 *       RAYSPEC_PERMISSIONS_POLICY set emits BOTH override values verbatim on a mount response
 *       (the operator knob means the same thing in both boot shapes — e.g. a SPA using
 *       `getUserMedia` needs `microphone=(self)`), while `/health` still carries neither.
 *
 * DB ISOLATION: a whole throwaway DATABASE (not a per-schema), exactly as
 * frontend-serve-boot.db.test.ts — the migration chain materializes the platform into a database's
 * default + `drizzle` schema, so per-schema isolation does not fit the chain-based boot.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  type BootedServer,
  DEFAULT_FRONTEND_CSP,
  DEFAULT_PERMISSIONS_POLICY,
  loadServerConfig,
} from './composition-root.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/app/server/src -> repo-root/examples/notes-ui
const NOTES_UI_YAML = resolve(here, '../../../../examples/notes-ui/rayspec.yaml');
// A unique substring of examples/notes-ui/web/dist/index.html — proves the asserted response IS the
// served static asset (not merely some 200 that happens to carry headers).
const INDEX_SENTINEL = 'data-static-frontend="notes-ui"';

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const SUITE_DB = `rayspec_server_frontend_headers_${process.pid}`;

describe('frontend-mount security headers — full-backend boot parity with the static profile', () => {
  const baseUrl = process.env.DATABASE_URL;
  // DB-backed: skip cleanly when there is no Postgres (mirrors the other boot suites' guard).
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed boot suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'frontend-mount-security-headers.db.test: DATABASE_URL is required (CI / ' +
        'RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let appDbUrl = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_FRONTEND_CSP',
    'RAYSPEC_PERMISSIONS_POLICY',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);

    // Fresh empty throwaway APP database (drop any leftover from a crashed prior run first).
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    // Snapshot every env var we mutate (restored in afterAll), then provision the boot secrets +
    // point the boot at the notes-ui spec. The two header overrides are DELETED so boot #1 proves
    // the DEFAULTS (an ambient value would fake the assertion either way).
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'frontend-headers-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8811';
    process.env.RAYSPEC_SPEC_PATH = NOTES_UI_YAML;
    delete process.env.RAYSPEC_FRONTEND_CSP;
    delete process.env.RAYSPEC_PERMISSIONS_POLICY;

    const config = loadServerConfig();
    server = await assembleServer(config, {
      // The LOCAL table-registration stand-in (deploy() verifies the same objects). notes-ui has no
      // handlers/agents/stream — a plain store+api+frontend boot.
      registerProductTables: (tables) => {
        registerScopedTables([...tables.values()]);
      },
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  maybe(
    '(a) MOUNT DEFAULTS: GET / (the served index.html) carries CSP + Permissions-Policy at the static-profile defaults',
    async () => {
      if (!server) throw new Error('server did not boot');
      const res = await server.app.request('/');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(INDEX_SENTINEL); // really the mount's asset
      // The SAME two values the static profile emits — shared defaults, not a copied string.
      expect(res.headers.get('content-security-policy')).toBe(DEFAULT_FRONTEND_CSP);
      expect(res.headers.get('permissions-policy')).toBe(DEFAULT_PERMISSIONS_POLICY);
    },
  );

  maybe('(b) SPA FALLBACK: GET /dashboard carries the same two headers', async () => {
    if (!server) throw new Error('server did not boot');
    const res = await server.app.request('/dashboard');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_SENTINEL);
    expect(res.headers.get('content-security-policy')).toBe(DEFAULT_FRONTEND_CSP);
    expect(res.headers.get('permissions-policy')).toBe(DEFAULT_PERMISSIONS_POLICY);
  });

  maybe(
    '(c) API UNCHANGED: GET /health carries NEITHER frontend header and still the four base headers',
    async () => {
      if (!server) throw new Error('server did not boot');
      const res = await server.app.request('/health');
      expect(res.status).toBe(200);
      // The health JSON, not a mount response.
      expect(await res.json()).toEqual({ status: 'ok', db: 'ok', frontend: 'ok' });
      // The frontend headers must NOT leak onto the API surface (CSP stays with the fronting proxy).
      expect(res.headers.get('content-security-policy')).toBeNull();
      expect(res.headers.get('permissions-policy')).toBeNull();
      // The global securityHeaders chain, unchanged.
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('strict-transport-security')).toBe(
        'max-age=31536000; includeSubDomains',
      );
    },
  );

  maybe('(d) AUTH UNCHANGED: a /v1 response (401) carries neither frontend header', async () => {
    if (!server) throw new Error('server did not boot');
    const res = await server.app.request('/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('permissions-policy')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  maybe(
    '(e) ENV OVERRIDES: a re-boot with RAYSPEC_FRONTEND_CSP / RAYSPEC_PERMISSIONS_POLICY emits both verbatim on a mount response',
    async () => {
      if (!server) throw new Error('server did not boot');
      await server.close();
      server = undefined;

      // The operator knob, same meaning as in the static profile — e.g. a SPA using getUserMedia
      // needs microphone=(self); the default denies it.
      const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'";
      const permissionsPolicy = 'camera=(), microphone=(self), geolocation=()';
      process.env.RAYSPEC_FRONTEND_CSP = csp;
      process.env.RAYSPEC_PERMISSIONS_POLICY = permissionsPolicy;

      const config = loadServerConfig();
      server = await assembleServer(config, {
        registerProductTables: (tables) => {
          registerScopedTables([...tables.values()]);
        },
      });
      // Same DB, same spec → the mount path (no re-materialize) — the override applies there too.
      expect(server.deployMode).toBe('mounted');

      const res = await server.app.request('/');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(INDEX_SENTINEL);
      expect(res.headers.get('content-security-policy')).toBe(csp);
      expect(res.headers.get('permissions-policy')).toBe(permissionsPolicy);

      // The override does not leak onto the API surface either.
      const health = await server.app.request('/health');
      expect(health.status).toBe(200);
      expect(health.headers.get('content-security-policy')).toBeNull();
      expect(health.headers.get('permissions-policy')).toBeNull();
    },
    120_000,
  );
});
