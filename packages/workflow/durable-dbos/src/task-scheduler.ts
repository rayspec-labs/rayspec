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
 * rows plus its own dispatches, so the cap holds WITHIN a pass.
 *
 * ACROSS passes it can OVERSHOOT, and the honest statement is not "a bounded transient": a pass
 * counts `working` rows, and a task it dispatched is not `working` until its claim commits, so two
 * passes that overlap in that window each see the same count and each admit up to the cap. In one
 * process the scheduled tick and a route's `kick()` are coalesced (`#passCoalesced`) so they cannot
 * overlap; ACROSS WORKER PROCESSES nothing in this file can prevent it, and observed concurrency
 * may reach (overlapping passes) × cap for one claim latency. What the dispatch law does guarantee
 * unconditionally is that no turn is lost and none is duplicated — the workflow id dedupes, and the
 * claim's compare-and-swap admits exactly one. Making the cap hard would take a reservation the
 * DATABASE counts (a claim-time counter row per scope, checked like the budget ledger), not a
 * tighter read.
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
  lockRootFirst,
  type MergedChildResult,
  mergeChildResults,
  releaseTurnReservation,
  resolveWorkforceBudgets,
  sweepApprovalTimeouts,
  type TaskRecord,
  TaskVersionConflictError,
  type TurnPlan,
  type WorkforceBudgets,
  workforceBudgetsSchema,
} from '@rayspec/tasks';
import { and, asc, desc, eq, inArray, isNull, notInArray, or, type SQL, sql } from 'drizzle-orm';

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
  /**
   * The TRUSTED review-policy match for a completing turn — computed by the dispatching
   * composition from declared rules, never from model output, and validated strictly by the
   * engine (`turnReviewPolicySchema`). Absent means no declared rule fired.
   */
  readonly reviewPolicy?: {
    readonly reviewer: string;
    readonly dispatchReviewer: boolean;
    readonly maxRounds: number;
  };
  /**
   * Children the turn BUFFERED for creation (the non-turn-ending create tools) — applied
   * atomically with the ending intent; validated strictly by the engine.
   */
  readonly createdChildren?: readonly {
    readonly title: string;
    readonly goal: string;
    readonly description?: string | null;
    readonly owner: string;
    readonly department?: string | null;
    readonly priority?: 'low' | 'normal' | 'high' | 'urgent';
    readonly delegatedTo?: string;
  }[];
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

/**
 * The dispatch rank, in SQL so a BOUNDED candidate scan pages in the order the pass dispatches in —
 * ordering by the `priority` text itself would put 'low' ahead of 'urgent', and a page taken in the
 * wrong order is a low-priority task jumping an urgent one that sat just outside it. A priority
 * outside the closed set sorts with `normal`, the same default the creation schema applies.
 */
const PRIORITY_RANK_SQL = sql`case ${schema.workforceTasks.priority}
  when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 when 'low' then 3 else 2 end`;

/**
 * Per-tick scan bounds. A pass is a BOUNDED unit of work over an unbounded table: it takes a page
 * in a deterministic order and the next tick (5s later) takes the rest — the alternative is one
 * pass materializing a tenant's whole task partition into process memory. Counts and cascades that
 * would be WRONG when truncated are aggregated in the database or documented as deliberate full
 * scans instead of being capped.
 *
 * A bound is only half the invariant. The other half is that the page must ADVANCE, and each scan
 * says which way it earns that: `#promotePlanned` because every row it examines leaves the set;
 * the dependency wake and the reaper because they carry a keyset cursor; the candidate page
 * because the scopes that cannot dispatch AT ALL this tick — paused, already at cap — are excluded
 * in SQL before the page is taken. A bounded scan whose rows can be skipped in place and is taken
 * from the top every tick is not a bound, it is a starvation window.
 *
 * The candidate page's guarantee is the WEAKEST of the four, and stated exactly: the exclusion is
 * computed ONCE, before the page, so it removes a workforce that was already saturated — but the
 * pass then FILLS the cap itself and skips the remainder of the page in place. A workforce with a
 * deep backlog and a small cap therefore still occupies page slots for the tick that fills its cap,
 * and delays the rest of the tenant by roughly (its backlog / page size) ticks before its rows stop
 * being drawn. That is a latency residual, not a permanent stall — the next tick sees it at cap and
 * excludes it — and closing it properly needs predicate-side saturation or cap-aware paging.
 */
export const RESERVE_SCAN_LIMIT = 500;
export const SWEEP_SCAN_LIMIT = 500;
/** How much of a task's own history a turn handler receives as context, newest kept. */
const CONTEXT_SIGNAL_LIMIT = 200;
const CONTEXT_MESSAGE_LIMIT = 200;

const EMPTY_BUDGETS = workforceBudgetsSchema.parse({});

/**
 * Where a task's declared dependencies stand. `decided` means at least one can never complete —
 * the dependent gets a typed failure rather than an unanswerable park.
 */
type DependencyVerdict =
  | { readonly kind: 'satisfied' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'decided'; readonly blockers: { taskId: string; status: string }[] };

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
  #passRunning = false;
  #passQueued = false;
  /**
   * Wrapping keyset cursors for the two BOUNDED scans whose rows may legitimately stay in the set:
   * a dependency park whose prerequisites are still pending, and a `working` row whose turn is
   * still alive. Both are examined, skipped, and still occupy the identical slot of the identical
   * page next tick — so past one page of them, nothing behind them is ever examined again. Each
   * scan therefore resumes from the last key it EXAMINED and resets when a short page says the set
   * is exhausted, which reaches every row within one cycle at the cost of one process-local field
   * rather than a schema column. A restart resets the cursor to the start of the order: a re-scan,
   * never a skip.
   */
  #dependencyWakeCursor: { key: Date; taskId: string } | null = null;
  #reapCursor: { key: Date; taskId: string } | null = null;

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
        await this.#passCoalesced();
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
   * resume) — one coalesced pass instead of waiting for the cron tick. Best-effort by design: the
   * scheduled tick is the guarantee, the kick is the latency.
   */
  kick(): void {
    queueMicrotask(() => {
      void this.#passCoalesced().catch((err) => {
        this.#logger.warn(`[workforce] kicked reserve pass failed: ${String(err)}`);
      });
    });
  }

  /**
   * Run a pass, never CONCURRENTLY with another pass THIS PROCESS started. The cap is counted per
   * pass (see the header), so a scheduled tick overlapping a route's kick would let each admit up
   * to it; both go through here instead. A nudge that arrives mid-pass is not dropped — it queues
   * exactly one follow-up, because the running pass may have read its state before it committed.
   * This closes the in-process half of the overshoot only; two worker processes still pass
   * independently, and the header says so.
   *
   * Under CONTINUOUS kicks the drain loop keeps running, so the scheduled reserve workflow that
   * entered it stays PENDING for as long as the kicks keep arriving. That is correct rather than a
   * leak — the work is genuinely being done, one pass at a time, and the alternative (returning and
   * letting the next tick pick it up) is the overlap this method exists to prevent — but it does
   * mean a PENDING reserve workflow is not by itself evidence of a stuck pass.
   */
  async #passCoalesced(): Promise<void> {
    // The claim is taken SYNCHRONOUSLY, before the first await: an async body runs to its first
    // await on the caller's turn, so a second caller can never observe the flag still down.
    if (this.#passRunning) {
      this.#passQueued = true;
      return;
    }
    this.#passRunning = true;
    try {
      do {
        this.#passQueued = false;
        await this.runReservePass();
      } while (this.#passQueued);
    } finally {
      this.#passRunning = false;
    }
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

    // The concurrency counts are aggregated IN the database: a LIMIT here would understate the
    // caps it feeds, and materializing every working row to count them is the unbounded read.
    const workingGroups = (await tdb
      .select(schema.workforceTasks, {
        workforceId: schema.workforceTasks.workforceId,
        department: schema.workforceTasks.department,
        count: sql<number>`count(*)::int`,
      })
      .where(eq(schema.workforceTasks.status, 'working'))
      .groupBy(schema.workforceTasks.workforceId, schema.workforceTasks.department)) as Array<{
      workforceId: string | null;
      department: string | null;
      count: number;
    }>;

    const workforceCount = new Map<string, number>();
    const departmentCount = new Map<string, number>();
    for (const g of workingGroups) {
      const wf = g.workforceId ?? '';
      workforceCount.set(wf, (workforceCount.get(wf) ?? 0) + g.count);
      if (g.department !== null) {
        departmentCount.set(`${wf}/${g.department}`, g.count);
      }
    }

    const budgetsCache = new Map<string, { paused: boolean; budgets: WorkforceBudgets }>();
    const skipped = await this.#undispatchableScopes(tdb, budgetsCache, {
      workforceCount,
      departmentCount,
    });
    outcome.paused += skipped.pausedTasks;
    outcome.saturated += skipped.saturatedTasks;

    // One page of candidates, ordered in the DATABASE by the same key the pass dispatches in
    // (priority band, then oldest queued) — so the bound cannot let a low-priority row jump ahead
    // of an urgent one that happened to sit outside the page.
    //
    // The page is taken over the rows that were dispatchable AT SCOPE-RESOLUTION TIME. A skipped
    // candidate gets no transition, so it holds the identical slot in the identical page on every
    // subsequent tick: one paused — or already at-capacity — workforce with more queued tasks than
    // the page holds would otherwise stop dispatch for every other workforce in the tenant,
    // forever. Both of those conditions are knowable before the page is taken, so they are excluded
    // in the predicate, and the rows they exclude are counted from the same database-side aggregate.
    //
    // What the predicate does NOT remove is a workforce this pass saturates itself: the loop below
    // fills the cap and then skips the remainder of the page IN PLACE. Those skips are real and
    // still counted, and they cost the rest of the tenant roughly (backlog / page) ticks of delay
    // before that workforce stops being drawn — bounded, self-clearing on the next tick's
    // exclusion, and tracked as a follow-up rather than closed here.
    const candidates = (await tdb
      .select(schema.workforceTasks)
      .where(and(eq(schema.workforceTasks.status, 'queued'), ...skipped.exclusions))
      .orderBy(
        PRIORITY_RANK_SQL,
        asc(schema.workforceTasks.queuedAt),
        asc(schema.workforceTasks.taskId),
      )
      .limit(RESERVE_SCAN_LIMIT)) as TaskRecord[];
    if (candidates.length === 0) return outcome;

    for (const task of candidates) {
      try {
        const wf = task.workforceId;
        // The caps are re-checked per candidate because the pass itself moves them: a workforce
        // with room at page time saturates as this loop dispatches into it. The cache is already
        // warm for every workforce that had a queued row when the scopes were resolved; a row that
        // arrived since then resolves here, so a fresh arrival is never dispatched past a cap.
        let entry = wf !== null ? budgetsCache.get(wf) : undefined;
        if (wf !== null && entry === undefined) {
          const runtime = await ensureWorkforceRuntime(tdb, wf);
          entry = { paused: runtime.paused, budgets: resolveWorkforceBudgets(runtime.budgets, wf) };
          budgetsCache.set(wf, entry);
        }
        const budgets = entry?.budgets ?? EMPTY_BUDGETS;
        if (entry?.paused === true) {
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
   * The scopes this pass cannot dispatch into, as SQL the candidate page is taken UNDER.
   *
   * Two conditions are decided per WORKFORCE (or per department) rather than per task — the pause
   * flag and a concurrency cap ALREADY met when the scopes are resolved — and both are knowable
   * before a single candidate row is read. Deciding them in the loop instead is what starves the
   * tenant: the skipped rows keep their place in the ordering, so they refill the same page every
   * tick and nothing behind them is ever examined. Deciding them here keeps the page full of rows
   * the pass can act on. A cap the pass fills DURING its own loop is still skipped in place there;
   * the header says what that costs.
   *
   * The counts come from the same database-side aggregate, so `paused`/`saturated` in the outcome
   * report every candidate those two conditions declined — not just the ones that fit in a page.
   * A THIRD condition declines rows and is deliberately counted by NEITHER: a workforce whose
   * stored budgets will not parse is excluded from the page (its candidates could only throw) and
   * reported through the error log alone, because it is a misconfiguration to fix, not a queue
   * state to report. The outcome's counters are therefore a lower bound on rows declined.
   *
   * Warms `budgetsCache` on the way through: every workforce with a queued task needs its runtime
   * row read exactly once per pass, whether it is excluded here or dispatched below.
   */
  async #undispatchableScopes(
    tdb: TenantDb,
    budgetsCache: Map<string, { paused: boolean; budgets: WorkforceBudgets }>,
    counts: { workforceCount: Map<string, number>; departmentCount: Map<string, number> },
  ): Promise<{ exclusions: SQL[]; pausedTasks: number; saturatedTasks: number }> {
    const queuedGroups = (await tdb
      .select(schema.workforceTasks, {
        workforceId: schema.workforceTasks.workforceId,
        department: schema.workforceTasks.department,
        count: sql<number>`count(*)::int`,
      })
      .where(eq(schema.workforceTasks.status, 'queued'))
      .groupBy(schema.workforceTasks.workforceId, schema.workforceTasks.department)) as Array<{
      workforceId: string | null;
      department: string | null;
      count: number;
    }>;

    const paused = new Set<string>();
    const saturated = new Set<string>();
    /** A workforce whose stored declaration will not parse: every candidate under it would throw. */
    const unresolvable = new Set<string>();
    for (const workforceId of new Set(
      queuedGroups.flatMap((g) => (g.workforceId !== null ? [g.workforceId] : [])),
    )) {
      try {
        const runtime = await ensureWorkforceRuntime(tdb, workforceId);
        const entry = {
          paused: runtime.paused,
          budgets: resolveWorkforceBudgets(runtime.budgets, workforceId),
        };
        budgetsCache.set(workforceId, entry);
        if (entry.paused) {
          paused.add(workforceId);
          continue;
        }
        const cap = entry.budgets.execution.maxConcurrentWorkers ?? null;
        if (cap !== null && (counts.workforceCount.get(workforceId) ?? 0) >= cap) {
          saturated.add(workforceId);
        }
      } catch (err) {
        // A misconfigured workforce must not fill the page with rows that can only throw — it is
        // excluded loudly and the rest of the tenant keeps dispatching.
        unresolvable.add(workforceId);
        this.#logger.error(
          `[workforce] reserve pass: workforce ${workforceId} is undispatchable: ${String(err)}`,
        );
      }
    }

    const saturatedDepartments: { workforceId: string; department: string }[] = [];
    let pausedTasks = 0;
    let saturatedTasks = 0;
    for (const g of queuedGroups) {
      const workforceId = g.workforceId;
      if (workforceId === null) continue; // no runtime row: no pause flag and no caps to meet
      if (paused.has(workforceId)) {
        pausedTasks += g.count;
        continue;
      }
      if (saturated.has(workforceId)) {
        saturatedTasks += g.count;
        continue;
      }
      if (unresolvable.has(workforceId) || g.department === null) continue;
      const depCap =
        budgetsCache.get(workforceId)?.budgets.departments?.[g.department]?.maxConcurrentWorkers ??
        null;
      if (
        depCap !== null &&
        (counts.departmentCount.get(`${workforceId}/${g.department}`) ?? 0) >= depCap
      ) {
        saturatedDepartments.push({ workforceId, department: g.department });
        saturatedTasks += g.count;
      }
    }

    const excludedWorkforces = [...paused, ...saturated, ...unresolvable];
    const exclusions: SQL[] = [];
    if (excludedWorkforces.length > 0) {
      // `NOT IN` alone would drop the workforce-less rows too (NULL NOT IN (…) is NULL, not true).
      exclusions.push(
        or(
          isNull(schema.workforceTasks.workforceId),
          notInArray(schema.workforceTasks.workforceId, excludedWorkforces),
        ) as SQL,
      );
    }
    for (const { workforceId, department } of saturatedDepartments) {
      // `IS DISTINCT FROM` so a NULL workforce id or department answers the comparison instead of
      // making the whole predicate NULL and dropping the row.
      exclusions.push(
        sql`(${schema.workforceTasks.workforceId} is distinct from ${workforceId} or ${schema.workforceTasks.department} is distinct from ${department})`,
      );
    }
    return { exclusions, pausedTasks, saturatedTasks };
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
      .where(eq(schema.workforceTasks.status, 'planned'))
      .orderBy(asc(schema.workforceTasks.createdAt), asc(schema.workforceTasks.taskId))
      .limit(RESERVE_SCAN_LIMIT)) as TaskRecord[];
    for (const task of planned) {
      try {
        const verdict = await this.#dependencyVerdict(tdb, task);
        if (verdict.kind === 'decided') {
          await this.#failOnDecidedDependency(tdb, task, verdict.blockers);
          continue;
        }
        if (verdict.kind === 'satisfied') {
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

  /**
   * Wake blocked(awaiting_dependency) rows whose dependencies have since completed — and DECIDE the
   * ones whose dependencies ended terminal without completing, because nothing else ever revisits
   * this park.
   *
   * PAGED FROM A CURSOR, not from the start of the order. `#promotePlanned` may take the first page
   * every tick because every row it examines LEAVES the set — promoted or parked, it is no longer
   * `planned`. Here the opposite is normal: a park whose dependencies are still pending is examined,
   * skipped, and is still the very same row at the very same position next tick, so a page's worth
   * of long-lived parks hides every newer task behind them permanently. The cursor advances past
   * what was examined and resets when a short page says the set is exhausted, so every park is
   * reached within one full cycle of the set.
   */
  async #wakeDependencySatisfied(tdb: TenantDb): Promise<void> {
    const cursor = this.#dependencyWakeCursor;
    const parked = (await tdb
      .select(schema.workforceTasks)
      .where(
        and(
          eq(schema.workforceTasks.status, 'blocked'),
          eq(schema.workforceTasks.statusReason, 'awaiting_dependency'),
          cursor === null
            ? undefined
            : sql`(${schema.workforceTasks.createdAt}, ${schema.workforceTasks.taskId}) > (${cursor.key.toISOString()}::timestamptz, ${cursor.taskId})`,
        ),
      )
      .orderBy(asc(schema.workforceTasks.createdAt), asc(schema.workforceTasks.taskId))
      .limit(RESERVE_SCAN_LIMIT)) as TaskRecord[];
    const last = parked[parked.length - 1];
    this.#dependencyWakeCursor =
      parked.length < RESERVE_SCAN_LIMIT || last === undefined
        ? null
        : { key: last.createdAt, taskId: last.taskId };
    for (const task of parked) {
      try {
        const verdict = await this.#dependencyVerdict(tdb, task);
        if (verdict.kind === 'decided') {
          await this.#failOnDecidedDependency(tdb, task, verdict.blockers);
          continue;
        }
        if (verdict.kind !== 'satisfied') continue;
        await deliverSignal(tdb, {
          taskId: task.taskId,
          kind: 'dependency_completed',
          signalKey: `deps:${task.taskId}`,
          actor: 'scheduler',
        });
      } catch (err) {
        if (!(err instanceof TaskVersionConflictError)) {
          this.#logger.error(`[workforce] dependency wake ${task.taskId} errored: ${String(err)}`);
        }
      }
    }
  }

  /**
   * Resolve a task's declared dependencies. `decided` is the outcome the park had no answer for: a
   * dependency that is TERMINAL but not `completed` (or that no longer exists) can never satisfy
   * the wait, so it is a decision, not a delay. Membership is checked per unique id against the
   * rows found, never by counting them — a list carrying the same id twice used to be permanently
   * unsatisfiable under a `rows.length === deps.length` comparison.
   */
  async #dependencyVerdict(tdb: TenantDb, task: TaskRecord): Promise<DependencyVerdict> {
    const declared = Array.isArray(task.dependencies) ? (task.dependencies as string[]) : [];
    const deps = [...new Set(declared)];
    if (deps.length === 0) return { kind: 'satisfied' };
    const rows = (await tdb
      .select(schema.workforceTasks)
      .where(inArray(schema.workforceTasks.taskId, deps))) as TaskRecord[];
    const byId = new Map(rows.map((r) => [r.taskId, r]));
    const blockers: { taskId: string; status: string }[] = [];
    let waiting = false;
    for (const id of deps) {
      const dep = byId.get(id);
      if (!dep) {
        // Creation refuses an unknown id, so a missing row here means the dependency is gone for
        // good — a decision, not something to keep waiting on.
        blockers.push({ taskId: id, status: 'absent' });
      } else if (dep.status === 'completed') {
      } else if (isTaskStatus(dep.status) && isTerminalStatus(dep.status)) {
        blockers.push({ taskId: id, status: dep.status });
      } else {
        waiting = true;
      }
    }
    if (blockers.length > 0) return { kind: 'decided', blockers };
    return waiting ? { kind: 'pending' } : { kind: 'satisfied' };
  }

  /**
   * A dependency's outcome is decided and it is not `completed`: fail the dependent with the typed
   * reason and journal what decided it. The alternative is the defect this replaces — a task in
   * `blocked(awaiting_dependency)` with nobody left who could ever wake it.
   */
  async #failOnDecidedDependency(
    tdb: TenantDb,
    task: TaskRecord,
    blockers: readonly { taskId: string; status: string }[],
  ): Promise<void> {
    await tdb.transaction(async (tx) => {
      await appendTaskEvents(tx, task.taskId, [
        {
          type: 'workforce.task.dependency_failed',
          payload: { taskId: task.taskId, dependencies: blockers },
        },
      ]);
      await applyTransition(tx, {
        taskId: task.taskId,
        expectedVersion: task.version,
        to: 'failed',
        reason: 'dependency_failed',
        actor: 'scheduler',
      });
    });
    this.#logger.warn(
      `[workforce] task ${task.taskId} failed: dependency ${blockers
        .map((b) => `${b.taskId} (${b.status})`)
        .join(', ')} ended without completing.`,
    );
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
   *
   * A reap also RELEASES the dead claim's budget reservation, in the same transaction as the
   * re-queue: `settleTurn` is the only other release and it runs from the turn's final transaction,
   * which this turn never reached. The un-windowed `task`/`root` scopes never roll over, so an
   * unreleased estimate is permanent — enough reaps and the task is denied at a ceiling it has
   * spent nothing against. What it releases is what the CLAIM reserved, in the window the claim
   * reserved it in (`#reservationOfClaim`), never a fresh derivation from today's declaration.
   */
  async runSweep(): Promise<ApprovalSweepOutcome & { reaped: string[] }> {
    if (!(await this.#deps.tenantExists(this.#deps.tenantId))) {
      return { failed: [], escalated: [], reaped: [] };
    }
    const tdb = forTenant(this.#deps.db, this.#deps.tenantId);
    const approvals = await sweepApprovalTimeouts(tdb, this.#now());
    const reaped: string[] = [];
    // Paged from the reap cursor for the same reason the dependency wake is: a LIVE turn is skipped
    // and stays `working`, so a page's worth of long-running turns would hide every dead one behind
    // them from every future sweep.
    const cursor = this.#reapCursor;
    const working = (await tdb
      .select(schema.workforceTasks)
      .where(
        and(
          eq(schema.workforceTasks.status, 'working'),
          cursor === null
            ? undefined
            : sql`(${schema.workforceTasks.startedAt}, ${schema.workforceTasks.taskId}) > (${cursor.key.toISOString()}::timestamptz, ${cursor.taskId})`,
        ),
      )
      .orderBy(asc(schema.workforceTasks.startedAt), asc(schema.workforceTasks.taskId))
      .limit(SWEEP_SCAN_LIMIT)) as TaskRecord[];
    const lastScanned = working[working.length - 1];
    this.#reapCursor =
      working.length < SWEEP_SCAN_LIMIT || lastScanned?.startedAt == null
        ? null
        : { key: lastScanned.startedAt, taskId: lastScanned.taskId };
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
          // `id` breaks a created_at tie: two claim rows can share a timestamp, and "the latest
          // claim" must be one row, not whichever the planner happened to return.
          .orderBy(
            desc(schema.workforceTaskTransitions.createdAt),
            desc(schema.workforceTaskTransitions.id),
          )
          .limit(1)) as (typeof schema.workforceTaskTransitions.$inferSelect)[];
        const turnId = claimRows[0]?.turnId;
        if (!turnId) continue; // no claim record — not this dispatcher's row to judge
        const status = await DBOS.getWorkflowStatus(turnId);
        const live =
          status !== null && (status.status === 'PENDING' || status.status === 'ENQUEUED');
        if (live) continue;
        const reservation = await this.#reservationOfClaim(tdb, task.taskId, turnId);
        await tdb.transaction(async (tx) => {
          // Lock rank (see #claimTurn): runtime row, then the task row, then the ledger rows.
          const budgets =
            task.workforceId !== null
              ? resolveWorkforceBudgets(
                  (await ensureWorkforceRuntime(tx, task.workforceId)).budgets,
                  task.workforceId,
                )
              : EMPTY_BUDGETS;
          await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'queued',
            reason: 'tool_error',
            actor: 'scheduler',
            queueReason: 'turn_reaped',
          });
          if (reservation !== null) {
            await releaseTurnReservation(
              tx,
              budgets,
              {
                taskId: task.taskId,
                rootTaskId: task.rootTaskId,
                workforceId: task.workforceId,
                department: task.department,
                estimateUsd: reservation.estimateUsd,
              },
              reservation.reservedAt,
            );
          }
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
   * What the dead claim actually RESERVED, and WHEN — the two facts the release must undo.
   *
   * Re-deriving them from today's declaration and today's clock is wrong twice over: an
   * `estimateUsdPerTurn` edited between the claim and the reap releases the wrong amount (releasing
   * too much eats the headroom of the turns still running and over-admits past the ceiling), and a
   * reap that crosses a calendar boundary decrements a window that never held the reservation while
   * the real one sits in the previous bucket, where nothing will ever release it.
   *
   * The claim recorded both facts in the transaction that took the reservation — its
   * `workforce.budget.reserved` journal entry, keyed by the claim's own turn id — so that entry is
   * the durable record of the reservation and is what the release reads back. No entry means this
   * claim reserved nothing (a row driven to `working` outside a dispatch), and releasing nothing is
   * then exactly right.
   */
  async #reservationOfClaim(
    tdb: TenantDb,
    taskId: string,
    turnId: string,
  ): Promise<{ estimateUsd: number; reservedAt: Date } | null> {
    const rows = (await tdb
      .select(schema.runEvents, { data: schema.runEvents.data })
      .where(
        and(
          eq(schema.runEvents.runId, taskId),
          eq(schema.runEvents.type, 'workforce.budget.reserved'),
          sql`${schema.runEvents.data}->>'turnId' = ${turnId}`,
        ),
      )) as Array<{ data: unknown }>;
    const data = rows[0]?.data;
    if (data === undefined || data === null || typeof data !== 'object') return null;
    const { estimateUsd, reservedAt } = data as { estimateUsd?: unknown; reservedAt?: unknown };
    const amount = Number(estimateUsd);
    const at = new Date(String(reservedAt));
    if (!Number.isFinite(amount) || amount < 0 || Number.isNaN(at.getTime())) {
      throw new Error(
        `[workforce] task ${taskId}: the reservation entry for turn ${turnId} carries ` +
          `estimateUsd=${String(estimateUsd)} reservedAt=${String(reservedAt)} — refusing to ` +
          'release a guessed amount into a guessed window. Fail-closed.',
      );
    }
    return { estimateUsd: amount, reservedAt: at };
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
        // The payload is durable state a recovery replays, not a source of scope: every other path
        // re-derives the tenant from the deps. Assert the two agree rather than binding a handle to
        // whatever a payload happens to carry.
        if (job.tenantId !== this.#deps.tenantId) {
          throw new Error(
            `turn workflow for task ${job.taskId} carries tenant ${job.tenantId} but this scheduler serves ${this.#deps.tenantId} — refusing to bind a handle to a payload-supplied scope. Fail-closed.`,
          );
        }
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
            ...(outcome.reviewPolicy !== undefined ? { reviewPolicy: outcome.reviewPolicy } : {}),
            ...(outcome.createdChildren !== undefined
              ? { createdChildren: outcome.createdChildren }
              : {}),
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
   *
   * THE LOCK RANK, established here and followed everywhere: `workforce_runtime` -> `workforce_tasks`
   * -> `workforce_budget_ledger`. This transaction takes all three in that order —
   * `ensureWorkforceRuntime`'s upsert locks the runtime row, `applyTransition`'s compare-and-swap
   * locks the task row, `authorizeTurn`'s upserts lock the ledger rows — so every other path that
   * touches more than one of them must too, or a claim and a settle could wait on each other. The
   * ordering WITHIN `workforce_tasks` is the root-first subtree order (@rayspec/tasks
   * apply-intents.ts); the ordering within the ledger is the canonical scope order (budget.ts).
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
            .orderBy(
              desc(schema.workforceTaskTransitions.createdAt),
              desc(schema.workforceTaskTransitions.id),
            )
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

        // ONE instant for the reservation: the window it lands in and the window a later release
        // works must be the same, so the clock is captured, not read twice.
        const reservedAt = this.#now();
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
          reservedAt,
        );
        if (!decision.allowed) throw new ClaimDenied(decision.denial);

        await appendTaskEvents(tx, task.taskId, [
          {
            type: 'workforce.budget.reserved',
            payload: {
              taskId: task.taskId,
              turnNumber: job.turnNumber,
              // The claim's own id and clock: the reaper's release reads them back to undo exactly
              // this reservation, in exactly the window it landed in (`#reservationOfClaim`).
              turnId: myWorkflowId,
              estimateUsd: budgets.execution.estimateUsdPerTurn,
              reservedAt: reservedAt.toISOString(),
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
      const snapshot = rows[0];
      if (snapshot?.status !== 'queued') return;
      // Lock rank: the runtime row, then the task rows. `block_and_escalate` additionally parks the
      // ROOT, so this touches a second task row and takes the root-first locks up front.
      const budgets =
        snapshot.workforceId !== null
          ? resolveWorkforceBudgets(
              (await ensureWorkforceRuntime(tx, snapshot.workforceId)).budgets,
              snapshot.workforceId,
            )
          : EMPTY_BUDGETS;
      const task = await lockRootFirst(tx, snapshot);
      if (task.status !== 'queued') return;
      await applyBudgetExhausted(tx, task, denial, budgets, { actor: 'scheduler' });
    });
  }

  /**
   * Assemble the read-only handler context (protocol step 2's input).
   *
   * The signal and message histories are BOUNDED to their newest entries and then presented oldest
   * first: the wake that re-queued this task is the newest row, so the cap can never drop the entry
   * a turn actually reasons from, and a long-lived task's history cannot grow the context without
   * limit. The children read is a DELIBERATE full scan — a join merges over ALL of them, and a page
   * of children would silently produce a partial result keyed by child id.
   */
  async #assembleContext(tdb: TenantDb, task: TaskRecord): Promise<TaskTurnContext> {
    const children = (await tdb
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.parentTaskId, task.taskId))) as TaskRecord[];
    const terminalChildren = children.filter(
      (c) => isTaskStatus(c.status) && isTerminalStatus(c.status),
    );
    const signals = (await tdb
      .select(schema.workforceTaskSignals)
      .where(eq(schema.workforceTaskSignals.taskId, task.taskId))
      .orderBy(desc(schema.workforceTaskSignals.createdAt), desc(schema.workforceTaskSignals.id))
      .limit(CONTEXT_SIGNAL_LIMIT)) as (typeof schema.workforceTaskSignals.$inferSelect)[];
    const messages = (await tdb
      .select(schema.workforceMessages)
      .where(eq(schema.workforceMessages.taskId, task.taskId))
      .orderBy(desc(schema.workforceMessages.createdAt), desc(schema.workforceMessages.id))
      .limit(CONTEXT_MESSAGE_LIMIT)) as (typeof schema.workforceMessages.$inferSelect)[];
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
