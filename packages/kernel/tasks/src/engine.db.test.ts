/**
 * The engine's turn-application, fan-out/fan-in, approval, review, and cancellation flows against
 * real Postgres — whole invariants on durable artifacts, no fakes. The receipts suite is the
 * restart story's kernel: re-applying a committed turn changes nothing and duplicates nothing.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTurnOutcome } from './apply-intents.js';
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

  async function driveToWorking(task: TaskRecord): Promise<TaskRecord> {
    const queued = await applyTransition(tdb(), {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'queued',
      actor: 'scheduler',
    });
    return applyTransition(tdb(), {
      taskId: task.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
    });
  }

  function turn(taskId: string, turnNumber: number, intent: unknown, actualUsd = 0) {
    return applyTurnOutcome(tdb(), {
      taskId,
      turnId: `wf-task-turn:${taskId}:${turnNumber}`,
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

    const replay = await turn(root.taskId, 1, intent);
    expect(replay.alreadyApplied).toBe(true);
    const stillFour = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    );
    expect(stillFour[0]?.c).toBe(4);
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
      await applyTransition(tdb(), {
        taskId: c.task_id,
        expectedVersion: queued.version,
        to: 'working',
        actor: 'scheduler',
      });
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
        turnId: `wf-task-turn:${root.taskId}:${turnNumber}`,
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
    await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: rejected.version,
      to: 'working',
      actor: 'scheduler',
    });
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
  });

  it('delegation rejections record typed rows and follow the one-retry fate', async () => {
    const budgets = workforceBudgetsSchema.parse({ delegation: { maxDepth: 1 } });
    const root = await driveToWorking(await newRoot());
    // Root fans out fine (depth 1)…
    const ok = await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: `wf-task-turn:${root.taskId}:1`,
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
    await applyTransition(tdb(), {
      taskId: child.task_id,
      expectedVersion: q.version,
      to: 'working',
      actor: 'scheduler',
    });
    const grandchildIntent = {
      kind: 'fan_out',
      children: [{ title: 'GC', goal: 'G', owner: 'worker-2' }],
    };
    const rejected = await applyTurnOutcome(tdb(), {
      taskId: child.task_id,
      turnId: `wf-task-turn:${child.task_id}:1`,
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
    await applyTransition(tdb(), {
      taskId: child.task_id,
      expectedVersion: (rejected.task as TaskRecord).version,
      to: 'working',
      actor: 'scheduler',
    });
    const failed = await applyTurnOutcome(tdb(), {
      taskId: child.task_id,
      turnId: `wf-task-turn:${child.task_id}:2`,
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
    await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: (first.task as TaskRecord).version,
      to: 'working',
      actor: 'scheduler',
    });
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
      turnId: `wf-task-turn:${root.taskId}:1`,
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
        await applyTransition(tdb(), {
          taskId: c.task_id,
          expectedVersion: queued.version,
          to: 'working',
          actor: 'scheduler',
        });
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
    await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: (parent[0] as { version: number }).version,
      to: 'working',
      actor: 'scheduler',
    });
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
      turnId: `wf-task-turn:${root.taskId}:1`,
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
      await applyTransition(tdb(), {
        taskId: c.task_id,
        expectedVersion: queued.version,
        to: 'working',
        actor: 'scheduler',
      });
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
    await applyTransition(tdb(), {
      taskId: c0.task_id,
      expectedVersion: q0.version,
      to: 'working',
      actor: 'scheduler',
    });

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
