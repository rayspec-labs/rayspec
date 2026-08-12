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
 *   - CLEAN URLS (`cleanUrls: true`, opt-in): an extensionless path that is not itself a file resolves to
 *     `<path>.html` BEFORE `<path>/index.html` — so `/docs/getting-started` serves
 *     `docs/getting-started.html`; with the flag OFF the same paths keep today's status and document
 *     (the opt-in control), a site shipping BOTH forms sees the documented flip, an exact match still
 *     wins, 404 stays terminal for `spa:false`, and on an `spa:true` mount the page wins the deep link
 *     while only a genuine miss reaches the shell. The option's DOMAIN is pinned in both directions: a
 *     TYPED path (`/api.js`, `/data.json`) is never rewritten — it stays a 404 even when a
 *     `<name>.<ext>.html` sibling exists, while a typed asset that exists still serves — and only the
 *     LAST segment decides, so a dotted directory (`/guide/1.2/notes`) still resolves. The guard, the
 *     range guard and the method guard all still run first (a dotfile, a `.html` symlink escaping the
 *     dir, an unsatisfiable range and a write verb keep their exact responses).
 *   - CONTENT METHODS: a mount serves GET/HEAD/OPTIONS; every other verb gets 405 + `Allow` and the
 *     uniform JSON envelope — so a POST/DELETE to a missing path under an spa:true mount is never
 *     answered 200 with the SPA shell — while the reserved-prefix decline and the fail-closed path
 *     guard, which both run first, keep their 404. The guard also sits AHEAD of the custom-404
 *     fall-through, so a write verb on a mount that ships a 404.html gets the 405, never the page.
 *   - SECURITY HEADERS: with the optional `securityHeaders` argument (the full-backend boot passes
 *     it), EVERY response the mount itself serves — file, SPA fallback, 404.html, 416, 405 — carries
 *     Content-Security-Policy + Permissions-Policy verbatim, while a `next()` fall-through (reserved
 *     prefix, refused path) stays unstamped; WITHOUT the argument (the static boot shape) the mount
 *     emits neither, keeping the static profile's app-wide chain the single source.
 *
 * Fail-the-fix: remove the guard in serve-static.ts and the traversal/dotfile/symlink arms serve the
 * secret file (200) instead of 404 — the `.not.toContain(SECRET)` + status assertions go red. Remove the
 * reserved-prefix decline and `/v1/nonexistent` serves the SPA shell (200) — its `.not.toContain` goes red.
 * Remove the method guard and a POST/DELETE to a missing path returns 200 + the SPA shell — the 405 arms
 * go red.
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

  it('spa:false — a non-content method on a mount that ships a 404.html → 405 + Allow, never the custom page', async () => {
    // The method guard sits AHEAD of the custom-page fall-through, so the page is a GET/HEAD/OPTIONS
    // surface only: a write verb is answered 405 before the page is ever consulted. This is the one
    // response the 404.html convention narrowed, so pin it explicitly.
    const app = buildApp([plainMount], mintFixture({ index: true, asset: true, notFound: true }));
    const res = await app.request('/no/such/page', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.text();
    expect(body).not.toContain(CUSTOM_404_SENTINEL);
    expect(body).not.toContain(LOCAL_INDEX_SENTINEL);
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

describe('mountFrontend — cleanUrls (extensionless resolution, opt-in)', () => {
  // `cleanUrls: true` resolves an extensionless path to `<path>.html` before `<path>/index.html` — the
  // order Netlify / Vercel / GitHub Pages use — so a site whose links are `/docs/getting-started` while
  // the built file is `docs/getting-started.html` serves rather than 404s. Each arm mints its OWN fixture
  // (the shared beforeAll fixture stays byte-untouched) holding BOTH resolvable forms plus an exact
  // extensionless file, a 404.html, a dotfile and a symlink escaping the served dir — so one fixture can
  // pin the resolution ORDER, the opt-in control, the terminal 404 and the fail-closed hardening alike.
  //
  // Fail-the-fix: drop the `cleanUrls` branch and the `/docs/getting-started` arms go RED at 404; run it
  // AFTER the file server instead of before and the both-forms arm goes RED (index.html would win); skip
  // the `isSafeStaticPath` check on the `.html` candidate and the symlink arm serves the outside secret.
  const CLEAN_PAGE_SENTINEL = 'CLEAN-URL-PAGE-SENTINEL';
  const CLEAN_INDEX_SENTINEL = 'CLEAN-URL-ROOT-INDEX-SENTINEL';
  const DOCS_INDEX_SENTINEL = 'CLEAN-URL-DOCS-INDEX-SENTINEL';
  const BOTH_FILE_SENTINEL = 'CLEAN-URL-BOTH-FILE-SENTINEL';
  const BOTH_INDEX_SENTINEL = 'CLEAN-URL-BOTH-INDEX-SENTINEL';
  const EXACT_FILE_SENTINEL = 'CLEAN-URL-EXACT-FILE-SENTINEL';
  const EXACT_HTML_SENTINEL = 'CLEAN-URL-EXACT-HTML-SENTINEL';
  const CLEAN_404_SENTINEL = 'CLEAN-URL-404-PAGE-SENTINEL';
  const CLEAN_DOTFILE_SECRET = 'CLEAN-URL-DOTFILE-SECRET';
  const CLEAN_SYMLINK_SECRET = 'CLEAN-URL-SYMLINK-SECRET';
  const TYPED_SIBLING_SENTINEL = 'CLEAN-URL-TYPED-SIBLING-SENTINEL';
  const TYPED_ASSET_SENTINEL = 'CLEAN-URL-TYPED-ASSET-SENTINEL';
  const DOTTED_DIR_SENTINEL = 'CLEAN-URL-DOTTED-DIR-SENTINEL';

  const tempRoots: string[] = [];
  let fixtureRoot = '';

  /**
   * The multi-page-site fixture every arm shares (minted once — no arm writes to it):
   *   index.html                      the root document
   *   docs/index.html                 a directory index (reachable as `/docs/`)
   *   docs/getting-started.html       the page the issue's navigation links to as `/docs/getting-started`
   *   both.html + both/index.html     BOTH resolvable forms — pins which one `cleanUrls` picks
   *   exact + exact.html              an EXACT extensionless file beside its `.html` sibling
   *   404.html                        the mount-root custom not-found page (the terminal outcome)
   *   api.js.html + data.json.html    TYPED paths with an `.html` sibling but NO typed file — the
   *                                   out-of-domain case: `/api.js` must stay a 404, never the sibling
   *   real.js                         a typed asset that DOES exist (the accept control beside it)
   *   guide/1.2/notes.html            a DOTTED directory on the way to an extensionless leaf
   *   .env                            a dotfile the guard must keep refusing
   *   leak.html                       a symlink OUT of the served dir (the `.html` candidate itself)
   */
  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'rayspec-clean-urls-'));
    tempRoots.push(root);
    const dir = join(root, 'web', 'dist');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'both'), { recursive: true });
    mkdirSync(join(dir, 'guide', '1.2'), { recursive: true });
    const page = (sentinel: string): string => `<!doctype html><title>${sentinel}</title>`;
    writeFileSync(join(dir, 'index.html'), page(CLEAN_INDEX_SENTINEL), 'utf8');
    writeFileSync(join(dir, 'docs', 'index.html'), page(DOCS_INDEX_SENTINEL), 'utf8');
    writeFileSync(join(dir, 'docs', 'getting-started.html'), page(CLEAN_PAGE_SENTINEL), 'utf8');
    writeFileSync(join(dir, 'both.html'), page(BOTH_FILE_SENTINEL), 'utf8');
    writeFileSync(join(dir, 'both', 'index.html'), page(BOTH_INDEX_SENTINEL), 'utf8');
    writeFileSync(join(dir, 'exact'), page(EXACT_FILE_SENTINEL), 'utf8');
    writeFileSync(join(dir, 'exact.html'), page(EXACT_HTML_SENTINEL), 'utf8');
    writeFileSync(join(dir, '404.html'), page(CLEAN_404_SENTINEL), 'utf8');
    // TYPED paths whose ONLY on-disk form is a `<name>.<ext>.html` sibling — the resolution must not
    // reach them, so `/api.js` and `/data.json` stay genuine misses.
    writeFileSync(join(dir, 'api.js.html'), page(TYPED_SIBLING_SENTINEL), 'utf8');
    writeFileSync(join(dir, 'data.json.html'), page(TYPED_SIBLING_SENTINEL), 'utf8');
    writeFileSync(join(dir, 'real.js'), `console.log('${TYPED_ASSET_SENTINEL}');`, 'utf8');
    writeFileSync(join(dir, 'guide', '1.2', 'notes.html'), page(DOTTED_DIR_SENTINEL), 'utf8');
    writeFileSync(join(dir, '.env'), `SECRET=${CLEAN_DOTFILE_SECRET}`, 'utf8');
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.html'), CLEAN_SYMLINK_SECRET, 'utf8');
    symlinkSync(join(outside, 'secret.html'), join(dir, 'leak.html'));
    fixtureRoot = root;
  });

  afterAll(() => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  });

  const cleanMount: FrontendSpec = { route: '/', dir: 'web/dist', spa: false, cleanUrls: true };
  const offMount: FrontendSpec = { route: '/', dir: 'web/dist', spa: false, cleanUrls: false };

  it('cleanUrls:true — an extensionless link resolves to <path>.html (200 + that page)', async () => {
    const app = buildApp([cleanMount], fixtureRoot);
    const res = await app.request('/docs/getting-started');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain(CLEAN_PAGE_SENTINEL);
  });

  it('cleanUrls:false — the SAME request is still a miss (the option is opt-in, nothing changes)', async () => {
    const app = buildApp([offMount], fixtureRoot);
    const res = await app.request('/docs/getting-started');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain(CLEAN_404_SENTINEL); // the mount's own not-found page, exactly as before
    expect(body).not.toContain(CLEAN_PAGE_SENTINEL);
  });

  it('cleanUrls:false — every other path answers byte-identically to a mount that never had the option', async () => {
    // The opt-in promise in full: with the flag off, the paths the option COULD have moved keep the
    // status and the document they have today.
    const app = buildApp([offMount], fixtureRoot);
    for (const [path, sentinel] of [
      ['/', CLEAN_INDEX_SENTINEL],
      ['/docs/', DOCS_INDEX_SENTINEL],
      ['/docs/index.html', DOCS_INDEX_SENTINEL],
      ['/docs/getting-started.html', CLEAN_PAGE_SENTINEL],
      ['/both', BOTH_INDEX_SENTINEL], // the DIRECTORY index — the resolution `cleanUrls` flips
      ['/both.html', BOTH_FILE_SENTINEL],
      ['/exact', EXACT_FILE_SENTINEL],
    ] as const) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(sentinel);
    }
  });

  it('cleanUrls:true — BOTH forms present: <path>.html WINS over <path>/index.html (the documented flip)', async () => {
    // The one visible change for a site that opts in while shipping both forms: today `/both` serves
    // `both/index.html`; under the flag it serves `both.html`, the order the hosts this mirrors use.
    const app = buildApp([cleanMount], fixtureRoot);
    const res = await app.request('/both');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(BOTH_FILE_SENTINEL);
    expect(body).not.toContain(BOTH_INDEX_SENTINEL);
  });

  it('cleanUrls:true — a TRAILING-SLASH request still resolves the directory index, never <path>.html', async () => {
    const app = buildApp([cleanMount], fixtureRoot);
    const res = await app.request('/both/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(BOTH_INDEX_SENTINEL);
  });

  it('cleanUrls:true — an EXACT file match wins over its .html sibling', async () => {
    const app = buildApp([cleanMount], fixtureRoot);
    const res = await app.request('/exact');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(EXACT_FILE_SENTINEL);
    expect(body).not.toContain(EXACT_HTML_SENTINEL);
  });

  it('cleanUrls:true — a TYPED path is NOT rewritten: /api.js stays a 404, never api.js.html', async () => {
    // The option's domain is EXTENSIONLESS paths. A request whose last segment carries an extension
    // names a typed asset, so a MISSING one must stay a miss — answering it 200 + HTML from a
    // `<name>.<ext>.html` sibling would hand a fetch/XHR a success status for a file that is not there
    // and break the "404 stays terminal for spa:false" promise exactly where it matters.
    // Fail-the-fix: drop the extension test in `resolveCleanUrlTarget` and both paths come back
    // 200 `text/html` carrying TYPED_SIBLING_SENTINEL.
    const app = buildApp([cleanMount], fixtureRoot);
    for (const path of ['/api.js', '/data.json'] as const) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain(CLEAN_404_SENTINEL); // the terminal outcome, unchanged by the flag
      expect(body).not.toContain(TYPED_SIBLING_SENTINEL);
    }
  });

  it('cleanUrls:true — the accept control: a typed asset that EXISTS still serves, by either name', async () => {
    // Without this the arm above would pass on a fixture that serves nothing at all. `real.js` proves
    // typed assets still serve, and `api.js.html` proves the sibling IS reachable — under its own name.
    const app = buildApp([cleanMount], fixtureRoot);
    const asset = await app.request('/real.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain(TYPED_ASSET_SENTINEL);
    const sibling = await app.request('/api.js.html');
    expect(sibling.status).toBe(200);
    expect(await sibling.text()).toContain(TYPED_SIBLING_SENTINEL);
  });

  it('cleanUrls:true — only the LAST segment decides: a dotted directory still resolves the page', async () => {
    const app = buildApp([cleanMount], fixtureRoot);
    const res = await app.request('/guide/1.2/notes');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(DOTTED_DIR_SENTINEL);
  });

  it('cleanUrls:true + spa:true — a typed miss reaches the SPA shell, never the .html sibling', async () => {
    // On a mount that sets both, the SPA fallback keeps its own promise for a typed miss — but the
    // answer is the shell, not the out-of-domain `api.js.html`.
    const app = buildApp(
      [{ route: '/', dir: 'web/dist', spa: true, cleanUrls: true }],
      fixtureRoot,
    );
    const res = await app.request('/api.js');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(CLEAN_INDEX_SENTINEL);
    expect(body).not.toContain(TYPED_SIBLING_SENTINEL);
  });

  it('cleanUrls:true — an unsatisfiable Range on a TYPED miss is not sized from the .html sibling', async () => {
    // The range guard shares the one resolution, so the domain restriction holds there too: `/api.js`
    // resolves to nothing, so the request falls through to serveStatic's normal 404 rather than a 416
    // computed from `api.js.html`.
    const app = buildApp([cleanMount], fixtureRoot);
    const res = await app.request('/api.js', { headers: { Range: 'bytes=99999-' } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(TYPED_SIBLING_SENTINEL);
  });

  it('cleanUrls:true — the mount root and a directory index are unaffected', async () => {
    const app = buildApp([cleanMount], fixtureRoot);
    const rootRes = await app.request('/');
    expect(rootRes.status).toBe(200);
    expect(await rootRes.text()).toContain(CLEAN_INDEX_SENTINEL);
    const docsRes = await app.request('/docs/');
    expect(docsRes.status).toBe(200);
    expect(await docsRes.text()).toContain(DOCS_INDEX_SENTINEL);
  });

  it('cleanUrls:true + spa:false — a genuine miss still ends at the root 404.html (404 stays terminal)', async () => {
    const app = buildApp([cleanMount], fixtureRoot);
    const res = await app.request('/no/such/page');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain(CLEAN_404_SENTINEL);
  });

  it('cleanUrls:true + spa:true — <path>.html wins the deep link, and only a genuine miss reaches the SPA shell', async () => {
    // The two options are ORDERED, not exclusive: exact → `<path>.html` → `<path>/index.html` → the SPA
    // fallback. So a link that HAS a page gets that page (not the shell), and a path with no page at all
    // still gets the shell — each option keeps its own promise on the same mount.
    const app = buildApp(
      [{ route: '/', dir: 'web/dist', spa: true, cleanUrls: true }],
      fixtureRoot,
    );
    const page = await app.request('/docs/getting-started');
    expect(page.status).toBe(200);
    const pageBody = await page.text();
    expect(pageBody).toContain(CLEAN_PAGE_SENTINEL);
    expect(pageBody).not.toContain(CLEAN_INDEX_SENTINEL);

    const miss = await app.request('/no/such/page');
    expect(miss.status).toBe(200);
    const missBody = await miss.text();
    expect(missBody).toContain(CLEAN_INDEX_SENTINEL); // the SPA shell, unchanged by the flag
    expect(missBody).not.toContain(CLEAN_404_SENTINEL);
  });

  it('spa:true alone — an unmatched path still returns the root document (unchanged by this change)', async () => {
    const app = buildApp(
      [{ route: '/', dir: 'web/dist', spa: true, cleanUrls: false }],
      fixtureRoot,
    );
    const res = await app.request('/no/such/page');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(CLEAN_INDEX_SENTINEL);
  });

  it('cleanUrls:true — a non-content verb on an extensionless path is still 405 + Allow, never the page', async () => {
    const app = buildApp([cleanMount], fixtureRoot);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.request('/docs/getting-started', { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
      expect(await res.text()).not.toContain(CLEAN_PAGE_SENTINEL);
    }
  });

  it('cleanUrls:true — HEAD on an extensionless path carries the page metadata with an EMPTY body', async () => {
    const app = buildApp([cleanMount], fixtureRoot);
    const res = await app.request('/docs/getting-started', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).not.toBeNull();
    expect(await res.text()).toBe('');
  });

  it('cleanUrls:true — an unsatisfiable Range on an extensionless path → 416 sized from the .html file', async () => {
    // The range guard resolves what the mount will ACTUALLY serve, so the clean-URL target is guarded
    // exactly like a directly-requested file: no malformed 0-byte 206, no ERR_OUT_OF_RANGE → 500.
    const size = Buffer.byteLength(`<!doctype html><title>${CLEAN_PAGE_SENTINEL}</title>`, 'utf8');
    const app = buildApp([cleanMount], fixtureRoot);
    const res = await app.request('/docs/getting-started', { headers: { Range: 'bytes=99999-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${size}`);
  });

  it('cleanUrls:true — the fail-closed guard still refuses a dotfile and a .html symlink escaping the dir', async () => {
    const app = buildApp([cleanMount], fixtureRoot);
    // The dotfile itself, and the `.html` form of a path whose candidate leaves the served directory.
    const dotfile = await app.request('/.env');
    expect(dotfile.status).toBe(404);
    expect(await dotfile.text()).not.toContain(CLEAN_DOTFILE_SECRET);
    // `leak.html` is a symlink OUT of the served dir — the clean-URL candidate must not follow it.
    const leak = await app.request('/leak');
    expect(leak.status).toBe(404);
    expect(await leak.text()).not.toContain(CLEAN_SYMLINK_SECRET);
    // An encoded traversal whose `.html` form would land outside the served directory.
    const traversal = await app.request('/a/..%2f..%2f..%2foutside/secret');
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain(CLEAN_SYMLINK_SECRET);
  });

  it('cleanUrls:true on a NON-ROOT mount — the route prefix is stripped before the .html lookup', async () => {
    const app = buildApp(
      [{ route: '/site', dir: 'web/dist', spa: false, cleanUrls: true }],
      fixtureRoot,
    );
    const res = await app.request('/site/docs/getting-started');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(CLEAN_PAGE_SENTINEL);
  });

  it('cleanUrls:true — a reserved platform namespace is still declined, never served as <path>.html', async () => {
    const app = buildApp([cleanMount], fixtureRoot);
    const res = await app.request('/v1/docs/getting-started');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(CLEAN_PAGE_SENTINEL);
  });
});

describe('mountFrontend — content methods (a static mount is not a write surface)', () => {
  // A static mount serves GET/HEAD/OPTIONS; every other verb gets 405 with `Allow` and the platform's
  // uniform JSON envelope. Fail-the-fix: without the method guard a POST/DELETE to a path that does not
  // exist under an spa:true mount falls through to the SPA fallback and returns 200 + index.html — a
  // success status a client cannot tell apart from a completed write.
  const ALLOW = 'GET, HEAD, OPTIONS';
  /** The uniform envelope the guard returns; the bare Hono of these unit proofs sets no request id. */
  const ENVELOPE = {
    error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', requestId: 'unknown' },
  };

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    it(`spa:true — ${method} to a nonexistent path → 405 + Allow + the uniform envelope, never the SPA shell`, async () => {
      const app = buildApp([spaMount], specDir());
      const res = await app.request('/route-that-does-not-exist', { method });
      expect(res.status).toBe(405);
      expect(res.status).not.toBe(200);
      expect(res.headers.get('allow')).toBe(ALLOW);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(await res.json()).toEqual(ENVELOPE);
    });
  }

  it('spa:true — POST to an EXISTING file → 405 too (the mount serves content, it never accepts a write)', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/assets/app.js', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe(ALLOW);
    expect(await res.text()).not.toContain(ASSET_SENTINEL);
  });

  it('spa:false — POST to a nonexistent path → 405 + Allow (the guard is not SPA-specific)', async () => {
    const app = buildApp([plainMount], specDir());
    const res = await app.request('/route-that-does-not-exist', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe(ALLOW);
  });

  // The three surfaces the guard must leave alone.
  for (const method of ['GET', 'HEAD', 'OPTIONS'] as const) {
    it(`${method} on an existing file is untouched — 200, no Allow header`, async () => {
      const app = buildApp([spaMount], specDir());
      const res = await app.request('/assets/app.js', { method });
      expect(res.status).toBe(200);
      expect(res.headers.get('allow')).toBeNull();
    });
  }

  it('spa:true — GET a deep link still returns index.html (200): History-API navigation is unaffected', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/deep/link');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_SENTINEL);
  });

  it('spa:true — OPTIONS to a nonexistent path keeps its current 200 (the guard exempts it), never a 405', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/deep/link', { method: 'OPTIONS' });
    expect(res.status).toBe(200);
    expect(res.headers.get('allow')).toBeNull();
  });

  it('the reserved-prefix decline runs FIRST — POST /v1/nonexistent keeps the platform fall-through 404', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/v1/nonexistent', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(405);
  });

  it('the fail-closed path guard runs FIRST — POST /.env stays a 404, never a 405 and never the secret', async () => {
    const app = buildApp([spaMount], specDir());
    const res = await app.request('/.env', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(405);
    expect(await res.text()).not.toContain(DOTFILE_SECRET);
  });
});

describe('mountFrontend — securityHeaders stamps every response the mount serves (full-backend parity)', () => {
  // The values are the CALLER's (the composition root resolves env override vs shared default);
  // distinctive strings prove verbatim pass-through, not a default baked into serve-static.
  const CSP = "default-src 'self'; img-src 'self' data:";
  const PERMISSIONS_POLICY = 'camera=(), microphone=(self), geolocation=()';

  /** The mini app of the other suites, with the mount handed the security headers. */
  function buildStampedApp(mounts: FrontendSpec[], dir: string): Hono {
    const app = new Hono();
    app.get('/v1/registered', (c) => c.json({ registered: true }));
    mountFrontend(app, mounts, dir, { csp: CSP, permissionsPolicy: PERMISSIONS_POLICY });
    return app;
  }

  function expectStamped(res: Response): void {
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
  }
  function expectUnstamped(res: Response): void {
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('permissions-policy')).toBeNull();
  }

  it('a served file carries both headers verbatim', async () => {
    const res = await buildStampedApp([spaMount], specDir()).request('/assets/app.js');
    expect(res.status).toBe(200);
    expectStamped(res);
  });

  it('the SPA fallback carries both headers (a fallback response is a mount response too)', async () => {
    const res = await buildStampedApp([spaMount], specDir()).request('/dashboard/deep/link');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(INDEX_SENTINEL);
    expectStamped(res);
  });

  it('the method 405 carries both headers', async () => {
    const res = await buildStampedApp([spaMount], specDir()).request('/route-that-does-not-exist', {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expectStamped(res);
  });

  it('the range 416 carries both headers', async () => {
    const res = await buildStampedApp([spaMount], specDir()).request('/assets/app.js', {
      headers: { Range: 'bytes=99999-' },
    });
    expect(res.status).toBe(416);
    expectStamped(res);
  });

  it('a custom 404.html page carries both headers', async () => {
    const NOTFOUND_SENTINEL = 'STAMPED-404-PAGE-SENTINEL';
    const root = mkdtempSync(join(tmpdir(), 'rayspec-stamped-404-'));
    try {
      mkdirSync(join(root, 'web', 'dist'), { recursive: true });
      writeFileSync(
        join(root, 'web', 'dist', '404.html'),
        `<!doctype html><title>${NOTFOUND_SENTINEL}</title>`,
        'utf8',
      );
      const res = await buildStampedApp([plainMount], root).request('/no/such/page');
      expect(res.status).toBe(404);
      expect(await res.text()).toContain(NOTFOUND_SENTINEL);
      expectStamped(res);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a reserved-prefix fall-through is NOT stamped — the platform surface keeps its own headers', async () => {
    const app = buildStampedApp([spaMount], specDir());
    // A REGISTERED platform route wins and stays clean (the mount declined before serving).
    const registered = await app.request('/v1/registered');
    expect(registered.status).toBe(200);
    expectUnstamped(registered);
    // An UNregistered reserved path reaches the platform fall-through 404, equally clean.
    const missed = await app.request('/v1/nonexistent');
    expect(missed.status).toBe(404);
    expectUnstamped(missed);
  });

  it('a guard-refused path is NOT stamped — the uniform 404 belongs to the platform surface', async () => {
    const res = await buildStampedApp([spaMount], specDir()).request('/.env');
    expect(res.status).toBe(404);
    expectUnstamped(res);
  });

  it('WITHOUT the argument (the static boot shape) the mount emits neither header', async () => {
    const res = await buildApp([spaMount], specDir()).request('/');
    expect(res.status).toBe(200);
    expectUnstamped(res);
  });
});
