/**
 * Review verdicts against real Postgres — the accept / rework / rounds-exhausted outcomes, the
 * one-verdict-per-round compare-and-swap under REAL concurrency, and the racer branch that reports
 * the truer refusal (already-decided beats a bare state error when the racer decided THIS review).
 * The lock discipline under test is the module's own rule: task locks BEFORE the review-row CAS,
 * on every path.
 */
import { schema } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTurnOutcome } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { workforceBudgetsSchema } from './budget.js';
import { createRootTask } from './create-task.js';
import {
  applyReviewVerdict,
  ReviewAlreadyDecidedError,
  ReviewNotFoundError,
  type ReviewRecord,
} from './reviews.js';
import {
  forTenant,
  makeTestDb,
  resetTaskSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'reviews.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

const NO_BUDGETS = workforceBudgetsSchema.parse({});
const ONE_ROUND = workforceBudgetsSchema.parse({ execution: { maxReviewRounds: 1 } });

describe.skipIf(!hasDb)('review verdicts (db)', () => {
  let db: ReturnType<typeof makeTestDb>;

  beforeAll(async () => {
    db = makeTestDb();
    await resetTaskSchema(db);
    return async () => {
      await db.$client.end();
    };
  });

  beforeEach(async () => {
    await db.$client.unsafe(
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals, workforce_delegations, workforce_approvals, workforce_reviews, workforce_messages, workforce_budget_ledger, workforce_runtime, run_events CASCADE;',
    );
    await seedOrgs(db);
  });

  const tdb = () => forTenant(db, TENANT_A);

  function turnIdFor(taskId: string, turnNumber: number): string {
    return `wf-task-turn:${taskId}:${turnNumber}`;
  }

  /** Park a fresh root in waiting_for_review via the request_review intent; return its review row. */
  async function parkedForReview(): Promise<{ task: TaskRecord; review: ReviewRecord }> {
    const root = await createRootTask(tdb(), {
      workforceId: 'wf',
      title: 'Reviewed work',
      goal: 'Produce a reviewable result.',
      owner: 'dev',
      requestedBy: 'user',
    });
    const queued = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(root.taskId, 1),
    });
    const applied = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: { kind: 'request_review', reviewer: 'qa' },
      budgets: NO_BUDGETS,
    });
    expect(applied.task?.status).toBe('waiting_for_review');
    const reviews = (await tdb()
      .select(schema.workforceReviews)
      .where(eq(schema.workforceReviews.taskId, root.taskId))) as ReviewRecord[];
    const review = reviews[0];
    if (!review) throw new Error('expected a pending review row');
    return { task: applied.task as TaskRecord, review };
  }

  it('accept completes the task and stamps the verdict + audit event', async () => {
    const { task, review } = await parkedForReview();
    const done = await applyReviewVerdict(tdb(), NO_BUDGETS, {
      reviewId: review.id,
      verdict: 'accept',
      reasons: [],
      requiredChanges: [],
      actor: 'user:qa',
    });
    expect(done.status).toBe('completed');
    const decided = await db.$client.unsafe(
      `SELECT verdict FROM workforce_reviews WHERE id = '${review.id}';`,
    );
    expect(decided[0]?.verdict).toBe('accept');
    const events = await db.$client.unsafe(
      `SELECT count(*)::int AS n FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.review.decided';`,
    );
    expect(events[0]?.n).toBe(1);
  });

  it('reject re-queues for rework below the round ceiling', async () => {
    const { review } = await parkedForReview();
    const reworked = await applyReviewVerdict(tdb(), NO_BUDGETS, {
      reviewId: review.id,
      verdict: 'reject',
      reasons: ['thin evidence'],
      requiredChanges: ['add the measurement table'],
      actor: 'user:qa',
    });
    expect(reworked.status).toBe('queued');
  });

  it('reject at the round ceiling parks the task for a human instead of looping', async () => {
    const { review } = await parkedForReview();
    const parked = await applyReviewVerdict(tdb(), ONE_ROUND, {
      reviewId: review.id,
      verdict: 'reject',
      reasons: ['still thin'],
      requiredChanges: [],
      actor: 'user:qa',
    });
    expect(parked.status).toBe('waiting_for_user');
    expect(parked.statusReason).toBeNull();
  });

  it('two RACING verdicts on one review admit exactly one — the loser reports already-decided', async () => {
    const { review } = await parkedForReview();
    // BOTH racers are the review's own named reviewer (`qa`): the subject here is the
    // one-verdict-per-round compare-and-swap, and the two are told apart by their VERDICT, not by
    // their actor. Racing two unrelated principals would now be refused by the decision-door
    // authority gate before the CAS ever ran, which would quietly stop testing the CAS.
    const race = await Promise.allSettled([
      applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'accept',
        reasons: [],
        requiredChanges: [],
        actor: 'user:qa',
      }),
      applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'reject',
        reasons: ['no'],
        requiredChanges: [],
        actor: 'user:qa',
      }),
    ]);
    const wins = race.filter((r) => r.status === 'fulfilled');
    const losses = race.filter((r) => r.status === 'rejected');
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);
    const loss = losses[0] as PromiseRejectedResult;
    expect(loss.reason).toBeInstanceOf(ReviewAlreadyDecidedError);
    // The stored verdict is the winner's — never a blend, never the loser's overwrite.
    const stored = await db.$client.unsafe(
      `SELECT verdict FROM workforce_reviews WHERE id = '${review.id}';`,
    );
    const winner = wins[0] as PromiseFulfilledResult<TaskRecord>;
    expect(stored[0]?.verdict).toBe(winner.value.status === 'completed' ? 'accept' : 'reject');
  });

  it('a second verdict after the first reports already-decided, not a bare state error', async () => {
    const { review } = await parkedForReview();
    await applyReviewVerdict(tdb(), NO_BUDGETS, {
      reviewId: review.id,
      verdict: 'accept',
      reasons: [],
      requiredChanges: [],
      actor: 'user:qa',
    });
    await expect(
      applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'reject',
        reasons: ['late'],
        requiredChanges: [],
        actor: 'user:late',
      }),
    ).rejects.toBeInstanceOf(ReviewAlreadyDecidedError);
  });

  it('an unknown review id is a typed refusal', async () => {
    await expect(
      applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: '00000000-0000-4000-8000-00000000dead',
        verdict: 'accept',
        reasons: [],
        requiredChanges: [],
        actor: 'user:qa',
      }),
    ).rejects.toBeInstanceOf(ReviewNotFoundError);
  });
});
