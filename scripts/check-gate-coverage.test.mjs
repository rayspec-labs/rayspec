#!/usr/bin/env node
/**
 * Regression test for the coverage guard on the two chokepoint-family gates.
 *
 * `check-tenant-chokepoint.mjs` and `check-adapter-no-handlers.mjs` walk a fixed list of source
 * roots. `walk()` returns silently when a directory does not exist ("root doesn't exist yet"), so a
 * rename or a move of any declared root made the gate read ZERO files, find zero violations, and exit
 * 0 with its normal PASS line — the guard retired itself without a signal. That is the same FAIL-OPEN
 * that `check-no-pack-imports.mjs` closed with a scanned-count guard (see its
 * `check-no-pack-imports.spacepath.test.mjs`); these two gates carry the same guard now.
 *
 * The test drives the REAL scripts. Each script derives its repo root from its own location
 * (`join(dirname(fileURLToPath(import.meta.url)), '..')`), so copying it into `<throwaway>/scripts/`
 * makes `<throwaway>` the repo root — which lets the roots be present, absent, or clean without
 * touching this checkout.
 *
 * Three cases per gate, so a pass means something:
 *
 *   (C) a populated tree PASSES — the scan actually reached the files, and the count is reported.
 *   (V) a planted violation FAILS — the detector still fires (the accept control for case G).
 *   (G) a root that resolves to nothing FAILS CLOSED, naming the unscanned root.
 *
 * Standalone (no test framework is wired for the gate scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Run a gate script and capture exit code + streams. */
function runGate(scriptPath) {
  try {
    const stdout = execFileSync('node', [scriptPath], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

/**
 * Build a throwaway repo whose root is the workspace itself: the gate script lands in
 * `<ws>/scripts/`, and `files` (relative paths → contents) are written under `<ws>`.
 */
function throwawayRepo(scriptName, files) {
  const ws = mkdtempSync(join(tmpdir(), 'rayspec-gate-coverage-'));
  mkdirSync(join(ws, 'scripts'), { recursive: true });
  cpSync(join(SCRIPTS_DIR, scriptName), join(ws, 'scripts', scriptName));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(ws, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { ws, script: join(ws, 'scripts', scriptName) };
}

const BENIGN = "import { readFileSync } from 'node:fs';\nexport const y = readFileSync;\n";

// The roots each gate declares. Kept here deliberately rather than imported: if a root is renamed in
// the gate and not here, case (C) stops finding files and this test goes red — which is exactly the
// drift the guard exists to catch.
const CHOKEPOINT_ROOTS = [
  'packages/kernel/platform/src',
  'packages/compose/api-auth/src',
  'packages/workflow/durable-dbos/src',
  'packages/kernel/db/src',
];
const ADAPTER_ROOTS = [
  'packages/adapters/openai/src',
  'packages/adapters/anthropic/src',
  'packages/adapters/pi/src',
  'packages/adapters/codex/src',
];

/** A populated tree: one benign source file under every declared root. */
function populated(roots) {
  return Object.fromEntries(roots.map((r) => [`${r}/ok.ts`, BENIGN]));
}

const created = [];
try {
  for (const [gate, script, roots, violation, violationPattern] of [
    [
      'tenant-chokepoint',
      'check-tenant-chokepoint.mjs',
      CHOKEPOINT_ROOTS,
      {
        path: 'packages/kernel/platform/src/leak.ts',
        src: "import { makeDb } from '@rayspec/db';\nexport const db = makeDb('u');\n",
      },
      /makeDb/,
    ],
    [
      'adapter-no-handlers',
      'check-adapter-no-handlers.mjs',
      ADAPTER_ROOTS,
      {
        path: 'packages/adapters/openai/src/leak.ts',
        src: 'export const toolHandlers = {\n  lookup: async () => ({ ok: true }),\n};\n',
      },
      /toolHandlers|handler/i,
    ],
  ]) {
    // ── (C) a populated tree passes, and says how much it read ─────────────────────────────────────
    {
      const { ws, script: s } = throwawayRepo(script, populated(roots));
      created.push(ws);
      const r = runGate(s);
      assert.equal(r.code, 0, `(C/${gate}) a populated tree must PASS; got ${r.code}: ${r.err}`);
      assert.match(r.out, /PASSED/, `(C/${gate}) a clean scan must report PASSED`);
      assert.match(
        r.out,
        new RegExp(`${roots.length} root\\(s\\)`),
        `(C/${gate}) the PASS line must report the coverage it achieved`,
      );
      console.log(`ok (C/${gate}) — populated tree passes and reports its coverage`);
    }

    // ── (V) the detector still fires (accept control for the guard below) ──────────────────────────
    {
      const files = populated(roots);
      files[violation.path] = violation.src;
      const { ws, script: s } = throwawayRepo(script, files);
      created.push(ws);
      const r = runGate(s);
      assert.notEqual(r.code, 0, `(V/${gate}) a planted violation must FAIL`);
      assert.match(r.err, violationPattern, `(V/${gate}) the violation must be named`);
      console.log(`ok (V/${gate}) — planted violation is detected (exit ${r.code})`);
    }

    // ── (G) a root that resolves to nothing fails CLOSED ───────────────────────────────────────────
    // Every root but the first is populated, so this is precisely the "one directory was renamed"
    // case — not a wholly empty checkout, which a coarser guard would also catch.
    {
      const files = populated(roots.slice(1));
      const { ws, script: s } = throwawayRepo(script, files);
      created.push(ws);
      const r = runGate(s);
      assert.notEqual(
        r.code,
        0,
        `(G/${gate}) a root that reads nothing must fail CLOSED, not PASS vacuously`,
      );
      assert.match(
        r.err,
        /scanned 0 source file\(s\)/,
        `(G/${gate}) the fail-closed reason must be named`,
      );
      assert.ok(
        r.err.includes(roots[0]),
        `(G/${gate}) the unscanned root must be named; got: ${r.err}`,
      );
      console.log(`ok (G/${gate}) — an unscanned root fails closed (exit ${r.code})`);
    }
  }

  console.log('\ngate-coverage regression: ALL CASES PASSED');
} finally {
  for (const d of created) rmSync(d, { recursive: true, force: true });
}
