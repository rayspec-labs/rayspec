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
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { afterTaskTerminal, lockRootFirst } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import type { WorkforceBudgets } from './budget.js';
import { TaskNotFoundError } from './errors.js';
import { appendTaskEvents } from './events.js';

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

export const reviewVerdictSchema = z.strictObject({
  verdict: z.enum(['accept', 'reject']),
  reasons: z.array(z.string().min(1)).default([]),
  requiredChanges: z.array(z.string().min(1)).default([]),
});

export type ReviewVerdictInput = z.output<typeof reviewVerdictSchema> & {
  readonly reviewId: string;
  readonly actor: string;
};

/**
 * Apply one verdict INSIDE an already-open transaction. Protocol, in lock-rank order:
 *
 *   1. Plain-read the review row — an unknown id or an already-decided review is a typed refusal
 *      before any lock is taken.
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

  const taskRows = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.taskId, pending.taskId))) as TaskRecord[];
  const snapshot = taskRows[0];
  if (!snapshot) throw new TaskNotFoundError(pending.taskId);

  const task = await lockRootFirst(tx, snapshot);
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

  const maxRounds = budgets.execution.maxReviewRounds ?? null;
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
