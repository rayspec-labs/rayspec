/**
 * Static FRONTEND serving boot test — the composition root mounts a deployed spec's declared
 * `frontend[]` static assets alongside the API, AFTER every API/auth/`/health` route. This drives the
 * REAL composition root (`assembleServer`) against a throwaway DATABASE with the `examples/notes-ui`
 * document (a `notes` store + `/api/notes` CRUD + a `/` SPA frontend), asserting END-TO-END on ground
 * truth (fail-the-fix, not pass-the-shape):
 *
 *   (a) STATIC PUBLIC: `GET /` (no token) → 200 text/html + the index.html sentinel — the mount is
 *       public (authenticate never self-401s) and serves the built asset from `web/dist`.
 *   (b) SPA FALLBACK: `GET /dashboard` (an unmatched deep link, no token) → 200 index.html (spa:true).
 *   (c) API PRECEDENCE: an authed `POST /api/notes` → 201, and `GET /api/notes` round-trips a JSON
 *       list — NOT the SPA shell. The declared store routes are registered BEFORE the `/` catch-all,
 *       so an API path is answered by its route, never the static mount.
 *   (d) RESERVED ROUTE: `GET /health` → 200 health JSON — never shadowed by the `/` static mount.
 *
 * DB ISOLATION: a whole throwaway DATABASE (not a per-schema), exactly as boot.smoke.test.ts /
 * stream-blob-boot.db.test.ts — the migration chain materializes the platform into a database's
 * default + `drizzle` schema, so per-schema isolation does not fit the chain-based boot.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/app/server/src -> repo-root/examples/notes-ui
const NOTES_UI_DIR = resolve(here, '../../../../examples/notes-ui');
const NOTES_UI_YAML = resolve(NOTES_UI_DIR, 'rayspec.yaml');
// A unique substring of examples/notes-ui/web/dist/index.html — proves the static asset itself was
// served (not merely some 200). If the mount served the wrong file this would miss.
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

const SUITE_DB = `rayspec_server_frontend_${process.pid}`;

describe('static frontend serving — composition root mounts declared frontend[] alongside the API', () => {
  const baseUrl = process.env.DATABASE_URL;
  // DB-backed: skip cleanly when there is no Postgres (mirrors the other boot suites' guard).
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed boot suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'frontend-serve-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
        'absent — refusing to silently skip this DB-backed suite.',
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

    // Snapshot every env var we mutate (restored in afterAll), then provision the boot secrets + point
    // the boot at the notes-ui spec (its handler root defaults to the spec dir; there are no handlers).
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'frontend-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8807';
    process.env.RAYSPEC_SPEC_PATH = NOTES_UI_YAML;

    if (baseUrl) {
      const config = loadServerConfig();
      server = await assembleServer(config, {
        // The LOCAL table-registration stand-in: register THESE exact product-table instances (deploy() verifies the
        // same objects). notes-ui has no handlers/agents/stream — a plain store+api+frontend boot.
        registerProductTables: (tables) => {
          registerScopedTables([...tables.values()]);
        },
      });
    }
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

  maybe('boots the notes-ui spec (materialized) with the store + frontend mounted', () => {
    if (!server) throw new Error('server did not boot');
    expect(server.deployMode).toBe('materialized');
    // The declared CRUD routes are present in the boot summary (proves the api section mounted).
    const paths = server.declaredRoutes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /api/notes');
    expect(paths).toContain('POST /api/notes');
  });

  maybe(
    '(a) STATIC PUBLIC: GET / (no token) serves index.html (200 text/html + sentinel)',
    async () => {
      if (!server) throw new Error('server did not boot');
      const res = await server.app.request('/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(await res.text()).toContain(INDEX_SENTINEL);
    },
  );

  maybe('(b) SPA FALLBACK: GET /dashboard (no token) returns index.html (200)', async () => {
    if (!server) throw new Error('server did not boot');
    const res = await server.app.request('/dashboard');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_SENTINEL);
  });

  maybe('(d) RESERVED: GET /health returns the health JSON, never the / static mount', async () => {
    if (!server) throw new Error('server did not boot');
    const res = await server.app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('ok'); // the platform readiness JSON, not the SPA shell
  });

  maybe(
    '(c) API PRECEDENCE: authed POST /api/notes → 201 and GET /api/notes lists JSON (not the SPA shell)',
    async () => {
      if (!server) throw new Error('server did not boot');
      const app = server.app;

      // Register → org → switch → a member token (store:write gates the create).
      const reg = await app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'frontend-boot@example.test',
          password: 'correct-horse-battery-staple-9',
        }),
      });
      expect(reg.status).toBe(201);
      const t0 = (await reg.json()).accessToken as string;

      const orgRes = await app.request('/v1/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t0}` },
        body: JSON.stringify({ name: 'Notes Co' }),
      });
      expect(orgRes.status).toBe(201);
      const orgId = (await orgRes.json()).id as string;

      const switchRes = await app.request(`/v1/orgs/${orgId}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t0}` },
      });
      expect(switchRes.status).toBe(200);
      const token = (await switchRes.json()).accessToken as string;

      // POST /api/notes → 201 (the declared store route wins over the `/` static mount).
      const created = await app.request('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'Buy milk', body: 'from the store route' }),
      });
      expect(created.status).toBe(201);
      const row = (await created.json()) as { id: string; title: string };
      expect(row.title).toBe('Buy milk');

      // GET /api/notes → a JSON list round-trip. GROUND TRUTH of precedence: the response is the store
      // list (application/json array containing the created note), NOT the static SPA shell.
      const list = await app.request('/api/notes', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.status).toBe(200);
      expect(list.headers.get('content-type')).toMatch(/application\/json/);
      const listText = await list.text();
      expect(listText).not.toContain(INDEX_SENTINEL); // NOT the SPA shell
      const rows = JSON.parse(listText) as Array<{ title: string }>;
      expect(rows.some((r) => r.title === 'Buy milk')).toBe(true);
    },
    120_000,
  );

  maybe(
    '(e) FAIL-CLOSED: a spec whose frontend.dir is missing aborts the boot with BootConfigError',
    async () => {
      // A spec declaring the SAME `notes` store (so the live schema present-matches → no drift throw)
      // but a frontend `dir` that does NOT exist → deployDeclaredSpec's frontend guard fires. GREEN only
      // because the guard throws the specific BootConfigError naming the frontend route + dir (flip the
      // `throw new BootConfigError(...)` off and the boot proceeds → this arm goes red). The failed boot
      // leaves makeDb()'s pool un-closed (assembleServer throws before returning a close()); the
      // throwaway DB is dropped WITH (FORCE) in afterAll.
      const tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-frontend-missing-'));
      const badSpecPath = join(tmpDir, 'rayspec.yaml');
      writeFileSync(
        badSpecPath,
        `version: '1.0'
metadata:
  name: notes-ui-missing-frontend
stores:
  - name: notes
    columns:
      - { name: title, type: text }
      - { name: body, type: text, nullable: true }
api:
  - { method: GET, path: '/api/notes', action: { kind: store, store: notes, op: list } }
frontend:
  - { route: /, dir: web/does-not-exist, spa: true }
`,
        'utf8',
      );
      process.env.RAYSPEC_SPEC_PATH = badSpecPath;
      const config = loadServerConfig();
      let caught: unknown;
      try {
        await assembleServer(config, {
          registerProductTables: (tables) => {
            registerScopedTables([...tables.values()]);
          },
        });
      } catch (err) {
        caught = err;
      } finally {
        process.env.RAYSPEC_SPEC_PATH = NOTES_UI_YAML; // restore
        rmSync(tmpDir, { recursive: true, force: true });
      }
      expect(caught).toBeInstanceOf(BootConfigError);
      expect((caught as BootConfigError).message).toMatch(/frontend/i);
      expect((caught as BootConfigError).message).toContain('web/does-not-exist');
    },
    120_000,
  );
});
