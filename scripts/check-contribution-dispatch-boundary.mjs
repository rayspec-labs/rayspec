#!/usr/bin/env node
/**
 * Contribution-dispatch-boundary CI gate — only a service may reach the run surface.
 *
 * A pack's REACTIVE contributions are called BY the platform: a route is served, a tool is invoked, a
 * trigger fires. None of them may turn around and drive an agent themselves. The RUN SURFACE — the
 * platform entry points that execute or schedule an agent turn (`runAgent`, the neutral
 * `DurableExecutor` enqueue seam and the engine behind it, the run-header writes that accompany a
 * schedule, and the `TurnDispatch` capability that hands that power out) — is reserved for a pack's
 * `services` contribution, the one kind the platform boots rather than calls.
 *
 * THE INVARIANT THIS GATE HOLDS: no module reachable from a pack's `handlers/` subtree, or from a
 * `tooling` contribution (whose `handler` id resolves into that same subtree), may import the run
 * surface. A `services` module may — it lives in its own subtree beside `handlers/`, which is not a
 * scanned root, so the exemption is STRUCTURAL rather than a listed exception. Nothing under a scanned
 * root is exempt: a directory NAMED `services` nested inside `handlers/` is still scanned, so the
 * exemption cannot be bought by naming a folder.
 *
 * "REACHABLE" WITHOUT A MODULE GRAPH. The gate reads every module file under a contribution root, and
 * closes the ways a module could reach the run surface from somewhere it does not read. A specifier
 * that LEAVES the scanned root is a violation however it is spelled — a relative path that climbs out
 * with `..`, an ABSOLUTE path, a URL specifier (`file:`, `data:`, `http:` …; `node:` is the one scheme
 * a contributed module legitimately writes), or a `#…` SUBPATH specifier whose target lives in a
 * package.json `imports` map this gate does not read. An opaque dynamic `import()`/`require()` — an
 * argument that is not one static string — is a violation too. What is left is either scanned here or
 * a bare specifier this gate vets by name.
 *
 * MIRRORS scripts/check-handler-imports.mjs: a greppable TRIPWIRE (no AST), COMMENT-stripped by a
 * string-aware pass before analysis, with a PURE `detectViolations(rel, src)` and a SELF-TEST that
 * runs BEFORE any scan and exits 2 (distinct from a real violation's exit 1) when the detector itself
 * is wrong. Deliberately SELF-CONTAINED — it imports no shared helper, so the whole gate is one file
 * that can be dropped into a throwaway root and driven end to end.
 *
 * HONEST CEILING (stated, not silently accepted):
 *   - It cannot tell `import type { runAgent }` from `import { runAgent }`, and FLAGS BOTH. That is
 *     deliberate: nothing on this side of the boundary needs the TYPE of a run-surface function, and
 *     buying the distinction costs a parser this gate does not want.
 *   - It matches import SOURCES and the names in an import CLAUSE. A run-surface function re-exported
 *     under a different name by some third package, or reached through an aliased local binding, is
 *     out of reach of a greppable tripwire — as is any name the scanned module never writes down. An
 *     import of a run-surface-bearing package whose bindings the gate cannot ENUMERATE is therefore
 *     flagged on sight: a `*` namespace, a DEFAULT binding, a side-effect import and a dynamic
 *     `import()`/`require()` all hand the module an object whose members the gate cannot see. A
 *     member named with a STRING rather than an identifier (`{ "runAgent" as go }`, legal since
 *     ES2022) is refused on the same ground and for a sharper reason: the clause reader cannot even
 *     extract such a statement, so leaving it unflagged would clear it against every rule at once.
 *   - It bounds IMPORTS, not behaviour. The capability contract is what actually withholds
 *     `TurnDispatch` from a handler; this gate is the forcing function that keeps the code shaped so
 *     that withholding it stays meaningful.
 *
 * ZERO FILES IS A FAILURE, NEVER A SKIP. Every declared contribution root must exist AND yield at
 * least one module file. A renamed or moved root would otherwise retire the scan with no signal —
 * zero files read, zero violations found, a normal PASS line.
 *
 * AN UNDECLARED ROOT IS A FAILURE TOO. The zero-file rule is fail-closed against a root that goes
 * AWAY; on its own it says nothing about a root that ARRIVES. So after the scan the gate walks
 * `examples/` for every directory named `handlers` and fails when one is missing from the declared
 * list — a new deployment or pack cannot ship handlers that this boundary silently exempts.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The contribution roots to scan — every in-repo `handlers/` subtree a deployment or a pack ships.
 * DECLARED DATA rather than parsed out of the deployment YAMLs, because this gate is self-contained by
 * design (it carries no YAML reader). Two rules keep the list honest, one per direction: the ZERO-FILE
 * rule below fails on a root that is renamed, moved or emptied, and the UNDECLARED-ROOT rule fails on
 * a `handlers/` directory that exists on disk and is missing from this list. A new deployment or pack
 * that ships handlers adds its root here — and the gate says so, in red, until it does.
 */
const CONTRIBUTION_ROOTS = [
  'examples/acme-notes-backend/handlers',
  'examples/expense-claim-coder/handlers',
  'examples/lead-qualifier/handlers',
  'examples/live-workspace-events/handlers',
  'examples/agent-pack-deployment/packs/agent-pack/handlers',
  'examples/stream-backend/packs/stream-pack/handlers',
];

/**
 * Where the undeclared-root rule LOOKS for contribution roots. This repo's deployments and packs all
 * live under `examples/`; a `handlers` directory inside `packages/` is platform code implementing the
 * handler machinery, not a contribution to it, and is out of scope by construction. A directory named
 * `handlers` anywhere under these must appear in `CONTRIBUTION_ROOTS`.
 */
const CONTRIBUTION_SEARCH_DIRS = ['examples'];

/**
 * Packages that EXIST to run or schedule agent turns. ANY import of one from this side of the
 * boundary is a violation — there is no benign reason a contributed handler names them. Prefix-matched
 * against the import source, so a deep subpath is caught with the bare specifier.
 */
const RUN_SURFACE_MODULE_PREFIXES = ['@rayspec/durable-dbos', '@rayspec/workflow-durable'];

/**
 * Packages that CARRY the run surface among other exports. Importing a NAMED binding from one is
 * judged by the name (below); an import whose bindings cannot be enumerated is flagged on sight,
 * because the object it hands over hides which member is taken through it.
 */
const RUN_SURFACE_BEARING_PREFIXES = [
  '@rayspec/platform',
  '@rayspec/server',
  ...RUN_SURFACE_MODULE_PREFIXES,
];

/**
 * The run-surface BINDINGS — the names that execute, schedule or hand out an agent turn. Matched
 * EXACTLY against the identifiers in an import/export clause, from ANY source, so re-exporting the
 * surface through an intermediate package does not launder it. `TurnDispatch` is listed before it
 * exists: this boundary lands ahead of the capability it guards, so the day the capability is named,
 * naming it on this side is already a build failure.
 */
const RUN_SURFACE_NAMES = new Set([
  'runAgent',
  'DurableExecutor',
  'DbosDurableExecutor',
  'RunJob',
  'EnqueueResult',
  'insertEnqueuedRunHeader',
  'markRunHeaderRunning',
  'TurnDispatch',
]);

/** Clause words that are syntax, not an imported binding. */
const CLAUSE_KEYWORDS = new Set(['type', 'as', 'from', 'default']);

/** Module file extensions a contributed module may be authored in. */
const MODULE_EXTS = ['.ts', '.tsx', '.mjs', '.js', '.cjs'];

/**
 * Walk a contribution root, yielding `{ full, isSymlink }` for every module file. Uses `lstatSync`
 * (NOT statSync) so a SYMLINK is detected rather than followed — a symlinked entry under the root
 * could point OUT of the scanned subtree, and a symlinked DIRECTORY could graft a whole out-of-tree
 * subtree in. Both are flagged and neither is followed. No subdirectory is exempt: a nested folder
 * named `services` is walked like any other.
 */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // an absent root reads nothing — the zero-file rule turns that into a FAILURE below.
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
 * Strip `//` line comments and slash-star block comments in a SINGLE left-to-right pass that is
 * STRING-AWARE: a comment delimiter is recognized ONLY when we are NOT inside a string/template
 * literal, so a delimiter that lives INSIDE a string is left intact (a naive two-regex strip mis-reads
 * such a delimiter as a real comment and can mangle the code around it, hiding an import). String
 * CONTENT is PRESERVED — the import extractor needs the source strings. Backslash escapes inside a
 * string are honored so an escaped quote does not end it early.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null; // current string delimiter: ' " or ` — null when outside a string
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

/**
 * Extract every import/export-from/dynamic-import from comment-stripped source as
 * `{ clause, source }`. The CLAUSE is the binding text between the keyword and `from` (empty for a
 * side-effect / dynamic import); the SOURCE is the specifier. Covers single-quote, double-quote AND
 * BACKTICK (no-substitution template) specifiers — a backtick source must not slip past a quote-only
 * matcher. A dynamic import with a NON-static argument is not source-extractable and is handled by
 * `detectDynamicImportViolations` instead.
 */
function extractImports(codeNoComments) {
  const found = [];
  const Q = String.raw`(?:'([^']+)'|"([^"]+)"|\`([^\`$]+)\`)`;
  // Each entry: [regex, hasClause]. A clause pattern captures the bindings in group 1, so the source
  // lands in groups 2-4; a clause-less pattern puts the source in groups 1-3.
  const patterns = [
    [new RegExp(String.raw`\bimport\s+([^'"\`;]*?)\bfrom\s*${Q}`, 'g'), true],
    [new RegExp(String.raw`\bexport\s+([^'"\`;]*?)\bfrom\s*${Q}`, 'g'), true],
    [new RegExp(String.raw`\bimport\s*${Q}`, 'g'), false], // side-effect import
    [new RegExp(String.raw`\bimport\s*\(\s*${Q}\s*\)`, 'g'), false], // dynamic, static string
    [new RegExp(String.raw`\brequire\s*\(\s*${Q}\s*\)`, 'g'), false], // require, static string
  ];
  for (const [re, hasClause] of patterns) {
    let m;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
    while ((m = re.exec(codeNoComments)) !== null) {
      const base = hasClause ? 1 : 0;
      found.push({
        clause: hasClause ? m[1] : '',
        source: m[base + 1] ?? m[base + 2] ?? m[base + 3],
      });
    }
  }
  return found;
}

/** The identifiers an import/export clause names, with the clause syntax words dropped. */
function clauseIdentifiers(clause) {
  return (clause.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((id) => !CLAUSE_KEYWORDS.has(id));
}

/** True when the clause takes a whole namespace (`* as ns`, or a bare `export *` re-export). */
function isNamespaceClause(clause) {
  return clause.includes('*');
}

/**
 * True when a clause takes the module's DEFAULT export from INSIDE a `{ … }` group — `{ default as
 * platform }`, or the `export { default } from …` re-export. This is the same whole-exports object the
 * bare `import platform from …` spelling hands over, only written where a brace-stripping test would
 * mistake it for an enumerable named binding, so both spellings have to be refused alike. Judged per
 * SPECIFIER, on the imported-name side: the mirror position `{ runAgent as default }` takes an
 * ENUMERABLE named export and merely renames it on the way out, and stays judged by that name.
 */
function takesDefaultBinding(clause) {
  for (const group of clause.match(/\{[^}]*\}/g) ?? []) {
    for (const specifier of group.slice(1, -1).split(',')) {
      if (/^\s*(?:type\s+)?default\b/.test(specifier)) return true;
    }
  }
  return false;
}

/**
 * True when an import takes bindings the gate CANNOT ENUMERATE, so judging it by name is impossible:
 * a `*` namespace, a DEFAULT binding (under CJS interop the whole exports object — written either
 * OUTSIDE the `{ … }` group or aliased INSIDE it, which is the same take), or NO clause at all, which
 * is how `extractImports` records a side-effect import, a dynamic `import()` and a `require()`.
 * Applied to a run-surface-BEARING package this is a refusal, for the same reason the namespace case
 * always was: the module gets an object and the gate cannot see which member it reaches through it.
 */
function isUnenumerableClause(clause) {
  if (clause.trim() === '' || isNamespaceClause(clause)) return true;
  if (takesDefaultBinding(clause)) return true;
  return clauseIdentifiers(clause.replace(/\{[^}]*\}/g, ' ')).length > 0;
}

/** True if the source is (or is a subpath of) a package that exists to run or schedule agent turns. */
function isRunSurfaceModule(source) {
  return RUN_SURFACE_MODULE_PREFIXES.some((p) => source === p || source.startsWith(`${p}/`));
}

/** True if the source is (or is a subpath of) a package that carries the run surface among its exports. */
function isRunSurfaceBearing(source) {
  return RUN_SURFACE_BEARING_PREFIXES.some((p) => source === p || source.startsWith(`${p}/`));
}

/**
 * Name the way a specifier LEAVES the scanned root, or return `null` when it does not. Reaching a
 * module this gate never read is exactly the hole the "reachable" claim has to close, and the `..`
 * climb is only its most obvious spelling: the identical reach written as an absolute path, a `file:`
 * URL or a `#`-subpath alias must fail the same way, or the rule is decoration. A sibling relative
 * import stays inside the root and is therefore already scanned; a bare package specifier is vetted by
 * name above; `node:` is the one URL scheme a contributed module legitimately writes.
 */
function escapeKind(source) {
  if (source.startsWith('.')) {
    return source.split(/[/\\]/).includes('..') ? "a '..'-escaping relative path" : null;
  }
  if (source.startsWith('#')) {
    return "a '#'-subpath specifier (its target lives in a package.json imports map, unread here)";
  }
  if (source.startsWith('/') || source.startsWith('\\') || isAbsolute(source)) {
    return 'an absolute path';
  }
  const scheme = /^([a-zA-Z][a-zA-Z\d+\-.]*):/.exec(source);
  if (scheme !== null && scheme[1] !== 'node') return `a '${scheme[1]}:' URL specifier`;
  return null;
}

/**
 * Flag a dynamic `import()` / `require()` / `createRequire(...)()` whose argument is NOT a single
 * STATIC string literal (a template with a substitution, a concatenation, a variable) — an opaque
 * specifier the gate cannot vet, so it could resolve to the run surface at runtime. The module-loader
 * escape hatches below are flagged ON SIGHT: each one is a way to build or invoke a loader outside
 * `import()`/`require()`, and a contributed module has no business constructing one.
 */
function detectDynamicImportViolations(rel, codeNoComments) {
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
        `${rel}: uses ${what} — a module-resolution escape hatch that could reach the run surface ` +
          'unseen (fail-closed).',
      );
    }
  }
  const STATIC_STRING_ARG = /^\s*(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*$/;
  const callRe = /\b(import|require)\s*\(/g;
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
  while ((m = callRe.exec(codeNoComments)) !== null) {
    const argStart = m.index + m[0].length;
    const arg = captureCallArg(codeNoComments, argStart);
    if (arg === null) continue;
    if (!STATIC_STRING_ARG.test(arg)) {
      found.push(
        `${rel}: dynamic ${m[1]}(${arg.trim().slice(0, 40)}…) — the argument is not a single static ` +
          'string literal, so the gate cannot vet what it resolves to (fail-closed).',
      );
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

/**
 * Detect run-surface reach in one contributed module's source. Pure (no I/O) so the self-test
 * exercises the EXACT logic the scan runs. `rel` is used only for the message.
 */
export function detectViolations(rel, src) {
  const found = [];
  const code = stripComments(src);
  for (const { clause, source } of extractImports(code)) {
    if (isRunSurfaceModule(source)) {
      found.push(
        `${rel}: imports '${source}' — that package exists to run or schedule agent turns. A ` +
          'contributed handler or tooling module may not reach the run surface; only a service may.',
      );
    } else if (isRunSurfaceBearing(source) && isUnenumerableClause(clause)) {
      found.push(
        `${rel}: takes '${source}' through bindings the gate cannot enumerate (a namespace, a ` +
          'default binding, a side-effect import or a dynamic import()/require()) — it cannot see ' +
          'which member is used through that object, so an unenumerable take of a run-surface-' +
          'bearing package is refused (fail-closed).',
      );
    } else {
      for (const id of clauseIdentifiers(clause)) {
        if (RUN_SURFACE_NAMES.has(id)) {
          found.push(
            `${rel}: imports the run-surface binding '${id}' from '${source}' — only a service may ` +
              'execute or schedule an agent turn (a type-only import of one is refused too).',
          );
        }
      }
    }
    const leaves = escapeKind(source);
    if (leaves !== null) {
      found.push(
        `${rel}: imports ${leaves} '${source}' — it leaves the scanned contribution subtree and is ` +
          'not a bare specifier this gate can vet by name, so what it reaches is unverified ' +
          '(fail-closed).',
      );
    }
  }
  found.push(...detectQuotedNameViolations(rel, code));
  found.push(...detectDynamicImportViolations(rel, code));
  return found;
}

/**
 * ES2022 lets a brace group name a member with a STRING rather than an identifier
 * (`import { "runAgent" as go } from '@rayspec/platform'`). `extractImports` builds its clause from a
 * character class that excludes quotes, so a quoted name does not merely confuse the reader — the
 * whole statement is never extracted, and EVERY rule above silently reads zero. That is one spelling
 * walking past the run-surface name rule, the module-prefix rule, the unenumerable-take rule and the
 * root-escape rule at once.
 *
 * The reader is a greppable tripwire, not a parser, so it does not learn to read the name: it refuses
 * the statement it cannot vet. Same posture as the unenumerable-take rule — a name the gate cannot
 * read is a name it cannot clear. Applied to the COMMENT-STRIPPED source, so an apostrophe inside a
 * comment between the braces cannot manufacture a violation.
 *
 * EVERY spelling the grammar gives such a name is matched, because one that is NOT matched is cleared
 * against every rule at once — the defect this rule exists to close:
 *   - the brace clause on its own, or after `type` (`import type { "runAgent" as R } from …`);
 *   - the brace clause after a DEFAULT BINDING — `ImportClause : ImportedDefaultBinding , NamedImports`
 *     puts a binding and a comma before the brace (`import platform, { "runAgent" as go } from …`);
 *   - the namespace re-export whose EXPORTED name is a string — `ExportFromClause : * as
 *     ModuleExportName`, and a `ModuleExportName` may be a StringLiteral (`export * as "p" from …`).
 * The clause body reads a quoted run AS a run (backslash escapes honored), so a name that itself
 * carries a brace (`{ "a}b" as c }`) does not end the clause early and slip past.
 */
// A member/export NAME written as a string: a quoted run, escapes honored.
const NAME_STRING = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
// The module SPECIFIER: the same three quote styles `extractImports` accepts, sans its captures.
const SOURCE_STRING = String.raw`(?:'[^']+'|"[^"]+"|\`[^\`$]+\`)`;
// A brace clause that CARRIES a quote (the lookahead: a quoted name always opens before the clause's
// first `}`), read as runs so a `}` inside a name is not mistaken for the end of the clause.
const QUOTED_CLAUSE = String.raw`\{(?=[^{}]*['"])(?:[^{}'"]|${NAME_STRING})*\}`;
const QUOTED_MODULE_EXPORT_NAME = new RegExp(
  String.raw`\b(?:import|export)(?:\s*type)?(?:\s+[A-Za-z_$][\w$]*\s*,)?\s*${QUOTED_CLAUSE}\s*from\s*${SOURCE_STRING}` +
    String.raw`|\bexport(?:\s*type)?\s*\*\s*as\s*${NAME_STRING}\s*from\s*${SOURCE_STRING}`,
  'g',
);

function detectQuotedNameViolations(rel, code) {
  const found = [];
  for (const [statement] of code.matchAll(QUOTED_MODULE_EXPORT_NAME)) {
    found.push(
      `${rel}: names an imported member with a string literal (${statement.trim().slice(0, 80)}…) — ` +
        'this gate matches the names in an import clause, and a quoted member name is one it cannot ' +
        'read, so the statement is refused rather than cleared (fail-closed). Write the member as a ' +
        'plain identifier.',
    );
  }
  return found;
}

/**
 * Scan the given contribution roots under `root`. Returns the violations and the per-root file counts,
 * so the caller can apply the zero-file rule. Separated from the exit logic so the self-test can drive
 * a scan over a fixture tree it builds.
 */
export function scanContributionRoots(root, roots) {
  const violations = [];
  const counts = new Map();
  for (const rel of roots) {
    let n = 0;
    for (const { full, isSymlink } of walk(join(root, rel))) {
      const relPath = relative(root, full).split('\\').join('/');
      n++;
      if (isSymlink) {
        violations.push(
          `${relPath}: is a SYMLINK under a contribution root — a symlinked entry could graft in a ` +
            'subtree this gate never read; ship real files, not symlinks (fail-closed).',
        );
        continue;
      }
      violations.push(...detectViolations(relPath, readFileSync(full, 'utf8')));
    }
    counts.set(rel, n);
  }
  return { violations, counts };
}

/**
 * Discover every `handlers` directory under `searchDirs`, as repo-relative paths. This is the input to
 * the undeclared-root rule: a root found here that `CONTRIBUTION_ROOTS` does not declare is a gate
 * FAILURE, which is what stops a newly added deployment or pack from shipping handlers this boundary
 * never sees. `fs` only — no YAML reader, so the gate stays one self-contained file. Descent stops at
 * a discovered root (a nested `handlers` is already covered by the outer one) and skips build/vendor
 * output, which is a copy of a root, not a new one.
 */
export function discoverContributionRoots(root, searchDirs = CONTRIBUTION_SEARCH_DIRS) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an absent search dir contributes nothing to discover.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // a symlinked dir is not followed (see `walk`).
      const { name } = entry;
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (name === 'handlers') found.push(relative(root, full).split('\\').join('/'));
      else visit(full);
    }
  };
  for (const rel of searchDirs) visit(join(root, rel));
  return found.sort();
}

// --- self-test: the detector's vectors, then the scan's behaviour over real fixture trees ---------
function fail(message) {
  console.error(`contribution-dispatch-boundary gate SELF-TEST FAILED: ${message}`);
  process.exit(2);
}

/** Arm one: every run-surface vector fires, and everything a contributed module legitimately writes passes. */
function selfTestDetector() {
  const cases = [
    // the sanctioned import a contributed handler actually writes — must PASS
    {
      rel: 'h/x.ts',
      src: "import type { ToolHandler, ToolHandlerInit } from '@rayspec/handler-sdk';",
      expect: false,
    },
    // the run entry, named from the package that carries it — must FIRE
    { rel: 'h/x.ts', src: "import { runAgent } from '@rayspec/platform';", expect: true },
    // the same binding under an alias — must FIRE (the imported name is still written down)
    { rel: 'h/x.ts', src: "import { runAgent as go } from '@rayspec/platform';", expect: true },
    // the ceiling, stated as a case: a TYPE-only import of a run-surface binding — must FIRE
    { rel: 'h/x.ts', src: "import type { runAgent } from '@rayspec/platform';", expect: true },
    // ── a QUOTED member name (ES2022) is not extracted at all, so it used to walk past EVERY rule
    //    above at once. It is refused as unreadable, not read. Each vector paired with the plain
    //    spelling it hides, and the accept controls below prove the refusal is not a blanket one.
    { rel: 'h/x.ts', src: 'import { "runAgent" as go } from \'@rayspec/platform\';', expect: true },
    {
      rel: 'h/x.ts',
      src: 'import { "DbosDurableExecutor" as D } from \'@rayspec/durable-dbos\';',
      expect: true,
    },
    { rel: 'h/x.ts', src: 'import { "default" as p } from \'@rayspec/platform\';', expect: true },
    { rel: 'h/x.ts', src: "import { 'runAgent' as go } from '@rayspec/platform';", expect: true },
    { rel: 'h/x.ts', src: 'export { "default" as p } from \'@rayspec/platform\';', expect: true },
    {
      rel: 'h/x.ts',
      src: 'import type { "runAgent" as R } from \'@rayspec/platform\';',
      expect: true,
    },
    { rel: 'h/x.ts', src: 'import { "go" as g } from \'/abs/run-core.js\';', expect: true },
    // a name carrying a BRACE (`"a}b"`) — the clause must not be read as ending inside the string
    { rel: 'h/x.ts', src: 'import { "a}b" as c } from \'@rayspec/platform\';', expect: true },
    // the same name after a DEFAULT BINDING and as the namespace re-export's exported name, each
    // paired with the plain spelling it would otherwise hide (both plain ones the gate already flags
    // on sight, as bindings it cannot enumerate)
    { rel: 'h/x.ts', src: "import platform, { runAgent } from '@rayspec/platform';", expect: true },
    {
      rel: 'h/x.ts',
      src: 'import platform, { "runAgent" as go } from \'@rayspec/platform\';',
      expect: true,
    },
    { rel: 'h/x.ts', src: "export * as p from '@rayspec/platform';", expect: true },
    { rel: 'h/x.ts', src: 'export * as "p" from \'@rayspec/platform\';', expect: true },
    // …and the accept controls for it: a quote in the SOURCE, in an object literal, in a default
    // export, in a comment between the braces, a legitimate enumerable re-export under the name
    // `default`, and the two widened spellings written WITHOUT a quoted name against a benign source.
    { rel: 'h/x.ts', src: 'import { helper } from "./shared.js";', expect: false },
    { rel: 'h/x.ts', src: 'export const o = { a: "x" };', expect: false },
    { rel: 'h/x.ts', src: 'export default { a: "x" };', expect: false },
    { rel: 'h/x.ts', src: "import helper, { shared } from './shared.js';", expect: false },
    { rel: 'h/x.ts', src: "export * as shared from './shared.js';", expect: false },
    {
      rel: 'h/x.ts',
      src: "import { /* don't */ helper } from '@rayspec/handler-sdk';",
      expect: false,
    },
    {
      rel: 'h/x.ts',
      src: "export { helper as default } from '@rayspec/platform';",
      expect: false,
    },
    {
      rel: 'h/x.ts',
      src: "import type { DurableExecutor } from '@rayspec/platform';",
      expect: true,
    },
    // the enqueue seam and the run-header writes that accompany a schedule — must FIRE
    {
      rel: 'h/x.ts',
      src: "import { insertEnqueuedRunHeader } from '@rayspec/platform';",
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: "import type { RunJob, EnqueueResult } from '@rayspec/platform';",
      expect: true,
    },
    // the capability this boundary lands ahead of — must FIRE the day it is named
    { rel: 'h/x.ts', src: "import type { TurnDispatch } from '@rayspec/platform';", expect: true },
    // a package that exists to run/schedule turns — ANY import of it must FIRE
    {
      rel: 'h/x.ts',
      src: "import { DbosDurableExecutor } from '@rayspec/durable-dbos';",
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: "import { AGENT_RUNS_QUEUE } from '@rayspec/durable-dbos';",
      expect: true,
    },
    { rel: 'h/x.ts', src: "import '@rayspec/workflow-durable';", expect: true },
    // a deep subpath of one — must FIRE (prefix match, not equality)
    { rel: 'h/x.ts', src: "import { x } from '@rayspec/durable-dbos/executor';", expect: true },
    // re-export of the surface through this module — must FIRE
    { rel: 'h/x.ts', src: "export { runAgent } from '@rayspec/platform';", expect: true },
    // a namespace import of a run-surface-bearing package hides the binding — must FIRE
    { rel: 'h/x.ts', src: "import * as platform from '@rayspec/platform';", expect: true },
    { rel: 'h/x.ts', src: "export * from '@rayspec/server';", expect: true },
    // EVERY OTHER SPELLING of the same unenumerable take of a bearing package — must FIRE too, or the
    // namespace rule is a formality the most idiomatic lazy-load walks around.
    { rel: 'h/x.ts', src: "const { runAgent } = await import('@rayspec/platform');", expect: true },
    {
      rel: 'h/x.ts',
      src: "const p = await import('@rayspec/platform'); p.runAgent(i);",
      expect: true,
    },
    { rel: 'h/x.ts', src: "const c = await import('@rayspec/platform/run-core');", expect: true },
    { rel: 'h/x.ts', src: "const { runAgent } = require('@rayspec/platform');", expect: true },
    { rel: 'h/x.ts', src: "import platform from '@rayspec/platform';", expect: true },
    { rel: 'h/x.ts', src: "import platform, { helper } from '@rayspec/platform';", expect: true },
    { rel: 'h/x.ts', src: "import '@rayspec/platform';", expect: true },
    { rel: 'h/x.ts', src: "import server from '@rayspec/server';", expect: true },
    // the SAME default binding written INSIDE the braces — must FIRE alike, or the refusal is a
    // formality one alias walks around: it hands over the identical whole-exports object.
    {
      rel: 'h/x.ts',
      src: "import { default as platform } from '@rayspec/platform';",
      expect: true,
    },
    { rel: 'h/x.ts', src: "import { default as p } from '@rayspec/server';", expect: true },
    { rel: 'h/x.ts', src: "export { default } from '@rayspec/platform';", expect: true },
    {
      rel: 'h/x.ts',
      src: "export { default as platform } from '@rayspec/platform';",
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: "import { default as d, helper } from '@rayspec/platform';",
      expect: true,
    },
    { rel: 'h/x.ts', src: "import type { default as P } from '@rayspec/platform';", expect: true },
    // a NAMED import of a benign binding from a bearing package stays enumerable — must NOT fire
    { rel: 'h/x.ts', src: "import { helper } from '@rayspec/platform';", expect: false },
    { rel: 'h/x.ts', src: "import type { RouteSpec } from '@rayspec/server';", expect: false },
    // the MIRROR position: `default` on the EXPORTED side renames an enumerable named binding, so it
    // stays judged by that name — benign one must NOT fire, run-surface one must.
    { rel: 'h/x.ts', src: "export { helper as default } from '@rayspec/platform';", expect: false },
    {
      rel: 'h/x.ts',
      src: "export { runAgent as default } from '@rayspec/platform';",
      expect: true,
    },
    // a namespace import of the type-only contribution SDK is not run-surface-bearing — must NOT fire
    { rel: 'h/x.ts', src: "import * as sdk from '@rayspec/handler-sdk';", expect: false },
    { rel: 'h/x.ts', src: "import sdk from '@rayspec/handler-sdk';", expect: false },
    // a BACKTICK specifier must not slip past a quote-only matcher — must FIRE
    { rel: 'h/x.ts', src: 'const e = await import(`@rayspec/durable-dbos`);', expect: true },
    { rel: 'h/x.ts', src: 'import { runAgent } from `@rayspec/platform`;', expect: true },
    // a dynamic import whose argument is not one static string — must FIRE
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test-fixture source, not a real template literal.
    { rel: 'h/x.ts', src: 'const m = await import(`@rayspec/${pkg}`);', expect: true },
    { rel: 'h/x.ts', src: 'const m = await import(spec);', expect: true },
    { rel: 'h/x.ts', src: "const c = require('@rayspec/' + name);", expect: true },
    {
      rel: 'h/x.ts',
      src: "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url);",
      expect: true,
    },
    { rel: 'h/x.ts', src: 'const m = Module._load("@rayspec/durable-dbos");', expect: true },
    {
      rel: 'h/x.ts',
      src: 'const m = module.constructor._load("@rayspec/durable-dbos");',
      expect: true,
    },
    { rel: 'h/x.ts', src: 'const fs = process.binding("fs");', expect: true },
    { rel: 'h/x.ts', src: 'const d = require.main.require("@rayspec/platform");', expect: true },
    {
      rel: 'h/x.ts',
      src: 'const d = process.mainModule.require("@rayspec/platform");',
      expect: true,
    },
    // a static-string dynamic import of a benign module — must NOT fire
    { rel: 'h/x.ts', src: "const sdk = await import('@rayspec/handler-sdk');", expect: false },
    // a relative path that climbs out of the scanned subtree — must FIRE
    { rel: 'h/x.ts', src: "import { boot } from '../services/reconcile.js';", expect: true },
    {
      rel: 'h/x.ts',
      src: "import { runAgent } from '../../packages/kernel/platform/src/run-core.js';",
      expect: true,
    },
    // the SAME reach spelled without a '..' — absolute, URL, or subpath alias — must FIRE the same way
    {
      rel: 'h/x.ts',
      src: "import { go } from '/repo/packages/kernel/platform/src/run-core.js';",
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: "import * as p from '/repo/packages/kernel/platform/src/run-core.js';",
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: "import { go } from 'file:///repo/packages/kernel/platform/src/run-core.js';",
      expect: true,
    },
    { rel: 'h/x.ts', src: "import { go } from '#platform/run-core.js';", expect: true },
    {
      rel: 'h/x.ts',
      src: "import { go } from 'https://cdn.example.com/run-core.js';",
      expect: true,
    },
    // a sibling relative import stays inside the scanned subtree — must NOT fire
    { rel: 'h/x.ts', src: "import { shared } from './shared.js';", expect: false },
    { rel: 'h/x.ts', src: "import { deep } from './lib/deep.js';", expect: false },
    // `node:` is the one URL scheme a contributed module legitimately writes — must NOT fire
    { rel: 'h/x.ts', src: "import { createHash } from 'node:crypto';", expect: false },
    // a forbidden import hidden after a string that CONTAINS comment delimiters — must FIRE
    {
      rel: 'h/x.ts',
      src: 'const s = "/* not a comment */"; import { runAgent } from "@rayspec/platform";',
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: 'const u = "http://example.com";\nimport { runAgent } from "@rayspec/platform";',
      expect: true,
    },
    // a REAL comment naming the surface, and a dead string naming it — must NOT fire
    { rel: 'h/x.ts', src: '/* a handler never calls runAgent */ const s = "ok";', expect: false },
    { rel: 'h/x.ts', src: '// runAgent belongs to a service, not here', expect: false },
    { rel: 'h/x.ts', src: 'const note = "runAgent is not reachable from here";', expect: false },
    // a benign third-party import a deployment vendors — must NOT fire
    { rel: 'h/x.ts', src: "import { z } from 'zod';", expect: false },
    { rel: 'h/x.ts', src: "import { readFileSync } from 'node:fs';", expect: false },
  ];
  for (const { rel, src, expect } of cases) {
    const hit = detectViolations(rel, src).length > 0;
    if (hit !== expect) {
      fail(`detector returned ${hit} (expected ${expect}) for [${rel}]: ${src}`);
    }
  }
}

/** Write `files` (relative path → contents) under a fresh throwaway directory and return its path. */
function fixtureTree(files) {
  const ws = mkdtempSync(join(tmpdir(), 'rayspec-dispatch-boundary-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(ws, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return ws;
}

const CLEAN_HANDLER =
  "import type { ToolHandler } from '@rayspec/handler-sdk';\nexport const t = {};\n";
const RUN_SURFACE_USER =
  "import { runAgent } from '@rayspec/platform';\nexport const go = runAgent;\n";

/**
 * Arm two: the SCAN, driven over fixture trees this test builds. The `services` kind does not exist in
 * the tree yet, so the directional half of the invariant — a handler may not, a service may — is
 * proved here against a pack laid out the way the kind will be: `handlers/` beside `services/`.
 */
function selfTestScan() {
  const trees = [];
  try {
    // (C) a clean pack passes, and the scan reaches every nested file.
    {
      const ws = fixtureTree({
        'pack/handlers/tool.ts': CLEAN_HANDLER,
        'pack/handlers/lib/shared.ts': 'export const shared = 1;\n',
      });
      trees.push(ws);
      const { violations, counts } = scanContributionRoots(ws, ['pack/handlers']);
      if (violations.length !== 0)
        fail(`(C) a clean pack must PASS; got: ${violations.join(' | ')}`);
      if (counts.get('pack/handlers') !== 2) {
        fail(`(C) the scan must reach every nested file; read ${counts.get('pack/handlers')} of 2`);
      }
    }

    // (V) a run-surface import planted in a NESTED handler module fires, naming the file.
    // (S) the SAME import in the pack's sibling `services/` subtree does NOT — the exemption is
    //     structural (that subtree is not a contribution root), which is the whole invariant.
    {
      const ws = fixtureTree({
        'pack/handlers/tool.ts': CLEAN_HANDLER,
        'pack/handlers/lib/deep.ts': RUN_SURFACE_USER,
        'pack/services/reconcile.ts': RUN_SURFACE_USER,
      });
      trees.push(ws);
      const { violations } = scanContributionRoots(ws, ['pack/handlers']);
      if (violations.length !== 1) {
        fail(`(V) exactly one planted violation expected; got: ${violations.join(' | ')}`);
      }
      if (!violations[0].includes('pack/handlers/lib/deep.ts')) {
        fail(`(V) the offending file must be named; got: ${violations[0]}`);
      }
      if (violations.some((v) => v.includes('services'))) {
        fail(
          `(S) a service may reach the run surface; it must not be flagged: ${violations.join(' | ')}`,
        );
      }
    }

    // (N) a directory NAMED `services` NESTED under a contribution root buys no exemption.
    {
      const ws = fixtureTree({ 'pack/handlers/services/sneak.ts': RUN_SURFACE_USER });
      trees.push(ws);
      const { violations } = scanContributionRoots(ws, ['pack/handlers']);
      if (violations.length !== 1 || !violations[0].includes('pack/handlers/services/sneak.ts')) {
        fail(
          `(N) a nested 'services' folder must still be scanned; got: ${violations.join(' | ')}`,
        );
      }
    }

    // (G) a root that reads nothing is reported as zero — the input to the fail-closed rule below.
    {
      const ws = fixtureTree({ 'other/handlers/tool.ts': CLEAN_HANDLER });
      trees.push(ws);
      const { counts } = scanContributionRoots(ws, ['pack/handlers', 'other/handlers']);
      if (counts.get('pack/handlers') !== 0 || counts.get('other/handlers') !== 1) {
        fail('(G) a root that resolves to nothing must be reported as zero files, per root');
      }
    }

    // (D) an UNDECLARED contribution root is DISCOVERED — the other direction of the honesty rule.
    //     `pack2/handlers` exists on disk and no declared list mentions it; discovery must surface it
    //     so the caller below can fail on the difference. Nested and vendored dirs are handled too: a
    //     `handlers` inside a discovered root is already covered by it, and one under `node_modules`
    //     or `dist` is build/vendor output, not a new contribution.
    {
      const ws = fixtureTree({
        'ex/pack1/handlers/tool.ts': CLEAN_HANDLER,
        'ex/pack2/handlers/tool.ts': CLEAN_HANDLER,
        'ex/pack1/handlers/nested/handlers/tool.ts': CLEAN_HANDLER,
        'ex/pack3/node_modules/vendored/handlers/tool.ts': CLEAN_HANDLER,
        'ex/pack3/dist/handlers/tool.ts': CLEAN_HANDLER,
        'ex/pack3/services/reconcile.ts': RUN_SURFACE_USER,
      });
      trees.push(ws);
      const discovered = discoverContributionRoots(ws, ['ex']);
      if (discovered.join(',') !== 'ex/pack1/handlers,ex/pack2/handlers') {
        fail(`(D) discovery must find exactly the two real roots; got: ${discovered.join(',')}`);
      }
      const undeclared = discovered.filter((r) => !['ex/pack1/handlers'].includes(r));
      if (undeclared.join(',') !== 'ex/pack2/handlers') {
        fail(`(D) an undeclared root must be surfaced; got: ${undeclared.join(',')}`);
      }
    }

    // (L) a symlink under a contribution root is flagged and not followed.
    {
      const ws = fixtureTree({
        'pack/handlers/tool.ts': CLEAN_HANDLER,
        'outside/reach.ts': RUN_SURFACE_USER,
      });
      trees.push(ws);
      symlinkSync(join(ws, 'outside'), join(ws, 'pack/handlers/linked'));
      const { violations } = scanContributionRoots(ws, ['pack/handlers']);
      if (violations.length !== 1 || !violations[0].includes('SYMLINK')) {
        fail(`(L) a symlinked entry must be flagged, not followed; got: ${violations.join(' | ')}`);
      }
    }
  } finally {
    for (const d of trees) rmSync(d, { recursive: true, force: true });
  }
}

selfTestDetector();
selfTestScan();

const { violations, counts } = scanContributionRoots(repoRoot, CONTRIBUTION_ROOTS);
const emptyRoots = [...counts].filter(([, n]) => n === 0).map(([rel]) => rel);

if (emptyRoots.length > 0) {
  console.error('contribution-dispatch-boundary gate FAILED: scanned 0 source file(s) under:');
  for (const rel of emptyRoots) console.error(`  - ${rel}`);
  console.error(
    '\nA declared contribution root that reads nothing is a FAILURE, never a skip: a renamed or ' +
      'moved root would otherwise retire this boundary with a normal PASS line. Fix the path, or ' +
      'drop the root from CONTRIBUTION_ROOTS if the contribution is really gone.',
  );
  process.exit(1);
}

const undeclaredRoots = discoverContributionRoots(repoRoot).filter(
  (rel) => !CONTRIBUTION_ROOTS.includes(rel),
);

if (undeclaredRoots.length > 0) {
  console.error(
    'contribution-dispatch-boundary gate FAILED: contribution root(s) on disk that this gate does ' +
      'not scan:',
  );
  for (const rel of undeclaredRoots) console.error(`  - ${rel}`);
  console.error(
    '\nA handlers/ subtree that no declared root covers is a FAILURE, never a skip: it would ship ' +
      'contributed modules this boundary never reads, which is the exact hole the gate exists to ' +
      'close. Add the root to CONTRIBUTION_ROOTS.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error('contribution-dispatch-boundary gate FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\nA module reachable from a pack handlers/ subtree — or from a tooling contribution, whose ' +
      'handler resolves into it — may not import the run surface (runAgent, the DurableExecutor ' +
      'enqueue seam and the engine behind it, the run-header writes, TurnDispatch). Only a services ' +
      'module may run or schedule an agent turn.',
  );
  process.exit(1);
}

console.log(
  `contribution-dispatch-boundary gate PASSED: ${[...counts.values()].reduce((a, b) => a + b, 0)} ` +
    `contributed module(s) across ${counts.size} root(s) reach no run surface (only a service may).`,
);
