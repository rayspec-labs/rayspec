/**
 * Review verdict application — the engine applies verdicts, never prose. `accept` completes the
 * task; `reject` re-queues it for rework UNTIL the round ceiling is spent, at which point the task
 * parks in `waiting_for_user` — a human decides, rather than an infinite accept/rework loop. The
 * per-review compare-and-swap (`verdict IS NULL`) admits exactly one verdict per round.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { afterTaskTerminal, lockRootFirst } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import type { WorkforceBudgets } from './budget.js';

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

export async function applyReviewVerdict(
  tdb: TenantDb,
  budgets: WorkforceBudgets,
  input: ReviewVerdictInput,
): Promise<TaskRecord> {
  return tdb.transaction(async (tx) => {
    const updated = (await tx
      .update(schema.workforceReviews, {
        verdict: input.verdict,
        reasons: input.reasons,
        requiredChanges: input.requiredChanges,
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(schema.workforceReviews.id, input.reviewId),
          isNull(schema.workforceReviews.verdict),
        ),
      )
      .returning()) as ReviewRecord[];
    const review = updated[0];
    if (!review) {
      const rows = (await tx
        .select(schema.workforceReviews)
        .where(eq(schema.workforceReviews.id, input.reviewId))) as ReviewRecord[];
      if (!rows[0]) throw new ReviewNotFoundError(input.reviewId);
      throw new ReviewAlreadyDecidedError(input.reviewId);
    }
    const taskRows = (await tx
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.taskId, review.taskId))) as TaskRecord[];
    const task = taskRows[0];
    if (task?.status !== 'waiting_for_review') {
      throw new ReviewTaskStateError(input.reviewId, task?.status ?? 'absent');
    }
    if (input.verdict === 'accept') {
      // Completing fans in to the parent, so this touches a second task row: root-first first
      // (apply-intents.ts's module header).
      const locked = await lockRootFirst(tx, task);
      if (locked.status !== 'waiting_for_review') {
        throw new ReviewTaskStateError(input.reviewId, locked.status);
      }
      const done = await applyTransition(tx, {
        taskId: locked.taskId,
        expectedVersion: locked.version,
        to: 'completed',
        actor: input.actor,
      });
      await afterTaskTerminal(tx, done);
      return done;
    }
    const maxRounds = budgets.execution.maxReviewRounds ?? null;
    if (maxRounds !== null && review.round >= maxRounds) {
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
  });
}
