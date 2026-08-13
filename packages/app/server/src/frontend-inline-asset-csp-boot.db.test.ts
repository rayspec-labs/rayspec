/**
 * BOOT WARNING for a served page whose inline `<style>` / `<script>` / `style=` / `on*=` the active
 * Content-Security-Policy blocks — on the FULL-BACKEND boot (`assembleServer`), the shape #313
 * extended the frontend security headers to. The static (frontend-only) shape is covered without a
 * database in `frontend-inline-asset-csp.test.ts`; both shapes must warn, because both serve the
 * declared `frontend[]` mounts under the same policy.
 *
 * Drives the REAL composition root against a throwaway DATABASE with a COPY of the
 * `examples/notes-ui` document (a `notes` store + `/api/notes` CRUD + a `/` SPA frontend) whose
 * `web/dist/index.html` this suite rewrites between boots — the shipped example's own index.html
 * carries no inline block (#345 moved its script into a file), so it could not produce the warning.
 *
 * The four arms, in boot order against the same database (boot #1 materializes, the rest mount):
 *   (a) COUNTERPROOF: index.html carries an inline `<style>`, an inline `<script>`, a `style=`
 *       attribute and an `onclick=` handler; the default policy has no `'unsafe-inline'` → the boot
 *       emits the warning NAMING `web/dist/index.html`, and the boot SUCCEEDS (warn-only): the same
 *       server answers `GET /` 200 with the file's bytes and `GET /health` 200.
 *   (b) ACCEPT CONTROL — a clean page: the same tree with the inline blocks moved into `/app.js`
 *       emits NO such warning. A warning that always fires proves nothing.
 *   (c) ACCEPT CONTROL — the active policy permits it: the offending page again, but with
 *       RAYSPEC_FRONTEND_CSP set to a policy carrying `'unsafe-inline'` for both directives → NO
 *       warning. The check reads the ACTIVE policy, not the shipped default.
 *   (d) The env override is what makes (c) silent, not the re-boot: the same offending tree with
 *       RAYSPEC_FRONTEND_CSP cleared warns again.
 *
 * DB ISOLATION: a whole throwaway DATABASE (not a per-schema), exactly as
 * frontend-mount-security-headers.db.test.ts — the migration chain materializes the platform into a
 * database's default + `drizzle` schema, so per-schema isolation does not fit the chain-based boot.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/app/server/src -> repo-root/examples/notes-ui
const NOTES_UI_DIR = resolve(here, '../../../../examples/notes-ui');

/** A page whose four inline shapes are all governed by `default-src` under the shipped policy. */
const OFFENDING_INDEX = `<!doctype html>
<html lang="en">
  <head><title>Notes UI</title><style>body { color: #222 }</style></head>
  <body>
    <main id="app" data-static-frontend="notes-ui" style="padding: 1rem">
      <button onclick="location.reload()">reload</button>
    </main>
    <script>document.title = 'inline';</script>
  </body>
</html>
`;

/** The same page with every inline block moved into the served `/app.js` — nothing to warn about. */
const CLEAN_INDEX = `<!doctype html>
<html lang="en">
  <head><title>Notes UI</title><link rel="stylesheet" href="/app.css" /></head>
  <body>
    <main id="app" data-static-frontend="notes-ui"><ul id="notes"></ul></main>
    <script src="/app.js" defer></script>
  </body>
</html>
`;

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

const SUITE_DB = `rayspec_server_inline_asset_csp_${process.pid}`;

describe('boot warning — an inline asset the active CSP blocks (full-backend boot)', () => {
  const baseUrl = process.env.DATABASE_URL;
  // DB-backed: skip cleanly when there is no Postgres (mirrors the other boot suites' guard).
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed boot suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'frontend-inline-asset-csp-boot.db.test: DATABASE_URL is required (CI / ' +
        'RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let specRoot = '';
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

  /** Boot the real composition root over the fixture, capturing every boot warning it emitted. */
  async function boot(): Promise<string[]> {
    const warnings: string[] = [];
    const config = loadServerConfig();
    server = await assembleServer(config, {
      registerProductTables: (tables) => {
        registerScopedTables([...tables.values()]);
      },
      bootWarn: (message) => warnings.push(message),
    });
    return warnings;
  }

  /** The warning lines this suite is about (the boot may emit unrelated ones). */
  function inlineWarnings(warnings: readonly string[]): string[] {
    return warnings.filter((w) => w.includes('Content-Security-Policy'));
  }

  beforeAll(async () => {
    if (!baseUrl) return;

    // A COPY of the shipped example beside a rewritable web/dist (the example itself is read-only
    // to this suite — it is the accept control the other frontend suites assert against).
    specRoot = mkdtempSync(join(tmpdir(), 'rayspec-inline-asset-csp-'));
    mkdirSync(join(specRoot, 'web', 'dist'), { recursive: true });
    copyFileSync(join(NOTES_UI_DIR, 'rayspec.yaml'), join(specRoot, 'rayspec.yaml'));
    copyFileSync(
      join(NOTES_UI_DIR, 'web', 'dist', 'app.js'),
      join(specRoot, 'web', 'dist', 'app.js'),
    );
    writeFileSync(join(specRoot, 'web', 'dist', 'index.html'), OFFENDING_INDEX, 'utf8');

    // Fresh empty throwaway APP database (drop any leftover from a crashed prior run first).
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'inline-asset-csp-pepper-only';
    process.env.DATABASE_URL = withDbName(baseUrl, SUITE_DB);
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8813';
    process.env.RAYSPEC_SPEC_PATH = join(specRoot, 'rayspec.yaml');
    // Deleted so boot #1 runs under the SHIPPED default policy (an ambient value would fake it).
    delete process.env.RAYSPEC_FRONTEND_CSP;
    delete process.env.RAYSPEC_PERMISSIONS_POLICY;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (specRoot) rmSync(specRoot, { recursive: true, force: true });
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
    '(a) an inline <style>/<script>/style=/on*= under the default policy warns, naming the file — and the boot SUCCEEDS',
    async () => {
      const warnings = inlineWarnings(await boot());
      expect(warnings).toHaveLength(1);
      const [warning] = warnings;
      // The FILE, relative to the spec — the thing an operator has to go open.
      expect(warning).toContain('web/dist/index.html');
      expect(warning).toContain('inline <style> element');
      expect(warning).toContain('inline <script> element');
      expect(warning).toContain('style= attribute');
      expect(warning).toContain('on*= handler attribute');

      // WARN-ONLY: the boot completed and the offending page still serves, bytes intact.
      if (!server) throw new Error('server did not boot');
      const res = await server.app.request('/');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<style>body { color: #222 }</style>');
      const health = await server.app.request('/health');
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok', db: 'ok', frontend: 'ok' });
    },
    120_000,
  );

  maybe(
    '(b) ACCEPT CONTROL: a clean page under the same policy warns about nothing',
    async () => {
      await server?.close();
      server = undefined;
      writeFileSync(join(specRoot, 'web', 'dist', 'index.html'), CLEAN_INDEX, 'utf8');

      const warnings = inlineWarnings(await boot());
      expect(warnings).toEqual([]);
      if (!server) throw new Error('server did not boot');
      expect(server.deployMode).toBe('mounted'); // same DB, same spec — the re-boot path
    },
    120_000,
  );

  maybe(
    '(c) ACCEPT CONTROL: RAYSPEC_FRONTEND_CSP permitting the inline block silences the warning',
    async () => {
      await server?.close();
      server = undefined;
      writeFileSync(join(specRoot, 'web', 'dist', 'index.html'), OFFENDING_INDEX, 'utf8');
      // The operator has already made the choice this warning exists to prompt.
      process.env.RAYSPEC_FRONTEND_CSP =
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'";

      expect(inlineWarnings(await boot())).toEqual([]);
    },
    120_000,
  );

  maybe(
    '(d) the override is what silenced (c): the same tree with it cleared warns again',
    async () => {
      await server?.close();
      server = undefined;
      delete process.env.RAYSPEC_FRONTEND_CSP;

      const warnings = inlineWarnings(await boot());
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('web/dist/index.html');
    },
    120_000,
  );
});
