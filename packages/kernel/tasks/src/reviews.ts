/**
 * Review verdict application — the engine applies verdicts, never prose. `accept` completes the
 * task; `reject` re-queues it for rework UNTIL the round ceiling is spent, at which point the task
 * parks in `waiting_for_user` — a human decides, rather than an infinite accept/rework loop. The
 * per-review compare-and-swap (`verdict IS NULL`) admits exactly one verdict per round.
 *
 * LOCK ORDER: every verdict takes THE TASK LOCK ORDER (apply-intents.ts module header — the
 * reviewed task's ancestors root-first, then the task) BEFORE the review-row compare-and-swap.
 * A verdict is never a single-row operation: the CAS touches the review row, `appendTaskEvents`
 * UPDATEs the task row's event counter, and the accept path fans in to the parent — so the task
 * half of the order is taken first on EVERY path, and any other verdict writer must do the same
 * (a caller that CASed the review row first while a turn held the task locks would be a
 * reviews → tasks acquisition against the turn's tasks → reviews, i.e. a deadlock by design).
 * `applyReviewVerdictInTx` is the in-transaction entry for callers that already hold the task
 * locks (a turn's final application); `applyReviewVerdict` wraps it in its own transaction for
 * the HTTP verdict route.
 *
 * THE ROW'S `reviewer` BINDS ITS DECIDER (decision-authority.ts), exactly as an approval's
 * `approver` does — the verdict event journals `reviewer` beside `decidedBy`, and a door that let
 * the two disagree would be writing an accountability claim it does not keep. `'user'` stays the
 * open sentinel (a policy that falls back to the human decides through any permitted principal);
 * a NAMED reviewer must be the actor, or an authorized break-glass override must say so — and the
 * journal then records it (`overriddenReviewer`). The dispatched-reviewer turn already satisfies
 * this: apply-intents.ts refuses a `submit_review` whose `review.reviewer !== task.owner` and then
 * passes that same owner as the actor.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import type { WorkforceBudgets } from './budget.js';
import { mayDecide } from './decision-authority.js';
import { TaskNotFoundError } from './errors.js';
import { appendTaskEvents } from './events.js';
import { joinPolicySchema } from './join.js';
import { afterTaskTerminal, lockRootFirst } from './task-locks.js';

export type ReviewRecord = typeof schema.workforceReviews.$inferSelect;

export class ReviewNotFoundError extends Error {
  readonly reviewId: string;
  constructor(reviewId: string) {
    super(`review '${reviewId}' not found for this tenant. Fail-closed.`);
    this.name = 'ReviewNotFoundError';
    this.reviewId = reviewId;
  }
}

export class ReviewAlreadyDecidedError extends Error {
  readonly reviewId: string;
  constructor(reviewId: string) {
    super(`review '${reviewId}' already carries a verdict — one verdict per round. Fail-closed.`);
    this.name = 'ReviewAlreadyDecidedError';
    this.reviewId = reviewId;
  }
}

export class ReviewTaskStateError extends Error {
  readonly reviewId: string;
  constructor(reviewId: string, status: string) {
    super(
      `review '${reviewId}' targets a task in '${status}' — a verdict applies only to a task ` +
        'parked in waiting_for_review. Fail-closed.',
    );
    this.name = 'ReviewTaskStateError';
    this.reviewId = reviewId;
  }
}

/**
 * The effective round ceiling for a reviewed task: the tighter of the DECLARED policy's `maxRounds`
 * (carried on the review park's binding, written when the park was opened) and the execution-wide
 * ceiling. Either may be absent; absent on both sides means unbounded rounds, which is what an
 * undeclared ceiling has always meant.
 */
function tighterRoundCeiling(task: TaskRecord, executionMax: number | null): number | null {
  const binding = joinPolicySchema.safeParse(task.joinPolicy);
  const policyMax =
    binding.success && binding.data.policy === 'review' ? (binding.data.maxRounds ?? null) : null;
  if (policyMax === null) return executionMax;
  return executionMax === null ? policyMax : Math.min(policyMax, executionMax);
}

/**
 * A verdict may only be applied to the park that NAMES its review. Fail-closed on the binding
 * rather than on the row: an undecided review row is no longer proof that its park is open.
 */
function assertReviewMatchesPark(task: TaskRecord, reviewId: string): void {
  const binding = joinPolicySchema.safeParse(task.joinPolicy);
  if (!binding.success || binding.data.policy !== 'review') return;
  // Believed unreachable: every review park this engine opens is written by `bindReviewPark`,
  // which always names its review. A review park that names none can certify nothing, and a
  // fail-open default inside a fail-closed check is the seam, not the odds.
  if (binding.data.reviewId === undefined) throw new ReviewNotForParkError(reviewId, null);
  if (binding.data.reviewId !== reviewId) {
    throw new ReviewNotForParkError(reviewId, binding.data.reviewId);
  }
}

/** A verdict aimed at a park that is waiting on a different review — refused, never applied. */
export class ReviewNotForParkError extends Error {
  readonly reviewId: string;
  /** The review the park names, or null when the park names none at all. */
  readonly parkReviewId: string | null;
  constructor(reviewId: string, parkReviewId: string | null) {
    super(
      parkReviewId === null
        ? `review '${reviewId}' was aimed at a review park that names no review — a park that ` +
            'cannot say which review it waits on cannot certify that this is it. Fail-closed.'
        : `review '${reviewId}' is not the review this task's park is waiting on ` +
            `('${parkReviewId}') — a verdict applies only to the review its own park names, or it ` +
            'would release a park that review never opened and spend the wrong round. Fail-closed.',
    );
    this.name = 'ReviewNotForParkError';
    this.reviewId = reviewId;
    this.parkReviewId = parkReviewId;
  }
}

/**
 * A verdict on a review this task NAMED someone else to give. The row's `reviewer` rides into the
 * `workforce.review.decided` event beside `decidedBy`; letting the two disagree silently would
 * make the journal's own two fields contradict each other.
 */
export class ReviewReviewerMismatchError extends Error {
  readonly reviewId: string;
  /** Who the row names. */
  readonly reviewer: string;
  /** Who tried. */
  readonly actor: string;
  constructor(reviewId: string, reviewer: string, actor: string) {
    super(
      `review '${reviewId}' names '${reviewer}' as its reviewer — '${actor}' is not that ` +
        'principal, and the verdict event journals that name beside the decider. Decide it as the ' +
        'named reviewer, or break the glass with the override permission (the journal records the ' +
        'override). Fail-closed.',
    );
    this.name = 'ReviewReviewerMismatchError';
    this.reviewId = reviewId;
    this.reviewer = reviewer;
    this.actor = actor;
  }
}

export const reviewVerdictSchema = z.strictObject({
  verdict: z.enum(['accept', 'reject']),
  reasons: z.array(z.string().min(1)).default([]),
  requiredChanges: z.array(z.string().min(1)).default([]),
  /**
   * BREAK-GLASS INTENT — never break-glass AUTHORITY. See `approvalDecisionSchema.override`: a door
   * that admits this ANDs it with a server-side permission check before setting
   * `overrideNamedReviewer`.
   */
  override: z.boolean().default(false),
});

export type ReviewVerdictInput = Omit<z.output<typeof reviewVerdictSchema>, 'override'> & {
  readonly reviewId: string;
  readonly actor: string;
  /**
   * The caller has VERIFIED that this principal may override a named reviewer. Set only where a
   * request both asked for the override and passed the permission gate; it lands in the journal as
   * `overriddenReviewer`.
   */
  readonly overrideNamedReviewer?: boolean;
};

/**
 * Apply one verdict INSIDE an already-open transaction. Protocol, in lock-rank order:
 *
 *   1. Plain-read the review row — an unknown id, an already-decided review, or an actor the row
 *      did not name (absent an authorized override) is a typed refusal before any lock is taken,
 *      and before anything at all is written.
 *   2. Take THE TASK LOCK ORDER on the reviewed task (`lockRootFirst`) — before the review-row
 *      CAS and before any write, the module-header rule.
 *   3. Re-check the park under the lock. A task no longer in `waiting_for_review` means a racer's
 *      verdict landed while we waited: re-read the review and report the truer error
 *      (already-decided when the racer decided THIS review; the state refusal otherwise).
 *   4. NOW the compare-and-swap on `verdict IS NULL` — one verdict per round; a lost CAS after the
 *      locks is the same racer story and reports already-decided.
 *   5. Outcome, audit event, transition (+ fan-in on accept) — all under the held locks.
 */
export async function applyReviewVerdictInTx(
  tx: TenantDb,
  budgets: WorkforceBudgets,
  input: ReviewVerdictInput,
): Promise<TaskRecord> {
  const reviewRows = (await tx
    .select(schema.workforceReviews)
    .where(eq(schema.workforceReviews.id, input.reviewId))) as ReviewRecord[];
  const pending = reviewRows[0];
  if (!pending) throw new ReviewNotFoundError(input.reviewId);
  if (pending.verdict !== null) throw new ReviewAlreadyDecidedError(input.reviewId);
  // WHO THE ROW NAMES. `reviewer` is written once when the review is opened and never updated, so
  // this plain read is authoritative; the `verdict IS NULL` CAS below remains the race arbiter.
  const overrode = !mayDecide(pending.reviewer, input.actor);
  if (overrode && input.overrideNamedReviewer !== true) {
    throw new ReviewReviewerMismatchError(input.reviewId, pending.reviewer, input.actor);
  }

  const taskRows = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.taskId, pending.taskId))) as TaskRecord[];
  const snapshot = taskRows[0];
  if (!snapshot) throw new TaskNotFoundError(pending.taskId);

  const task = await lockRootFirst(tx, snapshot);
  // THE PARK'S OWN BINDING decides which review may be applied to it. A park names exactly one
  // review, and deciding a DIFFERENT one against it takes the wrong round's ceiling and releases a
  // park that review never opened. That became reachable when an abandoned review started leaving
  // its row undecided: the stale row lists first in the operator inbox (undecided, oldest first),
  // and deciding it would have dissolved the LIVE review's park under the stale review's round,
  // orphaning the live reviewer whose verdict then lands as "superseded".
  assertReviewMatchesPark(task, input.reviewId);
  if (task.status !== 'waiting_for_review') {
    // A racer moved the task while we waited on the locks. If it decided THIS review, the truer
    // refusal is already-decided; otherwise the park is genuinely gone.
    const raced = (await tx
      .select(schema.workforceReviews)
      .where(eq(schema.workforceReviews.id, input.reviewId))) as ReviewRecord[];
    if (raced[0]?.verdict !== null) throw new ReviewAlreadyDecidedError(input.reviewId);
    throw new ReviewTaskStateError(input.reviewId, task.status);
  }

  const updated = (await tx
    .update(schema.workforceReviews, {
      verdict: input.verdict,
      reasons: input.reasons,
      requiredChanges: input.requiredChanges,
      decidedAt: new Date(),
    })
    .where(
      and(eq(schema.workforceReviews.id, input.reviewId), isNull(schema.workforceReviews.verdict)),
    )
    .returning()) as ReviewRecord[];
  const review = updated[0];
  if (!review) throw new ReviewAlreadyDecidedError(input.reviewId);

  // THE TIGHTER OF THE TWO ceilings, exactly as the planner computed it when the park was opened:
  // the DECLARED policy's own `maxRounds` (recorded on the park's binding — a policy lives in a
  // document this module is deliberately roster-free about, so the binding is the only way it
  // arrives here) and the execution-wide ceiling. Reading only the budgets' half made a policy
  // `maxRounds: 1` with no execution ceiling yield `rework` forever on the verdict path.
  const maxRounds = tighterRoundCeiling(task, budgets.execution.maxReviewRounds ?? null);
  const outcome =
    input.verdict === 'accept'
      ? 'completed'
      : maxRounds !== null && review.round >= maxRounds
        ? 'rounds_exhausted'
        : 'rework';
  // The verdict is an AUDIT fact: who decided what, in which round, and what the engine did about
  // it. The generic transition alone says the task moved, never that a reviewer moved it.
  await appendTaskEvents(tx, task.taskId, [
    {
      type: 'workforce.review.decided',
      payload: {
        reviewId: review.id,
        taskId: task.taskId,
        reviewer: review.reviewer,
        round: review.round,
        verdict: input.verdict,
        decidedBy: input.actor,
        reasons: input.reasons,
        requiredChanges: input.requiredChanges,
        outcome,
        // PRESENT ONLY ON A BREAK-GLASS VERDICT — the one case where `decidedBy` does not answer
        // to `reviewer`, said out loud rather than left for a reader to notice.
        ...(overrode ? { overriddenReviewer: review.reviewer } : {}),
      },
    },
  ]);
  if (outcome === 'completed') {
    const done = await applyTransition(tx, {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'completed',
      actor: input.actor,
    });
    await afterTaskTerminal(tx, done);
    return done;
  }
  if (outcome === 'rounds_exhausted') {
    // The round budget is spent — a human decides instead of another rework loop.
    return applyTransition(tx, {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'waiting_for_user',
      actor: input.actor,
    });
  }
  // Rework: back through the one door into execution. The transition's own queued event carries
  // the `review_verdict` queue reason; the verdict details live on the review row.
  return applyTransition(tx, {
    taskId: task.taskId,
    expectedVersion: task.version,
    to: 'queued',
    queueReason: 'review_verdict',
    actor: input.actor,
  });
}

/** The route-facing entry: one verdict in its own transaction. */
export async function applyReviewVerdict(
  tdb: TenantDb,
  budgets: WorkforceBudgets,
  input: ReviewVerdictInput,
): Promise<TaskRecord> {
  return tdb.transaction(async (tx) => applyReviewVerdictInTx(tx, budgets, input));
}
