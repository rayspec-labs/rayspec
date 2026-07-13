/**
 * `mountFrontend` — hardened static-serving unit proofs (no DB, no network). A mini Hono app + a
 * mkdtemp fixture directory exercise the guard + serving end-to-end (fail-the-fix, not pass-the-shape):
 *
 *   - serves index.html at the mount route + a nested asset;
 *   - SPA fallback: spa:true → a deep link returns index.html (200); spa:false → 404;
 *   - REFUSES path traversal (`/../.env`, `/..%2f.env`, deep `..`), dotfiles (`/.env`), and a symlink
 *     that escapes the served directory — each returns 404 and NEVER the secret bytes or the SPA shell;
 *   - API precedence: a route registered BEFORE the `/` catch-all still returns its JSON.
 *
 * Fail-the-fix: remove the guard in serve-static.ts and the traversal/dotfile/symlink arms serve the
 * secret file (200) instead of 404 — the `.not.toContain(SECRET)` + status assertions go red.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrontendSpec } from '@rayspec/spec';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountFrontend } from './serve-static.js';

const INDEX_SENTINEL = 'INDEX-HTML-SENTINEL-notes-ui';
const ASSET_SENTINEL = 'ASSET-JS-SENTINEL';
const DOTFILE_SECRET = 'DOTFILE-SECRET-must-never-serve';
const SYMLINK_SECRET = 'SYMLINK-OUTSIDE-SECRET-must-never-serve';

let webDir = ''; // the served directory (holds index.html + assets/ + a .env dotfile + a leaking symlink)
let outsideDir = ''; // a sibling dir OUTSIDE webDir — the symlink target + the deep-traversal target

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'rayspec-serve-static-'));
  webDir = join(root, 'web', 'dist');
  outsideDir = join(root, 'outside');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  writeFileSync(
    join(webDir, 'index.html'),
    `<!doctype html><title>${INDEX_SENTINEL}</title>`,
    'utf8',
  );
  writeFileSync(join(webDir, 'assets', 'app.js'), `console.log('${ASSET_SENTINEL}');`, 'utf8');
  // A dotfile INSIDE the served dir — the guard must never serve it (dotfiles are refused).
  writeFileSync(join(webDir, '.env'), `SECRET=${DOTFILE_SECRET}`, 'utf8');
  // A secret file OUTSIDE the served dir + a symlink INSIDE the served dir pointing at it — the
  // symlink-escape guard must refuse to follow it out of the served directory.
  writeFileSync(join(outsideDir, 'secret.txt'), SYMLINK_SECRET, 'utf8');
  symlinkSync(join(outsideDir, 'secret.txt'), join(webDir, 'leak.txt'));
});

afterAll(() => {
  // Remove the whole temp root (one level up from webDir/outsideDir).
  rmSync(join(webDir, '..', '..'), { recursive: true, force: true });
});

/** A mini app: an API route registered FIRST, then the frontend mount(s) — mirrors the real order. */
function buildApp(mounts: FrontendSpec[], specDir: string): Hono {
  const app = new Hono();
  app.get('/api/ping', (c) => c.json({ pong: true }));
  mountFrontend(app, mounts, specDir);
  return app;
}

const spaMount: FrontendSpec = { route: '/', dir: 'web/dist', spa: true };
const plainMount: FrontendSpec = { route: '/', dir: 'web/dist', spa: false };
/** The specDir is `webDir/../..` (the temp root), so `web/dist` resolves back to webDir. */
function specDir(): string {
  return join(webDir, '..', '..');
}

describe('mountFrontend — serving', () => {
  it('serves index.html at the mount route (200 text/html + sentinel)', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain(INDEX_SENTINEL);
  });

  it('serves a nested asset (200 + content)', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(ASSET_SENTINEL);
  });
});

describe('mountFrontend — SPA fallback', () => {
  it('spa:true — an unmatched deep link returns index.html (200)', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/dashboard/deep/link');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_SENTINEL);
  });

  it('spa:false — an unmatched deep link falls through to 404 (no fallback)', async () => {
    const app = buildApp([plainMount], specDir());
    const res = await app.request('/dashboard/deep/link');
    expect(res.status).toBe(404);
  });
});

describe('mountFrontend — hardened guard (fail-closed)', () => {
  // Every traversal/dotfile/symlink arm runs against a SPA mount: proving they still 404 (not the SPA
  // shell) is the stronger check — the guard short-circuits BEFORE the file/SPA server.
  const arms: Array<{ name: string; path: string }> = [
    { name: 'encoded single traversal (/..%2f.env)', path: '/..%2f.env' },
    { name: 'encoded dot-segment (/%2e%2e/.env)', path: '/%2e%2e/.env' },
    { name: 'deep encoded traversal', path: '/a/..%2f..%2f..%2foutside/secret.txt' },
    { name: 'dotfile (/.env)', path: '/.env' },
  ];
  for (const arm of arms) {
    it(`refuses ${arm.name} → 404, never the secret or the SPA shell`, async () => {
      const app = buildApp([spaMount], specDir());
      const res = await app.request(arm.path);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(DOTFILE_SECRET);
      expect(body).not.toContain(SYMLINK_SECRET);
      expect(body).not.toContain(INDEX_SENTINEL); // NOT the SPA shell either
    });
  }

  it('refuses a symlink that escapes the served directory → 404, never the outside secret', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/leak.txt');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SYMLINK_SECRET);
  });
});

describe('mountFrontend — API precedence', () => {
  it('an API route registered BEFORE the / catch-all still returns its JSON, not the SPA shell', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/api/ping');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ pong: true });
  });
});

describe('mountFrontend — non-root mount + longest-route-first ordering', () => {
  it('serves a non-root mount and does not shadow a more-specific prefix', async () => {
    // Two mounts sharing the tree: a specific `/admin` mount + a `/` catch-all. Longest-first
    // registration means `/admin/*` wins for admin paths, `/` serves everything else. Both served
    // dirs are created BEFORE the mount (as the real boot guard guarantees) so `realpathSync` resolves.
    const root = mkdtempSync(join(tmpdir(), 'rayspec-serve-order-'));
    mkdirSync(join(root, 'web', 'dist'), { recursive: true });
    mkdirSync(join(root, 'admin'), { recursive: true });
    writeFileSync(
      join(root, 'web', 'dist', 'index.html'),
      `<!doctype html><title>${INDEX_SENTINEL}</title>`,
      'utf8',
    );
    writeFileSync(
      join(root, 'admin', 'index.html'),
      '<!doctype html><title>ADMIN-SENTINEL</title>',
      'utf8',
    );
    try {
      const app = new Hono();
      mountFrontend(
        app,
        [
          { route: '/', dir: 'web/dist', spa: true },
          { route: '/admin', dir: 'admin', spa: false },
        ],
        root,
      );

      const adminRes = await app.request('/admin');
      expect(adminRes.status).toBe(200);
      expect(await adminRes.text()).toContain('ADMIN-SENTINEL');

      // A path under the root mount (not /admin) serves the root index — the /admin mount does not swallow it.
      const rootRes = await app.request('/');
      expect(rootRes.status).toBe(200);
      expect(await rootRes.text()).toContain(INDEX_SENTINEL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
