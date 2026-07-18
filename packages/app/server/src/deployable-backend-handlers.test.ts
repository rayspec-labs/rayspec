/**
 * DEPLOYABILITY of the backend examples that ship custom escape-hatch code — and the compiled-JavaScript
 * boundary that makes the production contract DETERMINISTIC.
 *
 * Production loads escape-hatch handler + extension-pack modules as compiled JavaScript ONLY: the loader
 * fail-closed-rejects a TypeScript-source path via an EXPLICIT extension check
 * (`assertCompiledJavaScriptModule`), so the contract is the SAME on every Node version — it does NOT
 * rely on Node throwing "unknown file extension", nor on whether a Node version transparently type-strips
 * `.ts` on import. Each backend example ships a documented build step (`build.mjs`) that compiles its
 * `.ts` to `.js`; the built output deploys, the raw source does not. Dev/test loads un-built source ONLY
 * through the explicit `typeStrippingImporter` seam (there is no ambient path that bypasses the guard).
 *
 * These prove it on GROUND TRUTH through the REAL loaders (fail-the-fix, not pass-the-shape):
 *
 *   acme-notes-backend — deployment-own `.ts` handlers, loaded by `loadHandlers`:
 *     RED   the production importer rejects the raw `.ts` handlers DETERMINISTICALLY (the guard), asserted
 *           both in-process AND in a PLAIN-NODE SUBPROCESS (so the rejection depends on neither the test
 *           runner nor the Node version).
 *     GREEN after `build.mjs`, the same production importer resolves every compiled `.js` handler — again
 *           in-process AND in a plain-node subprocess (the built output really runs on the js-only runtime).
 *     SEAM  the explicit `typeStrippingImporter` loads the raw `.ts` handlers (dev still works, via the
 *           seam, not ambient Node).
 *
 *   stream-backend — the whole surface is an extension PACK, loaded by `loadExtensions`:
 *     RED   the production importer rejects the raw `.ts` pack (entry + handlers) fail-closed.
 *     GREEN after `build.mjs`, the production importer resolves the BUILT pack — `.js`-preferred resolution
 *           picks the compiled `.js` siblings while the manifest keeps its authored `.ts` module paths (no
 *           manifest rewrite).
 *     SEAM  the explicit `typeStrippingImporter` loads the raw `.ts` pack.
 *
 * FAIL-THE-FIX: removing the `assertCompiledJavaScriptModule(...)` call from `defaultImporter` (a
 * `.ts`-aware production runtime) flips every RED arm; a build step that stopped emitting resolvable `.js`,
 * or a `.js`-preferred resolution that stopped preferring the compiled sibling, flips a GREEN arm.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultImporter,
  ExtensionLoadError,
  HandlerLoadError,
  loadExtensions,
  loadHandlers,
  typeStrippingImporter,
} from '@rayspec/platform';
import type { HandlerSpec } from '@rayspec/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// packages/app/server/src -> repo-root/examples/*
const repoRoot = resolve(here, '../../../..');
const ACME_DIR = resolve(repoRoot, 'examples/acme-notes-backend');
const ACME_BUILD = resolve(ACME_DIR, 'build.mjs');
const STREAM_DIR = resolve(repoRoot, 'examples/stream-backend');
const STREAM_BUILD = resolve(STREAM_DIR, 'build.mjs');

const require = createRequire(import.meta.url);
// The REAL, compiled `@rayspec/platform` entry (the js-only runtime a deploy loads modules through) — the
// plain-node subprocess imports the loader from THIS path, the same code `rayspec deploy` runs.
const PLATFORM_ENTRY = require.resolve('@rayspec/platform');

/** The acme-notes-backend handlers (one of each kind), addressed by their on-disk module basename. */
const ACME_HANDLERS = [
  {
    id: 'lookup_notebook_handler',
    file: 'lookup-notebook',
    export: 'lookupNotebook',
    kind: 'tool',
  },
  {
    id: 'nightly_digest_handler',
    file: 'nightly-digest',
    export: 'nightlyDigest',
    kind: 'trigger',
  },
  {
    id: 'list_completed_route',
    file: 'list-completed-route',
    export: 'listCompleted',
    kind: 'route',
  },
] as const;

/** Build the acme handler specs pointing at either the `.ts` source or the compiled `.js`. */
function acmeSpecs(ext: 'ts' | 'js'): HandlerSpec[] {
  return ACME_HANDLERS.map((h) => ({
    id: h.id,
    module: `handlers/${h.file}.${ext}`,
    export: h.export,
    kind: h.kind,
  }));
}

// ── plain-node subprocess: drive the REAL loader OUTSIDE vitest (no test-runner transform) ────────────
/**
 * A self-contained runner executed by a PLAIN `node` subprocess (NOT the vitest runner). It loads the
 * given handlers through the real `loadHandlers` + the PRODUCTION `defaultImporter` and prints ONE JSON
 * line — `{ ok, resolved }` on success, `{ ok:false, name, message }` on the fail-closed loader error.
 */
const RUNNER = `
import { pathToFileURL } from 'node:url';
const [platformEntry, root, ext, handlersJson] = process.argv.slice(2);
const { loadHandlers, defaultImporter } = await import(pathToFileURL(platformEntry).href);
const handlers = JSON.parse(handlersJson).map((h) => ({
  id: h.id, module: 'handlers/' + h.file + '.' + ext, export: h.export, kind: h.kind,
}));
try {
  const map = await loadHandlers(root, handlers, defaultImporter);
  const resolved = handlers.map((h) => ({ id: h.id, kind: map.get(h.id).kind, isFn: typeof map.get(h.id).fn === 'function' }));
  process.stdout.write(JSON.stringify({ ok: true, resolved }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, name: e && e.name, message: e && e.message }));
}
`;

interface RunnerResult {
  ok: boolean;
  resolved?: { id: string; kind: string; isFn: boolean }[];
  name?: string;
  message?: string;
}

let tmp: string;
let runnerPath: string;
let acmeBuiltDir: string;

function runLoaderInNode(root: string, ext: 'ts' | 'js'): RunnerResult {
  const out = execFileSync(
    process.execPath,
    [runnerPath, PLATFORM_ENTRY, root, ext, JSON.stringify(ACME_HANDLERS)],
    { encoding: 'utf8' },
  );
  return JSON.parse(out) as RunnerResult;
}

describe('deployable backend examples — compiled-JavaScript boundary (fail-the-fix, ground truth)', () => {
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rayspec-deployable-'));
    runnerPath = join(tmp, 'runner.mjs');
    writeFileSync(runnerPath, RUNNER);
    // Run the DOCUMENTED acme build step into an isolated dir (the acme handlers import their SDK
    // type-only, so the compiled `.js` has no runtime import and resolves from anywhere — incl. a subprocess).
    acmeBuiltDir = join(tmp, 'acme-built');
    execFileSync(process.execPath, [ACME_BUILD, `--out=${acmeBuiltDir}`], { stdio: 'pipe' });
    // Run the DOCUMENTED stream build step into its default in-repo `dist/` (the pack ENTRY imports
    // `@rayspec/platform` as a VALUE, so the built entry must resolve it from the workspace — which needs
    // the built pack to live inside the repo tree; this runs under vitest's workspace-aware resolver).
    execFileSync(process.execPath, [STREAM_BUILD], { stdio: 'pipe' });
  }, 120_000);

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(join(STREAM_DIR, 'packs', 'stream-pack', 'dist'), { recursive: true, force: true });
  });

  // ── acme-notes-backend: deployment-own `.ts` handlers via loadHandlers ──────────────────────────────
  describe('acme-notes-backend custom handlers', () => {
    it('RED (in-process): the production importer rejects the raw .ts handlers DETERMINISTICALLY (the guard)', async () => {
      const err = await loadHandlers(ACME_DIR, acmeSpecs('ts'), defaultImporter).catch((e) => e);
      expect(err).toBeInstanceOf(HandlerLoadError);
      // The DETERMINISTIC guard message — NOT Node's "Unknown file extension" (which never fires on a
      // type-stripping Node). Removing the guard from `defaultImporter` would import the `.ts` and this flips.
      expect((err as Error).message).toMatch(/TypeScript source|compiled JavaScript/i);
    });

    it('RED (plain-node subprocess): the guard fires OUTSIDE vitest too (not a test-runner artifact)', () => {
      const res = runLoaderInNode(ACME_DIR, 'ts');
      expect(res.ok).toBe(false);
      expect(res.name).toBe('HandlerLoadError');
      expect(res.message).toMatch(/TypeScript source|compiled JavaScript/i);
    });

    it('GREEN (in-process): after the build, the production importer resolves every compiled .js handler', async () => {
      const map = await loadHandlers(acmeBuiltDir, acmeSpecs('js'), defaultImporter);
      expect(map.size).toBe(ACME_HANDLERS.length);
      for (const h of ACME_HANDLERS) expect(typeof map.get(h.id)?.fn).toBe('function');
      expect(new Set([...map.values()].map((r) => r.kind))).toEqual(
        new Set(['tool', 'trigger', 'route']),
      );
    });

    it('GREEN (plain-node subprocess): the built .js handlers really run on the js-only runtime', () => {
      const res = runLoaderInNode(acmeBuiltDir, 'js');
      expect(res.ok).toBe(true);
      expect(res.resolved).toHaveLength(ACME_HANDLERS.length);
      for (const r of res.resolved ?? []) expect(r.isFn).toBe(true);
    });

    it('SEAM: the explicit typeStrippingImporter loads the raw .ts handlers (dev works via the seam)', async () => {
      const map = await loadHandlers(ACME_DIR, acmeSpecs('ts'), typeStrippingImporter);
      expect(map.size).toBe(ACME_HANDLERS.length);
      for (const h of ACME_HANDLERS) expect(typeof map.get(h.id)?.fn).toBe('function');
    });
  });

  // ── stream-backend: the whole surface is an extension PACK via loadExtensions ────────────────────────
  describe('stream-backend extension pack', () => {
    const sourceRef = { id: 'stream_pack', module: './packs/stream-pack', version: '1.0.0' };
    const builtRef = { id: 'stream_pack', module: './packs/stream-pack/dist', version: '1.0.0' };

    /** Resolve a pack via the given importer, then load its handlers — the full composition-root path. */
    async function loadPack(
      ref: typeof sourceRef,
      importer: typeof defaultImporter,
    ): Promise<number> {
      const loaded = await loadExtensions([ref], {
        packsRoot: STREAM_DIR,
        deploymentRoot: STREAM_DIR,
        importer,
      });
      const handlers = await loadHandlers(STREAM_DIR, loaded.handlers, loaded.importer);
      return handlers.size;
    }

    it('RED: the production importer rejects the raw .ts pack fail-closed (the guard)', async () => {
      const err = await loadPack(sourceRef, defaultImporter).catch((e) => e);
      expect(err).toBeInstanceOf(ExtensionLoadError);
      expect((err as Error).message).toMatch(/TypeScript source|compiled JavaScript/i);
    });

    it('GREEN: after the build, the production importer resolves the built pack (.js-preferred)', async () => {
      // The manifest keeps its authored `.ts` module paths; `.js`-preferred resolution loads the compiled
      // `.js` siblings the build emitted — so the production importer (compiled-JS-only) accepts the pack.
      expect(await loadPack(builtRef, defaultImporter)).toBe(3);
    });

    it('SEAM: the explicit typeStrippingImporter loads the raw .ts pack (dev works via the seam)', async () => {
      expect(await loadPack(sourceRef, typeStrippingImporter)).toBe(3);
    });
  });
});
