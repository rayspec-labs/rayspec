/**
 * `DbosTaskScheduler` — the durable task engine's dispatcher: one DBOS workflow per dispatched
 * turn, on the engine every other durable path here already runs on.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DISPATCH LAW — the workflow id IS the claim; the reserve pass WRITES NOTHING to dispatch.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The cron scheduler commits its reserve row BEFORE dispatch and honestly documents the resulting
 * crash window (reserve committed, dispatch lost ⇒ the occurrence is dropped). A task cannot
 * accept that trade: a dropped turn dispatch would strand a row. So the turn dispatcher inverts
 * the order — the reserve pass only computes candidates and calls `DBOS.startWorkflow` with the
 * DETERMINISTIC id `wf-task-turn:<taskId>:<turnNumber>:<version>`; the workflow-id idempotency law
 * (same id ⇒ at most one workflow — the same law the run surface leans on) dedupes racing
 * schedulers and repeated passes at the engine, and a crash before `startWorkflow` leaves the task
 * untouched in `queued` for the next pass. The id carries the row VERSION so a dispatch attempt
 * that ended without consuming a turn (a budget denial that parked the task; a later
 * `budget_raised` re-queue) mints a FRESH id — an id is never reused for a new attempt, and a
 * stale one dedupes into the attempt that already ran.
 *
 * The workflow BODY owns every write, so it is crash-safe under whole-body re-execution:
 *   1. ONE claim transaction: the receipt check (a re-execution whose final transaction committed
 *      no-ops), the `queued -> working` compare-and-swap (the true reserve — racing claimers lose
 *      the version CAS), the BUDGET AUTHORIZATION (inside the same transaction, task row locked
 *      first, so a denied or crashed claim leaks no reservation), and the turn_started journal
 *      entry. A denial rolls the claim back and parks the task `blocked(budget_exhausted)` with
 *      the declared exhaustion policy applied.
 *   2. The handler — an EFFECT-FREE turn function resolved by the task's owner; it returns one
 *      typed intent and never touches the database.
 *   3. The final application (`applyTurnOutcome`): intents + settlement + transition + the
 *      receipt, one transaction, idempotent under re-execution.
 * DBOS's default recovery re-executes a PENDING body from the top with exactly these guards, so
 * `maxRecoveryAttempts` stays at the engine default — turns are safely re-executable.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * CONCURRENCY IS A QUEUE, NOT A STATE.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `maxConcurrentWorkers` (per workforce, per department) is enforced by the reserve pass simply
 * NOT DISPATCHING past the cap: a task at a saturated workforce stays `queued` — no transition,
 * no reservation, no journal event — and is picked up when a slot frees. The pass counts `working`
 * rows plus its own dispatches, so the cap holds within a pass; across racing passes the dedup
 * law prevents double dispatch, and the residual is a BOUNDED transient (a dispatched-but-not-yet-
 * claimed task still reads `queued` for one claim latency), never a lost or duplicated turn.
 *
 * A paused workforce is skipped wholesale at the pass — its tasks stay visibly `queued`, accruing
 * nothing (the pause lives on the workforce_runtime row, deliberately not a task status).
 *
 * The SWEEP (a second scheduled workflow) enforces the declared approval-timeout fates; wall-clock
 * and deadline ceilings are enforced at the dispatch boundary by the pass itself, which is the one
 * place a task can be denied without killing anything.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Db } from '@rayspec/db';
import { forTenant, schema, type TenantDb } from '@rayspec/db';
import {
  type ApprovalSweepOutcome,
  appendTaskEvents,
  applyBudgetExhausted,
  applyTransition,
  applyTurnOutcome,
  authorizeTurn,
  deliverSignal,
  ensureWorkforceRuntime,
  isTaskStatus,
  isTerminalStatus,
  type MergedChildResult,
  mergeChildResults,
  resolveWorkforceBudgets,
  sweepApprovalTimeouts,
  type TaskRecord,
  TaskVersionConflictError,
  type TurnPlan,
  type WorkforceBudgets,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import { and, desc, eq, inArray } from 'drizzle-orm';

/** The DBOS queue turn workflows run on (worker-concurrency capped like the run queue). */
export const WORKFORCE_TURNS_QUEUE = 'workforce-turns';

export const TASK_TURN_WORKFLOW_NAME = 'workforceTaskTurn';
export const TASK_RESERVE_WORKFLOW_NAME = 'workforce:task-reserve';
export const TASK_SWEEP_WORKFLOW_NAME = 'workforce:task-sweep';

/** Every 5 seconds: dispatch latency for a queued task. DBOS crontabs carry a seconds field. */
export const DEFAULT_TASK_RESERVE_SCHEDULE = '*/5 * * * * *';
/** Every 30 seconds: approval-timeout enforcement latency. */
export const DEFAULT_TASK_SWEEP_SCHEDULE = '*/30 * * * * *';

const DEFAULT_TURN_QUEUE_CONCURRENCY = 4;

/** The deterministic dispatch claim (see the header: version-salted, never reused). */
export function taskTurnWorkflowId(taskId: string, turnNumber: number, version: number): string {
  return `wf-task-turn:${taskId}:${turnNumber}:${version}`;
}

export interface TaskTurnJob {
  readonly tenantId: string;
  readonly taskId: string;
  readonly turnNumber: number;
}

/** The read-only context a turn handler receives. Everything in it is DATA, never instructions. */
export interface TaskTurnContext {
  readonly task: TaskRecord;
  /** Terminal children's results keyed by CHILD TASK ID — never ordered by completion. */
  readonly childResults: Readonly<Record<string, MergedChildResult>> | null;
  /** The task's signal history, oldest first (the wake that re-queued it is in here). */
  readonly signals: readonly (typeof schema.workforceTaskSignals.$inferSelect)[];
  /** Recent task-scoped messages, oldest first. */
  readonly messages: readonly (typeof schema.workforceMessages.$inferSelect)[];
}

export interface TaskTurnHandlerOutcome {
  /** The ONE turn-ending intent (validated by the engine — a malformed one never completes). */
  readonly intent: unknown;
  readonly messages?: readonly { readonly recipient: string; readonly body: string }[];
  /** The turn's actual cost, settled against the dispatch reservation. */
  readonly actualUsd?: number;
}

/**
 * A turn handler is EFFECT-FREE: it computes an intent from the context and returns. Any durable
 * effect it wants happens through the intent the engine applies — never directly.
 */
export type TaskTurnHandler = (ctx: TaskTurnContext) => Promise<TaskTurnHandlerOutcome>;

export type ResolveTurnHandler = (owner: string) => TaskTurnHandler | undefined;

export interface TaskSchedulerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TaskSchedulerDeps {
  /** The worker's raw handle — held ONLY to bind forTenant(db, tenantId) per pass/turn. */
  readonly db: Db;
  /**
   * The one deployment tenant this scheduler serves (the same single-tenant posture as the cron
   * scheduler's fire tenant). The chokepoint binds every read and write to it.
   */
  readonly tenantId: string;
  /** Probe BEFORE any pass writes — a not-yet-provisioned tenant must skip loudly, not FK-crash. */
  readonly tenantExists: (tenantId: string) => Promise<boolean>;
  /** Resolve a task owner to its turn handler; an unresolved owner fails the task typed. */
  readonly resolveTurnHandler: ResolveTurnHandler;
  readonly logger?: TaskSchedulerLogger;
  readonly reserveSchedule?: string;
  readonly sweepSchedule?: string;
  readonly turnQueueConcurrency?: number;
  /** Injectable clock for the sweep/window tests. */
  readonly now?: () => Date;
}

export interface ReservePassOutcome {
  /** planned -> queued promotions this pass applied. */
  readonly promoted: string[];
  /** Turn workflows started (or deduped into an existing start) this pass. */
  readonly dispatched: { taskId: string; turnNumber: number }[];
  /** Candidates left `queued` untouched because a concurrency cap was saturated. */
  readonly saturated: number;
  /** Tasks parked blocked(deadline_exceeded) at the boundary this pass. */
  readonly expired: string[];
  /** Candidates skipped because their workforce is paused. */
  readonly paused: number;
}

const CONSOLE_LOGGER: TaskSchedulerLogger = {
  info: (m) => console.info(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const EMPTY_BUDGETS = workforceBudgetsSchema.parse({});

/** Thrown inside the claim transaction to roll a denied authorization back; never escapes. */
class ClaimDenied extends Error {
  readonly denial: { scopeKind: string; scopeId: string; ceiling: unknown; consumed: number };
  constructor(denial: ClaimDenied['denial']) {
    super('turn claim denied by the budget authorization — rolling the claim back.');
    this.name = 'ClaimDenied';
    this.denial = denial;
  }
}

export class DbosTaskScheduler {
  readonly #deps: TaskSchedulerDeps;
  readonly #logger: TaskSchedulerLogger;
  #registered = false;
  #turnWorkflow?: (job: TaskTurnJob) => Promise<void>;
  #kickInFlight = false;

  constructor(deps: TaskSchedulerDeps) {
    this.#deps = deps;
    this.#logger = deps.logger ?? CONSOLE_LOGGER;
  }

  #now(): Date {
    return this.#deps.now ? this.#deps.now() : new Date();
  }

  /**
   * Register the turn workflow + the two scheduled workflows (reserve tick, sweep tick). MUST run
   * in the executor's pre-launch window (`attachPreLaunchHook`). Idempotent.
   */
  registerScheduledWorkflows(): void {
    if (this.#registered) return;
    this.#turnWorkflow = DBOS.registerWorkflow((job: TaskTurnJob) => this.#turnBody(job), {
      name: TASK_TURN_WORKFLOW_NAME,
    });
    const reserveBody = DBOS.registerWorkflow(
      async (_scheduledTime: Date): Promise<void> => {
        await this.runReservePass();
      },
      { name: TASK_RESERVE_WORKFLOW_NAME },
    );
    DBOS.registerScheduled(reserveBody as (s: Date, a: Date) => Promise<void>, {
      name: TASK_RESERVE_WORKFLOW_NAME,
      crontab: this.#deps.reserveSchedule ?? DEFAULT_TASK_RESERVE_SCHEDULE,
    });
    const sweepBody = DBOS.registerWorkflow(
      async (_scheduledTime: Date): Promise<void> => {
        await this.runSweep();
      },
      { name: TASK_SWEEP_WORKFLOW_NAME },
    );
    DBOS.registerScheduled(sweepBody as (s: Date, a: Date) => Promise<void>, {
      name: TASK_SWEEP_WORKFLOW_NAME,
      crontab: this.#deps.sweepSchedule ?? DEFAULT_TASK_SWEEP_SCHEDULE,
    });
    this.#registered = true;
  }

  /**
   * Register the turn queue. `DBOS.registerQueue` is DB-backed and requires a LAUNCHED engine, so
   * the composition root calls this AFTER `executor.start()` (mirrors the run queue's placement in
   * the executor's own start). `onConflict:'always_update'` for the same per-document-version
   * reason the run queue carries it.
   */
  async registerQueue(): Promise<void> {
    await DBOS.registerQueue(WORKFORCE_TURNS_QUEUE, {
      workerConcurrency: this.#deps.turnQueueConcurrency ?? DEFAULT_TURN_QUEUE_CONCURRENCY,
      onConflict: 'always_update',
    });
  }

  /**
   * Nudge the scheduler after a state change a route just made (a signal, an approval decision, a
   * resume) — one coalesced pass on the next tick instead of waiting for the cron tick. Best-effort
   * by design: the scheduled tick is the guarantee, the kick is the latency.
   */
  kick(): void {
    if (this.#kickInFlight) return;
    this.#kickInFlight = true;
    queueMicrotask(() => {
      void this.runReservePass()
        .catch((err) => {
          this.#logger.warn(`[workforce] kicked reserve pass failed: ${String(err)}`);
        })
        .finally(() => {
          this.#kickInFlight = false;
        });
    });
  }

  /**
   * ONE reserve pass. Promotes dependency-satisfied `planned` rows through the one door, skips
   * paused workforces and saturated caps (silently — that is the contract), parks boundary-expired
   * tasks, and starts a turn workflow per remaining candidate. Deterministic seam for tests; the
   * scheduled tick calls exactly this.
   */
  async runReservePass(): Promise<ReservePassOutcome> {
    const outcome: {
      promoted: string[];
      dispatched: { taskId: string; turnNumber: number }[];
      saturated: number;
      expired: string[];
      paused: number;
    } = { promoted: [], dispatched: [], saturated: 0, expired: [], paused: 0 };
    if (!(await this.#deps.tenantExists(this.#deps.tenantId))) {
      this.#logger.warn(
        `[workforce] reserve pass skipped: tenant ${this.#deps.tenantId} does not exist yet (provision the org, then the pass resumes).`,
      );
      return outcome;
    }
    const tdb = forTenant(this.#deps.db, this.#deps.tenantId);
    const now = this.#now();

    await this.#promotePlanned(tdb, outcome);
    await this.#wakeDependencySatisfied(tdb);

    const queued = (await tdb
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.status, 'queued'))) as TaskRecord[];
    if (queued.length === 0) return outcome;
    const working = (await tdb
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.status, 'working'))) as TaskRecord[];

    const workforceCount = new Map<string, number>();
    const departmentCount = new Map<string, number>();
    for (const t of working) {
      const wf = t.workforceId ?? '';
      workforceCount.set(wf, (workforceCount.get(wf) ?? 0) + 1);
      if (t.department !== null) {
        const key = `${wf}/${t.department}`;
        departmentCount.set(key, (departmentCount.get(key) ?? 0) + 1);
      }
    }

    const budgetsCache = new Map<string, { paused: boolean; budgets: WorkforceBudgets }>();
    const candidates = [...queued].sort(
      (a, b) =>
        (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) ||
        (a.queuedAt?.getTime() ?? 0) - (b.queuedAt?.getTime() ?? 0),
    );

    for (const task of candidates) {
      try {
        const wf = task.workforceId;
        let paused = false;
        let budgets = EMPTY_BUDGETS;
        if (wf !== null) {
          let entry = budgetsCache.get(wf);
          if (!entry) {
            const runtime = await ensureWorkforceRuntime(tdb, wf);
            entry = {
              paused: runtime.paused,
              budgets: resolveWorkforceBudgets(runtime.budgets, wf),
            };
            budgetsCache.set(wf, entry);
          }
          paused = entry.paused;
          budgets = entry.budgets;
        }
        if (paused) {
          outcome.paused++;
          continue; // the pause lives on the workforce row; the task stays visibly queued
        }

        const wfKey = wf ?? '';
        const cap = budgets.execution.maxConcurrentWorkers ?? null;
        if (cap !== null && (workforceCount.get(wfKey) ?? 0) >= cap) {
          outcome.saturated++;
          continue; // a queue, not a state: no transition, no reservation, no event
        }
        const depCap =
          task.department !== null
            ? (budgets.departments?.[task.department]?.maxConcurrentWorkers ?? null)
            : null;
        const depKey = `${wfKey}/${task.department}`;
        if (depCap !== null && (departmentCount.get(depKey) ?? 0) >= depCap) {
          outcome.saturated++;
          continue;
        }

        const wallMs = budgets.execution.maxTaskWallClockMs ?? null;
        const wallExpired =
          wallMs !== null &&
          task.startedAt !== null &&
          now.getTime() - task.startedAt.getTime() > wallMs;
        const deadlineExpired =
          task.deadlineAt !== null && task.deadlineAt.getTime() < now.getTime();
        if (wallExpired || deadlineExpired) {
          try {
            await applyTransition(tdb, {
              taskId: task.taskId,
              expectedVersion: task.version,
              to: 'blocked',
              reason: 'deadline_exceeded',
              actor: 'scheduler',
            });
            outcome.expired.push(task.taskId);
          } catch (err) {
            if (!(err instanceof TaskVersionConflictError)) throw err;
          }
          continue;
        }

        const turnNumber = task.turnsUsed + 1;
        if (!this.#turnWorkflow) {
          throw new Error(
            'DbosTaskScheduler.runReservePass before registerScheduledWorkflows() — the turn workflow is not registered. Fail-closed.',
          );
        }
        const workflowId = await this.#resolveDispatchId(
          taskTurnWorkflowId(task.taskId, turnNumber, task.version),
        );
        if (workflowId === undefined) continue; // salted out — logged inside, next pass retries
        await DBOS.startWorkflow(this.#turnWorkflow, {
          workflowID: workflowId,
          queueName: WORKFORCE_TURNS_QUEUE,
        })({ tenantId: this.#deps.tenantId, taskId: task.taskId, turnNumber });
        outcome.dispatched.push({ taskId: task.taskId, turnNumber });
        workforceCount.set(wfKey, (workforceCount.get(wfKey) ?? 0) + 1);
        if (task.department !== null) {
          departmentCount.set(depKey, (departmentCount.get(depKey) ?? 0) + 1);
        }
      } catch (err) {
        // One candidate's failure must not wedge the pass for the rest.
        this.#logger.error(`[workforce] reserve pass: task ${task.taskId} errored: ${String(err)}`);
      }
    }
    return outcome;
  }

  /**
   * Resolve the dispatch id for a candidate, salting PAST dead prior attempts. The base id is
   * deterministic in (task, turn, version) so racing passes dedupe — but an attempt that DIED
   * without moving the row (an unexpected throw inside the claim leaves the workflow ERRORED and
   * the task still `queued` at the same version) would otherwise consume the id forever: every
   * later pass would mint the identical id and dedupe into the corpse. So the pass probes the
   * engine: a live attempt (PENDING/ENQUEUED) or an unused id dispatches as-is (dedup handles the
   * live case); a TERMINAL status appends a retry salt and probes again — self-healing, and still
   * deterministic across racing schedulers (both walk the same salt sequence). A bounded walk;
   * past the bound the candidate is skipped loudly for this pass.
   */
  async #resolveDispatchId(baseId: string): Promise<string | undefined> {
    const MAX_SALT = 50;
    for (let attempt = 0; attempt <= MAX_SALT; attempt++) {
      const id = attempt === 0 ? baseId : `${baseId}:r${attempt}`;
      const status = await DBOS.getWorkflowStatus(id);
      if (status === null) return id; // unused — this attempt's claim
      if (status.status === 'PENDING' || status.status === 'ENQUEUED') return id; // live — dedup
      // Terminal (ERROR / CANCELLED / SUCCESS-without-moving-the-row / recovery-exceeded): dead.
    }
    this.#logger.error(
      `[workforce] dispatch id ${baseId} has ${MAX_SALT} dead attempts — skipping this pass (fail-loud; investigate the turn workflow's failures).`,
    );
    return undefined;
  }

  /** planned -> queued when every dependency is completed; -> blocked(awaiting_dependency) else. */
  async #promotePlanned(tdb: TenantDb, outcome: { promoted: string[] }): Promise<void> {
    const planned = (await tdb
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.status, 'planned'))) as TaskRecord[];
    for (const task of planned) {
      try {
        const deps = Array.isArray(task.dependencies) ? (task.dependencies as string[]) : [];
        const satisfied = await this.#dependenciesCompleted(tdb, deps);
        if (satisfied) {
          await applyTransition(tdb, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'queued',
            actor: 'scheduler',
          });
          outcome.promoted.push(task.taskId);
        } else {
          await applyTransition(tdb, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'blocked',
            reason: 'awaiting_dependency',
            actor: 'scheduler',
          });
        }
      } catch (err) {
        if (!(err instanceof TaskVersionConflictError)) {
          this.#logger.error(`[workforce] promote ${task.taskId} errored: ${String(err)}`);
        }
      }
    }
  }

  /** Wake blocked(awaiting_dependency) rows whose dependencies have since completed. */
  async #wakeDependencySatisfied(tdb: TenantDb): Promise<void> {
    const parked = (await tdb
      .select(schema.workforceTasks)
      .where(
        and(
          eq(schema.workforceTasks.status, 'blocked'),
          eq(schema.workforceTasks.statusReason, 'awaiting_dependency'),
        ),
      )) as TaskRecord[];
    for (const task of parked) {
      const deps = Array.isArray(task.dependencies) ? (task.dependencies as string[]) : [];
      if (!(await this.#dependenciesCompleted(tdb, deps))) continue;
      await deliverSignal(tdb, {
        taskId: task.taskId,
        kind: 'dependency_completed',
        signalKey: `deps:${task.taskId}`,
        actor: 'scheduler',
      });
    }
  }

  async #dependenciesCompleted(tdb: TenantDb, deps: readonly string[]): Promise<boolean> {
    if (deps.length === 0) return true;
    const rows = (await tdb
      .select(schema.workforceTasks)
      .where(inArray(schema.workforceTasks.taskId, [...deps]))) as TaskRecord[];
    return rows.length === deps.length && rows.every((r) => r.status === 'completed');
  }

  /**
   * The sweep: enforce every overdue approval's declared fate, then REAP dead turns. A claim that
   * committed (`working`) whose workflow later died (an ERROR, a cancellation, an exceeded
   * recovery bound) would otherwise hold its row — and a `maxConcurrentWorkers` slot, and every
   * drain — forever. The reaper asks the ENGINE whether the claim's own workflow id is still live
   * (PENDING/ENQUEUED); a dead one re-queues the task through the one door (handlers are
   * effect-free and the receipt guards double application, so a fresh dispatch of the same turn is
   * safe). A LIVE turn is never touched, however long it runs — nothing is killed mid-flight.
   * Deterministic seam for tests.
   */
  async runSweep(): Promise<ApprovalSweepOutcome & { reaped: string[] }> {
    if (!(await this.#deps.tenantExists(this.#deps.tenantId))) {
      return { failed: [], escalated: [], reaped: [] };
    }
    const tdb = forTenant(this.#deps.db, this.#deps.tenantId);
    const approvals = await sweepApprovalTimeouts(tdb, this.#now());
    const reaped: string[] = [];
    const working = (await tdb
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.status, 'working'))) as TaskRecord[];
    for (const task of working) {
      try {
        const claimRows = (await tdb
          .select(schema.workforceTaskTransitions)
          .where(
            and(
              eq(schema.workforceTaskTransitions.taskId, task.taskId),
              eq(schema.workforceTaskTransitions.toStatus, 'working'),
            ),
          )
          .orderBy(desc(schema.workforceTaskTransitions.createdAt))
          .limit(1)) as (typeof schema.workforceTaskTransitions.$inferSelect)[];
        const turnId = claimRows[0]?.turnId;
        if (!turnId) continue; // no claim record — not this dispatcher's row to judge
        const status = await DBOS.getWorkflowStatus(turnId);
        const live =
          status !== null && (status.status === 'PENDING' || status.status === 'ENQUEUED');
        if (live) continue;
        await applyTransition(tdb, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'queued',
          reason: 'tool_error',
          actor: 'scheduler',
          queueReason: 'turn_reaped',
        });
        reaped.push(task.taskId);
        this.#logger.warn(
          `[workforce] reaped task ${task.taskId}: its turn workflow ${turnId} is ${status?.status ?? 'absent'} — re-queued for a fresh dispatch.`,
        );
      } catch (err) {
        if (!(err instanceof TaskVersionConflictError)) {
          this.#logger.error(`[workforce] reap ${task.taskId} errored: ${String(err)}`);
        }
      }
    }
    return { ...approvals, reaped };
  }

  /**
   * The turn workflow body — ONE step (no in-step retry), re-executed from the top on recovery.
   * See the header for the claim/handler/apply protocol and why each piece is idempotent.
   */
  async #turnBody(job: TaskTurnJob): Promise<void> {
    // The workflow's OWN id (salt included) — captured in workflow context, stamped on the claim,
    // and what a recovery verifies against: a stale dispatch for the same (task, turn) under a
    // DIFFERENT id must no-op instead of mistaking another attempt's claim for its own.
    const myWorkflowId = DBOS.workflowID ?? taskTurnWorkflowId(job.taskId, job.turnNumber, -1);
    await DBOS.runStep(
      async () => {
        const tdb = forTenant(this.#deps.db, job.tenantId);
        const claim = await this.#claimTurn(tdb, job, myWorkflowId);
        if (claim.kind !== 'claimed') return;
        const { task, budgets } = claim;

        const ctx = await this.#assembleContext(tdb, task);
        let outcome: TaskTurnHandlerOutcome;
        const handler = this.#deps.resolveTurnHandler(task.owner);
        if (!handler) {
          outcome = {
            intent: {
              kind: 'fail',
              message: `no turn handler is registered for owner '${task.owner}' — the task cannot execute. Fail-closed.`,
            },
          };
        } else {
          try {
            outcome = await handler(ctx);
          } catch (err) {
            outcome = {
              intent: {
                kind: 'fail',
                message: `turn handler for owner '${task.owner}' threw: ${err instanceof Error ? err.message : String(err)}`,
              },
            };
          }
        }

        let applied: Awaited<ReturnType<typeof applyTurnOutcome>>;
        try {
          applied = await applyTurnOutcome(tdb, {
            taskId: task.taskId,
            turnId: myWorkflowId,
            turnNumber: job.turnNumber,
            intent: outcome.intent,
            messages: outcome.messages,
            budgets,
            actualUsd: outcome.actualUsd ?? 0,
          });
        } catch (err) {
          // Losing a version race at the very end (a cancel cascade, an operator move) is a clean
          // no-op ONLY when the turn's receipt exists — someone applied this turn. Anything else
          // stays loud (the workflow records the error; the sweep's reaper re-queues the row).
          if (err instanceof TaskVersionConflictError) {
            const receipt = await tdb
              .select(schema.workforceTaskTransitions, { id: schema.workforceTaskTransitions.id })
              .where(
                and(
                  eq(schema.workforceTaskTransitions.taskId, job.taskId),
                  eq(schema.workforceTaskTransitions.turnNumber, job.turnNumber),
                ),
              );
            if (receipt.length > 0) {
              this.#logger.info(
                `[workforce] task ${job.taskId} turn ${job.turnNumber}: lost the final race to an applied receipt — clean no-op.`,
              );
              return;
            }
          }
          throw err;
        }
        this.#logTurn(task, job.turnNumber, applied.plan);
      },
      { name: 'taskTurn', retriesAllowed: false },
    );
  }

  /**
   * The claim transaction (protocol step 1). Returns `claimed` with the working row, or a no-op
   * verdict a recovered/stale/denied execution exits on.
   */
  async #claimTurn(
    tdb: TenantDb,
    job: TaskTurnJob,
    myWorkflowId: string,
  ): Promise<{ kind: 'claimed'; task: TaskRecord; budgets: WorkforceBudgets } | { kind: 'noop' }> {
    try {
      return await tdb.transaction(async (tx) => {
        const receipt = await tx
          .select(schema.workforceTaskTransitions, { id: schema.workforceTaskTransitions.id })
          .where(
            and(
              eq(schema.workforceTaskTransitions.taskId, job.taskId),
              eq(schema.workforceTaskTransitions.turnNumber, job.turnNumber),
            ),
          );
        if (receipt.length > 0) return { kind: 'noop' as const };

        const rows = (await tx
          .select(schema.workforceTasks)
          .where(eq(schema.workforceTasks.taskId, job.taskId))) as TaskRecord[];
        const task = rows[0];
        if (!task || !isTaskStatus(task.status)) return { kind: 'noop' as const };
        if (task.turnsUsed !== job.turnNumber - 1) return { kind: 'noop' as const };

        const budgets =
          task.workforceId !== null
            ? resolveWorkforceBudgets(
                (await ensureWorkforceRuntime(tx, task.workforceId)).budgets,
                task.workforceId,
              )
            : EMPTY_BUDGETS;

        if (task.status === 'working') {
          // A committed claim with no receipt. It is OURS only if the claim row carries THIS
          // workflow's id — a stale dispatch under a different id (expiry + manual_unblock can
          // legitimately mint one for the same turn number) must no-op here, or two live
          // executions would run one turn's handler concurrently.
          const claimRows = (await tx
            .select(schema.workforceTaskTransitions)
            .where(
              and(
                eq(schema.workforceTaskTransitions.taskId, job.taskId),
                eq(schema.workforceTaskTransitions.toStatus, 'working'),
              ),
            )
            .orderBy(desc(schema.workforceTaskTransitions.createdAt))
            .limit(1)) as (typeof schema.workforceTaskTransitions.$inferSelect)[];
          if (claimRows[0]?.turnId !== myWorkflowId) return { kind: 'noop' as const };
          // Recovery of OUR claim: the reservation exists, the turn_started entry exists —
          // re-run the handler and apply.
          return { kind: 'claimed' as const, task, budgets };
        }
        if (task.status !== 'queued') return { kind: 'noop' as const };

        const working = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'working',
          actor: 'scheduler',
          turnId: myWorkflowId,
        });

        const decision = await authorizeTurn(
          tx,
          budgets,
          {
            taskId: task.taskId,
            rootTaskId: task.rootTaskId,
            workforceId: task.workforceId,
            department: task.department,
            estimateUsd: budgets.execution.estimateUsdPerTurn,
          },
          this.#now(),
        );
        if (!decision.allowed) throw new ClaimDenied(decision.denial);

        await appendTaskEvents(tx, task.taskId, [
          {
            type: 'workforce.budget.reserved',
            payload: {
              taskId: task.taskId,
              turnNumber: job.turnNumber,
              estimateUsd: budgets.execution.estimateUsdPerTurn,
            },
          },
          {
            type: 'workforce.task.turn_started',
            payload: {
              taskId: task.taskId,
              turnNumber: job.turnNumber,
              turnId: myWorkflowId,
              owner: task.owner,
            },
          },
        ]);
        return { kind: 'claimed' as const, task: working, budgets };
      });
    } catch (err) {
      if (err instanceof ClaimDenied) {
        await this.#parkDenied(tdb, job, err.denial);
        return { kind: 'noop' };
      }
      if (err instanceof TaskVersionConflictError) return { kind: 'noop' };
      throw err;
    }
  }

  /** The claim rolled back on a denial: park the (still queued) task with the typed reason. */
  async #parkDenied(tdb: TenantDb, job: TaskTurnJob, denial: ClaimDenied['denial']): Promise<void> {
    await tdb.transaction(async (tx) => {
      const rows = (await tx
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.taskId, job.taskId))) as TaskRecord[];
      const task = rows[0];
      if (task?.status !== 'queued') return;
      const budgets =
        task.workforceId !== null
          ? resolveWorkforceBudgets(
              (await ensureWorkforceRuntime(tx, task.workforceId)).budgets,
              task.workforceId,
            )
          : EMPTY_BUDGETS;
      await applyBudgetExhausted(tx, task, denial, budgets, { actor: 'scheduler' });
    });
  }

  /** Assemble the read-only handler context (protocol step 2's input). */
  async #assembleContext(tdb: TenantDb, task: TaskRecord): Promise<TaskTurnContext> {
    const children = (await tdb
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.parentTaskId, task.taskId))) as TaskRecord[];
    const terminalChildren = children.filter(
      (c) => isTaskStatus(c.status) && isTerminalStatus(c.status),
    );
    const signals = (await tdb
      .select(schema.workforceTaskSignals)
      .where(
        eq(schema.workforceTaskSignals.taskId, task.taskId),
      )) as (typeof schema.workforceTaskSignals.$inferSelect)[];
    const messages = (await tdb
      .select(schema.workforceMessages)
      .where(
        eq(schema.workforceMessages.taskId, task.taskId),
      )) as (typeof schema.workforceMessages.$inferSelect)[];
    return {
      task,
      childResults:
        terminalChildren.length > 0 ? mergeChildResults(terminalChildren).byChildId : null,
      signals: signals.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      messages: messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    };
  }

  #logTurn(task: TaskRecord, turnNumber: number, plan: TurnPlan | null): void {
    this.#logger.info(
      `[workforce] task ${task.taskId} turn ${turnNumber} (owner ${task.owner}) -> ${plan?.kind ?? 'already-applied'}`,
    );
  }
}
