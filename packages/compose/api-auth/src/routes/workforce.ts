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
 * THE TWO DECISION DOORS ALSO KEEP THE ROW'S OWN AUTHORIZATION. An approval's `approver` and a
 * review's `reviewer` are accountability facts the engine journals (and the approval timeout sweep
 * MINTS one when it escalates to the requester's declared superior), so `store:write` alone is not
 * enough to resolve a row addressed to someone else: the engine compares the SERVER-DERIVED actor
 * against the recorded decider. `approver: 'user'` stays the open sentinel — the deployment's human
 * operator surface, and the shipped single-operator posture is unchanged. The break-glass path
 * (`override: true` on the body AND the `workforce:override` permission) exists so an unavailable
 * decider never wedges a deployment, and lands in the journal so the trail stays honest.
 *
 * Errors map typed: an unknown task/approval/review → 404 (uniform with foreign), a second decision
 * on a resolved approval or review → 409, a decision on a row that names a DIFFERENT decider → 403
 * naming who it names, a verdict aimed at a park waiting on a DIFFERENT review
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
  ApprovalApproverMismatchError,
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
  MAX_TASK_TEXT_BYTES,
  operatorSignalKindSchema,
  pauseWorkforce,
  RESERVED_WORKFORCE_SEGMENTS,
  ReviewAlreadyDecidedError,
  ReviewNotForParkError,
  ReviewNotFoundError,
  ReviewReviewerMismatchError,
  ReviewTaskStateError,
  readWorkforceRuntime,
  resolveWorkforceBudgets,
  resumeWorkforce,
  reviewVerdictSchema,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskNotFoundError,
  WorkforceDrainTimeoutError,
  WorkforcePausedError,
  WorkforceUnknownError,
  windowStartFor,
  workforceBudgetsSchema,
  workforceJournalEventSchema,
} from '@rayspec/tasks';
import { and, asc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppDeps, AppEnv, WorkforceControl, WorkforceGoalIntake } from '../app-context.js';
import { readBoundedJson } from '../http/bounded-body.js';
import { replayJournalEventsAsSse, resolveLastEventId } from '../http/journal-replay.js';
import {
  enforcePermission,
  requireAuth,
  requirePermission,
  resolveTenant,
} from '../http/middleware.js';

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

/**
 * BREAK-GLASS on a workforce decision, resolved to the flag the engine accepts.
 *
 * An approval's `approver` and a review's `reviewer` bind their decision door (@rayspec/tasks
 * decision-authority.ts). A deployment must never be permanently wedged by a named decider who has
 * gone unavailable — but "the override happened" has to be a DELIBERATE, ATTRIBUTED act, so it
 * takes TWO independent things, and neither alone does anything:
 *
 *  1. the request ASKS (`override: true` on the strict body) — intent, never authority;
 *  2. the principal HOLDS `workforce:override` — authority, checked server-side through the very
 *     same `enforcePermission` gate the route's `store:write` middleware used (live membership for
 *     this sensitive permission, an `authz_denied` audit row on refusal, a 403 naming the gap).
 *
 * A caller that asks without the permission gets that 403 rather than a silent downgrade to an
 * ordinary decision, whose refusal would then name the wrong problem. A caller that HOLDS the
 * permission but did not ask overrides nothing — holding an administrative role must not quietly
 * dissolve someone else's recorded accountability.
 */
async function breakGlassAuthorized(
  deps: AppDeps,
  c: Context<AppEnv>,
  asked: boolean,
): Promise<boolean> {
  if (!asked) return false;
  await enforcePermission(deps, c, 'workforce:override');
  return true;
}

/**
 * The paging + drain constants and the request schemas below are EXPORTED, not module-private, for
 * exactly one reason: `engine/emit-workforce-openapi.ts` builds this surface's OpenAPI section from
 * THEM rather than from a retyped copy. A documented default, cap or request shape that disagrees
 * with what the handler enforces would be a contract wider than its mechanism — the one failure
 * mode this surface cannot afford — so the document derives from the same objects the routes use.
 * Nothing outside that emitter imports them, and none is re-exported from the package barrel.
 */
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/** The tree read's hard row cap — the ceiling of RENDERABLE output, not a paging economics
 * number. Past it the response is a truncated prefix with the header flag set. */
export const TREE_MAX_TASKS = 500;

/** The approval rows' closed status vocabulary (the filter refuses free text, like the task list). */
export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'timed_out',
  'escalated',
] as const;

/** The drain window an HTTP pause may hold the request for; past it → 504 (the pause holds). */
export const HTTP_DRAIN_TIMEOUT_MS = 25_000;

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

export const signalRequestSchema = z.strictObject({
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

export const cancelRequestSchema = z.strictObject({
  reason: z.string().min(1).max(500).optional(),
});

export const decideRequestSchema = approvalDecisionSchema;

export const pauseRequestSchema = z.strictObject({
  drain: z.boolean().default(false),
});

export const haltRequestSchema = z.strictObject({
  reason: z.string().min(1).max(500),
});

/**
 * The goal (and description) ceiling at the intake edge, in BYTES — the SHARED `MAX_TASK_TEXT_BYTES`
 * (@rayspec/tasks), the same constant and unit the engine's creation schema and the delegate/create
 * toolset enforce (a character cap would let a multibyte goal pass here and burst the byte-denominated
 * turn-input budget there). It is a fraction of the assembly's task-section budget — the assembly
 * asserts THAT margin (`MAX_TASK_TEXT_BYTES` vs `SECTION_BUDGETS.task`) at module load (context.ts) —
 * so a goal accepted on this surface can ALWAYS be rendered untrimmed into the owning employee's
 * turns; the goal-never-trimmed refusal then only ever fires on goals minted by code that bypassed
 * this cap.
 */
const MAX_GOAL_BYTES = MAX_TASK_TEXT_BYTES;
const withinGoalBytes = (text: string) => Buffer.byteLength(text, 'utf8') <= MAX_GOAL_BYTES;

export const goalRequestSchema = z.strictObject({
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
  // The decision doors' authority refusals. 403 rather than 404: the caller is an authenticated
  // `store:write` member of THIS tenant and the row is theirs to see — what they lack is the
  // identity the row names. `details` carries that name so the refusal is ACTIONABLE (route it to
  // that principal, or break the glass); it is a tenant-internal declared id, disclosed only to a
  // principal already able to list the row through the inbox route.
  if (err instanceof ApprovalApproverMismatchError) {
    throw new ApiError(
      'FORBIDDEN',
      'This approval names a different approver. Decide it as that principal, or re-send with `override: true` if you hold workforce:override.',
      { approver: err.approver },
    );
  }
  if (err instanceof ReviewReviewerMismatchError) {
    throw new ApiError(
      'FORBIDDEN',
      'This review names a different reviewer. Decide it as that principal, or re-send with `override: true` if you hold workforce:override.',
      { reviewer: err.reviewer },
    );
  }
  if (err instanceof WorkforceDrainTimeoutError) {
    throw new ApiError(
      'GATEWAY_TIMEOUT',
      'The pause is in force, but in-flight turns did not drain inside the request window. Re-issue the drain.',
      { stillWorking: err.stillWorking },
    );
  }
  // 409, not 403 and not 404: the caller is authenticated, permitted, and naming a workforce that
  // exists and is theirs — what refuses them is the RESOURCE'S STATE, which is what CONFLICT means
  // on this surface. It is also the honest status for the caller's next move: resume the workforce
  // and re-send the identical request. No `details` — the code carries the whole answer, and
  // CONFLICT is not in DETAILS_ALLOWED, so the envelope would strip one anyway.
  if (err instanceof WorkforcePausedError) {
    throw new ApiError(
      'CONFLICT',
      'The workforce is paused and is not accepting new work. Resume it, then re-submit.',
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

/**
 * THE EXPERIMENTAL MARKING THIS SURFACE PUTS ON THE WIRE.
 *
 * `RAYSPEC_EXPERIMENTAL_WORKFORCE` gates AUTHORING and BOOT. An integrator holding nothing but a
 * running deployment's base URL never meets that gate — they meet these routes, and until now the
 * routes said nothing about their own stability.
 *
 * A HEADER **AND** AN OPENAPI TAG — the header first, and it is not superseded.
 *
 * This constant shipped as a header alone because at the time no OpenAPI document described these
 * routes, so a tag would have been a marking nobody could fetch. That is no longer true:
 * `engine/emit-workforce-openapi.ts` now describes the whole section in the SERVED
 * `GET /v1/openapi.json`, carrying `x-rayspec-experimental` on the section tag AND on every
 * operation — which is the only marking a CLIENT GENERATOR can see, because a generator reads the
 * document and never makes a request. (`rayspec openapi` still emits the PRODUCT-PROFILE view
 * surface and still refuses a backend-profile document; that is unchanged.)
 *
 * The two are complementary, and neither replaces the other. The header reaches the caller who
 * never fetches a document — including the fail-closed 501 and the unauthenticated 401, responses
 * that carry no body to read a marking from. The document reaches the toolchain that never makes a
 * request. The document also DESCRIBES this header on every response, so the two cannot disagree
 * about whether it is sent.
 *
 * DISTINCT FROM `OPENAPI_POSTURE_NOTICE`, which states the DEPLOYMENT posture (local / trusted /
 * not internet-facing) of the whole API. This states the STABILITY of one section. Two different
 * claims; neither substitutes for the other.
 *
 * Listed in `createAuthApp`'s CORS `exposeHeaders` — it is not a CORS-safelisted response header,
 * so without that a browser `fetch` client could not read it, and a marking that ships but cannot
 * be seen is not a marking.
 */
export const WORKFORCE_EXPERIMENTAL_HEADER = 'X-Experimental';
export const WORKFORCE_EXPERIMENTAL_HEADER_VALUE = 'workforce';

export function registerWorkforceRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // The marking rides EVERY response from this prefix — including the fail-closed 501 and an
  // unauthenticated 401, which are exactly the responses a marking usually misses and exactly the
  // callers who have no body to read it from. Applied POST-`next()` (the `securityHeaders` shape),
  // registered here rather than in `createAuthApp` so a route added to THIS function cannot be
  // added without it; the structural assertion in `workforce-experimental-header.db.test.ts` keeps
  // every path in this module under the globbed prefix.
  app.use('/v1/workforce/*', async (c, next) => {
    await next();
    c.header(WORKFORCE_EXPERIMENTAL_HEADER, WORKFORCE_EXPERIMENTAL_HEADER_VALUE);
  });

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────

  // GET /v1/workforce/:workforceId/status — control state, task counts, queue depth, and the
  // budget picture (`budgetExhausted`, `budget`, `budgetTiers`, `blockedOnBudget`).
  // Registered BEFORE the task routes so a workforce id is never shadowed by a fixed segment.
  //
  // THE SECOND THING A CONSUMER MUST NOT GET WRONG (the first is below): `budget` is the
  // WORKFORCE TIER ONLY. It was once the whole budget answer, and that made this summary lie —
  // a workforce stalled on an exhausted DEPARTMENT ceiling read as 99.86 % open, because the
  // engine meters four scopes and this view asked one. `budgetTiers` and `blockedOnBudget` are
  // the fix and are documented at the code that builds them; `budget` is kept, unchanged, only
  // so existing consumers do not break. Do not read it as "the budget".
  //
  // THE ONE THING A CONSUMER OF THIS RESPONSE MUST NOT GET WRONG:
  //
  //   `paused` is the LIVENESS flag. It alone answers "is this workforce stopped right now".
  //   `haltReason` (with `haltedAt`) answers "WHY WAS THIS LAST HALTED". It is a HISTORICAL
  //   RECORD, never a liveness flag, and it is NOT cleared by a resume.
  //
  // So `{ paused: false, haltReason: 'incident' }` is a normal, correct state: it means the
  // workforce was halted for 'incident', an operator resumed it, and it is RUNNING NOW. Resume
  // deliberately keeps the reason — clearing it would destroy the only durable record of why the
  // last halt happened outside the event journal, which is the more expensive thing to lose.
  //
  // Branching on `haltReason !== null` to decide whether a workforce is halted is therefore WRONG
  // in exactly one direction: it reports a resumed workforce as halted, forever, from its first
  // halt onward. Branch on `paused`. A halt implies a pause — `haltWorkforce`'s first act is
  // `pauseWorkforce(..., drain: true)` — so `paused` covers both operator verbs on its own.
  //
  // Pinned by `routes/workforce.test.ts`, `halt then resume reports paused:false with the halt
  // reason KEPT`. RESIDUAL, stated rather than implied away: that test holds this DOCUMENTATION
  // honest,
  // not any consumer's use of it. Nothing structural stops a client from reading `haltReason` as
  // liveness — the field is on the wire and the API cannot police how it is interpreted.
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
            // The EXHAUSTION SIGNAL, aggregated in the same pass — see `blockedOnBudget` below.
            // FILTERED on the reason, never on the status alone: a task parked awaiting children
            // or a clarification is also `blocked`, and counting it here would tell an operator to
            // raise a ceiling that is fine.
            budgetBlocked: sql<number>`count(*) filter (where ${schema.workforceTasks.statusReason} = 'budget_exhausted')::int`,
            oldestQueuedAt: sql<Date | null>`min(${schema.workforceTasks.queuedAt})`,
          })
          .where(eq(schema.workforceTasks.workforceId, workforceId))
          .groupBy(schema.workforceTasks.status)) as Array<{
          status: string;
          count: number;
          budgetBlocked: number;
          oldestQueuedAt: Date | null;
        }>;
        const byStatus: Record<string, number> = {};
        for (const g of grouped) byStatus[g.status] = g.count;
        const oldestQueuedAt = grouped.find((g) => g.status === 'queued')?.oldestQueuedAt ?? null;
        // `blocked(budget_exhausted)` is the ONLY park a budget denial produces
        // (@rayspec/tasks `REASON_RULES`), so the blocked group carries the whole count.
        const blockedOnBudget = grouped.find((g) => g.status === 'blocked')?.budgetBlocked ?? 0;

        // ── the enforcing tiers ───────────────────────────────────────────────────────────────
        //
        // WHAT THIS ANSWERS, AND WHAT IT DELIBERATELY DOES NOT. The engine meters FOUR scopes
        // (@rayspec/tasks `ledgerScopesFor`): task, root, department, workforce. This summary
        // enumerates the two whose cardinality is BOUNDED BY THE DECLARATION — the workforce and
        // each declared department. `task` and `root` have one ledger row per task and per
        // submitted goal; enumerating them is exactly the tenant-partition materialization the
        // count above avoids, so they are NOT here and `blockedOnBudget` is the only thing that
        // speaks for them. A `subtree` ceiling fully spent with nothing queued is therefore still
        // not visible in this summary. Stated, because the whole point of this block is that a
        // summary must not read greener than the workforce is.
        //
        // Only tiers with a DECLARED ceiling are listed. A scope with no ceiling enforces nothing
        // and can never exhaust; it still accrues a ledger row (spend visibility is not
        // conditional on enforcement) and its spend belongs to `cost --by department`, not here.
        const now = new Date();
        // The per-turn reservation every authorize adds before comparing to a ceiling. One value
        // per workforce (the dispatcher and every intent applier read this same field), so it is
        // emitted once on the response rather than repeated on each tier.
        const estimateUsdPerTurn = budgets.execution.estimateUsdPerTurn;
        const declaredTiers: Array<{
          scopeKind: 'workforce' | 'department';
          scopeId: string;
          window: string;
          windowStart: Date;
          ceilingUsd: number | null;
          ceilingTurns: number | null;
        }> = [];
        if (budgets.workforce?.usd !== undefined || budgets.workforce?.turns !== undefined) {
          const window = budgets.workforce.window;
          declaredTiers.push({
            scopeKind: 'workforce',
            scopeId: workforceId,
            window,
            windowStart: windowStartFor(window, now),
            ceilingUsd: budgets.workforce.usd ?? null,
            ceilingTurns: budgets.workforce.turns ?? null,
          });
        }
        for (const [departmentId, dep] of Object.entries(budgets.departments ?? {}).sort(
          ([a], [b]) => a.localeCompare(b),
        )) {
          if (dep.usd === undefined && dep.turns === undefined) continue;
          declaredTiers.push({
            scopeKind: 'department',
            scopeId: departmentId,
            window: dep.window,
            windowStart: windowStartFor(dep.window, now),
            ceilingUsd: dep.usd ?? null,
            ceilingTurns: dep.turns ?? null,
          });
        }
        // ONE bounded read for every tier: the row set is (declared tiers) x (their distinct
        // current buckets) over the ledger's own UNIQUE key, never a scan. Rows the `IN`s
        // over-fetch (a department whose id equals the workforce id) are discarded by the
        // (kind, id, window) match below.
        const ledgerRows =
          declaredTiers.length === 0
            ? []
            : ((await tdb
                .select(schema.workforceBudgetLedger)
                .where(
                  and(
                    inArray(schema.workforceBudgetLedger.scopeKind, ['workforce', 'department']),
                    inArray(schema.workforceBudgetLedger.scopeId, [
                      ...new Set(declaredTiers.map((t) => t.scopeId)),
                    ]),
                    inArray(schema.workforceBudgetLedger.windowStart, [
                      ...new Map(
                        declaredTiers.map((t) => [t.windowStart.getTime(), t.windowStart]),
                      ).values(),
                    ]),
                  ),
                )) as Array<typeof schema.workforceBudgetLedger.$inferSelect>);
        const budgetTiers = declaredTiers.map((tier) => {
          const row = ledgerRows.find(
            (r) =>
              r.scopeKind === tier.scopeKind &&
              r.scopeId === tier.scopeId &&
              r.windowStart.getTime() === tier.windowStart.getTime(),
          );
          const tierConsumedUsd =
            row !== undefined ? Number(row.settledUsd) + Number(row.reservedUsd) : 0;
          const tierConsumedTurns = row?.settledTurns ?? 0;
          return {
            scopeKind: tier.scopeKind,
            scopeId: tier.scopeId,
            window: tier.window,
            windowStart: tier.windowStart,
            ceilingUsd: tier.ceilingUsd,
            // UNCLAMPED, ON PURPOSE. A ceiling bounds what may be DISPATCHED, not what may be
            // SETTLED: the denial fires when the NEXT turn would exceed, so the turn already in
            // flight settles above the line and is never aborted. `consumedUsd > ceilingUsd` is
            // how that one-turn overrun reaches an operator.
            consumedUsd: tierConsumedUsd,
            // UNSPENT CEILING — `ceiling - consumed`, floored at zero. It is NOT "what may still be
            // dispatched", and the difference is not academic: the engine admits at
            // `consumed + estimate <= ceiling`, so the last `estimateUsdPerTurn` of every ceiling is
            // unspendable. A scope can sit here with `headroomUsd: 0.04` and refuse every dispatch
            // because a turn reserves `0.05`. `exhausted` below is the field that answers
            // dispatchability; subtract `estimateUsdPerTurn` (emitted on the response) from this to
            // get the spend a client can still expect to place.
            headroomUsd:
              tier.ceilingUsd !== null ? Math.max(tier.ceilingUsd - tierConsumedUsd, 0) : null,
            ceilingTurns: tier.ceilingTurns,
            // Dispatched turns — counted at authorize, not at settlement (@rayspec/tasks
            // `authorizeTurn`), which is what makes a turns ceiling bound concurrency.
            consumedTurns: tierConsumedTurns,
            // THE ENGINE'S OWN ADMISSION RULE, mirrored — not a "spent the ceiling" heuristic.
            // `authorizeTurn` admits a usd scope at `consumed + estimate <= ceiling` and a turns
            // scope at `settledTurns + 1 <= ceilingTurns`; `exhausted` is the negation of each, so
            // it means exactly THIS SCOPE WILL REFUSE THE NEXT DISPATCH.
            //
            // The estimate term is the whole point. It is derived from a document as
            // `task.usd / task.turns` — an UPPER bound on average turn cost — so real consumption
            // normally halts SHORT of the ceiling, inside a reservation band one estimate wide
            // where the ledger still shows unspent ceiling and nothing can run. A
            // `consumed >= ceiling` test reports `false` for every scope in that band, which is the
            // ordinary case, not the corner one.
            //
            // THE MIRROR IS UNCONDITIONAL, not "usually right". A zero estimate cannot coexist with
            // a usd ceiling here: `resolveWorkforceBudgets` (called at the top of this handler)
            // REFUSES every such shape with `WorkforceBudgetsInvalidError` — the fail-closed
            // coherence rule in @rayspec/tasks `workforceBudgetsSchema`. The only shapes it accepts
            // with a zero estimate are turns-only, where `ceilingUsd` is null and this disjunct is
            // guarded off. So whenever the left operand is evaluated, the estimate is positive.
            //
            // The comparison is also STRUCTURALLY identical to the engine's, not merely equivalent:
            // `authorizeTurn` evaluates `settled + reserved + estimate > ceiling`, and
            // `tierConsumedUsd` is built as `settled + reserved` in that same order, so both sides
            // reduce to `((settled + reserved) + estimate)`. IEEE-754 addition is order-sensitive,
            // and a re-association such as `settled + (reserved + estimate)` would agree almost
            // always and disagree exactly on the float boundaries this flag exists to get right.
            //
            // LIMIT, stated rather than implied away: this answers for the next SINGLE-turn
            // dispatch. A delegation reserves `children x estimate` in one authorize
            // (@rayspec/tasks `apply-intents`), so a fan-out is refused strictly earlier than this
            // flag turns true.
            exhausted:
              (tier.ceilingUsd !== null &&
                tierConsumedUsd + estimateUsdPerTurn > tier.ceilingUsd) ||
              (tier.ceilingTurns !== null && tierConsumedTurns >= tier.ceilingTurns),
          };
        });

        // The pre-existing `budget` block, UNCHANGED: the workforce tier's usd ceiling and
        // nothing else. It is kept exactly as it was so no consumer breaks — and it is precisely
        // why `budgetTiers` sits BESIDE it rather than inside it: `budget` is null whenever no
        // whole-workforce usd ceiling is declared, and nesting the enumeration in it would hide
        // an exhausted department on a document that declares department ceilings only. That
        // would be this route's own defect, rebuilt one level down.
        const ceiling = budgets.workforce?.usd ?? null;
        const consumedUsd =
          ceiling !== null
            ? (budgetTiers.find((t) => t.scopeKind === 'workforce')?.consumedUsd ?? 0)
            : 0;

        // THE HEADLINE. One scalar, beside `paused`, because the original defect was NOT that the
        // fact was unavailable — it was legible in `workforce events` the whole time — it was that
        // the SUMMARY read 99.86 % open while the workforce was dead. A truth an operator has to
        // find by scanning an array and comparing two numbers is the same defect wearing a
        // different shape, so the array is the detail and this is the answer.
        //
        // A DISJUNCTION, and each half is load-bearing:
        //  - a tier at or past its ceiling catches the DOOMED-BUT-NOT-YET-DEAD case (the ceiling is
        //    spent, the queue happens to be empty, so nothing is parked and the next goal is
        //    already refused);
        //  - a task parked on budget catches the tiers this route cannot enumerate at all (task and
        //    subtree — one ledger row per task and per submitted goal).
        // Drop either half and there is a real workforce this flag calls healthy.
        //
        // WHAT IT DOES NOT SAY: not "the workforce is dead". An exhausted ceiling on a department
        // nothing is currently working in is true, reportable, and survivable. It says A CEILING
        // SOMEWHERE IS SPENT — `budgetTiers` says which, `blockedOnBudget` says how much work is
        // already stopped, and the task journal says which scope refused a given task.
        const budgetExhausted = budgetTiers.some((t) => t.exhausted) || blockedOnBudget > 0;

        return c.json(
          {
            workforceId,
            paused: runtime.paused,
            pausedAt: runtime.pausedAt,
            pausedBy: runtime.pausedBy,
            // HISTORICAL — "why was this last halted", not "is it halted now". Survives a resume
            // by design; `paused` above is the liveness flag. See this route's header.
            haltReason: runtime.haltReason,
            tasks: byStatus,
            queueDepth: byStatus.queued ?? 0,
            oldestQueuedAt,
            // "Will a declared ceiling refuse the next dispatch?" — the one field an operator must
            // not have to look for. See its derivation above for what it does and does not claim.
            budgetExhausted,
            // The per-turn reservation. Emitted because `headroomUsd` is UNSPENT CEILING, and the
            // gap between that and what may actually still be dispatched is exactly this number.
            // A client is never required to use it to answer "is this scope dead" — `exhausted`
            // and `budgetExhausted` already do, correctly — it is here for the quantity: how much
            // of the reported headroom is unreachable, and how far a ceiling must be raised.
            estimateUsdPerTurn,
            // The CONSEQUENCE signal, tier-agnostic: how many tasks are parked on an exhausted
            // ceiling RIGHT NOW, whichever scope refused them — including the task and subtree
            // scopes `budgetTiers` cannot enumerate. It says THAT work is dead, never WHICH
            // ceiling killed it; that fact is in the task's journal
            // (`workforce.budget.exceeded` carries scopeKind/scopeId/ceiling/consumed).
            blockedOnBudget,
            budget:
              ceiling !== null
                ? {
                    ceilingUsd: ceiling,
                    consumedUsd,
                    headroomUsd: Math.max(ceiling - consumedUsd, 0),
                  }
                : null,
            budgetTiers,
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

      // The per-scope default is a bounded page like every other list on this surface —
      // deterministic order, hard cap, truncation header. `totalSettledUsd` sums the PAGE it
      // returns, and the header is how a reader knows the page is not the whole window.
      const ledger = schema.workforceBudgetLedger;
      const rows = (await tdb
        .select(ledger)
        .where(gte(ledger.updatedAt, since))
        .orderBy(asc(ledger.scopeKind), asc(ledger.scopeId), asc(ledger.windowStart))
        .limit(MAX_PAGE + 1)) as Array<typeof schema.workforceBudgetLedger.$inferSelect>;
      c.header('X-Result-Truncated', rows.length > MAX_PAGE ? 'true' : 'false');
      const page = rows.slice(0, MAX_PAGE);
      const scopes = page.map((r) => ({
        scopeKind: r.scopeKind,
        scopeId: r.scopeId,
        windowStart: r.windowStart.toISOString(),
        reservedUsd: r.reservedUsd,
        settledUsd: r.settledUsd,
        settledTurns: r.settledTurns,
      }));
      const totalSettledUsd = page
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
  // whichever task id they are holding. At most four bounded reads, no per-node walk: the anchor
  // row, one indexed root scan, the root's own row when the capped page happened to miss it (the
  // root ALWAYS rides the response — the goal line is its), and the runtime row for the per-task
  // ceiling (what the goal line of a rendered tree divides by — the ceiling that binds the
  // SUBTREE scope, not the workforce window, which is `status`'s number). Rows come back flat in
  // `task_id asc` (the parent pointers are on the rows; nesting is the caller's) and CAP at
  // TREE_MAX_TASKS with the truncation header — an operator most needs the tree exactly when a
  // subtree ran away, so a capped prefix with an explicit flag beats a refusal that blinds the
  // console.
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
      const pageRows = (await tdb
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.rootTaskId, anchor.rootTaskId))
        .orderBy(asc(schema.workforceTasks.taskId))
        .limit(TREE_MAX_TASKS + 1)) as TaskRow[];
      // THE ROOT ALWAYS RIDES THE RESPONSE. Task ids are random/hash UUIDs — id order is
      // deterministic, not creation order — so a >cap subtree's id-ordered page has no reason to
      // contain the root at all, and a tree whose goal line names an arbitrary child would
      // misread as that child's story. Membership is checked against the SLICED page — the rows we
      // actually return — NOT the +1 overflow probe: when the root sorts at index 500 it is inside
      // the 501-row probe yet dropped by the slice, so checking the probe let the slice strand it
      // (the off-by-one). When the page missed it, one point read fetches it and it takes the first
      // slot; the page yields its tail to stay inside the cap.
      const truncated = pageRows.length > TREE_MAX_TASKS;
      const page = pageRows.slice(0, TREE_MAX_TASKS);
      let rows: TaskRow[];
      if (page.some((row) => row.taskId === anchor.rootTaskId)) {
        rows = page;
      } else {
        const rootRows =
          anchor.taskId === anchor.rootTaskId
            ? [anchor]
            : ((await tdb
                .select(schema.workforceTasks)
                .where(eq(schema.workforceTasks.taskId, anchor.rootTaskId))) as TaskRow[]);
        rows = [...rootRows, ...page].slice(0, TREE_MAX_TASKS);
      }
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
          tasks: rows as unknown as Record<string, unknown>[], // already capped at TREE_MAX_TASKS
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
      // The break-glass gate runs BEFORE the engine call: a caller that asked to override without
      // the permission gets the named 403 here, never a mismatch error that describes the wrong
      // problem — and never a decision.
      const override = await breakGlassAuthorized(deps, c, body.override);
      try {
        const approval = await decideApproval(tdb, {
          approvalId: c.req.param('id'),
          decision: body.decision,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          decidedBy: actorFrom(c),
          overrideNamedApprover: override,
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
      const override = await breakGlassAuthorized(deps, c, body.override);
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
          overrideNamedReviewer: override,
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
  // `planned`; nothing has run yet, and the task list / tree is where progress reads. EVERY CALL
  // IS ITS OWN SUBMISSION — there is no idempotency key on this surface yet, so a client retry
  // after a lost 202 creates a second root (documented in the CLI reference; the caller that
  // needs exactly-once submission checks the task list before retrying).
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
      // R1: this route does not honor Idempotency-Key yet (a retry after a lost 202 mints a SECOND
      // billed root — a double-bill). The two sibling billed-work routes honor the header, so
      // silently ignoring it here is a lost-write trap. Until real idempotency lands, REFUSE a
      // supplied key (400) rather than accepting and dropping it.
      if (c.req.header('Idempotency-Key') !== undefined) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'This route does not support Idempotency-Key yet: a retry after a lost 202 would mint a ' +
            'second root. Omit the header and check the task list before retrying.',
        );
      }
      // C5 QUOTA (cost-DoS bound): every call mints a FRESH billed root run with no dedupe, and
      // budgets are optional (a document without `budgets:` has no backstop), so an authenticated
      // store:write principal could loop-mint unbounded dispatched runs. Throttle one
      // (tenant, workforce) via the SAME limiter triggers.ts/reprocess.ts use — BEFORE the body
      // read, so an over-quota call reads and dispatches nothing.
      const { allowed, retryAfterMs } = await deps.rateLimiter.checkAsync(
        'goal-submit',
        `${tenantId}:${workforceId}`,
      );
      if (!allowed) throw new ApiError('RATE_LIMITED', 'Too many requests.', { retryAfterMs });
      const body = goalRequestSchema.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
      // The intake throws TYPED engine errors (a paused workforce refuses admission), so this route
      // maps them like every sibling control route does. Without this the refusal would surface as
      // an unhandled 500 — a caller could not tell "not accepting work" from "the server broke".
      // The `ApiError`s thrown below pass through `mapEngineError` untouched: it matches none of
      // them and rethrows, so wrapping the whole block changes no existing status.
      try {
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
          // server-side defect and says so (500), not a 4xx the caller cannot fix. R5: the body is
          // STATIC — `result.detail` names employee ids, department names and the strategy id
          // (deployment shape), and this surface's rule is that a 5xx echoes no deployment config
          // to the client. The detail stays server-side.
          throw new ApiError(
            'INTERNAL',
            'The orchestration strategy produced a plan the intake refused — a server-side ' +
              'configuration defect. See the server logs for detail.',
          );
        }
        workforce.kick();
        return c.json({ workforceId, tasks: result.tasks }, 202);
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
