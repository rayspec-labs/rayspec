#!/usr/bin/env node
/**
 * Handler-imports CI gate — the escape-hatch import boundary.
 *
 * An escape-hatch handler module (a `handlers[].module` resolved under a deployment's
 * `escapeHatchRoot`) is TRUSTED-AUTHOR product logic. Its ONLY sanctioned dependency
 * is `@rayspec/handler-sdk` — the type-only capability contract the engine injects against. It must
 * NEVER import a platform internal (`@rayspec/platform`/`db`/`core`/`api-auth`/`auth-core`/`spec`)
 * or an agent SDK (`@openai/agents`, `@anthropic-ai/*`, `@earendil-works/*`), because:
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
 * detector fires on every forbidden vector AND passes the one sanctioned import.
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

/** The ONE import an escape-hatch module may name. */
const ALLOWED_IMPORT = '@rayspec/handler-sdk';

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
 * `detectDynamicImportViolations` — it is FLAGGED as opaque, not source-extracted).
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
 * A RELATIVE import is suspect: an escape-hatch module should depend only on `@rayspec/handler-sdk`
 * (a sibling .ts in the same escape-hatch library is allowed — that is still product logic, not a
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
 */
export function detectViolations(rel, src) {
  const found = [];
  const code = stripComments(src);
  for (const source of extractImportSources(code)) {
    if (source === ALLOWED_IMPORT) continue; // the ONE sanctioned import
    if (isForbidden(source)) {
      found.push(
        `${rel}: imports '${source}' — an escape-hatch handler may import ONLY ` +
          `'${ALLOWED_IMPORT}', never a platform internal or an agent SDK.`,
      );
    } else if (isEscapingRelative(source)) {
      found.push(
        `${rel}: imports a '..'-escaping relative path '${source}' — an escape-hatch handler may not ` +
          'tunnel out of the escape-hatch library into platform source.',
      );
    }
    // A non-forbidden, non-escaping import (a sibling relative module, or a benign 3rd-party util a
    // deployment vendors in its own library) is NOT flagged here — the path jail (loader.ts) bounds
    // WHICH file loads; this gate bounds the trust-boundary-crossing imports specifically.
  }
  // LOADER-1: an opaque dynamic import()/require()/createRequire — flag (cannot be vetted).
  found.push(...detectDynamicImportViolations(rel, code));
  return found;
}

// --- self-test: prove the detector fires for every forbidden vector + passes the clean one --------
function selfTest() {
  const cases = [
    // the ONE sanctioned import — must PASS
    {
      rel: 'examples/acme-notes-backend/handlers/x.ts',
      src: "import type { ToolHandler } from '@rayspec/handler-sdk';",
      expect: false,
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
}

selfTest();

const violations = [];
let scannedFiles = 0;
let scannedRoots = 0;
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
    violations.push(...detectViolations(rel, readFileSync(full, 'utf8')));
  }
}

if (violations.length > 0) {
  console.error('handler-imports gate FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    `\nAn escape-hatch handler may import ONLY '${ALLOWED_IMPORT}' — never a platform internal ` +
      '(@rayspec/{platform,db,core,api-auth,auth-core,spec}) or an agent SDK. The engine injects a ' +
      'capability-scoped HandlerInit; a handler must not reach around it.',
  );
  process.exit(1);
}

console.log(
  `handler-imports gate PASSED: ${scannedFiles} escape-hatch module(s) across ${scannedRoots} ` +
    `root(s) import only '${ALLOWED_IMPORT}' (no platform internals / SDKs / '..'-escapes).`,
);
