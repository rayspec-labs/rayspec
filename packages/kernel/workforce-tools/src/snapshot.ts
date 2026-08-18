/**
 * The bounded READ SNAPSHOT a turn's read tools answer from — built ONCE before the run, through
 * the tenant chokepoint, role-gated and page-capped, so the tool handlers themselves stay I/O-free
 * and a whole-turn re-execution re-reads rather than replays stale answers.
 *
 * Visibility is STRUCTURAL, decided here and nowhere the model can reach:
 *   - every role sees its OWN task;
 *   - orchestrators see their subtree page and the workforce state view;
 *   - managers see their subtree page plus their department's open tasks;
 *   - reviewers additionally see the PARENT task (the work under review, result included) and the
 *     pending review row their verdict targets;
 *   - EVERY role gets the resolved budget ceilings (one runtime-row read) and the results of its
 *     task's declared prerequisites — the facts the turn scaffolding states before the model runs;
 *   - nothing here can cross the tenant (every read runs on the caller's TenantDb) and nothing
 *     reaches outside the subtree/department the role earns.
 */
import { schema, type TenantDb } from '@rayspec/db';
import type { WorkforceConfig, WorkforceEmployeeConfig } from '@rayspec/spec';
import {
  joinPolicySchema,
  type MergedChildResult,
  mergeChildResults,
  readWorkforceRuntime,
  resolveWorkforceBudgets,
  type TaskRecord,
  type WorkforceBudgets,
  windowStartFor,
} from '@rayspec/tasks';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { ERASED_CONTENT } from './prompt.js';

/** Page caps — a snapshot is a bounded view, never a partition materialized into memory. */
export const SNAPSHOT_SUBTREE_LIMIT = 100;
export const SNAPSHOT_DEPARTMENT_LIMIT = 100;

export interface TaskSummary {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly owner: string;
  readonly department: string | null;
  readonly priority: string;
  readonly createdAt: string;
}

export interface WorkforceStateView {
  readonly paused: boolean;
  readonly departments: readonly {
    readonly id: string;
    readonly employees: number;
    readonly openTasks: number;
  }[];
  readonly openByStatus: Readonly<Record<string, number>>;
  readonly budget: {
    readonly ceilingUsd: number | null;
    readonly consumedUsd: number;
    readonly headroomUsd: number | null;
  };
}

export interface WorkforceReadSnapshot {
  readonly task: TaskRecord;
  /** The work under review — loaded ONLY for a review task (the reviewer reads the result here). */
  readonly parentTask: TaskRecord | null;
  /** Self + descendants, page-capped, creation order. Orchestrators and managers only. */
  readonly subtreeTasks: readonly TaskSummary[];
  /** The manager's department view (non-terminal tasks), page-capped. */
  readonly departmentTasks: readonly TaskSummary[];
  /** Orchestrators only. */
  readonly workforceState: WorkforceStateView | null;
  /** The pending review this task exists to decide (review tasks only). */
  readonly pendingReview: { readonly reviewId: string; readonly round: number } | null;
  /**
   * The teams whose `team:` DELEGATION opened this task or one of its ancestors — the durable fact
   * that says "this task IS team work", read off the delegation chain rather than inferred. A
   * manager's authority over a led team's members is scoped to it (see `assertManagerMayTarget`).
   */
  readonly activeTeamIds: readonly string[];
  /**
   * The OWNERS of this task's ancestors (deduped, ancestry order) — the seats the engine's
   * delegation-cycle rule refuses as targets from here. Read off the immutable ancestry ids
   * (one bounded IN query, ≤ the delegation depth), so the scaffolding can subtract them from
   * the legal-target facts instead of advertising a hand-off the planner will terminally refuse.
   */
  readonly ancestorOwners: readonly string[];
  /**
   * How many delegations THIS task has already opened — the planner's `existingDelegationCount`,
   * the value it adds new hand-offs to before comparing to `maxPerTask`. Read here (one indexed
   * count on `parentTaskId`) so the scaffolding can state the REMAINING fan-out allowance, not the
   * static cap: a second delegating turn otherwise reads "up to M children" when M−k remain.
   */
  readonly delegationsFromTask: number;
  /**
   * The declared ceilings, resolved off the runtime row — every role, every turn (the scaffolding
   * presents headroom and limits as facts before the model runs; a single-row read). The row
   * exists for any declared workforce (boot upserts it) and for any dispatched one (the scheduler
   * creates it on first dispatch).
   */
  readonly budgets: WorkforceBudgets;
  /**
   * The results of this task's declared prerequisites, keyed by task id in the same merged shape
   * child results use — the context a task that WAITED on other work runs with. Null when the
   * task declares no dependencies; a non-terminal prerequisite (possible on a re-queued task) is
   * simply absent from the map.
   */
  readonly dependencyResults: Readonly<Record<string, MergedChildResult>> | null;
}

const TERMINAL = ['completed', 'failed', 'cancelled'];

function summarize(row: TaskRecord): TaskSummary {
  return {
    taskId: row.taskId,
    // A NULL title means the tenant's content was erased by `journalScrub` (migration 0013) while
    // its ledger and structure were retained. The snapshot is a RENDERING, so it names that
    // explicitly rather than emitting an empty string an operator would read as an untitled task.
    title: row.title ?? ERASED_CONTENT,
    status: row.status,
    statusReason: row.statusReason,
    owner: row.owner,
    department: row.department,
    priority: row.priority,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

export async function buildWorkforceSnapshot(
  tdb: TenantDb,
  config: WorkforceConfig,
  task: TaskRecord,
  employee: WorkforceEmployeeConfig,
): Promise<WorkforceReadSnapshot> {
  // The declared ceilings — read once, for every role (the state view below reuses them). The
  // scaffolding renders these as facts, so a turn is never asked to guess its own limits.
  const runtime = await readWorkforceRuntime(tdb, config.id);
  const budgets = resolveWorkforceBudgets(runtime.budgets, config.id);

  // The prerequisite results — the context a task that WAITED on other work runs with, in the
  // same deterministic merged shape child results use (sorted keys, keyed by task id).
  let dependencyResults: Readonly<Record<string, MergedChildResult>> | null = null;
  const declaredDependencies = Array.isArray(task.dependencies)
    ? (task.dependencies as string[])
    : [];
  if (declaredDependencies.length > 0) {
    const rows = (await tdb
      .select(schema.workforceTasks)
      .where(inArray(schema.workforceTasks.taskId, declaredDependencies))) as TaskRecord[];
    dependencyResults = mergeChildResults(
      rows.filter((row) => TERMINAL.includes(row.status)),
    ).byChildId;
  }
  // The PARENT (the reviewed task) + the pending review row — for any role whose toolset carries
  // submit_review (reviewer, manager). Linkage is DERIVED, never model-supplied: the pending
  // review is named by the PARENT'S PARK BINDING — the durable linkage the engine wrote when it
  // opened the park, naming both the review row and the task dispatched to decide it.
  //
  // NOT a "newest verdict-less row for this parent" scan, which is a mutable sibling query and was
  // wrong in both directions: an undecided row left behind by an abandoned review permanently
  // stripped `request_review` from every sibling owned by that reviewer and offered them
  // `submit_review` against a dead row, while a task that was never the reviewer could be handed a
  // review that is not its own. The binding answers "is THIS task the one dispatched to decide
  // THAT review", which is the only question the toolset should be asking.
  let parentTask: TaskRecord | null = null;
  let pendingReview: { reviewId: string; round: number } | null = null;
  const mayReview = employee.role === 'reviewer' || employee.role === 'manager';
  if (mayReview && task.parentTaskId !== null) {
    const parents = (await tdb
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.taskId, task.parentTaskId))) as TaskRecord[];
    parentTask = parents[0] ?? null;
    const binding =
      parentTask !== null && parentTask.status === 'waiting_for_review'
        ? joinPolicySchema.safeParse(parentTask.joinPolicy)
        : null;
    if (
      parentTask &&
      binding?.success &&
      binding.data.policy === 'review' &&
      binding.data.reviewTaskId === task.taskId &&
      binding.data.reviewId !== undefined
    ) {
      const reviews = (await tdb
        .select(schema.workforceReviews)
        .where(
          eq(schema.workforceReviews.id, binding.data.reviewId),
        )) as (typeof schema.workforceReviews.$inferSelect)[];
      const review = reviews[0];
      // Still fail-closed on the row itself: a decided review is not pending, and a review naming a
      // different reviewer than this task's owner is not this task's to decide.
      if (review !== undefined && review.verdict === null && review.reviewer === employee.id) {
        pendingReview = { reviewId: review.id, round: review.round };
      }
    }
  }

  // The subtree page — self + descendants in creation order (orchestrators and managers).
  let subtreeTasks: readonly TaskSummary[] = [];
  if (employee.role === 'orchestrator' || employee.role === 'manager') {
    const rows = (await tdb
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.rootTaskId, task.rootTaskId))
      .orderBy(asc(schema.workforceTasks.createdAt), asc(schema.workforceTasks.taskId))
      .limit(SNAPSHOT_SUBTREE_LIMIT * 4)) as TaskRecord[];
    // Subtree membership is decided on the immutable ancestry, in code — the ROOT scan above is
    // the index-friendly superset. Page-capped AFTER the filter so a big sibling subtree cannot
    // starve the view of its own descendants entirely (a residual bound, stated honestly: a
    // subtree deeper than the scan window is partially visible).
    subtreeTasks = rows
      .filter(
        (row) =>
          row.taskId === task.taskId ||
          (Array.isArray(row.ancestryPath) && (row.ancestryPath as string[]).includes(task.taskId)),
      )
      .slice(0, SNAPSHOT_SUBTREE_LIMIT)
      .map(summarize);
  }

  // The department page — the manager's non-terminal department tasks.
  let departmentTasks: readonly TaskSummary[] = [];
  if (employee.role === 'manager' && employee.department !== null) {
    const rows = (await tdb
      .select(schema.workforceTasks)
      .where(
        and(
          eq(schema.workforceTasks.workforceId, config.id),
          eq(schema.workforceTasks.department, employee.department),
          sql`${schema.workforceTasks.status} not in ('completed', 'failed', 'cancelled')`,
        ),
      )
      .orderBy(asc(schema.workforceTasks.createdAt), asc(schema.workforceTasks.taskId))
      .limit(SNAPSHOT_DEPARTMENT_LIMIT)) as TaskRecord[];
    departmentTasks = rows.map(summarize);
  }

  // The workforce state view — orchestrators only. Counts aggregate IN the database.
  let workforceState: WorkforceStateView | null = null;
  if (employee.role === 'orchestrator') {
    const grouped = (await tdb
      .select(schema.workforceTasks, {
        status: schema.workforceTasks.status,
        department: schema.workforceTasks.department,
        count: sql<number>`count(*)::int`,
      })
      .where(eq(schema.workforceTasks.workforceId, config.id))
      .groupBy(schema.workforceTasks.status, schema.workforceTasks.department)) as Array<{
      status: string;
      department: string | null;
      count: number;
    }>;
    const openByStatus: Record<string, number> = {};
    const openByDepartment = new Map<string, number>();
    for (const g of grouped) {
      if (TERMINAL.includes(g.status)) continue;
      openByStatus[g.status] = (openByStatus[g.status] ?? 0) + g.count;
      if (g.department !== null) {
        openByDepartment.set(g.department, (openByDepartment.get(g.department) ?? 0) + g.count);
      }
    }
    const ceiling = budgets.workforce?.usd ?? null;
    let consumedUsd = 0;
    if (ceiling !== null) {
      const windowStart = windowStartFor(budgets.workforce?.window ?? 'daily', new Date());
      const ledger = (await tdb
        .select(schema.workforceBudgetLedger)
        .where(
          and(
            eq(schema.workforceBudgetLedger.scopeKind, 'workforce'),
            eq(schema.workforceBudgetLedger.scopeId, config.id),
            eq(schema.workforceBudgetLedger.windowStart, windowStart),
          ),
        )) as Array<typeof schema.workforceBudgetLedger.$inferSelect>;
      consumedUsd = ledger.reduce(
        (sum, row) => sum + Number(row.settledUsd) + Number(row.reservedUsd),
        0,
      );
    }
    workforceState = {
      paused: runtime.paused,
      departments: [...config.departments.entries()].map(([id, department]) => ({
        id,
        employees: department.members.length,
        openTasks: openByDepartment.get(id) ?? 0,
      })),
      openByStatus,
      budget: {
        ceilingUsd: ceiling,
        consumedUsd,
        headroomUsd: ceiling !== null ? Math.max(ceiling - consumedUsd, 0) : null,
      },
    };
  }

  // THE CYCLE RULE'S SUBJECTS: who owns the chain above this task. The ancestry ids are
  // immutable on the row; one bounded read resolves them to owners (ancestry order, deduped).
  const ancestryIds = Array.isArray(task.ancestryPath) ? (task.ancestryPath as string[]) : [];
  let ancestorOwners: readonly string[] = [];
  if (ancestryIds.length > 0) {
    const ancestorRows = (await tdb
      .select(schema.workforceTasks, {
        taskId: schema.workforceTasks.taskId,
        owner: schema.workforceTasks.owner,
      })
      .where(inArray(schema.workforceTasks.taskId, ancestryIds))) as Array<{
      taskId: string;
      owner: string;
    }>;
    const ownerById = new Map(ancestorRows.map((row) => [row.taskId, row.owner]));
    ancestorOwners = [
      ...new Set(
        ancestryIds.map((id) => ownerById.get(id)).filter((o): o is string => o !== undefined),
      ),
    ];
  }

  // THE TEAM-WORK FACT. A `team:` delegation records its original target verbatim on the delegation
  // row, so the chain from this task up to the root says which team's work this is — and nothing
  // the model says can change it.
  const ancestry = Array.isArray(task.ancestryPath) ? (task.ancestryPath as string[]) : [];
  const chainIds = [task.taskId, ...ancestry];
  const teamRows = (await tdb
    .select(schema.workforceDelegations, {
      delegatedTo: schema.workforceDelegations.delegatedTo,
    })
    .where(inArray(schema.workforceDelegations.childTaskId, chainIds))) as Array<{
    delegatedTo: string;
  }>;
  const activeTeamIds = [
    ...new Set(
      teamRows
        .map((row) => /^team:(.+)$/.exec(row.delegatedTo)?.[1])
        .filter((id): id is string => id !== undefined),
    ),
  ].sort();

  // THE FAN-OUT ALREADY SPENT FROM THIS TASK — the planner's `existingDelegationCount`, read the
  // same way (`workforce_delegations` keyed by `parentTaskId`) but as an indexed COUNT (one row).
  // Advisory: the enforcement re-reads it under the task lock; the scaffolding only needs it to
  // state the remaining allowance honestly.
  const delegationCount = (await tdb
    .select(schema.workforceDelegations, { count: sql<number>`count(*)::int` })
    .where(eq(schema.workforceDelegations.parentTaskId, task.taskId))) as Array<{ count: number }>;
  const delegationsFromTask = delegationCount[0]?.count ?? 0;

  return {
    task,
    parentTask,
    subtreeTasks,
    departmentTasks,
    workforceState,
    pendingReview,
    activeTeamIds,
    ancestorOwners,
    delegationsFromTask,
    budgets,
    dependencyResults,
  };
}
