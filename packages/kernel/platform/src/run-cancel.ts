/**
 * Run cancellation — ending one run on demand.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE PARTS, AND WHY EACH IS NEEDED.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  1. A PERSISTED MARKER (`idempotency_keys(scope='run_cancelled', key=runId)`) — the durable record
 *     that this run was ended. It is what a DISPATCH consults before executing: a run that has not
 *     started is never started, and a recovery re-dispatch can never resurrect it. Written BEFORE any
 *     signal is delivered, so a process that dies mid-cancel still leaves the run un-dispatchable.
 *     The mechanism mirrors the taint marker exactly (same table, same atomic primitive, same
 *     tenant-scoped-by-construction read) — no new table, no migration.
 *  2. A PROCESS-LOCAL SIGNAL — the AbortSignal run-core hands the adapter on `ctx.signal`. This is what
 *     frees the WORK rather than only the caller waiting on it. It is process-local, and honestly so:
 *     a run executing on ANOTHER worker process does not receive it. For that run the marker (1) and
 *     the engine's own cancellation are what apply, and the engine's cancellation is COOPERATIVE — the
 *     whole run executes inside one engine step, so cancelling it flips the workflow's status but does
 *     not by itself interrupt an in-flight model call.
 *  3. A JOURNALED TERMINAL OUTCOME — a cancelled run ends like any other run ends: one journal step
 *     carrying the neutral `cancelled` class plus a terminal run header, so `GET /v1/runs/{id}` reports
 *     the outcome instead of a run that simply stopped moving. The CANCEL surface writes it whenever it
 *     can: a run that has not started has no `runAgent` to write it at all, and a run that has already
 *     finished holds nothing. The one case it cannot write is a run still EXECUTING, which holds its
 *     header row inside its own transaction — it does not wait for it (see
 *     {@link RUN_CANCEL_LOCK_WAIT_MS}), because waiting there is waiting out the very run being ended.
 *     That run's own side writes it instead, and which part depends on how the run ends: one that
 *     produces a result records it from INSIDE the run (run-core consults the marker before its
 *     completing write), while one that ends by THROWING rolls that transaction back — taking any write
 *     made inside it — so the durable worker records it after the rollback, on its own non-transactional
 *     handle. Every one of those writes is the same idempotent, guarded transition, so however many
 *     sides try, exactly one ever counts.
 */

import type { AuthMode, ErrorClass } from '@rayspec/core';
import { isLockTimeout, schema, type TenantDb } from '@rayspec/db';
import { and, eq, notInArray } from 'drizzle-orm';
import {
  isTerminalRunStatus,
  type RunHeaderStatus,
  TERMINAL_RUN_STATUS_VALUES,
} from './run-header.js';

/**
 * The `idempotency_keys` scope for the per-run cancellation marker. A row
 * `(tenant, scope='run_cancelled', idem_key=runId)` means "this run was ended on demand". Distinct from
 * `agent_run` (the run-level idempotency reservation), `run_started` (the durable started-once guard)
 * and `run_taint` (the non-idempotent-tool marker) so the four never collide.
 */
export const RUN_CANCELLED_SCOPE = 'run_cancelled';

/**
 * The `body_hash` sentinel for a `run_cancelled` marker row. The marker's identity is its
 * `(tenant, scope, idem_key=runId)` UNIQUE key; `body_hash` is unused for it (a non-null sentinel for
 * the NOT-NULL column), so a stable constant rather than a value that would read as a hashed body.
 */
export const RUN_CANCELLED_BODY_HASH = 'run_cancelled_marker';

/**
 * The journal step's `idempotency_key` for the cancellation outcome. One slot per run in the
 * `(tenant, run, idempotency_key)` unique index, so recording a cancellation twice writes one row.
 */
export const RUN_CANCELLED_STEP_KEY = 'run:cancelled';

/**
 * The journal step TYPE the cancellation outcome is recorded under. Deliberately NOT `llm`: no model
 * call happened (a run cancelled before it started never reached one), and labelling it `llm` would put
 * a fabricated model step in the ledger. The `type` column's vocabulary is therefore wider than the
 * adapter-facing `StepReport['type']` union — the same shape the `error_class` column already has,
 * where the journal-only `tool_error` value lives outside the neutral enum. Nothing keys behaviour off
 * the type: the read path selects the failing step by `status='error'` plus a recognised `errorClass`,
 * and among those it recognises {@link CANCELLED_CLASS} first — see `pickFailingStep`, which is how the
 * read path arrives at the same outcome this module records for a cancelled run.
 */
export const RUN_CANCELLED_STEP_TYPE = 'cancel';

/**
 * The neutral class a cancelled run reports — a member of the closed enum, validated on read.
 * Exported because the read path has to recognise this exact value to keep its answer aligned with
 * this module's rule about what a cancelled run's outcome is; a second copy of the literal there is
 * the kind of drift the shared-constant rule exists to prevent.
 */
export const CANCELLED_CLASS: ErrorClass = 'cancelled';

/**
 * The auth mode recorded on the cancellation step. The step is a platform-side outcome, not a call made
 * under a credential, and `unauthenticated` is the neutral vocabulary for exactly that (the same value
 * an enqueue-time run header carries before any credential is resolved).
 */
const CANCELLED_AUTH_MODE: AuthMode = 'unauthenticated';

/** The message a cancelled run reports — what ended, and what that did and did not stop. */
export function runCancelledMessage(runId: string): string {
  return (
    `run ${runId} was cancelled. Cancelling ends the run and stops the platform waiting for it; a ` +
    'model call already in flight on another worker process runs on until it settles by itself.'
  );
}

/**
 * Raised when a run is ended on demand while run-core is waiting for the backend. The run's seams go
 * inert exactly as they do when the wall-clock bound fires — the backend call is still in flight and
 * still holding the RunContext, and nothing bound to a cancelled run's handle may issue a statement.
 *
 * The class name is deliberately NOT one `classifyUpstreamError` keys a class off: a cancellation is a
 * platform-side outcome, not an upstream failure, so the layers that surface it set the neutral
 * `cancelled` class explicitly rather than routing it through the upstream classifier.
 */
export class RunCancelledError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(runCancelledMessage(runId));
    this.name = 'RunCancelledError';
    this.runId = runId;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (1) The persisted marker.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * MARK a run as cancelled. An atomic `INSERT .. ON CONFLICT DO NOTHING` over the `idempotency_keys`
 * `UNIQUE(tenant, scope, idem_key)` index — idempotent, so cancelling twice is a no-op. Tenant-scoped
 * via the `TenantDb` chokepoint (the predicate is structural: a marker can never land on, or be read
 * from, another tenant's row).
 *
 * ORDERING CONTRACT: the cancel surface writes this BEFORE it signals anything and BEFORE it asks the
 * engine to cancel, so a crash between the two leaves a run that is un-dispatchable rather than one
 * that was signalled and then quietly re-dispatched.
 */
export async function markRunCancelled(tdb: TenantDb, runId: string): Promise<void> {
  await tdb
    .insert(schema.idempotencyKeys, {
      scope: RUN_CANCELLED_SCOPE,
      idemKey: runId,
      bodyHash: RUN_CANCELLED_BODY_HASH,
      snapshot: { runId },
    })
    .onConflictDoNothing();
}

/**
 * READ whether a run was cancelled. Every dispatch path consults this BEFORE executing `runAgent`, so a
 * cancelled run is neither started nor re-started. Tenant-scoped via the `TenantDb` chokepoint: a
 * foreign runId reads ZERO rows (returns false) exactly like every other tenant-scoped read.
 */
export async function isRunCancelled(tdb: TenantDb, runId: string): Promise<boolean> {
  const rows = await tdb
    .select(schema.idempotencyKeys)
    .where(
      and(
        eq(schema.idempotencyKeys.scope, RUN_CANCELLED_SCOPE),
        eq(schema.idempotencyKeys.idemKey, runId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (2) The process-local signal.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The runs executing IN THIS PROCESS, by runId, each with the AbortController run-core armed for it.
 * run-core registers a run when it starts waiting for the backend and releases it when that wait ends,
 * so the map holds exactly the runs a cancellation can still reach.
 *
 * PROCESS-LOCAL, stated exactly: a deployment that runs the HTTP surface and the durable worker in one
 * process (the shipped shape) reaches every executing run through it. A worker in a SEPARATE process
 * does not appear here — for those runs the persisted marker plus the engine's own cooperative
 * cancellation are what apply, and neither interrupts a model call already in flight.
 */
const liveRuns = new Map<string, AbortController>();

/** What run-core holds for one run's cancellation: the signal to thread, and the release. */
export interface RunCancellation {
  /** The run's signal — threaded onto `ctx.signal` and raced against the backend call. */
  readonly signal: AbortSignal;
  /** Release the registration (and any link to a caller-supplied signal). Idempotent. */
  dispose(): void;
}

/**
 * ARM a run's cancellation: mint the run's AbortController, LINK a caller-supplied signal into it (so
 * `RunOptions.signal` and the cancel surface are the same one mechanism, not two), and register it
 * under `runId` so {@link signalRunCancelled} can reach it.
 *
 * An `external` signal that is ALREADY aborted aborts the run's controller immediately, so a run started
 * with a spent signal never calls the backend at all.
 */
export function armRunCancellation(runId: string, external?: AbortSignal): RunCancellation {
  const controller = new AbortController();
  let onExternal: (() => void) | undefined;
  if (external) {
    if (external.aborted) controller.abort();
    else {
      onExternal = () => controller.abort();
      external.addEventListener('abort', onExternal, { once: true });
    }
  }
  liveRuns.set(runId, controller);
  return {
    signal: controller.signal,
    dispose() {
      // Only remove OUR registration: two executions of the same runId can overlap (a recovery
      // re-dispatch racing an in-flight run), and the later one owns the entry.
      if (liveRuns.get(runId) === controller) liveRuns.delete(runId);
      if (external && onExternal) external.removeEventListener('abort', onExternal);
    },
  };
}

/**
 * SIGNAL a run executing in this process to stop. Returns true iff a live run was found and signalled —
 * false is not a failure: the run may have already ended, or may be executing in another process, in
 * which case the persisted marker is what governs it.
 */
export function signalRunCancelled(runId: string): boolean {
  const controller = liveRuns.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Race `work` against `signal`. Resolves with `work`'s value when it finishes first; rejects with a
 * {@link RunCancelledError} the moment the signal aborts. The listener is removed once the race settles.
 *
 * When the signal wins, `work` is still pending. `Promise.race` has already subscribed to it, so its
 * eventual rejection counts as handled and cannot surface as an unhandled rejection — the same property
 * the wall-clock bound relies on.
 */
export async function withRunCancel<T>(
  work: PromiseLike<T>,
  signal: AbortSignal,
  runId: string,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    // An already-aborted signal rejects the race immediately rather than short-circuiting BEFORE it:
    // the race must still subscribe to `work`, or a rejection it produces later (the wall-clock bound
    // firing on the call we stopped waiting for) would surface as an unhandled rejection.
    if (signal.aborted) {
      reject(new RunCancelledError(runId));
      return;
    }
    onAbort = () => reject(new RunCancelledError(runId));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (3) The journaled terminal outcome.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link recordRunCancelled} did: whether it ended the run, and the header status it left. */
export interface RunCancellationOutcome {
  /**
   * True iff THIS call made the run terminal. False means the run's header was NOT moved by this call
   * — either it had already finished (its own outcome stands) or it is executing inside its own
   * transaction, which holds the header row and writes the run's outcome itself.
   */
  cancelled: boolean;
  /** The run header status after the call, or null when the run has no header for this tenant. */
  status: RunHeaderStatus | null;
}

/**
 * How long {@link recordRunCancelled} waits for the run header's row lock before giving up on the
 * completing transition.
 *
 * WHY A BOUND AT ALL: on the durable path run-core runs inside the executor's transaction and its
 * `running` write holds the header row for the WHOLE run (see run-header.ts). An unbounded UPDATE
 * against that row would make a cancel request wait for the run it is trying to end — pinning an HTTP
 * pool connection for the run's remaining lifetime. The cancel surface delivers the in-process signal
 * BEFORE this write, so a run this process can reach has already been told to stop and unwinds its
 * transaction in milliseconds; this bound is the margin for that, and the honest give-up for a run no
 * signal reached (one executing in another process). Giving up never loses the outcome: the run's own
 * side records it when it ends — from inside the run when it produces a result, from the durable worker
 * once the run's transaction has rolled back when it ends by throwing.
 */
export const RUN_CANCEL_LOCK_WAIT_MS = 2000;

/**
 * RECORD a run's terminal cancellation: the run header moved to the terminal `error` status, plus one
 * journal step carrying the neutral `cancelled` class. Tenant-scoped throughout via the `TenantDb`
 * chokepoint, and ATOMIC: both writes are one transaction, so the ledger never carries a cancellation
 * step for a run whose header was not moved, and never a moved header with no step saying why.
 *
 * WHAT IT REPORTS, and why it is derived rather than asserted. The transition is guarded on the run
 * not already being terminal and returns the rows it actually moved; `cancelled` is that row count.
 * A run that finished on its own keeps its outcome and this reports `cancelled:false` with the status
 * the run really has — the call never claims a transition it did not make. A repeated cancel is
 * therefore idempotent rather than an error.
 *
 * `opts.lockWaitMs` bounds the wait for the header row's lock ({@link RUN_CANCEL_LOCK_WAIT_MS} by
 * default; `0` waits as long as Postgres normally would). A run executing inside its OWN transaction
 * holds that row: past the bound this reports `cancelled:false` and leaves the outcome to the run,
 * rather than holding the caller. The run that IS that transaction passes `0` — it already holds the
 * lock, so it never waits.
 *
 * WHY `error` AND NOT A FIFTH HEADER STATUS: the terminal header statuses are read off the neutral
 * `RunResult.status` options, which are exactly `completed` and `error`; a cancelled run produced no
 * answer, so `error` is what it is, and the neutral `errorClass` is what says WHY. Every consumer that
 * tests terminality keeps working unchanged.
 */
export async function recordRunCancelled(
  tdb: TenantDb,
  runId: string,
  opts?: { lockWaitMs?: number },
): Promise<RunCancellationOutcome> {
  const lockWaitMs = opts?.lockWaitMs ?? RUN_CANCEL_LOCK_WAIT_MS;
  try {
    return await tdb.transaction(
      async (tx) => {
        const headerRows = (await tx
          .select(schema.runs, {
            status: schema.runs.status,
            backend: schema.runs.backend,
            authMode: schema.runs.authMode,
          })
          .where(eq(schema.runs.runId, runId))
          .limit(1)) as Array<{ status: string; backend: string; authMode: string }>;
        const header = headerRows[0];
        // No header for THIS tenant: absent or another tenant's run. Nothing to end (the caller has
        // already answered 404 for that case; this keeps the helper self-contained and side-effect-free).
        if (!header) return { cancelled: false, status: null };
        if (isTerminalRunStatus(header.status)) {
          return { cancelled: false, status: header.status as RunHeaderStatus };
        }

        // The completing transition, FIRST and GUARDED on the run not already being terminal — the read
        // above is not a lock, so this statement is what decides. `.returning()` is what makes the
        // reported outcome true rather than assumed: an empty return means the run reached its own
        // terminal status first and keeps it.
        const moved = await tx
          .update(schema.runs, { status: 'error' })
          .where(
            and(
              eq(schema.runs.runId, runId),
              notInArray(schema.runs.status, [...TERMINAL_RUN_STATUS_VALUES]),
            ),
          )
          .returning({ runId: schema.runs.runId });
        if (moved.length === 0) {
          // The run finished between the read and the write. Report what it actually is — and write NO
          // step: a run that produced its own outcome must not gain a contradictory `cancelled` error
          // step in its ledger (it would inflate the step count and shadow the run's real failure).
          const current = (await tx
            .select(schema.runs, { status: schema.runs.status })
            .where(eq(schema.runs.runId, runId))
            .limit(1)) as Array<{ status: string }>;
          return {
            cancelled: false,
            status: (current[0]?.status ?? null) as RunHeaderStatus | null,
          };
        }

        // The outcome step, written only because the transition above took. Usage and cost are zero:
        // nothing was consumed by ending the run, and the run's roll-ups must keep reporting exactly
        // what the run actually spent. `onConflictDoNothing` keeps a second cancellation from writing a
        // second step.
        await tx
          .insert(schema.journalSteps, {
            runId,
            backend: header.backend,
            type: RUN_CANCELLED_STEP_TYPE,
            idempotencyKey: RUN_CANCELLED_STEP_KEY,
            inputHash: RUN_CANCELLED_STEP_KEY,
            // The `{ error, errorClass }` shape every failing step carries — it is what the run read
            // path derives the reported error and class from.
            output: { error: runCancelledMessage(runId), errorClass: CANCELLED_CLASS },
            status: 'error',
            errorClass: CANCELLED_CLASS,
            authMode: CANCELLED_AUTH_MODE,
          })
          .onConflictDoNothing();

        return { cancelled: true, status: 'error' as RunHeaderStatus };
      },
      { lockTimeoutMs: lockWaitMs },
    );
  } catch (err) {
    if (!isLockTimeout(err)) throw err;
    // The header row is held by the run's own transaction — it is executing right now. Nothing was
    // written (the transaction aborted). The run stays MARKED cancelled, so no dispatch will run it
    // again, and the run itself is what writes the header from here: run-core consults the marker
    // before its completing write and records the cancellation as the run's own outcome. Report the
    // status a plain read sees (an MVCC read never waits on the holder).
    const current = (await tdb
      .select(schema.runs, { status: schema.runs.status })
      .where(eq(schema.runs.runId, runId))
      .limit(1)) as Array<{ status: string }>;
    return { cancelled: false, status: (current[0]?.status ?? null) as RunHeaderStatus | null };
  }
}
