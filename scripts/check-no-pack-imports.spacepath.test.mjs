#!/usr/bin/env node
/**
 * Regression test for the no-pack gate's checkout-path portability + fail-closed guard.
 *
 * TWO bugs, one root cause. `check-no-pack-imports.mjs` derived the repo root from
 * `new URL(import.meta.url).pathname`, which leaves a literal `%20` (etc.) in the path when the
 * checkout directory contains a space. Every `join(repoRoot, …)` below it then pointed at a
 * NON-EXISTENT `…/has%20space/…` tree, so `walk()` read ZERO files — and the gate reported "no
 * violations" and exited 0. That is a FAIL-OPEN: a genuine `products/`/`sdks/` seam import in a
 * space-path checkout sailed through un-detected.
 *
 * The fix is `fileURLToPath(import.meta.url)` (space survives) PLUS a guard that exits NON-ZERO when
 * the scan read zero platform files AND zero package.json files (a scan that read nothing must never
 * certify the seam as clean). This test builds throwaway trees under a SPACE path and drives the REAL
 * script through `node`, asserting all three post-fix behaviours:
 *
 *   (P) a seam import in a space-path checkout is now DETECTED (exit 1) — pre-fix it exited 0.
 *   (C) a clean space-path checkout PASSES (exit 0) — the scan actually reached the files.
 *   (G) a scan that reads nothing fails CLOSED (exit ≠ 0) — the fail-open backstop.
 *
 * Standalone (no test framework is wired for the gate scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-no-pack-imports.mjs');

/** Run the gate script located at `scriptPath` (from its own dir) and capture exit code + output. */
function runGate(scriptPath) {
  try {
    const stdout = execFileSync('node', [scriptPath], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    // execFileSync throws on a non-zero exit; the child's streams hang off the error.
    return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

/** Make a fresh throwaway workspace whose path CONTAINS A SPACE. */
function spaceWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'rayspec has space-'));
  assert.ok(root.includes(' '), `workspace path must contain a space, got: ${root}`);
  return root;
}

const created = [];
try {
  // ── (P) a seam import under a SPACE path is now DETECTED (pre-fix: exited 0, fail-open) ──────────
  {
    const ws = spaceWorkspace();
    created.push(ws);
    mkdirSync(join(ws, 'scripts'), { recursive: true });
    mkdirSync(join(ws, 'packages', 'plat', 'src'), { recursive: true });
    cpSync(SCRIPT, join(ws, 'scripts', 'check-no-pack-imports.mjs'));
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'root', version: '0.0.0' }));
    // A genuine static seam import — the gate must flag it. The specifier is assembled from parts so
    // THIS test file's own source never contains a literal `from '…products/…'` line, which the
    // line-based no-pack scan (it scans scripts/ too) would otherwise flag as a real seam import.
    const seamSpecifier = ['..', '..', '..', 'products', 'foo', 'bar.js'].join('/');
    writeFileSync(
      join(ws, 'packages', 'plat', 'src', 'seam.ts'),
      `import { x } from '${seamSpecifier}';\nexport const y = x;\n`,
    );
    const r = runGate(join(ws, 'scripts', 'check-no-pack-imports.mjs'));
    assert.notEqual(
      r.code,
      0,
      '(P) a seam import under a space path must FAIL (was fail-open exit 0)',
    );
    assert.match(r.err, /\[seam-import\]/, '(P) the seam import must be reported');
    console.log('ok (P) — seam import under a space path is detected (exit', `${r.code})`);
  }

  // ── (C) a CLEAN space-path checkout passes (the scan reached the files through the space) ────────
  {
    const ws = spaceWorkspace();
    created.push(ws);
    mkdirSync(join(ws, 'scripts'), { recursive: true });
    mkdirSync(join(ws, 'packages', 'plat', 'src'), { recursive: true });
    cpSync(SCRIPT, join(ws, 'scripts', 'check-no-pack-imports.mjs'));
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'root', version: '0.0.0' }));
    writeFileSync(
      join(ws, 'packages', 'plat', 'src', 'ok.ts'),
      "import { readFileSync } from 'node:fs';\nexport const y = readFileSync;\n",
    );
    const r = runGate(join(ws, 'scripts', 'check-no-pack-imports.mjs'));
    assert.equal(
      r.code,
      0,
      `(C) a clean space-path checkout must PASS; got exit ${r.code}: ${r.err}`,
    );
    assert.match(r.out, /PASSED/, '(C) a clean scan must report PASSED');
    console.log('ok (C) — clean space-path checkout passes (exit', `${r.code})`);
  }

  // ── (G) a scan that reads NOTHING fails CLOSED (the fail-open backstop) ──────────────────────────
  // The script sits in a dir NOT named `scripts/`, so its derived repoRoot has no packages/scripts/
  // examples code and no package.json to scan — the guard must refuse to PASS an empty scan.
  {
    const ws = spaceWorkspace();
    created.push(ws);
    mkdirSync(join(ws, 'tools'), { recursive: true });
    cpSync(SCRIPT, join(ws, 'tools', 'check-no-pack-imports.mjs'));
    const r = runGate(join(ws, 'tools', 'check-no-pack-imports.mjs'));
    assert.notEqual(r.code, 0, '(G) an empty scan must fail CLOSED');
    assert.match(
      r.err,
      /scanned 0 platform source files/,
      '(G) the fail-closed reason must be named',
    );
    console.log('ok (G) — empty scan fails closed (exit', `${r.code})`);
  }

  console.log('\nno-pack space-path regression: ALL CASES PASSED');
} finally {
  for (const d of created) rmSync(d, { recursive: true, force: true });
}
