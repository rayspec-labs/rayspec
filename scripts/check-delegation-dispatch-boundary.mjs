#!/usr/bin/env node
/**
 * Delegation dispatch-boundary CI gate — the workforce toolset's import boundary.
 *
 * The workforce toolset layer (`packages/kernel/workforce-tools`) COMPUTES typed turn intents; only
 * the engine DISPATCHES. A toolset module that could reach the executor, the agent runner, the
 * platform's run surface, an adapter, or an app package would be a path by which a tool call
 * EXECUTES another agent instead of writing an intent — the exact inversion the intent design
 * exists to prevent. This gate FAILS THE BUILD on any such import, plus on any VALUE import of the
 * engine's write/execute functions from `@rayspec/tasks` (the toolset may consume the engine's
 * types and schemas, never its write paths), any opaque module-loader escape hatch, and any
 * relative import that escapes the scanned root.
 *
 * MIRRORS scripts/check-handler-imports.mjs: a greppable TRIPWIRE (no AST), COMMENT-stripped with
 * a STRING-AWARE pass before analysis, with a SELF-TEST that proves the detector fires on every
 * forbidden vector AND passes the sanctioned imports — run BEFORE any scan (exit 2 on a self-test
 * failure, distinct from a real violation's exit 1). Unlike the handler gate, the scanned roots
 * ALWAYS exist on this main line, so a zero-file scan is a FAILURE, never a skip (the
 * check-tenant-chokepoint posture). DELIBERATELY SELF-CONTAINED (no scripts/lib import): the
 * gate-coverage regression copies exactly one script file into a throwaway repo root.
 *
 * HONEST SCOPE / known ceiling: a regex tripwire over trusted-author first-party code, not an AST.
 * It cannot see an import laundered THROUGH an allowed workspace package (those packages carry
 * their own gates), it flags `import type` of a banned engine function name deliberately (nothing
 * needs those types; distinguishing them is not worth the parser), and an opaque dynamic specifier
 * is flagged rather than resolved. The load-bearing defenses behind it are the package manifests
 * (no forbidden dependency is declared), review, and the engine's own claim/receipt checks.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from THIS file via fileURLToPath — a checkout path with a space (or any
// other percent-encodable character) survives, where `new URL(import.meta.url).pathname` would
// leave a literal `%20` in the path and break every join below.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The workforce toolset roots. These ALWAYS exist — an empty scan is a gate failure. */
const WORKFORCE_TOOLSET_ROOTS = ['packages/kernel/workforce-tools/src'];

/**
 * Module specifiers a toolset module may NEVER import (exact or subpath). The executor and its
 * engines, the run surface, every adapter, and the app/HTTP packages — each is a path from a tool
 * to running an agent or serving a surface, which the boundary exists to make unreachable.
 */
const FORBIDDEN_IMPORT_PREFIXES = [
  '@rayspec/durable-dbos',
  '@rayspec/platform',
  '@rayspec/server',
  '@rayspec/cli',
  '@rayspec/api-auth',
  '@rayspec/adapter-',
  '@rayspec/foundation',
  '@rayspec/workflow-durable',
];

/**
 * The engine's WRITE/EXECUTE surface in `@rayspec/tasks` — importing any of these names from the
 * tasks package is how a toolset would apply intents instead of producing them. Types and schemas
 * (TurnIntent, workerResultSchema, TaskRecord, …) stay importable; these identifiers do not, even
 * as `import type` (nothing legitimate needs those types — see the HONEST SCOPE note).
 */
const FORBIDDEN_TASKS_IMPORTS = new Set([
  'afterTaskTerminal',
  'applyBudgetExhausted',
  'applyReviewVerdict',
  'applyReviewVerdictInTx',
  'applyTransition',
  'applyTurnOutcome',
  'authorizeTurn',
  'cancelDescendants',
  'cancelTaskCascade',
  'createRootTask',
  'decideApproval',
  'deliverSignal',
  'ensureWorkforceRuntime',
  'haltWorkforce',
  'insertChildTask',
  'pauseWorkforce',
  'releaseTurnReservation',
  'resumeWorkforce',
  'settleTurn',
  'sweepApprovalTimeouts',
]);

const MODULE_EXTS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** Walk a root; symlinks are FLAGGED (never followed) — they could graft an out-of-tree subtree. */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // the zero-scan guard below turns an absent root into a FAILURE.
  }
  for (const name of entries) {
    const full = join(dir, name);
    const lst = lstatSync(full);
    if (lst.isSymbolicLink()) {
      yield { full, isSymlink: true };
      continue;
    }
    if (lst.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      yield* walk(full);
    } else if (MODULE_EXTS.some((ext) => name.endsWith(ext))) {
      yield { full, isSymlink: false };
    }
  }
}

/**
 * Strip `//` and slash-star comments in ONE left-to-right, STRING-AWARE pass (a delimiter inside a
 * string/template is NOT a comment; string content is preserved because the import extractor needs
 * the source strings; `\` escapes inside strings are honored).
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The static source-string body: single/double/backtick-quoted with NO `${` substitution. */
const Q = String.raw`(?:'([^']+)'|"([^"]+)"|\`([^\`$]+)\`)`;

/** Extract every static import/export-from/dynamic-import source AND its specifier clause. */
function extractImports(codeNoComments) {
  const found = [];
  const patterns = [
    new RegExp(String.raw`\bimport\s+type\s+([^'"\`]*?)\bfrom\s*${Q}`, 'g'),
    new RegExp(String.raw`\bimport\s+([^'"\`]*?)\bfrom\s*${Q}`, 'g'),
    new RegExp(String.raw`\bexport\s+([^'"\`]*?)\bfrom\s*${Q}`, 'g'),
    new RegExp(String.raw`\bimport\s*()${Q}`, 'g'), // side-effect import (empty clause)
    new RegExp(String.raw`\bimport\s*\(\s*()${Q}\s*\)`, 'g'),
    new RegExp(String.raw`\brequire\s*\(\s*()${Q}\s*\)`, 'g'),
  ];
  for (const re of patterns) {
    let m;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
    while ((m = re.exec(codeNoComments)) !== null) {
      found.push({ clause: m[1] ?? '', source: m[2] ?? m[3] ?? m[4] });
    }
  }
  return found;
}

/** Capture a call's first paren-balanced argument text, starting just after the opening `(`. */
function captureCallArg(s, start) {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return s.slice(start, i);
    }
  }
  return null;
}

/** Opaque loader escape hatches + non-static dynamic specifiers — flagged on sight. */
function detectOpaqueLoaders(rel, codeNoComments) {
  const found = [];
  const LOADER_ESCAPE_HATCHES = [
    { re: /\bcreateRequire\s*\(/, what: 'createRequire(...) (the require-factory escape hatch)' },
    { re: /\bModule\s*\.\s*_load\b/, what: 'Module._load (the internal CJS loader)' },
    {
      re: /\.\s*constructor\s*\.\s*_load\b/,
      what: 'module.constructor._load (the internal CJS loader via constructor)',
    },
    { re: /\bprocess\s*\.\s*binding\b/, what: 'process.binding (a native-binding escape hatch)' },
    {
      re: /\brequire\s*\.\s*main\s*\.\s*require\b/,
      what: 'require.main.require (a parent-module require escape hatch)',
    },
    {
      re: /\bprocess\s*\.\s*mainModule\s*\.\s*require\b/,
      what: 'process.mainModule.require (a parent-module require escape hatch)',
    },
  ];
  for (const { re, what } of LOADER_ESCAPE_HATCHES) {
    if (re.test(codeNoComments)) {
      found.push(
        `${rel}: uses ${what} — a module-resolution escape hatch the dispatch boundary cannot ` +
          'vet. Fail-closed.',
      );
    }
  }
  const STATIC_STRING_ARG = /^\s*(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*$/;
  const callRe = /\b(import|require)\s*\(/g;
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
  while ((m = callRe.exec(codeNoComments)) !== null) {
    const arg = captureCallArg(codeNoComments, m.index + m[0].length);
    if (arg === null) continue;
    if (!STATIC_STRING_ARG.test(arg)) {
      found.push(
        `${rel}: dynamic ${m[1]}(${arg.trim().slice(0, 40)}…) — the argument is not a single ` +
          'static string literal; an opaque specifier cannot be vetted at the dispatch boundary. ' +
          'Fail-closed.',
      );
    }
  }
  return found;
}

/** True if the import source names a forbidden package (exact or a subpath of a prefix). */
function isForbiddenPackage(source) {
  return FORBIDDEN_IMPORT_PREFIXES.some((prefix) => source === prefix || source.startsWith(prefix));
}

/**
 * The PURE detector — (repo-relative file path, raw source) → violation strings. No I/O, so the
 * self-test exercises the exact production logic.
 */
export function detectViolations(rel, src, root) {
  const violations = [];
  const code = stripComments(src);
  for (const { clause, source } of extractImports(code)) {
    if (isForbiddenPackage(source)) {
      violations.push(
        `${rel}: imports '${source}' — the workforce toolset may not reach the executor, the run ` +
          'surface, an adapter, or an app package. It PRODUCES typed intents; only the engine ' +
          'dispatches. Fail-closed.',
      );
      continue;
    }
    if (source === '@rayspec/tasks' || source.startsWith('@rayspec/tasks/')) {
      // Named value imports of the engine's write/execute surface. The clause is the text between
      // `import`/`export` and `from`; scan its identifiers against the banned set.
      const names = clause.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
      for (const name of names) {
        if (FORBIDDEN_TASKS_IMPORTS.has(name)) {
          violations.push(
            `${rel}: imports '${name}' from '@rayspec/tasks' — an engine write/execute function. ` +
              'The toolset consumes the engine\u2019s types and schemas, never its write paths. ' +
              'Fail-closed.',
          );
        }
      }
      continue;
    }
    if (source.startsWith('.')) {
      // A relative specifier must stay inside the scanned root: `../..` walking out of the
      // toolset tree is an import of un-gated code by another name.
      const resolved = posix.normalize(posix.join(posix.dirname(rel), source));
      if (!resolved.startsWith(`${root}/`)) {
        violations.push(
          `${rel}: relative import '${source}' escapes the toolset root ('${resolved}') — ` +
            'out-of-root code is not covered by this boundary. Fail-closed.',
        );
      }
    }
  }
  violations.push(...detectOpaqueLoaders(rel, stripComments(src)));
  return violations;
}

// ─── SELF-TEST (runs BEFORE any scan; exit 2 on failure) ─────────────────────────────────────────
function selfTest() {
  const root = 'packages/kernel/workforce-tools/src';
  const at = (name) => `${root}/${name}`;
  const cases = [
    // FIRE: one static import per forbidden package prefix (+ a subpath).
    {
      rel: at('a.ts'),
      src: "import { DbosTaskScheduler } from '@rayspec/durable-dbos';",
      expect: true,
    },
    { rel: at('a.ts'), src: "import { runAgent } from '@rayspec/platform';", expect: true },
    { rel: at('a.ts'), src: "import x from '@rayspec/platform/dispatch';", expect: true },
    { rel: at('a.ts'), src: "import { assembleServer } from '@rayspec/server';", expect: true },
    { rel: at('a.ts'), src: "import cli from '@rayspec/cli';", expect: true },
    { rel: at('a.ts'), src: "import { createAuthApp } from '@rayspec/api-auth';", expect: true },
    {
      rel: at('a.ts'),
      src: "import { OpenAIBackend } from '@rayspec/adapter-openai';",
      expect: true,
    },
    { rel: at('a.ts'), src: "import { engine } from '@rayspec/workflow-durable';", expect: true },
    // FIRE: import type of a forbidden package; export-from; side-effect; dynamic; backtick.
    {
      rel: at('a.ts'),
      src: "import type { TaskTurnHandler } from '@rayspec/durable-dbos';",
      expect: true,
    },
    { rel: at('a.ts'), src: "export { runAgent } from '@rayspec/platform';", expect: true },
    { rel: at('a.ts'), src: "import '@rayspec/server';", expect: true },
    { rel: at('a.ts'), src: "const m = await import('@rayspec/platform');", expect: true },
    { rel: at('a.ts'), src: "const m = require('@rayspec/adapter-pi');", expect: true },
    { rel: at('a.ts'), src: 'const m = await import(`@rayspec/durable-dbos`);', expect: true },
    // FIRE: engine write/execute names from @rayspec/tasks (value AND type form).
    { rel: at('a.ts'), src: "import { applyTurnOutcome } from '@rayspec/tasks';", expect: true },
    {
      rel: at('a.ts'),
      src: "import { applyTransition, deliverSignal } from '@rayspec/tasks';",
      expect: true,
    },
    {
      rel: at('a.ts'),
      src: "import type { applyTurnOutcome } from '@rayspec/tasks';",
      expect: true,
    },
    { rel: at('a.ts'), src: "import { cancelTaskCascade } from '@rayspec/tasks';", expect: true },
    // FIRE: opaque loaders + non-static dynamic specifiers + root-escaping relative imports.
    {
      rel: at('a.ts'),
      src: "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url);",
      expect: true,
    },
    { rel: at('a.ts'), src: 'const name = pick(); const m = await import(name);', expect: true },
    { rel: at('a.ts'), src: 'const m = await import(`@rayspec/${pkg}`);', expect: true },
    {
      rel: at('a.ts'),
      src: "import { x } from '../../../workflow/durable-dbos/src/task-scheduler.js';",
      expect: true,
    },
    {
      rel: at('nested/deep.ts'),
      src: "import { y } from '../../other-package/src/thing.js';",
      expect: true,
    },
    // PASS: the sanctioned imports and benign look-alikes.
    { rel: at('a.ts'), src: "import { z } from 'zod';", expect: false },
    {
      rel: at('a.ts'),
      src: "import { RESERVED_WORKFORCE_TOOL_NAMES } from '@rayspec/core';",
      expect: false,
    },
    { rel: at('a.ts'), src: "import { schema, forTenant } from '@rayspec/db';", expect: false },
    {
      rel: at('a.ts'),
      src: "import { deriveWorkforceConfig } from '@rayspec/spec';",
      expect: false,
    },
    {
      rel: at('a.ts'),
      src: "import { turnIntentSchema, workerResultSchema } from '@rayspec/tasks';",
      expect: false,
    },
    {
      rel: at('a.ts'),
      src: "import type { TaskRecord, TurnIntent } from '@rayspec/tasks';",
      expect: false,
    },
    { rel: at('a.ts'), src: "import { TurnCollector } from './collector.js';", expect: false },
    { rel: at('nested/deep.ts'), src: "import { roles } from '../roles.js';", expect: false },
    { rel: at('a.ts'), src: "// import { runAgent } from '@rayspec/platform';", expect: false },
    {
      rel: at('a.ts'),
      src: 'const note = "uses \'@rayspec/platform\' at runtime";',
      expect: false,
    },
    { rel: at('a.ts'), src: "const doc = 'call applyTurnOutcome later';", expect: false },
  ];
  for (const { rel, src, expect: shouldFire } of cases) {
    const fired = detectViolations(rel, src, 'packages/kernel/workforce-tools/src').length > 0;
    if (fired !== shouldFire) {
      console.error(
        `delegation-dispatch-boundary gate SELF-TEST FAILED: expected ${shouldFire ? 'FIRE' : 'PASS'} ` +
          `for ${JSON.stringify(src.slice(0, 80))} but the detector ${fired ? 'fired' : 'passed'}. ` +
          'Refusing to scan with a broken detector.',
      );
      process.exit(2);
    }
  }
}

// ─── SCAN ────────────────────────────────────────────────────────────────────────────────────────
selfTest();

const violations = [];
let scannedFiles = 0;
let scannedRoots = 0;
for (const root of WORKFORCE_TOOLSET_ROOTS) {
  let filesInRoot = 0;
  for (const entry of walk(join(repoRoot, root))) {
    const rel = relative(repoRoot, entry.full).split('\\').join('/');
    if (entry.isSymlink) {
      violations.push(
        `${rel}: is a SYMLINK under the toolset root — it could point outside the gated tree and ` +
          'is not followed. Fail-closed.',
      );
      continue;
    }
    filesInRoot += 1;
    violations.push(...detectViolations(rel, readFileSync(entry.full, 'utf8'), root));
  }
  if (filesInRoot === 0) {
    console.error(
      `delegation-dispatch-boundary gate FAILED: scanned 0 source file(s) under ${root} — the ` +
        'workforce toolset root must exist and hold code. An empty scan proves nothing. Fail-closed.',
    );
    process.exit(1);
  }
  scannedFiles += filesInRoot;
  scannedRoots += 1;
}

if (violations.length > 0) {
  console.error(
    `delegation-dispatch-boundary gate FAILED (${violations.length} violation(s)):\n` +
      violations.map((v) => `  - ${v}`).join('\n'),
  );
  process.exit(1);
}

console.log(
  `delegation-dispatch-boundary gate PASSED: ${scannedFiles} source file(s) across ` +
    `${scannedRoots} root(s) — the workforce toolset layer imports no executor / run-surface / ` +
    'adapter / app module and none of the engine\u2019s write paths.',
);
