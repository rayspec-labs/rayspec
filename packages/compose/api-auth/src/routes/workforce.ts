/**
 * The task-engine HTTP surface — the resume/approval/control API for durable tasks.
 *
 * Mounted on the SAME createAuthApp middleware chain as every other route
 * (requestId → securityHeaders → authenticate → resolveTenant → requirePermission), so the tenant
 * is SERVER-DERIVED (never client-supplied) and every read and write goes through the chokepoint.
 * Reads carry `store:read`; every mutation carries `store:write` (the SENSITIVE product-write
 * permission — deciding an approval or cancelling a task mutates the tenant's durable work).
 *
 * FAIL-CLOSED WHOLESALE: without a wired `deps.workforce` seam every route here is a clean 501 —
 * the engine requires a durable worker to dispatch anything, and a decision accepted on a
 * worker-less deployment would be a silent trap (a re-queued task nothing will ever run).
 *
 * The per-task events route replays the task's journal stream from the SAME durable table the run
 * replay serves, through the shared one-shot replay (http/journal-replay.ts) with THIS surface's
 * fail-closed read-side validator: a stored row outside the versioned workforce vocabulary is
 * dropped, never served verbatim. Ownership is probed on the tenant-scoped task row BEFORE
 * streaming — a foreign or absent task id is a uniform 404, no existence leak.
 *
 * Errors map typed: an unknown task/approval/review → 404 (uniform with foreign), a second decision
 * on a resolved approval or review → 409, a verdict aimed at a park waiting on a DIFFERENT review
 * → 409 (the stale-inbox interleaving; nothing was written), a drain that cannot complete inside
 * the HTTP window → 504 (the pause itself is already in force — the response says exactly that).
 * Every typed engine refusal that can reach a route belongs in `mapEngineError`: one that does not
 * surfaces as a generic 500, which reads as a broken server rather than as the refusal it is.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { ApiError } from '@rayspec/auth-core';
import { forTenant, schema, type TenantDb } from '@rayspec/db';
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  applyReviewVerdict,
  approvalDecisionSchema,
  cancelTaskCascade,
  decideApproval,
  deliverSignal,
  ensureWorkforceRuntime,
  haltWorkforce,
  isReservedWorkforceSegment,
  isTaskStatus,
  operatorSignalKindSchema,
  pauseWorkforce,
  RESERVED_WORKFORCE_SEGMENTS,
  ReviewAlreadyDecidedError,
  ReviewNotForParkError,
  ReviewNotFoundError,
  ReviewTaskStateError,
  readWorkforceRuntime,
  resolveWorkforceBudgets,
  resumeWorkforce,
  reviewVerdictSchema,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskNotFoundError,
  WorkforceDrainTimeoutError,
  WorkforceUnknownError,
  windowStartFor,
  workforceBudgetsSchema,
  workforceJournalEventSchema,
} from '@rayspec/tasks';
import { and, asc, eq, gt, gte, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppDeps, AppEnv, WorkforceControl, WorkforceGoalIntake } from '../app-context.js';
import { readBoundedJson } from '../http/bounded-body.js';
import { replayJournalEventsAsSse, resolveLastEventId } from '../http/journal-replay.js';
import { requireAuth, requirePermission, resolveTenant } from '../http/middleware.js';

/**
 * The journal actor: the VERIFIED principal, never a client-asserted name. `requireAuth()` runs
 * before every caller, so an unresolved principal is unreachable; the fallback is a closed
 * sentinel rather than a guessable identity. This string lands in `decided_by`, transition rows,
 * and journal events — the engine's accountability trail.
 */
function actorFrom(c: Context<AppEnv>): string {
  const p = c.get('principal');
  if (p?.kind === 'user' && p.userId !== undefined) return `user:${p.userId}`;
  if (p?.apiKeyId !== undefined) return `api-key:${p.apiKeyId}`;
  return 'principal:unresolved';
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** The tree read's hard row cap — the ceiling of RENDERABLE output, not a paging economics
 * number. Past it the response is a truncated prefix with the header flag set. */
const TREE_MAX_TASKS = 500;

/** The approval rows' closed status vocabulary (the filter refuses free text, like the task list). */
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'timed_out', 'escalated'] as const;

/** The drain window an HTTP pause may hold the request for; past it → 504 (the pause holds). */
const HTTP_DRAIN_TIMEOUT_MS = 25_000;

/**
 * The reserved segments come from the engine (`@rayspec/tasks`), which also refuses them where a
 * workforce id is MINTED: `/v1/workforce/tasks/:id` and `/v1/workforce/:workforceId/status` are
 * both four segments, and a workforce called `tasks` would collide with the task route on every
 * request. The `:workforceId` routes are registered FIRST (so `/v1/workforce/tasks/status` resolves
 * as a workforce, not as a task whose id is `status`) and refuse a reserved id here — one clear 400
 * naming the set, instead of a route silently answering for the wrong resource.
 */
function workforceIdParam(c: Context<AppEnv>): string {
  const workforceId = c.req.param('workforceId') ?? '';
  if (workforceId.length === 0 || isReservedWorkforceSegment(workforceId)) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'That workforce id is a reserved path segment on this surface.',
      { reserved: RESERVED_WORKFORCE_SEGMENTS },
    );
  }
  return workforceId;
}

const signalRequestSchema = z.strictObject({
  // OPERATOR kinds only. A mechanism kind posted from here would assert by hand the very fact its
  // park is waiting to observe — releasing a fan-out join with the children still running, or an
  // escalation park its child never answered. Those parks are structural on every engine door;
  // this is the same door from outside. Anything else is a typed 400.
  kind: operatorSignalKindSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
  /**
   * The delivery's idempotency key. Supply one to make re-sends collapse (the engine dedupes on
   * (task, key)); absent ⇒ a fresh key per call (each call is its own delivery).
   */
  signalKey: z.string().min(1).max(200).optional(),
});

const cancelRequestSchema = z.strictObject({
  reason: z.string().min(1).max(500).optional(),
});

const decideRequestSchema = approvalDecisionSchema;

const pauseRequestSchema = z.strictObject({
  drain: z.boolean().default(false),
});

const haltRequestSchema = z.strictObject({
  reason: z.string().min(1).max(500),
});

/**
 * The goal (and description) ceiling at the intake edge, in BYTES — the same unit the turn
 * input's section budgets use (a character cap would let a multibyte goal pass here and burst
 * the budget there). Half the assembly's task-section budget, so a goal accepted on this surface
 * can ALWAYS be rendered untrimmed into the owning employee's turns — the assembly's
 * goal-never-trimmed refusal then only ever fires on goals minted by code that bypassed it.
 */
const MAX_GOAL_BYTES = 16_384;
const withinGoalBytes = (text: string) => Buffer.byteLength(text, 'utf8') <= MAX_GOAL_BYTES;

const goalRequestSchema = z.strictObject({
  goal: z.string().min(1).refine(withinGoalBytes, `goal must be at most ${MAX_GOAL_BYTES} bytes`),
  description: z
    .string()
    .min(1)
    .refine(withinGoalBytes, `description must be at most ${MAX_GOAL_BYTES} bytes`)
    .optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
});

const WINDOW_RE = /^(\d{1,3})([hd])$/;
/** The widest cost window a single request may materialize (bounded read, like the task list). */
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Parse a `?window=` like `24h` / `7d` into milliseconds; fail-closed on anything else. */
function parseWindowMs(raw: string | undefined): number {
  if (raw === undefined) return 24 * 60 * 60 * 1000;
  const m = WINDOW_RE.exec(raw);
  if (!m) {
    throw new ApiError('VALIDATION_ERROR', "window must look like '24h' or '7d'.", {
      window: raw,
    });
  }
  const n = Number.parseInt(m[1] as string, 10);
  const ms = m[2] === 'h' ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
  if (ms > MAX_WINDOW_MS) {
    throw new ApiError('VALIDATION_ERROR', "window must not exceed '90d'.", { window: raw });
  }
  return ms;
}

/** Serialize a stored workforce journal row fail-closed (drop anything off-vocabulary). */
function serializeWorkforceEventData(data: unknown): string | undefined {
  const parsed = workforceJournalEventSchema.safeParse(data);
  if (!parsed.success) return undefined;
  try {
    return JSON.stringify(parsed.data);
  } catch {
    return undefined;
  }
}

/** The wired seam, or the wholesale fail-closed 501. */
function requireWorkforce(deps: AppDeps): WorkforceControl {
  if (!deps.workforce) {
    throw new ApiError(
      'NOT_IMPLEMENTED',
      'The task engine requires a configured durable worker. No task dispatcher is wired on this deployment.',
    );
  }
  return deps.workforce;
}

/** The wired goal-intake seam, or the fail-closed 501 (intake needs a DECLARED workforce). */
function requireGoalIntake(deps: AppDeps): WorkforceGoalIntake {
  if (!deps.workforceGoalIntake) {
    throw new ApiError(
      'NOT_IMPLEMENTED',
      'Goal submission requires a declared workforce. This deployment declares none, so no orchestrator seat can own the goal.',
    );
  }
  return deps.workforceGoalIntake;
}

function tenantHandle(deps: AppDeps, tenantId: string | undefined): TenantDb {
  if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
  return forTenant(deps.db, tenantId);
}

/** Map the engine's typed refusals onto the HTTP envelope; rethrow anything unexpected. */
function mapEngineError(err: unknown): never {
  if (
    err instanceof TaskNotFoundError ||
    err instanceof ApprovalNotFoundError ||
    err instanceof ReviewNotFoundError
  ) {
    throw new ApiError('NOT_FOUND', 'Not found.');
  }
  if (err instanceof ReviewAlreadyDecidedError) {
    throw new ApiError('CONFLICT', 'The review already carries a verdict.');
  }
  if (err instanceof ReviewTaskStateError) {
    throw new ApiError('CONFLICT', 'The task is no longer waiting for this review.');
  }
  if (err instanceof ReviewNotForParkError) {
    // The stale-review interleaving: an abandoned review keeps an undecided row, so it still lists
    // first in the inbox while a later round holds the park. Deciding it is a conflict about WHICH
    // review the task waits on — nothing was written, and the caller can act on that.
    throw new ApiError('CONFLICT', 'The task is waiting on a different review.');
  }
  if (err instanceof WorkforceUnknownError) {
    throw new ApiError('NOT_FOUND', 'Not found.');
  }
  if (err instanceof ApprovalAlreadyDecidedError) {
    throw new ApiError('CONFLICT', 'The approval is already decided.');
  }
  if (err instanceof WorkforceDrainTimeoutError) {
    throw new ApiError(
      'GATEWAY_TIMEOUT',
      'The pause is in force, but in-flight turns did not drain inside the request window. Re-issue the drain.',
      { stillWorking: err.stillWorking },
    );
  }
  throw err;
}

type TaskRow = typeof schema.workforceTasks.$inferSelect;

/**
 * The keyset cursor: strictly-after the primary key. Ordering is `task_id asc` — the same
 * precision-proof default the declared store list uses (`id asc`): a timestamp order column would
 * make the cursor lossy (the driver's Date carries milliseconds, the column microseconds), and a
 * page boundary that re-serves its last row is a pagination bug, not a nicety.
 */
function encodeCursor(row: TaskRow): string {
  return Buffer.from(JSON.stringify({ id: row.taskId }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { id: string } {
  try {
    return z
      .strictObject({ id: z.string().min(1) })
      .parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Malformed cursor.', {});
  }
}

export function registerWorkforceRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // ── reads ─────────────────────────────────────────────────────────────────────────────────────

  // GET /v1/workforce/:workforceId/status — control state, task counts, queue depth, headroom.
  // Registered BEFORE the task routes so a workforce id is never shadowed by a fixed segment.
  app.get(
    '/v1/workforce/:workforceId/status',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:read'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const workforceId = workforceIdParam(c);
      try {
        const runtime = await readWorkforceRuntime(tdb, workforceId);
        const budgets = resolveWorkforceBudgets(runtime.budgets, workforceId);
        // Aggregated IN the database — the view must not materialize the tenant's task
        // partition into process memory to count nine statuses.
        const grouped = (await tdb
          .select(schema.workforceTasks, {
            status: schema.workforceTasks.status,
            count: sql<number>`count(*)::int`,
            oldestQueuedAt: sql<Date | null>`min(${schema.workforceTasks.queuedAt})`,
          })
          .where(eq(schema.workforceTasks.workforceId, workforceId))
          .groupBy(schema.workforceTasks.status)) as Array<{
          status: string;
          count: number;
          oldestQueuedAt: Date | null;
        }>;
        const byStatus: Record<string, number> = {};
        for (const g of grouped) byStatus[g.status] = g.count;
        const oldestQueuedAt = grouped.find((g) => g.status === 'queued')?.oldestQueuedAt ?? null;
        // Headroom on the CURRENT workforce window, from the ledger row that enforces it.
        const ceiling = budgets.workforce?.usd ?? null;
        let consumedUsd = 0;
        if (ceiling !== null) {
          const windowStart = windowStartFor(budgets.workforce?.window ?? 'daily', new Date());
          const ledger = (await tdb
            .select(schema.workforceBudgetLedger)
            .where(
              and(
                eq(schema.workforceBudgetLedger.scopeKind, 'workforce'),
                eq(schema.workforceBudgetLedger.scopeId, workforceId),
                eq(schema.workforceBudgetLedger.windowStart, windowStart),
              ),
            )) as Array<typeof schema.workforceBudgetLedger.$inferSelect>;
          consumedUsd = ledger.reduce(
            (sum, r) => sum + Number(r.settledUsd) + Number(r.reservedUsd),
            0,
          );
        }
        return c.json(
          {
            workforceId,
            paused: runtime.paused,
            pausedAt: runtime.pausedAt,
            pausedBy: runtime.pausedBy,
            haltReason: runtime.haltReason,
            tasks: byStatus,
            queueDepth: byStatus.queued ?? 0,
            oldestQueuedAt,
            budget:
              ceiling !== null
                ? {
                    ceilingUsd: ceiling,
                    consumedUsd,
                    headroomUsd: Math.max(ceiling - consumedUsd, 0),
                  }
                : null,
          },
          200,
        );
      } catch (err) {
        mapEngineError(err);
      }
    },
  );

  // GET /v1/workforce/tasks?status=&owner=&workforceId=&cursor=&limit= — keyset-paginated list.
  app.get(
    '/v1/workforce/tasks',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:read'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const status = c.req.query('status');
      if (status !== undefined && !isTaskStatus(status)) {
        throw new ApiError('VALIDATION_ERROR', 'status must be one of the closed status set.', {
          allowed: TASK_STATUSES,
        });
      }
      const owner = c.req.query('owner');
      const workforceId = c.req.query('workforceId');
      const limitRaw = c.req.query('limit');
      const limit = Math.min(
        Math.max(Number.parseInt(limitRaw ?? String(DEFAULT_PAGE), 10) || DEFAULT_PAGE, 1),
        MAX_PAGE,
      );
      const cursorRaw = c.req.query('cursor');
      const after = cursorRaw !== undefined ? decodeCursor(cursorRaw) : undefined;

      const predicates = [
        status !== undefined ? eq(schema.workforceTasks.status, status) : undefined,
        owner !== undefined ? eq(schema.workforceTasks.owner, owner) : undefined,
        workforceId !== undefined ? eq(schema.workforceTasks.workforceId, workforceId) : undefined,
        after !== undefined ? gt(schema.workforceTasks.taskId, after.id) : undefined,
      ].filter((p) => p !== undefined);

      const rows = (await tdb
        .select(schema.workforceTasks)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(asc(schema.workforceTasks.taskId))
        .limit(limit)) as TaskRow[];

      // Serialize FIRST, set pagination headers after (the store-routes ordering: a prepared
      // header must never ride an error response).
      const body = rows as unknown as Record<string, unknown>[];
      if (rows.length === limit) c.header('X-Result-Truncated', 'true');
      const last = rows[rows.length - 1];
      if (last) c.header('X-Next-Cursor', encodeCursor(last));
      return c.json(body, 200);
    },
  );

  // GET /v1/workforce/approvals?status= — the operator's inbox (default: pending).
  app.get(
    '/v1/workforce/approvals',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:read'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const status = c.req.query('status') ?? 'pending';
      if (!APPROVAL_STATUSES.includes(status as (typeof APPROVAL_STATUSES)[number])) {
        throw new ApiError('VALIDATION_ERROR', 'Unknown approval status.', {
          allowed: APPROVAL_STATUSES,
        });
      }
      const rows = await tdb
        .select(schema.workforceApprovals)
        .where(eq(schema.workforceApprovals.status, status))
        .orderBy(asc(schema.workforceApprovals.createdAt))
        .limit(MAX_PAGE + 1);
      const truncated = rows.length > MAX_PAGE;
      c.header('X-Result-Truncated', truncated ? 'true' : 'false');
      return c.json(rows.slice(0, MAX_PAGE) as unknown as Record<string, unknown>[], 200);
    },
  );

  // GET /v1/workforce/cost?window=&by= — settled/reserved roll-up. Default: per ledger scope,
  // byte-unchanged. `?by=` groups server-side (a closed pair; anything else is a typed 400), and
  // each grouping names its BASIS, because the two are honest about different things:
  //   - by=department reads the ENFORCING LEDGER's department scope rows — real window semantics
  //     (settlement buckets), the same rows the ceilings hold on;
  //   - by=employee aggregates the TASK ROWS by owner (the ledger carries no employee scope) and
  //     therefore windows by task CREATION time: a long-lived task's whole settled cost
  //     attributes to the window it was created in. Stated structurally (`basis`), not glossed.
  // Deliberately NOT supported: a workforceId filter — the ledger's scope ids are not uniformly
  // workforce-keyed across kinds, and a filter that silently applied to some kinds and not
  // others would misreport spend. One deployment tenant runs one declared workforce.
  app.get(
    '/v1/workforce/cost',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:read'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const windowMs = parseWindowMs(c.req.query('window'));
      const since = new Date(Date.now() - windowMs);
      const window = c.req.query('window') ?? '24h';
      const by = c.req.query('by');
      if (by !== undefined && by !== 'employee' && by !== 'department') {
        throw new ApiError('VALIDATION_ERROR', "by must be 'employee' or 'department'.", {
          allowed: ['employee', 'department'],
        });
      }

      if (by === 'department') {
        const ledger = schema.workforceBudgetLedger;
        const rows = (await tdb
          .select(ledger, {
            id: ledger.scopeId,
            settledUsd: sql<string>`sum(${ledger.settledUsd})`,
            reservedUsd: sql<string>`sum(${ledger.reservedUsd})`,
            settledTurns: sql<number>`sum(${ledger.settledTurns})::int`,
          })
          .where(and(eq(ledger.scopeKind, 'department'), gte(ledger.updatedAt, since)))
          .groupBy(ledger.scopeId)
          .orderBy(sql`sum(${ledger.settledUsd}) desc`, asc(ledger.scopeId))
          .limit(MAX_PAGE + 1)) as Array<{
          id: string;
          settledUsd: string;
          reservedUsd: string;
          settledTurns: number;
        }>;
        c.header('X-Result-Truncated', rows.length > MAX_PAGE ? 'true' : 'false');
        return c.json(
          {
            window,
            by,
            basis: 'budget_ledger',
            groups: rows.slice(0, MAX_PAGE).map((row) => ({
              id: row.id,
              settledUsd: Number(row.settledUsd),
              reservedUsd: Number(row.reservedUsd),
              settledTurns: row.settledTurns,
            })),
          },
          200,
        );
      }

      if (by === 'employee') {
        const tasks = schema.workforceTasks;
        const rows = (await tdb
          .select(tasks, {
            id: tasks.owner,
            settledUsd: sql<string>`sum(${tasks.costUsd})`,
            settledTurns: sql<number>`sum(${tasks.turnsUsed})::int`,
            tasks: sql<number>`count(*)::int`,
          })
          .where(gte(tasks.createdAt, since))
          .groupBy(tasks.owner)
          .orderBy(sql`sum(${tasks.costUsd}) desc`, asc(tasks.owner))
          .limit(MAX_PAGE + 1)) as Array<{
          id: string;
          settledUsd: string;
          settledTurns: number;
          tasks: number;
        }>;
        c.header('X-Result-Truncated', rows.length > MAX_PAGE ? 'true' : 'false');
        return c.json(
          {
            window,
            by,
            basis: 'task_rows',
            groups: rows.slice(0, MAX_PAGE).map((row) => ({
              id: row.id,
              settledUsd: Number(row.settledUsd),
              settledTurns: row.settledTurns,
              tasks: row.tasks,
            })),
          },
          200,
        );
      }

      const rows = (await tdb
        .select(schema.workforceBudgetLedger)
        .where(gte(schema.workforceBudgetLedger.updatedAt, since))) as Array<
        typeof schema.workforceBudgetLedger.$inferSelect
      >;
      const scopes = rows.map((r) => ({
        scopeKind: r.scopeKind,
        scopeId: r.scopeId,
        windowStart: r.windowStart.toISOString(),
        reservedUsd: r.reservedUsd,
        settledUsd: r.settledUsd,
        settledTurns: r.settledTurns,
      }));
      const totalSettledUsd = rows
        .filter((r) => r.scopeKind === 'task')
        .reduce((sum, r) => sum + Number(r.settledUsd), 0);
      return c.json({ window, totalSettledUsd, scopes }, 200);
    },
  );

  // GET /v1/workforce/tasks/:id — one task row (uniform 404 for foreign/absent).
  app.get(
    '/v1/workforce/tasks/:id',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:read'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const rows = (await tdb
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.taskId, c.req.param('id')))) as TaskRow[];
      const task = rows[0];
      if (!task) throw new ApiError('NOT_FOUND', 'Not found.');
      return c.json(task as unknown as Record<string, unknown>, 200);
    },
  );

  // GET /v1/workforce/tasks/:id/events — the task's journal replay (same shape as run events).
  app.get(
    '/v1/workforce/tasks/:id/events',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:read'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const taskId = c.req.param('id');
      const rows = await tdb
        .select(schema.workforceTasks, { taskId: schema.workforceTasks.taskId })
        .where(eq(schema.workforceTasks.taskId, taskId));
      if (rows.length === 0) throw new ApiError('NOT_FOUND', 'Not found.');
      return replayJournalEventsAsSse(
        c,
        tdb,
        taskId,
        resolveLastEventId(c),
        serializeWorkforceEventData,
      );
    },
  );

  // GET /v1/workforce/tasks/:id/tree — the WHOLE subtree the task belongs to, flat. `:id` may be
  // ANY member of the subtree; the read anchors on its root, so an operator can ask from
  // whichever task id they are holding. Three bounded reads, no per-node walk: the anchor row,
  // one indexed root scan, and the runtime row for the per-task ceiling (what the goal line of a
  // rendered tree divides by — the ceiling that binds the SUBTREE scope, not the workforce
  // window, which is `status`'s number). Rows come back flat in `task_id asc` (the parent
  // pointers are on the rows; nesting is the caller's) and CAP at TREE_MAX_TASKS with the
  // truncation header — an operator most needs the tree exactly when a subtree ran away, so a
  // capped prefix with an explicit flag beats a refusal that blinds the console.
  app.get(
    '/v1/workforce/tasks/:id/tree',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:read'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const anchorRows = (await tdb
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.taskId, c.req.param('id')))) as TaskRow[];
      const anchor = anchorRows[0];
      if (!anchor) throw new ApiError('NOT_FOUND', 'Not found.');
      const rows = (await tdb
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.rootTaskId, anchor.rootTaskId))
        .orderBy(asc(schema.workforceTasks.taskId))
        .limit(TREE_MAX_TASKS + 1)) as TaskRow[];
      const truncated = rows.length > TREE_MAX_TASKS;
      let budgets: { taskUsd: number | null; taskTurns: number | null } | null = null;
      if (anchor.workforceId !== null) {
        try {
          const runtime = await readWorkforceRuntime(tdb, anchor.workforceId);
          const resolved = resolveWorkforceBudgets(runtime.budgets, anchor.workforceId);
          budgets = {
            taskUsd: resolved.task?.usd ?? null,
            taskTurns: resolved.task?.turns ?? null,
          };
        } catch (err) {
          // A bare engine-driven subtree may predate any runtime row — the tree still renders,
          // with no ceiling to divide by. Anything else is a real error.
          if (!(err instanceof WorkforceUnknownError)) throw err;
        }
      }
      c.header('X-Result-Truncated', truncated ? 'true' : 'false');
      return c.json(
        {
          rootTaskId: anchor.rootTaskId,
          tasks: rows.slice(0, TREE_MAX_TASKS) as unknown as Record<string, unknown>[],
          budgets,
        },
        200,
      );
    },
  );

  // ── mutations ─────────────────────────────────────────────────────────────────────────────────

  // POST /v1/workforce/tasks/:id/signal — deliver one closed-set wake signal.
  app.post(
    '/v1/workforce/tasks/:id/signal',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:write'),
    async (c) => {
      const workforce = requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const body = signalRequestSchema.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
      try {
        const outcome = await deliverSignal(tdb, {
          taskId: c.req.param('id'),
          kind: body.kind,
          signalKey: body.signalKey ?? `api:${body.kind}:${crypto.randomUUID()}`,
          payload: body.payload,
          actor: actorFrom(c),
        });
        workforce.kick();
        return c.json({ delivered: outcome.delivered, woke: outcome.woke }, 202);
      } catch (err) {
        mapEngineError(err);
      }
    },
  );

  // POST /v1/workforce/tasks/:id/cancel — root-first cascade; a working turn is never killed.
  app.post(
    '/v1/workforce/tasks/:id/cancel',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:write'),
    async (c) => {
      const workforce = requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const body = cancelRequestSchema.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
      try {
        const outcome = await cancelTaskCascade(tdb, {
          taskId: c.req.param('id'),
          actor: actorFrom(c),
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
        });
        workforce.kick();
        return c.json(outcome as unknown as Record<string, unknown>, 202);
      } catch (err) {
        mapEngineError(err);
      }
    },
  );

  // POST /v1/workforce/approvals/:id/decide — resolve a pending approval, wake its task.
  app.post(
    '/v1/workforce/approvals/:id/decide',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:write'),
    async (c) => {
      const workforce = requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const body = decideRequestSchema.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
      try {
        const approval = await decideApproval(tdb, {
          approvalId: c.req.param('id'),
          decision: body.decision,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          decidedBy: actorFrom(c),
        });
        workforce.kick();
        return c.json(approval as unknown as Record<string, unknown>, 200);
      } catch (err) {
        mapEngineError(err);
      }
    },
  );

  // GET /v1/workforce/reviews — the undecided-review inbox (a parked review must be decidable,
  // exactly as a parked approval is; an enterable state with no exit would be a defect).
  app.get(
    '/v1/workforce/reviews',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:read'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const rows = (await tdb
        .select(schema.workforceReviews)
        .where(isNull(schema.workforceReviews.verdict))
        .orderBy(asc(schema.workforceReviews.createdAt))
        .limit(MAX_PAGE + 1)) as Array<typeof schema.workforceReviews.$inferSelect>;
      const truncated = rows.length > MAX_PAGE;
      c.header('X-Result-Truncated', truncated ? 'true' : 'false');
      return c.json(rows.slice(0, MAX_PAGE) as unknown as Record<string, unknown>[], 200);
    },
  );

  // POST /v1/workforce/reviews/:id/verdict — apply one verdict (accept completes; reject reworks
  // through queued until the round ceiling parks the task for a human).
  app.post(
    '/v1/workforce/reviews/:id/verdict',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:write'),
    async (c) => {
      const workforce = requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const body = reviewVerdictSchema.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
      const reviewId = c.req.param('id');
      try {
        // Resolve the round ceiling from the task's own workforce declaration (a bare platform
        // task reviews under the empty declaration — no ceiling, never a guessed one).
        const reviewRows = (await tdb
          .select(schema.workforceReviews)
          .where(eq(schema.workforceReviews.id, reviewId))) as Array<
          typeof schema.workforceReviews.$inferSelect
        >;
        const review = reviewRows[0];
        if (!review) throw new ApiError('NOT_FOUND', 'Not found.');
        const taskRows = (await tdb
          .select(schema.workforceTasks)
          .where(eq(schema.workforceTasks.taskId, review.taskId))) as TaskRow[];
        const workforceId = taskRows[0]?.workforceId ?? null;
        // Same posture as the dispatcher's claim: ensure the runtime row (idempotent upsert) and
        // resolve the declared ceilings from it; a bare platform task reviews under the empty
        // declaration.
        const budgets =
          workforceId !== null
            ? resolveWorkforceBudgets(
                (await ensureWorkforceRuntime(tdb, workforceId)).budgets,
                workforceId,
              )
            : workforceBudgetsSchema.parse({});
        const task = await applyReviewVerdict(tdb, budgets, {
          reviewId,
          verdict: body.verdict,
          reasons: body.reasons,
          requiredChanges: body.requiredChanges,
          actor: actorFrom(c),
        });
        workforce.kick();
        return c.json(
          { reviewId, verdict: body.verdict, taskId: task.taskId, taskStatus: task.status },
          200,
        );
      } catch (err) {
        mapEngineError(err);
      }
    },
  );

  // POST /v1/workforce/:workforceId/goals — submit a goal; the deployment's orchestration
  // strategy shapes it into durable tasks and the dispatcher picks them up. 202: the tasks exist
  // `planned`; nothing has run yet, and the task list / tree is where progress reads.
  app.post(
    '/v1/workforce/:workforceId/goals',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:write'),
    async (c) => {
      const workforce = requireWorkforce(deps);
      const intake = requireGoalIntake(deps);
      const workforceId = workforceIdParam(c);
      const tenantId = c.get('tenantId');
      if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
      const body = goalRequestSchema.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
      const result = await intake.submitGoal({
        tenantId,
        workforceId,
        goal: body.goal,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        requestedBy: actorFrom(c),
      });
      if (result.outcome === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
      if (result.outcome === 'invalid_plan') {
        // The strategy is deployment configuration, never client input — a refused plan is a
        // server-side defect and says so, rather than hiding behind a 4xx the caller cannot fix.
        throw new ApiError(
          'INTERNAL',
          `The orchestration strategy produced a plan the intake refused: ${result.detail}`,
        );
      }
      workforce.kick();
      return c.json({ workforceId, tasks: result.tasks }, 202);
    },
  );

  // POST /v1/workforce/:workforceId/pause — stop reserving; with drain, return only when quiet.
  app.post(
    '/v1/workforce/:workforceId/pause',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:write'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const body = pauseRequestSchema.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
      try {
        const runtime = await pauseWorkforce(tdb, {
          workforceId: workforceIdParam(c),
          actor: actorFrom(c),
          drain: body.drain,
          drainTimeoutMs: HTTP_DRAIN_TIMEOUT_MS,
        });
        return c.json({ workforceId: runtime.workforceId, paused: runtime.paused }, 200);
      } catch (err) {
        mapEngineError(err);
      }
    },
  );

  // POST /v1/workforce/:workforceId/resume — reserving restarts; nothing needs re-queueing.
  app.post(
    '/v1/workforce/:workforceId/resume',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:write'),
    async (c) => {
      const workforce = requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      try {
        const runtime = await resumeWorkforce(tdb, {
          workforceId: workforceIdParam(c),
          actor: actorFrom(c),
        });
        workforce.kick();
        return c.json({ workforceId: runtime.workforceId, paused: runtime.paused }, 200);
      } catch (err) {
        mapEngineError(err);
      }
    },
  );

  // POST /v1/workforce/:workforceId/halt — drain, then cancel root-first. Never mid-flight.
  app.post(
    '/v1/workforce/:workforceId/halt',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:write'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const body = haltRequestSchema.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
      try {
        const outcome = await haltWorkforce(tdb, {
          workforceId: workforceIdParam(c),
          actor: actorFrom(c),
          reason: body.reason,
          drainTimeoutMs: HTTP_DRAIN_TIMEOUT_MS,
        });
        return c.json(outcome as unknown as Record<string, unknown>, 200);
      } catch (err) {
        mapEngineError(err);
      }
    },
  );
}
