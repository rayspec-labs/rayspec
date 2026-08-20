/**
 * THE APPROVAL GATE against real Postgres — a declared `approvalPolicies` rule INTERCEPTING a
 * completion, at BOTH of the two sites a worked task can reach `completed`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY BOTH, and why either alone would be a false green.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A worked task completes at exactly two sites: the planner's `case 'complete'` (apply-intents.ts)
 * and a review verdict's `accept` (reviews.ts), which never re-enters the planner. A matched review
 * policy DIVERTS every completion from the first to the second. So a gate written only into the
 * planner passes every test anyone would naturally write while leaving every review-covered seat
 * ungated — and, because a review rule may trigger on `confidenceBelow` (a number the submitting
 * turn writes about ITSELF), a seat under both policies would pick whether it is gated by picking a
 * number. `examples/workforce-maintainers/rayspec.yaml` already declares that seat.
 *
 * The suite therefore drives ONE seat under BOTH policies at BOTH sides of the review trigger and
 * requires the SAME park at each. The confidence fork itself is matched at the composition seam,
 * which is roster-aware and lives in another package: `@rayspec/workforce-tools`'s
 * `approval-gate-match.test.ts` proves that the review match MOVES with the self-reported number
 * while the approval match does NOT, on the shipped example. This suite proves the other half —
 * that both resulting channel combinations reach the approval park. **Neither is sufficient
 * alone**, and each header says so.
 *
 * This engine package is deliberately roster-free, so the "policy matched" fact arrives here on the
 * trusted channels (`reviewPolicy`, `approvalPolicy`) exactly as the composition supplies it.
 */
import { schema } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTurnOutcome } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { type ApprovalRecord, decideApproval, sweepApprovalTimeouts } from './approvals.js';
import { workforceBudgetsSchema } from './budget.js';
import { createRootTask } from './create-task.js';
import { joinPolicySchema } from './join.js';
import { applyReviewVerdict, type ReviewRecord } from './reviews.js';
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
    'approval-binding.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

const NO_BUDGETS = workforceBudgetsSchema.parse({});

/** The trusted approval channel, shaped as the composition builds it from a matched rule. */
const GATE = {
  id: 'public_statement_signoff',
  approver: 'user',
  timeoutMs: 86_400_000,
  onTimeout: 'fail',
} as const;

const GATE_FAIL = { ...GATE, escalateTo: null };
const GATE_ESCALATE = { ...GATE, onTimeout: 'escalate', escalateTo: 'lead' } as const;

/** The trusted review channel — the `docs_quality` rule as the composition would hand it over. */
const REVIEW = { reviewer: 'senior_reviewer', dispatchReviewer: false, maxRounds: 3 } as const;

const RESULT = (confidence: number) => ({
  status: 'completed' as const,
  summary: 'Release note drafted.',
  findings: ['the API changed'],
  recommendations: [],
  artifacts: [],
  confidence,
  needsFollowUp: false,
});

describe.skipIf(!hasDb)('a declared approval policy BINDS (db)', () => {
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
  const turnIdFor = (taskId: string, n: number) => `wf-task-turn:${taskId}:${n}`;

  async function freshTask(over: { owner?: string; parentTaskId?: string } = {}) {
    return createRootTask(tdb(), {
      workforceId: 'wf',
      title: 'Release note',
      goal: 'Draft the public release note.',
      owner: over.owner ?? 'mgr_docs',
      requestedBy: 'user',
    });
  }

  /** Drive a task into `working` under turn `n` so its outcome can be applied. */
  async function toWorking(task: TaskRecord, n: number): Promise<void> {
    const rows = (await tdb()
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.taskId, task.taskId))) as TaskRecord[];
    const current = rows[0] as TaskRecord;
    const queued =
      current.status === 'queued'
        ? current
        : await applyTransition(tdb(), {
            taskId: task.taskId,
            expectedVersion: current.version,
            to: 'queued',
            actor: 'scheduler',
          });
    await applyTransition(tdb(), {
      taskId: task.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(task.taskId, n),
    });
  }

  const approvalsOf = async (taskId: string): Promise<ApprovalRecord[]> =>
    (await tdb()
      .select(schema.workforceApprovals)
      .where(eq(schema.workforceApprovals.taskId, taskId))) as ApprovalRecord[];

  const reviewsOf = async (taskId: string): Promise<ReviewRecord[]> =>
    (await tdb()
      .select(schema.workforceReviews)
      .where(eq(schema.workforceReviews.taskId, taskId))) as ReviewRecord[];

  const read = async (taskId: string): Promise<TaskRecord> => {
    const rows = (await tdb()
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.taskId, taskId))) as TaskRecord[];
    const row = rows[0];
    if (!row) throw new Error(`task ${taskId} vanished`);
    return row;
  };

  const eventCount = async (taskId: string, type: string): Promise<number> => {
    const rows = await db.$client.unsafe(
      `SELECT count(*)::int AS n FROM run_events WHERE run_id = '${taskId}' AND type = '${type}';`,
    );
    return (rows[0] as { n: number }).n;
  };

  /**
   * CHOKEPOINT A: a covered seat completes with no review policy matched. Returns the parked task
   * and its gate approval.
   */
  async function gatedAtChokepointA(
    gate: typeof GATE_FAIL | typeof GATE_ESCALATE = GATE_FAIL,
    confidence = 0.9,
  ) {
    const task = await freshTask();
    await toWorking(task, 1);
    const applied = await applyTurnOutcome(tdb(), {
      taskId: task.taskId,
      turnId: turnIdFor(task.taskId, 1),
      turnNumber: 1,
      intent: { kind: 'complete', result: RESULT(confidence) },
      approvalPolicy: gate,
      budgets: NO_BUDGETS,
    });
    const approvals = await approvalsOf(task.taskId);
    return { task, applied, approval: approvals[0] as ApprovalRecord };
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  describe('CHOKEPOINT A — the planner’s complete intent', () => {
    it('THE DEFECT IS CLOSED: a covered completion parks instead of completing', async () => {
      const { task, applied } = await gatedAtChokepointA();
      expect(applied.plan?.kind).toBe('complete_with_approval');
      const row = await read(task.taskId);
      expect(row.status).toBe('blocked');
      expect(row.statusReason).toBe('approval_pending');
      // The observed defect, inverted: a labelled seat completed its labelled task and
      // `select count(*) from workforce_approvals` returned 0.
      expect((await approvalsOf(task.taskId)).length).toBe(1);
    });

    it('the RESULT IS STORED on the row — the human authorises bytes that already exist', async () => {
      const { task } = await gatedAtChokepointA();
      const row = await read(task.taskId);
      expect((row.result as { summary: string }).summary).toBe('Release note drafted.');
      expect(row.confidence).toBe('0.9');
    });

    it('the approval row carries the DECLARED window, fate and approver', async () => {
      const { approval } = await gatedAtChokepointA();
      expect(approval.status).toBe('pending');
      expect(approval.approver).toBe('user');
      expect(approval.onTimeout).toBe('fail');
      expect(approval.turnNumber).toBe(1);
      expect(approval.question).toContain('public_statement_signoff');
      // The question carries NO model-authored text — not the summary, not the title.
      expect(approval.question).not.toContain('Release note drafted.');
    });

    it('the park BINDS the one approval that may release it', async () => {
      const { task, approval } = await gatedAtChokepointA();
      const binding = joinPolicySchema.parse((await read(task.taskId)).joinPolicy);
      expect(binding).toEqual({ policy: 'approval', approvalId: approval.id });
    });

    it('the journal names the POLICY that gated it, under the existing event type', async () => {
      const { task } = await gatedAtChokepointA();
      expect(await eventCount(task.taskId, 'workforce.approval.requested')).toBe(1);
      const rows = await db.$client.unsafe(
        `SELECT data FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.approval.requested';`,
      );
      // `data` is `{ v, type, ...payload }` — the payload fields are merged in flat (events.ts).
      const data = (rows[0] as { data: Record<string, unknown> }).data;
      expect(data.policy).toBe(true);
      expect(data.policyId).toBe('public_statement_signoff');
      expect(data.approver).toBe('user');
      expect(data.onTimeout).toBe('fail');
    });

    it('NO declared rule still completes — the gate is opt-in by declaration', async () => {
      const task = await freshTask();
      await toWorking(task, 1);
      const applied = await applyTurnOutcome(tdb(), {
        taskId: task.taskId,
        turnId: turnIdFor(task.taskId, 1),
        turnNumber: 1,
        intent: { kind: 'complete', result: RESULT(0.9) },
        budgets: NO_BUDGETS,
      });
      expect(applied.plan?.kind).toBe('complete');
      expect((await read(task.taskId)).status).toBe('completed');
      expect((await approvalsOf(task.taskId)).length).toBe(0);
    });

    it('a REPLAY of the same turn is a no-op — one approval, not two', async () => {
      const { task, approval } = await gatedAtChokepointA();
      const replay = await applyTurnOutcome(tdb(), {
        taskId: task.taskId,
        turnId: turnIdFor(task.taskId, 1),
        turnNumber: 1,
        intent: { kind: 'complete', result: RESULT(0.9) },
        approvalPolicy: GATE_FAIL,
        budgets: NO_BUDGETS,
      });
      expect(replay.alreadyApplied).toBe(true);
      const approvals = await approvalsOf(task.taskId);
      expect(approvals.length).toBe(1);
      expect(approvals[0]?.id).toBe(approval.id);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  describe('THE RELEASE — what a human decision does to a gated park', () => {
    it('approve COMPLETES the task, with the stored result intact and no re-dispatch', async () => {
      const { task, approval } = await gatedAtChokepointA();
      await decideApproval(tdb(), {
        approvalId: approval.id,
        decision: 'approve',
        decidedBy: 'user:00000000-0000-4000-8000-0000000000ff',
      });
      const row = await read(task.taskId);
      expect(row.status).toBe('completed');
      expect((row.result as { summary: string }).summary).toBe('Release note drafted.');
      // NOT RE-DISPATCHED. The seat already finished and the human authorised exactly these bytes;
      // re-running it would re-spend budget and could produce a different result than the one that
      // was signed off. A status check alone cannot see that — a re-queued task that then completed
      // would read `completed` too. So the claim is asserted as the EDGE that must not exist: the
      // gate park was never left through `queued`. (Order-independent on purpose: the transitions
      // table's primary key is a random uuid, so `ORDER BY id` is not insertion order.)
      const outOfPark = await db.$client.unsafe(
        `SELECT count(*)::int AS n FROM workforce_task_transitions
           WHERE task_id = '${task.taskId}' AND from_status = 'blocked' AND to_status = 'queued';`,
      );
      expect((outOfPark[0] as { n: number }).n).toBe(0);
      const released = await db.$client.unsafe(
        `SELECT count(*)::int AS n FROM workforce_task_transitions
           WHERE task_id = '${task.taskId}' AND from_status = 'blocked' AND to_status = 'completed';`,
      );
      expect((released[0] as { n: number }).n).toBe(1);
      // And the seat spent exactly the one turn it took to produce the result.
      expect(row.turnsUsed).toBe(1);
    });

    it('reject parks in waiting_for_user (reasonless) and keeps the stored result', async () => {
      const { task, approval } = await gatedAtChokepointA();
      await decideApproval(tdb(), {
        approvalId: approval.id,
        decision: 'reject',
        decidedBy: 'user:00000000-0000-4000-8000-0000000000ff',
        reason: 'legal has not cleared the wording',
      });
      const row = await read(task.taskId);
      expect(row.status).toBe('waiting_for_user');
      expect(row.statusReason).toBeNull();
      expect((row.result as { summary: string }).summary).toBe('Release note drafted.');
      // NO second approval is opened — a rejection is a decision, not a re-ask.
      expect((await approvalsOf(task.taskId)).length).toBe(1);
      expect((await approvalsOf(task.taskId))[0]?.status).toBe('rejected');
    });

    it('a rejected park is released by user_reply, and by NOTHING the approval path sends', async () => {
      const { task, approval } = await gatedAtChokepointA();
      await decideApproval(tdb(), {
        approvalId: approval.id,
        decision: 'reject',
        decidedBy: 'user:00000000-0000-4000-8000-0000000000ff',
      });
      // The decision's own `approval_decided` signal must NOT have woken it: the reasonless park is
      // not an approval park, and a park is released by what ANSWERS it.
      expect((await read(task.taskId)).status).toBe('waiting_for_user');
      const woke = await deliverSignal(tdb(), {
        taskId: task.taskId,
        kind: 'user_reply',
        signalKey: `reply:${task.taskId}:1`,
        payload: { body: 'reworded — try again' },
        actor: 'user',
      });
      expect(woke.woke).toBe(true);
      expect((await read(task.taskId)).status).toBe('queued');
    });

    it('an approval the park does NOT name releases nothing — fail-closed on the binding', async () => {
      // A second, unrelated approval on the same task (the shape a seat's own `request_approval`
      // would leave behind). Deciding it must not complete work the park is holding for a
      // different decision.
      const { task, approval } = await gatedAtChokepointA();
      const inserted = (await tdb()
        .insert(schema.workforceApprovals, {
          taskId: task.taskId,
          question: 'Something else entirely?',
          options: [],
          approver: 'user',
          status: 'pending',
          timeoutAt: new Date(Date.now() + 3_600_000),
          onTimeout: 'fail',
          escalateTo: null,
          turnNumber: null,
        })
        .returning({ id: schema.workforceApprovals.id })) as { id: string }[];
      const other = inserted[0] as { id: string };
      await decideApproval(tdb(), {
        approvalId: other.id,
        decision: 'approve',
        decidedBy: 'user:00000000-0000-4000-8000-0000000000ff',
      });
      const row = await read(task.taskId);
      // Not completed. The wake set DOES cover this park, so the ordinary path re-queues it —
      // which is the pre-existing behaviour of an approval decision, and is not a release.
      expect(row.status).not.toBe('completed');
      const gate = (await approvalsOf(task.taskId)).find((a) => a.id === approval.id);
      expect(gate?.status).toBe('pending');
    });

    it('a released gate fans in to a waiting parent — the completion is a real terminal', async () => {
      const parent = await createRootTask(tdb(), {
        workforceId: 'wf',
        title: 'Ship the release',
        goal: 'Coordinate the release.',
        owner: 'lead',
        requestedBy: 'user',
      });
      await toWorking(parent, 1);
      const fannedOut = await applyTurnOutcome(tdb(), {
        taskId: parent.taskId,
        turnId: turnIdFor(parent.taskId, 1),
        turnNumber: 1,
        intent: {
          kind: 'fan_out',
          children: [{ title: 'Release note', goal: 'Draft it.', owner: 'mgr_docs' }],
        },
        budgets: NO_BUDGETS,
      });
      expect(fannedOut.task?.status).toBe('blocked');
      const children = (await tdb()
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.parentTaskId, parent.taskId))) as TaskRecord[];
      const child = children[0] as TaskRecord;
      await toWorking(child, 1);
      await applyTurnOutcome(tdb(), {
        taskId: child.taskId,
        turnId: turnIdFor(child.taskId, 1),
        turnNumber: 1,
        intent: { kind: 'complete', result: RESULT(0.9) },
        approvalPolicy: GATE_FAIL,
        budgets: NO_BUDGETS,
      });
      expect((await read(child.taskId)).status).toBe('blocked');
      // The parent is still correctly waiting — a gated child has NOT ended.
      expect((await read(parent.taskId)).status).toBe('blocked');
      const gate = (await approvalsOf(child.taskId))[0] as ApprovalRecord;
      await decideApproval(tdb(), {
        approvalId: gate.id,
        decision: 'approve',
        decidedBy: 'user:00000000-0000-4000-8000-0000000000ff',
      });
      expect((await read(child.taskId)).status).toBe('completed');
      expect((await read(parent.taskId)).status).toBe('queued');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  describe('CHOKEPOINT B — the review verdict, which never re-enters the planner', () => {
    /** One seat, BOTH policies, a confidence BELOW the review trigger: review park first. */
    async function gatedThroughReview(confidence = 0.5) {
      const task = await freshTask();
      await toWorking(task, 1);
      const applied = await applyTurnOutcome(tdb(), {
        taskId: task.taskId,
        turnId: turnIdFor(task.taskId, 1),
        turnNumber: 1,
        intent: { kind: 'complete', result: RESULT(confidence) },
        reviewPolicy: REVIEW,
        approvalPolicy: GATE_FAIL,
        budgets: NO_BUDGETS,
      });
      expect(applied.plan?.kind).toBe('complete_with_review');
      expect((await read(task.taskId)).status).toBe('waiting_for_review');
      const review = (await reviewsOf(task.taskId))[0] as ReviewRecord;
      return { task, review };
    }

    it('the review park CARRIES the gate — the only channel a roster-free verdict path has', async () => {
      const { task } = await gatedThroughReview();
      const binding = joinPolicySchema.parse((await read(task.taskId)).joinPolicy);
      expect(binding.policy).toBe('review');
      expect(binding.approvalGate).toEqual(GATE_FAIL);
    });

    it('THE HOLE IS CLOSED: an accept verdict opens the approval instead of completing', async () => {
      const { task, review } = await gatedThroughReview();
      const after = await applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'accept',
        reasons: [],
        requiredChanges: [],
        actor: 'user:senior_reviewer',
      });
      expect(after.status).toBe('blocked');
      expect(after.statusReason).toBe('approval_pending');
      const approvals = await approvalsOf(task.taskId);
      expect(approvals.length).toBe(1);
      // Turn-less: there is no turn on the verdict route, and stamping the reviewer's own turn
      // number onto the reviewed task's approval would collide with that task's receipt key.
      expect(approvals[0]?.turnNumber).toBeNull();
      // The park re-binds from the review it has resolved to the approval it now waits on.
      const binding = joinPolicySchema.parse((await read(task.taskId)).joinPolicy);
      expect(binding).toEqual({ policy: 'approval', approvalId: approvals[0]?.id });
    });

    it('and the human then releases it — review first, approval second, end to end', async () => {
      const { task, review } = await gatedThroughReview();
      await applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'accept',
        reasons: [],
        requiredChanges: [],
        actor: 'user:senior_reviewer',
      });
      const gate = (await approvalsOf(task.taskId))[0] as ApprovalRecord;
      await decideApproval(tdb(), {
        approvalId: gate.id,
        decision: 'approve',
        decidedBy: 'user:00000000-0000-4000-8000-0000000000ff',
      });
      const row = await read(task.taskId);
      expect(row.status).toBe('completed');
      expect((row.result as { confidence?: unknown; summary: string }).summary).toBe(
        'Release note drafted.',
      );
    });

    it('a REJECT verdict still reworks — the gate does not touch the un-completing paths', async () => {
      const { task, review } = await gatedThroughReview();
      const after = await applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'reject',
        reasons: ['thin'],
        requiredChanges: ['cite the changelog'],
        actor: 'user:senior_reviewer',
      });
      expect(after.status).toBe('queued');
      expect((await approvalsOf(task.taskId)).length).toBe(0);
    });

    it('an un-gated review park still completes on accept — no regression', async () => {
      const task = await freshTask();
      await toWorking(task, 1);
      await applyTurnOutcome(tdb(), {
        taskId: task.taskId,
        turnId: turnIdFor(task.taskId, 1),
        turnNumber: 1,
        intent: { kind: 'complete', result: RESULT(0.5) },
        reviewPolicy: REVIEW,
        budgets: NO_BUDGETS,
      });
      const review = (await reviewsOf(task.taskId))[0] as ReviewRecord;
      const after = await applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'accept',
        reasons: [],
        requiredChanges: [],
        actor: 'user:senior_reviewer',
      });
      expect(after.status).toBe('completed');
      expect((await approvalsOf(task.taskId)).length).toBe(0);
    });

    it('a MODEL-INITIATED request_review by a covered seat is gated too', async () => {
      // The third park-binding site. Without the gate on this binding a covered seat could escape
      // its declared approval simply by asking for a review of its own work.
      const task = await freshTask();
      await toWorking(task, 1);
      await applyTurnOutcome(tdb(), {
        taskId: task.taskId,
        turnId: turnIdFor(task.taskId, 1),
        turnNumber: 1,
        intent: { kind: 'request_review', reviewer: 'senior_reviewer' },
        approvalPolicy: GATE_FAIL,
        budgets: NO_BUDGETS,
      });
      expect((await read(task.taskId)).status).toBe('waiting_for_review');
      const review = (await reviewsOf(task.taskId))[0] as ReviewRecord;
      const after = await applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'accept',
        reasons: [],
        requiredChanges: [],
        actor: 'user:senior_reviewer',
      });
      expect(after.status).toBe('blocked');
      expect(after.statusReason).toBe('approval_pending');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  describe('BOTH CHOKEPOINTS, ONE SEAT — the confidence fork buys nothing', () => {
    it('above AND below the review trigger, the same seat reaches the same approval park', async () => {
      // The seat's own self-report picks WHICH chokepoint it faces. It must not pick WHETHER it is
      // gated. `approval-gate-match.test.ts` (@rayspec/workforce-tools) proves the fork itself
      // against the shipped maintainers example: at 0.9 `docs_quality` does not fire and at 0.5 it
      // does, while `matchApprovalRule` returns the identical rule at both. Here we drive the two
      // resulting channel combinations and require one outcome.
      const above = await freshTask();
      await toWorking(above, 1);
      await applyTurnOutcome(tdb(), {
        taskId: above.taskId,
        turnId: turnIdFor(above.taskId, 1),
        turnNumber: 1,
        // confidence 0.9 — no review rule fires, so no review channel is supplied.
        intent: { kind: 'complete', result: RESULT(0.9) },
        approvalPolicy: GATE_FAIL,
        budgets: NO_BUDGETS,
      });

      const below = await freshTask();
      await toWorking(below, 1);
      await applyTurnOutcome(tdb(), {
        taskId: below.taskId,
        turnId: turnIdFor(below.taskId, 1),
        turnNumber: 1,
        // confidence 0.5 — `confidenceBelow: 0.85` fires, so the review channel IS supplied.
        intent: { kind: 'complete', result: RESULT(0.5) },
        reviewPolicy: REVIEW,
        approvalPolicy: GATE_FAIL,
        budgets: NO_BUDGETS,
      });
      const review = (await reviewsOf(below.taskId))[0] as ReviewRecord;
      await applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'accept',
        reasons: [],
        requiredChanges: [],
        actor: 'user:senior_reviewer',
      });

      for (const [label, task] of [
        ['confidence 0.9 (chokepoint A)', above],
        ['confidence 0.5 (chokepoint B)', below],
      ] as const) {
        const row = await read(task.taskId);
        expect(row.status, label).toBe('blocked');
        expect(row.statusReason, label).toBe('approval_pending');
        expect((await approvalsOf(task.taskId)).length, label).toBe(1);
        const binding = joinPolicySchema.parse(row.joinPolicy);
        expect(binding.policy, label).toBe('approval');
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  describe('THE TIMEOUT SWEEP over a gated park', () => {
    it("onTimeout 'fail' DESTROYS THE RELEASE of finished work — pinned, because the word did not change and its price did", async () => {
      // On a `request_approval` the task had produced nothing and `fail` cost an unanswered
      // question. Here it costs a completed work product. Fail-closed is the right posture — a
      // release nobody authorised does not ship — but an operator declaring `onTimeout: fail` on an
      // approval POLICY is declaring something more expensive than the same word means on a
      // request, and `docs/spec-reference.md` now says so.
      const { task, approval } = await gatedAtChokepointA();
      await db.$client.unsafe(
        `UPDATE workforce_approvals SET timeout_at = now() - interval '1 hour' WHERE id = '${approval.id}';`,
      );
      const swept = await sweepApprovalTimeouts(tdb());
      expect(swept.failed).toEqual([approval.id]);
      const row = await read(task.taskId);
      expect(row.status).toBe('failed');
      // The BYTES are not destroyed — the release is. Stated precisely so nobody reads this as
      // "the sweep deletes the result".
      expect((row.result as { summary: string }).summary).toBe('Release note drafted.');
    });

    it("onTimeout 'escalate' re-issues to the reporting edge AND RE-BINDS the park", async () => {
      // Without the re-bind the superior's `approve` would fall through to the ordinary wake, which
      // re-queues the task and RE-DISPATCHES the seat with a finished result — the gate would
      // survive its own escalation as a re-run.
      const { task, approval } = await gatedAtChokepointA(GATE_ESCALATE);
      await db.$client.unsafe(
        `UPDATE workforce_approvals SET timeout_at = now() - interval '1 hour' WHERE id = '${approval.id}';`,
      );
      const swept = await sweepApprovalTimeouts(tdb());
      expect(swept.escalated).toEqual([approval.id]);
      const rows = await approvalsOf(task.taskId);
      const reissued = rows.find((a) => a.id !== approval.id) as ApprovalRecord;
      expect(reissued.approver).toBe('lead');
      expect(reissued.onTimeout).toBe('fail');
      expect(reissued.turnNumber).toBeNull();
      const row = await read(task.taskId);
      // Already in the escalated park — the sweep's guard correctly leaves it there.
      expect(row.status).toBe('blocked');
      expect(row.statusReason).toBe('approval_pending');
      const binding = joinPolicySchema.parse(row.joinPolicy);
      expect(binding).toEqual({ policy: 'approval', approvalId: reissued.id });
    });

    it('and the escalated approver can still RELEASE it — the chain ends at a completion', async () => {
      const { task, approval } = await gatedAtChokepointA(GATE_ESCALATE);
      await db.$client.unsafe(
        `UPDATE workforce_approvals SET timeout_at = now() - interval '1 hour' WHERE id = '${approval.id}';`,
      );
      await sweepApprovalTimeouts(tdb());
      const reissued = (await approvalsOf(task.taskId)).find(
        (a) => a.id !== approval.id,
      ) as ApprovalRecord;
      // The re-issued row NAMES an employee id as its approver, which no authenticated principal
      // can ever match (`workforce_escalation_unreachable`, docs/spec-reference.md) — so this is
      // the break-glass route, and the journal records the override. That advisory is a real,
      // documented limit of an escalating approval policy, and it is now sharper because what is
      // parked behind it is a finished result rather than an open question.
      await decideApproval(tdb(), {
        approvalId: reissued.id,
        decision: 'approve',
        decidedBy: 'user:00000000-0000-4000-8000-0000000000ff',
        overrideNamedApprover: true,
      });
      expect((await read(task.taskId)).status).toBe('completed');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  describe('OPERATOR INTERACTIONS with a gated park — pinned, not assumed', () => {
    it('manual_unblock RE-QUEUES the park (a pre-existing operator lever), and cannot complete it', async () => {
      // `blocked(approval_pending)` is operator-unblockable: `OPERATOR_UNBLOCKABLE` (signals.ts) is
      // every blocked reason except the structural parks and `deadline_exceeded`. That is
      // pre-existing behaviour of the ESCALATED approval park, which this gate now shares. The
      // consequence is worth stating rather than discovering: an operator can put a task holding a
      // stored result and a live approval back into the queue, and the seat runs again. It CANNOT
      // thereby ship unapproved work — the gate re-applies at the next completion — but the human's
      // pending decision is left orphaned, and this test is what says so out loud.
      const { task, approval } = await gatedAtChokepointA();
      const woke = await deliverSignal(tdb(), {
        taskId: task.taskId,
        kind: 'manual_unblock',
        signalKey: `unblock:${task.taskId}:1`,
        actor: 'user',
      });
      expect(woke.woke).toBe(true);
      expect((await read(task.taskId)).status).toBe('queued');
      // The approval is still pending and still bound; nothing completed.
      expect((await approvalsOf(task.taskId))[0]?.status).toBe('pending');
      expect((await read(task.taskId)).status).not.toBe('completed');
      // And the re-run is gated AGAIN rather than completing.
      await toWorking(await read(task.taskId), 2);
      await applyTurnOutcome(tdb(), {
        taskId: task.taskId,
        turnId: turnIdFor(task.taskId, 2),
        turnNumber: 2,
        intent: { kind: 'complete', result: RESULT(0.9) },
        approvalPolicy: GATE_FAIL,
        budgets: NO_BUDGETS,
      });
      const row = await read(task.taskId);
      expect(row.status).toBe('blocked');
      expect(row.statusReason).toBe('approval_pending');
      // The park now names the SECOND approval, and the first is still open for its decider.
      const binding = joinPolicySchema.parse(row.joinPolicy);
      expect(binding.approvalId).not.toBe(approval.id);
    });

    it('a cancel cascade still reaches a gated park — it is not a park with no exit', async () => {
      const { task } = await gatedAtChokepointA();
      const row = await read(task.taskId);
      await applyTransition(tdb(), {
        taskId: task.taskId,
        expectedVersion: row.version,
        to: 'cancelled',
        reason: 'cancelled_by_user',
        actor: 'user',
      });
      expect((await read(task.taskId)).status).toBe('cancelled');
    });
  });
});
