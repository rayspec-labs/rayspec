/**
 * The read-only SHADOW-APPLY for `rayspec plan` — proves a spec's generated product migration SQL
 * APPLIES cleanly, WITHOUT ever touching the real target DB.
 *
 * Mirrors scripts/shadow-dryrun.sh's clean-room pattern, generically over `generateProductSql` output:
 *   1. derive the SHADOW server from `SHADOW_DATABASE_URL` (NEVER `DATABASE_URL`);
 *   2. CREATE a uniquely-named throwaway DB on that server (`rayspec_plan_<pid>_<random>`);
 *   3. connect to the THROWAWAY DB, seed a minimal `orgs` FK root (the generated tables carry a
 *      `tenant_id uuid NOT NULL REFERENCES orgs(id)` injected FK — applying them needs orgs to exist);
 *   4. apply the generated SQL (stripping Drizzle's `--> statement-breakpoint` markers, like the
 *      shadow-dryrun script) inside one transaction — all-or-nothing;
 *   5. DROP the throwaway DB in a `finally` (FORCE-terminating any lingering backend) so a failure
 *      leaves no orphan DB behind.
 *
 * READ-ONLY w.r.t. the real target's CONTENTS — STRUCTURAL ARGUMENT (scoped honestly):
 *   • NO DML/DDL this module issues ever mutates the real target's schema or rows: every mutating
 *     statement (the `orgs` seed + the applied migration) runs on a connection to
 *     `withDatabaseName(shadowUrl, throwawayName)` — the SHADOW server's host/credentials with the
 *     database name OVERWRITTEN to a name this module just generated.
 *   • the admin connection AND the `CREATE DATABASE`/`DROP DATABASE` it issues run on the SHADOW
 *     SERVER (the `shadowDatabaseUrl` host) — they create/drop only the throwaway DB this module
 *     named. The caller (`plan.ts`, RO-1) additionally REFUSES to run a shadow whose URL resolves to
 *     the SAME host:port AND database as `DATABASE_URL`, so the shadow server is never the real DB.
 *   • the throwaway name is `rayspec_plan_` + pid + random — it cannot pre-exist (a `CREATE DATABASE`
 *     of an existing name errors), so we never adopt/mutate a DB we did not just create.
 *   • the DROP is the last thing we do, in a `finally`.
 *
 * NO secrets leak (SL-1/SL-2): this module returns only `{ ok }` or `{ ok:false, error }`. The
 * sanitizer is STRUCTURALLY FAIL-CLOSED by code REGION, not by an error-code allowlist (SL-1-INCOMPLETE
 * hardening): ANY throw from the admin-connect / `CREATE DATABASE` region OR the throwaway-connect /
 * `orgs`-seed region (all infrastructure) collapses to a fixed generic string — postgres.js / Node can
 * embed the host:port (with no `@` authority, e.g. `connect EHOSTUNREACH 10.0.0.5:5432`,
 * `write CONNECTION_CLOSED db.internal:5432`) for failure CODES no allowlist can fully enumerate, so we
 * never echo a connect-class message at all. ONLY the in-transaction SQL APPLY of the spec's generated
 * migration (`tx.unsafe(applySql)`) is surfaced VERBATIM — it describes the SQL (the diagnosable case
 * the docstring promises), never the URL. An enumerated code allowlist + an authority/host:port regex
 * remain as defence-in-depth, but the load-bearing guarantee is the region split. The caller is
 * additionally responsible for never echoing the URL, and this module never puts the URL in the error.
 */
import { randomBytes } from 'node:crypto';
import {
  type DriftFinding,
  detectDrift,
  formatDrift,
  type QueryFn,
  type StoreConflictKeys,
} from '@rayspec/db';
import type { StoreSpec } from '@rayspec/spec';
import postgres from 'postgres';

/** A fixed, secret-free message for any connection/auth-class failure (no host/port/user/password). */
const GENERIC_CONNECT_ERROR = 'could not connect to / authenticate against the shadow database';

/**
 * A defence-in-depth set of postgres.js / Node error CODES that indicate a CONNECTION or
 * AUTHENTICATION failure. This is NO LONGER the load-bearing guarantee (the structural region split in
 * `sanitizeError`/`shadowApply` is) — a connect-region failure is fail-closed by phase regardless of
 * its code; this set only collapses an `apply`-phase message that happens to carry one of these codes.
 *   - 28P01 invalid_password · 28000 invalid_authorization_specification (PostgresError SQLSTATE)
 *   - ECONNREFUSED / ENOTFOUND / ETIMEDOUT (Node socket/DNS) · EAI_AGAIN (DNS)
 *   - CONNECT_TIMEOUT / CONNECTION_CLOSED / CONNECTION_ENDED / CONNECTION_DESTROYED (postgres.js)
 */
const CONNECT_AUTH_CODES = new Set([
  '28P01',
  '28000',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
]);

/**
 * The phase a throw came from. `'connect'` = any infrastructure region (admin-connect / CREATE
 * DATABASE, or the throwaway-connect / `orgs`-seed) — ALWAYS collapses to the generic message,
 * fail-closed, because such a failure can embed the host:port for a CODE no allowlist enumerates.
 * `'apply'` = the in-transaction apply of the spec's generated migration — surfaced VERBATIM (it
 * describes the SQL, the diagnosable case; it never carries the URL).
 */
type SanitizePhase = 'connect' | 'apply';

/**
 * Sanitize a thrown error into a secret-free `error` string — STRUCTURALLY fail-closed by `phase`
 * (SL-1-INCOMPLETE hardening). For `phase: 'connect'` (any infra region) we ALWAYS return the fixed
 * {@link GENERIC_CONNECT_ERROR} — never the verbatim message — so no host/port/user/password can leak,
 * regardless of the error code (EHOSTUNREACH/ENETUNREACH/TLS codes and bare `host:port` messages that
 * no code allowlist catches). For `phase: 'apply'` (the spec's migration SQL) we surface the verbatim
 * message — it describes the SQL, not the URL. The PRIMARY guarantee is this region split; the
 * enumerated {@link CONNECT_AUTH_CODES} check + the authority/host:port regex below are a secondary
 * defence-in-depth net (they also collapse an `apply`-phase message that somehow embeds an authority or
 * a bare `host:port`/IPv4:port form).
 */
function sanitizeError(e: unknown, phase: SanitizePhase): string {
  // Region fail-closed: a connect/infra failure NEVER echoes its message — independent of the code.
  if (phase === 'connect') return GENERIC_CONNECT_ERROR;
  // apply-phase: surface the SQL error verbatim, but still belt-and-braces against a leaked authority.
  const code =
    e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;
  if (code !== undefined && CONNECT_AUTH_CODES.has(code)) return GENERIC_CONNECT_ERROR;
  const msg = e instanceof Error ? e.message : String(e);
  // Belt-and-braces: collapse if the message embeds a postgres:// URL, an `@host:port` authority, OR a
  // bare `host:port` / IPv4:port (the form postgres.js/Node use in connect-style messages with no `@`).
  if (
    /postgres(ql)?:\/\//i.test(msg) ||
    /@[\w.-]+:\d+/.test(msg) ||
    /\b[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?:\d{1,5}\b/i.test(msg)
  ) {
    return GENERIC_CONNECT_ERROR;
  }
  return msg;
}

/**
 * The outcome of a shadow-apply: clean apply, or a captured (secret-free) error message. `dbName` is
 * the throwaway DB name this run created (always returned so a test can assert THAT specific DB was
 * dropped — robust to concurrent runs vs a global `rayspec_plan_%` pattern check; `undefined` only if
 * the CREATE itself never happened, e.g. an admin-connect failure).
 */
export type ShadowApplyResult =
  | { ok: true; dbName: string | undefined }
  | { ok: false; error: string; dbName: string | undefined };

/**
 * Rewrite a postgres connection URL's DATABASE NAME (the path segment) to `dbName`, preserving the
 * scheme/credentials/host/port/query. Used to point the SHADOW server's URL at our throwaway DB. We
 * parse with the WHATWG URL (postgres URLs are URL-shaped) and only replace the pathname.
 */
export function withDatabaseName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Derive a fresh, unique throwaway DB name. Lowercase + underscores + hex only → a safe SQL
 * identifier (no quoting needed); pid + random make a concurrent `plan` collision effectively
 * impossible.
 */
export function throwawayDbName(): string {
  return `rayspec_plan_${process.pid}_${randomBytes(6).toString('hex')}`;
}

/** The minimal `orgs` FK root the injected `tenant_id -> orgs(id)` FK needs (mirrors shadow-dryrun.sh). */
const ORGS_ROOT_SQL = `
CREATE TABLE orgs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL DEFAULT 'x',
  region text NOT NULL DEFAULT 'eu',
  retention_days integer,
  external_idp_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);`;

/**
 * Apply `migrationSql` against a throwaway DB on the SHADOW server, read-only w.r.t. the real target.
 * Returns `{ ok:true }` if the seed + migration applied cleanly; `{ ok:false, error }` (secret-free)
 * otherwise. The error is sanitized STRUCTURALLY by region (SL-1-INCOMPLETE): any failure of the
 * connect / CREATE-DATABASE / throwaway-connect / `orgs`-seed infrastructure collapses to a fixed
 * generic message (no host/credential ever echoed, regardless of error code — SL-1); ONLY a failure of
 * the spec's migration APPLY is surfaced verbatim (it describes the SQL). ALWAYS drops the throwaway
 * DB in a `finally`.
 *
 * `migrationSql` is the `generateProductSql` output — Drizzle-style with `--> statement-breakpoint`
 * separators, which we strip (like shadow-dryrun.sh) before running the file as one transaction.
 */
export async function shadowApply(
  shadowDatabaseUrl: string,
  migrationSql: string,
): Promise<ShadowApplyResult> {
  const dbName = throwawayDbName();

  // The admin connection — connect to the SHADOW server (its own DB) ONLY to CREATE/DROP the
  // throwaway. `max:1` (one connection); we end it in the finally.
  const admin = postgres(shadowDatabaseUrl, { max: 1, onnotice: () => {} });
  let created = false;
  try {
    // CREATE the throwaway. The name is a freshly-generated safe identifier; `unsafe` is required for
    // a DDL statement that cannot be parameterized (a DB name is an identifier, not a value) — it is
    // safe here because the name is OURS (generated from pid+hex), never operator/spec input.
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    created = true;

    // Connect to the THROWAWAY DB (never the real target) to seed + apply.
    const throwUrl = withDatabaseName(shadowDatabaseUrl, dbName);
    const work = postgres(throwUrl, { max: 1, onnotice: () => {} });
    try {
      // Strip Drizzle's statement-breakpoint markers (same as shadow-dryrun.sh's `sed`), then apply
      // the seed + migration in ONE transaction (all-or-nothing — a failure rolls back, then we drop).
      // PHASE-tag the throw fail-closed: a failure of the `orgs` SEED (infra) collapses to the generic
      // connect message; ONLY a failure of the spec's migration APPLY is surfaced verbatim (it
      // describes the SQL). We mark the apply boundary so the catch can tell the two regions apart.
      const applySql = migrationSql.replace(/-->\s*statement-breakpoint/g, '');
      let phase: SanitizePhase = 'connect'; // the connect/seed region until the apply begins
      try {
        await work.begin(async (tx) => {
          await tx.unsafe(ORGS_ROOT_SQL); // infra seed — still 'connect'
          phase = 'apply'; // from here, a throw is the spec's migration SQL → surfaced verbatim
          await tx.unsafe(applySql);
        });
      } catch (e) {
        return { ok: false, error: sanitizeError(e, phase), dbName };
      }
      return { ok: true, dbName };
    } finally {
      await work.end({ timeout: 5 });
    }
  } catch (e) {
    // The admin-connect / CREATE DATABASE / throwaway-connect failed — all infrastructure (the 'connect'
    // region). Fail-closed: NEVER echo host/port/credentials, regardless of the error code.
    return {
      ok: false,
      error: sanitizeError(e, 'connect'),
      dbName: created ? dbName : undefined,
    };
  } finally {
    // Drop the throwaway (FORCE-terminates lingering backends) so a failure leaves no orphan DB.
    if (created) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } catch {
        // Swallow — a failed drop must not mask the real result (mirrors shadow-dryrun.sh's trap).
      }
    }
    await admin.end({ timeout: 5 });
  }
}

/**
 * The outcome of a BASELINE-SEEDED shadow-apply (the `plan --against` UPDATE check). Same secret-free
 * contract as {@link ShadowApplyResult}, plus the drift findings from the post-apply oracle: `ok:true`
 * carries `drift:[]` (the end state matches the NEW spec); `ok:false` carries the failure `error` and,
 * when the failure was DRIFT (not an apply error), the non-empty `drift` list that explains it.
 */
export type ShadowBaselineResult =
  | { ok: true; dbName: string | undefined; drift: DriftFinding[] }
  | { ok: false; error: string; dbName: string | undefined; drift?: DriftFinding[] };

/**
 * BASELINE-SEEDED shadow-apply for `plan --against` — proves a DELTA migration evolves the
 * OLD schema into the NEW spec, WITHOUT ever touching the real target DB. On a throwaway DB (same
 * clean-room lifecycle as {@link shadowApply}):
 *   1. seed the `orgs` FK root,
 *   2. apply `baselineSql` (the OLD spec's first-materialization — the schema the delta evolves FROM;
 *      it comes from the OLD SPEC FILE, never live introspection, so `plan` stays zero-real-DB-contact),
 *   3. apply `deltaSql` (the `diffProductStores` forward migration) in statement order,
 *   4. assert the END STATE satisfies the NEW spec via the SAME `detectDrift` oracle the boot path
 *      uses. What the oracle CHECKS is one-directional — spec ⊆ live: for everything `newStores`
 *      DECLARES (every table; every business + injected column's presence / normalized type /
 *      nullability; each single-column UNIQUE; the tenant_id→orgs FK and each product→product FK's
 *      ON DELETE policy) it verifies the live end state has it, correct. ZERO drift ⇒ the delta
 *      produced (at least) the target schema. Non-vacuous in the ADD/type direction: an UNAPPLIABLE
 *      delta fails on apply (step 3); a delta that adds the wrong column/type/nullability, or omits a
 *      column/table/unique/FK the new spec declares, fails here (step 4).
 *
 *      HONEST LIMIT — because the oracle is spec ⊆ live it does NOT check the REMOVE direction: a delta
 *      that FAILS to drop a column/table the new spec no longer declares leaves that column/table
 *      present, and this check still reports drift-clean (extra, undeclared structure is invisible to a
 *      spec⊆live comparison). This is NOT reachable through `plan --against`'s real path — the delta
 *      ALWAYS comes from `diffProductStores`, which deterministically emits the DROP for every removed
 *      column/table, and a destructive delta with no covering allowlist is gate-BLOCKED before the
 *      shadow ever runs, so any delta that reaches step 4 already contains its removals. The limit is
 *      only that THIS oracle alone would not catch a hand-crafted delta that silently skipped a DROP.
 *
 * Secret-free by the SAME region split as {@link shadowApply}: connect / CREATE-DATABASE / `orgs`-seed
 * failures collapse to the generic connect message; a baseline/delta SQL apply failure is surfaced
 * VERBATIM (it describes the SQL, never the URL). ALWAYS drops the throwaway DB in a `finally`.
 *
 * `baselineSql`/`deltaSql` are `generateProductSql` / `diffProductStores` output (Drizzle-style with
 * `--> statement-breakpoint` markers), which we strip before running each as one transaction.
 *
 * `newConflictKeys` (DX-v1.2, optional) ARMS the post-apply oracle: supplied ⇒ `detectDrift` is STRICT
 * about the unique-index shape (a non-key author-unique column with a stale single-column GLOBAL index
 * where a tenant-scoped compound is now expected is flagged `stale_global_unique`); omitted ⇒ LENIENT
 * (the boot posture — any covering unique index satisfies, so a working legacy deployment is never
 * refused). The `plan` path passes it; direct callers omit it.
 */
export async function shadowApplyBaselineUpdate(
  shadowDatabaseUrl: string,
  baselineSql: string,
  deltaSql: string,
  newStores: StoreSpec[],
  newConflictKeys?: StoreConflictKeys,
): Promise<ShadowBaselineResult> {
  const dbName = throwawayDbName();
  const admin = postgres(shadowDatabaseUrl, { max: 1, onnotice: () => {} });
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    created = true;

    const throwUrl = withDatabaseName(shadowDatabaseUrl, dbName);
    const work = postgres(throwUrl, { max: 1, onnotice: () => {} });
    try {
      const stripBreakpoints = (sql: string): string =>
        sql.replace(/-->\s*statement-breakpoint/g, '');
      const baseline = stripBreakpoints(baselineSql);
      const delta = stripBreakpoints(deltaSql);

      // Apply seed → baseline → delta all-or-nothing. PHASE-tag the throw fail-closed: the `orgs` seed
      // (infra) collapses to the generic connect message; a baseline/delta SQL apply failure is
      // surfaced verbatim (it describes the SQL — the diagnosable UNAPPLIABLE-delta case).
      let phase: SanitizePhase = 'connect';
      try {
        await work.begin(async (tx) => {
          await tx.unsafe(ORGS_ROOT_SQL); // infra seed — still 'connect'
          phase = 'apply'; // from here, a throw is baseline/delta SQL → surfaced verbatim
          await tx.unsafe(baseline);
          await tx.unsafe(delta);
        });
      } catch (e) {
        return { ok: false, error: sanitizeError(e, phase), dbName };
      }

      // Post-apply ORACLE: the SAME drift-detect the boot path uses. The throwaway materializes the
      // product tables in `public`; zero drift vs `newStores` = the delta produced the target schema.
      const query: QueryFn = async (sql, params) =>
        (await work.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];
      // DX-v1.2 FINDING-2: when `newConflictKeys` is supplied (the `plan` path arms it), the oracle is
      // STRICT about the unique-index shape — a NON-key author-unique column with a stale single-column
      // GLOBAL index (where a tenant-scoped compound is now expected) is flagged `stale_global_unique`.
      // Omitted (a direct/legacy caller) ⇒ LENIENT: any covering unique index satisfies (boot posture).
      const drift = await detectDrift(newStores, 'public', query, newConflictKeys);
      if (drift.length > 0) {
        return {
          ok: false,
          error: `baseline+delta applied but the end state DRIFTS from the new spec:\n${formatDrift(drift)}`,
          drift,
          dbName,
        };
      }
      return { ok: true, dbName, drift: [] };
    } finally {
      await work.end({ timeout: 5 });
    }
  } catch (e) {
    return { ok: false, error: sanitizeError(e, 'connect'), dbName: created ? dbName : undefined };
  } finally {
    if (created) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } catch {
        // Swallow — a failed drop must not mask the real result.
      }
    }
    await admin.end({ timeout: 5 });
  }
}
