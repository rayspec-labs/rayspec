/**
 * TenantDb — the tenant-predicate CHOKEPOINT.
 *
 * `forTenant(rawDb, tenantId)` returns a handle that STRUCTURALLY carries the tenant
 * predicate so no call site can forget it:
 *   - select/update/delete auto-inject `eq(table.tenantId, tenantId)` into the WHERE;
 *   - insert auto-stamps `tenantId` onto every row;
 *   - empty/undefined tenantId THROWS at construction (fail-closed);
 *   - DENY-BY-DEFAULT: only tables in TENANT_SCOPED_TABLES are reachable here; any other
 *     table throws rather than silently falling through unscoped;
 *   - `unscoped()` is the ONE loud, greppable escape hatch returning the raw Drizzle handle
 *     for global/auth tables (orgs, users, sessions, api_keys, memberships, auth_audit, the
 *     OIDC store). The grep/lint gate forbids `.unscoped()` outside whitelisted modules.
 *   - `transaction(fn)` populates the `app.current_tenant` GUC first (its name is the exported
 *     `TENANT_GUC` constant — single source of truth) via
 *     `select set_config(TENANT_GUC, <tenantId>, true)`, so Postgres row-level-security
 *     policies (when RLS is enabled) bind to an already-populated GUC with zero call-site churn. `set_config`
 *     is used rather than `SET LOCAL` deliberately: SET's grammar rejects a bind parameter, so
 *     a `SET LOCAL app.current_tenant = ${tenantId}` interpolation (which Drizzle/postgres-js
 *     compile to `$1`) is a hard syntax error; set_config IS a function and accepts the value
 *     as a bind parameter, which also keeps the tenantId out of raw SQL (no injection seam).
 *
 * Built as a purpose-shaped wrapper over the documented Drizzle 0.45.2 query builder
 * (select().from().where(), insert().values(), update().set().where(), delete().where())
 * rather than monkey-patching Drizzle internals, so an ORM bump cannot silently strip the
 * predicate.
 */
import { and, eq, getTableColumns, type SQL, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from './client.js';
import { runs, TENANT_SCOPED_TABLES } from './schema.js';

/**
 * The Postgres GUC the transaction seam populates and row-level-security policies (when RLS is enabled) read back. Exported as
 * the single source of truth so the set_config write site (here) and any read-back (current_setting
 * in tests / future RLS policy SQL) reference one constant — a rename cannot silently desync them.
 */
export const TENANT_GUC = 'app.current_tenant';

/** The set of tables forTenant() will auto-scope. Anything else throws (deny-by-default). */
const SCOPED = new Set<PgTable>(TENANT_SCOPED_TABLES as readonly PgTable[]);

type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

function assertScoped(table: PgTable): void {
  if (!SCOPED.has(table)) {
    throw new Error(
      'TenantDb: table is not registered in TENANT_SCOPED_TABLES — refusing to auto-scope. ' +
        'Use db.unscoped() for global/auth tables, or add it to the tenant-scoped allowlist.',
    );
  }
}

/**
 * GATE-ONLY: run `fn` with `tables` temporarily registered in the REAL
 * deny-by-default Set, then restore it. The platform main line ships a PRODUCT-EMPTY generated
 * tuple, so the cross-tenant gate cannot otherwise reach a product table through the chokepoint;
 * this lets the gate assert tenancy over the THROWAWAY's runtime-built product tables using the
 * SAME `assertScoped`/predicate machinery a real deployment uses (where the tables ARE in the Set
 * via the committed generated tuple). It mutates the real Set so the assertion exercises the actual
 * chokepoint — NOT a parallel copy. Restored in a `finally` so a throwing assertion cannot leak a
 * registration. This is loud + greppable like `.unscoped()`: the tenant-chokepoint CI gate FORBIDS
 * `withScopedTables` in shipped scoped roots (packages/platform/src, packages/api-auth/src), so it
 * can only appear in test/gate code.
 */
export async function withScopedTables<R>(
  tables: readonly PgTable[],
  fn: () => Promise<R>,
): Promise<R> {
  const unregister = registerScopedTables(tables);
  try {
    return await fn();
  } finally {
    unregister();
  }
}

/**
 * GATE-ONLY: the PERSISTENT analog of `withScopedTables` — register `tables` in the REAL
 * deny-by-default Set and return an `unregister()` thunk to remove exactly the ones THIS call added.
 * For a test that serves HTTP requests across its whole lifetime (the declared-route api interpreter
 * resolves tables through the chokepoint per request, so the registration must be LIVE for the suite,
 * not just one assertion) — register in `beforeAll`, call the returned thunk in `afterAll`. A real
 * deployment registers via the committed generated tuple (TENANT_SCOPED_TABLES); this is the test/gate
 * equivalent. Same loud + greppable status as `withScopedTables`: the tenant-chokepoint CI gate
 * FORBIDS it in shipped scoped roots, so it can only appear in test/gate code.
 */
export function registerScopedTables(tables: readonly PgTable[]): () => void {
  const added: PgTable[] = [];
  for (const t of tables) {
    if (!SCOPED.has(t)) {
      SCOPED.add(t);
      added.push(t);
    }
  }
  return () => {
    for (const t of added) SCOPED.delete(t);
  };
}

/**
 * Tenant ids are org UUIDs (orgs.id is `uuid` — see schema.ts). A shape check at the
 * boundary keeps a non-uuid value (a leftover legacy text tenant, a slug, an injected string)
 * from ever reaching forTenant() and the set_config GUC. Accepts any RFC-4122 8-4-4-4-12 hex
 * form, case-insensitive.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the table's tenant_id column object (for eq()/auto-stamp). */
function tenantColumn(table: PgTable) {
  const col = (getTableColumns(table) as Record<string, unknown>).tenantId;
  if (!col) {
    throw new Error('TenantDb: registered table has no tenantId column');
  }
  return col as Parameters<typeof eq>[0];
}

export class TenantDb {
  private readonly raw: Db;
  readonly tenantId: string;

  constructor(raw: Db, tenantId: string) {
    // Fail-closed: an empty/undefined/blank tenantId must never resolve to "all tenants".
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new Error('TenantDb: tenantId is required (fail-closed) — refusing an empty scope.');
    }
    // Shape-check: tenant ids are org UUIDs; reject anything that is not (defence in depth for
    // the set_config GUC and the eq() predicate).
    if (!UUID_SHAPE.test(tenantId)) {
      throw new Error('TenantDb: tenantId must be a UUID (fail-closed).');
    }
    this.raw = raw;
    this.tenantId = tenantId;
  }

  /**
   * SELECT from a tenant-scoped table with the tenant predicate auto-injected. The returned
   * builder's `.where(extra)` AND-combines `extra` with the structural tenant predicate, so a
   * caller can add their own conditions but can NEVER drop the tenant filter.
   */
  select<T extends TenantScopedTable>(table: T, columns?: Parameters<Db['select']>[0]) {
    assertScoped(table);
    const tenantPredicate = eq(tenantColumn(table), this.tenantId);
    const base = (columns ? this.raw.select(columns) : this.raw.select()).from(table as PgTable);
    return {
      where(extra?: SQL | undefined) {
        return base.where(and(tenantPredicate, extra));
      },
      // No explicit .where() ⇒ still tenant-scoped.
      all() {
        return base.where(tenantPredicate);
      },
    };
  }

  /** INSERT into a tenant-scoped table, auto-stamping tenantId on every row. */
  insert<T extends TenantScopedTable>(
    table: T,
    values: Record<string, unknown> | Record<string, unknown>[],
  ) {
    assertScoped(table);
    const stamp = (v: Record<string, unknown>) => ({ ...v, tenantId: this.tenantId });
    const stamped = Array.isArray(values) ? values.map(stamp) : stamp(values);
    return this.raw.insert(table as PgTable).values(stamped as never);
  }

  /**
   * UPDATE a tenant-scoped table, auto-injecting the tenant predicate into the WHERE.
   *
   * Defense-in-depth (structural for ALL callers): the `tenantId` key is STRIPPED from the
   * SET — symmetric with `insert` auto-stamping it. So an `update(table, { tenantId: other })` can
   * NEVER move a row to another tenant: the predicate scopes the WHERE to THIS tenant's rows, and the
   * stripped SET means the compiled UPDATE never carries a tenant_id assignment. This is the
   * belt-and-suspenders beneath every caller (run-core / api-auth / the handler facade) that no caller
   * may move a row's tenant; the facade additionally rejects a tenant_id in the patch loudly upstream.
   *
   * NOTE: if `tenantId` was the ONLY key, the stripped SET is EMPTY and Drizzle THROWS "No values to
   * set" (an empty `.set({})` is a hard error, NOT a silent no-op). That is acceptable here — a
   * tenant-only update is meaningless, the facade already rejects it at its edge, and a loud throw is
   * preferable to silently moving (or no-op'ing) a row. A patch with OTHER keys + a stray tenantId
   * applies the other keys with the tenant assignment dropped.
   */
  update<T extends TenantScopedTable>(table: T, set: Record<string, unknown>) {
    assertScoped(table);
    const tenantPredicate = eq(tenantColumn(table), this.tenantId);
    // Strip the tenant key from the SET (the Drizzle property is `tenantId`); a caller may never
    // re-assign a row's tenant via update — matches how insert auto-stamps it.
    const { tenantId: _stripped, ...safeSet } = set;
    return {
      where: (extra?: SQL | undefined) =>
        this.raw
          .update(table as PgTable)
          .set(safeSet as never)
          .where(and(tenantPredicate, extra)),
    };
  }

  /** DELETE from a tenant-scoped table, auto-injecting the tenant predicate into the WHERE. */
  delete<T extends TenantScopedTable>(table: T) {
    assertScoped(table);
    const tenantPredicate = eq(tenantColumn(table), this.tenantId);
    return {
      where: (extra?: SQL | undefined) =>
        this.raw.delete(table as PgTable).where(and(tenantPredicate, extra)),
    };
  }

  /**
   * Run `fn` inside a transaction that populates the `app.current_tenant` GUC first — the
   * RLS-ready seam (for row-level security when enabled). The callback receives a TenantDb bound to the SAME tenant over
   * the transactional handle.
   *
   * Uses `set_config(name, value, is_local := true)` rather than `SET LOCAL name = value`:
   * Drizzle/postgres-js compile the `${this.tenantId}` interpolation to a `$1` bind parameter,
   * which Postgres' SET grammar rejects (syntax error). set_config is a function that DOES
   * accept the value as a parameter — so the GUC is set transaction-locally and the tenantId
   * is never concatenated into raw SQL.
   */
  async transaction<R>(fn: (tx: TenantDb) => Promise<R>): Promise<R> {
    return this.raw.transaction(async (txRaw) => {
      await txRaw.execute(sql`select set_config(${TENANT_GUC}, ${this.tenantId}, true)`);
      // txRaw is a Drizzle transaction handle structurally compatible with Db's query API.
      const txTenant = new TenantDb(txRaw as unknown as Db, this.tenantId);
      return fn(txTenant);
    });
  }

  /**
   * Cross-tenant run-header ownership probe (CRITICAL #1, encapsulated).
   *
   * Returns the OWNERSHIP verdict for a runId against THIS tenant. This is intentionally a
   * cross-tenant read (it must see whether the PK belongs to ANOTHER tenant to detect a
   * collision) — so it lives HERE, inside the db boundary, rather than forcing run-core to
   * reach for unscoped(). Result:
   *   - 'absent'  — no runs row for this runId (a genuine cache-miss; safe to run live);
   *   - 'owned'   — the row exists and belongs to this tenant (safe to replay);
   *   - 'foreign' — the row exists under a DIFFERENT tenant ⇒ reject before backend.run.
   */
  async runHeaderOwnership(runId: string): Promise<'absent' | 'owned' | 'foreign'> {
    const rows = await this.raw
      .select({ tenantId: runs.tenantId })
      .from(runs)
      .where(eq(runs.runId, runId))
      .limit(1);
    const owner = rows[0]?.tenantId;
    if (owner === undefined) return 'absent';
    return owner === this.tenantId ? 'owned' : 'foreign';
  }

  /**
   * The ONE sanctioned escape hatch: the raw Drizzle handle for GLOBAL/auth tables that are
   * deliberately NOT tenant-scoped (orgs, users, sessions, api_keys, memberships, auth_audit,
   * the OIDC model store). Loud + greppable on purpose; the CI gate forbids `.unscoped()`
   * outside whitelisted global-table modules.
   */
  unscoped(): Db {
    return this.raw;
  }
}

/** Bind the raw Drizzle handle to one tenant. The ONLY way request/run-core code gets a Db. */
export function forTenant(rawDb: Db, tenantId: string): TenantDb {
  return new TenantDb(rawDb, tenantId);
}
