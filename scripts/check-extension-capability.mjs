#!/usr/bin/env node
/**
 * Extension-capability CI gate — the capability-injection boundary.
 *
 * An escape-hatch / extension-pack handler module is TRUSTED-AUTHOR product logic. It
 * receives EVERY capability it needs by INJECTION — the tenant-bound `init.db` (a name-keyed `HandlerDb`
 * facade over the real `TenantDb` chokepoint) and the tenant-bound `init.blob` (a `BlobStore` bound to
 * the run's server-derived tenant). A handler must NEVER SELF-CONSTRUCT a raw capability: a raw Postgres
 * pool/client, a `makeDb`/`makeDbWithSchema` handle, a `forTenant(...)` on a self-built db, a `deps.db`
 * reach-around, a `drizzle(...)` instance, or a raw blob backend (`new FsBlobStore` / a
 * `makeFsBlobStoreFactory` call). Each of those FABRICATES a capability OUTSIDE the injected, tenant-
 * bound handle — defeating the entire tenant-isolation model:
 *   - a self-built DB handle bypasses the `TenantDb` tenant predicate (a cross-tenant read);
 *   - a self-built blob backend bypasses the tenant-prefix-by-construction + path jail that ARE the
 *     ENTIRE tenant isolation for blobs (a `BlobStore` does NOT traverse the SQL chokepoint).
 * This gate FAILS THE BUILD on any such self-construction in an escape-hatch module.
 *
 * MIRRORS scripts/check-tenant-chokepoint.mjs + check-handler-imports.mjs: a greppable TRIPWIRE (no
 * AST), COMMENT-stripped (string-aware, like check-handler-imports.mjs) before analysis, with a PURE
 * `detectViolations(rel, src)` + a SELF-TEST that proves the detector FIRES on every self-construct
 * vector AND PASSES clean injected-handle code.
 *
 * SCOPE + HONEST LIMITS (this is a TRIPWIRE, not a sandbox — the real boundary is the isolate):
 *   - It is GREPPABLE: it matches CALL SHAPES (`new Pool(`, `forTenant(`, `new FsBlobStore(`). It does
 *     NOT chase ALIASING — `const F = FsBlobStore; new F()` or `const ft = forTenant; ft(...)` slip past
 *     (the original token never appears next to `(`). Catching aliasing needs real data-flow analysis,
 *     out of scope for a greppable tripwire; the self-test documents these as known `expect:false` gaps.
 *   - The companion `gate:handler-imports` forbids importing a platform internal, so a handler CANNOT
 *     import `forTenant`/`makeDb`/`FsBlobStore` from `@rayspec/*` — for THOSE the import gate is the
 *     prerequisite block and this gate is the second layer. BUT that prerequisite does NOT hold for the
 *     raw-DB-via-third-party-driver path: `pg` / `postgres` / `drizzle-orm` are NOT import-forbidden (a
 *     deployment may legitimately vendor them), so for the `new Pool(` / `new Client(` / `drizzle(`
 *     vectors THIS aliasable blocklist is the SOLE tripwire — and aliasing defeats it. The real
 *     confinement is, again, the isolate (a handler cannot reach a raw driver from inside it).
 *
 * ESCAPE-HATCH ROOTS: the SAME roots `gate:handler-imports` scans (the throwaway's handlers on the
 * platform main line; a real deployment / pack adds its own root). Absent roots are skipped (the
 * platform main line ships no product handlers → green by construction).
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverExtensionHandlerRoots } from './lib/extension-roots.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The BASE escape-hatch roots — kept in lockstep with check-handler-imports.mjs's
 * BASE_ESCAPE_HATCH_ROOTS (the throwaway's handlers; a real deployment/pack runs the gate in its own
 * repo). The PACK handler roots are DISCOVERED below (manifest-derived, the SAME
 * `discoverExtensionHandlerRoots` both gates share — so a pack added to a YAML is scanned by BOTH).
 */
const BASE_ESCAPE_HATCH_ROOTS = [
  'examples/acme-notes-backend/handlers',
  // The GENERATED reference handlers (Expense-Claim Auto-Coder). Scanned here
  // so the capability-injection gate FIRES if generated code ever self-constructs a raw DB/blob handle.
  // Kept in LOCKSTEP with check-handler-imports.mjs's BASE_ESCAPE_HATCH_ROOTS.
  'examples/expense-claim-coder/handlers',
  // NOTE: the stream/blob backend's handlers live in its extension PACK — DISCOVERED
  // below as a pack handler root (manifest-derived), not a fixed base root.
];

// DISCOVER the extension-pack handler roots (manifest-derived, path-jailed). A
// pack `module` that ESCAPES the repo jail is a gate FAILURE (fail-closed) — surfaced before any scan.
const { roots: PACK_HANDLER_ROOTS, escapes: PACK_ROOT_ESCAPES } =
  discoverExtensionHandlerRoots(repoRoot);
if (PACK_ROOT_ESCAPES.length > 0) {
  console.error(
    'extension-capability gate FAILED: an extension-pack module escapes the repo jail:',
  );
  for (const e of PACK_ROOT_ESCAPES) {
    console.error(
      `  - ${e.spec}: extensions[].module '${e.module}' resolves OUTSIDE the repo (path-jail).`,
    );
  }
  process.exit(1);
}
const ESCAPE_HATCH_ROOTS = [...BASE_ESCAPE_HATCH_ROOTS, ...PACK_HANDLER_ROOTS];

/** Module file extensions an escape-hatch handler may be authored in (mirror handler-imports). */
const MODULE_EXTS = ['.ts', '.tsx', '.mjs', '.js', '.cjs'];

/**
 * The self-construct vectors. Each is a greppable token/shape that FABRICATES a raw capability instead
 * of using the injected `init.db` / `init.blob`. Matched against COMMENT-STRIPPED source so a docstring
 * that merely MENTIONS one is not a false positive.
 */
const SELF_CONSTRUCT_VECTORS = [
  // A raw Postgres pool/client (the `pg` package) — the rawest DB-capability fabrication.
  { re: /\bnew\s+Pool\s*\(/, what: 'new Pool(...) (a raw Postgres connection pool)' },
  { re: /\bnew\s+Client\s*\(/, what: 'new Client(...) (a raw Postgres client)' },
  // The raw-handle factories (also forbidden by the import gate; backstopped here on the call shape).
  {
    re: /\bmakeDb(WithSchema)?\s*\(/,
    what: 'makeDb/makeDbWithSchema(...) (a raw unscoped Drizzle handle)',
  },
  // A `forTenant(...)` CALL — in a handler this can only be a self-built TenantDb (the handler gets the
  // tenant-bound `init.db` facade, never constructs one). The injected facade is `init.db`, not forTenant.
  {
    re: /\bforTenant\s*\(/,
    what: 'forTenant(...) (self-constructing a TenantDb — use the injected init.db facade)',
  },
  // A `deps.db` reach-around (the injected RAW Db on AppDeps — a handler must never see/query it).
  {
    re: /\bdeps\s*\.\s*db\b/,
    what: 'deps.db (reaching the raw injected Db — not a handler capability)',
  },
  // A `drizzle(...)` instance — building an ORM handle directly over a raw client.
  { re: /\bdrizzle\s*\(/, what: 'drizzle(...) (building a raw Drizzle handle)' },
  // A raw blob backend — constructing the fs/object blob store instead of using the injected init.blob.
  {
    re: /\bnew\s+FsBlobStore\s*\(/,
    what: 'new FsBlobStore(...) (a raw blob backend — use the injected init.blob handle)',
  },
  {
    re: /\bmakeFsBlobStoreFactory\s*\(/,
    what: 'makeFsBlobStoreFactory(...) (a raw blob backend factory — use the injected init.blob handle)',
  },
  // A raw READ-ONLY fs-source backend — constructing the path-jailed local-file reader instead of using
  // the injected init.fsSource (a self-built one over an unrestricted root would defeat the path jail).
  {
    re: /\bmakeFsSourceFactory\s*\(/,
    what: 'makeFsSourceFactory(...) (a raw fs-source backend factory — use the injected init.fsSource handle)',
  },
];

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
    if (lst.isSymbolicLink()) continue; // handler-imports gate flags symlinks; we just don't descend.
    if (lst.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      yield* walk(full);
    } else if (MODULE_EXTS.some((ext) => name.endsWith(ext))) {
      yield full;
    }
  }
}

/**
 * Strip `//` line comments and slash-star block comments in a SINGLE left-to-right pass that is
 * STRING-AWARE (mirrors check-handler-imports.mjs's stripper, HG1-COMMENT-STRIP-STRING-BYPASS fix). A
 * comment delimiter is recognized ONLY when we are NOT inside a string/template literal — so a `/* *​/`
 * or `//` that lives INSIDE a string is left intact and does NOT swallow a real self-construct token on
 * a later line (the naive two-regex form could mis-parse such an in-string delimiter as a real comment
 * and mangle the code around it, hiding a violation). String/template CONTENT is PRESERVED (so a
 * docstring/string mentioning a forbidden token is still seen as a non-comment string — but the
 * self-construct regexes match CALL SHAPES like `new Pool(`, which a prose string does not contain, so
 * a mere mention stays a non-false-positive). Backslash escapes inside strings are honored.
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
 * Detect self-construction of a raw capability in one escape-hatch module's source. Pure (no I/O) so
 * the self-test exercises the EXACT logic. `rel` is used only for the message. Returns violation strings.
 */
export function detectViolations(rel, src) {
  const found = [];
  const code = stripComments(src);
  for (const { re, what } of SELF_CONSTRUCT_VECTORS) {
    if (re.test(code)) {
      found.push(
        `${rel}: self-constructs a capability — ${what}. An escape-hatch/pack handler receives EVERY ` +
          'capability by injection (init.db / init.blob, both tenant-bound); it must never fabricate a ' +
          'raw DB or blob backend (that bypasses the tenant predicate / the blob tenant-prefix+jail). ' +
          'Use the injected handle (fail-closed).',
      );
    }
  }
  return found;
}

// --- self-test: prove the detector FIRES on every self-construct vector + PASSES clean code ----------
function selfTest() {
  const cases = [
    // clean injected-handle code — must PASS
    {
      rel: 'h/clean.ts',
      src: "export const ingest = async (init) => { await init.blob.put('k', body); await init.db.insert('blob_chunks', row); };",
      expect: false,
    },
    {
      rel: 'h/clean2.ts',
      src: "import type { StreamRouteHandler } from '@rayspec/handler-sdk'; export const h = (init) => init.db.select('s');",
      expect: false,
    },
    // self-construct vectors — each must FIRE
    { rel: 'h/x.ts', src: 'const pool = new Pool({ connectionString: url });', expect: true },
    { rel: 'h/x.ts', src: 'const c = new Client(url);', expect: true },
    { rel: 'h/x.ts', src: 'const db = makeDb(url);', expect: true },
    { rel: 'h/x.ts', src: 'const db = makeDbWithSchema(url, schema);', expect: true },
    { rel: 'h/x.ts', src: 'const tdb = forTenant(db, tenantId);', expect: true },
    { rel: 'h/x.ts', src: 'const rows = await deps.db.select().from(t);', expect: true },
    { rel: 'h/x.ts', src: 'const d = drizzle(client);', expect: true },
    { rel: 'h/x.ts', src: 'const blob = new FsBlobStore(root, tenantId);', expect: true },
    { rel: 'h/x.ts', src: "const f = makeFsBlobStoreFactory('/data/blobs');", expect: true },
    { rel: 'h/x.ts', src: "const s = makeFsSourceFactory('/data/reference');", expect: true },
    // a COMMENT mentioning a forbidden token — must NOT fire (prose, not code)
    {
      rel: 'h/x.ts',
      src: '// never call forTenant or new Pool in a handler — use init.db / init.blob',
      expect: false,
    },
    {
      rel: 'h/x.ts',
      src: '/* do not makeDb() or new FsBlobStore() here */ export const h = (init) => init.db.select("s");',
      expect: false,
    },
    // a benign use of a similarly-named local (NOT a forbidden vector) — must NOT fire. `init.db` is the
    // sanctioned facade; a method named `insert` on it is fine.
    {
      rel: 'h/x.ts',
      src: "export const h = (init) => init.db.transaction(async (tx) => tx.insert('s', row));",
      expect: false,
    },
    // FIX B — STRING-AWARE comment stripper, proven FAIL-THE-FIX. A STRING LITERAL
    // opens an UNMATCHED `/*`, a REAL `new Pool(` follows it, and a LATER string contains `*/`. The
    // NAIVE two-regex stripper's `/\*[\s\S]*?\*\//` matches from the IN-STRING `/*` to the IN-STRING
    // `*/` and SWALLOWS the `new Pool(` between them → the violation is HIDDEN (detector returns false).
    // The string-aware single-pass stripper recognizes those delimiters are INSIDE strings, leaves the
    // code intact, and the real `new Pool(` is seen → must FIRE. (Reverting stripComments to the naive
    // two-regex form turns this case RED — the detector would return false where we assert true.)
    {
      rel: 'h/x.ts',
      src: 'const a = "x /* y"; const pool = new Pool(cfg); const b = "z */ w";',
      expect: true,
    },
    // a string containing `//` then a REAL self-construct on the next line — the in-string `//` must not
    // be treated as a line comment that swallows the violation. Must FIRE.
    {
      rel: 'h/x.ts',
      src: 'const u = "http://example.com";\nconst c = new Client(url);',
      expect: true,
    },
    // FIX D (nit) — the greppable blocklist is a TRIPWIRE and does NOT catch ALIASING. These document
    // that limit honestly (expect:false): the real boundary is the isolate, NOT this regex.
    // An aliased constructor (`const F = FsBlobStore; new F()`) is NOT matched (the `new FsBlobStore(`
    // shape never appears) — we deliberately do NOT try to chase aliasing in the regex (out of scope).
    {
      rel: 'h/x.ts',
      src: 'const F = FsBlobStore; const blob = new F(root, tenantId);',
      expect: false,
    },
    // a destructured/renamed factory import then called via the alias — likewise NOT caught (the
    // `makeFsBlobStoreFactory(` call-shape token never appears). Documented tripwire limit.
    {
      rel: 'h/x.ts',
      src: 'const make = makeFsBlobStoreFactory; const f = make("/data/blobs");',
      expect: false,
    },
    // an aliased forTenant — same documented limit (no `forTenant(` token after aliasing).
    { rel: 'h/x.ts', src: 'const ft = forTenant; const tdb = ft(db, tenantId);', expect: false },
  ];
  for (const { rel, src, expect } of cases) {
    const hit = detectViolations(rel, src).length > 0;
    if (hit !== expect) {
      console.error(
        `extension-capability gate SELF-TEST FAILED: detector returned ${hit} (expected ${expect}) ` +
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
  for (const full of walk(abs)) {
    const rel = relative(repoRoot, full).split('\\').join('/');
    scannedFiles++;
    violations.push(...detectViolations(rel, readFileSync(full, 'utf8')));
  }
}

if (violations.length > 0) {
  console.error('extension-capability gate FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\nAn escape-hatch/pack handler receives every capability by injection (init.db / init.blob, both ' +
      'tenant-bound) — it must never self-construct a raw DB or blob backend. That bypasses the tenant ' +
      'predicate / the blob tenant-prefix+jail (the entire tenant isolation for blobs).',
  );
  process.exit(1);
}

console.log(
  `extension-capability gate PASSED: ${scannedFiles} escape-hatch module(s) across ${scannedRoots} ` +
    'root(s) self-construct no raw DB/blob capability (injected handles only).',
);
