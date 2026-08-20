/**
 * The turn-intent EXECUTOR — one transaction that turns a plan (intent-applier.ts) into rows.
 *
 * Everything a turn produced is applied ATOMICALLY with the task's state transition: result
 * columns, child rows + delegation records, approval/review rows, messages, the cost settlement,
 * the journal events, and the transition itself — the keystone posture that a turn's effects and
 * its state move are one fact. The transaction is IDEMPOTENT under whole-turn re-execution: the
 * first thing it does is look for the turn's RECEIPT (the partial-unique transition row keyed
 * (task, turn number)); a recovered turn whose final transaction already committed finds it and
 * no-ops, so a crash-and-replay changes no terminal outcome and duplicates no side effect.
 *
 * Fan-in runs from here too (`afterTaskTerminal`, task-locks.ts): when a task reaches a terminal
 * status and has a parent parked on `blocked(awaiting_children)`, the fan-in LOCKS THE PARENT ROW
 * FIRST and only then reads the siblings — under READ COMMITTED the post-lock read sees the racing
 * sibling's committed terminal row, so two last children completing concurrently cannot BOTH
 * conclude "join not yet satisfied" and strand the parent. A satisfied join writes exactly ONE
 * `child_completed` signal (the signal-key UNIQUE dedupes) and re-queues the parent; the parent's
 * next dispatch receives the full results keyed by child task id, never by completion order.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE TASK LOCK ORDER — one order, every path that touches more than one task row.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Task rows are locked ROOT-FIRST: a task's ancestors before the task, the task before its
 * descendants, ties inside a level broken by task id. An operation takes the locks on its way UP
 * (`lockRootFirst`) BEFORE its first transition, and `lockDescendants` takes the ones on its way
 * DOWN in the same order. Two operations whose row sets overlap therefore acquire the intersection
 * in the same sequence and QUEUE instead of deadlocking — an operator cancel holding a parent waits
 * for the completing child's turn to finish, rather than the two waiting on each other until
 * Postgres kills one (which turned a cancel into a 500 that did nothing, and a turn into a leaked
 * reservation). A single-row transition needs no pre-lock: it holds one row and wants nothing else,
 * so it can never be half of a cycle — `SINGLE_ROW_PLANS` is where a turn claims that exemption,
 * and it is keyed on the turn's computed PLAN because an intent does not determine its own reach.
 *
 * Rank against the other row types this engine locks: workforce_runtime -> workforce_tasks ->
 * workforce_budget_ledger (established by the dispatcher's claim transaction). BOTH halves of the
 * task order are taken before the FIRST LEDGER ROW, not merely before the first transition: a turn
 * that will cascade knows its plan before it settles, so it takes the descendant locks up front
 * rather than reaching back down for them with ledger rows already in hand — which is a
 * tasks -> ledger -> tasks acquisition, and closes a cycle against any concurrent claim that shares
 * the subtree's `root:` ledger row.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { probeSpend, settleTurn, type WorkforceBudgets } from './budget.js';
import { delegationChildSpecSchema, insertChildTask } from './create-task.js';
import { TaskNotFoundError, TaskRowCorruptError, TaskVersionConflictError } from './errors.js';
import { appendTaskEvents } from './events.js';
import { deterministicChildTaskId } from './ids.js';
import {
  classificationForIntent,
  invalidIntentPlan,
  MAX_MESSAGE_BODY_CHARS,
  MAX_MESSAGES_PER_TURN,
  planTurnOutcome,
  type TurnPlan,
  turnClassificationSchema,
  turnIntentSchema,
} from './intent-applier.js';
import { joinPolicySchema } from './join.js';
import {
  applyReviewVerdictInTx,
  ReviewAlreadyDecidedError,
  ReviewNotForParkError,
  ReviewTaskStateError,
} from './reviews.js';
import {
  absorbPendingWakes,
  consumePendingCancels,
  deliverSignal,
  escalationTargetsPark,
  isStructuralPark,
  peekPendingCancels,
} from './signals.js';
import { isTaskStatus, isTerminalStatus } from './status.js';
import {
  afterTaskTerminal,
  type DelegationStatus,
  lockDescendants,
  lockRootFirst,
} from './task-locks.js';

// The lock-order helpers, the fan-in, and the delegation-settlement vocabulary moved to
// task-locks.ts (the review verdict path takes the same locks and may not import this module's
// write paths). Re-exported here so the package surface is unchanged.
export {
  afterTaskTerminal,
  DELEGATION_STATUSES,
  type DelegationStatus,
  delegationStatusSchema,
  lockDescendants,
  lockRootFirst,
} from './task-locks.js';

/** The strict shape of the trusted review-policy channel (`ApplyTurnInput.reviewPolicy`). */
export const turnReviewPolicySchema = z.strictObject({
  reviewer: z.string().min(1),
  /** True when the reviewer is a declared employee whose verdict arrives via a dispatched turn. */
  dispatchReviewer: z.boolean(),
  /** The matched rule's own round ceiling; the planner takes the tighter of it and the budgets'. */
  maxRounds: z.number().int().positive(),
});

export type TurnReviewPolicy = z.output<typeof turnReviewPolicySchema>;

// The caps live in the pure planner (the lower module) so the intent schema can enforce the same
// body limit on `request_clarification`; re-exported here so the package surface is unchanged.
export { MAX_MESSAGE_BODY_CHARS, MAX_MESSAGES_PER_TURN } from './intent-applier.js';

/**
 * The strict shape of the trusted message channel (`ApplyTurnInput.messages`) — validated exactly
 * like its siblings (`reviewPolicy`, `createdChildren`) rather than trusted as it arrives. The
 * recipient is checked for shape here; WHICH recipients are declared is the composition's question,
 * and the kernel stays roster-free about it.
 */
export const turnMessagesSchema = z
  .array(
    z.strictObject({
      recipient: z.string().min(1),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
    }),
  )
  .max(MAX_MESSAGES_PER_TURN);

/** The turn's final application refuses a task in a state it cannot explain. */
export class TurnStateError extends Error {
  readonly taskId: string;
  constructor(taskId: string, detail: string) {
    super(
      `turn application for task '${taskId}' found ${detail} and no receipt for this turn — ` +
        'refusing to apply intents over foreign state. Fail-closed.',
    );
    this.name = 'TurnStateError';
    this.taskId = taskId;
  }
}

/**
 * The PLANS whose application touches exactly ONE task row: a transition on the task itself and
 * nothing else. Every other plan reaches a SECOND row — the parent it fans in to
 * (`afterTaskTerminal`), the root it escalates to, the descendants it cascades over — and so must
 * take the root-first locks before its first write. The module header's own rule is that a
 * single-row transition needs no pre-lock; honouring it is what keeps a yield from serializing
 * every other turn in the subtree on the root row.
 *
 * Classified by PLAN, never by intent. An intent-shaped exemption is unsound because the planner
 * REJECTS intents the schema accepts: `{kind:'request_approval', onTimeout:'escalate'}` with no
 * `escalateTo` parses (the field is optional) and plans `invalid_intent`, whose tool-error fate is
 * terminal after a prior offense — and a terminal task fans in to its parent. Reading the intent
 * would hand exactly that turn the fast path and no parent lock. The planner is PURE, so the
 * caller simply asks it what this turn will do before taking any lock, and trusts the answer only
 * for the plans listed here. Kept EXPLICIT rather than inferred, so a new plan kind has to be
 * classified deliberately.
 */
const SINGLE_ROW_PLANS: ReadonlySet<TurnPlan['kind']> = new Set([
  'yield',
  'request_approval',
  'request_review',
  // Still single-row with the stored-result extension: the result columns land on the SAME row
  // the transition moves.
  'review_rounds_exhausted',
  // One transition on the own row plus leaf-table writes (the question's message row, events) that
  // no other path holds while waiting on a task row — no second TASK row is ever reached: no
  // probe, no child, no fan-in (the park is non-terminal), and the `user_reply` wake arrives later
  // through the delivery path. The ledger touch is `settleTurn` only, the same touch `yield`
  // already makes on this fast path, in rank order (own task row, then ledger).
  'request_clarification',
]);

export interface ApplyTurnInput {
  readonly taskId: string;
  /** The dispatched turn's workflow id (journaled on the transition row + events). */
  readonly turnId: string;
  /** The 1-based turn number — the receipt key under the partial UNIQUE. */
  readonly turnNumber: number;
  /** The handler's raw turn-ending intent; validated HERE, never assumed. */
  readonly intent: unknown;
  /**
   * Task-scoped messages the turn asked to append (context, never instructions). A TRUSTED channel
   * like its siblings: strictly validated and capped here (`turnMessagesSchema`), and applied only
   * with an outcome the turn earned — never on the attempt a tool-error requeue will re-run.
   */
  readonly messages?: unknown;
  /**
   * The TRUSTED review-policy match for a completing turn, computed by the dispatching
   * composition from declared rules — never derived from model output (the handler's tool
   * arguments are the model's only input, and this field is not one). Validated strictly here;
   * a malformed channel is a caller bug and a hard typed refusal.
   */
  readonly reviewPolicy?: unknown;
  /**
   * Children the turn BUFFERED for creation (the non-turn-ending create tools) — validated
   * strictly here, applied atomically with the turn's ending intent. Slots 0..k-1 of this turn's
   * deterministic child-id space belong to them; a same-turn fan-out's children continue after.
   */
  readonly createdChildren?: unknown;
  /**
   * The turn's CLASSIFICATION — which way a decision seat moved its task, derived by the
   * dispatching composition from the TYPED collected intent (never from model prose; a refused
   * or absent ending carries none). A TRUSTED channel like `reviewPolicy`: validated strictly
   * against the closed vocabulary here, journaled on `turn_ended`, and a malformed value is a
   * caller bug and a hard typed refusal.
   */
  readonly classification?: unknown;
  readonly budgets: WorkforceBudgets;
  /** The turn's actual cost; settled against the dispatch reservation. */
  readonly actualUsd?: number;
}

export interface ApplyTurnOutcome {
  /** True when the receipt already existed — a recovered re-execution, nothing changed. */
  readonly alreadyApplied: boolean;
  readonly plan: TurnPlan | null;
  readonly task: TaskRecord | null;
}

async function readTask(tx: TenantDb, taskId: string): Promise<TaskRecord> {
  const rows = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.taskId, taskId))) as TaskRecord[];
  const task = rows[0];
  if (!task) throw new TaskNotFoundError(taskId);
  if (!isTaskStatus(task.status)) throw new TaskRowCorruptError(taskId, `status '${task.status}'`);
  return task;
}

/**
 * The claim a turn applies must be the claim that turn TOOK. `#claimTurn` stamps the dispatching
 * workflow's own id on the `queued -> working` transition row, and the latest such row IS the
 * current claim — the same read `#claimTurn` performs before it runs a handler.
 *
 * A mismatch means the row was re-queued and re-claimed under this body's feet: the reaper acts on
 * workflows the engine merely BELIEVES are dead, and a CANCELLED workflow is not a stopped body.
 * Applying this turn's intent over the successor's claim would settle away the successor's
 * reservation and overwrite the state it is building, so it is a typed refusal — not a no-op that
 * would report the turn as landed.
 */
async function assertClaimOwnership(tx: TenantDb, input: ApplyTurnInput): Promise<void> {
  const claimRows = (await tx
    .select(schema.workforceTaskTransitions)
    .where(
      and(
        eq(schema.workforceTaskTransitions.taskId, input.taskId),
        eq(schema.workforceTaskTransitions.toStatus, 'working'),
      ),
    )
    .orderBy(
      desc(schema.workforceTaskTransitions.createdAt),
      desc(schema.workforceTaskTransitions.id),
    )
    .limit(1)) as (typeof schema.workforceTaskTransitions.$inferSelect)[];
  const claimedBy = claimRows[0]?.turnId ?? null;
  if (claimedBy !== input.turnId) {
    throw new TurnStateError(
      input.taskId,
      `a live claim held by turn '${claimedBy ?? '(unstamped)'}' rather than by this turn ` +
        `'${input.turnId}'`,
    );
  }
}

/**
 * Open the ONE review this turn asks for, IDEMPOTENTLY — the durable second layer beneath the
 * receipt.
 *
 * The receipt read at the top of this module is the primary guard and stays that. This is the layer
 * the DATABASE enforces: `workforce_reviews_turn_receipt_idx` is a partial UNIQUE on
 * `(tenant_id, task_id, turn_number)`, so a re-applied turn whose receipt is somehow absent — a
 * repaired or partially restored database; any future refactor that moves this write out of the
 * receipt's transaction — collides here instead of writing a second row. `onConflictDoNothing`
 * makes that collision a NO-OP rather than an error surfacing to the caller, and the replay then
 * CONVERGES on the row the first application wrote: the id it returns is that row's, so the park
 * binding and the journal entry name the review that actually exists.
 *
 * `turn_number` and not `round`: `round` is derived from the rows that already exist
 * (`reviewRoundsUsed + 1`), so a replay computes a different one and would not collide at all.
 */
async function openReview(
  tx: TenantDb,
  taskId: string,
  turnNumber: number,
  reviewer: string,
  round: number,
): Promise<string> {
  const inserted = (await tx
    .insert(schema.workforceReviews, { taskId, reviewer, round, turnNumber })
    .onConflictDoNothing()
    .returning({ id: schema.workforceReviews.id })) as { id: string }[];
  const fresh = inserted[0];
  if (fresh) return fresh.id;
  const existing = (await tx
    .select(schema.workforceReviews, { id: schema.workforceReviews.id })
    .where(
      and(
        eq(schema.workforceReviews.taskId, taskId),
        eq(schema.workforceReviews.turnNumber, turnNumber),
      ),
    )) as { id: string }[];
  const row = existing[0];
  if (!row) {
    // The insert wrote nothing AND no row for this (task, turn) exists — the only conflict target
    // is this turn's own key, so this is unreachable. Fail LOUD rather than return a guessed id.
    throw new TurnStateError(
      taskId,
      `the review for turn ${turnNumber} neither inserted nor exists — refusing to bind a park to a review that is not there`,
    );
  }
  return row.id;
}

/**
 * Open the ONE approval this turn asks for, IDEMPOTENTLY. Same shape and same reasoning as
 * `openReview` above, under `workforce_approvals_turn_receipt_idx`.
 *
 * The sweep's escalation re-issue (approvals.ts) does NOT come through here: it opens a request
 * with no turn at all and writes `turn_number = NULL`, so this key does not dedupe it — its dedupe
 * is the `status = 'pending'` compare-and-swap that claimed the row it escalates. The index's
 * partial predicate declares that intent; it is not what makes those rows legal. NULLs are DISTINCT
 * for uniqueness in Postgres, so a total UNIQUE would admit them too.
 */
async function openApproval(
  tx: TenantDb,
  taskId: string,
  turnNumber: number,
  request: {
    question: string;
    options: readonly string[];
    approver: string;
    timeoutAt: Date;
    onTimeout: string;
    escalateTo: string | null;
  },
): Promise<string> {
  const inserted = (await tx
    .insert(schema.workforceApprovals, {
      taskId,
      question: request.question,
      options: request.options,
      approver: request.approver,
      status: 'pending',
      timeoutAt: request.timeoutAt,
      onTimeout: request.onTimeout,
      escalateTo: request.escalateTo,
      turnNumber,
    })
    .onConflictDoNothing()
    .returning({ id: schema.workforceApprovals.id })) as { id: string }[];
  const fresh = inserted[0];
  if (fresh) return fresh.id;
  const existing = (await tx
    .select(schema.workforceApprovals, { id: schema.workforceApprovals.id })
    .where(
      and(
        eq(schema.workforceApprovals.taskId, taskId),
        eq(schema.workforceApprovals.turnNumber, turnNumber),
      ),
    )) as { id: string }[];
  const row = existing[0];
  if (!row) {
    throw new TurnStateError(
      taskId,
      `the approval for turn ${turnNumber} neither inserted nor exists — refusing to journal an approval that is not there`,
    );
  }
  return row.id;
}

/**
 * Is this task the REVIEW CHILD its parent's park is bound to? Read from the parent's binding —
 * the same row the park lives on, so the fact cannot disagree with the park it describes. A plain
 * read: the parent is parked and moves only by a verdict, and a racing verdict only ever makes the
 * answer stale in the fail-closed direction (see `rejectReviewChildEnding`).
 */
async function readReviewAssignment(
  tx: TenantDb,
  task: TaskRecord,
): Promise<{ reviewId: string } | null> {
  if (task.parentTaskId === null) return null;
  const rows = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.taskId, task.parentTaskId))) as TaskRecord[];
  const parent = rows[0];
  if (parent?.status !== 'waiting_for_review') return null;
  const binding = joinPolicySchema.safeParse(parent.joinPolicy);
  if (!binding.success || binding.data.policy !== 'review') return null;
  if (binding.data.reviewTaskId !== task.taskId || binding.data.reviewId === undefined) return null;
  return { reviewId: binding.data.reviewId };
}

/** Owners along the ancestry — the cycle-rejection input, read from rows, never from promises. */
async function ancestorOwners(tx: TenantDb, task: TaskRecord): Promise<string[]> {
  const ids = Array.isArray(task.ancestryPath) ? (task.ancestryPath as string[]) : [];
  if (ids.length === 0) return [];
  const rows = (await tx
    .select(schema.workforceTasks)
    .where(inArray(schema.workforceTasks.taskId, ids))) as TaskRecord[];
  return rows.map((r) => r.owner);
}

/**
 * Apply one finished turn. See the module header for the protocol; the receipt short-circuit is
 * the FIRST read so a recovered re-execution stays a read-only no-op.
 */
export async function applyTurnOutcome(
  tdb: TenantDb,
  input: ApplyTurnInput,
): Promise<ApplyTurnOutcome> {
  return tdb.transaction(async (tx) => {
    const receipt = await tx
      .select(schema.workforceTaskTransitions, { id: schema.workforceTaskTransitions.id })
      .where(
        and(
          eq(schema.workforceTaskTransitions.taskId, input.taskId),
          eq(schema.workforceTaskTransitions.turnNumber, input.turnNumber),
        ),
      );
    if (receipt.length > 0) return { alreadyApplied: true, plan: null, task: null };

    const snapshot = await readTask(tx, input.taskId);
    if (snapshot.status !== 'working') {
      throw new TurnStateError(input.taskId, `status '${snapshot.status}'`);
    }
    // The row is `working`, but is it working under THIS turn's claim? The reaper re-queues a turn
    // whose workflow the engine merely BELIEVES is dead (a cancelled workflow is not a stopped
    // body), so a stale execution can arrive here over a successor's live claim — and applying its
    // intent would settle away the successor's reservation and overwrite its state. The claim row
    // carries the id that took it; compare, exactly as `#claimTurn` does before it runs a handler.
    await assertClaimOwnership(tx, input);

    // One prior tool_error re-queue means THIS offense is terminal (one retry, then failed).
    const priorReceipt = (await tx
      .select(schema.workforceTaskTransitions)
      .where(
        and(
          eq(schema.workforceTaskTransitions.taskId, input.taskId),
          eq(schema.workforceTaskTransitions.turnNumber, input.turnNumber - 1),
        ),
      )) as (typeof schema.workforceTaskTransitions.$inferSelect)[];
    const priorToolError =
      priorReceipt[0]?.toStatus === 'queued' && priorReceipt[0]?.statusReason === 'tool_error';

    const reviewRows = await tx
      .select(schema.workforceReviews, { id: schema.workforceReviews.id })
      .where(eq(schema.workforceReviews.taskId, input.taskId));
    const delegationRows = await tx
      .select(schema.workforceDelegations, { id: schema.workforceDelegations.id })
      .where(eq(schema.workforceDelegations.parentTaskId, input.taskId));

    // The trusted channel is validated BEFORE it can steer a plan — a malformed value is a caller
    // bug (the composition builds it, never the model) and refuses loudly rather than degrading to
    // "no policy fired".
    const matchedReviewPolicy =
      input.reviewPolicy === undefined ? null : turnReviewPolicySchema.parse(input.reviewPolicy);

    // The buffered creates ride a TRUSTED channel too — validated strictly before they can plan.
    const createdChildren = z.array(delegationChildSpecSchema).parse(input.createdChildren ?? []);
    const messages = turnMessagesSchema.parse(input.messages ?? []);
    // The classification channel steers NOTHING — it is journaled truth about the decision the
    // typed intent already carries — but a malformed value is the same caller bug its siblings
    // refuse, so it validates the same way.
    const classification =
      input.classification === undefined
        ? null
        : turnClassificationSchema.parse(input.classification);

    // Everything the planner needs except the one input that can only be read under a lock. The
    // fields taken from `snapshot` here (owner, ancestry) are immutable for the row's lifetime.
    const parsedIntent = turnIntentSchema.safeParse(input.intent);

    // A cancel_task intent's target facts are PRE-READ from the immutable ancestry — no lock is
    // needed for the membership fact, and the planner refuses a target outside the caller's own
    // subtree before any lock is taken.
    let cancelTarget: { exists: boolean; inCallerSubtree: boolean } | null = null;
    if (parsedIntent.success && parsedIntent.data.kind === 'cancel_task') {
      const targetRows = (await tx
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.taskId, parsedIntent.data.taskId))) as TaskRecord[];
      const target = targetRows[0];
      cancelTarget = {
        exists: target !== undefined,
        inCallerSubtree:
          target !== undefined &&
          Array.isArray(target.ancestryPath) &&
          (target.ancestryPath as string[]).includes(input.taskId),
      };
    }

    // THE APPROVALS A HUMAN ALREADY RESOLVED on this task — the re-request cap's input, counted on
    // the table under this transaction, never on a promise, exactly like the review and delegation
    // pre-reads above.
    //
    // READ ONLY FOR THE INTENT THAT CONSULTS IT, the same way `cancelTarget` is, and for a sharper
    // reason than tidiness: `workforce_approvals` carries no (tenant, task) index — its indexes
    // serve the status inbox and the timeout sweep — so this is the one pre-read here that cannot
    // be answered from a narrow index scan. Gating it keeps that cost off every turn that is not a
    // `request_approval`, which is nearly all of them. Adding an index would be a migration, and
    // the planner treats an empty list identically to no list, so the gate is behaviour-neutral.
    //
    // ONLY the decided statuses. `timed_out`/`escalated` are the timeout chain's own machinery and
    // carry no human answer; counting them would make the engine refuse the very request its own
    // sweep re-issued (approvals.ts, the escalate branch). A scrubbed row (`question IS NULL`,
    // migration 0013) contributes nothing — erasure removes the content, and a cap can only compare
    // content it still has.
    let resolvedApprovalQuestions: string[] = [];
    if (parsedIntent.success && parsedIntent.data.kind === 'request_approval') {
      const rows = (await tx
        .select(schema.workforceApprovals, { question: schema.workforceApprovals.question })
        .where(
          and(
            eq(schema.workforceApprovals.taskId, input.taskId),
            inArray(schema.workforceApprovals.status, ['approved', 'rejected']),
          ),
        )) as { question: string | null }[];
      resolvedApprovalQuestions = rows
        .map((row) => row.question)
        .filter((q): q is string => q !== null);
    }

    const planInput = {
      reviewAssignment: await readReviewAssignment(tx, snapshot),
      taskOwner: snapshot.owner,
      ancestryDepth: Array.isArray(snapshot.ancestryPath) ? snapshot.ancestryPath.length : 0,
      ancestorOwners: await ancestorOwners(tx, snapshot),
      existingDelegationCount: delegationRows.length,
      maxDelegationDepth: input.budgets.delegation?.maxDepth ?? null,
      maxDelegationsPerTask: input.budgets.delegation?.maxPerTask ?? null,
      maxReviewRounds: input.budgets.execution.maxReviewRounds ?? null,
      reviewRoundsUsed: reviewRows.length,
      resolvedApprovalQuestions,
      priorToolError,
      matchedReviewPolicy,
      createdChildren,
      cancelTarget,
    };
    const planFor = (pendingCancel: boolean): TurnPlan =>
      parsedIntent.success
        ? planTurnOutcome({ ...planInput, pendingCancel, intent: parsedIntent.data })
        : invalidIntentPlan(parsedIntent.error.message, priorToolError);

    // THE TASK LOCKS, BEFORE the first write and before any other row type (see the module header).
    // WHICH locks this turn needs is a property of its PLAN, not of the intent it was handed — so
    // the pure planner is asked first, and its answer is trusted only for the plans that provably
    // move one row. The single input the planner still lacks is a pending cancel, which overrides
    // every intent; the cancels are PEEKED here (a read takes no lock) and consumed below, under
    // the locks, so a non-empty peek alone disqualifies the fast path.
    const speculativePlan = planFor(false);
    const singleRow =
      SINGLE_ROW_PLANS.has(speculativePlan.kind) &&
      createdChildren.length === 0 &&
      (await peekPendingCancels(tx, input.taskId)).length === 0;
    const task = singleRow ? snapshot : await lockRootFirst(tx, snapshot);
    if (task.status !== 'working') {
      throw new TurnStateError(input.taskId, `status '${task.status}'`);
    }

    const cancels = singleRow ? [] : await consumePendingCancels(tx, input.taskId);
    // A cancel consumed under the lock is the ONE thing that can change the plan; nothing else the
    // planner reads moves while this turn holds the row.
    const plan: TurnPlan = cancels.length > 0 ? planFor(true) : speculativePlan;

    if (plan.kind === 'cancelled' || plan.kind === 'cancel_task') {
      // The cascade below reaches DOWN into the descendants, and settlement reaches into the
      // LEDGER. The rank is workforce_tasks -> workforce_budget_ledger, so the descendant locks
      // come first: a concurrent claim for a descendant holds that task row and wants the shared
      // `root:` ledger row, and taking the ledger first here closes the cycle on it. The plan is
      // already known, so nothing forces this acquisition to wait for the settlement (the
      // cancel_task cascade stays inside the caller's subtree, which this lock set covers).
      await lockDescendants(tx, task);
    }

    // Settle FIRST: the task-row roll-up takes the task lock (canonical order), then the ledger.
    const actualUsd = input.actualUsd ?? 0;
    const settlement = {
      taskId: task.taskId,
      rootTaskId: task.rootTaskId,
      workforceId: task.workforceId,
      department: task.department,
      estimateUsd: input.budgets.execution.estimateUsdPerTurn,
      actualUsd,
    };
    await settleTurn(tx, input.budgets, settlement);
    await appendTaskEvents(tx, task.taskId, [
      {
        type: 'workforce.budget.settled',
        payload: {
          taskId: task.taskId,
          estimateUsd: settlement.estimateUsd,
          actualUsd,
          turnNumber: input.turnNumber,
        },
      },
    ]);

    const stamp = { actor: task.owner, turnId: input.turnId, turnNumber: input.turnNumber };
    let finalTask: TaskRecord | null = null;

    // THE TURN'S BUFFERED EFFECTS — its created children and its messages — apply with every
    // outcome the turn actually EARNED, and with none that overrode or refused it (a consumed
    // cancel, a rejected hand-off, a malformed ending, a terminal fail). A tool-error requeue
    // re-runs the turn under a NEW turn number, and the receipt keys on (task, turn): anything
    // applied on the failed attempt is therefore applied AGAIN on the retry, with no key to
    // collide on. Children have always been guarded this way; messages had not been, so a turn
    // that malformed its ending sent its notes twice.
    //
    // ONE EXCEPTION, stated rather than papered over: a BUDGET DENIAL inside the branches below
    // overrides the plan after this predicate was computed, so a turn whose creates were denied
    // still applies its messages. That is deliberate — the denial is not a refusal of the TURN
    // (the turn ran and ended legitimately, its receipt is written, and it is not re-run under a
    // new turn number), so its messages are not duplicated by anything. The predicate keys on the
    // PLAN because the plan is what decides whether this turn will be replayed.
    const effectsApply =
      plan.kind !== 'cancelled' &&
      plan.kind !== 'fail' &&
      plan.kind !== 'delegation_rejected' &&
      plan.kind !== 'invalid_intent';
    const createsApply = createdChildren.length > 0 && effectsApply;
    if (createsApply) {
      const probe = await probeSpend(
        tx,
        input.budgets,
        {
          taskId: task.taskId,
          rootTaskId: task.rootTaskId,
          workforceId: task.workforceId,
          department: task.department,
          estimateUsd: createdChildren.length * input.budgets.execution.estimateUsdPerTurn,
        },
        createdChildren.length,
      );
      if (!probe.allowed) {
        finalTask = await applyBudgetExhausted(tx, task, probe.denial, input.budgets, stamp);
      } else {
        for (const [index, specWithTarget] of createdChildren.entries()) {
          const { delegatedTo, ...spec } = specWithTarget;
          const child = await insertChildTask(tx, task, input.turnNumber, index, spec);
          if (child.owner === task.owner) continue; // a self-owned planning child is no hand-off
          const depth = Array.isArray(child.ancestryPath) ? child.ancestryPath.length : 0;
          await tx
            .insert(schema.workforceDelegations, {
              workforceId: task.workforceId,
              parentTaskId: task.taskId,
              childTaskId: child.taskId,
              delegatedBy: task.owner,
              delegatedTo: delegatedTo ?? child.owner,
              resolvedOwner: child.owner,
              goal: child.goal,
              expectedOutput: 'worker_result',
              depth,
              status: 'accepted' satisfies DelegationStatus,
            })
            .onConflictDoNothing();
          await appendTaskEvents(tx, task.taskId, [
            {
              type: 'workforce.delegation.accepted',
              payload: {
                parentTaskId: task.taskId,
                childTaskId: child.taskId,
                delegatedBy: task.owner,
                delegatedTo: delegatedTo ?? child.owner,
                resolvedOwner: child.owner,
                depth,
                goal: child.goal,
              },
            },
          ]);
        }
      }
    }

    // A creates denial above IS the turn's outcome; otherwise the plan decides.
    if (finalTask === null) {
      switch (plan.kind) {
        case 'cancelled': {
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'cancelled',
            reason: 'cancelled_by_user',
            ...stamp,
          });
          await cancelDescendants(tx, finalTask, 'system');
          await afterTaskTerminal(tx, finalTask);
          break;
        }
        case 'complete': {
          await tx
            .update(schema.workforceTasks, {
              result: plan.result,
              confidence: String(plan.result.confidence),
            })
            .where(eq(schema.workforceTasks.taskId, task.taskId));
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'completed',
            ...stamp,
          });
          await afterTaskTerminal(tx, finalTask);
          break;
        }
        case 'fan_out': {
          const probe = await probeSpend(
            tx,
            input.budgets,
            {
              taskId: task.taskId,
              rootTaskId: task.rootTaskId,
              workforceId: task.workforceId,
              department: task.department,
              estimateUsd: plan.children.length * input.budgets.execution.estimateUsdPerTurn,
            },
            plan.children.length,
          );
          if (!probe.allowed) {
            finalTask = await applyBudgetExhausted(tx, task, probe.denial, input.budgets, stamp);
            break;
          }
          const joinChildTaskIds: string[] = [];
          for (const [index, specWithTarget] of plan.children.entries()) {
            // The ORIGINAL target rides the delegation record only — the task row's `owner` IS the
            // resolution, so the target is stripped before the child insert.
            const { delegatedTo, ...spec } = specWithTarget;
            // Buffered creates hold slots 0..k-1 of this turn's child-id space; fan-out children
            // continue after them so the deterministic ids can never collide.
            const child = await insertChildTask(
              tx,
              task,
              input.turnNumber,
              createdChildren.length + index,
              spec,
            );
            joinChildTaskIds.push(child.taskId);
            const depth = Array.isArray(child.ancestryPath) ? child.ancestryPath.length : 0;
            await tx
              .insert(schema.workforceDelegations, {
                workforceId: task.workforceId,
                parentTaskId: task.taskId,
                childTaskId: child.taskId,
                delegatedBy: task.owner,
                delegatedTo: delegatedTo ?? child.owner,
                resolvedOwner: child.owner,
                goal: child.goal,
                expectedOutput: 'worker_result',
                depth,
                status: 'accepted' satisfies DelegationStatus,
              })
              .onConflictDoNothing();
            await appendTaskEvents(tx, task.taskId, [
              {
                type: 'workforce.delegation.accepted',
                payload: {
                  parentTaskId: task.taskId,
                  childTaskId: child.taskId,
                  delegatedBy: task.owner,
                  delegatedTo: delegatedTo ?? child.owner,
                  resolvedOwner: child.owner,
                  depth,
                  goal: child.goal,
                },
              },
            ]);
          }
          // BIND the park to the children THIS fan-out opened. A detached buffered-create child
          // shares the parent but was never part of this round, and must not hold the join open.
          await tx
            .update(schema.workforceTasks, {
              joinPolicy: { ...plan.joinPolicy, childTaskIds: joinChildTaskIds },
            })
            .where(eq(schema.workforceTasks.taskId, task.taskId));
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'blocked',
            reason: 'awaiting_children',
            ...stamp,
          });
          break;
        }
        case 'request_approval': {
          const approvalId = await openApproval(tx, task.taskId, input.turnNumber, {
            question: plan.question,
            options: plan.options,
            approver: plan.approver,
            timeoutAt: new Date(Date.now() + plan.timeoutMs),
            onTimeout: plan.onTimeout,
            escalateTo: plan.escalateTo,
          });
          await appendTaskEvents(tx, task.taskId, [
            {
              type: 'workforce.approval.requested',
              payload: {
                approvalId,
                taskId: task.taskId,
                question: plan.question,
                options: plan.options,
                approver: plan.approver,
                onTimeout: plan.onTimeout,
              },
            },
          ]);
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'waiting_for_user',
            reason: 'approval_pending',
            ...stamp,
          });
          break;
        }
        case 'request_review': {
          const reviewId = await openReview(
            tx,
            task.taskId,
            input.turnNumber,
            plan.reviewer,
            plan.round,
          );
          // A model-initiated review answers to the EXECUTION ceiling alone — no declared policy
          // stands behind it, so the binding carries none and the verdict path uses the budgets'.
          await bindReviewPark(tx, task.taskId, {
            reviewId,
            reviewTaskId: null,
            maxRounds: null,
          });
          await appendTaskEvents(tx, task.taskId, [
            {
              type: 'workforce.review.requested',
              payload: {
                reviewId,
                taskId: task.taskId,
                reviewer: plan.reviewer,
                round: plan.round,
              },
            },
          ]);
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'waiting_for_review',
            reason: 'review_pending',
            ...stamp,
          });
          break;
        }
        case 'request_review_dispatch':
        case 'complete_with_review': {
          // A review WITH a dispatched reviewer turn (and, for the policy-intercepted completion,
          // the stored result). Probe BEFORE any write so a denial leaves a clean row: the reviewer
          // child is a turn to be paid for, exactly like a fan-out child.
          const dispatchReviewer =
            plan.kind === 'request_review_dispatch' ? true : plan.dispatchReviewer;
          if (dispatchReviewer) {
            const probe = await probeSpend(
              tx,
              input.budgets,
              {
                taskId: task.taskId,
                rootTaskId: task.rootTaskId,
                workforceId: task.workforceId,
                department: task.department,
                estimateUsd: input.budgets.execution.estimateUsdPerTurn,
              },
              1,
            );
            if (!probe.allowed) {
              finalTask = await applyBudgetExhausted(tx, task, probe.denial, input.budgets, stamp);
              break;
            }
          }
          if (plan.kind === 'complete_with_review') {
            // Policy intercepted the completion: the RESULT IS STORED (the reviewer reads it off
            // this row) but the task parks for review instead of completing.
            await tx
              .update(schema.workforceTasks, {
                result: plan.result,
                confidence: String(plan.result.confidence),
              })
              .where(eq(schema.workforceTasks.taskId, task.taskId));
          }
          const reviewId = await openReview(
            tx,
            task.taskId,
            input.turnNumber,
            plan.reviewer,
            plan.round,
          );
          let reviewTaskId: string | null = null;
          // The reviewer child skips the delegation depth ceiling DELIBERATELY (like the escalation
          // child): review dispatch cannot recurse, and that is now enforced rather than argued —
          // a task bound as a review child may take NEITHER `complete` NOR `request_review`
          // (`rejectReviewChildEnding`), so a task's review chain sits exactly one level below it.
          if (dispatchReviewer) {
            const child = await insertChildTask(
              tx,
              task,
              input.turnNumber,
              createdChildren.length,
              {
                title: `Review: ${task.title}`.slice(0, 200),
                goal:
                  `Review the submitted result of task ${task.taskId} (round ${plan.round}) and ` +
                  'return a verdict.',
                owner: plan.reviewer,
              },
            );
            reviewTaskId = child.taskId;
          }
          // BIND the park: which review answers it, which task was dispatched to decide it, and the
          // DECLARED policy's own round ceiling. The verdict path takes the tighter of that and the
          // execution ceiling — it is the only way a document the kernel cannot read reaches it.
          await bindReviewPark(tx, task.taskId, {
            reviewId,
            reviewTaskId,
            maxRounds: plan.kind === 'complete_with_review' ? plan.maxRounds : null,
          });
          await appendTaskEvents(tx, task.taskId, [
            {
              type: 'workforce.review.requested',
              payload: {
                reviewId,
                taskId: task.taskId,
                reviewer: plan.reviewer,
                round: plan.round,
                policy: plan.kind === 'complete_with_review',
                reviewTaskId,
              },
            },
          ]);
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'waiting_for_review',
            reason: 'review_pending',
            ...stamp,
          });
          break;
        }
        case 'review_rounds_exhausted': {
          // The round budget is spent; a human decides rather than an accept/rework loop. A result
          // that arrived with the rounds already spent is STORED on the same row — never dropped.
          if (plan.result !== null) {
            await tx
              .update(schema.workforceTasks, {
                result: plan.result,
                confidence: String(plan.result.confidence),
              })
              .where(eq(schema.workforceTasks.taskId, task.taskId));
          }
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'waiting_for_user',
            ...stamp,
          });
          break;
        }
        case 'submit_review': {
          // A reviewer turn's verdict on the task UNDER REVIEW — this task's PARENT. The trusted
          // layer resolved `reviewId` from the pending review row; the kernel still re-checks the
          // linkage fail-closed, on BOTH ends: the review must belong to the parent, AND its named
          // reviewer must be this task's own owner. Without the second check any task under the
          // reviewed parent — a fan-out sibling, a buffered child — could decide a review addressed
          // to someone else. Either mismatch is a tool error, one requeue then failed, exactly like
          // any other malformed turn ending.
          const reviewRows = (await tx
            .select(schema.workforceReviews)
            .where(
              eq(schema.workforceReviews.id, plan.reviewId),
            )) as (typeof schema.workforceReviews.$inferSelect)[];
          const review = reviewRows[0];
          if (
            !review ||
            task.parentTaskId === null ||
            review.taskId !== task.parentTaskId ||
            review.reviewer !== task.owner
          ) {
            finalTask = await applyToolErrorFate(
              tx,
              task,
              priorToolError ? 'fail' : 'requeue',
              stamp,
            );
            break;
          }
          // Apply the verdict through the ONE verdict path (reviews.ts) — same CAS, same round
          // ceiling, same locks (this turn's `lockRootFirst` already holds the parent; re-taking is
          // free). A verdict that lost its race (the human route decided first, or the reviewed task
          // moved) is BENIGN: nothing was written before the refusal, and the reviewer task still
          // completes below with the superseded outcome on record.
          let verdictOutcome: 'applied' | 'superseded' = 'applied';
          try {
            await applyReviewVerdictInTx(tx, input.budgets, {
              reviewId: plan.reviewId,
              verdict: plan.verdict,
              reasons: [...plan.reasons],
              requiredChanges: [...plan.requiredChanges],
              actor: task.owner,
            });
          } catch (err) {
            if (
              err instanceof ReviewAlreadyDecidedError ||
              err instanceof ReviewTaskStateError ||
              // Believed unreachable here: `plan.reviewId` was read from the PARENT's own park
              // binding (`readReviewAssignment`), and this transaction holds the parent lock, so the
              // park cannot name a different review by the time the verdict lands. It joins its two
              // siblings because it is the same story — a verdict this reviewer no longer owns — and
              // a future path that loses that identity should be superseded, not thrown out of a
              // turn that has already written.
              err instanceof ReviewNotForParkError
            ) {
              verdictOutcome = 'superseded';
            } else {
              throw err;
            }
          }
          const reviewerResult = {
            status: 'completed',
            summary:
              verdictOutcome === 'applied'
                ? `review ${plan.verdict} (round ${review.round})`
                : 'verdict superseded — another decision landed first',
            findings: [...plan.reasons],
            recommendations: [...plan.requiredChanges],
            artifacts: [],
            confidence: 1,
            needsFollowUp: false,
          };
          await tx
            .update(schema.workforceTasks, { result: reviewerResult, confidence: '1' })
            .where(eq(schema.workforceTasks.taskId, task.taskId));
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'completed',
            ...stamp,
          });
          await afterTaskTerminal(tx, finalTask);
          break;
        }
        case 'escalate': {
          // A fresh CHILD task carries the escalation to the superior — their own open task, if any,
          // is structurally parked on the join that contains THIS task and may not be woken (the
          // WAKES rule). The caller parks `blocked(escalated)`; the child's terminal fans back as
          // the `escalated` signal that answers exactly that park (`afterTaskTerminal`).
          const probe = await probeSpend(
            tx,
            input.budgets,
            {
              taskId: task.taskId,
              rootTaskId: task.rootTaskId,
              workforceId: task.workforceId,
              department: task.department,
              estimateUsd: input.budgets.execution.estimateUsdPerTurn,
            },
            1,
          );
          if (!probe.allowed) {
            finalTask = await applyBudgetExhausted(tx, task, probe.denial, input.budgets, stamp);
            break;
          }
          const child = await insertChildTask(tx, task, input.turnNumber, createdChildren.length, {
            title: `Escalation: ${task.title}`.slice(0, 200),
            goal:
              `Escalated (${plan.reason}) from task ${task.taskId}: ` +
              `${plan.detail ?? task.goal}`,
            owner: plan.escalateTo,
            department: plan.escalateToDepartment,
          });
          // BIND the park to its child: only THIS child's terminal answers `blocked(escalated)` —
          // a detached buffered-create child (this turn's or an earlier turn's) finishing while
          // the caller waits must not release the park (afterTaskTerminal checks the binding).
          await tx
            .update(schema.workforceTasks, {
              joinPolicy: { policy: 'escalation', escalationTaskId: child.taskId },
            })
            .where(eq(schema.workforceTasks.taskId, task.taskId));
          await appendTaskEvents(tx, task.taskId, [
            {
              type: 'workforce.escalation.raised',
              payload: {
                taskId: task.taskId,
                escalationTaskId: child.taskId,
                escalateTo: plan.escalateTo,
                reason: plan.reason,
                detail: plan.detail,
              },
            },
          ]);
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'blocked',
            reason: 'escalated',
            ...stamp,
          });
          break;
        }
        case 'request_clarification': {
          // The question is a MESSAGE to whoever requested this work — context for their reply,
          // never an instruction — and the park waits for the `user_reply` that answers it
          // (WAKES: user_reply -> blocked(clarification_pending)).
          await tx.insert(schema.workforceMessages, {
            taskId: task.taskId,
            sender: task.owner,
            recipient: task.requestedBy,
            body: plan.question,
          });
          await appendTaskEvents(tx, task.taskId, [
            {
              type: 'workforce.message.sent',
              payload: {
                taskId: task.taskId,
                sender: task.owner,
                recipient: task.requestedBy,
                bodyLength: plan.question.length,
              },
            },
          ]);
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'blocked',
            reason: 'clarification_pending',
            ...stamp,
          });
          break;
        }
        case 'cancel_task': {
          // The caller's whole subtree is already locked (the cancel branch above the settlement
          // took `lockDescendants`), so every row acted on here is re-read UNDER its lock.
          const targetRows = (await tx
            .select(schema.workforceTasks)
            .where(eq(schema.workforceTasks.taskId, plan.targetTaskId))) as TaskRecord[];
          const target = targetRows[0];
          if (target && isTaskStatus(target.status) && !isTerminalStatus(target.status)) {
            if (target.status === 'working') {
              // Never kill a turn mid-flight: the target absorbs the cancel at its own boundary;
              // descendants that are NOT mid-turn cancel now (the cascade's own rule).
              await deliverSignal(tx, {
                taskId: target.taskId,
                kind: 'cancel',
                signalKey: `cancel:${task.taskId}`,
                payload: { origin: task.taskId, detail: plan.detail },
                actor: task.owner,
              });
              await cancelDescendants(tx, target, task.owner);
            } else {
              const done = await applyTransition(tx, {
                taskId: target.taskId,
                expectedVersion: target.version,
                to: 'cancelled',
                reason: 'cancelled_by_user',
                actor: task.owner,
              });
              await cancelDescendants(tx, done, task.owner);
              await afterTaskTerminal(tx, done);
            }
          }
          // The caller keeps orchestrating: back through the one door.
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'queued',
            queueReason: 'turn_yield',
            ...stamp,
          });
          break;
        }
        case 'yield': {
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'queued',
            queueReason: 'turn_yield',
            ...stamp,
          });
          break;
        }
        case 'fail': {
          // PERSIST THE MESSAGE BEFORE THE TRANSITION, and the ordering is the whole point: the
          // terminal `workforce.task.failed` event reads its `resultSummary` off THIS column
          // (apply-transition.ts), so a write afterwards would journal `null` and the operator's
          // only record of WHY would be gone. Until this write existed, `plan.message` was
          // constructed and then referenced by nothing — a failed task carried no reason, no result
          // and no journal text, which is a worse operator surface than the mislabelled
          // `completed` it replaces. (The ordering is not a standing hazard: moving this write
          // below the transition reddens the `resultSummary` assertion in engine.db.test.ts.)
          //
          // THE SUMMARY AND NOTHING ELSE. A first cut also stored `status: 'failed'` here and the
          // state-machine gate refused the file — correctly, and not merely as a regex accident:
          //   - `result` is the column `workerResultSchema` governs, and that schema's status enum
          //     is `['completed','partial']` — so a stored `status: 'failed'` was a value the
          //     column's own contract rejects, and nothing would have caught it, because NOTHING
          //     re-parses a stored result through that schema (its only non-test use is the intent
          //     path in @rayspec/workforce-tools);
          //   - it was a SECOND copy of a fact the status column already owns. `mergeChildResults`
          //     (join.ts) hands a waiting parent `status: child.status` straight off the row, so the
          //     parent already reads `failed` from the authority. Two copies can disagree; one
          //     cannot.
          // Every reader of this column duck-types `'summary' in result` and takes it when it is a
          // string (apply-transition.ts, workforce-tools context.ts + memory.ts), so a summary-only
          // payload satisfies all of them. `confidence` is deliberately absent: a failure has none
          // to report, and inventing one would feed the review-policy predicates a number nobody
          // stated.
          //
          // AND IT IS BOUNDED HERE, because this arm is shared with machine producers that the
          // model-facing cap does not reach. `report_failure` caps `message` at
          // MAX_MESSAGE_BODY_CHARS at the tool door, but FIVE other sites build a `fail` intent
          // directly — three in the composition (@rayspec/server workforce-turn-handlers.ts) and
          // two in the scheduler (@rayspec/durable-dbos task-scheduler.ts) — and one of them
          // interpolates a raw `err.message` from ANY throw inside a turn handler. A ZodError's
          // message alone is its whole formatted issue list. Before this write existed the string
          // was discarded, so its length cost nothing; now it lands in a jsonb column and a journal
          // row, and an unbounded write is not something to introduce by accident.
          //
          // The cap lives HERE and still NOT on `turnIntentSchema`'s `fail` arm: capping the intent
          // would turn a long diagnostic into a MALFORMED intent and lose the failure entirely,
          // which is the opposite of the goal. Refuse nothing; store boundedly. The marker is
          // deliberate — a silently truncated diagnostic is worse than one that says it was cut,
          // and it names the full length so a reader knows how much is missing.
          //
          // NEVER END ON A SPLIT ASTRAL PAIR. `slice` cuts UTF-16 CODE UNITS, so a cut landing
          // between the halves of an astral pair leaves a lone high surrogate — and this column is
          // `jsonb`, so unlike the other truncation sites that is not mangled text, it is a write
          // PostgreSQL refuses outright (`22P02`, "Unicode low surrogate must follow a high
          // surrogate"). That throw is inside this transaction: the `working -> failed` transition,
          // the journal and the settlement all roll back, the row stays `working` under its claim,
          // the reaper re-queues it and the same deterministic error recurs — a task that never
          // settles, which is a worse outcome than the mislabelled `completed` this whole item
          // exists to remove. The trigger is precisely the producer above, since model-authored text
          // embedded in a ZodError carries emoji routinely.
          //
          // A DELIBERATELY TEMPORARY LOCAL COPY — extraction is K-003, and this comment is the
          // cross-reference that a fourth silent copy would not have had.
          //
          // There are FOUR truncation sites in this tree. Two carry the guard already:
          // @rayspec/workforce-tools memory.ts (`clampText`) and context.ts (`truncateToBytes`),
          // which cross-reference each other. Two did not: this one, and task-locks.ts's 500-unit
          // escalation-summary slice — which has since been DRIVEN and reproduces the same `22P02`
          // on the completion path. That one is pre-existing, reachable on the main line today, and
          // NOT this item's to fix (K-003 owns it, and owns pulling all four onto one predicate).
          //
          // Why this is a copy rather than an import, checked rather than assumed:
          // `clampText` is NOT importable from here. The blocker is not
          // `gate:delegation-dispatch-boundary` — that gate constrains the TOOLSET layer's OUTBOUND
          // imports and says nothing about this direction. It is the dependency graph:
          // workforce-tools declares `@rayspec/tasks` and this package does not declare
          // workforce-tools, so importing it would create a package cycle.
          //
          // Where the shared predicate SHOULD live, for K-003 to act on: `@rayspec/core`. Both
          // packages already depend on it (no new edge, no cycle), task-locks.ts is in this package
          // so it is covered too, and the dispatch-boundary gate names `@rayspec/core` among the
          // specifiers the toolset may import — so a pure string helper there is reachable by all
          // four sites and boundary-legal. Deliberately NOT created here: that extraction deserves
          // its own review, not a drive-by inside a failure-channel PR.
          //
          // Dropping one unit only shortens the result, so the stated ceiling of
          // MAX_MESSAGE_BODY_CHARS + MAX_TRUNCATION_MARKER_CHARS is unaffected.
          let head = plan.message.slice(0, MAX_MESSAGE_BODY_CHARS);
          if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
          const summary =
            plan.message.length > MAX_MESSAGE_BODY_CHARS
              ? `${head}${truncationMarker(plan.message.length)}`
              : plan.message;
          await tx
            .update(schema.workforceTasks, { result: { summary } })
            .where(eq(schema.workforceTasks.taskId, task.taskId));
          finalTask = await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'failed',
            ...stamp,
          });
          await afterTaskTerminal(tx, finalTask);
          break;
        }
        case 'delegation_rejected': {
          // Record the refusal on the delegation table (the child ids are deterministic, so the
          // rejected rows are idempotent under re-execution too), then apply the tool-error fate.
          const intent = parsedIntent.success ? parsedIntent.data : null;
          if (intent?.kind === 'fan_out') {
            for (const [index, spec] of intent.children.entries()) {
              const childTaskId = deterministicChildTaskId(
                tx.tenantId,
                task.taskId,
                input.turnNumber,
                index,
              );
              await tx
                .insert(schema.workforceDelegations, {
                  workforceId: task.workforceId,
                  parentTaskId: task.taskId,
                  childTaskId,
                  delegatedBy: task.owner,
                  delegatedTo: spec.delegatedTo ?? spec.owner,
                  resolvedOwner: spec.owner,
                  goal: spec.goal,
                  expectedOutput: 'worker_result',
                  depth: (Array.isArray(task.ancestryPath) ? task.ancestryPath.length : 0) + 1,
                  status: 'rejected' satisfies DelegationStatus,
                  rejectionReason: plan.reason,
                })
                .onConflictDoNothing();
              await appendTaskEvents(tx, task.taskId, [
                {
                  type: 'workforce.delegation.rejected',
                  payload: {
                    parentTaskId: task.taskId,
                    childTaskId,
                    delegatedBy: task.owner,
                    delegatedTo: spec.delegatedTo ?? spec.owner,
                    resolvedOwner: spec.owner,
                    reason: plan.reason,
                    detail: plan.detail,
                  },
                },
              ]);
            }
          }
          finalTask = await applyToolErrorFate(tx, task, plan.fate, stamp);
          break;
        }
        case 'invalid_intent': {
          finalTask = await applyToolErrorFate(tx, task, plan.fate, stamp);
          break;
        }
      }
    }

    if (effectsApply) {
      for (const message of messages) {
        await tx.insert(schema.workforceMessages, {
          taskId: task.taskId,
          sender: task.owner,
          recipient: message.recipient,
          body: message.body,
        });
        // The journal carries WHO wrote to WHOM and HOW MUCH — never the body: a message is
        // untrusted data addressed to a later turn's context, not operator UX.
        await appendTaskEvents(tx, task.taskId, [
          {
            type: 'workforce.message.sent',
            payload: {
              taskId: task.taskId,
              sender: task.owner,
              recipient: message.recipient,
              bodyLength: message.body.length,
            },
          },
        ]);
      }
    }

    // The narrow post-turn absorption (signals.ts): a wake that arrived mid-turn and answers the
    // park this turn just applied re-queues the task NOW instead of stranding it.
    if (finalTask && finalTask.status === 'blocked') {
      const absorbed = await absorbPendingWakes(tx, finalTask);
      if (absorbed) finalTask = await readTask(tx, task.taskId);
    }

    // The classification journals ONLY where the decision it names actually stood: never beside
    // a refused ending (`invalid_intent` — the caller's channel said 'delegate' about an intent
    // this transaction rejected), never beside an outcome that refused or overrode the decision
    // itself (`delegation_rejected`, a consumed `cancel`). `complete_with_review` keeps it — the
    // decision stood and policy ADDED review, and the journal deliberately records both facts.
    //
    // AND it must NAME the intent it rode with: the engine RE-DERIVES the classification from the
    // typed intent it actually applied (`classificationForIntent`, the same map the composition's
    // deriver uses) and suppresses a caller-supplied value that disagrees — so an embedded caller
    // cannot journal `escalate` beside an accepted `complete`. Whether the caller derived correctly
    // is not trusted; the presence AND the value are the engine's to own, so no caller can journal a
    // decision that never existed. (The caller still gates non-decision seats to null.)
    const derivedClassification = parsedIntent.success
      ? classificationForIntent(parsedIntent.data)
      : null;
    const journaledClassification =
      classification !== null &&
      classification === derivedClassification &&
      parsedIntent.success &&
      plan.kind !== 'invalid_intent' &&
      plan.kind !== 'delegation_rejected' &&
      plan.kind !== 'cancelled'
        ? classification
        : null;
    await appendTaskEvents(tx, task.taskId, [
      {
        type: 'workforce.task.turn_ended',
        payload: {
          taskId: task.taskId,
          turnId: input.turnId,
          turnNumber: input.turnNumber,
          outcome: plan.kind,
          costUsd: actualUsd,
          // Present on decision-seat turns whose typed intent was accepted and applied as that
          // decision; absent elsewhere — the vocabulary's own presence rule.
          ...(journaledClassification !== null ? { classification: journaledClassification } : {}),
        },
      },
    ]);
    return { alreadyApplied: false, plan, task: finalTask };
  });
}

/**
 * BIND a `waiting_for_review` park to the review it waits on, on the same row the park lives on
 * (`joinPolicy`, the park-binding column — see join.ts). Three facts nothing else can supply later:
 * WHICH review answers the park, WHICH task was dispatched to decide it (null when a human does),
 * and the DECLARED policy's round ceiling — a ceiling that lives in a document the kernel is
 * deliberately roster-free about, and which the verdict path would otherwise never see.
 */
async function bindReviewPark(
  tx: TenantDb,
  taskId: string,
  binding: { reviewId: string; reviewTaskId: string | null; maxRounds: number | null },
): Promise<void> {
  await tx
    .update(schema.workforceTasks, {
      joinPolicy: {
        policy: 'review',
        reviewId: binding.reviewId,
        reviewTaskId: binding.reviewTaskId,
        ...(binding.maxRounds !== null ? { maxRounds: binding.maxRounds } : {}),
      },
    })
    .where(eq(schema.workforceTasks.taskId, taskId));
}

type Stamp = { actor: string; turnId: string; turnNumber: number };

/**
 * The suffix a truncated failure summary carries, naming the ORIGINAL length so a reader can see
 * how much was cut. Exported so the bound can be asserted without re-spelling the string in a test.
 *
 * The stored summary is therefore at most `MAX_MESSAGE_BODY_CHARS + MAX_TRUNCATION_MARKER_CHARS`
 * characters. A model-authored failure never reaches this: `report_failure` caps `message` at
 * MAX_MESSAGE_BODY_CHARS at the tool door, so the branch is dead on that path and live only for the
 * machine producers of a `fail` intent.
 */
export function truncationMarker(originalLength: number): string {
  return `… [truncated — full diagnostic was ${originalLength} characters]`;
}

/**
 * The marker's own ceiling. `Number.MAX_SAFE_INTEGER` is 16 digits, which is a hard bound on the
 * interpolated length for any string JavaScript can hold, so this constant is a fact about the
 * template rather than a guess.
 */
export const MAX_TRUNCATION_MARKER_CHARS = truncationMarker(Number.MAX_SAFE_INTEGER).length;

/** One retry re-queue, then failed — both with the typed `tool_error` reason. */
async function applyToolErrorFate(
  tx: TenantDb,
  task: TaskRecord,
  fate: 'requeue' | 'fail',
  stamp: Stamp,
): Promise<TaskRecord> {
  const finalTask = await applyTransition(tx, {
    taskId: task.taskId,
    expectedVersion: task.version,
    to: fate === 'requeue' ? 'queued' : 'failed',
    reason: 'tool_error',
    ...(fate === 'requeue' ? { queueReason: 'tool_error' } : {}),
    ...stamp,
  });
  if (fate === 'fail') await afterTaskTerminal(tx, finalTask);
  return finalTask;
}

/**
 * A denied dispatch/fan-out blocks with the typed reason, journals the exceedance, and applies the
 * declared exhaustion policy (`block_and_escalate` additionally parks the ROOT for a human, with a
 * payload naming what would unblock it).
 *
 * PRECONDITION: the caller holds this task's root-first locks (`lockRootFirst`) before calling.
 * The escalation writes a SECOND task row — the root — so the lock order is the caller's to
 * establish; taking it here instead would make the acquisition order depend on which branch runs.
 *
 * The escalation is REASON-MATCHED (`escalationTargetsPark`, signals.ts). A root parked on a
 * mechanism — a fan-out join, a dependency, a pending review or approval — is NOT moved: the
 * transition would erase the very exit that park is waiting for, and the mechanism would then have
 * nowhere to land (the fan-in bails and never writes the join signal at all). Such an escalation is
 * DEFERRED and journaled, never dropped silently.
 *
 * What a deferral is worth depends on the park, and the two cases are NOT the same:
 *
 *   - `awaiting_dependency`, `review_pending`, `approval_pending`, `clarification_pending` — the
 *     mechanism runs independently of this denial, so the root does resume, does re-authorize, and
 *     an unchanged ceiling denies it again; at that point the root itself sits in
 *     `blocked(budget_exhausted)`, a park the escalation may target, and it surfaces there. Nothing
 *     is lost.
 *   - the STRUCTURAL parks (`awaiting_children`, `escalated`) — the deferral does NOT surface by
 *     itself whenever the denied task is the very child the park waits on, and saying otherwise
 *     would be circular: that child cannot terminate, so the join cannot close (or the escalation
 *     cannot be answered), the root never redispatches, and every exit from the child (raise the
 *     ceiling and signal `budget_raised`, or cancel it) is precisely the operator action the
 *     escalation existed to summon. The journal entry is the whole notification in that case, and
 *     it says so. Still strictly better than the alternative it replaced — dissolving the park and
 *     orphaning the child — but a durable deferral that can wake a structural park is a real design
 *     task, tracked as a follow-up rather than pretended away here.
 */
export async function applyBudgetExhausted(
  tx: TenantDb,
  task: TaskRecord,
  denial: { scopeKind: string; scopeId: string; ceiling: unknown; consumed: number },
  budgets: WorkforceBudgets,
  stamp: Stamp | { actor: string },
): Promise<TaskRecord> {
  const blocked = await applyTransition(tx, {
    taskId: task.taskId,
    expectedVersion: task.version,
    to: 'blocked',
    reason: 'budget_exhausted',
    ...stamp,
  });
  await appendTaskEvents(tx, task.taskId, [
    {
      type: 'workforce.budget.exceeded',
      payload: {
        taskId: task.taskId,
        scopeKind: denial.scopeKind,
        scopeId: denial.scopeId,
        ceiling: denial.ceiling,
        consumed: denial.consumed,
        onBudgetExhausted: budgets.execution.onBudgetExhausted,
      },
    },
  ]);
  if (budgets.execution.onBudgetExhausted !== 'block_and_escalate') return blocked;

  const rootId = task.rootTaskId;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Re-read every attempt, this task included: the transition above moved it, and a retry that
    // presented the pre-transition version could never win the compare-and-swap.
    const root = await readTask(tx, rootId);
    if (!escalationTargetsPark(root.status, root.statusReason)) {
      // A root that has already ended needs no human and will never dispatch again — there is
      // nothing to escalate and nothing a deferral could later surface, so it is not journaled as
      // one.
      if (isTaskStatus(root.status) && isTerminalStatus(root.status)) break;
      await appendTaskEvents(tx, root.taskId, [
        {
          type: 'workforce.budget.escalation_deferred',
          payload: {
            taskId: root.taskId,
            escalatedFrom: task.taskId,
            scopeKind: denial.scopeKind,
            scopeId: denial.scopeId,
            park: { status: root.status, statusReason: root.statusReason },
            // The STRUCTURAL parks are the ones that do NOT re-surface on their own: each waits on
            // a child's terminal, and a denied child cannot terminate — so the join never closes
            // (or the escalation is never answered) and the root never redispatches. The event says
            // which case this is rather than promising a wake that will not come.
            surfacesWhen: isStructuralPark(root.statusReason)
              ? 'not automatically — the park waits on a child terminal that a blocked child ' +
                'cannot reach; raise the ceiling and send budget_raised to the blocked child, or ' +
                'cancel it'
              : 'the park is released by its own mechanism and the next dispatch is denied again',
          },
        },
      ]);
      break;
    }
    try {
      const escalated = await applyTransition(tx, {
        taskId: root.taskId,
        expectedVersion: root.version,
        to: 'waiting_for_user',
        actor: 'system',
      });
      await appendTaskEvents(tx, root.taskId, [
        {
          type: 'workforce.budget.exceeded',
          payload: {
            taskId: root.taskId,
            escalatedFrom: task.taskId,
            scopeKind: denial.scopeKind,
            scopeId: denial.scopeId,
            unblock: 'raise the ceiling and send a budget_raised signal',
          },
        },
      ]);
      // When the escalated root IS this task, the escalation moved the row the caller is about to
      // act on — hand back what the row became, never the pre-escalation snapshot.
      return rootId === task.taskId ? escalated : blocked;
    } catch (err) {
      // ONLY a lost version race retries; anything else is a real defect and must stay loud.
      if (!(err instanceof TaskVersionConflictError)) throw err;
    }
  }
  return rootId === task.taskId ? await readTask(tx, task.taskId) : blocked;
}

/**
 * Cancel every non-terminal descendant, root-first; working ones absorb a cancel signal.
 *
 * Every row this will act on is locked FIRST (`lockDescendants`). The act-on decision is then made
 * from the LOCKED row, never from the snapshot: a descendant that ended its turn between the two
 * reads is cancelled rather than signalled into a task that will never run again.
 */
export async function cancelDescendants(
  tx: TenantDb,
  origin: TaskRecord,
  actor: string,
): Promise<{ cancelled: string[]; signalled: string[] }> {
  const locked = await lockDescendants(tx, origin);
  const cancelled: string[] = [];
  const signalled: string[] = [];
  for (const desc of locked) {
    if (!isTaskStatus(desc.status) || isTerminalStatus(desc.status)) continue;
    if (desc.status === 'working') {
      // Never kill a turn mid-flight: the cancel is absorbed at the turn's own boundary.
      await deliverSignal(tx, {
        taskId: desc.taskId,
        kind: 'cancel',
        signalKey: `cancel:${origin.taskId}`,
        payload: { origin: origin.taskId },
        actor,
      });
      signalled.push(desc.taskId);
      continue;
    }
    const done = await applyTransition(tx, {
      taskId: desc.taskId,
      expectedVersion: desc.version,
      to: 'cancelled',
      reason: 'cancelled_by_parent',
      actor,
    });
    await tx
      .update(schema.workforceDelegations, {
        status: 'cancelled' satisfies DelegationStatus,
        completedAt: new Date(),
      })
      .where(eq(schema.workforceDelegations.childTaskId, done.taskId));
    cancelled.push(desc.taskId);
  }
  return { cancelled, signalled };
}
