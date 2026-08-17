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
import { type Db, POOLED_HANDLE } from './client.js';
import {
  appendTenantEvents,
  readTenantEventPage,
  type TenantEventAppendResult,
  type TenantEventInput,
  type TenantEventPage,
} from './event-bus.js';
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
   *
   * `opts.lockTimeoutMs` BOUNDS how long a statement in this transaction waits for a row lock another
   * transaction holds: past it Postgres aborts the statement with SQLSTATE 55P03 (`isLockTimeout`)
   * instead of waiting. It is opt-in per call and omitted by default, so every existing transaction
   * keeps Postgres' default (wait indefinitely). Pass it where a contended row must not hold the
   * caller — a request handler touching a row a long-running run's transaction owns.
   */
  async transaction<R>(
    fn: (tx: TenantDb) => Promise<R>,
    opts?: { lockTimeoutMs?: number },
  ): Promise<R> {
    const lockTimeoutMs = opts?.lockTimeoutMs;
    const bounded =
      typeof lockTimeoutMs === 'number' && Number.isFinite(lockTimeoutMs) && lockTimeoutMs > 0;
    return this.raw.transaction(async (txRaw) => {
      await txRaw.execute(sql`select set_config(${TENANT_GUC}, ${this.tenantId}, true)`);
      // Same set_config reason as the tenant GUC above: SET's grammar rejects a bind parameter. The
      // value is a whole number of milliseconds (the GUC's own default unit — it rejects a fraction),
      // and `is_local` makes it last exactly as long as this transaction.
      if (bounded) {
        const ms = String(Math.ceil(lockTimeoutMs as number));
        await txRaw.execute(sql`select set_config('lock_timeout', ${ms}, true)`);
      }
      // txRaw is a Drizzle transaction handle structurally compatible with Db's query API.
      const txTenant = new TenantDb(txRaw as unknown as Db, this.tenantId);
      return fn(txTenant);
    });
  }

  /**
   * Cross-tenant run-header ownership probe (encapsulated).
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
   * Append events to THIS tenant's event-bus stream (encapsulated, like `runHeaderOwnership`).
   *
   * The append is ONE statement whose correctness is Postgres-internal — the counter row's lock is
   * what makes allocation order equal commit order (see event-bus.ts) — so it cannot be expressed
   * through the query-builder methods above without becoming several statements. Rather than hand a
   * caller the raw handle to run it (the reach-around the chokepoint gate exists to catch), the call
   * lives HERE: the tenant comes from `this.tenantId`, so the statement has no tenant parameter a
   * caller could supply, and the capability a handler receives is bound to the run's server-derived
   * tenant BY CONSTRUCTION.
   *
   * Called on the TRANSACTIONAL handle inside a route handler's engine-opened transaction (the events
   * commit with the handler's own writes), and on a plain handle from a tool handler (which has no
   * outer transaction by design). Returns the allocated seq range, or undefined for an empty batch.
   */
  async appendEvents(
    events: readonly TenantEventInput[],
  ): Promise<TenantEventAppendResult | undefined> {
    return appendTenantEvents(this.raw, this.tenantId, events);
  }

  /**
   * Read ONE page of THIS tenant's event-bus stream — the head, the retention floor, how far the read
   * scanned, and the matching events — from ONE snapshot (see `readTenantEventPage`).
   *
   * Here for the same reason `appendEvents` is: the read's correctness comes from the statement being
   * ONE statement (the floor and the rows must not be able to disagree), which the query-builder
   * methods above cannot express, and the alternative — handing the subscription route the raw handle
   * — is the reach-around the chokepoint exists to catch. The tenant comes from `this.tenantId`, so
   * there is no tenant parameter a cursor or a query string could ever supply.
   */
  async readEventPage(opts: {
    readonly after: number;
    readonly limit: number;
    readonly topics?: readonly string[];
  }): Promise<TenantEventPage> {
    return readTenantEventPage(this.raw, this.tenantId, opts);
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

/** What a pinned handle exposes to a caller that has to run one statement on THIS connection. */
export interface PinnedConnection {
  unsafe(
    sql: string,
    params: never[],
    options: { prepare?: boolean | undefined },
  ): Promise<unknown>;
}

/**
 * THE CONNECTION A TRANSACTIONAL HANDLE IS PINNED TO — `undefined` when the handle is the pooled one.
 *
 * Why this exists: a pack's contributed route runs inside the transaction the deployment opened
 * around the request, and the door onto that pack's own platform tables has to run its statements on
 * THAT connection. Anything else takes a second connection out of a four-connection pool while this
 * request is holding one of them. That is not a hazard but a measured deadlock — eight concurrent
 * requests through a pooled mount completed 0 of 8 and timed out at 15 s, where the pinned mount
 * completed 8 of 8 in 24 ms — and it would also cost atomicity with the route's own writes.
 *
 * IT READS THE DRIVER'S INTERNALS, and says so: the transaction object the query builder hands its
 * callback is not decorated the way the base handle is, so the pinned connection is reached through
 * the session. Measured: `tx.session.client.unsafe(…)` and `tx.execute(…)` report the same
 * `txid_current()`.
 *
 * THE DISCRIMINATOR IS A SYMBOL WE OWN, and an earlier version of this function got that wrong in a
 * way worth leaving on the record. It keyed on `$client`, reasoning that the base handle carries it
 * "because `makeDb` puts it there". `makeDb` does assign it — and so does
 * `drizzle-orm/postgres-js/driver.js`, which sets `db.$client = client` itself. So the discriminator
 * was the DRIVER's property, and the day a driver decorated its transactions with it too, every
 * pinned mount would have become a pooled one SILENTLY: measured, that mutation left all three pack
 * suites green while turning the request path into the deadlock above. {@link POOLED_HANDLE} cannot
 * be produced outside `@rayspec/db`, so a dependency cannot add it to anything.
 *
 * THE FAILURE MODE IS THE RETURN TYPE'S WHOLE DESIGN. Branded ⇒ pooled, and there is legitimately
 * nothing to pin. NOT branded ⇒ this is not the pooled handle, and failing to find a pinned
 * connection on it is a REFUSAL, never a fallback.
 */
export function pinnedConnectionOf(tdb: TenantDb): PinnedConnection | undefined {
  const raw = tdb.unscoped() as unknown as {
    [POOLED_HANDLE]?: true;
    session?: { client?: unknown };
  };
  if (raw[POOLED_HANDLE] === true) return undefined; // the base handle: pooled by construction
  const client = raw.session?.client;
  if (client === undefined || typeof (client as PinnedConnection).unsafe !== 'function') {
    throw new Error(
      'TenantDb: this handle is not the pooled one this package builds, and its pinned connection ' +
        'could not be reached through `session.client` — the database driver changed shape. ' +
        'Refusing rather than falling back to the pooled handle: a statement that must run inside ' +
        'the caller\u2019s transaction would otherwise take a second connection out of the same ' +
        'pool, block on the rows the caller already holds, and lose atomicity with them.',
    );
  }
  return client as PinnedConnection;
}
