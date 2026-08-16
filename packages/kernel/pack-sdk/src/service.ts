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
import type { PackJournalStatus, PackJournalStepType } from './journal.js';

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
  /** Run one parameterized statement and read its rows back. */
  query(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
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
 * What a service's `boot` receives.
 *
 * `journal` and `dispatch` are OPTIONAL, and their absence is a real answer rather than an oversight:
 * a deployment that bound no tenant has no journal writer to give, and one that wired no durable
 * worker has no dispatch capability. An ABSENT key is what makes a service that needs one fail-closed
 * loudly on `undefined` instead of silently doing nothing.
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
  /** The tenant-bound run-journal writer (absent when the deployment bound no tenant). */
  readonly journal?: PackJournalWriter;
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
