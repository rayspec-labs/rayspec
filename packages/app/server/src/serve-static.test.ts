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
 *     and an empty body; an UNSATISFIABLE range (start >= size — open OR closed beyond EOF) is intercepted
 *     by the additive validateRange guard and returned as a proper RFC-7233 416 whose Content-Range names
 *     the full size (BEFORE serveStatic, which would otherwise emit a malformed 0-byte 206 or throw a
 *     500); and the fail-closed guard stays method/range-agnostic (dotfile, traversal, and symlink-escape
 *     each still 404 under BOTH a Range GET and a HEAD).
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
  // HONORED Range + HEAD handling is delegated to @hono/node-server's serveStatic (pinned 2.0.6); the
  // module adds ONE additive guard — validateRange — that intercepts an UNSATISFIABLE range (start >= size)
  // and returns a proper RFC-7233 416 before serveStatic (which would otherwise emit a malformed 0-byte
  // 206 for a closed beyond-EOF range, or throw a 500 for an open one). Every HONORED-range assertion
  // still mirrors the ACTUAL 2.0.6 output (a client can seek/resume a large media asset); the guard only
  // changes the unsatisfiable case.
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

  it('unsatisfiable OPEN Range (bytes=99999- on a small file) → 416 with Content-Range: bytes */<size>', async () => {
    // The additive validateRange guard intercepts an unsatisfiable range BEFORE serveStatic (which would
    // otherwise clamp end < start and throw ERR_OUT_OF_RANGE → 500). start (99999) ≥ size ⇒ unsatisfiable
    // ⇒ a proper RFC-7233 416 with `Content-Range: bytes */<size>`. Correcting the old 500 to 416 is
    // deliberate and RFC-correct.
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/assets/app.js', { headers: { Range: 'bytes=99999-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${ASSET_SIZE}`);
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(206);
    expect(res.status).not.toBe(500);
  });

  it('unsatisfiable CLOSED Range (bytes=999999-1000000 beyond EOF) → 416, not a malformed 0-byte 206', async () => {
    // A CLOSED beyond-EOF range makes serveStatic 2.0.6 emit a malformed 206 (Content-Range/Content-Length
    // set, 0-byte body). start (999999) ≥ size ⇒ the guard returns a proper RFC-7233 416 instead.
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/assets/app.js', {
      headers: { Range: 'bytes=999999-1000000' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${ASSET_SIZE}`);
    expect(res.status).not.toBe(206);
  });

  it('Accept-Ranges is present ONLY on an actual Range response — absent on a plain GET', async () => {
    const app = buildApp([spaMount], specDir());
    const plain = await app.request('/assets/app.js');
    expect(plain.status).toBe(200);
    expect(plain.headers.get('accept-ranges')).toBeNull();
  });

  // METHOD-COMPLETENESS: serveStatic 2.0.6 answers HEAD/OPTIONS safely at 200 (it ignores Range for
  // them) but routes EVERY other verb through its buggy Range branch — so the additive guard fires for
  // GET AND the write verbs (POST/PUT/PATCH/DELETE) and exempts ONLY HEAD/OPTIONS. `mountFrontend`
  // registers with app.use (all methods), so each verb reaches the guard. Fail-the-fix: gate on GET-only
  // and the POST/PUT/PATCH/DELETE arms go RED (serveStatic 500s on the open range); exempt nothing and
  // the HEAD/OPTIONS arms go RED (they'd get a 416 where serveStatic answers 200).
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    it(`${method} + an unsatisfiable OPEN Range (bytes=99999-) → 416, never serveStatic's 500`, async () => {
      const app = buildApp([spaMount], specDir());
      const res = await app.request('/assets/app.js', {
        method,
        headers: { Range: 'bytes=99999-' },
      });
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe(`bytes */${ASSET_SIZE}`);
      expect(res.status).not.toBe(500);
      expect(res.status).not.toBe(206);
    });
  }

  it('POST + an unsatisfiable CLOSED Range (bytes=999999-1000000) → 416, not a malformed 0-byte 206', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/assets/app.js', {
      method: 'POST',
      headers: { Range: 'bytes=999999-1000000' },
    });
    expect(res.status).toBe(416);
    expect(res.status).not.toBe(206);
  });

  for (const method of ['HEAD', 'OPTIONS'] as const) {
    it(`${method} + an unsatisfiable Range (bytes=99999-) → 200 (serveStatic ignores Range for ${method}), never a 416`, async () => {
      const app = buildApp([spaMount], specDir());
      const res = await app.request('/assets/app.js', {
        method,
        headers: { Range: 'bytes=99999-' },
      });
      expect(res.status).toBe(200);
      expect(res.status).not.toBe(416);
    });
  }

  it('HEAD + a satisfiable Range (bytes=0-4) stays 200 (serveStatic ignores Range for HEAD)', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/assets/app.js', {
      method: 'HEAD',
      headers: { Range: 'bytes=0-4' },
    });
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(206);
  });

  // SPA fallback: a Range GET to a NON-FILE deep link on an spa:true mount misses the file server and
  // would fall through to the SPA fallback, re-running serveStatic's buggy Range math against index.html
  // (the exact 500 / malformed 206 this guard removes). The guard validates the unsatisfiable range
  // against index.html — the file the fallback will actually serve — and returns a proper 416 up front.
  it('spa:true — GET a non-file deep link with an unsatisfiable Range → 416 (guarding the SPA fallback index.html), never a 500/206', async () => {
    const INDEX_SIZE = Buffer.byteLength(`<!doctype html><title>${INDEX_SENTINEL}</title>`, 'utf8');
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/dashboard/deep', { headers: { Range: 'bytes=99999-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${INDEX_SIZE}`);
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(206);
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

describe('mountFrontend — custom 404.html page', () => {
  // Each arm mints its OWN fixture directory so it controls EXACTLY which files (index.html / 404.html /
  // assets / a dotfile / a leaking symlink) the served root holds — the shared beforeAll fixture is left
  // byte-untouched. Distinct sentinels keep the custom-page assertion from ever confusing the 404.html
  // body with the SPA shell, a real asset, or a secret.
  const CUSTOM_404_SENTINEL = 'CUSTOM-404-PAGE-SENTINEL';
  const LOCAL_INDEX_SENTINEL = 'CUSTOM-404-INDEX-SENTINEL';
  const LOCAL_ASSET_SENTINEL = 'CUSTOM-404-ASSET-SENTINEL';
  const LOCAL_DOTFILE_SECRET = 'CUSTOM-404-DOTFILE-SECRET';
  const LOCAL_SYMLINK_SECRET = 'CUSTOM-404-SYMLINK-SECRET';

  const tempRoots: string[] = [];

  /**
   * Mint a fresh served-directory fixture at `<root>/web/dist` and return its specDir (`root`, so the
   * `web/dist` mount dir resolves back under it). Each file is present only when its flag is set, so an
   * arm can assert exactly the "404.html present / absent" case it needs.
   */
  function mintFixture(opts: {
    index?: boolean;
    notFound?: boolean;
    asset?: boolean;
    dotfile?: boolean;
    symlink?: boolean;
  }): string {
    const root = mkdtempSync(join(tmpdir(), 'rayspec-custom-404-'));
    tempRoots.push(root);
    const dir = join(root, 'web', 'dist');
    mkdirSync(dir, { recursive: true });
    if (opts.index) {
      writeFileSync(
        join(dir, 'index.html'),
        `<!doctype html><title>${LOCAL_INDEX_SENTINEL}</title>`,
        'utf8',
      );
    }
    if (opts.notFound) {
      writeFileSync(
        join(dir, '404.html'),
        `<!doctype html><title>${CUSTOM_404_SENTINEL}</title>`,
        'utf8',
      );
    }
    if (opts.asset) {
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(
        join(dir, 'assets', 'app.js'),
        `console.log('${LOCAL_ASSET_SENTINEL}');`,
        'utf8',
      );
    }
    if (opts.dotfile) {
      writeFileSync(join(dir, '.env'), `SECRET=${LOCAL_DOTFILE_SECRET}`, 'utf8');
    }
    if (opts.symlink) {
      const outside = join(root, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'secret.txt'), LOCAL_SYMLINK_SECRET, 'utf8');
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.txt'));
    }
    return root;
  }

  afterAll(() => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  });

  it('spa:false — a miss with a root 404.html present → 404 text/html carrying the 404.html bytes', async () => {
    const app = buildApp([plainMount], mintFixture({ index: true, asset: true, notFound: true }));
    const res = await app.request('/no/such/page');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain(CUSTOM_404_SENTINEL);
  });

  it('spa:false — a miss with NO root 404.html → the uniform 404 (no custom page, backward compatible)', async () => {
    const app = buildApp([plainMount], mintFixture({ index: true, asset: true, notFound: false }));
    const res = await app.request('/no/such/page');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(CUSTOM_404_SENTINEL);
  });

  it('spa:true — a missed deep link still returns index.html (200), NOT the 404.html (SPA still wins)', async () => {
    const app = buildApp([spaMount], mintFixture({ index: true, notFound: true }));
    const res = await app.request('/dashboard/deep/link');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(LOCAL_INDEX_SENTINEL);
    expect(body).not.toContain(CUSTOM_404_SENTINEL);
  });

  it('a nested existing asset still serves 200 with its content even though a 404.html exists (file server still wins)', async () => {
    const app = buildApp([plainMount], mintFixture({ index: true, asset: true, notFound: true }));
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(LOCAL_ASSET_SENTINEL);
    expect(body).not.toContain(CUSTOM_404_SENTINEL);
  });

  // FAIL-CLOSED: with a 404.html present, an attack path is refused by the guard BEFORE the custom-page
  // branch, so it still gets the uniform 404 — never the custom page and never the secret bytes.
  const attackArms: Array<{ name: string; path: string }> = [
    { name: 'dotfile (/.env)', path: '/.env' },
    { name: 'encoded traversal (/..%2f.env)', path: '/..%2f.env' },
    { name: 'symlink-escape (/leak.txt)', path: '/leak.txt' },
  ];
  for (const arm of attackArms) {
    it(`fail-closed: ${arm.name} with a 404.html present → uniform 404, never the custom page nor the secret`, async () => {
      const app = buildApp(
        [plainMount],
        mintFixture({ index: true, notFound: true, dotfile: true, symlink: true }),
      );
      const res = await app.request(arm.path);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(CUSTOM_404_SENTINEL);
      expect(body).not.toContain(LOCAL_DOTFILE_SECRET);
      expect(body).not.toContain(LOCAL_SYMLINK_SECRET);
    });
  }

  it('reserved prefixes (/v1, /health) keep the uniform 404, never the custom 404.html page', async () => {
    const root = mintFixture({ index: true, notFound: true });
    const app = new Hono();
    app.get('/v1/registered', (c) => c.json({ registered: true }));
    app.get('/health', (c) => c.json({ status: 'ok' }));
    mountFrontend(app, [plainMount], root);

    const v1 = await app.request('/v1/nonexistent');
    expect(v1.status).toBe(404);
    expect(await v1.text()).not.toContain(CUSTOM_404_SENTINEL);

    const health = await app.request('/health/whatever');
    expect(health.status).toBe(404);
    expect(await health.text()).not.toContain(CUSTOM_404_SENTINEL);
  });

  // The custom 404 page must honor the module's HEAD contract: a metadata-only verb (HEAD/OPTIONS)
  // carries the status + content-type + Content-Length but NEVER a body. Against a body-for-every-method
  // helper, OPTIONS leaks the full 404.html bytes and neither verb advertises a Content-Length.
  const NOTFOUND_BYTES = Buffer.byteLength(
    `<!doctype html><title>${CUSTOM_404_SENTINEL}</title>`,
    'utf8',
  );
  for (const method of ['HEAD', 'OPTIONS'] as const) {
    it(`spa:false — ${method} on a miss with a root 404.html present → 404 text/html, Content-Length, EMPTY body`, async () => {
      const app = buildApp([plainMount], mintFixture({ index: true, notFound: true }));
      const res = await app.request('/no/such/page', { method });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      // Metadata-only: advertise the byte size, write no body.
      expect(res.headers.get('content-length')).toBe(String(NOTFOUND_BYTES));
      expect(await res.text()).toBe('');
    });
  }

  it('a root 404.html that is a symlink escaping the served dir → uniform 404, never the outside bytes', async () => {
    const OUTSIDE_404_SECRET = 'ESCAPING-404-SYMLINK-SECRET';
    const root = mkdtempSync(join(tmpdir(), 'rayspec-custom-404-symlink-'));
    tempRoots.push(root);
    const dir = join(root, 'web', 'dist');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.html'),
      `<!doctype html><title>${LOCAL_INDEX_SENTINEL}</title>`,
      'utf8',
    );
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 'secret-404.html'),
      `<!doctype html><title>${OUTSIDE_404_SECRET}</title>`,
      'utf8',
    );
    // The mount's `404.html` is a symlink pointing OUT of the served directory — the fail-closed guard
    // must refuse to follow it, keeping the uniform 404 (never the escaped file's bytes).
    symlinkSync(join(outside, 'secret-404.html'), join(dir, '404.html'));

    const app = buildApp([plainMount], root);
    const res = await app.request('/no/such/page');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(OUTSIDE_404_SECRET);
  });

  it('a root 404.html that is a DIRECTORY (not a file) → uniform 404, never its index.html (file-only)', async () => {
    const DIR_404_INDEX_SENTINEL = 'DIRECTORY-404-INDEX-SENTINEL';
    const root = mkdtempSync(join(tmpdir(), 'rayspec-custom-404-dir-'));
    tempRoots.push(root);
    const dir = join(root, 'web', 'dist');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.html'),
      `<!doctype html><title>${LOCAL_INDEX_SENTINEL}</title>`,
      'utf8',
    );
    // `404.html` is a DIRECTORY holding an index.html — the dir→index resolution must NOT apply here;
    // only the exact FILE `404.html` is a custom 404 page, so this is a genuine miss (uniform 404).
    mkdirSync(join(dir, '404.html'), { recursive: true });
    writeFileSync(
      join(dir, '404.html', 'index.html'),
      `<!doctype html><title>${DIR_404_INDEX_SENTINEL}</title>`,
      'utf8',
    );

    const app = buildApp([plainMount], root);
    const res = await app.request('/no/such/page');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(DIR_404_INDEX_SENTINEL);
  });

  it('cross-mount: an inner /docs mount with its own 404.html answers ITS subtree miss, not the outer SPA index', async () => {
    // Two overlapping mounts — a plain `/docs` shipping its own 404.html and a `/` SPA catch-all. A miss
    // under /docs is answered by the docs mount's 404.html (status 404), by design — it does NOT fall
    // through to the outer catch-all's SPA index. This pins the intended cross-mount behavior.
    const DOCS_404_SENTINEL = 'DOCS-MOUNT-404-SENTINEL';
    const APP_INDEX_SENTINEL = 'APP-ROOT-SPA-INDEX-SENTINEL';
    const root = mkdtempSync(join(tmpdir(), 'rayspec-custom-404-crossmount-'));
    tempRoots.push(root);
    const docsDir = join(root, 'docs');
    const appDir = join(root, 'app');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(docsDir, '404.html'),
      `<!doctype html><title>${DOCS_404_SENTINEL}</title>`,
      'utf8',
    );
    writeFileSync(
      join(appDir, 'index.html'),
      `<!doctype html><title>${APP_INDEX_SENTINEL}</title>`,
      'utf8',
    );

    const app = new Hono();
    mountFrontend(
      app,
      [
        { route: '/docs', dir: 'docs', spa: false },
        { route: '/', dir: 'app', spa: true },
      ],
      root,
    );

    const res = await app.request('/docs/client-route');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain(DOCS_404_SENTINEL); // the docs mount's own custom 404 page
    expect(body).not.toContain(APP_INDEX_SENTINEL); // NOT the outer catch-all SPA shell
  });
});
