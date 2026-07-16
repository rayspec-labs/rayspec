#!/usr/bin/env node
/**
 * Tenant-chokepoint CI gate.
 *
 * Request-path code (routes), packages/kernel/platform/src, AND packages/workflow/durable-dbos/src (the off-request
 * worker — it runs runAgent under forTenant(db, tenantId), same chokepoint discipline) must hold ONLY
 * a TenantDb and never reach around it. This gate FAILS THE BUILD if, in those source roots, any
 * non-test file:
 *   - names a raw-handle factory `makeDb` OR `makeDbWithSchema` (both return the unscoped
 *     Drizzle handle; they live on the @rayspec/db/testing subpath, never the main surface), or
 *   - calls `.unscoped()` outside an explicit, reviewed whitelist.
 *
 * run-core lives in packages/kernel/platform (outside a routes-only grep), so the gate covers it —
 * exactly the regression vector the security critique flagged. Test files and test-support
 * helpers are NOT request-path code and are excluded.
 *
 * This is a TRIPWIRE, not a proof: it is intentionally simple + greppable (no AST), so a
 * forbidden TOKEN is a violation. It is the SECOND layer behind the module boundary — the raw
 * factories are not exported from `@rayspec/db` at all, so scoped code cannot import one even
 * if the gate were removed; the gate catches a regression (e.g. someone re-exporting them or
 * reaching the /testing subpath) loudly. The self-test below proves the detector still fires.
 *
 * HONEST SCOPE / known ceiling. Because the detectors are REGEXES (no AST),
 * they catch the COMMON + previously-seen-regression forms — a direct `.db.<query>`, a single-hop alias
 * (`const h = this.db; h.select()`, incl. a private-field `this.#deps.db`), a bracket/`["unscoped"]`
 * access, and a bare `Db`-typed parameter used as a receiver. They do NOT catch every conceivable
 * indirection: a MULTI-HOP alias (`const a = this.db; const b = a; b.select()`), a getter that RETURNS
 * the raw handle, a computed `this['db']` access, the handle stashed on an object property, or a handle
 * obtained through arbitrary call chains can all slip past a regex. So this gate is a loud tripwire for
 * the realistic regressions, NOT an "alias-proof" or "cannot-escape" guarantee. The LOAD-BEARING
 * defenses are: (1) the MODULE BOUNDARY — the raw factories are unexported, so scoped code cannot
 * construct a raw handle; and (2) code review. The gate is defence-in-depth on top
 * of those, not a substitute for them. (Per-tenant ISOLATION proper remains a launch-gate hardening requirement.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Source roots that are request-path / orchestration code and must stay on the chokepoint.
// (packages/compose/api-auth/src + routes are in scope so the gate covers them.)
// packages/workflow/durable-dbos/src is the off-request worker: it holds a raw Db ONLY to bind
// forTenant(db, tenantId) per job (the injected-handle-as-argument pattern, the same sanctioned
// posture as the stores) and never queries the raw handle directly — so it passes all detectors.
const SCOPED_ROOTS = [
  'packages/kernel/platform/src',
  'packages/compose/api-auth/src',
  'packages/workflow/durable-dbos/src',
];

// packages/kernel/db/src is the chokepoint's OWN home (it DEFINES makeDb/unscoped()/forTenant), so it is
// not subject to the raw-factory/unscoped/raw-db-query detectors. But the GATE-ONLY scoped-table
// hooks (`registerScopedTables`/`withScopedTables` — which mutate the real deny-by-default Set) must
// not be CALLED by shipped db/src code outside the modules that legitimately define/host them: a
// shipped caller could register an arbitrary table and defeat deny-by-default. We scan db/src for
// ONLY the scoped-tables-hook token, excluding the definition site + the gate-only modules below.
const DB_SCOPED_TABLES_ROOT = 'packages/kernel/db/src';
const DB_SCOPED_TABLES_ALLOWLIST = new Set([
  // The DEFINITION site — `withScopedTables`/`registerScopedTables` are declared (and reference each
  // other) here. This is the chokepoint module itself, not a caller.
  'packages/kernel/db/src/tenant-db.ts',
  // The `/testing` subpath: the deliberately test-only/gate-only export surface that RE-EXPORTS the
  // hooks (they are not on the shipped @rayspec/db main surface — see index.ts). Gate/test code
  // imports them from here; shipped request code cannot reach them.
  'packages/kernel/db/src/testing.ts',
  // The cross-tenant CI gate harness — a gate-only module that CALLS withScopedTables to assert
  // tenancy over the throwaway's runtime product tables through the real chokepoint machinery.
  'packages/kernel/db/src/generated/product-tenancy-gate.ts',
  // The SANCTIONED product-store registrar (@rayspec/db/composition): registerProductStores VALIDATES
  // every product table before delegating ONCE to registerScopedTables (which it imports from
  // ./tenant-db.js) — the boot-time door onto the deny-by-default Set. It is symmetric with the
  // /testing seam + the product-tenancy gate above (it references the hook by DEFINITION/delegation,
  // not as a shipped-request caller), so it is allowlisted here; the registerProductStores TOKEN itself
  // is the newly-forbidden token in the SCOPED_ROOTS below (a scoped root must not reach this door).
  'packages/kernel/db/src/composition.ts',
]);

// Files explicitly allowed to name a raw-db factory AND/OR call .unscoped() — the composition
// root + the GLOBAL/auth-table store modules (users, orgs, memberships, sessions, api_keys,
// auth_audit, the OIDC model store) that are DELIBERATELY not tenant-scoped (these are
// reached via db.unscoped(); tenant-scoped tables go through forTenant()). Each entry is a
// reviewed global-table module; request handlers for TENANT-scoped resources never appear here.
const UNSCOPED_WHITELIST = new Set([
  // Global/auth-table stores (no tenant_id column — predicate-exempt by design). The raw Db
  // handle is INJECTED into these (the only makeDb call lives in the test harness / a future
  // deploy entrypoint, both outside shipped src); they reach global tables directly and use
  // forTenant(db, tenantId) / db.unscoped() where a tenant scope applies.
  'packages/compose/api-auth/src/stores/identity-store.ts',
  'packages/compose/api-auth/src/stores/org-store.ts',
  'packages/compose/api-auth/src/stores/api-key-store.ts',
  'packages/compose/api-auth/src/stores/audit-store.ts',
  'packages/compose/api-auth/src/stores/oidc-store.ts',
]);

// The named, per-file allowlist for the `Db`-typed-parameter query form
// (`function f(db: Db) { db.transaction(...) }`) — a construction site that legitimately takes the raw
// handle as a bare param and wraps it into a least-privilege facade. It currently has NO members: any
// such audited exemption is added here (and thereby AUDITED, not invisible). Any scoped file that
// queries a `Db`-typed bare param without an entry here fires.
// (This is separate from UNSCOPED_WHITELIST: that exempts `.db`/unscoped()/raw-`.db.<query>` on the
// global-table stores; this exempts only the bare-`Db`-param-as-receiver form.)
const DB_PARAM_QUERY_ALLOWLIST = new Set();

// Exclude test code + test-support helpers (not request-path code).
function isExcluded(relPath) {
  return (
    relPath.includes('/test-support/') ||
    relPath.endsWith('.test.ts') ||
    relPath.endsWith('.test.tsx')
  );
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // root doesn't exist yet
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      yield* walk(full);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      yield full;
    }
  }
}

// raw-db handle factories: makeDb AND makeDbWithSchema (the (WithSchema)? branch is the fix
// for the gap where a SECOND factory slipped past a `\bmakeDb\b`-only detector).
const RAW_FACTORY_RE = /\bmakeDb(WithSchema)?\b/;
// Also catch `.unscoped()` AND its bracket/computed-access equivalents — `tdb["unscoped"]()` /
// `tdb['unscoped']()` — which the dot-only regex missed, so a forbidden escape-hatch call could
// be smuggled past the gate as a computed member access. PLUS a bare `unscoped` token backstop
// (the method exists ONLY on TenantDb, so the identifier appearing in CODE is the tripwire even
// when reached via an alias/string key). The bare-token check runs on COMMENT-STRIPPED source so
// prose that merely MENTIONS unscoped() in a docstring is not a false positive; the dot/bracket
// checks run on raw source (those forms are unambiguous calls).
const UNSCOPED_RES = [
  /\.unscoped\s*\(/, // tdb.unscoped()
  /\[\s*['"]unscoped['"]\s*\]/, // tdb["unscoped"] / tdb['unscoped']
];
const UNSCOPED_TOKEN_RE = /\bunscoped\b/; // applied to comment-stripped source only

// SF (raw-deps.db gap): the injected RAW Db handle (`deps.db`, the unscoped Drizzle handle on
// AppDeps) must NOT be queried directly in request/orchestration code — that bypasses the
// TenantDb predicate exactly like an unscoped() call. We forbid a Drizzle QUERY method invoked
// directly on a `.db` member (`<x>.db.select(...)` / `.insert/.update/.delete/.transaction/
// .execute`) outside the whitelist. PASSING the handle to the chokepoint constructor —
// `forTenant(deps.db, tenantId)` or `DrizzleOidcAdapter.factory(opts.db)` — is FINE (the handle is
// an argument, not the query receiver), so those forms (no `.db.<query>(`) do not match.
const RAW_DB_QUERY_RE = /\.db\s*\.\s*(select|insert|update|delete|transaction|execute)\s*\(/;

// The `.db.<query>(` pattern above misses an ALIASED
// raw handle — `const h = this.db; h.select()` (or `const { db } = this; db.execute(sql)`). A holder
// can dereference the unscoped handle into a local and then query THAT local, so the `.db.`-receiver
// regex never fires on the call site. We close it WITHOUT an AST + WITHOUT false-positiving on the
// SANCTIONED extract-then-pass-as-argument pattern (`const { db } = deps; forTenant(db, tenantId)`)
// by a two-step, same-file match: (1) find every local that is an ALIAS of a raw `.db` handle, then
// (2) FIRE only if that alias is later used as a QUERY RECEIVER (`<alias>.select/insert/update/
// delete/transaction/execute(`). Extracting the handle to pass it onward (never querying it) does
// NOT match — so the cleanup/cron composition sites stay clean, while the aliased-query escape fires.
// HONEST CEILING (re-review): this matches a SINGLE-HOP alias only. A multi-hop chain (`const a =
// this.db; const b = a; b.select()`), a getter return, or a computed `this['db']` can still evade the
// regex — see the file header. The facade + module boundary are the load-bearing defenses; this is a
// tripwire for the realistic single-hop regression, not an exhaustive alias proof.
//
// Alias-introduction forms recognised (the RHS is a raw `.db` member of this/deps/opts/an arg):
//   const h = this.db;        const h = deps.db;        const h = opts.db;
//   const { db } = this;      const { db } = deps;      const { db: h } = deps;
// The RHS char class includes `#` (re-review #3) so a PRIVATE-FIELD handle (`const h = this.#deps.db`)
// is recognised — `#` is otherwise outside `\w`, so the old char class stopped at `this.` and missed it.
const DB_ALIAS_ASSIGN_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$.#]*\.db\b/g;
const DB_ALIAS_DESTRUCTURE_RE =
  /(?:const|let|var)\s*\{[^}]*?\bdb\b(?:\s*:\s*([A-Za-z_$][\w$]*))?[^}]*\}\s*=\s*[A-Za-z_$][\w$.#]*/g;
const QUERY_METHODS = 'select|insert|update|delete|transaction|execute';

/**
 * Find raw-`.db` aliases in `code` that are then USED AS A QUERY RECEIVER (the aliased-escape form the
 * plain `.db.<query>` regex misses). Pure (so the self-test exercises it). Returns the alias names
 * that are queried — an extract-then-pass-as-argument alias (never the receiver of a query) is NOT
 * returned, so the sanctioned `const { db } = deps; forTenant(db, …)` composition stays clean.
 */
function aliasedRawDbQueries(code) {
  const aliases = new Set();
  for (const m of code.matchAll(DB_ALIAS_ASSIGN_RE)) aliases.add(m[1]);
  // Destructured `{ db }` (or `{ db: h }`) — the bound name is the renamed local or `db`.
  for (const m of code.matchAll(DB_ALIAS_DESTRUCTURE_RE)) aliases.add(m[1] ?? 'db');
  const queried = [];
  for (const alias of aliases) {
    // `<alias>.select(` etc. — the alias is the query receiver (word-boundary anchored so `dbx` !== `db`).
    const re = new RegExp(`\\b${escapeRe(alias)}\\s*\\.\\s*(?:${QUERY_METHODS})\\s*\\(`);
    if (re.test(code)) queried.push(alias);
  }
  return queried;
}

/** Escape a captured identifier for safe inclusion in a dynamic RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A raw `Db`-TYPED FUNCTION PARAMETER used as a query receiver —
// `function f(db: Db) { db.transaction(...) }` — evaded every detector above (they match a `.db`
// member or an alias OF a `.db` member, never a bare parameter that IS the raw handle). A facade
// factory `f(db: Db)` that wraps the raw handle is exactly this shape. We close it by
// (1) finding every identifier annotated with the LITERAL `Db` type (`name: Db`) — `\bDb\b` does NOT
// match a facade type like `ReadOnlyDb`/`TenantDb`/`ReadFacade` (no word boundary before `Db` inside
// them, or no `Db` at all), so this stays narrow — then (2) firing only if that name is a BARE query
// receiver (`<name>.select/insert/.../execute(` NOT preceded by a `.`). The non-member-access guard is
// what keeps the global-table stores clean: they hold `private readonly db: Db` and query `this.db.x()`,
// where `db` IS preceded by a `.` — so the field-access form does NOT match here (it is the already-
// handled `.db.<query>` receiver form, audited via UNSCOPED_WHITELIST). Passing the param onward as an
// ARGUMENT (`new DrizzleOidcAdapter(db, name)`) is not a receiver either, so it does not fire.
const DB_TYPED_PARAM_RE = /\b([A-Za-z_$][\w$]*)\s*:\s*Db\b/g;

/**
 * Find `Db`-typed names that are used as a BARE query receiver (the raw-handle-as-parameter form the
 * other detectors miss). Pure (so the self-test exercises it). Returns the offending names. A name
 * queried only via member access (`this.db.x()`) or passed onward as an argument is NOT returned.
 */
function dbTypedParamQueries(code) {
  const names = new Set();
  for (const m of code.matchAll(DB_TYPED_PARAM_RE)) names.add(m[1]);
  const queried = [];
  for (const name of names) {
    // `<name>.<method>(` where `<name>` is NOT a property access: the char before it is not `.`/word/`$`.
    // (Negative lookbehind `(?<![.\w$])` excludes `this.db.x()` — there `db` is preceded by `.`.)
    const re = new RegExp(`(?<![.\\w$])${escapeRe(name)}\\s*\\.\\s*(?:${QUERY_METHODS})\\s*\\(`);
    if (re.test(code)) queried.push(name);
  }
  return queried;
}

// `withScopedTables` (scoped) and `registerScopedTables` (persistent) are the GATE-ONLY hooks, and
// `registerProductStores` is the SANCTIONED-BOOT registrar (@rayspec/db/composition) — all THREE
// register product tables into the real deny-by-default Set (so the cross-tenant gate / the
// declared-route api test can assert tenancy over the throwaway runtime tables; the boot composition
// root + the CLI deploy entrypoint register a real deployment's tables through registerProductStores).
// None may appear in shipped request/orchestration code — a shipped caller could register an arbitrary
// table and defeat deny-by-default. Forbidden in scoped roots; test/gate code (excluded by isExcluded)
// + the definition/composition-root modules (allowlisted above for db/src) may use them.
const WITH_SCOPED_TABLES_RE = /\b(withScopedTables|registerScopedTables|registerProductStores)\b/;

/** Strip `//` line comments and slash-star block comments so the bare-token check skips prose. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid matching `://` in urls)
}

/**
 * Detect chokepoint violations in one file's source. Pure (no I/O) so the self-test below can
 * exercise the EXACT detection logic the gate runs. `rel` is only used for the whitelist check
 * and the message. Returns an array of violation strings (empty = clean).
 */
function detectViolations(rel, src) {
  const found = [];
  // A whitelisted file is a reviewed composition-root / global-table module: it is permitted to
  // construct a raw handle (makeDb) AND to call db.unscoped() for predicate-exempt global tables.
  const whitelisted = UNSCOPED_WHITELIST.has(rel);
  // All detectors run on COMMENT-STRIPPED source so a docstring that merely MENTIONS makeDb /
  // unscoped() (e.g. explaining the chokepoint) is not a false positive; the patterns below match
  // genuine code references (imports, calls, member access).
  const code = stripComments(src);
  if (RAW_FACTORY_RE.test(code) && !whitelisted) {
    found.push(
      `${rel}: names a raw-db factory (makeDb/makeDbWithSchema) — request/orchestration code ` +
        'must use forTenant(db, tenantId), not a raw unscoped handle.',
    );
  }
  const tokenHit = UNSCOPED_TOKEN_RE.test(code);
  const callHit = UNSCOPED_RES.some((re) => re.test(code));
  if ((callHit || tokenHit) && !whitelisted) {
    found.push(
      `${rel}: references unscoped() (dot, computed ["unscoped"], or bare token in code) outside ` +
        'the global-table whitelist.',
    );
  }
  if (RAW_DB_QUERY_RE.test(code) && !whitelisted) {
    found.push(
      `${rel}: queries the raw injected Db directly (.db.select/insert/update/delete/transaction/` +
        'execute) — request/orchestration code must go through forTenant(db, tenantId) or a ' +
        'whitelisted global-table store, never the raw deps.db handle.',
    );
  }
  // The ALIASED form: a raw `.db` handle dereferenced into a local that is then queried
  // (`const h = this.db; h.select()` / `const { db } = this; db.execute(sql)`). Closes the gap where
  // the `.db.<query>` regex above misses an aliased receiver. (An extract-then-pass-as-argument alias
  // — never the query receiver — does not match, so the sanctioned composition sites stay clean.)
  if (!whitelisted) {
    const aliased = aliasedRawDbQueries(code);
    if (aliased.length > 0) {
      found.push(
        `${rel}: queries the raw injected Db via an ALIAS (${aliased.join(', ')}) of a .db handle ` +
          '(e.g. `const h = this.db; h.select()`) — aliasing the unscoped handle does not escape the ' +
          'chokepoint; use forTenant(db, tenantId) or a whitelisted global-table store.',
      );
    }
  }
  // The `Db`-typed-PARAMETER-as-query-receiver form: `function f(db: Db) { db.select() }`.
  // Allowlisted ONLY via DB_PARAM_QUERY_ALLOWLIST (a named, audited facade factory) so it is AUDITED,
  // not invisible; any other scoped file querying a bare `Db`-typed param fires.
  if (!DB_PARAM_QUERY_ALLOWLIST.has(rel)) {
    const dbParams = dbTypedParamQueries(code);
    if (dbParams.length > 0) {
      found.push(
        `${rel}: queries a raw Db-typed PARAMETER directly (${dbParams.join(', ')}) — ` +
          '(e.g. `function f(db: Db) { db.select() }`) — a raw-handle parameter is the unscoped ' +
          'Db; use forTenant(db, tenantId) or a whitelisted global-table store / facade factory.',
      );
    }
  }
  if (WITH_SCOPED_TABLES_RE.test(code)) {
    found.push(
      `${rel}: names withScopedTables/registerScopedTables/registerProductStores — the hooks that ` +
        'register tables into the real deny-by-default Set. They must appear only in test/gate code ' +
        'or the boot composition root / CLI deploy entrypoint, never in shipped request/orchestration ' +
        'code (they could defeat deny-by-default).',
    );
  }
  return found;
}

/**
 * Detect a gate-only scoped-tables-hook reference in a db/src file. Pure (so the self-test exercises
 * the EXACT logic): an allowlisted module (the definition site / /testing subpath / a gate-only
 * module) is permitted; any other db/src file naming the hook is a violation. Returns a violation
 * string or null.
 */
function detectDbScopedTablesViolation(rel, src) {
  if (DB_SCOPED_TABLES_ALLOWLIST.has(rel)) return null;
  if (!WITH_SCOPED_TABLES_RE.test(stripComments(src))) return null;
  return (
    `${rel}: names withScopedTables/registerScopedTables/registerProductStores — the hooks that ` +
    'register tables into the real deny-by-default Set. In packages/kernel/db/src they may appear ONLY ' +
    'in the definition site (tenant-db.ts), the /testing subpath, the sanctioned registrar ' +
    '(composition.ts), or a gate-only module — never in shipped db/src code (they could defeat ' +
    'deny-by-default).'
  );
}

// --- self-test: prove the detector fires for both factories + .unscoped() ----------------
// A regression where makeDbWithSchema (or makeDb) silently slips past the detector is exactly
// the earlier gap; this asserts the detector still catches both before the gate scans anything.
function selfTest() {
  const cases = [
    { src: "import { makeDb } from '@rayspec/db/testing';", expect: true },
    { src: "import { makeDbWithSchema } from '@rayspec/db/testing';", expect: true },
    { src: 'const db = makeDb(url);', expect: true },
    { src: 'const db = makeDbWithSchema(url, schema);', expect: true },
    { src: 'const raw = tdb.unscoped();', expect: true },
    // bracket/computed-member forms + the bare-token backstop must all fire.
    { src: 'const raw = tdb["unscoped"]();', expect: true },
    { src: "const raw = tdb['unscoped']();", expect: true },
    { src: 'const m = "unscoped"; tdb[m]();', expect: true },
    { src: "import { forTenant } from '@rayspec/db';", expect: false },
    { src: 'const tdb = forTenant(db, tenantId);', expect: false },
    // SF raw-deps.db gap: querying the injected raw handle directly must FIRE; passing the handle
    // to the chokepoint constructor / an adapter factory must NOT (the handle is an argument).
    { src: 'const rows = await deps.db.select().from(t);', expect: true },
    { src: 'await deps.db.insert(t).values(v);', expect: true },
    { src: 'await deps.db.update(t).set(s).where(w);', expect: true },
    { src: 'await deps.db.delete(t).where(w);', expect: true },
    { src: 'await deps.db.transaction(async (tx) => {});', expect: true },
    { src: 'return forTenant(deps.db, tenantId);', expect: false },
    { src: 'adapter: DrizzleOidcAdapter.factory(opts.db),', expect: false },
    // `.db.execute(` (raw SQL on the injected handle) must FIRE — it is in the query-method set.
    { src: 'await deps.db.execute(sql`select 1`);', expect: true },
    // The ALIASED raw-db query forms must FIRE — a
    // holder cannot escape the chokepoint by dereferencing `.db` into a local and querying THAT.
    { src: 'const h = this.db; const rows = await h.select().from(t);', expect: true },
    { src: 'const h = this.db; await h.execute(sql`select 1`);', expect: true },
    { src: 'const { db } = this; await db.select().from(t);', expect: true },
    { src: 'const { db } = deps; await db.execute(sql);', expect: true },
    { src: 'const { db: h } = deps; await h.delete(t).where(w);', expect: true },
    // But EXTRACTING the handle to pass it onward (never querying it) must NOT fire — the sanctioned
    // composition-root pattern the cleanup/cron schedulers use (`const { db } = deps; forTenant(db,…)`).
    { src: 'const { db } = deps; const tdb = forTenant(db, tenantId);', expect: false },
    { src: 'const { db, config } = deps; new DrizzleOidcAdapter(db, "Session");', expect: false },
    { src: 'const { db, tenantId } = this.deps; return forTenant(db, tenantId);', expect: false },
    // A local merely NAMED like the alias but not derived from `.db` (and never the deref) is clean.
    { src: 'const dbx = makeThing(); dbx.run();', expect: false },
    // A PRIVATE-FIELD handle alias (`const h = this.#deps.db; h.select()`)
    // must FIRE — `#` is now allowed in the alias RHS, so the deref-then-query escape is caught.
    { src: 'const h = this.#deps.db; const rows = await h.select().from(t);', expect: true },
    { src: 'const { db } = this.#priv; await db.execute(sql);', expect: true },
    // A `Db`-typed PARAMETER queried as a BARE receiver must FIRE.
    { src: 'function f(db: Db) { return db.select().from(t); }', expect: true },
    { src: 'const f = (db: Db) => db.transaction(async (tx) => {});', expect: true },
    { src: 'async function g(handle: Db) { await handle.execute(sql`select 1`); }', expect: true },
    // A FACADE-typed param (ReadOnlyDb/ReadFacade/TenantDb) is NOT the raw `Db` — `\bDb\b` does not match
    // inside those identifiers — so querying it does NOT fire (the least-privilege surface is fine).
    { src: 'function f(ro: ReadOnlyDb) { return ro.select().from(t); }', expect: false },
    { src: 'function f(tdb: TenantDb) { return tdb.select(t); }', expect: false },
    { src: 'function f(db: ReadFacade) { return db.select().from(t); }', expect: false },
    // Passing a `Db`-typed param onward as an ARGUMENT (never querying it) must NOT fire.
    { src: 'function f(db: Db) { return forTenant(db, tenantId); }', expect: false },
    { src: 'static factory(db: Db) { return (name) => new Adapter(db, name); }', expect: false },
    // withScopedTables is gate-only; naming it in shipped scoped code must FIRE.
    { src: 'await withScopedTables(tables, async () => {});', expect: true },
    // registerProductStores is the sanctioned-boot registrar; a SCOPED root must not reach it — FIRE.
    { src: "import { registerProductStores } from '@rayspec/db/composition';", expect: true },
    { src: 'const un = registerProductStores(productTables);', expect: true },
  ];
  for (const { src, expect } of cases) {
    const hit = detectViolations('self-test.ts', src).length > 0;
    if (hit !== expect) {
      console.error(
        `tenant-chokepoint gate SELF-TEST FAILED: detector returned ${hit} (expected ${expect}) ` +
          `for: ${src}`,
      );
      process.exit(2);
    }
  }

  // The `Db`-typed-param detector in ISOLATION — it must fire on a BARE
  // param-receiver but NOT on a MEMBER-access form (`this.db.x()`, which is the already-handled `.db.`
  // receiver form). Tested directly on `dbTypedParamQueries` (rather than via `detectViolations`) because
  // a `this.db.x()` string ALSO trips the separate `.db.<query>` detector — here we isolate the param arm.
  const paramDetectorCases = [
    { src: 'function f(db: Db) { return db.select().from(t); }', expectQueried: true },
    { src: 'function g(handle: Db) { return handle.execute(sql); }', expectQueried: true },
    // Member access via `this.db` is NOT the bare param receiver — the param arm must stay silent.
    {
      src: 'class S { constructor(private readonly db: Db) {} q() { return this.db.select(); } }',
      expectQueried: false,
    },
    // Passing the param onward (argument, never a receiver) is not a query.
    { src: 'function f(db: Db) { return forTenant(db, tenantId); }', expectQueried: false },
    // A facade type is not the raw `Db`.
    { src: 'function f(ro: ReadOnlyDb) { return ro.select().from(t); }', expectQueried: false },
  ];
  for (const { src, expectQueried } of paramDetectorCases) {
    const queried = dbTypedParamQueries(src).length > 0;
    if (queried !== expectQueried) {
      console.error(
        `tenant-chokepoint gate SELF-TEST FAILED (Db-param arm): dbTypedParamQueries returned ` +
          `${queried} (expected ${expectQueried}) for: ${src}`,
      );
      process.exit(2);
    }
  }

  // The UNSCOPED_WHITELIST exemption is a NAMED, PER-FILE entry — NOT a blanket pass for a directory.
  // Prove: a whitelisted global-table store may query the raw injected Db (its predicate-exempt reads),
  // but ANY OTHER file doing the SAME raw-db query MUST still FIRE — so the exemption is path-exact +
  // non-blind (a sibling file cannot smuggle a raw-db read past the gate by sharing a path prefix).
  const whitelistExemptionCases = [
    // A whitelisted global-table store: a raw-db query here is PERMITTED (predicate-exempt by design).
    {
      rel: 'packages/compose/api-auth/src/stores/identity-store.ts',
      src: 'const rows = await this.db.select().from(schema.users);',
      expect: false,
    },
    // The whitelisted store stays exempt EVEN via an alias of the handle.
    {
      rel: 'packages/compose/api-auth/src/stores/identity-store.ts',
      src: 'const h = this.db; const rows = await h.select().from(schema.users);',
      expect: false,
    },
    // A NON-whitelisted request-path file doing a raw-db query is a violation (no blanket pass).
    {
      rel: 'packages/kernel/platform/src/run-core.ts',
      src: 'const rows = await deps.db.select().from(schema.runs);',
      expect: true,
    },
    // The ALIASED escape is blocked per-file too: a non-whitelisted file cannot smuggle a raw-db read
    // past the gate by aliasing the handle (`const h = deps.db; h.select()`).
    {
      rel: 'packages/kernel/platform/src/run-core.ts',
      src: 'const h = deps.db; const rows = await h.select().from(schema.runs);',
      expect: true,
    },
  ];
  for (const { rel, src, expect } of whitelistExemptionCases) {
    const hit = detectViolations(rel, src).length > 0;
    if (hit !== expect) {
      console.error(
        `tenant-chokepoint gate SELF-TEST FAILED: detector returned ${hit} (expected ${expect}) ` +
          `for: ${src}`,
      );
      process.exit(2);
    }
  }

  // db/src scoped-tables-hook detector: a non-allowlisted db/src file naming the hook MUST fire; the
  // allowlisted definition/gate-only modules MUST NOT (even when they call it). The bare-token-only
  // (commented) case must also be skipped (prose mention is not a call).
  const dbCases = [
    {
      rel: 'packages/kernel/db/src/some-shipped.ts',
      src: 'registerScopedTables(t);',
      expect: true,
    },
    {
      rel: 'packages/kernel/db/src/some-shipped.ts',
      src: 'await withScopedTables(t, fn);',
      expect: true,
    },
    {
      rel: 'packages/kernel/db/src/tenant-db.ts',
      src: 'export function withScopedTables() {}',
      expect: false,
    },
    {
      rel: 'packages/kernel/db/src/testing.ts',
      src: 'export { registerScopedTables } from "./x";',
      expect: false,
    },
    {
      rel: 'packages/kernel/db/src/generated/product-tenancy-gate.ts',
      src: 'return withScopedTables(tables, fn);',
      expect: false,
    },
    {
      rel: 'packages/kernel/db/src/some-shipped.ts',
      src: '// withScopedTables is gate-only (prose only, no call)',
      expect: false,
    },
    // registerProductStores in a NON-allowlisted db/src file must FIRE; the composition.ts definition
    // site (allowlisted above) must NOT — even though it DEFINES + delegates through the hook.
    {
      rel: 'packages/kernel/db/src/some-shipped.ts',
      src: 'const un = registerProductStores(tables);',
      expect: true,
    },
    {
      rel: 'packages/kernel/db/src/composition.ts',
      src: 'export function registerProductStores(tables) { return registerScopedTables([...]); }',
      expect: false,
    },
  ];
  for (const { rel, src, expect } of dbCases) {
    const hit = detectDbScopedTablesViolation(rel, src) !== null;
    if (hit !== expect) {
      console.error(
        `tenant-chokepoint gate SELF-TEST FAILED (db/src): detector returned ${hit} (expected ` +
          `${expect}) for ${rel}: ${src}`,
      );
      process.exit(2);
    }
  }
}

selfTest();

const violations = [];

for (const root of SCOPED_ROOTS) {
  for (const file of walk(join(repoRoot, root))) {
    const rel = relative(repoRoot, file);
    if (isExcluded(rel)) continue;
    const src = readFileSync(file, 'utf8');
    violations.push(...detectViolations(rel, src));
  }
}

// db/src: ONLY the gate-only scoped-tables-hook check, with the definition/gate-only allowlist.
for (const file of walk(join(repoRoot, DB_SCOPED_TABLES_ROOT))) {
  const rel = relative(repoRoot, file);
  if (isExcluded(rel)) continue;
  const v = detectDbScopedTablesViolation(rel, readFileSync(file, 'utf8'));
  if (v) violations.push(v);
}

if (violations.length > 0) {
  console.error('tenant-chokepoint gate FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\nRequest-path + run-core code must hold only a TenantDb. Use forTenant(db, tenantId);' +
      ' reach global/auth tables via db.unscoped() ONLY in a whitelisted module.',
  );
  process.exit(1);
}

console.log(
  'tenant-chokepoint gate PASSED: no raw-db imports or unscoped() calls in scoped roots.',
);
