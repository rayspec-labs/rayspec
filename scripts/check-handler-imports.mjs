#!/usr/bin/env node
/**
 * Handler-imports CI gate — the escape-hatch import boundary.
 *
 * An escape-hatch handler module (a `handlers[].module` resolved under a deployment's
 * `escapeHatchRoot`) is TRUSTED-AUTHOR product logic. The `@rayspec/`-scoped packages it may name are
 * the TWO handler contracts and nothing else under that scope: `@rayspec/handler-sdk`, the contract a
 * deployment's own handler is injected against, and `@rayspec/pack-sdk`, the contract a handler
 * CONTRIBUTED BY AN EXTENSION PACK is written against. Each is sanctioned on its OWN property and the
 * two properties are NOT the same one — stated per package at `ALLOWED_IMPORTS` below rather than
 * generalized into a single claim that is false of one of them. Outside that scope the module must
 * NEVER import an agent SDK (`@openai/agents`, `@anthropic-ai/*`, `@earendil-works/*`); inside it, a
 * platform internal (`@rayspec/platform`/`db`/`core`/`api-auth`/`auth-core`/`spec`) is enumerated
 * explicitly so the failure names which rule fired, and every remaining `@rayspec/` package is
 * refused by the scope rule. Why those two refusals are the ones that matter:
 *   - a platform-internal import would let a handler reach AROUND the injected, capability-scoped
 *     `HandlerInit` (e.g. construct a raw `TenantDb`, bypassing the tenant chokepoint) — defeating
 *     the whole "handler gets ONLY a serializable-shaped init" model + the isolate seam
 *     (an isolate cannot resolve a platform module — the import would simply break inside one);
 *   - an SDK import would couple product logic to a churning SDK type, the exact risk the neutral
 *     boundary exists to prevent.
 * This gate FAILS THE BUILD on any forbidden import in an escape-hatch module.
 *
 * MIRRORS scripts/check-adapter-no-handlers.mjs + check-tenant-chokepoint.mjs: a greppable TRIPWIRE
 * (no AST), COMMENT- and STRING-LITERAL-stripped before analysis, with a SELF-TEST that proves the
 * detector fires on every forbidden vector AND passes each sanctioned import.
 *
 * HONEST CEILING: being a tripwire, it vets what a module WRITES DOWN — a source it can read — and
 * the reader is a matcher, not a parser. Two shapes it cannot read are REFUSED rather than cleared:
 * an opaque dynamic `import()`/`require()` argument is flagged on sight, and so is a member named
 * with a STRING rather than an identifier (`{ "runAgent" as go }`, legal since ES2022) — the clause
 * reader cannot extract such a statement at all, so leaving it unflagged would clear it against every
 * rule at once. That refusal covers the spellings enumerated at the rule below (the brace clause alone,
 * after `type`, after a default binding — `import platform, { "runAgent" as go } from …`, the binding
 * read as a superset of the identifier grammar rather than an ASCII-only one — and the namespace
 * re-export `export * as "p" from …`), each pinned by a self-test case alongside the plain spelling it
 * would otherwise hide. What the refusals do NOT buy is a parser: a spelling no matcher here
 * anticipates is still read as clean, which is why the OS-level isolate, not this gate, is the
 * boundary that actually holds.
 *
 * THE OTHER HALF OF THE CEILING is about WHICH specifiers are in scope at all. This gate refuses
 * platform internals, agent SDKs, every non-sanctioned `@rayspec/`-scoped package, a `..`-escape out
 * of the handler tree and an import statement it cannot read. It does NOT refuse an ordinary
 * third-party or node-builtin import (`lodash`, `pg`, `node:child_process`): a deployment vendoring a
 * util into its own escape-hatch library is legitimate, the path jail (loader.ts) bounds WHICH file
 * loads, and this gate bounds the trust-boundary-crossing imports specifically. So "refuses
 * everything else" is true of the `@rayspec/` scope and of the enumerated vectors — not of every
 * import a handler can write.
 *
 * ESCAPE-HATCH ROOTS: a RaySpec deployment's escape-hatch library lives outside the platform
 * (zero-product-code). On the platform main line the ONLY escape-hatch modules that exist are
 * the THROWAWAY's (examples/acme-notes-backend/handlers). A real deployment would add its own root here
 * (or run this gate in its own repo). The gate scans every configured root; absent roots are skipped
 * (so the platform main line — which ships no product handlers — stays green by construction).
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverExtensionHandlerRoots } from './lib/extension-roots.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The BASE escape-hatch roots to scan — a deployment's OWN handler dirs (the throwaway's handlers; a
 * real deployment adds its own root or runs this gate in its own repo). The PACK handler roots are
 * DISCOVERED below (manifest-derived from every deployment YAML's `extensions[].module` dirs), so
 * adding a pack to a YAML automatically scans its handlers. Kept in LOCKSTEP with
 * check-extension-capability.mjs (both import the SAME `discoverExtensionHandlerRoots`).
 */
const BASE_ESCAPE_HATCH_ROOTS = [
  'examples/acme-notes-backend/handlers',
  // The GENERATED reference handlers for the Expense-Claim Auto-Coder (rendered
  // by `rayspec gen-handler` from committed holes). Scanned here so the import-boundary gate FIRES on
  // any forbidden import in generated code (the gate's "a real deployment adds its own root" pattern).
  'examples/expense-claim-coder/handlers',
  // The event-bus example's handlers. Scanned here (and in check-extension-capability.mjs, in
  // lockstep) because they are the reference for how a handler ANNOUNCES a change: the boundary that
  // matters for `init.emit` is that a handler uses the INJECTED capability rather than reaching the
  // append itself, and only these gates say so about example code.
  'examples/live-workspace-events/handlers',
  // NOTE: the stream/blob backend's handlers live in its extension PACK
  // (examples/stream-backend/packs/stream-pack/handlers) — DISCOVERED below as a pack handler
  // root (manifest-derived), not a fixed base root.
];

// DISCOVER the extension-pack handler roots (manifest-derived, path-jailed). A
// pack `module` that ESCAPES the repo jail is a gate FAILURE (fail-closed) — surfaced before any scan.
const { roots: PACK_HANDLER_ROOTS, escapes: PACK_ROOT_ESCAPES } =
  discoverExtensionHandlerRoots(repoRoot);
if (PACK_ROOT_ESCAPES.length > 0) {
  console.error('handler-imports gate FAILED: an extension-pack module escapes the repo jail:');
  for (const e of PACK_ROOT_ESCAPES) {
    console.error(
      `  - ${e.spec}: extensions[].module '${e.module}' resolves OUTSIDE the repo (path-jail).`,
    );
  }
  process.exit(1);
}
const ESCAPE_HATCH_ROOTS = [...BASE_ESCAPE_HATCH_ROOTS, ...PACK_HANDLER_ROOTS];

/**
 * The `@rayspec/`-scoped packages an escape-hatch module may name — the two handler contracts, and
 * nothing else that carries that scope.
 *
 * THIS SET IS LOAD-BEARING, not a label. `isUnsanctionedScoped` refuses every OTHER specifier under
 * the `@rayspec/` scope, so dropping a name here turns its import into a violation. That is asserted
 * by MUTATION rather than by this sentence: `selfTest` removes each name in turn and requires the
 * very case that accepted it to go red, which is the check that would have caught the earlier shape
 * of this constant — where the set decided only which specifiers skipped a forbidden-prefix test they
 * were never going to fail, and emptying it changed nothing.
 *
 * `@rayspec/handler-sdk` is what a DEPLOYMENT's own handler is injected against. `@rayspec/pack-sdk`
 * is what a handler CONTRIBUTED BY AN EXTENSION PACK is written against: a pack authors both halves
 * of a contribution — the manifest that declares it and the module the declaration points at —
 * against one surface, and this gate scans the manifest-derived pack handler roots, so the sanctioned
 * set has to name it.
 *
 * THE TRUST ARGUMENT DIFFERS PER PACKAGE, so it is stated per package. Generalizing one package's
 * property to both is how a false claim gets written down:
 *   - `@rayspec/pack-sdk` is a types-only, zero-dependency leaf. Its manifest declares no
 *     `dependencies`, its built `dist/index.js` is a single re-export of its own identifier helper,
 *     and it names no platform internal. Importing it can reach nothing.
 *   - `@rayspec/handler-sdk` is NOT a leaf, and saying so is the point. Its manifest declares
 *     `@rayspec/core`, `@rayspec/stt-port` and `@rayspec/tts-port` under `dependencies`; it ships
 *     runtime (a bounded body reader, a tokenizer conduit, the response-envelope brand); and its
 *     `src/index.ts` imports `@rayspec/core`, which is itself entry #3 on FORBIDDEN_IMPORT_PREFIXES
 *     below. It is sanctioned because it IS the injection contract — the shape the engine builds the
 *     `HandlerInit` against — and a handler is supposed to depend on the seam it is injected through.
 *     What the forbidden list stops is a handler reaching AROUND that seam to construct a capability
 *     itself; naming the seam is not that.
 */
const ALLOWED_IMPORTS = ['@rayspec/handler-sdk', '@rayspec/pack-sdk'];
/** The sanctioned set, rendered for a message. */
const ALLOWED_LIST = ALLOWED_IMPORTS.map((s) => `'${s}'`).join(' or ');
/** The scope the sanction governs: a specifier under it is refused unless it is EXACTLY sanctioned. */
const RAYSPEC_SCOPE = '@rayspec/';

/**
 * Forbidden import specifiers (a handler may import NONE of these). Platform internals + every agent
 * SDK + the raw db testing subpath. Matched against the import SOURCE string (the `from '...'` / the
 * `import('...')` argument), so a prefix match also catches deep subpath imports
 * (`@rayspec/db/testing`, `@anthropic-ai/claude-agent-sdk`).
 */
const FORBIDDEN_IMPORT_PREFIXES = [
  '@rayspec/platform',
  '@rayspec/db',
  '@rayspec/core',
  '@rayspec/api-auth',
  '@rayspec/auth-core',
  '@rayspec/spec',
  '@openai/agents',
  '@anthropic-ai/',
  '@earendil-works/',
];

/** Module file extensions an escape-hatch handler may be authored in (c: not just .ts/.tsx). */
const MODULE_EXTS = ['.ts', '.tsx', '.mjs', '.js', '.cjs'];

/**
 * Walk an escape-hatch root, yielding `{ full, isSymlink }` for every module file. Uses `lstatSync`
 * (NOT statSync) so a SYMLINK is detected as a symlink (d) rather than followed — a symlinked entry
 * under the root is flagged by the scanner (it could point OUT of the escape-hatch library). A
 * symlinked DIRECTORY is likewise flagged + not descended (it could graft an out-of-tree subtree in).
 */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // an absent root (the platform main line ships no product handlers) → skip, stay green.
  }
  for (const name of entries) {
    const full = join(dir, name);
    const lst = lstatSync(full);
    if (lst.isSymbolicLink()) {
      // A symlink (file OR dir) under the root: flag it (d) and do NOT follow it.
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
 * STRING-AWARE (HG1-COMMENT-STRIP-STRING-BYPASS fix). A comment delimiter is recognized ONLY when we
 * are NOT inside a string/template literal — so a `/* *​/` or `//` that lives INSIDE a string is left
 * intact (the naive two-regex approach mis-parsed such a delimiter as a real comment and could mangle
 * the code around it, hiding a forbidden import). String/template CONTENT is PRESERVED (this gate's
 * import extractor needs the source strings); we only remove genuine comments. Backslash escapes
 * inside strings are honored so an escaped quote does not end the string early. (`${…}` substitutions
 * inside a template are not separately parsed — a template with `${` is flagged by
 * detectDynamicImportViolations regardless, and never carries a real comment we must see.)
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
      // Inside a string/template: copy verbatim, honor `\` escapes, end only on the matching quote.
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
    // Outside a string: a comment delimiter starts a comment; a quote starts a string.
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1; // drop to end of line
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2; // skip the closing */
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
 * Extract every import/export-from/dynamic-import SOURCE string from comment-stripped source. Covers
 * single-quote, double-quote, AND BACKTICK (template-literal, no substitution) source strings — a
 * `import(\`@rayspec/db\`)` must NOT slip past a quote-only matcher (HG-1). Covers:
 *   - `import ... from '<src>'`            (incl. `import type`)
 *   - `export ... from '<src>'`            (re-export)
 *   - `import '<src>'`                     (side-effect import)
 *   - `import('<src>')` / `require('<src>')` (dynamic, static-string arg)
 * A dynamic import/require with a NON-static-string arg is handled separately (see
 * `detectDynamicImportViolations` — it is FLAGGED as opaque, not source-extracted), and so is a clause
 * that names a member with a STRING literal (see `detectQuotedNameViolations` — the clause body below
 * excludes quotes, so such a statement is never extracted here).
 * Returns the list of source specifiers (the strings inside the quotes/backticks).
 */
function extractImportSources(codeNoComments) {
  const sources = [];
  // The source string body: a single/double/backtick-quoted run with NO substitution (`${`). A
  // backtick WITH `${` is not a static string — it is flagged by detectDynamicImportViolations.
  const Q = String.raw`(?:'([^']+)'|"([^"]+)"|\`([^\`$]+)\`)`;
  const patterns = [
    new RegExp(String.raw`\bimport\s+type\s+[^'"\`]*?\bfrom\s*${Q}`, 'g'),
    new RegExp(String.raw`\bimport\s+[^'"\`]*?\bfrom\s*${Q}`, 'g'),
    new RegExp(String.raw`\bexport\s+[^'"\`]*?\bfrom\s*${Q}`, 'g'),
    new RegExp(String.raw`\bimport\s*${Q}`, 'g'), // side-effect import
    new RegExp(String.raw`\bimport\s*\(\s*${Q}\s*\)`, 'g'), // dynamic import, static string
    new RegExp(String.raw`\brequire\s*\(\s*${Q}\s*\)`, 'g'), // require, static string
  ];
  for (const re of patterns) {
    let m;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
    while ((m = re.exec(codeNoComments)) !== null) {
      // The capture is in group 1 (single), 2 (double), or 3 (backtick) depending on the quote.
      sources.push(m[1] ?? m[2] ?? m[3]);
    }
  }
  return sources;
}

/**
 * ES2022 lets a brace group name a member with a STRING rather than an identifier
 * (`import { "runAgent" as go } from '@rayspec/platform'`). `extractImportSources` builds its clause
 * from a character class that EXCLUDES quotes, so such a statement is not merely read wrong — it is
 * never extracted, its source is never vetted, and every rule this gate owns silently reads zero for
 * it.
 *
 * The reader stays a greppable tripwire rather than learning to parse the name: it REFUSES the
 * statement it cannot read, the same posture the opaque-dynamic-specifier rule already takes. Applied
 * to the COMMENT-STRIPPED source, so an apostrophe inside a comment between the braces cannot
 * manufacture a violation.
 *
 * The spellings MATCHED are enumerated here, each pinned by a self-test case; the list is kept as wide
 * as a matcher can be, because a spelling that is NOT matched is cleared against every rule at once —
 * the exact defect this rule exists to close:
 *   - the brace clause on its own, or after `type` (`import type { "AgentSpec" as A } from …`);
 *   - the brace clause after a DEFAULT BINDING — `ImportClause : ImportedDefaultBinding , NamedImports`
 *     puts a binding and a comma before the brace (`import platform, { "runAgent" as go } from …`),
 *     one comma away from the plain spelling. The binding is read as a SUPERSET of the identifier
 *     grammar (see `DEFAULT_BINDING`), since an ASCII-only class would clear `import é, { "runAgent"
 *     as go } from …` — a statement that parses clean and runs;
 *   - the namespace re-export whose EXPORTED name is a string — `ExportFromClause : * as
 *     ModuleExportName`, and a `ModuleExportName` may be a StringLiteral (`export * as "p" from …`).
 * The clause body reads a quoted run AS a run (backslash escapes honored), so a name that itself
 * carries a brace (`{ "a}b" as c }`) does not end the clause early and slip past. What no widening
 * here buys is a parser: this stays a matcher, so a spelling it does not anticipate is still read as
 * clean — which is why the OS-level isolate, not this gate, is the boundary that actually holds.
 */
// A member/export NAME written as a string: a quoted run, escapes honored.
const NAME_STRING = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
// The module SPECIFIER: the same three quote styles `extractImportSources` accepts, sans its captures.
const SOURCE_STRING = String.raw`(?:'[^']+'|"[^"]+"|\`[^\`$]+\`)`;
// A brace clause that CARRIES a quote (the lookahead: a quoted name always opens before the clause's
// first `}`), read as runs so a `}` inside a name is not mistaken for the end of the clause.
const QUOTED_CLAUSE = String.raw`\{(?=[^{}]*['"])(?:[^{}'"]|${NAME_STRING})*\}`;
// The DEFAULT BINDING that may precede the brace clause, read as a SUPERSET of the identifier grammar
// — one run of anything that is not whitespace, a comma, a brace or a quote. An ES identifier is NOT
// ASCII-only: it may carry any non-ASCII ID_Start/ID_Continue code point (`import é, …`,
// `import 平台, …`) or spell a code point as a unicode escape (a backslash form), and an ASCII-only
// class here would hide exactly the statement this rule exists to refuse. The superset cannot
// manufacture a match because the position is pinned on both sides (`import`/`export` before it,
// `, { … } from '…'` after). WHITESPACE IS EXCLUDED DELIBERATELY: the `\s+`/`\s*` around this run
// would otherwise compete with it over the same characters (non-ASCII whitespace is both), and a run
// of a few thousand of those costs seconds of backtracking rather than microseconds.
const DEFAULT_BINDING = String.raw`[^\s,{}'"]+`;
const QUOTED_MEMBER_NAME = new RegExp(
  String.raw`\b(?:import|export)(?:\s*type)?(?:\s+${DEFAULT_BINDING}\s*,)?\s*${QUOTED_CLAUSE}\s*from\s*${SOURCE_STRING}` +
    String.raw`|\bexport(?:\s*type)?\s*\*\s*as\s*${NAME_STRING}\s*from\s*${SOURCE_STRING}`,
  'g',
);

function detectQuotedNameViolations(rel, codeNoComments) {
  const found = [];
  for (const [statement] of codeNoComments.matchAll(QUOTED_MEMBER_NAME)) {
    found.push(
      `${rel}: names an imported member with a string literal (${statement.trim().slice(0, 80)}…) — ` +
        'this gate reads an import clause to reach the source it names, and a quoted member name is ' +
        'one it cannot read, so the statement is refused rather than cleared (fail-closed). Write ' +
        'the member as a plain identifier.',
    );
  }
  return found;
}

/**
 * Flag a dynamic `import()` / `require()` / `createRequire(...)()` whose argument is NOT a single
 * STATIC string literal (template-with-substitution / concatenation / a variable) — an opaque
 * specifier the gate cannot vet, so it could resolve to a forbidden module at runtime (LOADER-1 /
 * mirroring check-adapter-no-handlers' non-inline-positional flag). Returns violation strings.
 *
 * Approach: find every `import(`/`require(`/`createRequire(` call, capture its (paren-balanced) arg,
 * and FLAG it unless the arg is exactly one static string literal (`'…'`/`"…"`/backtick-without-`${`).
 * `createRequire` is flagged on SIGHT (it is the node:module escape hatch to build a `require`; an
 * escape-hatch handler has no business constructing one).
 */
function detectDynamicImportViolations(rel, codeNoComments) {
  const found = [];
  // ON-SIGHT module-loader escape hatches (NIT HG1-CREATEREQUIRE-ALIAS / HG1-NODE-INTERNAL-LOADERS):
  // any of these is a casual reach-around to build/invoke a module loader outside import()/require().
  // The gate is a TRIPWIRE under trusted-author (the isolate is the real boundary), so these are
  // cheap on-sight flags — each name appearing in CODE (comment/string-stripped) is the violation.
  const LOADER_ESCAPE_HATCHES = [
    { re: /\bcreateRequire\s*\(/, what: 'createRequire(...) (the require-factory escape hatch)' },
    {
      re: /\bModule\s*\.\s*_load\b/,
      what: 'Module._load (the internal CJS loader)',
    },
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
        `${rel}: uses ${what} — a forbidden module-resolution escape hatch in an escape-hatch ` +
          'handler (fail-closed; the gate is a casual-reach-around tripwire, the OS-level isolate is the ' +
          'real boundary).',
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
          'string literal (template-with-substitution / concat / variable). An opaque dynamic ' +
          'specifier cannot be vetted and is forbidden in an escape-hatch handler (fail-closed).',
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

/** True if the import source is a forbidden specifier (exact or a subpath of a forbidden prefix). */
function isForbidden(source) {
  return FORBIDDEN_IMPORT_PREFIXES.some((prefix) => source === prefix || source.startsWith(prefix));
}

/**
 * True if the source carries the `@rayspec/` scope but is not EXACTLY a sanctioned handler contract.
 * This is the rule that makes `ALLOWED_IMPORTS` decide anything.
 *
 * It is SCOPE-shaped rather than list-shaped on purpose. `FORBIDDEN_IMPORT_PREFIXES` enumerates the
 * platform internals someone thought of; this workspace also publishes `@rayspec/server`,
 * `@rayspec/durable-dbos`, the capability runtimes and the adapters, and it gains packages every
 * release. An enumeration is refused-until-listed, which fails open for exactly the reach-around
 * vectors this gate exists to stop; a scope rule is refused-by-default, so a package added next
 * release is covered on the day it lands rather than on the day someone remembers it.
 *
 * EXACT match, not a prefix: a subpath of a sanctioned contract (`@rayspec/pack-sdk/internal`) is NOT
 * sanctioned. Both packages declare a `'.'`-only `exports` map so such an import does not resolve
 * anyway, and reading the sanction as a prefix would re-open the scope one subpath at a time.
 */
function isUnsanctionedScoped(source, allowed) {
  return source.startsWith(RAYSPEC_SCOPE) && !allowed.includes(source);
}

/**
 * A RELATIVE import is suspect: an escape-hatch module should depend only on a sanctioned handler
 * contract (a sibling .ts in the same escape-hatch library is allowed — that is still product logic, not a
 * platform reach-around). We ALLOW relative imports (a multi-file escape-hatch library is legitimate)
 * but FORBID a relative path that climbs OUT of the escape-hatch tree with `..` reaching a platform
 * package — caught structurally: a relative `..`-traversal is flagged so it cannot tunnel to
 * `../../packages/...`. (A real deployment's handlers live in their own repo; this guards the
 * throwaway's in-repo layout where `../../packages` IS reachable on disk.)
 */
function isEscapingRelative(source) {
  return source.startsWith('.') && source.split(/[/\\]/).includes('..');
}

/**
 * Detect forbidden imports in one escape-hatch module's source. Pure (no I/O) so the self-test
 * exercises the EXACT logic. `rel` is used only for the message. Returns violation strings.
 *
 * `allowed` is a PARAMETER (defaulting to the sanctioned set) so `selfTest` can shrink it and measure
 * that the set is load-bearing, instead of the set being trusted to matter.
 */
export function detectViolations(rel, src, allowed = ALLOWED_IMPORTS) {
  const found = [];
  const code = stripComments(src);
  const allowedList = allowed.map((s) => `'${s}'`).join(' or ') || '(nothing)';
  for (const source of extractImportSources(code)) {
    if (allowed.includes(source)) continue; // a sanctioned handler contract
    if (isForbidden(source)) {
      found.push(
        `${rel}: imports '${source}' — a platform internal or an agent SDK. Under the '@rayspec/' ` +
          `scope an escape-hatch handler may name ONLY ${allowedList}, and it may never name an ` +
          'agent SDK at all.',
      );
    } else if (isUnsanctionedScoped(source, allowed)) {
      found.push(
        `${rel}: imports '${source}' — a '@rayspec/'-scoped package that is not a sanctioned handler ` +
          `contract. Under that scope an escape-hatch handler may name ONLY ${allowedList} (exactly; ` +
          'a subpath of one is not sanctioned). Everything else under it is platform code a handler ' +
          'must receive through its injected init rather than import.',
      );
    } else if (isEscapingRelative(source)) {
      found.push(
        `${rel}: imports a '..'-escaping relative path '${source}' — an escape-hatch handler may not ` +
          'tunnel out of the escape-hatch library into platform source.',
      );
    }
    // An UNSCOPED, non-escaping import (a sibling relative module, or a benign 3rd-party util a
    // deployment vendors in its own library) is NOT flagged here — the path jail (loader.ts) bounds
    // WHICH file loads; this gate bounds the trust-boundary-crossing imports specifically. That is a
    // stated ceiling, not a sanction (see HONEST CEILING in the header).
  }
  // A member named with a STRING literal — refuse the statement (its source is never extracted).
  found.push(...detectQuotedNameViolations(rel, code));
  // LOADER-1: an opaque dynamic import()/require()/createRequire — flag (cannot be vetted).
  found.push(...detectDynamicImportViolations(rel, code));
  return found;
}

/**
 * Which sanctioned contracts a module actually NAMES. Used only for the PASS line, so the summary
 * REPORTS what the scan read rather than asserting a set membership no reader can check against the
 * tree — the failure mode of a summary that named one package while the modules under it imported
 * another.
 */
export function sanctionedImportsIn(src) {
  const named = new Set();
  for (const source of extractImportSources(stripComments(src))) {
    if (ALLOWED_IMPORTS.includes(source)) named.add(source);
  }
  return named;
}

// --- self-test: prove the detector fires for every forbidden vector + passes the clean one --------
function selfTest() {
  const cases = [
    // the sanctioned imports — BOTH must PASS. The second is the contract a handler contributed by
    // an extension pack is written against; it is scanned under a manifest-derived pack handler root,
    // so a set that named only the first would make this gate's own PASS line false about the tree.
    {
      rel: 'examples/acme-notes-backend/handlers/x.ts',
      src: "import type { ToolHandler } from '@rayspec/handler-sdk';",
      expect: false,
    },
    {
      rel: 'packages/test/fixture-pack/dist/handlers/x.ts',
      src: "import type { PackToolHandler } from '@rayspec/pack-sdk';",
      expect: false,
    },
    {
      rel: 'packages/test/fixture-pack/dist/handlers/x.ts',
      src: "import type { PackRouteHandler } from '@rayspec/pack-sdk';",
      expect: false,
    },
    // The allow-check is an EXACT match, not a prefix, so a subpath does NOT ride the exemption: it
    // is still `@rayspec/`-scoped and not sanctioned, so the scope rule FIRES. (Such an import does
    // not resolve anyway — both packages declare a '.'-only `exports` map — but a gate that cleared
    // it would let the scope be re-opened one subpath at a time.)
    {
      rel: 'h/x.ts',
      src: "import type { T } from '@rayspec/pack-sdk/internal';",
      expect: true,
    },
    { rel: 'h/x.ts', src: "import type { T } from '@rayspec/handler-sdk/blob';", expect: true },
    // The reach-around vectors an ENUMERATED forbidden list misses. None of these is on
    // FORBIDDEN_IMPORT_PREFIXES; each is refused because it carries the `@rayspec/` scope and is not
    // sanctioned. `@rayspec/server` and `@rayspec/durable-dbos` are the two that matter most — the
    // HTTP app and the durable engine, precisely what a handler must not reach around its init for.
    { rel: 'h/x.ts', src: "import { app } from '@rayspec/server';", expect: true },
    { rel: 'h/x.ts', src: "import { enqueue } from '@rayspec/durable-dbos';", expect: true },
    { rel: 'h/x.ts', src: "import type { SttPort } from '@rayspec/stt-port';", expect: true },
    { rel: 'h/x.ts', src: "import { agent } from '@rayspec/agent-runtime';", expect: true },
    // …and the same scope in every spelling the extractor reads, so the rule is not quote-shaped.
    { rel: 'h/x.ts', src: 'import { app } from `@rayspec/server`;', expect: true },
    { rel: 'h/x.ts', src: "export { app } from '@rayspec/server';", expect: true },
    { rel: 'h/x.ts', src: "import '@rayspec/server';", expect: true },
    { rel: 'h/x.ts', src: "const s = await import('@rayspec/server');", expect: true },
    { rel: 'h/x.ts', src: "const s = require('@rayspec/server');", expect: true },
    // a pack handler reaching a platform internal ALONGSIDE its sanctioned contract — must FIRE (the
    // second sanctioned import does not open a door beside itself).
    {
      rel: 'packages/test/fixture-pack/dist/handlers/x.ts',
      src: "import type { PackRouteHandler } from '@rayspec/pack-sdk';\nimport { forTenant } from '@rayspec/db';",
      expect: true,
    },
    // a backtick / dynamic-static-string spelling of the second sanctioned import — must NOT fire
    { rel: 'h/x.ts', src: 'import type { T } from `@rayspec/pack-sdk`;', expect: false },
    { rel: 'h/x.ts', src: "const sdk = await import('@rayspec/pack-sdk');", expect: false },
    // …and a QUOTED member name is still refused even when the source is sanctioned (the statement is
    // unreadable, so it is refused rather than cleared — the exemption is on the SOURCE, not a bypass).
    {
      rel: 'h/x.ts',
      src: 'import { "PackRouteHandler" as H } from \'@rayspec/pack-sdk\';',
      expect: true,
    },
    // platform internals — must FIRE
    {
      rel: 'h/x.ts',
      src: "import { forTenant } from '@rayspec/db';",
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: "import { runAgent } from '@rayspec/platform';",
      expect: true,
    },
    { rel: 'h/x.ts', src: "import { AgentSpec } from '@rayspec/core';", expect: true },
    { rel: 'h/x.ts', src: "import { createAuthApp } from '@rayspec/api-auth';", expect: true },
    { rel: 'h/x.ts', src: "import { ApiError } from '@rayspec/auth-core';", expect: true },
    { rel: 'h/x.ts', src: "import { parseSpec } from '@rayspec/spec';", expect: true },
    // the raw db testing subpath (a subpath of @rayspec/db) — must FIRE
    {
      rel: 'h/x.ts',
      src: "import { makeDb } from '@rayspec/db/testing';",
      expect: true,
    },
    // agent SDKs — must FIRE
    { rel: 'h/x.ts', src: "import { Agent } from '@openai/agents';", expect: true },
    {
      rel: 'h/x.ts',
      src: "import { query } from '@anthropic-ai/claude-agent-sdk';",
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: "import { Pi } from '@earendil-works/pi-coding-agent';",
      expect: true,
    },
    // export-from re-export of a forbidden module — must FIRE
    { rel: 'h/x.ts', src: "export { schema } from '@rayspec/db';", expect: true },
    // side-effect import of a forbidden module — must FIRE
    { rel: 'h/x.ts', src: "import '@rayspec/platform';", expect: true },
    // dynamic import of a forbidden module — must FIRE
    {
      rel: 'h/x.ts',
      src: "const db = await import('@rayspec/db');",
      expect: true,
    },
    // require of a forbidden module — must FIRE
    { rel: 'h/x.ts', src: "const c = require('@rayspec/core');", expect: true },
    // HG-1: a BACKTICK template-literal source naming a forbidden module — must FIRE (was a quote-only gap)
    { rel: 'h/x.ts', src: 'const db = await import(`@rayspec/db`);', expect: true },
    { rel: 'h/x.ts', src: 'import { x } from `@rayspec/platform`;', expect: true },
    // a backtick ALLOWED import — must NOT fire (backtick handling is not over-broad)
    { rel: 'h/x.ts', src: 'import type { T } from `@rayspec/handler-sdk`;', expect: false },
    // LOADER-1: a dynamic import with a NON-static-string arg (template-with-substitution) — must FIRE.
    // The src below is a TEST FIXTURE string that intentionally contains a template substitution.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test-fixture source, not a real template literal.
    { rel: 'h/x.ts', src: 'const m = await import(`@rayspec/${pkg}`);', expect: true },
    // LOADER-1: a dynamic import with a VARIABLE arg — must FIRE (opaque, unvetted)
    { rel: 'h/x.ts', src: 'const m = await import(spec);', expect: true },
    // LOADER-1: a dynamic require with a CONCAT arg — must FIRE
    { rel: 'h/x.ts', src: "const c = require('@rayspec/' + name);", expect: true },
    // LOADER-1: createRequire (the require-factory escape hatch) — must FIRE
    {
      rel: 'h/x.ts',
      src: "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url);",
      expect: true,
    },
    // a static-string dynamic import of an ALLOWED module — must NOT fire
    { rel: 'h/x.ts', src: "const sdk = await import('@rayspec/handler-sdk');", expect: false },
    // HG1-NODE-INTERNAL-LOADERS (NIT): on-sight module-loader escape hatches — each must FIRE.
    { rel: 'h/x.ts', src: 'const m = Module._load("@rayspec/db");', expect: true },
    { rel: 'h/x.ts', src: 'const m = module.constructor._load("@rayspec/db");', expect: true },
    { rel: 'h/x.ts', src: 'const fs = process.binding("fs");', expect: true },
    { rel: 'h/x.ts', src: 'const d = require.main.require("@rayspec/db");', expect: true },
    { rel: 'h/x.ts', src: 'const d = process.mainModule.require("@rayspec/db");', expect: true },
    // HG1-COMMENT-STRIP-STRING-BYPASS (should-fix): a forbidden import HIDDEN after a string that
    // CONTAINS comment delimiters — the string-aware stripper must NOT treat the in-string `/*`/`*/`
    // as a real comment (which would mangle the line + hide the import). Must FIRE.
    {
      rel: 'h/x.ts',
      src: 'const s = "/* not a comment */"; import { forTenant } from "@rayspec/db";',
      expect: true,
    },
    // a string containing `//` then a REAL forbidden import on the next line — must FIRE (the in-string
    // `//` must not be treated as a line comment that swallows the import).
    {
      rel: 'h/x.ts',
      src: 'const u = "http://example.com";\nimport { runAgent } from "@rayspec/platform";',
      expect: true,
    },
    // a REAL block comment that mentions a forbidden module, with a string after it — must NOT fire.
    {
      rel: 'h/x.ts',
      src: '/* do not import @rayspec/db */ const s = "ok";',
      expect: false,
    },
    // a '..'-escaping relative path (tunnel to platform source) — must FIRE
    {
      rel: 'h/x.ts',
      src: "import { forTenant } from '../../packages/kernel/db/src/tenant-db.js';",
      expect: true,
    },
    // ── a QUOTED member name (ES2022) is not extracted at all, so the statement walks past EVERY
    //    rule above at once. It is refused as unreadable, not read. Each vector is the quoted
    //    spelling of a plain one already above, and the accept controls below prove the refusal is
    //    not a blanket one.
    { rel: 'h/x.ts', src: 'import { "runAgent" as go } from \'@rayspec/platform\';', expect: true },
    { rel: 'h/x.ts', src: 'import { "makeDb" as m } from \'@rayspec/db/testing\';', expect: true },
    { rel: 'h/x.ts', src: 'import { "default" as p } from \'@rayspec/platform\';', expect: true },
    { rel: 'h/x.ts', src: "import { 'forTenant' as f } from '@rayspec/db';", expect: true },
    { rel: 'h/x.ts', src: 'export { "default" as p } from \'@rayspec/platform\';', expect: true },
    {
      rel: 'h/x.ts',
      src: 'import type { "AgentSpec" as A } from \'@rayspec/core\';',
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: 'import { "forTenant" as f } from \'../../packages/kernel/db/src/tenant-db.js\';',
      expect: true,
    },
    // a name carrying a BRACE (`"a}b"`) — the clause must not be read as ending inside the string
    { rel: 'h/x.ts', src: 'import { "a}b" as c } from \'@rayspec/platform\';', expect: true },
    // ── the same name after a DEFAULT BINDING and as the namespace re-export's exported name. Each
    //    group opens with the PLAIN spelling of that shape, which the ordinary rules already flag,
    //    and is followed by the quoted spellings of it (single- and double-quoted, and one whose
    //    source escapes the scanned root). The plain reading is what makes the quoted zero a hole
    //    rather than a benign miss — and a spelling missing here is cleared against every rule.
    { rel: 'h/x.ts', src: "import platform, { runAgent } from '@rayspec/platform';", expect: true },
    {
      rel: 'h/x.ts',
      src: 'import platform, { "runAgent" as go } from \'@rayspec/platform\';',
      expect: true,
    },
    { rel: 'h/x.ts', src: "import d, { 'makeDb' as m } from '@rayspec/db/testing';", expect: true },
    {
      rel: 'h/x.ts',
      src: 'import x, { "forTenant" as f } from \'../../packages/kernel/db/src/tenant-db.js\';',
      expect: true,
    },
    { rel: 'h/x.ts', src: "export * as p from '@rayspec/platform';", expect: true },
    { rel: 'h/x.ts', src: 'export * as "p" from \'@rayspec/platform\';', expect: true },
    {
      rel: 'h/x.ts',
      src: 'export * as "t" from \'../../packages/kernel/db/src/tenant-db.js\';',
      expect: true,
    },
    // …and the same default binding written as a NON-ASCII identifier, which an ASCII-only binding
    // class would read as no statement at all. Each is paired with its plain spelling, which the
    // ordinary rules flag, so the quoted zero would again be a hole rather than a benign miss.
    { rel: 'h/x.ts', src: "import é, { runAgent } from '@rayspec/platform';", expect: true },
    {
      rel: 'h/x.ts',
      src: 'import é, { "runAgent" as go } from \'@rayspec/platform\';',
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: 'import 平台, { "runAgent" as go } from \'@rayspec/platform\';',
      expect: true,
    },
    // …and the binding written with a unicode escape, which carries a backslash rather than a
    // non-ASCII code point.
    {
      rel: 'h/x.ts',
      src: 'import \\u0070lat, { "runAgent" as go } from \'@rayspec/platform\';',
      expect: true,
    },
    {
      rel: 'h/x.ts',
      src: 'import é, { "forTenant" as f } from \'../../packages/kernel/db/src/tenant-db.js\';',
      expect: true,
    },
    // …and the accept controls for it: a quote in the SOURCE, in an object literal, in a default
    // export, in a comment between the braces, a legitimate enumerable re-export under the name
    // `default`, and the widened spellings written WITHOUT a quoted name against a benign source (a
    // default binding, ASCII and non-ASCII, and a namespace re-export).
    { rel: 'h/x.ts', src: 'import { helper } from "./shared.js";', expect: false },
    { rel: 'h/x.ts', src: 'export const o = { a: "x" };', expect: false },
    { rel: 'h/x.ts', src: 'export default { a: "x" };', expect: false },
    {
      rel: 'h/x.ts',
      src: "import { /* don't */ helper } from '@rayspec/handler-sdk';",
      expect: false,
    },
    { rel: 'h/x.ts', src: "export { helper as default } from './shared.js';", expect: false },
    { rel: 'h/x.ts', src: "import helper, { shared } from './shared.js';", expect: false },
    { rel: 'h/x.ts', src: "export * as shared from './shared.js';", expect: false },
    // the widened binding, spelled non-ASCII, against a benign source: the widening buys the QUOTED
    // NAME after such a binding, not the binding itself.
    { rel: 'h/x.ts', src: "import é, { shared } from './shared.js';", expect: false },
    { rel: 'h/x.ts', src: "import 平台, { shared } from './shared.js';", expect: false },
    // a DEAD STRING mentioning a forbidden module (not an import) — must NOT fire (#16-style)
    {
      rel: 'h/x.ts',
      src: 'const note = "do not import @rayspec/db here";',
      expect: false,
    },
    // a COMMENT mentioning a forbidden module — must NOT fire
    {
      rel: 'h/x.ts',
      src: '// never import @rayspec/platform in a handler',
      expect: false,
    },
    // a benign sibling relative import (a multi-file escape-hatch library) — must NOT fire
    {
      rel: 'h/x.ts',
      src: "import { shared } from './shared.js';",
      expect: false,
    },
    // a benign node builtin a deployment might vendor — NOT a trust-boundary crossing — must NOT fire
    // (the path jail bounds WHICH module loads; this gate targets platform/SDK reach-arounds only)
    { rel: 'h/x.ts', src: "import { z } from 'zod';", expect: false },
  ];
  for (const { rel, src, expect } of cases) {
    const hit = detectViolations(rel, src).length > 0;
    if (hit !== expect) {
      console.error(
        `handler-imports gate SELF-TEST FAILED: detector returned ${hit} (expected ${expect}) ` +
          `for [${rel}]: ${src}`,
      );
      process.exit(2);
    }
  }

  // ── THE SANCTIONED SET IS LOAD-BEARING, proved by MUTATION rather than asserted in a comment.
  //
  // Every accept case above would read identically if `ALLOWED_IMPORTS` decided nothing — which is
  // what it did before the scope rule existed: a name in the set only skipped a forbidden-prefix test
  // it was never going to fail, so emptying the set left this gate green and every case silent. The
  // check that catches that is differential: drop each name in turn and the import that the full set
  // ACCEPTS must be REFUSED by the shrunken one. A name for which it is not is INERT — it is in the
  // set for decoration, and the gate's own message about it would be a claim rather than a rule.
  for (const name of ALLOWED_IMPORTS) {
    const src = `import type { T } from '${name}';`;
    if (detectViolations('h/x.ts', src, ALLOWED_IMPORTS).length !== 0) {
      console.error(
        `handler-imports gate SELF-TEST FAILED: '${name}' is in ALLOWED_IMPORTS but the detector ` +
          'refuses it — the sanctioned set does not accept its own member.',
      );
      process.exit(2);
    }
    const shrunk = ALLOWED_IMPORTS.filter((s) => s !== name);
    if (detectViolations('h/x.ts', src, shrunk).length === 0) {
      console.error(
        `handler-imports gate SELF-TEST FAILED: '${name}' is INERT in ALLOWED_IMPORTS — removing it ` +
          'from the sanctioned set does not make importing it a violation, so its presence there ' +
          'decides nothing and every claim this gate makes about sanctioning it is false.',
      );
      process.exit(2);
    }
  }
}

selfTest();

const violations = [];
let scannedFiles = 0;
let scannedRoots = 0;
/** Per sanctioned contract: how many scanned modules NAME it (the PASS line reports this, not a claim). */
const namedBy = new Map(ALLOWED_IMPORTS.map((s) => [s, 0]));
for (const root of ESCAPE_HATCH_ROOTS) {
  const abs = join(repoRoot, root);
  let exists = true;
  try {
    statSync(abs);
  } catch {
    exists = false;
  }
  if (!exists) continue; // absent root → skip (platform main line ships no product handlers).
  scannedRoots++;
  for (const { full, isSymlink } of walk(abs)) {
    const rel = relative(repoRoot, full).split('\\').join('/');
    scannedFiles++;
    if (isSymlink) {
      // (d) a SYMLINK under an escape-hatch root could point OUT of the trusted library → flag it
      // (we did not follow it). A real escape-hatch library ships real files, not symlinks.
      violations.push(
        `${rel}: is a SYMLINK under the escape-hatch root — a symlinked handler entry could point ` +
          'OUT of the trusted library; ship real files, not symlinks (fail-closed).',
      );
      continue;
    }
    const src = readFileSync(full, 'utf8');
    violations.push(...detectViolations(rel, src));
    for (const s of sanctionedImportsIn(src)) namedBy.set(s, (namedBy.get(s) ?? 0) + 1);
  }
}

if (violations.length > 0) {
  console.error('handler-imports gate FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    `\nUnder the '@rayspec/' scope an escape-hatch handler may name ONLY ${ALLOWED_LIST} — a ` +
      "deployment's own handler names '@rayspec/handler-sdk', a handler contributed by an extension " +
      "pack names '@rayspec/pack-sdk', and every other package under that scope is refused (a " +
      'subpath of a sanctioned one included). An agent SDK is refused outright, and so are a ' +
      "'..'-escape out of the handler tree and an import statement this gate cannot read. The engine " +
      'injects a capability-scoped init; a handler must not reach around it.',
  );
  process.exit(1);
}

// The PASS line REPORTS what the scan read. It does NOT assert a property of every scanned module:
// the tally counts modules that NAME a sanctioned contract, which is fewer than the modules scanned
// (a compiled handler whose only import was type-only carries no import statement at all), and an
// unscoped third-party import is outside every rule here by design. A summary that generalized over
// the scanned set would be false of files this gate had just read.
const tally = [...namedBy].map(([s, n]) => `${n}× '${s}'`).join(', ');
console.log(
  `handler-imports gate PASSED: ${scannedFiles} module(s) across ${scannedRoots} root(s) scanned; ` +
    `sanctioned contracts named ${tally}; no platform internals / agent SDKs / unsanctioned ` +
    "'@rayspec/'-scoped imports / '..'-escapes / unreadable import statements found.",
);
