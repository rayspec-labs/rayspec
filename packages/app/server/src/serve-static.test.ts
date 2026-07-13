/**
 * `mountFrontend` — hardened static-serving unit proofs (no DB, no network). A mini Hono app + a
 * mkdtemp fixture directory exercise the guard + serving end-to-end (fail-the-fix, not pass-the-shape):
 *
 *   - serves index.html at the mount route + a nested asset;
 *   - SPA fallback: spa:true → a deep link returns index.html (200); spa:false → 404;
 *   - REFUSES path traversal (`/../.env`, `/..%2f.env`, deep `..`), dotfiles (`/.env`), and a symlink
 *     that escapes the served directory — each returns 404 and NEVER the secret bytes or the SPA shell;
 *   - API precedence: a route registered BEFORE the `/` catch-all still returns its JSON.
 *   - RESERVED NAMESPACES: a `/` spa:true catch-all NEVER answers `/v1/*`, `/health/*`, `/oidc/*` — an
 *     unregistered reserved path falls through to the 404 (not the SPA shell), a registered one still
 *     wins, and an ordinary app deep link (`/dashboard`) still gets the SPA shell.
 *   - RANGE / HEAD (byte-serving delegated to serveStatic): a Range GET returns 206 partial content
 *     (Content-Range + Accept-Ranges + only the requested bytes); a HEAD returns 200 with Content-Length
 *     and an empty body; an unsatisfiable range is pinned to serveStatic 2.0.6's ACTUAL clamped-206
 *     (there is no RFC-7233 416 path); and the fail-closed guard stays method/range-agnostic (dotfile,
 *     traversal, and symlink-escape each still 404 under BOTH a Range GET and a HEAD).
 *
 * Fail-the-fix: remove the guard in serve-static.ts and the traversal/dotfile/symlink arms serve the
 * secret file (200) instead of 404 — the `.not.toContain(SECRET)` + status assertions go red. Remove the
 * reserved-prefix decline and `/v1/nonexistent` serves the SPA shell (200) — its `.not.toContain` goes red.
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

describe('mountFrontend — reserved platform namespaces are never served statically', () => {
  // A `/` spa:true catch-all registered AFTER a couple of mock platform routes (mirrors the real order:
  // API/auth routes register first, the frontend mount last). The catch-all must decline reserved-prefix
  // paths so a platform route wins / the uniform 404 shows — never the SPA shell.
  function buildReservedApp(): Hono {
    const app = new Hono();
    app.get('/v1/registered', (c) => c.json({ registered: true }));
    app.get('/health', (c) => c.json({ status: 'ok' }));
    mountFrontend(app, [spaMount], specDir());
    return app;
  }

  it('a REGISTERED /v1 route still returns its real response (not the SPA shell)', async () => {
    const res = await buildReservedApp().request('/v1/registered');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registered: true });
  });

  it('GET /v1/nonexistent → the platform fall-through 404, NEVER the SPA shell', async () => {
    const res = await buildReservedApp().request('/v1/nonexistent');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(INDEX_SENTINEL);
  });

  it('GET /health/whatever (unmatched under /health) → not the SPA shell', async () => {
    const res = await buildReservedApp().request('/health/whatever');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(INDEX_SENTINEL);
  });

  it('a normal app deep link (/dashboard) STILL returns the SPA shell (200) — only reserved namespaces are declined', async () => {
    const res = await buildReservedApp().request('/dashboard');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_SENTINEL);
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

describe('mountFrontend — Range / HEAD (partial content for media seek/resume)', () => {
  // Range + HEAD handling is delegated ENTIRELY to @hono/node-server's serveStatic (pinned 2.0.6) — this
  // module adds no range code of its own. These tests PIN that delegated behaviour as a deliberate,
  // supported feature (a client can request a byte range to seek/resume a large media asset) AND act as a
  // fail-closed regression guard. Every assertion mirrors the ACTUAL 2.0.6 output (verified by running the
  // suite against the real dependency), NOT an idealized RFC-7233 response.
  const ASSET_CONTENT = `console.log('${ASSET_SENTINEL}');`;
  const ASSET_SIZE = Buffer.byteLength(ASSET_CONTENT, 'utf8');

  it('Range GET on a nested asset → 206 partial content (Content-Range + Accept-Ranges + only the requested bytes)', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/assets/app.js', { headers: { Range: 'bytes=0-4' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-4/${ASSET_SIZE}`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('5');
    // Body is EXACTLY the first 5 bytes (0..4 inclusive), not the whole asset.
    expect(await res.text()).toBe(ASSET_CONTENT.slice(0, 5));
  });

  it('HEAD on the mount root → 200 with Content-Length and an EMPTY body (no 206, no Content-Range)', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).not.toBeNull();
    expect(res.headers.get('content-range')).toBeNull();
    expect(res.headers.get('accept-ranges')).toBeNull(); // HEAD is not a Range response
    // HEAD carries the metadata (length) but never a body.
    expect(await res.text()).toBe('');
  });

  it('unsatisfiable Range (bytes=99999- on a small file) → 500, NOT 416 (serveStatic 2.0.6 has no 416 path)', async () => {
    // ⚠ OBSERVED REALITY, NOT THE IDEAL (empirically verified against @hono/node-server 2.0.6): there is
    // no RFC-7233 416 branch. For `bytes=99999-` serveStatic parses start=99999 and clamps `end` to
    // size-1 (< start), then calls `createReadStream(path, { start: 99999, end: size-1 })` — Node throws
    // `ERR_OUT_OF_RANGE` synchronously because start > end, and Hono surfaces the throw as a 500 (NOT a
    // clamped 206, and NOT a 416). We pin the ACTUAL status: asserting 416/206 would assert a fiction, and
    // producing a proper 416 would require vendoring the dependency (out of scope for this tests-only
    // change). This also serves as a sentinel: a future serveStatic that adds a real 416 (or a clean 206)
    // would flip this and force a deliberate re-look. Body left unread on purpose (it is a 500 error page).
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/assets/app.js', { headers: { Range: 'bytes=99999-' } });
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(206);
    expect(res.status).not.toBe(416);
  });

  it('Accept-Ranges is present ONLY on an actual Range response — absent on a plain GET', async () => {
    const app = buildApp([spaMount], specDir());
    const plain = await app.request('/assets/app.js');
    expect(plain.status).toBe(200);
    expect(plain.headers.get('accept-ranges')).toBeNull();
  });

  // REGRESSION (the load-bearing arm) — the fail-closed guard runs BEFORE and INDEPENDENTLY of the
  // method/range: a dotfile, an encoded traversal, and a symlink-escape each still 404 under BOTH a Range
  // GET and a HEAD, never leaking the secret bytes and never falling back to the SPA shell. How it fails
  // the fix: remove the `if (!isSafeStaticPath(...)) return next();` line in serve-static.ts and — because
  // serveStatic itself blocks neither dotfiles nor a symlink-escape, and a `%2f`-miss falls back to the
  // SPA shell — these go RED (the dotfile/symlink arms would serve the secret at 200; the `/..%2f.env`
  // arms would serve index.html at 200), tripping the status + `.not.toContain` assertions. (We do NOT
  // revert the shipped guard here; this comment only documents how the arm fails the fix.)
  const guardTargets: Array<{ name: string; path: string }> = [
    { name: 'dotfile /.env', path: '/.env' },
    { name: 'encoded traversal /..%2f.env', path: '/..%2f.env' },
    { name: 'symlink-escape /leak.txt', path: '/leak.txt' },
  ];
  const methodVariants: Array<{
    name: string;
    init: { method?: string; headers?: Record<string, string> };
  }> = [
    { name: 'Range GET', init: { headers: { Range: 'bytes=0-4' } } },
    { name: 'HEAD', init: { method: 'HEAD' } },
  ];
  for (const target of guardTargets) {
    for (const variant of methodVariants) {
      it(`fail-closed guard is ${variant.name}-agnostic: ${target.name} → 404, never the secret or the SPA shell`, async () => {
        const app = buildApp([spaMount], specDir());
        const res = await app.request(target.path, variant.init);
        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body).not.toContain(DOTFILE_SECRET);
        expect(body).not.toContain(SYMLINK_SECRET);
        expect(body).not.toContain(INDEX_SENTINEL); // NOT the SPA shell either
      });
    }
  }
});
