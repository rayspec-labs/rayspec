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
 *
 * EVERY STATEMENT RUNS UNDER THE TENANT CONTEXT. The tenant is also written into the transaction-local
 * setting `app.current_tenant` (the exported `TENANT_GUC`), which the database's row-level policies
 * compare every row with (`tenant-isolation.ts`). A statement built here therefore never runs without
 * it:
 *   - `transaction(fn)` sets it first, and every statement of `fn` runs in that transaction;
 *   - a statement built on a handle over the POOL is executed in its own short transaction that sets
 *     the context first — the builder is recorded and replayed on the transaction's handle when it is
 *     awaited, so the call sites keep the plain Drizzle chain (`.where().limit()`, `.returning()`);
 *   - a statement built on a handle over a transaction someone else opened sets the context in that
 *     transaction right before it runs.
 * The setting is transaction-local (`set_config(name, value, true)`), so a pooled connection carries
 * no tenant from one transaction into the next. `set_config` is used rather than `SET LOCAL`: SET's
 * grammar rejects a bind parameter, so a `SET LOCAL app.current_tenant = ${tenantId}` interpolation
 * (which Drizzle/postgres-js compile to `$1`) is a hard syntax error; set_config IS a function and
 * accepts the value as a bind parameter, which also keeps the tenantId out of raw SQL (no injection
 * seam).
 *
 * Built as a purpose-shaped wrapper over the documented Drizzle 0.45.2 query builder
 * (select().from().where(), insert().values(), update().set().where(), delete().where())
 * rather than monkey-patching Drizzle internals, so an ORM bump cannot silently strip the
 * predicate.
 */
import { and, eq, getTableColumns, is, type SQL, sql } from 'drizzle-orm';
import { type PgTable, PgTransaction } from 'drizzle-orm/pg-core';
import type { Db } from './client.js';
import {
  appendTenantEvents,
  readTenantEventPage,
  sweepTenantEvents,
  type TenantEventAppendResult,
  type TenantEventInput,
  type TenantEventPage,
  type TenantEventSweepResult,
} from './event-bus.js';
import { runs, TENANT_SCOPED_TABLES } from './schema.js';

/**
 * The Postgres setting every statement of the chokepoint runs under and the row-level policies read
 * back. Exported as the single source of truth so the set_config write site (here), the policy SQL
 * (`tenant-isolation.ts`) and any read-back in tests reference one constant — a rename cannot
 * silently desync them.
 */
export const TENANT_GUC = 'app.current_tenant';

/**
 * Handles whose transaction already carries this handle's tenant: the ones `transaction()` hands its
 * callback. Every other handle sets the context itself before each statement.
 */
const CONTEXT_SET = new WeakSet<TenantDb>();

/**
 * Builder members that describe the statement rather than run it. Reading one replays the recorded
 * chain on the raw handle and returns the real member, so the SQL text of a statement can still be
 * inspected without executing it.
 */
const DESCRIBE_ONLY = new Set<string | symbol>(['toSQL', 'getSQL', 'getSelectedFields', '_']);

interface RecordedCall {
  readonly member: string | symbol;
  readonly args: readonly unknown[];
}

function replay(builder: unknown, calls: readonly RecordedCall[]): unknown {
  let current = builder as Record<string | symbol, (...a: unknown[]) => unknown>;
  for (const call of calls) {
    const method = current[call.member];
    if (typeof method !== 'function') {
      throw new Error(`TenantDb: the query builder has no method '${String(call.member)}'`);
    }
    current = method.apply(current, call.args as unknown[]) as typeof current;
  }
  return current;
}

async function setContext(handle: Db, tenantId: string): Promise<void> {
  await handle.execute(sql`select set_config(${TENANT_GUC}, ${tenantId}, true)`);
}

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
    const from = (h: Db) => (columns ? h.select(columns) : h.select()).from(table as PgTable);
    return {
      where: (extra?: SQL | undefined) =>
        this.inContextBuilder((h) => from(h).where(and(tenantPredicate, extra))),
      // No explicit .where() ⇒ still tenant-scoped.
      all: () => this.inContextBuilder((h) => from(h).where(tenantPredicate)),
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
    return this.inContextBuilder((h) => h.insert(table as PgTable).values(stamped as never));
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
        this.inContextBuilder((h) =>
          h
            .update(table as PgTable)
            .set(safeSet as never)
            .where(and(tenantPredicate, extra)),
        ),
    };
  }

  /** DELETE from a tenant-scoped table, auto-injecting the tenant predicate into the WHERE. */
  delete<T extends TenantScopedTable>(table: T) {
    assertScoped(table);
    const tenantPredicate = eq(tenantColumn(table), this.tenantId);
    return {
      where: (extra?: SQL | undefined) =>
        this.inContextBuilder((h) => h.delete(table as PgTable).where(and(tenantPredicate, extra))),
    };
  }

  /**
   * Run `work` under this handle's tenant context: directly when the handle's transaction already
   * carries it, after setting it when the handle is a transaction someone else opened, and otherwise
   * in a new short transaction that sets it first.
   */
  private async inContext<R>(work: (h: Db) => Promise<R>): Promise<R> {
    if (CONTEXT_SET.has(this)) return work(this.raw);
    if (is(this.raw, PgTransaction)) {
      await setContext(this.raw, this.tenantId);
      return work(this.raw);
    }
    return this.raw.transaction(async (tx) => {
      const h = tx as unknown as Db;
      await setContext(h, this.tenantId);
      return work(h);
    });
  }

  /**
   * A query builder that runs under the tenant context. On a handle whose transaction already carries
   * the context it is the plain Drizzle builder. Otherwise the returned value records the builder
   * chain the caller adds (`.where()`, `.limit()`, `.returning()`, …) and, when it is awaited or
   * executed, replays that chain on the handle `inContext` provides and runs it there. It is typed as
   * the builder `build` returns, so a call site cannot tell the two apart.
   */
  private inContextBuilder<B>(build: (h: Db) => B): B {
    if (CONTEXT_SET.has(this)) return build(this.raw);
    const run = (calls: readonly RecordedCall[]): Promise<unknown> =>
      this.inContext(async (h) => (await replay(build(h), calls)) as unknown);
    const record = (calls: readonly RecordedCall[]): unknown =>
      new Proxy(Object.create(null) as object, {
        get: (_target, member) => {
          if (member === 'then') {
            return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              run(calls).then(onFulfilled, onRejected);
          }
          if (member === 'catch') {
            return (onRejected?: (e: unknown) => unknown) => run(calls).catch(onRejected);
          }
          if (member === 'finally') {
            return (onFinally?: () => void) => run(calls).finally(onFinally);
          }
          if (member === 'execute') return () => run(calls);
          if (DESCRIBE_ONLY.has(member)) {
            const described = replay(build(this.raw), calls) as Record<string | symbol, unknown>;
            const value = described[member];
            return typeof value === 'function' ? value.bind(described) : value;
          }
          if (typeof member === 'symbol') return undefined;
          return (...args: unknown[]) => record([...calls, { member, args }]);
        },
      });
    return record([]) as B;
  }

  /**
   * Run `fn` inside a transaction that populates the `app.current_tenant` setting first, so every
   * statement of `fn` runs under the tenant context the row-level policies read. The callback
   * receives a TenantDb bound to the SAME tenant over the transactional handle.
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
      CONTEXT_SET.add(txTenant);
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
   *
   * Under row-level security the read sees only this tenant's rows, so a row it does not see is asked
   * about once more through `rayspec_run_owned_elsewhere`, which the platform chain creates beside
   * `runs`: it answers whether the id is taken by another tenant, and nothing else. A schema without
   * the function (a hand-built test schema) keeps the plain read's answer.
   */
  async runHeaderOwnership(runId: string): Promise<'absent' | 'owned' | 'foreign'> {
    return this.inContext(async (h) => {
      const rows = await h
        .select({ tenantId: runs.tenantId })
        .from(runs)
        .where(eq(runs.runId, runId))
        .limit(1);
      const owner = rows[0]?.tenantId;
      if (owner !== undefined) return owner === this.tenantId ? 'owned' : 'foreign';
      const schema = await platformFunctionSchema(h, 'runs', 'rayspec_run_owned_elsewhere(text)');
      if (schema === undefined) return 'absent';
      const elsewhere = (await h.execute(
        sql`select ${sql.identifier(schema)}.rayspec_run_owned_elsewhere(${runId}) as taken`,
      )) as unknown as { taken: boolean }[];
      return elsewhere[0]?.taken === true ? 'foreign' : 'absent';
    });
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
   * outer transaction by design; the append then commits in its own short transaction under the
   * tenant context). Returns the allocated seq range, or undefined for an empty batch.
   */
  async appendEvents(
    events: readonly TenantEventInput[],
  ): Promise<TenantEventAppendResult | undefined> {
    if (events.length === 0) return undefined;
    return this.inContext((h) => appendTenantEvents(h, this.tenantId, events));
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
    return this.inContext((h) => readTenantEventPage(h, this.tenantId, opts));
  }

  /**
   * Delete THIS tenant's events older than `cutoff` and raise its truncation floor, in one statement
   * (see `sweepTenantEvents`). The scheduled cleanup calls it once per tenant, so the retention sweep
   * runs under each tenant's context like every other statement.
   */
  async sweepEvents(cutoff: Date): Promise<TenantEventSweepResult> {
    return this.inContext((h) => sweepTenantEvents(h, { cutoff, tenantId: this.tenantId }));
  }

  /**
   * The ONE sanctioned escape hatch: the raw Drizzle handle for GLOBAL/auth tables that are
   * deliberately NOT tenant-scoped (orgs, users, sessions, api_keys, memberships, auth_audit,
   * the OIDC model store). Loud + greppable on purpose; the CI gate forbids `.unscoped()`
   * outside whitelisted global-table modules. A statement run on it carries no tenant context of
   * its own, so under row-level security it reaches a tenant table only inside a transaction that
   * set one.
   */
  unscoped(): Db {
    return this.raw;
  }
}

/**
 * The schema holding `table` (as the unqualified name resolves on this connection) when that schema
 * also holds the platform chain's function `fn` (`name(argtypes)`), else undefined. The function is
 * asked only about the table it reads: the one in its own schema. A schema without the function (a
 * hand-built test schema) keeps the plain read's answer.
 */
async function platformFunctionSchema(h: Db, table: string, fn: string): Promise<string | undefined> {
  // MATERIALIZED: the function lookup must run for the table's own schema only. Folded into one scan
  // the planner may evaluate it for other schemas first, and a role without USAGE on one of those
  // (`pg_toast`) would fail the statement.
  const rows = (await h.execute(sql`
    with resolved as materialized (
      select n.nspname::text as schema
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.oid = to_regclass(${table})
    )
    select schema from resolved
     where to_regprocedure(format('%I.%s', schema, ${fn}::text)) is not null
  `)) as unknown as { schema: string }[];
  return rows[0]?.schema;
}

/**
 * The tenant of the invite whose token hashes to `tokenHash`, or undefined — the ONE read that must
 * find an invite before any tenant is known (the redeemer holds only the token). A plain read answers
 * it where row security does not apply; under row security that read sees nothing without a tenant,
 * and `rayspec_invite_tenant` (created by the platform chain beside `invites`) answers it: it returns the tenant id and nothing else,
 * for a hash only the holder of a live token and the pepper can compute. The caller then reads the
 * invite itself through `forTenant` under that tenant.
 */
export async function inviteTenantByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<string | undefined> {
  const rows = (await db.execute(
    sql`select tenant_id::text as tenant from invites where token_hash = ${tokenHash} limit 1`,
  )) as unknown as { tenant: string }[];
  if (rows[0] !== undefined) return rows[0].tenant;
  const schema = await platformFunctionSchema(db, 'invites', 'rayspec_invite_tenant(text)');
  if (schema === undefined) return undefined;
  const resolved = (await db.execute(
    sql`select ${sql.identifier(schema)}.rayspec_invite_tenant(${tokenHash})::text as tenant`,
  )) as unknown as { tenant: string | null }[];
  return resolved[0]?.tenant ?? undefined;
}

/** Bind the raw Drizzle handle to one tenant. The ONLY way request/run-core code gets a Db. */
export function forTenant(rawDb: Db, tenantId: string): TenantDb {
  return new TenantDb(rawDb, tenantId);
}
