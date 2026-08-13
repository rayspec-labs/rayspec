/**
 * BOOT WARNING for a served page whose inline `<style>` / `<script>` / `style=` / `on*=` the ACTIVE
 * Content-Security-Policy blocks — the STATIC (frontend-only) boot shape and the scan itself, over
 * mkdtemp fixtures, with NO database and NO network. The FULL-BACKEND shape (`assembleServer`, which
 * #313 gave the same frontend headers) is proved in `frontend-inline-asset-csp-boot.db.test.ts`.
 *
 * What is asserted here, and why each arm is not pass-the-shape:
 *
 *   COUNTERPROOF — a real `assembleStaticServer` over a page carrying all four shapes emits ONE
 *   warning naming `web/dist/index.html`, and the SAME server still answers `GET /` 200 with the
 *   bytes intact (warn-only: remove the emit and the first assertion goes red; make it throw and the
 *   second does).
 *
 *   ACCEPT CONTROL 1 — a clean page emits nothing. Without it, an unconditional warn would pass
 *   every other arm in this file.
 *
 *   ACCEPT CONTROL 2 — RAYSPEC_FRONTEND_CSP permitting the shape silences it, per-directive: a
 *   policy that opens `style-src` and not `script-src` still names the script and no longer names
 *   the style, so the arm cannot pass by ignoring the policy altogether.
 *
 *   THE BOUNDS — pinned by construction at the exported limits: `INLINE_ASSET_SCAN_FILE_LIMIT` + 1
 *   offending files produce a scan that stops at the limit AND says so; more than
 *   `INLINE_ASSET_SCAN_REPORT_LIMIT` offenders are listed up to the limit and the remainder counted;
 *   a file over `INLINE_ASSET_SCAN_BYTE_LIMIT` is scanned to that prefix and the message says so.
 *   Each truncation clause is asserted as TEXT, so a silent bound cannot pass.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrontendSpec } from '@rayspec/spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assembleStaticServer,
  DEFAULT_FRONTEND_CSP,
  loadStaticServerConfig,
} from './composition-root.js';
import {
  blockedInlineAssetWarning,
  frontendMountsReadiness,
  INLINE_ASSET_SCAN_BYTE_LIMIT,
  INLINE_ASSET_SCAN_FILE_LIMIT,
  INLINE_ASSET_SCAN_REPORT_LIMIT,
} from './serve-static.js';

const SPA_MOUNT: FrontendSpec = { route: '/', dir: 'web/dist', spa: true };
/** All four blocked shapes on one page (an inline style, an inline script, `style=`, `onclick=`). */
const ALL_FOUR = `<!doctype html><html><head><style>body{color:red}</style></head>
<body><div style="color:blue" onclick="reload()">hi</div><script>console.log(1)</script></body></html>`;
/** The same page with the style in a linked sheet and the script in a file — nothing inline. */
const CLEAN = `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head>
<body><div class="box">hi</div><script src="/app.js" defer></script></body></html>`;

let root = '';
const dist = (): string => join(root, 'web', 'dist');
const specPath = (): string => join(root, 'rayspec.yaml');

/** Write one file under `web/dist` (creating parent directories), returning its absolute path. */
function writeAsset(relativePath: string, contents: string): string {
  const full = join(dist(), relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents, 'utf8');
  return full;
}

/** The warning the scan produces for the fixture under `csp` (`undefined` when it says nothing). */
function warningFor(csp: string): string | undefined {
  return blockedInlineAssetWarning([SPA_MOUNT], root, csp);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rayspec-inline-asset-csp-'));
  mkdirSync(dist(), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('static boot — the warning an operator actually sees', () => {
  it('COUNTERPROOF: a page with all four inline shapes warns once, naming the file — and the boot still serves it', async () => {
    writeAsset('index.html', ALL_FOUR);
    const warnings: string[] = [];
    const server = assembleStaticServer(
      loadStaticServerConfig({}),
      { specPath: specPath(), frontend: [SPA_MOUNT] },
      { bootWarn: (message) => warnings.push(message) },
    );

    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning).toContain('web/dist/index.html');
    expect(warning).toContain('inline <style> element (default-src)');
    expect(warning).toContain('inline <script> element (default-src)');
    expect(warning).toContain('style= attribute (default-src)');
    expect(warning).toContain('on*= handler attribute (default-src)');
    // The reader is told this is a heuristic, and told NOT to trust the browser console.
    expect(warning).toContain('HEURISTIC');
    expect(warning).toContain('browser console is not a reliable way to check this');

    // WARN-ONLY: the boot produced a working server that serves the offending page unchanged, under
    // exactly the policy the warning judged it against.
    const res = await server.app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<style>body{color:red}</style>');
    expect(res.headers.get('content-security-policy')).toBe(DEFAULT_FRONTEND_CSP);
    expect(await (await server.app.request('/health')).json()).toEqual({
      status: 'ok',
      frontend: 'ok',
    });
  });

  it('ACCEPT CONTROL 1: a clean page emits NO warning at all', () => {
    writeAsset('index.html', CLEAN);
    const warnings: string[] = [];
    assembleStaticServer(
      loadStaticServerConfig({}),
      { specPath: specPath(), frontend: [SPA_MOUNT] },
      { bootWarn: (message) => warnings.push(message) },
    );
    expect(warnings).toEqual([]);
  });

  it('ACCEPT CONTROL 3: a mount that cannot be served at all still boots — readiness reports it, the scan does not throw', () => {
    // No index.html for an spa:true mount → 'unavailable'. The scan must not change that answer and
    // must not turn a reportable state into an exception.
    const warnings: string[] = [];
    const server = assembleStaticServer(
      loadStaticServerConfig({}),
      { specPath: specPath(), frontend: [SPA_MOUNT] },
      { bootWarn: (message) => warnings.push(message) },
    );
    expect(warnings).toEqual([]);
    expect(typeof server.app.fetch).toBe('function');
  });
});

describe('the active policy decides — not the shipped default', () => {
  it('ACCEPT CONTROL 2: a policy with `unsafe-inline` for everything says nothing', () => {
    writeAsset('index.html', ALL_FOUR);
    expect(warningFor("default-src 'self' 'unsafe-inline'")).toBeUndefined();
  });

  it('per-directive: opening style-src only still names the script shapes, and no longer the style ones', () => {
    writeAsset('index.html', ALL_FOUR);
    const warning = warningFor("default-src 'self'; style-src 'self' 'unsafe-inline'");
    expect(warning).toBeDefined();
    expect(warning).toContain('inline <script> element (default-src)');
    expect(warning).toContain('on*= handler attribute (default-src)');
    expect(warning).not.toContain('inline <style> element');
    expect(warning).not.toContain('style= attribute');
  });

  it('the most specific directive wins its fallback chain (`style-src-elem` over `style-src`)', () => {
    writeAsset('index.html', '<style>body{color:red}</style><div style="x">');
    // style-src-elem permits the ELEMENT; the ATTRIBUTE falls back to style-src, which does not.
    const warning = warningFor(
      "default-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'",
    );
    expect(warning).toBeDefined();
    expect(warning).not.toContain('inline <style> element');
    expect(warning).toContain('style= attribute (style-src)');
  });

  it('a policy that governs neither shape (no default-src, no style/script-src) says nothing', () => {
    writeAsset('index.html', ALL_FOUR);
    expect(warningFor("frame-ancestors 'none'; base-uri 'self'")).toBeUndefined();
  });

  it('a hash source suppresses that shape — the scan computes no digests, and says so', () => {
    writeAsset('index.html', ALL_FOUR);
    const warning = warningFor(
      "default-src 'self'; script-src 'self' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='",
    );
    expect(warning).toBeDefined();
    // The script shapes are not accused (their directive lists a hash this scan cannot check)…
    expect(warning).not.toContain('inline <script> element');
    expect(warning).not.toContain('on*= handler attribute');
    // …the style shapes still fall back to default-src, and the limit is stated in the message.
    expect(warning).toContain('inline <style> element (default-src)');
    expect(warning).toContain('does not compute hashes');
  });
});

describe('detection fidelity — what the heuristic does and does not report', () => {
  it('a commented-out inline block is not reported', () => {
    writeAsset('index.html', '<!-- <style>body{color:red}</style> --><p>copy</p>');
    expect(warningFor(DEFAULT_FRONTEND_CSP)).toBeUndefined();
  });

  it('markup inside a <script> body does not become an attribute finding', () => {
    // The script itself IS reported; the `style="…"`/`onclick="…"` in its string must not add to it.
    writeAsset('index.html', `<script>el.innerHTML = '<div style="x" onclick="y()">';</script>`);
    const warning = warningFor(DEFAULT_FRONTEND_CSP);
    expect(warning).toContain('inline <script> element');
    expect(warning).not.toContain('style= attribute');
    expect(warning).not.toContain('on*= handler attribute');
  });

  it('an external <script src>, an empty <script>, and a JSON data block are not inline code', () => {
    writeAsset(
      'index.html',
      '<script src="/app.js"></script><script></script>' +
        '<script type="application/ld+json">{"a":1}</script>',
    );
    expect(warningFor(DEFAULT_FRONTEND_CSP)).toBeUndefined();
  });

  it('`type="module"` without src IS inline code (CSP governs it)', () => {
    writeAsset('index.html', '<script type="module">import "./a.js";</script>');
    expect(warningFor(DEFAULT_FRONTEND_CSP)).toContain('inline <script> element');
  });

  it('the words "style=" / "onclick=" in page copy are not attributes', () => {
    writeAsset('index.html', '<p>Write style= or onclick= in your markup and it is blocked.</p>');
    expect(warningFor(DEFAULT_FRONTEND_CSP)).toBeUndefined();
  });

  it('a non-handler attribute starting with "on" is not a handler', () => {
    writeAsset('index.html', '<div once="1" on="x">hi</div>');
    expect(warningFor(DEFAULT_FRONTEND_CSP)).toBeUndefined();
  });

  it('only .html/.htm files are read — a .js asset carrying the same bytes is not scanned', () => {
    writeAsset('app.js', 'const t = `<div style="x" onclick="y()"></div>`;');
    expect(warningFor(DEFAULT_FRONTEND_CSP)).toBeUndefined();
  });

  it('nested pages are found, and named by their path relative to the spec', () => {
    writeAsset('docs/guide/index.html', '<div style="x">');
    expect(warningFor(DEFAULT_FRONTEND_CSP)).toContain('web/dist/docs/guide/index.html');
  });

  it('dotfiles and symlinks are skipped — `mountFrontend` refuses to serve either', () => {
    writeAsset('.hidden/index.html', ALL_FOUR);
    const real = writeAsset('real.html', ALL_FOUR);
    symlinkSync(real, join(dist(), 'link.html'));
    const warning = warningFor(DEFAULT_FRONTEND_CSP);
    expect(warning).toContain('web/dist/real.html');
    expect(warning).not.toContain('.hidden');
    expect(warning).not.toContain('link.html');
  });
});

describe('the bounds — stated in the message whenever they bite', () => {
  it('the exported limits are the numbers this suite builds against', () => {
    expect(INLINE_ASSET_SCAN_FILE_LIMIT).toBe(200);
    expect(INLINE_ASSET_SCAN_REPORT_LIMIT).toBe(5);
    expect(INLINE_ASSET_SCAN_BYTE_LIMIT).toBe(1024 * 1024);
  });

  it(`more than ${INLINE_ASSET_SCAN_REPORT_LIMIT} offenders: the first are named, the rest counted`, () => {
    const offenders = INLINE_ASSET_SCAN_REPORT_LIMIT + 3;
    for (let i = 0; i < offenders; i += 1) {
      writeAsset(`page-${String(i).padStart(3, '0')}.html`, '<div style="x">');
    }
    const warning = warningFor(DEFAULT_FRONTEND_CSP) ?? '';
    expect(warning).toContain(`${offenders} served HTML files carry`);
    const named = warning.split('\n').filter((l) => l.includes('web/dist/page-'));
    expect(named).toHaveLength(INLINE_ASSET_SCAN_REPORT_LIMIT);
    expect(warning).toContain(
      `… and 3 more — this warning names the first ${INLINE_ASSET_SCAN_REPORT_LIMIT}.`,
    );
  });

  it(`past ${INLINE_ASSET_SCAN_FILE_LIMIT} files the scan stops AND the message says the rest were not examined`, () => {
    // One more file than the budget, every one of them offending: a scan that silently covered all
    // of them would report a higher count, and one that silently stopped would say nothing.
    const files = INLINE_ASSET_SCAN_FILE_LIMIT + 1;
    for (let i = 0; i < files; i += 1) {
      writeAsset(`page-${String(i).padStart(4, '0')}.html`, '<div style="x">');
    }
    const warning = warningFor(DEFAULT_FRONTEND_CSP) ?? '';
    expect(warning).toContain(`${INLINE_ASSET_SCAN_FILE_LIMIT} served HTML files carry`);
    expect(warning).toContain(
      `Bound: the scan stopped after ${INLINE_ASSET_SCAN_FILE_LIMIT} HTML files`,
    );
    expect(warning).toContain('were NOT examined');
    // Deterministic truncation: entries are walked in sorted order, so it is always the LAST file
    // that goes unexamined — never a different one per boot.
    expect(warning).not.toContain(`page-${String(files - 1).padStart(4, '0')}.html`);
  });

  it(`a file past ${INLINE_ASSET_SCAN_BYTE_LIMIT} bytes is read to that prefix, and the message says so`, () => {
    // The inline block sits INSIDE the prefix; the padding pushes the file past the cap.
    writeAsset('index.html', `<div style="x"></div>${'\n<!-- pad -->'.repeat(100_000)}`);
    const warning = warningFor(DEFAULT_FRONTEND_CSP) ?? '';
    expect(warning).toContain('web/dist/index.html');
    expect(warning).toContain(
      `Bound: at least one file is larger than ${INLINE_ASSET_SCAN_BYTE_LIMIT} bytes`,
    );
  });

  it('a bound that did not bite is not mentioned', () => {
    writeAsset('index.html', '<div style="x">');
    const warning = warningFor(DEFAULT_FRONTEND_CSP) ?? '';
    expect(warning).not.toContain('Bound:');
    expect(warning).not.toContain('names the first');
  });
});

describe('the dock — the scan rides the boot pass, not the /health path', () => {
  it('`frontendMountsReadiness` without the scan option is unchanged (no read, no warn)', () => {
    writeAsset('index.html', ALL_FOUR);
    expect(frontendMountsReadiness([SPA_MOUNT], root)).toBe('ok');
  });

  it('the scan cannot change the readiness it rides along with', () => {
    writeAsset('index.html', ALL_FOUR);
    const warnings: string[] = [];
    const readiness = frontendMountsReadiness([SPA_MOUNT], root, {
      csp: DEFAULT_FRONTEND_CSP,
      warn: (m) => warnings.push(m),
    });
    expect(readiness).toBe('ok');
    expect(warnings).toHaveLength(1);
  });

  it('an unservable mount still reports `unavailable`, with the scan wired', () => {
    const warnings: string[] = [];
    const readiness = frontendMountsReadiness([{ route: '/', dir: 'nope', spa: true }], root, {
      csp: DEFAULT_FRONTEND_CSP,
      warn: (m) => warnings.push(m),
    });
    expect(readiness).toBe('unavailable');
    expect(warnings).toEqual([]);
  });

  it('two mounts sharing one directory report each offending file once', () => {
    writeAsset('index.html', '<div style="x">');
    const warning = blockedInlineAssetWarning(
      [SPA_MOUNT, { route: '/admin', dir: 'web/dist', spa: false }],
      root,
      DEFAULT_FRONTEND_CSP,
    );
    expect(warning).toContain('1 served HTML file carries');
  });
});
