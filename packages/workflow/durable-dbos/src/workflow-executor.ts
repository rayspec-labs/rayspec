/**
 * `DbosWorkflowExecutor` — the DBOS durable path for the declarative WORKFLOW runtime.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE PACKAGE THAT KNOWS DBOS (workflow half).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The neutral `@rayspec/workflow-durable` engine is DBOS-free; this adapter runs one
 * `engine.execute()` off-request inside a single DBOS durable workflow, mirroring how
 * `DbosDurableExecutor` runs `runAgent`. It attaches to the SAME shared `DbosDurableExecutor` (DBOS is
 * a process-global singleton with ONE launch) via `attachPreLaunchHook` — exactly like
 * `DbosCronScheduler` — so a deployment has ONE launch that owns the agent-run workflow, the cron
 * scheduled-workflows, AND this workflow-run workflow.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SINGLE-FLIGHT + DURABILITY (with honest resume).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The DBOS `workflowID` IS the tenant-namespaced `durableWorkflowRunId(tenant, workflowId,
 * idempotencyKey)`, so DBOS's own workflow-id idempotency law dedups a redelivered / concurrent
 * enqueue to exactly one workflow (single-flight). On a crash mid-run, DBOS re-invokes the workflow → the ONE
 * step re-runs `engine.execute()`, which JOURNAL-RESUMES at the first non-completed node (a completed
 * node is never re-run). This is the honest durability contract documented on the engine (a node
 * interrupted mid-execution is re-run — node handlers self-guard: capability idempotency keys,
 * content-addressed store upsert, the agent path's own taint quarantine).
 *
 * NOTE: unlike the agent path's bare-runId workflowID, THIS workflowID is ALREADY
 * tenant-namespaced by construction (`durableWorkflowRunId` hashes the tenant in), so the workflow
 * dedup namespace is tenant-disjoint here — a colliding pinned key across tenants cannot occur.
 */
import { randomUUID } from 'node:crypto';
import { DBOS, StatusString } from '@dbos-inc/dbos-sdk';
import type { Db } from '@rayspec/db';
import { forTenant, type TenantDb } from '@rayspec/db';
import type {
  CapabilityRegistry,
  WorkflowInputEvent,
  WorkflowRunStatus,
  WorkflowSpec,
} from '@rayspec/foundation';
import type { DurableJobStatus } from '@rayspec/platform';
import {
  DurableWorkflowEngine,
  durableWorkflowRunId,
  type RepairHandler,
  TenantDbWorkflowJournalStore,
  type WorkflowEnqueuer,
} from '@rayspec/workflow-durable';

/**
 * The JSON-serializable payload to reconstruct + execute a workflow run off-request. It carries NO
 * live object graph (no registry/handlers) — the `resolveWorkflowRun` resolver rebuilds the compiled
 * spec + the tenant-bound capability registry at fire time (like `RunJob` → `resolveRun`).
 */
export interface WorkflowJob {
  /** The tenant-namespaced durable run id — also the DBOS workflowID (single-flight). */
  readonly workflowRunId: string;
  readonly tenantId: string;
  /** The compiled workflow id — the resolver re-resolves its spec + registry at fire time. */
  readonly workflowId: string;
  /** The per-event idempotency key (the single-flight scope). */
  readonly idempotencyKey: string;
  /** The neutral trigger event that started the run. */
  readonly event: WorkflowInputEvent;
}

/** What the resolver returns at fire time: the compiled spec + the tenant-bound node registry. */
export interface ResolvedWorkflowRun {
  readonly workflow: WorkflowSpec;
  readonly registry: CapabilityRegistry;
  readonly repairers?: ReadonlyMap<string, RepairHandler>;
}

/** A minimal logger sink for the resolve-failure line (the deployment can inject; defaults to `console`). */
export interface WorkflowExecutorLogger {
  warn(message: string): void;
}

/** The default sink — one `console.warn` per journalled resolve failure. */
const CONSOLE_LOGGER: WorkflowExecutorLogger = {
  warn: (m) => console.warn(m),
};

export interface DbosWorkflowExecutorDeps {
  /** The raw Db (composition root); the worker binds `forTenant(db, tenantId)` per job. */
  readonly db: Db;
  /**
   * Resolve a `WorkflowJob` → its compiled spec + the tenant-bound capability registry (agent/
   * capability/validate/store handlers), built from the job's `tdb` so agent/store nodes are
   * tenant-scoped. Called at FIRE time (no serialized live object graph). Throws on an unknown
   * workflow id (fail-closed — the worker surfaces the run failed).
   */
  readonly resolveWorkflowRun: (job: WorkflowJob, tdb: TenantDb) => ResolvedWorkflowRun;
  /** Where the resolve-failure line goes. Defaults to `console.warn` (like the cron scheduler's sink). */
  readonly logger?: WorkflowExecutorLogger;
}

/**
 * The `WorkflowErrorState.code` a run journalled from a FAILED resolver carries. Distinct from any
 * node-level code: no node ever ran — the job could not be turned into a runnable workflow at all.
 */
export const WORKFLOW_RESOLVE_FAILED_CODE = 'workflow_resolve_failed';

/**
 * The ONE line the worker emits when a job's resolver threw and the run was journalled terminally.
 * Pure + exported so its wording has a single source of truth and is directly testable without a
 * DBOS launch (the same posture as `cronTenantAbsentLog`).
 *
 * WHY IT EXISTS. The resolver throws BEFORE the engine is constructed, so `engine.execute` — the only
 * caller of `ensureRun`/`finalizeRun` — never runs and the failure reaches no journal. The raw throw
 * does surface: it fails the DBOS step and lands in `dbos.workflow_status`. But that is the DBOS
 * system database, not a surface the product documents, and on a shared DATABASE_URL the process that
 * consumed the job is not necessarily the one that accepted it. This line puts the same fact on the
 * consuming deployment's own log surface, next to the journal row it just wrote.
 *
 * It names WHERE the reason is rather than repeating it: the resolver's message is stored verbatim on
 * the `workflow_runs` row's `error`, and the original error is rethrown unchanged, so it also reaches
 * DBOS. Repeating it here would be a third copy with no reader.
 */
export function workflowResolveFailureLog(job: {
  workflowRunId: string;
  tenantId: string;
  workflowId: string;
}): string {
  return (
    `[workflow] resolve FAILED for workflow '${job.workflowId}' (tenant ${job.tenantId}, run ` +
    `${job.workflowRunId}) — the run was journalled in workflow_runs as terminal_failure with the ` +
    "resolver's error on the row, and the durable job then fails with that same error."
  );
}

/**
 * The line the worker emits INSTEAD when the run already had a `workflow_runs` header written by an
 * earlier execution — a header this path must not overwrite. Pure + exported for the same reason as
 * `workflowResolveFailureLog`.
 *
 * WHY THE HEADER IS KEPT. `ensureRun` is INSERT .. ON CONFLICT DO NOTHING, so a pre-existing header
 * survives it untouched — but `finalizeRun` is a plain UPDATE. Applying this failure's patch to a
 * header the ENGINE wrote would replace that row's real `attempts` (summed from the node journal) and
 * its `resumable` flag with `0` / `false`, while `workflow_node_states` still holds the attempts the
 * row would then deny. So the row is left as it is and this line carries the fact instead.
 */
export function workflowResolveFailureHeaderKeptLog(
  job: { workflowRunId: string; tenantId: string; workflowId: string },
  existingStatus: WorkflowRunStatus,
): string {
  return (
    `[workflow] resolve FAILED for workflow '${job.workflowId}' (tenant ${job.tenantId}, run ` +
    `${job.workflowRunId}) — an earlier execution of this run already wrote a workflow_runs header ` +
    `(status '${existingStatus}'), which was LEFT UNCHANGED: this failure attempted no node and must ` +
    'not overwrite that row. Its record is the DBOS workflow status and this line.'
  );
}

/**
 * The line the worker emits when the terminal journal write ITSELF failed — the third and last shape
 * this path can take. Pure + exported for the same reason as the other two: the wording has a single
 * source of truth and is assertable without a DBOS launch.
 *
 * It says the run is not recorded TERMINALLY, which is exact in both sub-cases: `ensureRun` may have
 * failed (no row at all) or `finalizeRun` may have failed after it (a `running` header that no engine
 * will ever settle, because no engine was built).
 */
export function workflowResolveFailureJournalFailedLog(
  job: { workflowRunId: string; tenantId: string; workflowId: string },
  journalError: unknown,
): string {
  const reason = journalError instanceof Error ? journalError.message : String(journalError);
  return (
    `[workflow] resolve FAILED for workflow '${job.workflowId}' (tenant ${job.tenantId}, run ` +
    `${job.workflowRunId}) and the terminal journal write ALSO failed (${reason}) — the run is NOT ` +
    'recorded terminally in workflow_runs; its complete record is the DBOS workflow status and this line.'
  );
}

/** Map DBOS's workflow status → the neutral job status (the asymmetry stays here; `unknown` fail-safe). */
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

export const WORKFLOW_RUNS_QUEUE = 'workflow-runs';
export const DEFAULT_WORKFLOW_WORKER_CONCURRENCY = 4;

/** The operational liveness of a workflow run, reconciling its journal header against DBOS (DUR-HONESTY-2). */
export type WorkflowRunLiveness = 'active' | 'stalled' | 'terminal' | 'absent';

/**
 * DUR-HONESTY-2: reconcile a workflow run's JOURNAL header status against its DBOS workflow liveness to
 * surface a DEAD-LETTERED run honestly. After DBOS exhausts `maxRecoveryAttempts` it marks the workflow
 * ERROR / MAX_RECOVERY_ATTEMPTS_EXCEEDED and STOPS recovering it — but `engine.execute` never reached
 * `finalizeRun`, so the journal header stays `running` forever (an operator reading the journal alone sees
 * a run that looks live but is dead). This classification makes that visible from the two sources of
 * truth:
 *  - `absent`   — no journal header for the run;
 *  - `terminal` — the journal header SETTLED (not `running`) — done, no reconciliation needed;
 *  - `active`   — header `running` AND DBOS still owns it (enqueued/running) — a healthy in-flight run;
 *  - `stalled`  — header `running` BUT DBOS is no longer active/queued (failed / cancelled / succeeded-
 *                 without-finalize / unknown) — a DEAD-LETTERED run stuck `running`; an operator must act.
 *
 * Pure + deterministic (no DBOS handle) so it is unit-testable; the executor's `liveness()` fetches both
 * inputs and applies it.
 */
export function reconcileWorkflowLiveness(
  journalStatus: WorkflowRunStatus | 'absent',
  dbosStatus: DurableJobStatus,
): WorkflowRunLiveness {
  if (journalStatus === 'absent') return 'absent';
  if (journalStatus !== 'running') return 'terminal';
  return dbosStatus === 'enqueued' || dbosStatus === 'running' ? 'active' : 'stalled';
}

export class DbosWorkflowExecutor implements WorkflowEnqueuer {
  readonly #deps: DbosWorkflowExecutorDeps;
  readonly #logger: WorkflowExecutorLogger;
  readonly #workerConcurrency: number;
  #registered = false;
  #launched = false;
  #runWorkflowJob?: (job: WorkflowJob) => Promise<void>;

  constructor(deps: DbosWorkflowExecutorDeps, config: { workerConcurrency?: number } = {}) {
    this.#deps = deps;
    this.#logger = deps.logger ?? CONSOLE_LOGGER;
    this.#workerConcurrency = config.workerConcurrency ?? DEFAULT_WORKFLOW_WORKER_CONCURRENCY;
  }

  /**
   * Register the durable `runWorkflowJob` workflow. MUST run in the shared executor's pre-launch
   * window (`DbosDurableExecutor.attachPreLaunchHook(() => wfExecutor.registerWorkflowJob())`), so
   * crash-recovery knows about it. Idempotent.
   */
  registerWorkflowJob(): void {
    if (this.#registered) return;
    this.#runWorkflowJob = DBOS.registerWorkflow(
      (job: WorkflowJob) => this.#runWorkflowJobBody(job),
      {
        name: 'runWorkflowJob',
        // Cap DBOS recovery so a perpetually-crashing job dead-letters instead of looping. The engine's
        // journal-resume + node-handler idempotency are the real never-double-fire guarantees.
        maxRecoveryAttempts: 5,
      },
    );
    this.#registered = true;
  }

  /**
   * Register the workflow queue AFTER launch (queues are DB-backed). Call once after the shared
   * `executor.start()` has launched DBOS (mirrors `DbosDurableExecutor.start`'s post-launch
   * `registerQueue`). Idempotent.
   */
  async registerQueueAfterLaunch(): Promise<void> {
    if (this.#launched) return;
    // `onConflict:'always_update'` for the same reason the agent queue sets it: with a per-document
    // `applicationVersion`, DBOS's default `update_if_latest_version` silently degrades this upsert to
    // ON CONFLICT DO NOTHING for every process that is not the newest registered version. It carries
    // the same limit too — the `queues` row is name-keyed and therefore SHARED across deployments on
    // one system database; see the note on the agent queue in executor.ts.
    await DBOS.registerQueue(WORKFLOW_RUNS_QUEUE, {
      workerConcurrency: this.#workerConcurrency,
      onConflict: 'always_update',
    });
    this.#launched = true;
  }

  async #runWorkflowJobBody(job: WorkflowJob): Promise<void> {
    await DBOS.runStep(
      async () => {
        const tdb = forTenant(this.#deps.db, job.tenantId);
        const journal = new TenantDbWorkflowJournalStore(tdb);
        // The resolver is fail-closed and throws BEFORE the engine exists (unbound composition,
        // unknown workflow id). `engine.execute` is the ONLY caller of ensureRun/finalizeRun, so
        // without this the run has no journal row at all — not even an orphaned `running` header —
        // and the loss is visible only in the DBOS system database, on whichever process consumed the
        // job. Journal the terminal outcome here, then RETHROW unchanged so the step still fails.
        // Scoped to the resolver ALONE: `engine.execute` keeps its own invariant that an invalid spec
        // never creates a run header, and widening this catch over it would quietly break that.
        //
        // KNOWN NARROW WINDOW — a crash BETWEEN the journal commit and the rethrow (documented, not
        // closed here). `#journalResolveFailure` writes the `terminal_failure` header through a
        // non-transactional `forTenant` handle, so it is COMMITTED the moment it returns; the
        // `throw err` on the next line is what fails the DBOS step. A process that
        // dies in between leaves the header committed and the step un-failed, so DBOS crash-recovery
        // re-invokes this workflow. Should the resolver SUCCEED on that re-invocation, control reaches
        // `engine.execute` below — which short-circuits on a pre-existing non-`running` header and
        // returns it as-is (engine.ts, the `!created && run.status !== 'running'` dedup, pinned by
        // engine.test.ts "DEDUP IS BLIND TO WHETHER ANYTHING RAN"). This body ignores that return
        // value, so the step, and the workflow, complete SUCCESSFULLY having executed no node.
        //
        // WHAT BOUNDS IT: the resolver's verdict for a given job cannot change within one process.
        // The only production `resolveWorkflowRun` closes over `composedProduct` in product-boot.ts,
        // which is assigned exactly once and BEFORE `await executor.start()`, so every in-process
        // recovery re-invocation of a job whose resolve failed fails identically — re-settling its own
        // marked header (idempotent) and re-failing the step until `maxRecoveryAttempts` dead-letters
        // it. Reaching the SUCCESS-without-executing outcome therefore needs a second condition on top
        // of the sub-second crash: a LATER process whose composition does declare the workflow (a
        // redeploy of the same document identity that re-adds it) recovering that same job.
        //
        // NOT closed by widening the short-circuit here: distinguishing a header this path settled
        // (which attempted nothing) from one the ENGINE settled (which did) is a change to the
        // engine's dedup contract, and re-running a run another writer settled is the worse failure.
        // Tracked for a release that can carry that change.
        let resolved: ResolvedWorkflowRun;
        try {
          resolved = this.#deps.resolveWorkflowRun(job, tdb);
        } catch (err) {
          await this.#journalResolveFailure(journal, job, err);
          throw err;
        }
        const engine = new DurableWorkflowEngine({
          journal,
          registry: resolved.registry,
          tenantId: job.tenantId,
          ...(resolved.repairers ? { repairers: resolved.repairers } : {}),
        });
        await engine.execute({
          workflow: resolved.workflow,
          event: job.event,
          idempotencyKey: job.idempotencyKey,
        });
      },
      // The whole engine.execute is one step — a crash re-invokes the workflow → the step re-runs
      // engine.execute → journal-resume. NOT retried in-step (the engine owns retry per node).
      { name: 'runWorkflow', retriesAllowed: false },
    );
  }

  /**
   * Write the terminal `workflow_runs` header for a job whose resolver threw, through the tenant
   * chokepoint (never raw SQL), and emit the one line. BEST-EFFORT: `workflow_runs.tenant_id` is a
   * foreign key to `orgs(id)`, so this write can itself fail on a job for a tenant that no longer
   * exists — and an advisory record must never turn one failure into two. A failure is logged; the
   * caller rethrows the ORIGINAL resolver error either way. What ENFORCES that: this method has no
   * throwing path. The journal work is caught, and the single emit sits OUTSIDE that try and is itself
   * guarded — so neither a failed write nor a sink that throws can become the error the caller
   * propagates in place of the resolver's.
   *
   * NEVER OVERWRITES A HEADER SOMEONE ELSE WROTE. `ensureRun` reports whether it created the row, and
   * the terminal patch is applied only to a row this path created or to one that CARRIES THIS PATH'S
   * OWN MARK — `status = terminal_failure` AND `error.code = WORKFLOW_RESOLVE_FAILED_CODE`, the code
   * no other writer sets (the engine's `finalizeRun` passes the first failed NODE's error). That
   * property is on the row itself, so it is decidable from what was read; re-applying the patch to
   * such a row keeps a DBOS re-invocation idempotent. Every other pre-existing header — including one
   * the ENGINE settled at `terminal_failure`, reachable via a crash mid-`engine.execute` followed by a
   * recovery re-invocation against a document that no longer carries the workflow — is left exactly as
   * it is, because `finalizeRun` is a plain UPDATE and would replace its real `attempts` / `resumable`
   * / `error` with this failure's zeroes while `workflow_node_states` still holds the attempts.
   */
  async #journalResolveFailure(
    journal: TenantDbWorkflowJournalStore,
    job: WorkflowJob,
    err: unknown,
  ): Promise<void> {
    let line: string;
    try {
      const { run, created } = await journal.ensureRun({
        workflowRunId: job.workflowRunId,
        workflowId: job.workflowId,
        idempotencyKey: job.idempotencyKey,
        // `trigger_event` is NOT NULL with no default, and its only other writer fills it from the
        // COMPILED spec's `workflow.trigger.event` — which the failed resolver never returned. The
        // engine refuses any run whose `workflow.trigger.event` differs from the event's type, so for
        // every job that could have executed these are the same string; use the one the job carries.
        triggerEvent: job.event.type,
        inputEvent: job.event,
      });
      // A header this call did not create belongs to an earlier execution of the run: leave it, and
      // say so on the log surface. The one exception is a row already carrying THIS path's own mark
      // (`terminal_failure` + `workflow_resolve_failed`) — no other writer produces that pair, so
      // re-applying the patch to it keeps a DBOS re-invocation idempotent. A `terminal_failure` the
      // ENGINE wrote carries a NODE's error code and its real `attempts`, so the check below keeps it.
      const isOwnSettledHeader =
        run.status === 'terminal_failure' && run.error?.code === WORKFLOW_RESOLVE_FAILED_CODE;
      if (!created && !isOwnSettledHeader) {
        line = workflowResolveFailureHeaderKeptLog(job, run.status);
      } else {
        // ensureRun hard-codes status `running`; the terminal state is the finalize patch.
        // `attempts:0` is exact for the row this line can reach: it was created just above, or it
        // carries this path's own mark — no engine was built on either, so no node was ever attempted.
        await journal.finalizeRun(job.workflowRunId, {
          status: 'terminal_failure',
          resumable: false,
          error: {
            code: WORKFLOW_RESOLVE_FAILED_CODE,
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          },
          attempts: 0,
        });
        line = workflowResolveFailureLog(job);
      }
    } catch (journalErr) {
      line = workflowResolveFailureJournalFailedLog(job, journalErr);
    }
    try {
      this.#logger.warn(line);
    } catch {
      // A sink that throws — an injected logger, or `console.warn` on a closed stream — must not
      // become the error the caller propagates: the caller's very next statement rethrows the
      // ORIGINAL resolver error, and that is the error that matters. Nothing escapes here.
    }
  }

  /**
   * Enqueue (or dedup) a durable workflow run — the `WorkflowEnqueuer` seam the trigger dispatcher
   * calls. The DBOS workflowID is the tenant-namespaced `durableWorkflowRunId`, so a redelivery /
   * concurrent enqueue of the same `(tenant, workflow, idempotency)` dedups to one workflow (single-flight).
   */
  async enqueueWorkflowRun(input: {
    tenantId: string;
    workflow: WorkflowSpec;
    event: WorkflowInputEvent;
    idempotencyKey: string;
  }): Promise<{ workflowRunId: string; deduped: boolean }> {
    if (!this.#runWorkflowJob) {
      throw new Error(
        'DbosWorkflowExecutor.enqueueWorkflowRun called before registerWorkflowJob()/launch.',
      );
    }
    const workflowRunId = durableWorkflowRunId(
      input.tenantId,
      input.workflow.id,
      input.idempotencyKey,
    );

    // Best-effort dedup detection: a workflow already exists for this id ⇒ deduped (DBOS.startWorkflow
    // with an existing workflowID is itself idempotent, so the single-flight holds regardless of a race).
    let deduped = false;
    try {
      const existing = await DBOS.getWorkflowStatus(workflowRunId);
      deduped = existing != null;
    } catch {
      deduped = false;
    }

    const job: WorkflowJob = {
      workflowRunId,
      tenantId: input.tenantId,
      workflowId: input.workflow.id,
      idempotencyKey: input.idempotencyKey,
      event: input.event,
    };
    await DBOS.startWorkflow(this.#runWorkflowJob, {
      workflowID: workflowRunId,
      queueName: WORKFLOW_RUNS_QUEUE,
    })(job);
    return { workflowRunId, deduped };
  }

  /** Read the neutral status of a workflow run (by its durable run id). */
  async status(workflowRunId: string): Promise<DurableJobStatus> {
    const status = await DBOS.getWorkflowStatus(workflowRunId);
    return toNeutralStatus(status?.status);
  }

  /**
   * DUR-HONESTY-2: reconcile a run's JOURNAL header against its DBOS liveness so a DEAD-LETTERED run
   * (DBOS gave up after `maxRecoveryAttempts` but the journal header is stuck `running`) is visible as
   * `stalled` rather than looking forever-live. Tenant-scoped (reads the header through the chokepoint).
   */
  async liveness(tenantId: string, workflowRunId: string): Promise<WorkflowRunLiveness> {
    const tdb = forTenant(this.#deps.db, tenantId);
    const view = await new TenantDbWorkflowJournalStore(tdb).loadRun(workflowRunId);
    const journalStatus: WorkflowRunStatus | 'absent' = view ? view.run.status : 'absent';
    const dbosStatus = await this.status(workflowRunId);
    return reconcileWorkflowLiveness(journalStatus, dbosStatus);
  }

  /** A fresh random idempotency key (for a caller that wants an at-most-once ad-hoc run, no dedup). */
  static freshIdempotencyKey(): string {
    return randomUUID();
  }
}
