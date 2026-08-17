/**
 * The SERVICE half of the contract — the one contribution the platform BOOTS rather than calls.
 *
 * Every other kind a pack contributes is REACTIVE: a route is served, a tool is invoked, a trigger
 * fires. A pack that has to reconcile state at boot, drain a queue or schedule follow-up work has no
 * such door. A SERVICE is that door: a module the pack declares (`services: [{ module }]` on the
 * manifest), whose default export the platform starts before the deployment serves traffic and stops
 * when it closes.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO GUARANTEES A SERVICE AUTHOR CAN RELY ON.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  1. ORDER. `boot` runs AFTER the platform migration chain, after every pack's own chain, and after
 *     the deployed document has been validated — so the tables exist and the configuration is real —
 *     and BEFORE the deployment's listener accepts traffic, so nothing can observe half-reconciled
 *     state. `shutdown` runs in the exact REVERSE of boot order.
 *  2. FAILURE. A `boot` that throws FAILS the deployment's boot, naming the pack and the service. A
 *     deployment does not come up with a service that could not start.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE THE MODULE LIVES, AND WHY IT MATTERS MORE THAN IT LOOKS.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A service module lives BESIDE the pack's `handlers/` subtree, never inside it. That is not a
 * convention: `handlers/` is the subtree the repository's dispatch-boundary CI gate scans, and a
 * module under it may not so much as name the run surface. A service may — it is the ONE contribution
 * that receives `TurnDispatch`. The exemption is structural, so it cannot be bought by naming a folder
 * `services` inside `handlers/`.
 */
import type { PackJournalReader, PackJournalStatus, PackJournalStepType } from './journal.js';

/** One long-lived service a pack declares on its manifest. */
export interface PackServiceDeclaration {
  /** The pack-relative module whose default export is the service (jailed under the pack root). */
  readonly module: string;
}

/** What a service asks for when it schedules one durable agent turn. */
export interface TurnDispatchRequest {
  /** The declared agent to run — resolved against the deployed registry (undeclared → fail-closed). */
  readonly agentId: string;
  /** The agent's run input (the per-run task value). DATA. */
  readonly input: string;
  /** Optional per-run override of the agent's declared instructions. */
  readonly instructions?: string;
  /** Optional per-run override of the agent's declared maxTurns. */
  readonly maxTurns?: number;
}

/** The scheduled turn's durable identity — the runId the deployment's run-read surfaces resolve. */
export interface TurnDispatchResult {
  /** The durable run id. Poll or stream it through the deployment's existing run surfaces. */
  readonly runId: string;
}

/**
 * The ONE sanctioned way a pack schedules a durable agent turn, and the ONE contribution kind that
 * receives it. A reactive contribution — a route handler, a tool, a trigger — cannot have it: the
 * repository's dispatch-boundary gate fails the build on a module reachable from `handlers/`, or from
 * a tooling contribution, that so much as names this type.
 *
 * TENANCY IS ENFORCED BY THE PLATFORM, NOT BY THE CALLER. There is no `tenantId` anywhere on the
 * request: a service has no request and therefore no caller-derived tenant, so the deployment binds
 * the tenant when it builds the capability and the closure has no path to another one. A turn a
 * service schedules is journaled, read, streamed and cancelled by the surfaces that already exist —
 * this adds no second run path.
 *
 * HONEST LIMIT: a fresh run id is minted per call and no exactly-once key is promised. A service that
 * must reconcile a crash-retry to one run keys that in its own table.
 */
export interface TurnDispatch {
  /** Schedule ONE durable agent turn for the tenant this capability is bound to. */
  schedule(request: TurnDispatchRequest): Promise<TurnDispatchResult>;
}

/**
 * The DATABASE door — the parameterized query executor a service reaches the platform tables its own
 * pack owns through.
 *
 * WHY A QUERY EXECUTOR AND NOT A GENERATED STORE HANDLE: what a service maintains is the state its
 * pack's own MIGRATION CHAIN created — an append-only ledger, hand-shaped indexes, a foreign key onto
 * a platform table — and none of that is a generated business store, so no generated handle addresses
 * it. The posture is the pack's existing one rather than a wider one: a pack already ships arbitrary
 * DDL for exactly these tables, and it runs in the deployment's process as a trusted, non-sandboxed
 * author. Always pass values as `params` — a name or a value interpolated into `sql` is an injection
 * seam, and the identifier rule (`isSafeIdentifier`) is what a derived name must clear first.
 */
export interface PackDatabase {
  /**
   * Run one parameterized statement and read its rows back.
   *
   * A TRANSACTION-CONTROL STATEMENT IS REFUSED HERE — `BEGIN`, `START TRANSACTION`, `COMMIT`,
   * `ROLLBACK`, `SAVEPOINT` and the rest reject with an `Error` whose `name` is
   * `PackTransactionError`, before the statement reaches the server. This handle is POOLED, so such a
   * statement cannot do what it looks like it does: the connection it lands on goes back to the pool
   * still inside a transaction nothing ever commits, and every later write that happens to be issued
   * on it is invisible to every other connection while its locks are held indefinitely. Use
   * `transaction(fn)` below.
   */
  query(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /**
   * Run `fn` inside ONE transaction, on a connection PINNED for the callback's whole duration. `tx` is
   * a `PackDatabase` again — the same parameterized `query` — so a statement reads the same inside a
   * transaction as outside one: nothing new to learn, nothing extra to import.
   *
   * WHY THE METHOD HAS TO EXIST. `query` runs on a POOLED handle, where two calls are not promised the
   * same connection: a bare `BEGIN` through it cannot open a transaction the next call is in, and a
   * `SELECT … FOR UPDATE` through it holds NOTHING once the call returns — correct for a pool, and
   * fatal for a read-decide-write whose correctness rests on the row not moving. Inside `fn` the
   * connection is one and the same, so a lock taken there is held until the callback returns, and two
   * writes land together or not at all.
   *
   * A CALLBACK THAT THROWS ROLLS BACK, and the error propagates UNCHANGED — the same value the
   * callback threw, so a pack's own error class and message reach its own catch intact. What the
   * callback RETURNS is what this resolves with, WITH ONE EXCEPTION, and it is the one worth reading
   * twice: ⚠ A STATEMENT THAT FAILS INSIDE `fn` ABORTS THE WHOLE CALL, EVEN IF YOU CAUGHT IT. The
   * driver latches the first statement error raised on the pinned connection and re-raises it once the
   * callback resolves, so a `tx.query(…)` wrapped in a `try`/`catch` the pack treats as handled,
   * followed by a normal return, still REJECTS with that statement's error and rolls back. Rolling
   * back to your own `SAVEPOINT` does not undo the latch either — which is why `tx.query` refuses
   * `SAVEPOINT` outright rather than letting a pack believe it recovered. Read-decide-write: do the
   * READ that tells you whether the write is safe (`SELECT … FOR UPDATE`, an existence check), rather
   * than writing speculatively and catching the constraint violation.
   *
   * NESTING IS REFUSED, not left to the driver, and the refusal covers BOTH ways to reach for a second
   * transaction. `tx.transaction(…)` rejects with a typed refusal (an `Error` whose `name` is
   * `PackTransactionError`); so does calling `transaction` again on the SAME `ctx.db` from inside the
   * callback — the ordinary factoring once a helper takes a `PackDatabase` — and both, like any other
   * failure inside a callback, roll the transaction they were attempted in back. Neither could be what
   * it looks like: through `tx` it could only be a SAVEPOINT, a different guarantee wearing the same
   * name (rolling one back leaves the OUTER transaction alive and committing, so a pack that believed
   * it had opened a transaction would watch its "rollback" commit); through `ctx.db` it would be a
   * genuinely INDEPENDENT transaction on a second pooled connection, which commits even when the outer
   * one rolls back, and blocks until the pool runs out on any row the outer one holds. A transaction
   * opened from an UNRELATED context — a timer the service armed, another request in flight — is not
   * nesting and is unaffected. The refusal lasts exactly as long as `fn` does, so that holds for a
   * context `fn` ITSELF started and left running — arming the periodic sweep in the same transaction
   * that writes the row it will sweep — from the moment the callback settles onwards.
   *
   * ⚠ A TRANSACTION IS A RESOURCE DECISION, NOT A FREE CONVENIENCE. The pinned connection is reserved
   * out of the pool the deployment SERVES REQUESTS ON — the HTTP/API pool, four connections by default
   * — and not out of the durable worker's, which is a pool of its own. Two concurrent pack transactions
   * therefore hold half of it, and it is not returned until `fn` returns: a callback that awaits a
   * model call, an HTTP round trip or a timer holds its share for exactly that long, and enough of
   * those starve the deployment's own `/health` and `/events`. Keep what is inside `fn` to database
   * work and do the slow part before or after it.
   *
   * NO WIDER THAN `query`. `tx` carries exactly the members `query` is reached through and nothing
   * else — no tenant handle, no journal writer, no escape hatch — so opening a transaction reaches no
   * further than a single statement already reaches. What it is NOT is a tenant filter: neither half
   * rewrites the SQL a pack wrote, so what a statement touches is what the pack asked for, and a pack
   * that attributes rows to a tenant gets that value from the deployment (its configuration, its
   * environment) rather than from this door — there is no `tenantId` on a service's context, in a
   * transaction or out of one, exactly as there is none on a `TurnDispatchRequest`.
   */
  transaction<T>(fn: (tx: PackDatabase) => Promise<T>): Promise<T>;
}

/** One step a service records in the run journal. `input` is HASHED by the platform, never stored. */
export interface PackJournalStep {
  /** The run this step belongs to — the service's own correlation id for the unit of work. */
  readonly runId: string;
  /** Which kind of step this is, in the journal's own closed vocabulary. */
  readonly type: PackJournalStepType;
  /** The replay key: identical `(runId, idempotencyKey)` is one step, recorded once. */
  readonly idempotencyKey: string;
  /** The step's input — hashed into the recorded `inputHash`, never stored verbatim. */
  readonly input: unknown;
  /** The step's output as recorded. Opaque data — its shape is the step's own concern. */
  readonly output: unknown;
  /** Whether the step succeeded. A failed step is journaled, never dropped. */
  readonly status: PackJournalStatus;
  /** Wall-clock duration of the step in milliseconds (0 when the service measures none). */
  readonly latencyMs?: number;
}

/**
 * The JOURNAL WRITER — how a service's own work reaches the run journal, which is where every other
 * kind of work in the platform is already recorded (`PackJournalEntry` is what those records read back
 * as). Tenant-bound by construction: there is no `tenantId` field, because the deployment binds it.
 */
export interface PackJournalWriter {
  /** Append ONE journal step for work this service performed. */
  record(step: PackJournalStep): Promise<void>;
}

/**
 * The JOURNAL DOOR a service is handed — BOTH verbs on one handle: append what this service did, and
 * read back what it (and the rest of this tenant's work) was recorded as.
 *
 * THE READ HALF BELONGS HERE, not only on a route. A service is the surface that WRITES journal
 * steps, so it is the surface with something to read back; and the work that needs a recall — what
 * did this pack already do, before deciding what to do next — has no request behind it and nothing it
 * is serving. A read door reachable only from a route would leave the writing surface exactly where
 * it started: naming a core table in a SQL string through the escape hatch, which is the dependency
 * this contract exists to remove. `PackRouteHandlerInit.journal` carries the same reader for the
 * other case, where a read IS being served to a client.
 *
 * TENANT-BOUND BY CONSTRUCTION, in both directions and for the same reason: the deployment binds the
 * tenant when it builds this handle, so neither verb takes a `tenantId` and neither can reach another
 * tenant's rows. That is why this door is tenant-scoped while `PackDatabase` beside it is not — the
 * database door runs the SQL a pack wrote, this one runs the platform's own scoped read.
 *
 * `PackJournalWriter` stays exactly what it was and is still exported: a service that only appends
 * may keep annotating it, and this is the wider handle the context now hands over.
 */
export interface PackJournal extends PackJournalWriter, PackJournalReader {}

/**
 * What a service's `boot` receives.
 *
 * `journal` and `dispatch` are OPTIONAL, and their absence is a real answer rather than an oversight:
 * a deployment that bound no tenant has no journal door to give — neither half of it, because an
 * unattributable write and an unscoped read are equally not what they claim to be — and one that
 * wired no durable worker has no dispatch capability. An ABSENT key is what makes a service that needs
 * one fail-closed loudly on `undefined` instead of silently doing nothing.
 */
export interface PackServiceContext {
  /** The id the deployment's `extensions[]` entry gave this pack — what its own messages name it by. */
  readonly packId: string;
  /** The database door for the platform tables this pack owns. */
  readonly db: PackDatabase;
  /**
   * The deployed document as the deployment validated it — its own sections plus every pack's merged
   * fragments. OPEN by construction: the document grammar is the deployment's, and re-stating it here
   * would make every additive grammar field a breaking change to this package.
   */
  readonly spec: Readonly<Record<string, unknown>>;
  /**
   * The top-level sections THIS pack claims, keyed by key, exactly as this pack's OWN validator
   * returned them — never another pack's, and never a raw node the pack has still to check. A key the
   * deployment's document did not write is absent, so a service reads its own configuration the way it
   * declared it.
   */
  readonly sections: Readonly<Record<string, unknown>>;
  /**
   * The tenant-bound run-journal door — `record` to append, `read` to page back through what was
   * recorded (absent when the deployment bound no tenant, because a row nobody can attribute is not a
   * record and a read with no tenant to scope to is not a read).
   */
  readonly journal?: PackJournal;
  /** The deployment's environment, read-only. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The one sanctioned way to schedule a durable agent turn (absent when no durable worker is wired). */
  readonly dispatch?: TurnDispatch;
}

/**
 * What a service MODULE default-exports — the shape the platform starts and stops.
 *
 *     const service: PackServiceModule = {
 *       name: 'audit-ledger',
 *       async boot(ctx) { … },
 *       async shutdown() { … },
 *     };
 *     export default service;
 *
 * Both members may be synchronous: a service whose whole job is to arm a timer has nothing to await.
 */
export interface PackServiceModule {
  /** This service's own name — used in the deployment's boot log and in every message that names it. */
  readonly name: string;
  /** Start the service. Throwing FAILS the deployment's boot, naming this pack and this service. */
  boot(ctx: PackServiceContext): Promise<void> | void;
  /** Stop the service. Called in the exact REVERSE of boot order when the deployment closes. */
  shutdown(): Promise<void> | void;
}
