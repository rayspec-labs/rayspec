/**
 * `DbosDurableExecutor` — the DBOS implementation of the neutral `DurableExecutor`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE PACKAGE THAT KNOWS ABOUT DBOS.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `@rayspec/platform` / `run-core` / the four SDK adapters carry NO `@dbos-inc/dbos-sdk` import —
 * the engine asymmetry is absorbed HERE. This adapter runs the EXISTING `runAgent`
 * off-request, UNCHANGED, inside one DBOS workflow whose single durable step calls it on a
 * tenant-bound `forTenant(db, tenantId)` handle. It adds NO new persistence/streaming layer: events
 * still persist to `run_events` via run-core's pipeline; the client resumes via the shipped
 * `GET /v1/runs/{id}/events?lastEventId=`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NO TRANSACTION ACROSS THE MODEL CALL.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A run's statements commit as they are made, exactly as on the in-request path, so a run waiting on
 * a slow provider holds no database connection: the worker pool's size bounds statements, not runs.
 * What the one long transaction used to provide is provided explicitly instead:
 *  - ONE EXECUTION AT A TIME. The started-once marker carries a LEASE (an execution id and an expiry
 *    the executing worker renews). A second dispatch of the same run — a recovery re-dispatch while the
 *    first is still alive — waits for the lease to lapse instead of executing alongside it, and an
 *    execution that finds its lease taken over stops its own run.
 *  - A CLEAN RE-RUN. A crashed attempt's rows (events, journal, transcript) used to vanish with the
 *    rollback; a re-run of an untainted run now removes them before it starts, so the re-run's record
 *    is its own. Tool writes are NOT undone: a tool's effects commit as they happen, as they always did
 *    on the in-request path — which is why a re-run is only ever automatic for an untainted run.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DURABILITY CONTRACT — WHOLE-RUN RE-EXECUTION, HONEST.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DBOS recovers an interrupted workflow by RE-INVOKING the workflow body from the start, replaying
 * only COMPLETED steps from their memoized return values (verified doc-first against the installed
 * 4.21.6: `workflow-tutorial` "resumes the workflow from the last completed step" + steps are "never
 * re-executed after they complete"). Our workflow has ONE big step (the whole `runAgent`), so a
 * crash MID-`runAgent` leaves that step INCOMPLETE → on recovery it would RE-RUN `runAgent` from
 * scratch (the model is re-called; the journal only short-circuits an ALREADY-completed run). There
 * is NO intra-run step-resume.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SAFETY INVARIANT — a crashed run that already fired a side effect is NEVER silently re-fired.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Whole-run re-execution + a non-idempotent (`idempotent:false`) tool = a re-fired side effect
 * (`send_email`/`charge_card` runs twice — a kill-class hazard). Two layers enforce the invariant:
 *
 *  1. `maxRecoveryAttempts: 1` on the workflow — caps DBOS's own crash-recovery so a workflow that
 *     keeps crashing terminates at `MAX_RECOVERY_ATTEMPTS_EXCEEDED` (a terminal dead-letter status,
 *     NOT looped forever; verified in the installed `system_database.js:495-502`). NOTE the exact
 *     semantics: the flip happens only when `recovery_attempts > maxRecoveryAttempts + 1`, so `1`
 *     ALONE would still permit ONE silent recovery re-run before terminating, and `0` is falsy →
 *     defaults to 100 (the executor maps `wConfig.maxRecoveryAttempts ? … : DEFAULT_MAX(100)`). So
 *     layer 1 alone is INSUFFICIENT for the invariant — hence layer 2.
 *  2. A "started-once" guard backed by OUR OWN `idempotency_keys` (the correctness boundary —
 *     DBOS memoizes step OUTPUTS, not our in-step Drizzle writes, so OUR dedup is authoritative for
 *     non-idempotent effects). After resolving the run (a resolve failure must not poison the
 *     runId) and BEFORE running `runAgent`, atomically RESERVE `(tenant, scope='run_started',
 *     key=runId)`: the FIRST execution wins → it runs `runAgent`. A recovery RE-execution LOSES the
 *     reserve (the marker was committed by the first attempt before the crash) and is then resolved
 *     by the TAINT-aware quarantine decision: a run that already fired a non-idempotent tool (its
 *     `run_taint` marker survived the crash) is QUARANTINED terminal via `DurableRunNotRetriedError`
 *     and `runAgent` is NOT re-run, while an untainted (idempotent / no-tool) run is SAFELY re-run
 *     (the safe-class automated retry). This holds regardless of `maxRecoveryAttempts` and is the
 *     REAL guarantee.
 *
 * The honest consequence for a QUARANTINED async run started under an Idempotency-Key: that runId is
 * now permanently un-retryable under the SAME key (the run-surface reservation + the marker both
 * persist), so a same-key retry replays the terminal failure rather than re-running.
 */

import { randomUUID } from 'node:crypto';
import { DBOS, StatusString } from '@dbos-inc/dbos-sdk';
import {
  type AgentSpec,
  type Backend,
  type NeutralTool,
  REDACTED,
  redactText,
  redactValue,
} from '@rayspec/core';
import type { Db } from '@rayspec/db';
import { forTenant, schema, type TenantDb } from '@rayspec/db';
import type {
  DurableExecutor,
  DurableExecutorIdentity,
  DurableJobStatus,
  DurableRunAuthorizer,
  EnqueueResult,
  RunJob,
} from '@rayspec/platform';
import {
  isRunCancelled,
  isRunTainted,
  isTerminalRunStatus,
  markRunCancelled,
  RunAdmissionRefusedError,
  recordRunCancelled,
  runAgent,
} from '@rayspec/platform';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { PausableQueue } from './pausable-queue.js';

/**
 * The neutral run-resolution the executor needs to turn a `RunJob` back into a runnable run — the
 * SAME shape the sync run surface resolves (an `AgentRegistryEntry`): the base spec, the backend,
 * and EITHER a per-run tenant-bound `toolFactory` (declared agents — its `HandlerDb` closes over the
 * run's TenantDb) OR a static `tools` list. The worker builds the tools from the SAME tenant-bound
 * handle it runs `runAgent` on.
 */
export interface ResolvedRun {
  readonly backend: Backend;
  /** The BASE neutral spec (instructions/model/outputSchema/maxTurns) — `input` is the job's. */
  readonly spec: AgentSpec;
  /** Static neutral tools. Prefer `toolFactory` when both are present. */
  readonly tools?: NeutralTool[];
  /**
   * Build this run's tenant-bound tools from a `TenantDb` (a declared agent's per-run factory — the
   * SAME `entry.toolFactory` the sync path calls). The worker calls it with the run's tenant-bound
   * TenantDb. Optional (no-tool agent).
   */
  readonly toolFactory?: (tdb: TenantDb) => NeutralTool[];
  /**
   * The deployment's declared product tables (store name → runtime `PgTable`). Threaded into `runAgent`
   * so a job carrying `persistTo` can resolve the target store and write the run's validated output
   * (reusing the store-facade insert path). A no-store deployment / a job without `persistTo` leaves it
   * inert. Deployment-constant (the resolver captures it), like `backend`.
   */
  readonly productTables?: ReadonlyMap<string, PgTable>;
}

/** What `DbosDurableExecutor` is constructed with: a raw Db + the agent resolver the worker fires. */
export interface DbosExecutorDeps {
  /**
   * The raw Db handle (the composition root's single makeDb). The worker binds `forTenant(db,
   * tenantId)` per job — NEVER a cross-tenant handle. This is the composition root, not a scoped
   * request path, so holding the raw `Db` here is sanctioned (the same posture as the stores).
   */
  readonly db: Db;
  /**
   * Resolve a `RunJob`'s `agentId` → `{ backend, spec, toolFactory|tools }` using the SAME resolution
   * the sync run path uses (the DeclarativeEngine / agent registry). Called at FIRE time (so a
   * serialized job carries no live object graph, and the agent definition is read live, like every
   * run). Throws if the agent id is unknown (fail-closed — the worker surfaces the run as failed).
   */
  readonly resolveRun: (job: RunJob) => ResolvedRun;
  /**
   * Re-check, when the job is about to execute, that the identity it was enqueued for may still run
   * an agent in its tenant. A denial ends the run before anything runs: it is marked like a
   * cancellation (so no recovery re-dispatch runs it either) and recorded terminal with
   * {@link runNotAuthorizedMessage}. A throw fails the job without running it. Absent ⇒ no re-check,
   * as before this option existed.
   */
  readonly authorizeRun?: DurableRunAuthorizer;
}

/**
 * What a run ended by the execution-time authorization re-check reports. It names no identity: the
 * run's reader may not be the member who asked for it.
 */
export function runNotAuthorizedMessage(runId: string): string {
  return (
    `run ${runId} was not started: the member or API key that requested it may no longer run ` +
    'agents in this organization.'
  );
}

/** The DBOS config the executor needs (the composition root derives `systemDatabaseUrl` from env). */
export interface DbosExecutorConfig {
  /** The DBOS application name (namespaces the workflow registry). */
  readonly name: string;
  /**
   * The DBOS SYSTEM database url — SEPARATE from the app DB (DBOS auto-creates it; it does NOT touch
   * our `public`/app schema, so `gate:migrate-clean` is unaffected). Derived from DATABASE_URL by
   * swapping the db name (the composition root does this) or set via DBOS_SYSTEM_DATABASE_URL.
   */
  readonly systemDatabaseUrl: string;
  /**
   * The DBOS APPLICATION VERSION this worker runs as — the ONLY discriminator DBOS's dequeue is
   * scoped by (`application_version IS NULL OR application_version = $3` in
   * `findAndMarkStartableWorkflows`; the other column it could have used, `executor_id`, is not a
   * discriminator here because nothing in this repo sets `DBOSConfig.executorID` and DBOS then
   * defaults it to the same constant in every process).
   * Supply it to fence a deployment to the work its OWN document enqueued: two processes sharing one
   * DATABASE_URL, and therefore one DBOS system database and one set of queue names, otherwise
   * dequeue each other's jobs.
   *
   * OPTIONAL, and the omission is meaningful: with no value DBOS computes its own version (an md5
   * over the source of the workflow functions registered in the process plus the SDK version). Every
   * caller that has no document to name keeps that computed hash. The composition roots derive
   * theirs from the deployed document's identity (`deriveDbosApplicationVersion` in @rayspec/server).
   * Supplying it means the SDK version and the wrapper source no longer participate in the value;
   * what pins those instead is the exact `@dbos-inc/dbos-sdk` version in this package's package.json
   * plus the compile-time key assertions in `wire-shape-assertions.ts`.
   */
  readonly applicationVersion?: string;
  /**
   * The queue's worker concurrency cap (the concurrency-semaphore discipline; a conservative
   * default). Bounds how many `runAgentJob`s this worker runs at once.
   */
  readonly workerConcurrency?: number;
  /**
   * Queue admission: how many agent runs may be queued or executing at once, in total and per tenant,
   * before `enqueue` refuses a new one with `RunAdmissionRefusedError`. Counted over the engine's own
   * queue, so it covers every process that shares the system database. Absent bound ⇒ not checked.
   */
  readonly admission?: { readonly queueMax?: number; readonly queueMaxPerTenant?: number };
  /**
   * How long an execution's lease on its run lasts without renewal, in milliseconds (default
   * {@link DEFAULT_RUN_LEASE_TTL_MS}). The executing worker renews it every third of this. A second
   * dispatch of the same run waits until the lease lapses.
   */
  readonly runLeaseTtlMs?: number;
  /** Silence DBOS's own console logging in tests (a DLogger-shaped sink). Optional. */
  readonly logger?: ConstructorLoggerOption;
  /**
   * TEST-ONLY: `shutdown()` passes `{ deregister: true }` to `DBOS.shutdown` so the GLOBAL DBOS
   * workflow/queue registry is cleared, letting a FRESH executor re-register `runAgentJob` in the same
   * process. DBOS is a process-global singleton, so a production deployment has exactly ONE executor for
   * the process lifetime and NEVER sets this (the default, undefined, leaves the registry intact across
   * a normal shutdown). Only the multi-executor reliability test harness sets it. NOT a production path.
   */
  readonly deregisterOnShutdown?: boolean;
}

/**
 * The narrow shape DBOS's `DBOSConfig.logger` accepts (a DLogger). We only ever pass a no-op test
 * logger; typing it loosely here avoids importing DBOS's internal `DLogger` into our config surface.
 */
type ConstructorLoggerOption = NonNullable<Parameters<typeof DBOS.setConfig>[0]['logger']>;

/** The DBOS queue name the off-request agent runs are enqueued onto (the single agent-run queue). */
export const AGENT_RUNS_QUEUE = 'agent-runs';

/** The default per-worker concurrency for `agent-runs`. */
export const DEFAULT_WORKER_CONCURRENCY = 4;

/** The `idempotency_keys` scope for the per-run "started-once" safety marker (the started-once guard). */
export const RUN_STARTED_SCOPE = 'run_started';

/** How long an execution's lease on its run lasts without renewal, by default. */
export const DEFAULT_RUN_LEASE_TTL_MS = 30_000;

/**
 * The advisory-lock key admission takes on the application database, so that counting the queue and
 * enqueueing are one step for every process: the ASCII of `rays` (the namespace the schema lock uses)
 * and a slot of its own.
 */
export const ADMISSION_LOCK_NAMESPACE = 0x72617973;
export const ADMISSION_LOCK_SLOT = 3;

/** The started-once marker's snapshot: whose execution holds the run, and until when. */
interface RunLease {
  runId: string;
  executionId?: string;
  /** Epoch milliseconds. */
  leaseUntil?: number;
}

/** Reserve the started-once marker for a FIRST execution, with its lease. True ⇔ this call won. */
async function reserveRunLease(
  tdb: TenantDb,
  runId: string,
  executionId: string,
  ttlMs: number,
): Promise<boolean> {
  const lease: RunLease = { runId, executionId, leaseUntil: Date.now() + ttlMs };
  const reserved = await tdb
    .insert(schema.idempotencyKeys, {
      scope: RUN_STARTED_SCOPE,
      idemKey: runId,
      bodyHash: RUN_STARTED_BODY_HASH,
      snapshot: lease,
    })
    .onConflictDoNothing()
    .returning();
  return reserved.length > 0;
}

/** Read the current lease on a run (undefined when the marker is absent). */
async function readRunLease(tdb: TenantDb, runId: string): Promise<RunLease | undefined> {
  const rows = (await tdb
    .select(schema.idempotencyKeys, { snapshot: schema.idempotencyKeys.snapshot })
    .where(
      and(
        eq(schema.idempotencyKeys.scope, RUN_STARTED_SCOPE),
        eq(schema.idempotencyKeys.idemKey, runId),
      ),
    )
    .limit(1)) as Array<{ snapshot: unknown }>;
  const snap = rows[0]?.snapshot as RunLease | null | undefined;
  return snap ?? undefined;
}

/**
 * Move the lease to `executionId`, but only from the holder this caller saw (`from`; undefined = a
 * marker written before leases existed). A compare-and-set: of two executions taking over at once,
 * exactly one moves it. True ⇔ this call moved it.
 */
async function moveRunLease(
  tdb: TenantDb,
  runId: string,
  from: string | undefined,
  executionId: string,
  ttlMs: number,
): Promise<boolean> {
  const lease: RunLease = { runId, executionId, leaseUntil: Date.now() + ttlMs };
  const holder = sql`${schema.idempotencyKeys.snapshot}->>'executionId'`;
  const moved = await tdb
    .update(schema.idempotencyKeys, { snapshot: lease })
    .where(
      and(
        eq(schema.idempotencyKeys.scope, RUN_STARTED_SCOPE),
        eq(schema.idempotencyKeys.idemKey, runId),
        from === undefined ? isNull(holder) : eq(holder, from),
      ),
    )
    .returning({ idemKey: schema.idempotencyKeys.idemKey });
  return moved.length > 0;
}

/** Give up this execution's lease (it ended): the lease then reads as lapsed. */
async function releaseRunLease(tdb: TenantDb, runId: string, executionId: string): Promise<void> {
  await moveRunLease(tdb, runId, executionId, executionId, 0);
}

/**
 * Renew this execution's lease on an interval while its run executes. When a renewal finds the lease
 * held by another execution (it lapsed — this worker could not reach the database for a whole lease —
 * and a recovery took the run over), `onLost` runs once: two executions of one run must not continue
 * side by side. A failed renewal is retried on the next tick; the lease only lapses if they all fail.
 */
function startLeaseRenewal(
  tdb: TenantDb,
  runId: string,
  executionId: string,
  ttlMs: number,
  onLost: () => void,
): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    timer = setTimeout(() => void tick(), Math.max(1, Math.floor(ttlMs / 3)));
    timer.unref?.();
  };
  const tick = async (): Promise<void> => {
    let held: boolean | undefined;
    try {
      held = await moveRunLease(tdb, runId, executionId, executionId, ttlMs);
    } catch {
      held = undefined; // no answer: ask again next tick
    }
    if (!live) return;
    if (held === false) {
      live = false;
      onLost();
      return;
    }
    schedule();
  };
  schedule();
  return () => {
    live = false;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * Remove what an interrupted attempt of an UNTAINTED run left behind — its events, journal steps and
 * transcript — so the re-run's record is its own. The tables are the ones run-core writes per run; the
 * markers (`idempotency_keys`) and the run header are kept, the header being moved by the re-run.
 */
async function clearInterruptedAttempt(tdb: TenantDb, runId: string): Promise<void> {
  await tdb.delete(schema.runEvents).where(eq(schema.runEvents.runId, runId));
  await tdb.delete(schema.journalSteps).where(eq(schema.journalSteps.runId, runId));
  await tdb.delete(schema.conversationItems).where(eq(schema.conversationItems.runId, runId));
}

/** How deep a chain of `cause`s is followed when a thrown error is redacted. */
const REDACT_CAUSE_DEPTH = 5;

/**
 * Pass a thrown value through the redaction path before it leaves the step: an error keeps its class
 * (callers match on it) and has its message, stack and own properties redacted, its `cause` chain
 * too. An error whose fields cannot be written is replaced by a plain error carrying the redacted
 * message.
 */
export function redactThrown(thrown: unknown, depth = 0): unknown {
  if (!(thrown instanceof Error)) return redactValue(thrown);
  try {
    thrown.message = redactText(thrown.message);
    if (typeof thrown.stack === 'string') thrown.stack = redactText(thrown.stack);
    const fields = thrown as unknown as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (key !== 'cause') fields[key] = redactValue(fields[key]);
    }
    if (thrown.cause !== undefined) {
      thrown.cause = depth < REDACT_CAUSE_DEPTH ? redactThrown(thrown.cause, depth + 1) : REDACTED;
    }
    return thrown;
  } catch {
    return new Error(redactText(String(thrown.message)));
  }
}

/** The step body, with whatever it throws passed through {@link redactThrown}. */
function redactingThrows(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await body();
    } catch (err) {
      throw redactThrown(err);
    }
  };
}

/**
 * The `body_hash` sentinel for a `run_started` marker row. The marker's identity is its
 * (tenant, scope, idemKey=runId) UNIQUE key — the body_hash is unused for it (it is NOT an
 * idempotency-key body, just a non-null sentinel for the NOT-NULL column), so we use a stable
 * constant rather than echoing the runId (which read as if the run input were hashed there).
 */
export const RUN_STARTED_BODY_HASH = 'run_started_marker';

/**
 * Thrown by the workflow when a recovery RE-execution of an already-started, TAINTED run is detected
 * and we refuse to re-run `runAgent` (the safety invariant: never silently re-fire a side effect).
 * The workflow ends terminally with this error rather than re-executing the model/tools. An untainted
 * run is instead safely re-run (the safe-class automated retry).
 */
export class DurableRunNotRetriedError extends Error {
  constructor(runId: string) {
    super(
      `durable run '${runId}' was interrupted after it already started, is TAINTED, and is NOT ` +
        'auto-retried (a crashed tainted run is made terminal, never silently re-executed — a ' +
        'whole-run re-run would re-fire non-idempotent tools).',
    );
    this.name = 'DurableRunNotRetriedError';
  }
}

/**
 * Map DBOS's own `WorkflowStatusString` → the neutral `DurableJobStatus` (the asymmetry stays HERE).
 * `unknown` is the fail-safe for an unmapped/absent status — a status read must never throw.
 */
function toNeutralStatus(dbosStatus: string | null | undefined): DurableJobStatus {
  switch (dbosStatus) {
    case StatusString.ENQUEUED:
    case StatusString.DELAYED:
      return 'enqueued';
    case StatusString.PENDING:
      return 'running';
    case StatusString.SUCCESS:
      return 'succeeded';
    case StatusString.ERROR:
    case StatusString.MAX_RECOVERY_ATTEMPTS_EXCEEDED:
      return 'failed';
    case StatusString.CANCELLED:
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/**
 * How many times the worker RE-ATTEMPTS the taint READ on a transient DB error before giving up (fix
 * C). The read decides quarantine-vs-retry for an already-started run; a momentary DB blip must not
 * permanently dead-letter a SAFE (untainted) run, so we absorb a brief outage with a few short-backoff
 * retries. If the read STILL fails, the original DB error propagates (terminal-failed, diagnosable —
 * never a silent re-run on an uncertain taint).
 */
export const TAINT_READ_MAX_ATTEMPTS = 4;
/** Base backoff (ms) between taint-read attempts; doubles per attempt (50, 100, 200). */
export const TAINT_READ_BACKOFF_MS = 50;

/**
 * Read the run's taint status, RETRYING a transient DB read error a bounded number of times (fix C).
 * Returns the boolean on a SUCCESSFUL read (true ⇒ quarantine, false ⇒ safe re-run). RETHROWS the
 * ORIGINAL DB error if every attempt fails — the caller then surfaces it as the terminal step error
 * (the run is NOT re-executed off an unresolved taint read; the safety direction is preserved because
 * an uncertain read NEVER falls through to re-run). This makes the READ retryable in place, which is
 * the correct seam: the surrounding `runAgent` step is `retriesAllowed:false`, so a thrown step error
 * is memoized as terminal and would NOT be re-attempted on recovery — retrying here, not the run, is
 * what lets a momentary blip resolve without dead-lettering a safe run.
 */
export async function readTaintWithBoundedRetry(tdb: TenantDb, runId: string): Promise<boolean> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TAINT_READ_MAX_ATTEMPTS; attempt++) {
    try {
      return await isRunTainted(tdb, runId);
    } catch (e) {
      lastErr = e;
      if (attempt < TAINT_READ_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, TAINT_READ_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
  }
  // Every attempt failed: rethrow the ORIGINAL DB error. The caller does NOT proceed to re-run — an
  // uncertain taint must never enable a silent re-fire — but this surfaces a diagnosable transient DB
  // failure rather than a misleading "quarantine", and it does not dead-letter a healthy run as tainted.
  throw lastErr;
}

/**
 * Read whether the run was CANCELLED, retrying a transient DB read error under the SAME bounded-read
 * policy as {@link readTaintWithBoundedRetry} (the `TAINT_READ_*` constants are that shared policy).
 * Returns the boolean on a SUCCESSFUL read (true ⇒ do not execute this run at all).
 *
 * SAFETY DIRECTION — the same one the taint read takes, for the same reason: it RETHROWS the ORIGINAL
 * DB error when every attempt fails, so a run is NEVER dispatched off an unresolved cancellation read.
 * A cancelled run that executed anyway would burn a model call the caller explicitly ended (and, with a
 * non-idempotent tool, fire a side effect); a momentary DB blip surfacing as a diagnosable terminal step
 * error is the cheaper failure. The retries are what keep that blip from dead-lettering a healthy run.
 */
export async function readCancelledWithBoundedRetry(
  tdb: TenantDb,
  runId: string,
): Promise<boolean> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TAINT_READ_MAX_ATTEMPTS; attempt++) {
    try {
      return await isRunCancelled(tdb, runId);
    } catch (e) {
      lastErr = e;
      if (attempt < TAINT_READ_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, TAINT_READ_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Read whether the run's `runs` header is at a TERMINAL status (`completed` or `error`, the
 * `RunResult.status` values run-core and the end records persist): the run has ended and its outcome
 * is recorded, so a recovery or a second dispatch must not run it again (the double-model-bill
 * window). Mirrors `readTaintWithBoundedRetry`: it RETRIES a transient DB read error a bounded number
 * of times (the same `TAINT_READ_*` policy).
 *
 * SAFETY DIRECTION — deliberately OPPOSITE `readTaintWithBoundedRetry`. On a PERSISTENT read failure
 * this returns **false** (it NEVER throws), so the caller FALLS THROUGH to the safe re-run. That is
 * sound because the short-circuit only runs AFTER the taint check has already confirmed the run
 * UNTAINTED — an untainted run is safe to re-run (no non-idempotent side effect fired), so an
 * unreadable header costs at most a possible re-bill. An uncertain TAINT must block a re-run (hence
 * that helper rethrows); an uncertain END must never SKIP a genuinely-needed retry (hence this one
 * falls through).
 */
export async function readRunEndedWithBoundedRetry(tdb: TenantDb, runId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= TAINT_READ_MAX_ATTEMPTS; attempt++) {
    try {
      const rows = (await tdb
        .select(schema.runs, { status: schema.runs.status })
        .where(eq(schema.runs.runId, runId))
        .limit(1)) as Array<{ status: string }>;
      const status = rows[0]?.status;
      return status !== undefined && isTerminalRunStatus(status);
    } catch {
      if (attempt < TAINT_READ_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, TAINT_READ_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
  }
  return false;
}

/**
 * Count the agent runs queued or executing on the engine's queue — all of them, or one tenant's — up to
 * `atMost` (a count that reached the bound is all admission needs to know).
 */
async function countBacklog(atMost: number, tenantId?: string): Promise<number> {
  const rows = await DBOS.listWorkflows({
    queueName: AGENT_RUNS_QUEUE,
    status: [StatusString.ENQUEUED, StatusString.PENDING, StatusString.DELAYED],
    ...(tenantId === undefined ? {} : { attributes: { tenantId } }),
    limit: atMost,
    loadInput: false,
    loadOutput: false,
  });
  return rows.length;
}

export class DbosDurableExecutor implements DurableExecutor {
  readonly #deps: DbosExecutorDeps;
  readonly #config: DbosExecutorConfig;
  #started = false;
  /** Set once `start()` registers it — the registered workflow function used by `startWorkflow`. */
  #runAgentJob?: (job: RunJob) => Promise<void>;
  /**
   * Hooks run AFTER `registerWorkflow` but BEFORE `DBOS.launch()`. DBOS's scheduled-
   * workflow registration (`registerScheduled`) + any other workflow registration MUST happen before
   * launch (the `ScheduledReceiver` lifecycle callback starts the schedule loops at launch). The cron
   * scheduler attaches its `registerScheduledWorkflows()` here so the executor owns the SINGLE
   * `DBOS.launch()` (DBOS is a global singleton — there is exactly one launch) while the scheduler's
   * registration still lands in the correct pre-launch window.
   */
  readonly #preLaunchHooks: Array<() => void> = [];
  /** The agent-run queue, pausable without shutting the engine down (see `pausable-queue.ts`). */
  readonly #queue: PausableQueue;

  constructor(deps: DbosExecutorDeps, config: DbosExecutorConfig) {
    this.#deps = deps;
    this.#config = config;
    this.#queue = new PausableQueue(
      AGENT_RUNS_QUEUE,
      config.workerConcurrency ?? DEFAULT_WORKER_CONCURRENCY,
    );
  }

  /**
   * Stop dequeuing agent runs without shutting DBOS down, so `resumeDispatch` can start them again.
   * Runs already executing continue (`inFlight` counts them); an `enqueue` still records the job,
   * which waits until dispatch resumes. Callable before `start()`: the queue is then registered
   * paused.
   */
  async pauseDispatch(): Promise<void> {
    await this.#queue.pause();
  }

  /** Dequeue agent runs again after `pauseDispatch`. */
  async resumeDispatch(): Promise<void> {
    await this.#queue.resume();
  }

  /** Whether a pause has settled: no dispatch loop can still claim a job it read before it. */
  get dispatchSettled(): boolean {
    return this.#queue.settled;
  }

  /** Whether the engine is launched and not shut down. */
  get running(): boolean {
    return this.#started;
  }

  /** How many agent runs this process is executing right now. */
  get inFlight(): number {
    return this.#queue.inFlight;
  }

  /**
   * Attach a hook to run AFTER `registerWorkflow` but BEFORE `DBOS.launch()` (the register-before-
   * launch window). Used by `DbosCronScheduler` to register its DBOS scheduled-workflows on the single
   * shared launch. MUST be called before `start()` (a no-op throw otherwise — a hook attached after
   * launch could never run pre-launch). Idempotent attachment is the caller's concern (the cron
   * scheduler's own `registerScheduledWorkflows` is itself idempotent).
   */
  attachPreLaunchHook(hook: () => void): void {
    if (this.#started) {
      throw new Error(
        'DbosDurableExecutor.attachPreLaunchHook called after start() — a pre-launch hook must be ' +
          'attached before the engine launches (register-before-launch). Wire the cron scheduler ' +
          'before executor.start().',
      );
    }
    this.#preLaunchHooks.push(hook);
  }

  /**
   * The single durable workflow body. Its ONE durable step runs the whole `runAgent` off-request,
   * inside `forTenant(db, tenantId).transaction()`. The started-once guard (layer 2) runs at the top
   * of the step so a recovery re-execution is detected and refused BEFORE `runAgent` re-fires.
   *
   * Defined as an instance method bound at start() so the resolver/db close over `this` cleanly.
   */
  async #runAgentJobBody(job: RunJob): Promise<void> {
    await DBOS.runStep(
      // What the step throws is stored by the engine in its system database (message and stack), so
      // it leaves through the redaction path like every other record of the run.
      redactingThrows(async () => {
        const tdb = forTenant(this.#deps.db, job.tenantId);

        // ── Cancellation: a run that was ended is never executed, and never RE-executed ────────
        // Read FIRST, before anything else this body does. The engine's own cancellation ends a job
        // it has not dequeued, but it is not the whole guarantee: OUR marker is authoritative for the
        // same reason the started-once guard is (the engine memoizes step OUTPUTS, not our Drizzle
        // writes), and it is what a RECOVERY re-dispatch — which re-invokes this body from the start —
        // consults. A cancelled run completes the step as a NO-OP: its terminal outcome is recorded by
        // the cancel surface, or by run-core for a run that was executing when it was ended.
        if (await readCancelledWithBoundedRetry(tdb, job.runId)) {
          // Record before returning. `recordRunCancelled` is idempotent and guarded on the run not
          // already being terminal, so for the ordinary case this reads the header, sees a terminal
          // status and writes nothing. It earns its place for a run cancelled WHILE EXECUTING whose
          // worker died before it could record anything.
          await recordRunCancelled(tdb, job.runId);
          return;
        }

        // ── Authorization, re-checked now that the job executes ────────────────────────────────
        // The enqueue was authorized when it was made; a member removed, or a key revoked, while the
        // job waited must not have it run on their behalf. A denial is made durable the same way a
        // cancellation is — the marker first, so a recovery re-dispatch refuses it too — and the run
        // is recorded terminal with the reason. A throw from the check propagates: the job fails
        // without running, never runs on an unresolved answer.
        if (this.#deps.authorizeRun && !(await this.#deps.authorizeRun(job))) {
          await markRunCancelled(tdb, job.runId);
          await recordRunCancelled(tdb, job.runId, { message: runNotAuthorizedMessage(job.runId) });
          return;
        }

        // ── Resolve the run FIRST (before the marker) ─────────────────────────────────────────
        // resolveRun reads the agent definition LIVE. It runs BEFORE the started-once reserve on
        // purpose: a transient resolve failure throws here WITHOUT committing the marker, so the
        // workflow re-runs cleanly on the next recovery attempt instead of poisoning the runId. A
        // genuinely-unknown agentId still throws → status 'failed' (fail-closed).
        const resolved = this.#deps.resolveRun(job);

        // ── The started-once guard, with its lease ─────────────────────────────────────────────
        // Atomically reserve the per-run "started" marker AFTER resolveRun but BEFORE runAgent (the
        // marker-before-side-effect ordering the safety invariant depends on), carrying this
        // execution's lease. The marker row is PERMANENT until pruned.
        const ttlMs = this.#config.runLeaseTtlMs ?? DEFAULT_RUN_LEASE_TTL_MS;
        const executionId = randomUUID();
        if (!(await reserveRunLease(tdb, job.runId, executionId, ttlMs))) {
          // The marker exists ⇒ this run was started before: a RECOVERY re-dispatch, or a second
          // dispatch while the first is still executing. Wait for any live execution to end (its
          // lease lapses or the run completes) — never execute alongside it.
          const claim = await this.#claimStartedRun(tdb, job.runId, executionId, ttlMs);
          if (claim === 'done') return;
          // The quarantine decision is keyed on the NON-IDEMPOTENT-TAINT marker:
          //  - TAINTED (a non-idempotent tool already fired ⇒ the chokepoint wrote the `run_taint`
          //    marker before it fired) → QUARANTINE: refuse to re-run. Terminal, manual review.
          //  - UNTAINTED (idempotent / no-tool) → SAFELY re-runnable: fall through and run again.
          // A transient READ ERROR is not collapsed into "tainted": the read is retried a bounded
          // number of times and, if it still fails, the original DB error is the step's outcome — the
          // run is NEVER re-executed off an unresolved taint read.
          const tainted = await readTaintWithBoundedRetry(tdb, job.runId);
          if (tainted) {
            throw new DurableRunNotRetriedError(job.runId);
          }
          // ── Already-ended short-circuit (the double-MODEL-BILL window) ──────────────────────
          // The run may have ALREADY ENDED on an earlier attempt while the engine still dispatches
          // it again: a step-outcome checkpoint lost under load, or a second dispatch that waited on
          // the first execution's lease. An ended run carries a terminal header — `completed`, or
          // `error` with its recorded end (a wall-clock bound whose outcome is unknown, a throw, a
          // returned error). Its outcome is the record: re-running would bill the model again, and
          // would erase the journal step that states how it ended. So complete as a NO-OP. Only a
          // header still `enqueued`/`running` (or none) is an interrupted attempt. A persistent
          // header-read failure falls through to the safe re-run (the run is untainted).
          if (await readRunEndedWithBoundedRetry(tdb, job.runId)) {
            return;
          }
          // An interrupted, untainted attempt: clear what it left, then re-run.
          await clearInterruptedAttempt(tdb, job.runId);
        }

        // ── Run the EXISTING runAgent off-request ─────────────────────────────────────────────
        const effectiveSpec: AgentSpec = {
          ...resolved.spec,
          input: job.input,
          ...(job.instructions !== undefined ? { instructions: job.instructions } : {}),
          ...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
        };
        // This execution's own stop: aborted when its lease is found taken over, so two executions of
        // one run never continue side by side. Linked into the run's signal by run-core.
        const leaseLost = new AbortController();
        const stopRenewal = startLeaseRenewal(tdb, job.runId, executionId, ttlMs, () =>
          leaseLost.abort(),
        );
        try {
          const tools = resolved.toolFactory ? resolved.toolFactory(tdb) : resolved.tools;
          await runAgent(tdb, resolved.backend, effectiveSpec, {
            runId: job.runId,
            // The run's handle commits each statement as it is made, so the taint marker, the
            // cancellation watch and the run's terminal record all go through it directly.
            taintDb: tdb,
            signal: leaseLost.signal,
            ...(tools ? { tools } : {}),
            // Output persistence: when the job carries `persistTo`, write the run's validated output
            // into the resolved store (exactly-once — the header completing-transition gate makes a
            // recovery re-dispatch of an already-completed run a NO second write).
            ...(job.persistTo !== undefined ? { persistTo: job.persistTo } : {}),
            ...(resolved.productTables ? { productTables: resolved.productTables } : {}),
          });
        } catch (err) {
          // ── A CANCELLED run that ends by REJECTING is accounted for, not failed ───────────────
          // run-core records a cancelled run's outcome itself (with what happened to its provider
          // call); the record below is the same guarded, idempotent transition, kept for a run whose
          // own record could not be written. The step then completes as a NO-OP: failing the
          // workflow would add an engine-level error on top of a recorded outcome. A run that failed
          // on its own rethrows unchanged, and so does one whose cancellation read cannot be
          // resolved — an unreadable marker must never swallow a run's real failure.
          const cancelled = await readCancelledWithBoundedRetry(tdb, job.runId).catch(() => false);
          if (!cancelled) throw err;
          await recordRunCancelled(tdb, job.runId);
          return;
        } finally {
          stopRenewal();
          // Give the lease up, so a dispatch waiting on this run takes over at once rather than when
          // the lease lapses. Best-effort: a failure only means the waiter waits for the expiry.
          await releaseRunLease(tdb, job.runId, executionId).catch(() => {});
        }
      }),
      // The step is NOT retried in-step (default retriesAllowed:false) — no in-step auto-retry.
      { name: 'runAgent', retriesAllowed: false },
    );
  }

  /**
   * Take over a run whose started-once marker already exists. Waits while another execution holds a
   * live lease; returns `done` when the run was cancelled (and is recorded), and `claimed` once this
   * execution holds the lease — the caller then decides, taint first, whether the run may run again.
   * An execution gives its lease up when it ends, so a waiter takes over at once; a lease that lapsed
   * because its holder died is noticed within one renewal interval.
   */
  async #claimStartedRun(
    tdb: TenantDb,
    runId: string,
    executionId: string,
    ttlMs: number,
  ): Promise<'done' | 'claimed'> {
    for (;;) {
      if (await readCancelledWithBoundedRetry(tdb, runId)) {
        await recordRunCancelled(tdb, runId);
        return 'done';
      }
      const lease = await readRunLease(tdb, runId);
      const live = lease?.leaseUntil !== undefined && lease.leaseUntil > Date.now();
      if (!live && (await moveRunLease(tdb, runId, lease?.executionId, executionId, ttlMs))) {
        return 'claimed';
      }
      await new Promise((r) => setTimeout(r, Math.max(1, Math.floor(ttlMs / 3))));
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    DBOS.setConfig({
      name: this.#config.name,
      systemDatabaseUrl: this.#config.systemDatabaseUrl,
      // SECURITY (no hidden listener): DISABLE the DBOS admin HTTP server. By default
      // `DBOS.launch()` starts an UNAUTHENTICATED admin HTTP server on `adminPort` (3001) that binds
      // ALL interfaces with wildcard CORS and can cancel/resume/restart/list workflows — and it
      // SWALLOWS an EADDRINUSE (it only `logger.warn`s; verified in the installed 4.21.6
      // dbos.js:235-251). That contradicts the LOCAL/no-hidden-listener/fail-closed posture of
      // @rayspec/server. `runAdminServer`/`adminPort` are TOP-LEVEL fields on the
      // `DBOSConfig` that `DBOS.setConfig` accepts (dbos-executor.d.ts:54-55); at launch
      // `translateRuntimeConfig` reads `config.runAdminServer ?? true` (config.js:171-174) and the
      // launch path only starts the server `if (runtimeConfig.runAdminServer)` (dbos.js:235). Setting
      // it false here means NO admin listener is ever bound. (NOTE: this is NOT the YAML `ConfigFile`
      // `runtimeConfig:{ runAdminServer }` nesting — `DBOSConfig` has no `runtimeConfig` field, so the
      // top-level field is the correct + only typeable shape for the programmatic setConfig surface.)
      runAdminServer: false,
      // FENCE (issue #359): the per-document application version, when the deployment named one.
      // `applicationVersion` is a TOP-LEVEL `DBOSConfig` field (dbos-executor.d.ts:56, one line below
      // `runAdminServer` above) and `DBOS.launch` copies it into `globalParams.appVersion` BEFORE
      // `init()` reaches the `if (globalParams.appVersion === '')` compute branch — so supplying it
      // here replaces DBOS's own hash rather than racing it. Spread CONDITIONALLY: an executor
      // constructed without one must send NO key, so DBOS still computes its version (the behaviour
      // every caller that names no document keeps).
      ...(this.#config.applicationVersion
        ? { applicationVersion: this.#config.applicationVersion }
        : {}),
      ...(this.#config.logger ? { logger: this.#config.logger } : {}),
    });

    // Register the SINGLE durable workflow BEFORE launch (so crash-recovery knows about it).
    // maxRecoveryAttempts:1 = layer 1 (cap DBOS recovery so a perpetually-crashing job dead-letters at
    // MAX_RECOVERY_ATTEMPTS_EXCEEDED instead of looping); the started-once guard (layer 2, in the body)
    // is the real never-silently-re-fire guarantee.
    this.#runAgentJob = DBOS.registerWorkflow(
      (job: RunJob) => this.#queue.track(() => this.#runAgentJobBody(job)),
      {
        name: 'runAgentJob',
        maxRecoveryAttempts: 1,
      },
    );

    // Run the pre-launch hooks (the cron scheduler registers its DBOS scheduled-workflows
    // HERE — after registerWorkflow, before launch — so the `ScheduledReceiver` lifecycle callback
    // picks them up at launch). Any other future pre-launch registration rides this same window.
    for (const hook of this.#preLaunchHooks) hook();

    // Launch BEFORE registering the queue: `registerQueue` is DB-backed and requires DBOS to be
    // launched first (verified doc-first against 4.21.6 — `ensureDBOSIsLaunched` throws otherwise).
    await DBOS.launch();

    // The off-request queue (DBOS-native worker-concurrency cap — the SAFE-half semaphore).
    // `onConflict:'always_update'` is REQUIRED once `applicationVersion` is per-document: the DBOS
    // default (`update_if_latest_version`) only writes the queue row when THIS process's version is
    // the newest row in `application_versions`, and otherwise degrades the upsert to ON CONFLICT DO
    // NOTHING — so a second deployment's `workerConcurrency` would look accepted and never apply.
    // WHAT IT DOES NOT BUY: per-deployment queue CONFIG. `applicationVersion` fences CLAIMING, not
    // this row. DBOS's `queues` table is keyed on the queue NAME alone (no application_version
    // column; `always_update` upserts `ON CONFLICT (name) DO UPDATE` — verified against the pinned
    // 4.21.6 sysdb migrations + `system_database.ts`), and the name here is a process-independent
    // constant. So two deployments sharing one system database share ONE row: whichever booted most
    // recently sets `workerConcurrency` for both. Differing values need separate system databases.
    // Registered PAUSED (worker concurrency 0) when `pauseDispatch` ran before start: a runtime that
    // boots under a held source fence must not dequeue anything, and must not switch dispatch back on
    // for the other processes that share this queue row.
    await this.#queue.register();

    this.#started = true;
  }

  async enqueue(_tenantId: string, job: RunJob): Promise<EnqueueResult> {
    if (!this.#started || !this.#runAgentJob) {
      throw new Error(
        'DbosDurableExecutor.enqueue called before start() — launch the engine first.',
      );
    }
    const runAgentJob = this.#runAgentJob;
    // The durable workflow id IS the pre-minted, idempotency-reserved runId: DBOS's workflow-id
    // idempotency law (same id ⇒ at most one workflow) + our reserve interlock to exactly one job
    // per Idempotency-Key. The queue dequeues + runs it off-request with the worker-concurrency cap.
    // The tenant rides as a workflow attribute, which is what admission counts a tenant's runs by.
    const start = async (): Promise<EnqueueResult> => {
      const handle = await DBOS.startWorkflow(runAgentJob, {
        workflowID: job.runId,
        queueName: AGENT_RUNS_QUEUE,
        workflowAttributes: { tenantId: job.tenantId },
      })(job);
      return { jobId: handle.workflowID };
    };
    const admission = this.#config.admission;
    if (admission?.queueMax === undefined && admission?.queueMaxPerTenant === undefined) {
      return start();
    }
    // QUEUE ADMISSION. Counting and enqueueing are one step for every process: they run under one
    // advisory lock on the application database, so a burst cannot all pass the count before any of
    // them is counted. The count is the engine's own queue (queued and executing), which every
    // process sharing the system database writes to.
    const tdb = forTenant(this.#deps.db, job.tenantId);
    return tdb.withAdvisoryLock(ADMISSION_LOCK_NAMESPACE, ADMISSION_LOCK_SLOT, async () => {
      // A re-enqueue of a run that already exists is not a new run: the engine answers it with the
      // existing workflow, so it is never refused.
      if ((await DBOS.getWorkflowStatus(job.runId)) === null) {
        if (admission.queueMaxPerTenant !== undefined) {
          const tenantBacklog = await countBacklog(admission.queueMaxPerTenant, job.tenantId);
          if (tenantBacklog >= admission.queueMaxPerTenant) {
            throw new RunAdmissionRefusedError('tenant', admission.queueMaxPerTenant);
          }
        }
        if (admission.queueMax !== undefined) {
          const backlog = await countBacklog(admission.queueMax);
          if (backlog >= admission.queueMax) {
            throw new RunAdmissionRefusedError('global', admission.queueMax);
          }
        }
      }
      return start();
    });
  }

  async status(jobId: string): Promise<DurableJobStatus> {
    if (!this.#started) return 'unknown';
    const status = await DBOS.getWorkflowStatus(jobId);
    return toNeutralStatus(status?.status);
  }

  /**
   * End a job through DBOS. `cancelWorkflow` flips an ENQUEUED workflow to CANCELLED so the queue never
   * dequeues it — the clean, real case: the run is stopped before it starts.
   *
   * WHAT IT DOES NOT DO, stated exactly (verified doc-first against the installed 4.21.6: "If the
   * workflow is currently running, `DBOSWorkflowCancelledError` will be thrown from its next DBOS
   * call"): DBOS cancellation is COOPERATIVE, and our workflow runs the WHOLE `runAgent` inside ONE
   * step, so a job already executing has no next DBOS call to raise at until that step ends. Cancelling
   * it therefore changes its recorded status and nothing more — the run's own AbortSignal is what stops
   * the work in flight. Mirrors `enqueue` in requiring a launched engine.
   */
  async cancel(jobId: string): Promise<void> {
    if (!this.#started) {
      throw new Error(
        'DbosDurableExecutor.cancel called before start() — launch the engine first.',
      );
    }
    await DBOS.cancelWorkflow(jobId);
  }

  async shutdown(): Promise<void> {
    if (!this.#started) return;
    // GRACEFUL DRAIN (SAFE half): DBOS.shutdown() deactivates the event/queue receivers (stops
    // dequeuing) and then destroys the executor, which AWAITS running workflows to quiescence
    // (`awaitRunningWorkflows` in the installed 4.21.6 dbos-executor.js) — so an in-flight runAgentJob
    // FINISHES before this resolves (no orphaned mid-run job). `deregisterOnShutdown` (TEST-ONLY) also
    // clears the process-global workflow registry so a fresh executor can re-register in the same process.
    await DBOS.shutdown(this.#config.deregisterOnShutdown ? { deregister: true } : undefined);
    this.#started = false;
  }

  /**
   * The LIVE executor identity, read straight off the DBOS global singleton. `DBOS.executorID` defaults
   * to a short constant even before launch, but `DBOS.applicationVersion` is EMPTY until `DBOS.launch()`
   * sets or computes it — so a not-yet-launched engine reports an empty `applicationVersion`, which the
   * readiness probe treats as fail-closed. camelCase (`executorId` / `applicationVersion`) mirrors the
   * DBOS/JS convention. Returns ONLY these two identity fields — no secret / connection material.
   */
  identity(): DurableExecutorIdentity {
    return { executorId: DBOS.executorID, applicationVersion: DBOS.applicationVersion };
  }
}
