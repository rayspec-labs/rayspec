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
    const snapshot = taskRows[0];
    if (snapshot?.status !== 'waiting_for_review') {
      throw new ReviewTaskStateError(input.reviewId, snapshot?.status ?? 'absent');
    }
    const maxRounds = budgets.execution.maxReviewRounds ?? null;
    const outcome =
      input.verdict === 'accept'
        ? 'completed'
        : maxRounds !== null && review.round >= maxRounds
          ? 'rounds_exhausted'
          : 'rework';
    // Completing fans in to the parent — a SECOND task row — so the root-first locks come before
    // ANY write on this task, the journal counter's own UPDATE included (apply-intents.ts's module
    // header). The other two outcomes move one row and need no pre-lock.
    const task = outcome === 'completed' ? await lockRootFirst(tx, snapshot) : snapshot;
    if (task.status !== 'waiting_for_review') {
      throw new ReviewTaskStateError(input.reviewId, task.status);
    }
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
  });
}
