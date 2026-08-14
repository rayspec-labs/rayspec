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
 * Errors map typed: an unknown task/approval → 404 (uniform with foreign), a second decision on a
 * resolved approval → 409, a drain that cannot complete inside the HTTP window → 504 (the pause
 * itself is already in force — the response says exactly that).
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { ApiError } from '@rayspec/auth-core';
import { forTenant, schema, type TenantDb } from '@rayspec/db';
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  approvalDecisionSchema,
  cancelTaskCascade,
  decideApproval,
  deliverSignal,
  haltWorkforce,
  isTaskStatus,
  pauseWorkforce,
  readWorkforceRuntime,
  resolveWorkforceBudgets,
  resumeWorkforce,
  signalKindSchema,
  TASK_STATUSES,
  TaskNotFoundError,
  WorkforceDrainTimeoutError,
  WorkforceUnknownError,
  windowStartFor,
  workforceJournalEventSchema,
} from '@rayspec/tasks';
import { and, asc, eq, gt, gte } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDeps, AppEnv, WorkforceControl } from '../app-context.js';
import { readBoundedJson } from '../http/bounded-body.js';
import { replayJournalEventsAsSse, resolveLastEventId } from '../http/journal-replay.js';
import { requireAuth, requirePermission, resolveTenant } from '../http/middleware.js';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** The drain window an HTTP pause may hold the request for; past it → 504 (the pause holds). */
const HTTP_DRAIN_TIMEOUT_MS = 25_000;

const signalRequestSchema = z.strictObject({
  kind: signalKindSchema,
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

const WINDOW_RE = /^(\d{1,3})([hd])$/;

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
  return m[2] === 'h' ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
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

function tenantHandle(deps: AppDeps, tenantId: string | undefined): TenantDb {
  if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
  return forTenant(deps.db, tenantId);
}

/** Map the engine's typed refusals onto the HTTP envelope; rethrow anything unexpected. */
function mapEngineError(err: unknown): never {
  if (err instanceof TaskNotFoundError || err instanceof ApprovalNotFoundError) {
    throw new ApiError('NOT_FOUND', 'Not found.');
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
      const rows = await tdb
        .select(schema.workforceApprovals)
        .where(eq(schema.workforceApprovals.status, status))
        .orderBy(asc(schema.workforceApprovals.createdAt));
      return c.json(rows as unknown as Record<string, unknown>[], 200);
    },
  );

  // GET /v1/workforce/cost?window=&workforceId= — settled/reserved roll-up per ledger scope.
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
      return c.json({ window: c.req.query('window') ?? '24h', totalSettledUsd, scopes }, 200);
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

  // GET /v1/workforce/:workforceId/status — control state, task counts, queue depth, headroom.
  app.get(
    '/v1/workforce/:workforceId/status',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:read'),
    async (c) => {
      requireWorkforce(deps);
      const tdb = tenantHandle(deps, c.get('tenantId'));
      const workforceId = c.req.param('workforceId');
      try {
        const runtime = await readWorkforceRuntime(tdb, workforceId);
        const budgets = resolveWorkforceBudgets(runtime.budgets, workforceId);
        const tasks = (await tdb
          .select(schema.workforceTasks)
          .where(eq(schema.workforceTasks.workforceId, workforceId))) as TaskRow[];
        const byStatus: Record<string, number> = {};
        for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        const oldestQueuedAt = tasks
          .filter((t) => t.status === 'queued' && t.queuedAt !== null)
          .reduce<Date | null>(
            (oldest, t) =>
              oldest === null || (t.queuedAt as Date).getTime() < oldest.getTime()
                ? (t.queuedAt as Date)
                : oldest,
            null,
          );
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
          actor: 'user',
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
          actor: 'user',
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
          decidedBy: body.decidedBy,
        });
        workforce.kick();
        return c.json(approval as unknown as Record<string, unknown>, 200);
      } catch (err) {
        mapEngineError(err);
      }
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
          workforceId: c.req.param('workforceId'),
          actor: 'user',
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
          workforceId: c.req.param('workforceId'),
          actor: 'user',
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
          workforceId: c.req.param('workforceId'),
          actor: 'user',
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
