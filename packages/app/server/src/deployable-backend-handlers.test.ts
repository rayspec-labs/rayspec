/**
 * DEPLOYABILITY of a backend example that ships custom escape-hatch handlers.
 *
 * The `rayspec` serve/deploy runtime loads each `handlers[].module` with a plain dynamic import on a
 * JavaScript-only runtime — it cannot execute TypeScript. So a backend-profile document that
 * references custom `.ts` handlers is NOT deployable as authored: the loader fails closed at boot with
 * `Unknown file extension ".ts"`. The fix is a documented BUILD STEP (examples/acme-notes-backend/
 * build.mjs) that compiles the handlers to `.js` and emits a deploy-ready spec — NOT a runtime that
 * understands `.ts`.
 *
 * This test proves the build step closes the gap, exercised through the REAL loader:
 *   - RED  — pointing `loadHandlers` at the raw `handlers/*.ts` source fails with the unknown-extension
 *            error (the exact production failure). This is asserted in a PLAIN-NODE SUBPROCESS because
 *            the vitest runner transparently transpiles `.ts` (so the failure only surfaces on the real
 *            js-only runtime, which is what a deploy actually runs).
 *   - GREEN — after `build.mjs`, pointing the SAME loader at the compiled `handlers/*.js` resolves every
 *            handler to a callable function.
 *
 * FAIL-THE-FIX: if a future change made the loader silently accept `.ts` (a `.ts`-aware runtime) or the
 * build step stopped emitting resolvable `.js`, one of the two halves flips and this test breaks.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// packages/app/server/src -> repo-root/examples/acme-notes-backend
const repoRoot = resolve(here, '../../../..');
const EXAMPLE_DIR = resolve(repoRoot, 'examples/acme-notes-backend');
const BUILD_SCRIPT = resolve(EXAMPLE_DIR, 'build.mjs');

// Resolve the REAL, compiled `@rayspec/platform` entry (the js-only runtime a deploy loads handlers
// through). The subprocess imports the loader from THIS path — the same code `rayspec deploy` runs.
const require = createRequire(import.meta.url);
const PLATFORM_ENTRY = require.resolve('@rayspec/platform');

// The three handlers the acme-notes backend declares (id + export + kind, per its rayspec.yaml).
const HANDLERS = [
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

/**
 * A self-contained runner executed by a PLAIN `node` subprocess (NOT the vitest runner, so no `.ts`
 * transpile). It loads the given handlers through the real `loadHandlers` + `defaultImporter` and
 * prints a single JSON result line — `{ ok, resolved }` on success, `{ ok:false, name, message }` on
 * the fail-closed loader error.
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
let builtDir: string;

function runLoader(root: string, ext: 'ts' | 'js'): RunnerResult {
  const out = execFileSync(
    process.execPath,
    [runnerPath, PLATFORM_ENTRY, root, ext, JSON.stringify(HANDLERS)],
    { encoding: 'utf8' },
  );
  return JSON.parse(out) as RunnerResult;
}

describe('a backend example with custom .ts handlers is deployable only after the build step', () => {
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rayspec-deployable-'));
    runnerPath = join(tmp, 'runner.mjs');
    writeFileSync(runnerPath, RUNNER);
    // Run the DOCUMENTED build step into an isolated directory (no side effect on the example tree).
    builtDir = join(tmp, 'built');
    execFileSync(process.execPath, [BUILD_SCRIPT, `--out=${builtDir}`], { stdio: 'pipe' });
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('RED: the real loader rejects the raw .ts handlers with the unknown-extension error', () => {
    const res = runLoader(EXAMPLE_DIR, 'ts');
    expect(res.ok).toBe(false);
    expect(res.name).toBe('HandlerLoadError');
    // The exact production failure a deploy hits on the js-only runtime.
    expect(res.message).toContain('Unknown file extension ".ts"');
  });

  it('GREEN: after the build step the same loader resolves every compiled .js handler to a function', () => {
    const res = runLoader(builtDir, 'js');
    expect(res.ok).toBe(true);
    expect(res.resolved).toHaveLength(HANDLERS.length);
    for (const r of res.resolved ?? []) {
      expect(r.isFn).toBe(true);
    }
    // The kinds round-trip through the loader (tool/trigger/route), proving real resolution.
    expect(new Set(res.resolved?.map((r) => r.kind))).toEqual(
      new Set(['tool', 'trigger', 'route']),
    );
  });
});
