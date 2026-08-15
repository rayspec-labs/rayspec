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
 * Twelve cases, so a pass means something:
 *
 *   (Z) NO package declares the marker — PASSES, and says the set was empty rather than staying quiet.
 *   (C) a declared, populated, up-to-date package PASSES, the count is reported, and the written
 *       report really carries the surface (the scan reached the declarations).
 *   (V) a surface change with a stale report FAILS, and so does a hand-edited report — the accept
 *       control, in both directions — then `--write` makes it green again.
 *   (G) a declared package with NO report FAILS CLOSED, naming the package.
 *   (B) a declared package that was never built FAILS CLOSED — an unbuilt package must never be
 *       recorded as an empty surface.
 *   (D) a name with SEVERAL declarations (an overload set) keeps every one of them, and a default
 *       export is recorded — driven by declarations the compiler really emitted, and each removal is
 *       a diff.
 *   (N) a namespace re-export of a module INSIDE the package is read through: a change to a member
 *       FAILS. One that leaves the package stays a single opaque line.
 *   (I) a name bound by an IMPORT and re-exported by clause — the other spelling of the same promise,
 *       and the one the compiler emits — is read through too: a change behind either an
 *       `import * as ns` or a default import FAILS. A name the reader cannot reach inside the package
 *       fails CLOSED rather than being recorded as living outside the closure.
 *   (S) a declaration file that opens with a `#!` line keeps every export, and a signature change in
 *       the first one FAILS.
 *   (U) a top-level export the parser cannot read FAILS CLOSED, naming the file and the statement —
 *       an unreadable export is never dropped quietly.
 *   (O) a report whose package no longer declares the marker FAILS — a guard cannot retire itself by
 *       leaving its artifact behind.
 *   (Y) a re-export CYCLE reached through one entry point does not blind another: the name behind it
 *       keeps its declaration, retyping that declaration FAILS, and neither fact depends on which
 *       entry point is read first. One cache is shared by all of a package's entry points, so a
 *       surface truncated by a cycle break must not be memoised for the next reader.
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

/** A throwaway tree whose declared package carries exactly the given `dist` files. */
function treeWith(dist) {
  const files = { 'pnpm-workspace.yaml': WORKSPACE_YAML, 'package.json': ROOT_MANIFEST };
  files[`${PKG}/package.json`] = manifest({ declared: true });
  for (const [name, contents] of Object.entries(dist)) files[`${PKG}/dist/${name}`] = contents;
  return files;
}

// The VERBATIM emit of the repo's TypeScript (`tsc --emitDeclarationOnly`) for
//
//     export class Kernel { readonly id: string = 'a'; }
//     export function pick(value: string): string;
//     export function pick(value: number): number;
//     export function pick(value: unknown): unknown { return value; }
//     export default Kernel;
//
// — pasted rather than hand-written, so arm (D) cannot be satisfied by a shape the parser happens to
// like. The `;` after `export default Kernel` and the two consecutive `pick` lines are what the
// COMPILER produces, and both are exactly what a name-keyed reader loses.
const EMITTED_DTS = `export declare class Kernel {
    readonly id: string;
}
export declare function pick(value: string): string;
export declare function pick(value: number): number;
export default Kernel;
`;

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

  // ── (D) every declaration of a name, and the default export ────────────────────────────────────
  // A name routinely carries more than one top-level declaration — an overload set here, a `const`
  // beside a `type` of the same name elsewhere — and each one is a promise on its own. A reader that
  // keeps the LAST one records a surface the package does not have, and the removal of any other
  // declaration then compares clean.
  {
    const { ws, script } = throwawayRepo(treeWith({ 'index.d.ts': EMITTED_DTS }));
    created.push(ws);
    assert.equal(runGate(script, ['--write']).code, 0, '(D) --write must succeed');
    const report = readFileSync(join(ws, PKG, 'api-report.md'), 'utf8');
    assert.match(report, /^3 export\(s\)\./m, '(D) the default export must be counted');
    assert.ok(
      report.includes('### `default` — `dist/index.d.ts` (declared as `Kernel`)'),
      '(D) a default export must be recorded, and say what it is declared as',
    );
    assert.ok(
      report.includes('export declare function pick(value: string): string;') &&
        report.includes('export declare function pick(value: number): number;'),
      '(D) BOTH overloads must be recorded, not just the last one',
    );

    // Each declaration has to be load-bearing on its own: remove ONE overload, keep the other.
    const indexPath = join(ws, PKG, 'dist/index.d.ts');
    writeFileSync(
      indexPath,
      EMITTED_DTS.replace('export declare function pick(value: string): string;\n', ''),
    );
    const dropped = runGate(script);
    assert.notEqual(dropped.code, 0, '(D) removing ONE overload must FAIL');
    assert.match(dropped.err, /value: string/, '(D) the removed overload must appear in the diff');

    // …and so does the default export.
    writeFileSync(indexPath, EMITTED_DTS.replace('export default Kernel;\n', ''));
    const undefaulted = runGate(script);
    assert.notEqual(undefaulted.code, 0, '(D) removing the default export must FAIL');
    assert.match(
      undefaulted.err,
      /default/,
      '(D) the removed default export must appear in the diff',
    );
    console.log('ok (D) — every declaration of a name is recorded, and so is the default export');
  }

  // ── (N) a namespace re-export inside the package is read through ───────────────────────────────
  // `export * as ns from './local.js'` is inside this package's own readable closure, so recording it
  // as one opaque line would hide every member behind a line that never changes.
  {
    const INDEX = `export * as codes from './codes.js';
export * as elsewhere from 'other-package';
`;
    const CODES = `export declare const CODE_A: 'a';
export declare const CODE_B: 'b';
`;
    const { ws, script } = throwawayRepo(treeWith({ 'index.d.ts': INDEX, 'codes.d.ts': CODES }));
    created.push(ws);
    assert.equal(runGate(script, ['--write']).code, 0, '(N) --write must succeed');
    const report = readFileSync(join(ws, PKG, 'api-report.md'), 'utf8');
    assert.ok(
      report.includes('#### `codes.CODE_A`') &&
        report.includes("export declare const CODE_B: 'b';"),
      '(N) the members of a LOCAL namespace re-export must be recorded',
    );
    assert.ok(
      report.includes('### `elsewhere` — re-exported from `other-package` (namespace re-export)'),
      '(N) a namespace re-export that LEAVES the package stays one opaque line',
    );
    writeFileSync(join(ws, PKG, 'dist/codes.d.ts'), CODES.replace("CODE_B: 'b'", 'CODE_B: string'));
    const changed = runGate(script);
    assert.notEqual(changed.code, 0, '(N) a change INSIDE a local namespace re-export must FAIL');
    assert.match(changed.err, /CODE_B/, '(N) the changed member must appear in the diff');
    console.log('ok (N) — a local namespace re-export is read through, a foreign one stays opaque');
  }

  // ── (I) a name bound by an import and re-exported by clause is read through as well ────────────
  // `export * as ns from './x.js'` is only ONE spelling of a grouped export. The compiler emits the
  // other one whenever the source imports first and re-exports by name, and a reader that models only
  // the first records the members of the second as a single line that never changes — which is worse
  // than a missing section, because the line ASSERTS the members live outside the readable closure.
  {
    // The VERBATIM emit of the repo's TypeScript for
    //
    //     import * as codes from './codes.js';
    //     import Kernel from './kernel.js';
    //     export { codes };
    //     export { Kernel };
    //     export const TOP: string = 't';
    //
    // with `codes.ts` exporting two consts and `kernel.ts` a default class.
    const INDEX = `import * as codes from './codes.js';
import Kernel from './kernel.js';
export { codes };
export { Kernel };
export declare const TOP: string;
`;
    const CODES = `export declare const CODE_A = "a";
export declare const CODE_B = "b";
`;
    const KERNEL = `export default class Kernel {
    readonly id: string;
}
`;
    const { ws, script } = throwawayRepo(
      treeWith({ 'index.d.ts': INDEX, 'codes.d.ts': CODES, 'kernel.d.ts': KERNEL }),
    );
    created.push(ws);
    assert.equal(runGate(script, ['--write']).code, 0, '(I) --write must succeed');
    const report = readFileSync(join(ws, PKG, 'api-report.md'), 'utf8');
    assert.ok(
      !report.includes('declared outside the readable declaration closure'),
      '(I) a module inside the package is inside the closure — the report must not say otherwise',
    );
    assert.ok(
      report.includes('#### `codes.CODE_A`') &&
        report.includes('export declare const CODE_B = "b";'),
      '(I) the members behind an `import * as` binding must be recorded',
    );
    assert.ok(
      report.includes('### `Kernel` — `dist/kernel.d.ts`') &&
        report.includes('readonly id: string;'),
      '(I) the declaration behind a default import must be recorded',
    );

    // Each side has to be load-bearing: change a member behind the namespace binding…
    const codesPath = join(ws, PKG, 'dist/codes.d.ts');
    writeFileSync(codesPath, CODES.replace('CODE_B = "b"', 'CODE_B: string'));
    const retyped = runGate(script);
    assert.notEqual(retyped.code, 0, '(I) a change behind an `import * as` binding must FAIL');
    assert.match(retyped.err, /CODE_B/, '(I) the changed member must appear in the diff');

    // …and behind the default binding.
    writeFileSync(codesPath, CODES);
    writeFileSync(join(ws, PKG, 'dist/kernel.d.ts'), KERNEL.replace('id: string', 'id: number'));
    const reshaped = runGate(script);
    assert.notEqual(reshaped.code, 0, '(I) a change behind a default import must FAIL');
    assert.match(reshaped.err, /id: number/, '(I) the changed member must appear in the diff');

    // …and a name the reader cannot reach INSIDE the package fails closed rather than being recorded
    // as living outside it — the bodiless line is reserved for a name another package really owns.
    writeFileSync(join(ws, PKG, 'dist/kernel.d.ts'), KERNEL);
    writeFileSync(
      join(ws, PKG, 'dist/index.d.ts'),
      `${INDEX}export { Absent } from './codes.js';\n`,
    );
    for (const args of [[], ['--write']]) {
      const r = runGate(script, args);
      assert.notEqual(r.code, 0, `(I) an unreachable name must fail CLOSED (args: ${args})`);
      assert.match(r.err, /declares no such name/, '(I) the fail-closed reason must be named');
      assert.match(r.err, /Absent/, '(I) the name must be quoted');
    }
    console.log(
      'ok (I) — an imported binding is read through, and an unreachable name fails closed',
    );
  }

  // ── (S) a declaration file that opens with a `#!` line ─────────────────────────────────────────
  // An executable entry point emits one, it is not a comment and carries no `;`, so leaving it in
  // glues it to the first declaration and costs that export.
  {
    const INDEX = `#!/usr/bin/env node
export declare function main(argv: string[]): Promise<void>;
export declare function run(): void;
`;
    const { ws, script } = throwawayRepo(treeWith({ 'index.d.ts': INDEX }));
    created.push(ws);
    assert.equal(runGate(script, ['--write']).code, 0, '(S) --write must succeed');
    const report = readFileSync(join(ws, PKG, 'api-report.md'), 'utf8');
    assert.match(report, /^2 export\(s\)\./m, '(S) both exports must be counted');
    assert.ok(report.includes('### `main`'), '(S) the export after the `#!` line must be recorded');
    writeFileSync(
      join(ws, PKG, 'dist/index.d.ts'),
      INDEX.replace('main(argv: string[])', 'main(argv: string[], json: boolean)'),
    );
    const changed = runGate(script);
    assert.notEqual(changed.code, 0, '(S) a signature change in that export must FAIL');
    assert.match(changed.err, /json: boolean/, '(S) the changed signature must appear in the diff');
    console.log('ok (S) — a `#!` line does not swallow the export that follows it');
  }

  // ── (U) an export the parser cannot read fails CLOSED ──────────────────────────────────────────
  // The alternative is the worst outcome available: the export leaves the report silently, and every
  // later change to it then compares clean.
  {
    const { ws, script } = throwawayRepo(
      treeWith({ 'index.d.ts': 'declare function legacy(a: string): void;\nexport = legacy;\n' }),
    );
    created.push(ws);
    for (const args of [[], ['--write']]) {
      const r = runGate(script, args);
      assert.notEqual(r.code, 0, `(U) an unreadable export must fail CLOSED (args: ${args})`);
      assert.match(r.err, /cannot read/, '(U) the fail-closed reason must be named');
      assert.match(r.err, /index\.d\.ts/, '(U) the file must be named');
      assert.match(r.err, /export = legacy;/, '(U) the statement must be quoted');
    }
    console.log('ok (U) — an export the parser cannot read fails closed instead of vanishing');
  }

  // ── (O) a report nobody declares any more fails ────────────────────────────────────────────────
  // The empty PASS is sound only while "nothing has opted in" is TRUE. A committed report is the
  // tree's own evidence that something did, so a one-key edit to a manifest must not be able to
  // retire the guard and leave the report behind to rot.
  {
    const { ws, script } = throwawayRepo(tree());
    created.push(ws);
    assert.equal(runGate(script, ['--write']).code, 0, '(O) the fixture must start green');
    writeFileSync(join(ws, PKG, 'package.json'), manifest({ declared: false }));
    writeFileSync(
      join(ws, PKG, 'dist/index.d.ts'),
      `${INDEX_DTS}export declare function addedAfterTheMarkerWasLost(): void;\n`,
    );
    for (const args of [[], ['--write']]) {
      const r = runGate(script, args);
      assert.notEqual(r.code, 0, `(O) an unclaimed report must FAIL (args: ${args})`);
      assert.match(r.err, /claimed by NO manifest/, '(O) the reason must be named');
      assert.match(r.err, /api-report\.md/, '(O) the orphaned report must be named');
    }
    console.log('ok (O) — a report whose package dropped the marker fails instead of rotting');
  }

  // ── (Y) a re-export cycle behind ONE entry point must not blind ANOTHER ───────────────────────
  // One `cache` is shared by every entry point of a package. A surface computed while a cycle was
  // open is truncated by that break, and the truncation is valid ONLY for the entry point that
  // opened it. Caching it handed the truncation to the next reader: `A` — declared right there in
  // `a.d.ts` — rendered as a bodiless "declared outside the readable declaration closure" line, and
  // every later change to that declaration passed the gate GREEN. The declaration recorded for a
  // name must not depend on which entry point happened to be read first.
  {
    const twoEntryPoints = (altFirst) =>
      `${JSON.stringify(
        {
          name: '@throwaway/contract',
          version: '0.0.0',
          private: true,
          type: 'module',
          exports: altFirst
            ? {
                './alt': { types: './dist/alt.d.ts' },
                '.': { types: './dist/index.d.ts' },
              }
            : {
                '.': { types: './dist/index.d.ts' },
                './alt': { types: './dist/alt.d.ts' },
              },
          rayspecPublicApi: 'api-report.md',
        },
        null,
        2,
      )}\n`;
    const cyclicDist = (aType) => ({
      'pnpm-workspace.yaml': WORKSPACE_YAML,
      'package.json': ROOT_MANIFEST,
      // `index` -> `a` -> `b` -> `a` is the cycle; `alt` -> `b` -> `a` reaches `A` acyclically.
      [`${PKG}/dist/index.d.ts`]: "export { X } from './a.js';\n",
      [`${PKG}/dist/a.d.ts`]: `export { X } from './b.js';\nexport declare const A: ${aType};\n`,
      [`${PKG}/dist/b.d.ts`]: "export { A } from './a.js';\nexport declare const X: string;\n",
      [`${PKG}/dist/alt.d.ts`]: "export { A } from './b.js';\n",
    });
    const BODILESS = 'declared outside the readable declaration closure';

    for (const altFirst of [false, true]) {
      const order = altFirst ? 'alt-first' : 'index-first';
      const { ws, script } = throwawayRepo({
        ...cyclicDist('string'),
        [`${PKG}/package.json`]: twoEntryPoints(altFirst),
      });
      created.push(ws);
      assert.equal(
        runGate(script, ['--write']).code,
        0,
        `(Y) the cyclic fixture must regenerate (${order})`,
      );
      const report = readFileSync(join(ws, PKG, 'api-report.md'), 'utf8');
      assert.ok(
        !report.includes(BODILESS),
        `(Y) no name declared inside the package may be recorded bodiless (${order})`,
      );
      assert.ok(
        report.includes('export declare const A: string;'),
        `(Y) the declaration behind the cycle must be recorded (${order})`,
      );
      assert.ok(
        report.includes('export declare const X: string;'),
        `(Y) the declaration on the cyclic path must be recorded too (${order})`,
      );

      // The accept control: retyping that declaration must be caught. This exited 0 before the fix.
      writeFileSync(join(ws, PKG, 'dist/a.d.ts'), cyclicDist('number')[`${PKG}/dist/a.d.ts`]);
      const changed = runGate(script, []);
      assert.notEqual(
        changed.code,
        0,
        `(Y) retyping a declaration reached through a cycle must FAIL (${order})`,
      );
      assert.match(
        changed.err,
        /const A/,
        `(Y) the changed declaration must appear in the diff (${order})`,
      );
    }
    console.log('ok (Y) — a cycle behind one entry point does not blind another');
  }

  console.log('\npublic-api-report gate regression: ALL CASES PASSED');
} finally {
  for (const d of created) rmSync(d, { recursive: true, force: true });
}
