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
 * SINGLE-FLIGHT + DURABILITY (C10 + honest resume).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The DBOS `workflowID` IS the tenant-namespaced `durableWorkflowRunId(tenant, workflowId,
 * idempotencyKey)`, so DBOS's own workflow-id idempotency law dedups a redelivered / concurrent
 * enqueue to exactly one workflow (C10). On a crash mid-run, DBOS re-invokes the workflow → the ONE
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
  readonly #workerConcurrency: number;
  #registered = false;
  #launched = false;
  #runWorkflowJob?: (job: WorkflowJob) => Promise<void>;

  constructor(deps: DbosWorkflowExecutorDeps, config: { workerConcurrency?: number } = {}) {
    this.#deps = deps;
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
    await DBOS.registerQueue(WORKFLOW_RUNS_QUEUE, { workerConcurrency: this.#workerConcurrency });
    this.#launched = true;
  }

  async #runWorkflowJobBody(job: WorkflowJob): Promise<void> {
    await DBOS.runStep(
      async () => {
        const tdb = forTenant(this.#deps.db, job.tenantId);
        const resolved = this.#deps.resolveWorkflowRun(job, tdb);
        const engine = new DurableWorkflowEngine({
          journal: new TenantDbWorkflowJournalStore(tdb),
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
   * Enqueue (or dedup) a durable workflow run — the `WorkflowEnqueuer` seam the trigger dispatcher
   * calls. The DBOS workflowID is the tenant-namespaced `durableWorkflowRunId`, so a redelivery /
   * concurrent enqueue of the same `(tenant, workflow, idempotency)` dedups to one workflow (C10).
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
