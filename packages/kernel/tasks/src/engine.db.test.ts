/**
 * The engine's turn-application, fan-out/fan-in, approval, review, and cancellation flows against
 * real Postgres — whole invariants on durable artifacts, no fakes. The receipts suite is the
 * restart story's kernel: re-applying a committed turn changes nothing and duplicates nothing.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBudgetExhausted,
  applyTurnOutcome,
  DELEGATION_STATUSES,
  lockRootFirst,
  TurnStateError,
} from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { ApprovalAlreadyDecidedError, decideApproval, sweepApprovalTimeouts } from './approvals.js';
import { workforceBudgetsSchema } from './budget.js';
import { cancelTaskCascade } from './control.js';
import { createRootTask } from './create-task.js';
import { applyReviewVerdict } from './reviews.js';
import { deliverSignal } from './signals.js';
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
    'engine.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

const NO_BUDGETS = workforceBudgetsSchema.parse({});
const RESULT = { status: 'completed', summary: 'Done.', confidence: 0.9 };

describe.skipIf(!hasDb)('turn application (db)', () => {
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

  async function newRoot(over: Record<string, unknown> = {}): Promise<TaskRecord> {
    return createRootTask(tdb(), {
      workforceId: 'wf',
      title: 'Root',
      goal: 'Drive the flows.',
      owner: 'coordinator',
      requestedBy: 'user',
      ...over,
    });
  }

  /** The dispatch id a turn claims under — the same id its application then presents. */
  function turnIdFor(taskId: string, turnNumber: number): string {
    return `wf-task-turn:${taskId}:${turnNumber}`;
  }

  /**
   * Take a turn's claim exactly as `#claimTurn` does: the `queued -> working` transition STAMPED
   * with the dispatching turn's own id. An unstamped claim is not a claim the application will
   * accept — `applyTurnOutcome` refuses to apply over a turn it does not own.
   */
  function claim(taskId: string, expectedVersion: number, turnNumber: number): Promise<TaskRecord> {
    return applyTransition(tdb(), {
      taskId,
      expectedVersion,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(taskId, turnNumber),
    });
  }

  async function driveToWorking(task: TaskRecord): Promise<TaskRecord> {
    const queued = await applyTransition(tdb(), {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'queued',
      actor: 'scheduler',
    });
    return claim(task.taskId, queued.version, 1);
  }

  function turn(taskId: string, turnNumber: number, intent: unknown, actualUsd = 0) {
    return applyTurnOutcome(tdb(), {
      taskId,
      turnId: turnIdFor(taskId, turnNumber),
      turnNumber,
      intent,
      budgets: NO_BUDGETS,
      actualUsd,
    });
  }

  it('a complete turn finishes the task and the receipt makes re-application a no-op', async () => {
    const root = await driveToWorking(await newRoot());
    const first = await turn(root.taskId, 1, { kind: 'complete', result: RESULT }, 0.25);
    expect(first.alreadyApplied).toBe(false);
    expect(first.task?.status).toBe('completed');
    expect(first.task?.turnsUsed).toBe(1);
    expect(Number(first.task?.costUsd)).toBe(0.25);

    // Whole-turn re-execution after a crash lands here again — the receipt short-circuits.
    const replay = await turn(root.taskId, 1, { kind: 'complete', result: RESULT }, 0.25);
    expect(replay.alreadyApplied).toBe(true);
    const counts = await db.$client.unsafe(
      `SELECT
         (SELECT count(*)::int FROM workforce_task_transitions WHERE task_id = '${root.taskId}') AS transitions,
         (SELECT count(*)::int FROM run_events WHERE run_id = '${root.taskId}' AND type = 'workforce.task.completed') AS completed_events,
         (SELECT turns_used FROM workforce_tasks WHERE task_id = '${root.taskId}') AS turns;`,
    );
    expect(counts[0]).toMatchObject({ transitions: 3, completed_events: 1, turns: 1 });
  });

  it('fan-out opens the children, records the delegations, parks the parent — idempotently', async () => {
    const root = await driveToWorking(await newRoot());
    const intent = {
      kind: 'fan_out',
      children: [1, 2, 3, 4].map((i) => ({
        title: `Slice ${i}`,
        goal: `Handle slice ${i}.`,
        owner: `worker-${i}`,
      })),
    };
    const out = await turn(root.taskId, 1, intent);
    expect(out.task?.status).toBe('blocked');
    expect(out.task?.statusReason).toBe('awaiting_children');
    expect(out.task?.joinPolicy).toEqual({ policy: 'all' });

    const children = await db.$client.unsafe(
      `SELECT task_id, status, owner, root_task_id, ancestry_path FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' ORDER BY owner;`,
    );
    expect(children).toHaveLength(4);
    for (const c of children) {
      expect(c.status).toBe('planned');
      expect(c.root_task_id).toBe(root.taskId);
      expect(c.ancestry_path).toEqual([root.taskId]);
    }
    const delegations = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_delegations WHERE parent_task_id = '${root.taskId}' AND status = 'accepted';`,
    );
    expect(delegations[0]?.c).toBe(4);
    // Each hand-off is journaled: a delegation surface that leaves only a generic transition
    // behind is not auditable.
    const accepted = (await db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${root.taskId}' AND type = 'workforce.delegation.accepted' ORDER BY seq::numeric;`,
    )) as unknown as { data: { childTaskId: string; delegatedTo: string; depth: number } }[];
    expect(accepted).toHaveLength(4);
    expect(accepted.map((e) => e.data.childTaskId).sort()).toEqual(
      children.map((c) => c.task_id as string).sort(),
    );
    for (const e of accepted) expect(e.data.depth).toBe(1);

    const replay = await turn(root.taskId, 1, intent);
    expect(replay.alreadyApplied).toBe(true);
    const stillFour = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    );
    expect(stillFour[0]?.c).toBe(4);
  });

  it('a fan-out child carries the ORIGINAL delegation target on the record, never on the task row', async () => {
    const root = await driveToWorking(await newRoot());
    const out = await turn(root.taskId, 1, {
      kind: 'fan_out',
      children: [
        { title: 'Dept work', goal: 'G', owner: 'mgr-eng', delegatedTo: 'department:engineering' },
        { title: 'Direct work', goal: 'G', owner: 'worker-1' },
      ],
    });
    expect(out.task?.statusReason).toBe('awaiting_children');
    const rows = (await db.$client.unsafe(
      `SELECT delegated_to, resolved_owner FROM workforce_delegations WHERE parent_task_id = '${root.taskId}' ORDER BY resolved_owner;`,
    )) as unknown as { delegated_to: string; resolved_owner: string }[];
    expect(rows).toEqual([
      { delegated_to: 'department:engineering', resolved_owner: 'mgr-eng' },
      { delegated_to: 'worker-1', resolved_owner: 'worker-1' },
    ]);
    // The task row's owner IS the resolution — the target string never lands there.
    const owners = await db.$client.unsafe(
      `SELECT owner FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' ORDER BY owner;`,
    );
    expect(owners.map((r) => r.owner)).toEqual(['mgr-eng', 'worker-1']);
  });

  it('a rejected fan-out records the ORIGINAL target on the rejected delegation rows too', async () => {
    const root = await driveToWorking(await newRoot());
    const out = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: {
        kind: 'fan_out',
        children: [
          { title: 'One too many', goal: 'G', owner: 'worker-1', delegatedTo: 'team:release' },
          { title: 'Two too many', goal: 'G', owner: 'worker-2' },
        ],
      },
      budgets: workforceBudgetsSchema.parse({ delegation: { maxPerTask: 1 } }),
    });
    expect(out.plan?.kind).toBe('delegation_rejected');
    const rows = (await db.$client.unsafe(
      `SELECT delegated_to, resolved_owner, status FROM workforce_delegations WHERE parent_task_id = '${root.taskId}' ORDER BY resolved_owner;`,
    )) as unknown as { delegated_to: string; resolved_owner: string; status: string }[];
    expect(rows).toEqual([
      { delegated_to: 'team:release', resolved_owner: 'worker-1', status: 'rejected' },
      { delegated_to: 'worker-2', resolved_owner: 'worker-2', status: 'rejected' },
    ]);
  });

  it('request_clarification parks the task, messages the requester, and a user_reply wakes it', async () => {
    const root = await driveToWorking(await newRoot());
    const out = await turn(root.taskId, 1, {
      kind: 'request_clarification',
      question: 'Which quarter does the report cover?',
    });
    expect(out.task?.status).toBe('blocked');
    expect(out.task?.statusReason).toBe('clarification_pending');
    const messages = await db.$client.unsafe(
      `SELECT sender, recipient, body FROM workforce_messages WHERE task_id = '${root.taskId}';`,
    );
    expect(messages).toEqual([
      {
        sender: 'coordinator',
        recipient: 'user',
        body: 'Which quarter does the report cover?',
      },
    ]);

    // The reply is the wake: user_reply answers exactly blocked(clarification_pending).
    const woke = await deliverSignal(tdb(), {
      taskId: root.taskId,
      kind: 'user_reply',
      signalKey: 'reply:1',
      payload: { answer: 'Q3' },
      actor: 'user',
    });
    expect(woke.woke).toBe(true);
    const row = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(row[0]).toEqual({ status: 'queued', status_reason: null });

    // Receipt idempotency: re-applying the SAME turn after the wake is a read-only no-op.
    const replay = await turn(root.taskId, 1, {
      kind: 'request_clarification',
      question: 'Which quarter does the report cover?',
    });
    expect(replay.alreadyApplied).toBe(true);
    const still = await db.$client.unsafe(
      `SELECT status, count(*) OVER ()::int AS messages FROM workforce_tasks t JOIN workforce_messages m ON m.task_id = t.task_id WHERE t.task_id = '${root.taskId}';`,
    );
    expect(still[0]?.status).toBe('queued');
    expect(still[0]?.messages).toBe(1);
  });

  it('buffered creates land with the turn; delegation rows only for hand-offs; replay is a no-op', async () => {
    const root = await driveToWorking(await newRoot());
    const applyIt = () =>
      applyTurnOutcome(tdb(), {
        taskId: root.taskId,
        turnId: turnIdFor(root.taskId, 1),
        turnNumber: 1,
        intent: { kind: 'yield' },
        createdChildren: [
          { title: 'Backlog item', goal: 'Own follow-up planning.', owner: 'coordinator' },
          {
            title: 'Handed off',
            goal: 'A member does this.',
            owner: 'worker-1',
            delegatedTo: 'department:eng',
          },
        ],
        budgets: NO_BUDGETS,
      });
    const out = await applyIt();
    expect(out.task?.status).toBe('queued'); // the caller keeps working — creates never park it
    const children = (await db.$client.unsafe(
      `SELECT owner FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' ORDER BY owner;`,
    )) as unknown as { owner: string }[];
    expect(children.map((c) => c.owner)).toEqual(['coordinator', 'worker-1']);
    const delegations = (await db.$client.unsafe(
      `SELECT delegated_to, resolved_owner FROM workforce_delegations WHERE parent_task_id = '${root.taskId}';`,
    )) as unknown as { delegated_to: string; resolved_owner: string }[];
    expect(delegations).toEqual([{ delegated_to: 'department:eng', resolved_owner: 'worker-1' }]);

    const replay = await applyIt();
    expect(replay.alreadyApplied).toBe(true);
    const still = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    );
    expect(still[0]?.c).toBe(2);
  });

  it('buffered creates and a same-turn fan-out share the child-id space without collision', async () => {
    const root = await driveToWorking(await newRoot());
    const out = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: {
        kind: 'fan_out',
        children: [
          { title: 'F1', goal: 'G', owner: 'worker-1' },
          { title: 'F2', goal: 'G', owner: 'worker-2' },
        ],
      },
      createdChildren: [{ title: 'Planned', goal: 'G', owner: 'coordinator' }],
      budgets: NO_BUDGETS,
    });
    expect(out.task?.statusReason).toBe('awaiting_children');
    const children = await db.$client.unsafe(
      `SELECT count(*)::int AS c, count(DISTINCT task_id)::int AS ids FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    );
    expect(children[0]).toEqual({ c: 3, ids: 3 });
  });

  it('buffered creates the budget cannot pay for park the task and create nothing', async () => {
    const root = await driveToWorking(await newRoot());
    const out = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: { kind: 'yield' },
      createdChildren: [{ title: 'C', goal: 'G', owner: 'worker-1' }],
      budgets: workforceBudgetsSchema.parse({
        subtree: { usd: 0.1 },
        execution: { estimateUsdPerTurn: 1 },
      }),
    });
    expect(out.task?.status).toBe('blocked');
    expect(out.task?.statusReason).toBe('budget_exhausted');
    const children = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    );
    expect(children[0]?.c).toBe(0);
  });

  it('cancel_task cancels a subtree the caller roots and the caller keeps orchestrating', async () => {
    const root = await driveToWorking(await newRoot());
    await turn(root.taskId, 1, { kind: 'yield' });
    // Turn 2 buffers a hand-off child, then turn 3 cancels it.
    await claim(root.taskId, await currentVersion(root.taskId), 2);
    await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 2),
      turnNumber: 2,
      intent: { kind: 'yield' },
      createdChildren: [{ title: 'Doomed', goal: 'G', owner: 'worker-1' }],
      budgets: NO_BUDGETS,
    });
    const child = (await db.$client.unsafe(
      `SELECT task_id FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    )) as unknown as { task_id: string }[];
    const childId = (child[0] as { task_id: string }).task_id;

    await claim(root.taskId, await currentVersion(root.taskId), 3);
    const out = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 3),
      turnNumber: 3,
      intent: { kind: 'cancel_task', taskId: childId, detail: 'superseded' },
      budgets: NO_BUDGETS,
    });
    expect(out.plan?.kind).toBe('cancel_task');
    expect(out.task?.status).toBe('queued'); // the caller continues
    const rows = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${childId}';`,
    );
    expect(rows[0]).toEqual({ status: 'cancelled', status_reason: 'cancelled_by_user' });
    // The hand-off's delegation record settles with its child.
    const settled = await db.$client.unsafe(
      `SELECT status FROM workforce_delegations WHERE child_task_id = '${childId}';`,
    );
    expect(settled[0]?.status).toBe('cancelled');
  });

  it('cancel_task on a task outside the caller subtree is a tool error touching nothing', async () => {
    const rootA = await driveToWorking(await newRoot());
    const foreign = await newRoot({ owner: 'other' });
    const out = await turn(rootA.taskId, 1, { kind: 'cancel_task', taskId: foreign.taskId });
    expect(out.plan?.kind).toBe('invalid_intent');
    expect(out.task?.status).toBe('queued');
    expect(out.task?.statusReason).toBe('tool_error');
    const untouched = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${foreign.taskId}';`,
    );
    expect(untouched[0]?.status).toBe('planned');
  });

  async function currentVersion(taskId: string): Promise<number> {
    const rows = (await db.$client.unsafe(
      `SELECT version FROM workforce_tasks WHERE task_id = '${taskId}';`,
    )) as unknown as { version: number }[];
    return (rows[0] as { version: number }).version;
  }

  const QA_POLICY = { reviewer: 'qa', dispatchReviewer: true, maxRounds: 2 };

  /** Drive a task's next turn to a policy-intercepted completion. */
  function completeUnderPolicy(taskId: string, turnNumber: number) {
    return applyTurnOutcome(tdb(), {
      taskId,
      turnId: turnIdFor(taskId, turnNumber),
      turnNumber,
      intent: { kind: 'complete', result: { ...RESULT, confidence: 0.6 } },
      reviewPolicy: QA_POLICY,
      budgets: NO_BUDGETS,
    });
  }

  async function reviewerChildOf(
    taskId: string,
  ): Promise<{ task_id: string; version: number; owner: string; status: string }> {
    const rows = (await db.$client.unsafe(
      `SELECT task_id, version, owner, status FROM workforce_tasks WHERE parent_task_id = '${taskId}' AND status <> 'completed' ORDER BY created_at DESC LIMIT 1;`,
    )) as unknown as { task_id: string; version: number; owner: string; status: string }[];
    const child = rows[0];
    if (!child) throw new Error('expected a dispatched reviewer child');
    return child;
  }

  async function driveChildToWorking(taskId: string, turnNumber = 1): Promise<void> {
    const rows = (await db.$client.unsafe(
      `SELECT version, status FROM workforce_tasks WHERE task_id = '${taskId}';`,
    )) as unknown as { version: number; status: string }[];
    const row = rows[0] as { version: number; status: string };
    const queued =
      row.status === 'queued'
        ? { version: row.version }
        : await applyTransition(tdb(), {
            taskId,
            expectedVersion: row.version,
            to: 'queued',
            actor: 'scheduler',
          });
    await applyTransition(tdb(), {
      taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(taskId, turnNumber),
    });
  }

  it('a matched policy intercepts completion; the dispatched reviewer drives rework, acceptance, then exhaustion', async () => {
    const root = await driveToWorking(await newRoot({ owner: 'dev' }));

    // Round 1: the policy intercepts the completion — result STORED, task parked for review,
    // reviewer child dispatched.
    const parked = await completeUnderPolicy(root.taskId, 1);
    expect(parked.plan?.kind).toBe('complete_with_review');
    expect(parked.task?.status).toBe('waiting_for_review');
    expect(parked.task?.statusReason).toBe('review_pending');
    const stored = await db.$client.unsafe(
      `SELECT result->>'summary' AS summary, confidence FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(stored[0]?.summary).toBe('Done.');
    const requested = (await db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${root.taskId}' AND type = 'workforce.review.requested' ORDER BY seq::numeric;`,
    )) as unknown as { data: { policy: boolean; reviewTaskId: string; round: number } }[];
    expect(requested).toHaveLength(1);
    expect(requested[0]?.data.policy).toBe(true);
    const reviewer1 = await reviewerChildOf(root.taskId);
    expect(reviewer1.owner).toBe('qa');
    expect(requested[0]?.data.reviewTaskId).toBe(reviewer1.task_id);

    // The reviewer REJECTS: the reviewed task re-queues for rework, the reviewer task completes.
    const review1 = (await db.$client.unsafe(
      `SELECT id FROM workforce_reviews WHERE task_id = '${root.taskId}' AND round = 1;`,
    )) as unknown as { id: string }[];
    await driveChildToWorking(reviewer1.task_id);
    const verdict1 = await applyTurnOutcome(tdb(), {
      taskId: reviewer1.task_id,
      turnId: turnIdFor(reviewer1.task_id, 1),
      turnNumber: 1,
      intent: {
        kind: 'submit_review',
        reviewId: (review1[0] as { id: string }).id,
        verdict: 'reject',
        reasons: ['thin evidence'],
        requiredChanges: ['add the measurements'],
      },
      budgets: NO_BUDGETS,
    });
    expect(verdict1.task?.status).toBe('completed');
    const afterReject = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(afterReject[0]?.status).toBe('queued');

    // Round 2: rework resubmits under the same policy; the second reviewer ACCEPTS.
    await driveChildToWorking(root.taskId, 2);
    const parked2 = await completeUnderPolicy(root.taskId, 2);
    expect(parked2.task?.status).toBe('waiting_for_review');
    const reviewer2 = await reviewerChildOf(root.taskId);
    const review2 = (await db.$client.unsafe(
      `SELECT id FROM workforce_reviews WHERE task_id = '${root.taskId}' AND round = 2;`,
    )) as unknown as { id: string }[];
    await driveChildToWorking(reviewer2.task_id);
    await applyTurnOutcome(tdb(), {
      taskId: reviewer2.task_id,
      turnId: turnIdFor(reviewer2.task_id, 1),
      turnNumber: 1,
      intent: {
        kind: 'submit_review',
        reviewId: (review2[0] as { id: string }).id,
        verdict: 'accept',
      },
      budgets: NO_BUDGETS,
    });
    const accepted = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(accepted[0]?.status).toBe('completed');
  });

  it('a completion arriving with the policy rounds spent parks for a human WITH the result stored', async () => {
    const root = await driveToWorking(await newRoot({ owner: 'dev' }));
    // Two rounds already consumed on the review table.
    await db.$client.unsafe(
      `INSERT INTO workforce_reviews (tenant_id, task_id, reviewer, round, verdict) VALUES ('${TENANT_A}', '${root.taskId}', 'qa', 1, 'reject'), ('${TENANT_A}', '${root.taskId}', 'qa', 2, 'reject');`,
    );
    const out = await completeUnderPolicy(root.taskId, 1);
    expect(out.plan?.kind).toBe('review_rounds_exhausted');
    expect(out.task?.status).toBe('waiting_for_user');
    const stored = await db.$client.unsafe(
      `SELECT result->>'summary' AS summary FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(stored[0]?.summary).toBe('Done.');
  });

  it('a reviewer verdict that lost its race completes the reviewer task as superseded', async () => {
    const root = await driveToWorking(await newRoot({ owner: 'dev' }));
    await completeUnderPolicy(root.taskId, 1);
    const reviewer = await reviewerChildOf(root.taskId);
    const review = (await db.$client.unsafe(
      `SELECT id FROM workforce_reviews WHERE task_id = '${root.taskId}' AND round = 1;`,
    )) as unknown as { id: string }[];
    // The HUMAN verdict route decides first.
    await applyReviewVerdict(tdb(), NO_BUDGETS, {
      reviewId: (review[0] as { id: string }).id,
      verdict: 'accept',
      reasons: [],
      requiredChanges: [],
      actor: 'user:qa-lead',
    });
    // The dispatched reviewer's turn then lands — benign, recorded as superseded.
    await driveChildToWorking(reviewer.task_id);
    const out = await applyTurnOutcome(tdb(), {
      taskId: reviewer.task_id,
      turnId: turnIdFor(reviewer.task_id, 1),
      turnNumber: 1,
      intent: {
        kind: 'submit_review',
        reviewId: (review[0] as { id: string }).id,
        verdict: 'reject',
        reasons: ['too late'],
      },
      budgets: NO_BUDGETS,
    });
    expect(out.task?.status).toBe('completed');
    const summary = await db.$client.unsafe(
      `SELECT result->>'summary' AS summary FROM workforce_tasks WHERE task_id = '${reviewer.task_id}';`,
    );
    expect(summary[0]?.summary).toContain('superseded');
    // The winner's outcome stands.
    const rootRow = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(rootRow[0]?.status).toBe('completed');
  });

  it('a review id that does not belong to the parent is a tool error — requeue once, then failed', async () => {
    const root = await driveToWorking(await newRoot({ owner: 'dev' }));
    await completeUnderPolicy(root.taskId, 1);
    const reviewer = await reviewerChildOf(root.taskId);
    // A FOREIGN review row (another task's pending review).
    const other = await driveToWorking(await newRoot({ owner: 'dev-2' }));
    await turn(other.taskId, 1, { kind: 'request_review', reviewer: 'qa' });
    const foreign = (await db.$client.unsafe(
      `SELECT id FROM workforce_reviews WHERE task_id = '${other.taskId}';`,
    )) as unknown as { id: string }[];

    const forged = {
      kind: 'submit_review',
      reviewId: (foreign[0] as { id: string }).id,
      verdict: 'accept',
    };
    await driveChildToWorking(reviewer.task_id);
    const first = await applyTurnOutcome(tdb(), {
      taskId: reviewer.task_id,
      turnId: turnIdFor(reviewer.task_id, 1),
      turnNumber: 1,
      intent: forged,
      budgets: NO_BUDGETS,
    });
    expect(first.task?.status).toBe('queued');
    expect(first.task?.statusReason).toBe('tool_error');
    await driveChildToWorking(reviewer.task_id, 2);
    const second = await applyTurnOutcome(tdb(), {
      taskId: reviewer.task_id,
      turnId: turnIdFor(reviewer.task_id, 2),
      turnNumber: 2,
      intent: forged,
      budgets: NO_BUDGETS,
    });
    expect(second.task?.status).toBe('failed');
    // The foreign review is untouched.
    const untouched = await db.$client.unsafe(
      `SELECT verdict FROM workforce_reviews WHERE task_id = '${other.taskId}';`,
    );
    expect(untouched[0]?.verdict).toBeNull();
  });

  it('a malformed trusted review-policy channel is a hard typed refusal', async () => {
    const root = await driveToWorking(await newRoot({ owner: 'dev' }));
    await expect(
      applyTurnOutcome(tdb(), {
        taskId: root.taskId,
        turnId: turnIdFor(root.taskId, 1),
        turnNumber: 1,
        intent: { kind: 'complete', result: RESULT },
        reviewPolicy: { reviewer: 'qa' },
        budgets: NO_BUDGETS,
      }),
    ).rejects.toThrow();
  });

  it('escalate parks the caller, opens the escalation child, and the child completing wakes it', async () => {
    const root = await driveToWorking(await newRoot({ owner: 'worker-1' }));
    const out = await turn(root.taskId, 1, {
      kind: 'escalate',
      reason: 'capability_missing',
      detail: 'needs a production credential',
      escalateTo: 'mgr',
      escalateToDepartment: 'eng',
    });
    expect(out.task?.status).toBe('blocked');
    expect(out.task?.statusReason).toBe('escalated');

    const children = (await db.$client.unsafe(
      `SELECT task_id, owner, department, status, version FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    )) as unknown as {
      task_id: string;
      owner: string;
      department: string;
      status: string;
      version: number;
    }[];
    expect(children).toHaveLength(1);
    const child = children[0] as (typeof children)[number];
    expect(child.owner).toBe('mgr');
    expect(child.department).toBe('eng');
    expect(child.status).toBe('planned');
    // An escalation is NOT a delegation: no delegation row, no fan-out cap consumed.
    const delegations = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_delegations WHERE parent_task_id = '${root.taskId}';`,
    );
    expect(delegations[0]?.c).toBe(0);
    const raised = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${root.taskId}' AND type = 'workforce.escalation.raised';`,
    );
    expect(raised[0]?.c).toBe(1);

    // The superior answers: their escalation task completes, and the terminal fans back as the
    // escalated signal that answers exactly the blocked(escalated) park.
    const queuedChild = await applyTransition(tdb(), {
      taskId: child.task_id,
      expectedVersion: child.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await claim(child.task_id, queuedChild.version, 1);
    await turn(child.task_id, 1, {
      kind: 'complete',
      result: { status: 'completed', summary: 'Granted a scoped credential.', confidence: 1 },
    });

    const woken = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(woken[0]).toEqual({ status: 'queued', status_reason: null });
    const signal = (await db.$client.unsafe(
      `SELECT kind, signal_key, payload FROM workforce_task_signals WHERE task_id = '${root.taskId}';`,
    )) as unknown as {
      kind: string;
      signal_key: string;
      payload: { summary: string; status: string };
    }[];
    expect(signal).toHaveLength(1);
    expect(signal[0]?.kind).toBe('escalated');
    expect(signal[0]?.signal_key).toBe(`escalated:${child.task_id}`);
    expect(signal[0]?.payload.status).toBe('completed');
    expect(signal[0]?.payload.summary).toBe('Granted a scoped credential.');
  });

  it('a sibling terminal never releases an escalation park — only the bound escalation child does', async () => {
    const root = await driveToWorking(await newRoot({ owner: 'worker-1' }));
    // ONE turn: buffer a detached self-owned child, then escalate — the caller now waits on the
    // superior while the detached child runs on.
    const out = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: {
        kind: 'escalate',
        reason: 'risk',
        escalateTo: 'mgr',
        escalateToDepartment: 'eng',
      },
      createdChildren: [{ title: 'Detached', goal: 'Runs on regardless.', owner: 'worker-1' }],
      budgets: NO_BUDGETS,
    });
    expect(out.task?.status).toBe('blocked');
    expect(out.task?.statusReason).toBe('escalated');

    const children = (await db.$client.unsafe(
      `SELECT task_id, owner, version FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' ORDER BY owner;`,
    )) as unknown as { task_id: string; owner: string; version: number }[];
    expect(children.map((c) => c.owner)).toEqual(['mgr', 'worker-1']);
    const escalation = children[0] as (typeof children)[number];
    const detached = children[1] as (typeof children)[number];
    // The park is BOUND to the escalation child on the caller's row.
    const bound = await db.$client.unsafe(
      `SELECT join_policy FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(bound[0]?.join_policy).toEqual({
      policy: 'escalation',
      escalationTaskId: escalation.task_id,
    });

    // The DETACHED sibling completes first — the park must hold and no signal may land.
    const queuedDetached = await applyTransition(tdb(), {
      taskId: detached.task_id,
      expectedVersion: detached.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await claim(detached.task_id, queuedDetached.version, 1);
    await turn(detached.task_id, 1, {
      kind: 'complete',
      result: { status: 'completed', summary: 'Side quest done.', confidence: 1 },
    });
    const held = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(held[0]).toEqual({ status: 'blocked', status_reason: 'escalated' });
    const noSignals = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_signals WHERE task_id = '${root.taskId}';`,
    );
    expect(noSignals[0]?.c).toBe(0);

    // The BOUND escalation child completes — exactly that terminal is the reply.
    const queuedEscalation = await applyTransition(tdb(), {
      taskId: escalation.task_id,
      expectedVersion: escalation.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await claim(escalation.task_id, queuedEscalation.version, 1);
    await turn(escalation.task_id, 1, {
      kind: 'complete',
      result: { status: 'completed', summary: 'Handled.', confidence: 1 },
    });
    const woken = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(woken[0]).toEqual({ status: 'queued', status_reason: null });
    const signals = (await db.$client.unsafe(
      `SELECT signal_key FROM workforce_task_signals WHERE task_id = '${root.taskId}';`,
    )) as unknown as { signal_key: string }[];
    expect(signals.map((s) => s.signal_key)).toEqual([`escalated:${escalation.task_id}`]);
  });

  it('a denied escalation blocks with the typed budget reason and opens no child', async () => {
    // The escalation child cannot be paid for: the subtree usd ceiling is below one per-turn
    // estimate (the child draws on the shared root scope — the task's own ceiling deliberately
    // does not bind a child, which gets its own task scope).
    const budgets = workforceBudgetsSchema.parse({
      subtree: { usd: 0.1 },
      execution: { estimateUsdPerTurn: 1 },
    });
    const root = await driveToWorking(await newRoot({ owner: 'worker-1' }));
    const out = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: { kind: 'escalate', reason: 'budget', escalateTo: 'mgr' },
      budgets,
    });
    expect(out.task?.status).toBe('blocked');
    expect(out.task?.statusReason).toBe('budget_exhausted');
    const children = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    );
    expect(children[0]?.c).toBe(0);
  });

  it('re-applying an escalate turn after the wake is a receipt no-op (no duplicate child)', async () => {
    const root = await driveToWorking(await newRoot({ owner: 'worker-1' }));
    await turn(root.taskId, 1, { kind: 'escalate', reason: 'risk', escalateTo: 'mgr' });
    const replay = await turn(root.taskId, 1, {
      kind: 'escalate',
      reason: 'risk',
      escalateTo: 'mgr',
    });
    expect(replay.alreadyApplied).toBe(true);
    const children = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    );
    expect(children[0]?.c).toBe(1);
  });

  it('buffered turn messages land as rows AND journal workforce.message.sent without the body', async () => {
    const root = await driveToWorking(await newRoot());
    await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: { kind: 'complete', result: RESULT },
      messages: [{ recipient: 'user', body: 'shipping the summary now' }],
      budgets: NO_BUDGETS,
    });
    const rows = await db.$client.unsafe(
      `SELECT sender, recipient, body FROM workforce_messages WHERE task_id = '${root.taskId}';`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sender).toBe('coordinator');
    const events = (await db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${root.taskId}' AND type = 'workforce.message.sent';`,
    )) as unknown as {
      data: { sender: string; recipient: string; bodyLength: number; body?: string };
    }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.data.recipient).toBe('user');
    expect(events[0]?.data.bodyLength).toBe('shipping the summary now'.length);
    expect(events[0]?.data.body).toBeUndefined();
  });

  it('the join wakes the parent exactly once, even when the last two children finish concurrently', async () => {
    const root = await driveToWorking(await newRoot());
    await turn(root.taskId, 1, {
      kind: 'fan_out',
      children: [1, 2].map((i) => ({ title: `S${i}`, goal: `G${i}`, owner: `worker-${i}` })),
    });
    const children = (await db.$client.unsafe(
      `SELECT task_id, version FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' ORDER BY task_id;`,
    )) as unknown as { task_id: string; version: number }[];

    // Drive both children to working, then complete them CONCURRENTLY.
    for (const c of children) {
      const row = (await db.$client.unsafe(
        `SELECT * FROM workforce_tasks WHERE task_id = '${c.task_id}';`,
      )) as unknown as Record<string, unknown>[];
      const queued = await applyTransition(tdb(), {
        taskId: c.task_id,
        expectedVersion: (row[0] as { version: number }).version,
        to: 'queued',
        actor: 'scheduler',
      });
      await claim(c.task_id, queued.version, 1);
    }
    await Promise.all(
      children.map((c) => turn(c.task_id, 1, { kind: 'complete', result: RESULT })),
    );

    const parent = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(parent[0]?.status).toBe('queued');
    const joinSignals = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_signals WHERE task_id = '${root.taskId}' AND kind = 'child_completed';`,
    );
    expect(joinSignals[0]?.c).toBe(1);
  });

  it('an approval request parks the task; the decision wakes it; a second decision is refused', async () => {
    const root = await driveToWorking(await newRoot());
    const out = await turn(root.taskId, 1, {
      kind: 'request_approval',
      question: 'Send the announcement?',
      options: ['send', 'hold'],
      timeoutMs: 60_000,
    });
    expect(out.task?.status).toBe('waiting_for_user');
    expect(out.task?.statusReason).toBe('approval_pending');

    const approvals = (await db.$client.unsafe(
      `SELECT id, status FROM workforce_approvals WHERE task_id = '${root.taskId}';`,
    )) as unknown as { id: string; status: string }[];
    expect(approvals[0]?.status).toBe('pending');
    const approvalId = approvals[0]?.id as string;

    const decided = await decideApproval(tdb(), {
      approvalId,
      decision: 'approve',
      decidedBy: 'user',
    });
    expect(decided.status).toBe('approved');
    const woke = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(woke[0]?.status).toBe('queued');

    await expect(
      decideApproval(tdb(), { approvalId, decision: 'reject', decidedBy: 'user' }),
    ).rejects.toThrow(ApprovalAlreadyDecidedError);
  });

  it("an overdue approval's declared fate is enforced: fail fails the task", async () => {
    const root = await driveToWorking(await newRoot());
    await turn(root.taskId, 1, {
      kind: 'request_approval',
      question: 'Proceed?',
      timeoutMs: 1,
    });
    const swept = await sweepApprovalTimeouts(tdb(), new Date(Date.now() + 10_000));
    expect(swept.failed).toHaveLength(1);
    const rows = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(rows[0]?.status).toBe('failed');
    const events = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${root.taskId}' AND type = 'workforce.approval.timed_out';`,
    );
    expect(events[0]?.c).toBe(1);
  });

  it('escalate re-issues the request to the DECLARED target and parks the task blocked', async () => {
    const root = await driveToWorking(await newRoot());
    await turn(root.taskId, 1, {
      kind: 'request_approval',
      question: 'Proceed?',
      timeoutMs: 1,
      onTimeout: 'escalate',
      escalateTo: 'ops-lead',
    });
    const swept = await sweepApprovalTimeouts(tdb(), new Date(Date.now() + 10_000));
    expect(swept.escalated).toHaveLength(1);
    const rows = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(rows[0]).toMatchObject({ status: 'blocked', status_reason: 'approval_pending' });
    const approvals = await db.$client.unsafe(
      `SELECT approver, status, on_timeout FROM workforce_approvals WHERE task_id = '${root.taskId}' ORDER BY created_at;`,
    );
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toMatchObject({ status: 'escalated' });
    // The escalated request ends at a human with a terminal fate — the chain cannot loop.
    expect(approvals[1]).toMatchObject({
      approver: 'ops-lead',
      status: 'pending',
      on_timeout: 'fail',
    });
  });

  it('review: reject reworks through queued; the round past the ceiling parks for a human; accept completes', async () => {
    const budgets = workforceBudgetsSchema.parse({ execution: { maxReviewRounds: 2 } });
    const root = await driveToWorking(await newRoot());
    const reviewTurn = (turnNumber: number) =>
      applyTurnOutcome(tdb(), {
        taskId: root.taskId,
        turnId: turnIdFor(root.taskId, turnNumber),
        turnNumber,
        intent: { kind: 'request_review', reviewer: 'reviewer-1' },
        budgets,
      });

    const r1 = await reviewTurn(1);
    expect(r1.task?.status).toBe('waiting_for_review');
    const review1 = (await db.$client.unsafe(
      `SELECT id FROM workforce_reviews WHERE task_id = '${root.taskId}' AND round = 1;`,
    )) as unknown as { id: string }[];
    const rejected = await applyReviewVerdict(tdb(), budgets, {
      reviewId: review1[0]?.id as string,
      verdict: 'reject',
      reasons: ['numbers unsupported'],
      requiredChanges: ['cite the ledger'],
      actor: 'reviewer-1',
    });
    expect(rejected.status).toBe('queued');

    // Rework round 2: dispatch again, request review again, reject again — rounds now exhausted.
    await claim(root.taskId, rejected.version, 2);
    const r2 = await reviewTurn(2);
    expect(r2.task?.status).toBe('waiting_for_review');
    const review2 = (await db.$client.unsafe(
      `SELECT id, round FROM workforce_reviews WHERE task_id = '${root.taskId}' AND round = 2;`,
    )) as unknown as { id: string }[];
    const exhausted = await applyReviewVerdict(tdb(), budgets, {
      reviewId: review2[0]?.id as string,
      verdict: 'reject',
      actor: 'reviewer-1',
    });
    expect(exhausted.status).toBe('waiting_for_user');

    // The whole review lifecycle is journaled — this surface is audit-first, and a verdict that
    // leaves only a generic transition behind cannot answer "who decided what, and when".
    const reviewEvents = (await db.$client.unsafe(
      `SELECT type, data FROM run_events WHERE run_id = '${root.taskId}' AND type LIKE 'workforce.review.%' ORDER BY seq::numeric;`,
    )) as unknown as {
      type: string;
      data: { round: number; verdict?: string; decidedBy?: string; outcome?: string };
    }[];
    expect(reviewEvents.map((e) => e.type)).toEqual([
      'workforce.review.requested',
      'workforce.review.decided',
      'workforce.review.requested',
      'workforce.review.decided',
    ]);
    expect(reviewEvents[1]?.data).toMatchObject({
      round: 1,
      verdict: 'reject',
      decidedBy: 'reviewer-1',
      outcome: 'rework',
    });
    expect(reviewEvents[3]?.data).toMatchObject({ round: 2, outcome: 'rounds_exhausted' });
  });

  it('every delegation status written is a member of the closed vocabulary', async () => {
    const budgets = workforceBudgetsSchema.parse({ delegation: { maxDepth: 1 } });
    const root = await driveToWorking(await newRoot());
    // Accepted (fan-out) …
    await turn(root.taskId, 1, {
      kind: 'fan_out',
      children: [1, 2].map((i) => ({ title: `S${i}`, goal: `G${i}`, owner: `worker-${i}` })),
    });
    const children = (await db.$client.unsafe(
      `SELECT task_id, version FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' ORDER BY task_id;`,
    )) as unknown as { task_id: string; version: number }[];
    // … completed (a child finishing settles its opening record) …
    const first = children[0] as { task_id: string; version: number };
    const q = await applyTransition(tdb(), {
      taskId: first.task_id,
      expectedVersion: first.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await claim(first.task_id, q.version, 1);
    await turn(first.task_id, 1, { kind: 'complete', result: RESULT });
    // … rejected (a hand-off refused at planning) …
    const second = children[1] as { task_id: string; version: number };
    const q2 = await applyTransition(tdb(), {
      taskId: second.task_id,
      expectedVersion: second.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await claim(second.task_id, q2.version, 1);
    await applyTurnOutcome(tdb(), {
      taskId: second.task_id,
      turnId: turnIdFor(second.task_id, 1),
      turnNumber: 1,
      intent: { kind: 'fan_out', children: [{ title: 'GC', goal: 'G', owner: 'worker-9' }] },
      budgets,
    });
    // … and cancelled (the cascade).
    await cancelTaskCascade(tdb(), { taskId: root.taskId, actor: 'user' });

    const written = (await db.$client.unsafe(
      'SELECT DISTINCT status FROM workforce_delegations ORDER BY status;',
    )) as unknown as { status: string }[];
    expect(written.length).toBeGreaterThan(1);
    for (const row of written) {
      expect(DELEGATION_STATUSES as readonly string[]).toContain(row.status);
    }
    const rejectedEvents = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${second.task_id}' AND type = 'workforce.delegation.rejected';`,
    );
    expect(rejectedEvents[0]?.c).toBe(1);
  });

  it('delegation rejections record typed rows and follow the one-retry fate', async () => {
    const budgets = workforceBudgetsSchema.parse({ delegation: { maxDepth: 1 } });
    const root = await driveToWorking(await newRoot());
    // Root fans out fine (depth 1)…
    const ok = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: { kind: 'fan_out', children: [{ title: 'C', goal: 'G', owner: 'worker-1' }] },
      budgets,
    });
    const childId = (await db.$client.unsafe(
      `SELECT task_id, version FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    )) as unknown as { task_id: string; version: number }[];
    expect(ok.task?.statusReason).toBe('awaiting_children');

    // …but the CHILD fanning out again would exceed maxDepth 1: typed rejection, re-queue once.
    const child = childId[0] as { task_id: string; version: number };
    const q = await applyTransition(tdb(), {
      taskId: child.task_id,
      expectedVersion: child.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await claim(child.task_id, q.version, 1);
    const grandchildIntent = {
      kind: 'fan_out',
      children: [{ title: 'GC', goal: 'G', owner: 'worker-2' }],
    };
    const rejected = await applyTurnOutcome(tdb(), {
      taskId: child.task_id,
      turnId: turnIdFor(child.task_id, 1),
      turnNumber: 1,
      intent: grandchildIntent,
      budgets,
    });
    expect(rejected.plan).toMatchObject({ kind: 'delegation_rejected', reason: 'depth_exceeded' });
    expect(rejected.task?.status).toBe('queued');
    expect(rejected.task?.statusReason).toBe('tool_error');
    const rejectedRows = await db.$client.unsafe(
      `SELECT status, rejection_reason FROM workforce_delegations WHERE parent_task_id = '${child.task_id}';`,
    );
    expect(rejectedRows[0]).toMatchObject({
      status: 'rejected',
      rejection_reason: 'depth_exceeded',
    });

    // Second consecutive offense is terminal.
    await claim(child.task_id, (rejected.task as TaskRecord).version, 2);
    const failed = await applyTurnOutcome(tdb(), {
      taskId: child.task_id,
      turnId: turnIdFor(child.task_id, 2),
      turnNumber: 2,
      intent: grandchildIntent,
      budgets,
    });
    expect(failed.task?.status).toBe('failed');
    expect(failed.task?.statusReason).toBe('tool_error');
  });

  it('a malformed intent never completes a task: re-queue once, then failed', async () => {
    const root = await driveToWorking(await newRoot());
    const bad = { kind: 'complete', result: { status: 'done', summary: 'x' } };
    const first = await turn(root.taskId, 1, bad);
    expect(first.task?.status).toBe('queued');
    expect(first.task?.statusReason).toBe('tool_error');
    await claim(root.taskId, (first.task as TaskRecord).version, 2);
    const second = await turn(root.taskId, 2, bad);
    expect(second.task?.status).toBe('failed');
  });

  it('a denied fan-out blocks with the typed reason and block_and_escalate parks the root', async () => {
    const budgets = workforceBudgetsSchema.parse({
      subtree: { usd: 0.1 },
      execution: { estimateUsdPerTurn: 1, onBudgetExhausted: 'block_and_escalate' },
    });
    const root = await driveToWorking(await newRoot());
    const out = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: { kind: 'fan_out', children: [{ title: 'C', goal: 'G', owner: 'worker-1' }] },
      budgets,
    });
    // The task itself IS the root: blocked(budget_exhausted), then escalated to waiting_for_user.
    const rows = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(out.plan?.kind).toBe('fan_out');
    expect(rows[0]?.status).toBe('waiting_for_user');
    const events = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${root.taskId}' AND type = 'workforce.budget.exceeded';`,
    );
    expect(events[0]?.c).toBeGreaterThanOrEqual(1);
    const noChildren = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    );
    expect(noChildren[0]?.c).toBe(0);
  });

  it('a SECOND fan-out round joins and wakes the parent again — the join key is per round', async () => {
    const root = await driveToWorking(await newRoot());

    async function completeAllChildren(): Promise<void> {
      const children = (await db.$client.unsafe(
        `SELECT task_id, version FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' AND status = 'planned' ORDER BY task_id;`,
      )) as unknown as { task_id: string; version: number }[];
      expect(children).toHaveLength(2);
      for (const c of children) {
        const queued = await applyTransition(tdb(), {
          taskId: c.task_id,
          expectedVersion: c.version,
          to: 'queued',
          actor: 'scheduler',
        });
        await claim(c.task_id, queued.version, 1);
        await turn(c.task_id, 1, { kind: 'complete', result: RESULT });
      }
    }

    await turn(root.taskId, 1, {
      kind: 'fan_out',
      children: [1, 2].map((i) => ({ title: `R1-${i}`, goal: `G${i}`, owner: `worker-${i}` })),
    });
    await completeAllChildren();
    let parent = await db.$client.unsafe(
      `SELECT status, version FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(parent[0]?.status).toBe('queued');

    // Round two: the parent works again and fans out a fresh pair. Before the per-round join key,
    // this round's wake collided with round one's signal row and the parent stayed blocked forever.
    await claim(root.taskId, (parent[0] as { version: number }).version, 2);
    await turn(root.taskId, 2, {
      kind: 'fan_out',
      children: [1, 2].map((i) => ({ title: `R2-${i}`, goal: `G${i}`, owner: `worker-${i}` })),
    });
    await completeAllChildren();

    parent = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(parent[0]?.status).toBe('queued');
    const joinSignals = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_signals WHERE task_id = '${root.taskId}' AND kind = 'child_completed';`,
    );
    expect(joinSignals[0]?.c).toBe(2);
  });

  it('a budget_raised delivered MID-TURN survives the boundary and wakes the park it answers', async () => {
    const budgets = workforceBudgetsSchema.parse({
      subtree: { usd: 0.1 },
      execution: { estimateUsdPerTurn: 1 },
    });
    const root = await driveToWorking(await newRoot());
    // The raise lands while the task is working — not wakeable, so the signal stays pending.
    const delivery = await deliverSignal(tdb(), {
      taskId: root.taskId,
      kind: 'budget_raised',
      signalKey: 'raise-mid-turn',
      actor: 'user',
    });
    expect(delivery).toEqual({ delivered: true, woke: false });

    // The turn ends in a denied fan-out → blocked(budget_exhausted) → the pending raise absorbs.
    await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: { kind: 'fan_out', children: [{ title: 'C', goal: 'G', owner: 'worker-1' }] },
      budgets,
    });
    const row = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(row[0]?.status).toBe('queued');
    const consumed = await db.$client.unsafe(
      `SELECT consumed_at FROM workforce_task_signals WHERE task_id = '${root.taskId}' AND kind = 'budget_raised';`,
    );
    expect(consumed[0]?.consumed_at).not.toBeNull();
    // The journal shows the task DID pass through the park — absorption is a wake, not a skip.
    const parked = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_transitions WHERE task_id = '${root.taskId}' AND to_status = 'blocked' AND status_reason = 'budget_exhausted';`,
    );
    expect(parked[0]?.c).toBe(1);
  });

  it('a stale manual_unblock does NOT dissolve the fan-out join it arrived alongside', async () => {
    const root = await driveToWorking(await newRoot());
    // The operator's override lands mid-turn — not wakeable while `working`, so it stays pending.
    const delivery = await deliverSignal(tdb(), {
      taskId: root.taskId,
      kind: 'manual_unblock',
      signalKey: 'op-override',
      actor: 'user',
    });
    expect(delivery).toEqual({ delivered: true, woke: false });

    // The turn ends in a fan-out. The parent's park is STRUCTURAL — an override says nothing about
    // whether the children are done, so the same transaction must not absorb the signal into a
    // wake: doing so ran the parent with childResults null and orphaned the children.
    await turn(root.taskId, 1, {
      kind: 'fan_out',
      children: [1, 2].map((i) => ({ title: `S${i}`, goal: `G${i}`, owner: `worker-${i}` })),
    });
    const parked = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(parked[0]).toMatchObject({ status: 'blocked', status_reason: 'awaiting_children' });
    const stillPending = await db.$client.unsafe(
      `SELECT consumed_at FROM workforce_task_signals WHERE task_id = '${root.taskId}' AND kind = 'manual_unblock';`,
    );
    expect(stillPending[0]?.consumed_at).toBeNull();

    // The join is intact: the children finishing is what wakes the parent, with their results.
    const children = (await db.$client.unsafe(
      `SELECT task_id, version FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' ORDER BY task_id;`,
    )) as unknown as { task_id: string; version: number }[];
    for (const c of children) {
      const queued = await applyTransition(tdb(), {
        taskId: c.task_id,
        expectedVersion: c.version,
        to: 'queued',
        actor: 'scheduler',
      });
      await claim(c.task_id, queued.version, 1);
      await turn(c.task_id, 1, { kind: 'complete', result: RESULT });
    }
    const woken = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(woken[0]?.status).toBe('queued');
    const joinSignals = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_signals WHERE task_id = '${root.taskId}' AND kind = 'child_completed';`,
    );
    expect(joinSignals[0]?.c).toBe(1);
  });

  it('a stale manual_unblock does NOT dissolve the escalation park it arrived alongside', async () => {
    const root = await driveToWorking(await newRoot());
    // The operator's override lands mid-turn — not wakeable while `working`, so it stays pending.
    const delivery = await deliverSignal(tdb(), {
      taskId: root.taskId,
      kind: 'manual_unblock',
      signalKey: 'op-override',
      actor: 'user',
    });
    expect(delivery).toEqual({ delivered: true, woke: false });

    // The turn ends by escalating. The park is STRUCTURAL in exactly the fan-out join's sense: its
    // exit is the escalation child's terminal, and the child is already live when the override is
    // absorbed. Dissolving the park here erases that exit — the superior's answer then finds the
    // caller unparked, the binding check drops the reply, and the answer vanishes.
    await turn(root.taskId, 1, { kind: 'escalate', reason: 'risk', escalateTo: 'mgr' });
    const parked = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(parked[0]).toMatchObject({ status: 'blocked', status_reason: 'escalated' });
    const stillPending = await db.$client.unsafe(
      `SELECT consumed_at FROM workforce_task_signals WHERE task_id = '${root.taskId}' AND kind = 'manual_unblock';`,
    );
    expect(stillPending[0]?.consumed_at).toBeNull();

    // The escalation is intact: the superior's answer is what wakes the caller.
    const child = (
      (await db.$client.unsafe(
        `SELECT task_id, version FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
      )) as unknown as { task_id: string; version: number }[]
    )[0] as { task_id: string; version: number };
    const queued = await applyTransition(tdb(), {
      taskId: child.task_id,
      expectedVersion: child.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await claim(child.task_id, queued.version, 1);
    await turn(child.task_id, 1, { kind: 'complete', result: RESULT });
    const woken = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(woken[0]?.status).toBe('queued');
  });

  it('a manual_unblock delivered to an escalation park declines instead of dissolving it', async () => {
    const root = await driveToWorking(await newRoot());
    await turn(root.taskId, 1, { kind: 'escalate', reason: 'risk', escalateTo: 'mgr' });
    // The delivery path matches on the PARK, not the status: an override answers no fact about
    // the escalation child, so it stays pending exactly as it does against a fan-out join.
    const delivery = await deliverSignal(tdb(), {
      taskId: root.taskId,
      kind: 'manual_unblock',
      signalKey: 'op-override',
      actor: 'user',
    });
    expect(delivery).toEqual({ delivered: true, woke: false });
    const held = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(held[0]).toMatchObject({ status: 'blocked', status_reason: 'escalated' });
  });

  it('a wake releases only the park it ANSWERS — a raised ceiling is not a dependency or a decision', async () => {
    const parkedOn = async (reason: 'awaiting_dependency' | 'approval_pending') => {
      const task = await newRoot();
      return applyTransition(tdb(), {
        taskId: task.taskId,
        expectedVersion: task.version,
        to: 'blocked',
        reason,
        actor: 'scheduler',
      });
    };
    const onDependency = await parkedOn('awaiting_dependency');
    const onApproval = await parkedOn('approval_pending');

    for (const parked of [onDependency, onApproval]) {
      const delivery = await deliverSignal(tdb(), {
        taskId: parked.taskId,
        kind: 'budget_raised',
        signalKey: `raise:${parked.taskId}`,
        actor: 'user',
      });
      expect(delivery).toEqual({ delivered: true, woke: false });
      const row = await db.$client.unsafe(
        `SELECT status, status_reason, version FROM workforce_tasks WHERE task_id = '${parked.taskId}';`,
      );
      expect(row[0]).toMatchObject({ status: 'blocked', version: parked.version });
    }

    // The park a raised ceiling DOES answer still wakes, through the same one match.
    const exhausted = await parkedOn('awaiting_dependency');
    const onBudget = await applyTransition(tdb(), {
      taskId: exhausted.taskId,
      expectedVersion: exhausted.version,
      to: 'queued',
      actor: 'scheduler',
    });
    const blocked = await applyTransition(tdb(), {
      taskId: onBudget.taskId,
      expectedVersion: onBudget.version,
      to: 'blocked',
      reason: 'budget_exhausted',
      actor: 'scheduler',
    });
    const woke = await deliverSignal(tdb(), {
      taskId: blocked.taskId,
      kind: 'budget_raised',
      signalKey: 'raise-answered',
      actor: 'user',
    });
    expect(woke).toEqual({ delivered: true, woke: true });
  });

  describe('a budget escalation binds on the park, not just on the status', () => {
    const ESCALATING = workforceBudgetsSchema.parse({
      subtree: { usd: 0.1 },
      execution: { estimateUsdPerTurn: 1, onBudgetExhausted: 'block_and_escalate' },
    });
    const DENIAL = {
      scopeKind: 'root',
      scopeId: 'subtree',
      ceiling: { kind: 'usd', limit: 0.1 },
      consumed: 0.2,
    };

    async function record(tx: TenantDb, taskId: string): Promise<TaskRecord> {
      const rows = (await tx
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.taskId, taskId))) as TaskRecord[];
      return rows[0] as TaskRecord;
    }

    /** Deny a CHILD's dispatch under `block_and_escalate`, holding the caller's locks first. */
    async function denyChild(childTaskId: string): Promise<void> {
      await tdb().transaction(async (tx) => {
        const child = await lockRootFirst(tx, await record(tx, childTaskId));
        await applyBudgetExhausted(tx, child, DENIAL, ESCALATING, { actor: 'system' });
      });
    }

    async function rowOf(taskId: string): Promise<Record<string, unknown>> {
      const rows = await db.$client.unsafe(
        `SELECT status, status_reason, version FROM workforce_tasks WHERE task_id = '${taskId}';`,
      );
      return rows[0] as Record<string, unknown>;
    }

    async function versionOf(taskId: string): Promise<number> {
      return (await rowOf(taskId)).version as number;
    }

    /** Re-park a task that is `blocked` on something else, through the one door. */
    async function reparkThroughAWorkingTurn(taskId: string): Promise<TaskRecord> {
      const queued = await applyTransition(tdb(), {
        taskId,
        expectedVersion: await versionOf(taskId),
        to: 'queued',
        actor: 'scheduler',
      });
      return claim(taskId, queued.version, 2);
    }

    async function deferredEvents(taskId: string): Promise<number> {
      const rows = await db.$client.unsafe(
        `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${taskId}' AND type = 'workforce.budget.escalation_deferred';`,
      );
      return (rows[0] as { c: number }).c;
    }

    /** root -> fan-out -> [c1, c2], parent parked on the join. */
    async function fanOutTwo(): Promise<{ root: TaskRecord; children: string[] }> {
      const root = await driveToWorking(await newRoot());
      await turn(root.taskId, 1, {
        kind: 'fan_out',
        children: [1, 2].map((i) => ({ title: `S${i}`, goal: `G${i}`, owner: `worker-${i}` })),
      });
      const rows = (await db.$client.unsafe(
        `SELECT task_id FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' ORDER BY task_id;`,
      )) as unknown as { task_id: string }[];
      return { root, children: rows.map((r) => r.task_id) };
    }

    it('the fan-out join survives it, and still completes', async () => {
      const { root, children } = await fanOutTwo();
      const parkedBefore = await rowOf(root.taskId);

      // A child's dispatch is denied. Escalating the root here would move it out of
      // `awaiting_children`, and the fan-in would then find no park to answer and never write the
      // join signal at all — the join simply gone, the children orphaned.
      await denyChild(children[0] as string);
      expect(await rowOf(root.taskId)).toEqual(parkedBefore);
      expect(await deferredEvents(root.taskId)).toBe(1);

      // The join still closes: the denied child ends terminal through the cascade, the other
      // completes its turn, and the parent wakes with one signal.
      await cancelTaskCascade(tdb(), { taskId: children[0] as string, actor: 'user' });
      const second = (await db.$client.unsafe(
        `SELECT version FROM workforce_tasks WHERE task_id = '${children[1]}';`,
      )) as unknown as { version: number }[];
      const queued = await applyTransition(tdb(), {
        taskId: children[1] as string,
        expectedVersion: (second[0] as { version: number }).version,
        to: 'queued',
        actor: 'scheduler',
      });
      await claim(children[1] as string, queued.version, 1);
      await turn(children[1] as string, 1, { kind: 'complete', result: RESULT });

      expect((await rowOf(root.taskId)).status).toBe('queued');
      const joinSignals = await db.$client.unsafe(
        `SELECT count(*)::int AS c FROM workforce_task_signals WHERE task_id = '${root.taskId}' AND kind = 'child_completed';`,
      );
      expect(joinSignals[0]?.c).toBe(1);
    });

    it('a dependency park survives it, and the dependency wake still answers it', async () => {
      const { root, children } = await fanOutTwo();
      // Re-park the root on a DEPENDENCY: its exit is the scheduler's wake scan, whose predicate is
      // the park itself — an escalation out of it leaves that predicate forever.
      const working = await reparkThroughAWorkingTurn(root.taskId);
      await applyTransition(tdb(), {
        taskId: root.taskId,
        expectedVersion: working.version,
        to: 'blocked',
        reason: 'awaiting_dependency',
        actor: 'scheduler',
      });
      const parkedBefore = await rowOf(root.taskId);

      await denyChild(children[0] as string);
      expect(await rowOf(root.taskId)).toEqual(parkedBefore);
      expect(await deferredEvents(root.taskId)).toBe(1);

      const woke = await deliverSignal(tdb(), {
        taskId: root.taskId,
        kind: 'dependency_completed',
        signalKey: `deps:${root.taskId}`,
        actor: 'scheduler',
      });
      expect(woke).toEqual({ delivered: true, woke: true });
    });

    it('a review park survives it, and the verdict still decides the task', async () => {
      const { root, children } = await fanOutTwo();
      const w = await reparkThroughAWorkingTurn(root.taskId);
      await applyTurnOutcome(tdb(), {
        taskId: root.taskId,
        turnId: turnIdFor(root.taskId, 2),
        turnNumber: 2,
        intent: { kind: 'request_review', reviewer: 'reviewer-1' },
        budgets: NO_BUDGETS,
      });
      expect(w.status).toBe('working');
      const parkedBefore = await rowOf(root.taskId);
      expect(parkedBefore).toMatchObject({
        status: 'waiting_for_review',
        status_reason: 'review_pending',
      });

      // The verdict route refuses any task outside `waiting_for_review`, so an escalation here
      // leaves the review permanently undecidable.
      await denyChild(children[0] as string);
      expect(await rowOf(root.taskId)).toEqual(parkedBefore);
      expect(await deferredEvents(root.taskId)).toBe(1);

      const review = (await db.$client.unsafe(
        `SELECT id FROM workforce_reviews WHERE task_id = '${root.taskId}';`,
      )) as unknown as { id: string }[];
      const accepted = await applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review[0]?.id as string,
        verdict: 'accept',
        actor: 'reviewer-1',
      });
      expect(accepted.status).toBe('completed');
    });

    it('an approval park survives it, and the decision still wakes the task', async () => {
      const { root, children } = await fanOutTwo();
      const w = await reparkThroughAWorkingTurn(root.taskId);
      await applyTurnOutcome(tdb(), {
        taskId: root.taskId,
        turnId: turnIdFor(root.taskId, 2),
        turnNumber: 2,
        intent: { kind: 'request_approval', question: 'Proceed?', timeoutMs: 60_000 },
        budgets: NO_BUDGETS,
      });
      expect(w.status).toBe('working');
      const parkedBefore = await rowOf(root.taskId);

      await denyChild(children[0] as string);
      expect(await rowOf(root.taskId)).toEqual(parkedBefore);
      expect(await deferredEvents(root.taskId)).toBe(1);

      const approvals = (await db.$client.unsafe(
        `SELECT id FROM workforce_approvals WHERE task_id = '${root.taskId}';`,
      )) as unknown as { id: string }[];
      await decideApproval(tdb(), {
        approvalId: approvals[0]?.id as string,
        decision: 'approve',
        decidedBy: 'user',
      });
      expect((await rowOf(root.taskId)).status).toBe('queued');
    });

    it('an escalation park survives it, and the escalation child still answers it', async () => {
      const { root, children } = await fanOutTwo();
      const w = await reparkThroughAWorkingTurn(root.taskId);
      await applyTurnOutcome(tdb(), {
        taskId: root.taskId,
        turnId: turnIdFor(root.taskId, 2),
        turnNumber: 2,
        intent: { kind: 'escalate', reason: 'risk', escalateTo: 'mgr' },
        budgets: NO_BUDGETS,
      });
      expect(w.status).toBe('working');
      const parkedBefore = await rowOf(root.taskId);
      expect(parkedBefore).toMatchObject({ status: 'blocked', status_reason: 'escalated' });

      // The escalation park's exit is its OWN child's terminal, bound on the caller's row. Moving
      // the caller out of it erases that exit: the child's fan-in finds no matching park, the
      // binding check drops the reply, and the superior's answer is lost with nothing journalled.
      await denyChild(children[0] as string);
      expect(await rowOf(root.taskId)).toEqual(parkedBefore);
      expect(await deferredEvents(root.taskId)).toBe(1);

      const escalation = (
        (await db.$client.unsafe(
          `SELECT task_id, version FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' AND owner = 'mgr';`,
        )) as unknown as { task_id: string; version: number }[]
      )[0] as { task_id: string; version: number };
      const queued = await applyTransition(tdb(), {
        taskId: escalation.task_id,
        expectedVersion: escalation.version,
        to: 'queued',
        actor: 'scheduler',
      });
      await claim(escalation.task_id, queued.version, 1);
      await turn(escalation.task_id, 1, { kind: 'complete', result: RESULT });
      expect((await rowOf(root.taskId)).status).toBe('queued');
    });

    it('a clarification park survives it, and the reply still wakes the task', async () => {
      const { root, children } = await fanOutTwo();
      const w = await reparkThroughAWorkingTurn(root.taskId);
      await applyTurnOutcome(tdb(), {
        taskId: root.taskId,
        turnId: turnIdFor(root.taskId, 2),
        turnNumber: 2,
        intent: { kind: 'request_clarification', question: 'Which region?' },
        budgets: NO_BUDGETS,
      });
      expect(w.status).toBe('working');
      const parkedBefore = await rowOf(root.taskId);
      expect(parkedBefore).toMatchObject({
        status: 'blocked',
        status_reason: 'clarification_pending',
      });

      // The clarification park's exit is the `user_reply` keyed to the question that was asked.
      // An escalation out of it leaves that reply with no park to answer — it is refused on
      // delivery and stays pending forever, while the question is never asked again.
      await denyChild(children[0] as string);
      expect(await rowOf(root.taskId)).toEqual(parkedBefore);
      expect(await deferredEvents(root.taskId)).toBe(1);

      const woke = await deliverSignal(tdb(), {
        taskId: root.taskId,
        kind: 'user_reply',
        signalKey: `reply:${root.taskId}`,
        actor: 'user',
      });
      expect(woke).toEqual({ delivered: true, woke: true });
    });

    it('a SELF escalation hands back the row the escalation left, not the pre-escalation one', async () => {
      const root = await driveToWorking(await newRoot());
      // A pending operator override the turn boundary would absorb if it read a stale `blocked`.
      await deliverSignal(tdb(), {
        taskId: root.taskId,
        kind: 'manual_unblock',
        signalKey: 'op-override',
        actor: 'user',
      });
      // root == task: the denial blocks it AND escalates it in one transaction. Reporting the
      // pre-escalation row made the follow-up absorption present a spent version, and the whole
      // turn transaction aborted on the conflict — every re-execution the same way.
      const out = await applyTurnOutcome(tdb(), {
        taskId: root.taskId,
        turnId: turnIdFor(root.taskId, 1),
        turnNumber: 1,
        intent: { kind: 'fan_out', children: [{ title: 'C', goal: 'G', owner: 'worker-1' }] },
        budgets: ESCALATING,
      });
      expect(out.task?.status).toBe('waiting_for_user');
      expect((await rowOf(root.taskId)).version).toBe(out.task?.version);
    });
  });

  it('a turn applies only over its OWN claim — a stale body cannot overwrite the successor', async () => {
    const root = await driveToWorking(await newRoot());
    // The reaper believes this turn is dead and re-queues it; a fresh dispatch claims the same turn
    // number under a NEW id. The first body was never actually stopped.
    const requeued = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      reason: 'tool_error',
      actor: 'scheduler',
      queueReason: 'turn_reaped',
    });
    await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: requeued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: 'wf-task-turn:successor',
    });

    // The stale body arrives with its own (now superseded) claim id.
    await expect(
      applyTurnOutcome(tdb(), {
        taskId: root.taskId,
        turnId: turnIdFor(root.taskId, 1),
        turnNumber: 1,
        intent: { kind: 'complete', result: RESULT },
        budgets: NO_BUDGETS,
      }),
    ).rejects.toThrow(TurnStateError);
    const untouched = await db.$client.unsafe(
      `SELECT status, turns_used FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(untouched[0]).toMatchObject({ status: 'working', turns_used: 0 });

    // The successor, presenting the claim it actually holds, applies.
    const applied = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: 'wf-task-turn:successor',
      turnNumber: 1,
      intent: { kind: 'complete', result: RESULT },
      budgets: NO_BUDGETS,
    });
    expect(applied.task?.status).toBe('completed');
  });

  it('a manual_unblock declines a deadline park instead of livelocking against it', async () => {
    const root = await newRoot();
    const queued = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });
    const parked = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: queued.version,
      to: 'blocked',
      reason: 'deadline_exceeded',
      actor: 'scheduler',
    });

    // The deadline is an absolute fact on the row: waking the task only lets the next reserve pass
    // re-park it against the same instant, journaling a fresh park every tick forever.
    const delivery = await deliverSignal(tdb(), {
      taskId: root.taskId,
      kind: 'manual_unblock',
      signalKey: 'op-unblock',
      actor: 'user',
    });
    expect(delivery).toEqual({ delivered: true, woke: false });
    const row = await db.$client.unsafe(
      `SELECT status, status_reason, version FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect(row[0]).toMatchObject({
      status: 'blocked',
      status_reason: 'deadline_exceeded',
      version: parked.version,
    });
  });

  it('cancel cascades root-first; a working descendant is signalled, never killed', async () => {
    const root = await driveToWorking(await newRoot());
    await turn(root.taskId, 1, {
      kind: 'fan_out',
      children: [1, 2].map((i) => ({ title: `S${i}`, goal: `G${i}`, owner: `worker-${i}` })),
    });
    const children = (await db.$client.unsafe(
      `SELECT task_id, version FROM workforce_tasks WHERE parent_task_id = '${root.taskId}' ORDER BY task_id;`,
    )) as unknown as { task_id: string; version: number }[];
    // Put child[0] mid-turn (working); leave child[1] planned.
    const c0 = children[0] as { task_id: string; version: number };
    const q0 = await applyTransition(tdb(), {
      taskId: c0.task_id,
      expectedVersion: c0.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await claim(c0.task_id, q0.version, 1);

    const outcome = await cancelTaskCascade(tdb(), { taskId: root.taskId, actor: 'user' });
    expect(outcome.cancelled).toContain(root.taskId);
    expect(outcome.cancelled).toContain((children[1] as { task_id: string }).task_id);
    expect(outcome.signalled).toContain(c0.task_id);

    const c0row = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${c0.task_id}';`,
    );
    expect(c0row[0]?.status).toBe('working'); // still mid-turn — nothing killed

    // The working child's own turn end absorbs the cancel and its outcome IS the cancellation.
    const absorbed = await turn(c0.task_id, 1, { kind: 'complete', result: RESULT });
    expect(absorbed.plan?.kind).toBe('cancelled');
    const c0after = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${c0.task_id}';`,
    );
    expect(c0after[0]).toMatchObject({ status: 'cancelled', status_reason: 'cancelled_by_user' });
  });
});
