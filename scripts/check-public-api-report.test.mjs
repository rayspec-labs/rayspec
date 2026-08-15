#!/usr/bin/env node
/**
 * Regression test for the public-API report gate (`check-public-api-report.mjs`).
 *
 * The gate's whole value is that it FIRES: a checked-in report nobody can make go red is worth
 * nothing. It also has an unusual PASS that has to be pinned down — a tree where no package declares
 * the opt-in marker passes, because the scanned set is declared data rather than a fixed directory
 * root. Both properties are held here.
 *
 * The test drives the REAL script. It derives its repo root from its own location
 * (`join(dirname(fileURLToPath(import.meta.url)), '..')`), so copying it into `<throwaway>/scripts/`
 * makes `<throwaway>` the repo root — which lets a package be declared, undeclared, unbuilt or stale
 * without touching this checkout. The throwaway packages carry `dist` and NO `src`, which is also how
 * this test pins the "derived from the built declarations, not from source" contract.
 *
 * Five cases, so a pass means something:
 *
 *   (Z) NO package declares the marker — PASSES, and says the set was empty rather than staying quiet.
 *   (C) a declared, populated, up-to-date package PASSES, the count is reported, and the written
 *       report really carries the surface (the scan reached the declarations).
 *   (V) a surface change with a stale report FAILS, and so does a hand-edited report — the accept
 *       control, in both directions — then `--write` makes it green again.
 *   (G) a declared package with NO report FAILS CLOSED, naming the package.
 *   (B) a declared package that was never built FAILS CLOSED — an unbuilt package must never be
 *       recorded as an empty surface.
 *
 * Standalone (no test framework is wired for the gate scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const GATE = 'check-public-api-report.mjs';
const PKG = 'packages/contract';

/** Run the gate and capture exit code + streams. */
function runGate(scriptPath, args = []) {
  try {
    const stdout = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

/**
 * Build a throwaway repo whose root is the workspace itself: the gate script lands in
 * `<ws>/scripts/`, and `files` (relative paths → contents) are written under `<ws>`.
 */
function throwawayRepo(files) {
  const ws = mkdtempSync(join(tmpdir(), 'rayspec-api-report-'));
  mkdirSync(join(ws, 'scripts'), { recursive: true });
  cpSync(join(SCRIPTS_DIR, GATE), join(ws, 'scripts', GATE));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(ws, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { ws, script: join(ws, 'scripts', GATE) };
}

const WORKSPACE_YAML = 'packages:\n  - "packages/*"\n';
const ROOT_MANIFEST = `${JSON.stringify({ name: 'throwaway-root', private: true }, null, 2)}\n`;

/** The declared package's manifest, with or without the opt-in marker. */
function manifest({ declared }) {
  return `${JSON.stringify(
    {
      name: '@throwaway/contract',
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      ...(declared ? { rayspecPublicApi: 'api-report.md' } : {}),
    },
    null,
    2,
  )}\n`;
}

// Built type declarations only — there is no `src` anywhere in the throwaway tree, so a report that
// carries these names can only have come from `dist`. Three of these shapes put a `}` at top level
// WITHOUT ending the statement (a clause re-export, a union, an intersection); a splitter that cuts
// there loses the module a clause re-exports from and reads the union as several malformed exports.
const INDEX_DTS = `/** A doc comment that must NOT reach the report. */
export type { SectionName } from './names.js';
export type { Elsewhere } from 'other-package';
export interface SectionContext {
    readonly tenantId: string;
}
export type SectionKind = {
    readonly kind: 'route';
} | {
    readonly kind: 'tool';
};
export declare function isSectionName(value: unknown): value is SectionName;
`;
const NAMES_DTS = `export type SectionName = string & {
    readonly __sectionName: true;
};
`;

/** The throwaway tree: `declared` toggles the opt-in marker, `built` toggles the declarations. */
function tree({ declared = true, built = true } = {}) {
  return {
    'pnpm-workspace.yaml': WORKSPACE_YAML,
    'package.json': ROOT_MANIFEST,
    [`${PKG}/package.json`]: manifest({ declared }),
    ...(built
      ? { [`${PKG}/dist/index.d.ts`]: INDEX_DTS, [`${PKG}/dist/names.d.ts`]: NAMES_DTS }
      : {}),
  };
}

const created = [];
try {
  // ── (Z) nothing has opted in — a PASS the gate states out loud ─────────────────────────────────
  // The scanned set is DECLARED DATA read from the manifests, not a directory root that could vanish,
  // so an empty set is a legitimate state. It must still be visible, never a silent exit 0.
  {
    const { ws, script } = throwawayRepo(tree({ declared: false }));
    created.push(ws);
    const r = runGate(script);
    assert.equal(
      r.code,
      0,
      `(Z) a tree where nothing has opted in must PASS; got ${r.code}: ${r.err}`,
    );
    assert.match(
      r.out,
      /PASSED: 0 declared package\(s\)/,
      '(Z) the empty declared set must be reported',
    );
    assert.match(
      r.out,
      /workspace manifest\(s\) scanned/,
      '(Z) the coverage it achieved must be reported',
    );
    console.log('ok (Z) — an empty declared set passes and says so');
  }

  // ── (C) a declared, up-to-date package passes, and the report really carries the surface ───────
  {
    const { ws, script } = throwawayRepo(tree());
    created.push(ws);

    const written = runGate(script, ['--write']);
    assert.equal(written.code, 0, `(C) --write must succeed; got ${written.code}: ${written.err}`);
    const report = readFileSync(join(ws, PKG, 'api-report.md'), 'utf8');
    for (const name of [
      'Elsewhere',
      'SectionContext',
      'SectionKind',
      'SectionName',
      'isSectionName',
    ]) {
      assert.ok(
        report.includes(`### \`${name}\``),
        `(C) the report must record the export ${name}`,
      );
    }
    // The names alone are not enough: a reader that reached the entry file but not the modules it
    // re-exports from would still list every name — and then a change to the DECLARATION would be
    // invisible. Pin the declaration bodies, from the entry file AND from the module behind it.
    assert.ok(
      report.includes('readonly __sectionName: true;'),
      '(C) a re-exported declaration must be recorded from the module that declares it',
    );
    assert.ok(
      report.includes("readonly kind: 'route';") && report.includes("readonly kind: 'tool';"),
      '(C) a union declaration must be recorded whole, not cut at its first closing brace',
    );
    assert.ok(
      report.includes('### `Elsewhere` — re-exported from `other-package`'),
      '(C) a name borrowed from another package must be recorded as such',
    );
    assert.ok(
      !report.includes('declared outside the readable declaration closure'),
      '(C) every name of a readable surface must resolve to where it is declared',
    );
    assert.ok(
      !report.includes('must NOT reach the report'),
      '(C) doc comments are not part of the surface and must not churn the report',
    );
    assert.ok(!report.includes('0.0.0'), '(C) the package version must not churn the report');

    const r = runGate(script);
    assert.equal(r.code, 0, `(C) a fresh report must PASS; got ${r.code}: ${r.err}`);
    assert.match(r.out, /PASSED/, '(C) a fresh report must report PASSED');
    assert.match(
      r.out,
      /1 declared package\(s\)/,
      '(C) the PASS line must report the coverage it achieved',
    );
    assert.match(r.out, /5 export\(s\)/, '(C) the PASS line must report the surface it read');
    console.log('ok (C) — a declared, up-to-date package passes and reports its coverage');
  }

  // ── (V) the detector fires in both directions (the accept control for the guards below) ────────
  {
    const { ws, script } = throwawayRepo(tree());
    created.push(ws);
    assert.equal(runGate(script, ['--write']).code, 0, '(V) the fixture must start green');

    // V1: the declarations gain an export and the report is not regenerated.
    const indexPath = join(ws, PKG, 'dist/index.d.ts');
    writeFileSync(indexPath, `${INDEX_DTS}export declare function addedLater(): void;\n`);
    const changed = runGate(script);
    assert.notEqual(changed.code, 0, '(V) a surface change with a stale report must FAIL');
    assert.match(changed.err, /addedLater/, '(V) the added export must appear in the diff');
    assert.match(changed.err, /^@@ /m, '(V) the failure must print a unified diff');
    assert.match(changed.err, /--write/, '(V) the failure must name the regeneration command');

    // V2: the declarations are untouched and the REPORT is hand-edited.
    assert.equal(runGate(script, ['--write']).code, 0, '(V) --write must make it green again');
    assert.equal(runGate(script).code, 0, '(V) a regenerated report must pass');
    const reportPath = join(ws, PKG, 'api-report.md');
    writeFileSync(
      reportPath,
      readFileSync(reportPath, 'utf8').replace(
        'readonly tenantId: string;',
        'readonly tenantId: number;',
      ),
    );
    const edited = runGate(script);
    assert.notEqual(edited.code, 0, '(V) a hand-edited report must FAIL');
    assert.match(edited.err, /tenantId/, '(V) the hand-edited line must appear in the diff');
    console.log(
      `ok (V) — a stale report and a hand-edited report are both detected (exit ${edited.code})`,
    );
  }

  // ── (G) a declared package with no report fails CLOSED ─────────────────────────────────────────
  {
    const { ws, script } = throwawayRepo(tree());
    created.push(ws);
    const r = runGate(script);
    assert.notEqual(r.code, 0, '(G) a declared package with no report must fail CLOSED');
    assert.match(r.err, /MISSING or unreadable/, '(G) the fail-closed reason must be named');
    assert.match(r.err, /@throwaway\/contract/, '(G) the package must be named');
    assert.match(r.err, /--write/, '(G) the regeneration command must be named');
    console.log(`ok (G) — a declared package with no report fails closed (exit ${r.code})`);
  }

  // ── (B) a declared package that was never built fails CLOSED ───────────────────────────────────
  // Not a hypothetical: reading an unbuilt package as an EMPTY surface would let `--write` erase a
  // whole report, and the erased report would then compare clean.
  {
    const { ws, script } = throwawayRepo(tree());
    created.push(ws);
    assert.equal(runGate(script, ['--write']).code, 0, '(B) the fixture must start green');
    rmSync(join(ws, PKG, 'dist'), { recursive: true, force: true });
    for (const args of [[], ['--write']]) {
      const r = runGate(script, args);
      assert.notEqual(
        r.code,
        0,
        `(B) an unbuilt declared package must fail CLOSED (args: ${args})`,
      );
      assert.match(
        r.err,
        /built type declarations are MISSING/,
        '(B) the fail-closed reason must be named',
      );
      assert.match(r.err, /pnpm build/, '(B) the fix must be named');
    }
    const survived = readFileSync(join(ws, PKG, 'api-report.md'), 'utf8');
    assert.ok(
      survived.includes('### `SectionContext`'),
      '(B) a refused --write must not erase the report',
    );
    console.log('ok (B) — an unbuilt declared package fails closed and its report survives');
  }

  console.log('\npublic-api-report gate regression: ALL CASES PASSED');
} finally {
  for (const d of created) rmSync(d, { recursive: true, force: true });
}
