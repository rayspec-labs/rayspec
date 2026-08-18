/**
 * THE DECISION DOOR KEEPS THE AUTHORIZATION IT WRITES — against real Postgres.
 *
 * The engine records `approver` / `reviewer` as accountability FACTS and journals them; the
 * approval timeout sweep MINTS one when it escalates a hung request to the requester's declared
 * superior. Before this suite, both `decideApproval` and `applyReviewVerdict` compare-and-swapped
 * on status alone — so the very operator whose inaction caused an escalation could resolve the row
 * addressed to their superior, and `decided_by` was free to contradict the journal.
 *
 * The load-bearing assertion in every refusal case is on the ROW, not the rejected promise: a
 * refusal must write NOTHING — no status move, no `decided_by`, no `decided_at`, no journal event,
 * no wake signal. A refusal that half-wrote would be a worse audit trail than the gap it closes.
 *
 * The posture case is equally load-bearing in the other direction: `approver: 'user'` is the
 * sentinel every shipped example declares, and it must keep admitting ANY principal.
 */
import { schema } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTurnOutcome } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import {
  ApprovalAlreadyDecidedError,
  ApprovalApproverMismatchError,
  ApprovalNotFoundError,
  decideApproval,
  sweepApprovalTimeouts,
} from './approvals.js';
import { workforceBudgetsSchema } from './budget.js';
import { createRootTask } from './create-task.js';
import { applyReviewVerdict, type ReviewRecord, ReviewReviewerMismatchError } from './reviews.js';
import {
  forTenant,
  makeTestDb,
  resetTaskSchema,
  seedOrgs,
  TENANT_A,
  TENANT_B,
} from './test-support/test-db.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'decision-authority.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

const NO_BUDGETS = workforceBudgetsSchema.parse({});

interface ApprovalRow {
  id: string;
  approver: string;
  status: string;
  decided_by: string | null;
  decided_at: Date | null;
}

describe.skipIf(!hasDb)('the decision door enforces the recorded decider (db)', () => {
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

  const tdb = (tenant: string = TENANT_A) => forTenant(db, tenant);

  const turnIdFor = (taskId: string, n: number) => `wf-task-turn:${taskId}:${n}`;

  async function workingRoot(title = 'Root'): Promise<TaskRecord> {
    const root = await createRootTask(tdb(), {
      workforceId: 'wf',
      title,
      goal: 'Drive the decision doors.',
      owner: 'coordinator',
      requestedBy: 'user',
    });
    const queued = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });
    return applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(root.taskId, 1),
    });
  }

  function turn(taskId: string, turnNumber: number, intent: unknown) {
    return applyTurnOutcome(tdb(), {
      taskId,
      turnId: turnIdFor(taskId, turnNumber),
      turnNumber,
      intent,
      budgets: NO_BUDGETS,
    });
  }

  /** Park a fresh root on an approval addressed to `approver`. */
  async function pendingApproval(
    approver: string,
  ): Promise<{ task: TaskRecord; row: ApprovalRow }> {
    const task = await workingRoot('Approval subject');
    await turn(task.taskId, 1, {
      kind: 'request_approval',
      question: 'Ship it?',
      timeoutMs: 60_000,
      approver,
    });
    const rows = (await db.$client.unsafe(
      `SELECT id, approver, status, decided_by, decided_at FROM workforce_approvals WHERE task_id = '${task.taskId}';`,
    )) as unknown as ApprovalRow[];
    expect(rows).toHaveLength(1);
    return { task, row: rows[0] as ApprovalRow };
  }

  /** Re-read one approval row straight from SQL — the refusal assertions read THIS, not a promise. */
  async function approvalRow(id: string): Promise<ApprovalRow> {
    const rows = (await db.$client.unsafe(
      `SELECT id, approver, status, decided_by, decided_at FROM workforce_approvals WHERE id = '${id}';`,
    )) as unknown as ApprovalRow[];
    return rows[0] as ApprovalRow;
  }

  async function eventCount(taskId: string, type: string): Promise<number> {
    const rows = (await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${taskId}' AND type = '${type}';`,
    )) as unknown as { c: number }[];
    return (rows[0] as { c: number }).c;
  }

  async function signalCount(taskId: string): Promise<number> {
    const rows = (await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_signals WHERE task_id = '${taskId}';`,
    )) as unknown as { c: number }[];
    return (rows[0] as { c: number }).c;
  }

  /** Park a fresh root in `waiting_for_review` on a review addressed to `reviewer`. */
  async function pendingReview(
    reviewer: string,
  ): Promise<{ task: TaskRecord; review: ReviewRecord }> {
    const task = await workingRoot('Review subject');
    const applied = await turn(task.taskId, 1, { kind: 'request_review', reviewer });
    expect(applied.task?.status).toBe('waiting_for_review');
    const reviews = (await tdb()
      .select(schema.workforceReviews)
      .where(eq(schema.workforceReviews.taskId, task.taskId))) as ReviewRecord[];
    return { task: applied.task as TaskRecord, review: reviews[0] as ReviewRecord };
  }

  // ── approvals ───────────────────────────────────────────────────────────────────────────────

  it('a NAMED approver decides their own row — bare id and the HTTP door’s user: spelling', async () => {
    const bare = await pendingApproval('ops_lead');
    const decidedBare = await decideApproval(tdb(), {
      approvalId: bare.row.id,
      decision: 'approve',
      decidedBy: 'ops_lead',
    });
    expect(decidedBare.status).toBe('approved');

    const scheme = await pendingApproval('ops_lead');
    const decidedScheme = await decideApproval(tdb(), {
      approvalId: scheme.row.id,
      decision: 'approve',
      decidedBy: 'user:ops_lead',
    });
    expect(decidedScheme.status).toBe('approved');
    expect(decidedScheme.decidedBy).toBe('user:ops_lead');
  });

  it('a DIFFERENT principal is refused and the row is untouched — no status, no decided_by, no event, no signal', async () => {
    const { task, row } = await pendingApproval('ops_lead');
    await expect(
      decideApproval(tdb(), {
        approvalId: row.id,
        decision: 'approve',
        decidedBy: 'user:someone_else',
      }),
    ).rejects.toBeInstanceOf(ApprovalApproverMismatchError);

    // THE ROW, not the promise: a refusal writes nothing at all.
    const after = await approvalRow(row.id);
    expect(after).toMatchObject({ status: 'pending', decided_by: null, decided_at: null });
    expect(after.approver).toBe('ops_lead');
    expect(await eventCount(task.taskId, 'workforce.approval.decided')).toBe(0);
    expect(await signalCount(task.taskId)).toBe(0);
    // …and the task is still parked on the approval it was parked on.
    const parked = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(parked[0]).toMatchObject({
      status: 'waiting_for_user',
      status_reason: 'approval_pending',
    });
  });

  it("the 'user' sentinel keeps admitting ANY permitted principal (the shipped single-operator posture)", async () => {
    // Zero-padded synthetic ids (the `test-db.ts` tenant convention) — a realistic random UUID beside
    // an `api-key:`/`user:` prefix is what a secret scanner is built to flag, and the shape is all
    // this row needs.
    for (const actor of ['user', 'user:00000000-0000-4000-8000-000000000001', 'api-key:k1']) {
      const { row } = await pendingApproval('user');
      const decided = await decideApproval(tdb(), {
        approvalId: row.id,
        decision: 'approve',
        decidedBy: actor,
      });
      expect(decided.status, actor).toBe('approved');
      expect(decided.decidedBy, actor).toBe(actor);
    }
  });

  it('break-glass decides a named row AND the journal records that an override happened', async () => {
    const { task, row } = await pendingApproval('ops_lead');
    const decided = await decideApproval(tdb(), {
      approvalId: row.id,
      decision: 'approve',
      decidedBy: 'user:incident_commander',
      overrideNamedApprover: true,
    });
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('user:incident_commander');

    const events = (await db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.approval.decided';`,
    )) as unknown as { data: Record<string, unknown> }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({
      decidedBy: 'user:incident_commander',
      overriddenApprover: 'ops_lead',
    });
  });

  it('an ordinary (non-override) decision journals NO override field — the flag is not a default', async () => {
    const { task, row } = await pendingApproval('user');
    await decideApproval(tdb(), { approvalId: row.id, decision: 'approve', decidedBy: 'user:any' });
    const events = (await db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.approval.decided';`,
    )) as unknown as { data: Record<string, unknown> }[];
    expect(events[0]?.data).not.toHaveProperty('overriddenApprover');
  });

  it('a matching id in ANOTHER tenant is still refused — identity never crosses the tenant boundary', async () => {
    const { row } = await pendingApproval('ops_lead');
    // Tenant B's principal carries the very id tenant A's row names. The tenant chokepoint answers
    // first: the row is not found at all, so the identity match never gets a chance to apply.
    await expect(
      decideApproval(tdb(TENANT_B), {
        approvalId: row.id,
        decision: 'approve',
        decidedBy: 'user:ops_lead',
      }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    const after = await approvalRow(row.id);
    expect(after).toMatchObject({ status: 'pending', decided_by: null, decided_at: null });
  });

  // ── the escalation path, end to end (the scenario the finding is actually about) ─────────────

  it('THE ESCALATION: only the superior the sweep named (or break-glass) may decide the re-issued request', async () => {
    const task = await workingRoot('Escalating approval');
    await turn(task.taskId, 1, {
      kind: 'request_approval',
      question: 'Proceed?',
      timeoutMs: 1,
      onTimeout: 'escalate',
      escalateTo: 'ops_lead',
    });
    const swept = await sweepApprovalTimeouts(tdb(), new Date(Date.now() + 10_000));
    expect(swept.escalated).toHaveLength(1);

    // The sweep MINTED an authorization: a fresh row addressed to the declared superior, journaled
    // as `workforce.approval.requested{approver}`.
    const pending = (await db.$client.unsafe(
      `SELECT id, approver, status, decided_by, decided_at FROM workforce_approvals WHERE task_id = '${task.taskId}' AND status = 'pending';`,
    )) as unknown as ApprovalRow[];
    expect(pending).toHaveLength(1);
    const escalated = pending[0] as ApprovalRow;
    expect(escalated.approver).toBe('ops_lead');
    const requested = (await db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.approval.requested' ORDER BY seq DESC LIMIT 1;`,
    )) as unknown as { data: Record<string, unknown> }[];
    expect(requested[0]?.data).toMatchObject({
      approver: 'ops_lead',
      escalatedFrom: expect.any(String),
    });

    // THE FINDING: the operator whose inaction caused the escalation must not be able to resolve
    // the row addressed to their superior.
    await expect(
      decideApproval(tdb(), {
        approvalId: escalated.id,
        decision: 'approve',
        decidedBy: 'user:the_operator_who_stalled',
      }),
    ).rejects.toBeInstanceOf(ApprovalApproverMismatchError);
    const held = await approvalRow(escalated.id);
    expect(held).toMatchObject({ status: 'pending', decided_by: null, decided_at: null });
    // The task is still parked where the escalation left it — nothing woke.
    const stillBlocked = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(stillBlocked[0]).toMatchObject({ status: 'blocked', status_reason: 'approval_pending' });
    expect(await signalCount(task.taskId)).toBe(0);

    // The NAMED superior decides, and the chain keeps its exit.
    const decided = await decideApproval(tdb(), {
      approvalId: escalated.id,
      decision: 'approve',
      decidedBy: 'ops_lead',
    });
    expect(decided.status).toBe('approved');
    const woken = await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(woken[0]).toEqual({ status: 'queued', status_reason: null });
  });

  it('THE ESCALATION, break-glass arm: an unavailable superior never wedges the deployment', async () => {
    const task = await workingRoot('Escalating approval');
    await turn(task.taskId, 1, {
      kind: 'request_approval',
      question: 'Proceed?',
      timeoutMs: 1,
      onTimeout: 'escalate',
      escalateTo: 'ops_lead',
    });
    expect(
      (await sweepApprovalTimeouts(tdb(), new Date(Date.now() + 10_000))).escalated,
    ).toHaveLength(1);
    const pending = (await db.$client.unsafe(
      `SELECT id FROM workforce_approvals WHERE task_id = '${task.taskId}' AND status = 'pending';`,
    )) as unknown as { id: string }[];
    const decided = await decideApproval(tdb(), {
      approvalId: (pending[0] as { id: string }).id,
      decision: 'reject',
      reason: 'ops_lead is unreachable; incident bridge decision',
      decidedBy: 'user:incident_commander',
      overrideNamedApprover: true,
    });
    expect(decided.status).toBe('rejected');
    const events = (await db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.approval.decided';`,
    )) as unknown as { data: Record<string, unknown> }[];
    expect(events[0]?.data).toMatchObject({
      decidedBy: 'user:incident_commander',
      overriddenApprover: 'ops_lead',
    });
  });

  // ── reviews (the same matrix) ────────────────────────────────────────────────────────────────

  it('a NAMED reviewer decides their own review — bare id and the user: spelling', async () => {
    const bare = await pendingReview('qa');
    const doneBare = await applyReviewVerdict(tdb(), NO_BUDGETS, {
      reviewId: bare.review.id,
      verdict: 'accept',
      reasons: [],
      requiredChanges: [],
      actor: 'qa',
    });
    expect(doneBare.status).toBe('completed');

    const scheme = await pendingReview('qa');
    const doneScheme = await applyReviewVerdict(tdb(), NO_BUDGETS, {
      reviewId: scheme.review.id,
      verdict: 'accept',
      reasons: [],
      requiredChanges: [],
      actor: 'user:qa',
    });
    expect(doneScheme.status).toBe('completed');
  });

  it('a DIFFERENT principal is refused on a named review, and the review row is untouched', async () => {
    const { task, review } = await pendingReview('qa');
    await expect(
      applyReviewVerdict(tdb(), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'accept',
        reasons: [],
        requiredChanges: [],
        actor: 'user:someone_else',
      }),
    ).rejects.toBeInstanceOf(ReviewReviewerMismatchError);
    const rows = (await db.$client.unsafe(
      `SELECT verdict, decided_at FROM workforce_reviews WHERE id = '${review.id}';`,
    )) as unknown as { verdict: string | null; decided_at: Date | null }[];
    expect(rows[0]).toMatchObject({ verdict: null, decided_at: null });
    expect(await eventCount(task.taskId, 'workforce.review.decided')).toBe(0);
    const parked = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(parked[0]?.status).toBe('waiting_for_review');
  });

  it("a review addressed to 'user' is decidable by any permitted principal", async () => {
    const { review } = await pendingReview('user');
    const done = await applyReviewVerdict(tdb(), NO_BUDGETS, {
      reviewId: review.id,
      verdict: 'accept',
      reasons: [],
      requiredChanges: [],
      actor: 'user:00000000-0000-4000-8000-000000000003',
    });
    expect(done.status).toBe('completed');
  });

  it('break-glass decides a named review AND the journal records the override', async () => {
    const { task, review } = await pendingReview('qa');
    const done = await applyReviewVerdict(tdb(), NO_BUDGETS, {
      reviewId: review.id,
      verdict: 'accept',
      reasons: [],
      requiredChanges: [],
      actor: 'user:incident_commander',
      overrideNamedReviewer: true,
    });
    expect(done.status).toBe('completed');
    const events = (await db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.review.decided';`,
    )) as unknown as { data: Record<string, unknown> }[];
    expect(events[0]?.data).toMatchObject({
      decidedBy: 'user:incident_commander',
      reviewer: 'qa',
      overriddenReviewer: 'qa',
    });
  });

  it('a matching reviewer id in ANOTHER tenant is still refused', async () => {
    const { review } = await pendingReview('qa');
    await expect(
      applyReviewVerdict(tdb(TENANT_B), NO_BUDGETS, {
        reviewId: review.id,
        verdict: 'accept',
        reasons: [],
        requiredChanges: [],
        actor: 'user:qa',
      }),
    ).rejects.toThrow(/not found/i);
    const rows = (await db.$client.unsafe(
      `SELECT verdict FROM workforce_reviews WHERE id = '${review.id}';`,
    )) as unknown as { verdict: string | null }[];
    expect(rows[0]?.verdict).toBeNull();
  });

  // ── the CAS under REAL concurrency (B-015 clause 1) ──────────────────────────────────────────
  //
  // WHY HERE, in the authority suite. `approvals.ts`'s own protocol note states that the authority
  // gate "cannot be the race arbiter and does not try to be: the `status = 'pending'`
  // compare-and-swap below is still the only thing that admits one winner (two authorized racers
  // both read `pending`, both CAS, and the loser lands in the same already-decided branch as
  // before)". That sentence is a claim about a race, and until these arms nothing in the tree ran
  // one: every `decideApproval` call in every suite was a sequential `await`, so the CAS was only
  // ever exercised on the trivially-serialized path where the second call reads a decided row.
  //
  // The REVIEW twin is already covered this way (reviews.db.test.ts, "two RACING verdicts on one
  // review admit exactly one") and this is deliberately the same shape, for the same reason its
  // comment gives: BOTH racers are the row's own named approver. Racing two unrelated principals
  // would be refused by the authority gate BEFORE the CAS ever ran, which would quietly stop
  // testing the CAS while still producing a green "exactly one winner".
  //
  // WHAT "EXACTLY ONE WINNER" DOES NOT SAY, and why the arms below say more. A count of one
  // fulfilled promise is ALSO satisfied by neither racer succeeding (0 wins is not 1, but a suite
  // asserting only `losses.length >= 1`, or only that the row is no longer pending, would pass on a
  // double refusal). So the row is read back and matched against the WINNER's own return value, the
  // journal is counted, and the wake is asserted: the winner must have actually won, not merely
  // been the only one that did not lose.
  //
  // ── WHY THERE IS A BARRIER, and why a bare `Promise.allSettled` was NOT enough ───────────────
  //
  // `decideApproval` can refuse a second decision in TWO different places, and only one of them is
  // the CAS:
  //   (A) the PRE-CAS read (`if (named.status !== 'pending')`) — reached when the second call's
  //       opening SELECT happens AFTER the first call committed;
  //   (B) the POST-CAS branch (`if (!approval)`) — reached only when both calls read `pending` and
  //       then contend on the UPDATE.
  // Both throw the SAME `ApprovalAlreadyDecidedError`, so the outcome cannot tell them apart.
  //
  // A plain `Promise.allSettled` of two calls therefore lands on (A) or (B) depending on host
  // timing, and a run that lands on (A) is green while testing nothing about the compare-and-swap.
  // This was not a hypothetical: the first draft of these arms WAS a plain `allSettled`, and a
  // mutation that made branch (B) throw a different error class LEFT BOTH ARMS GREEN — the loser
  // had never reached (B). The barrier below removes the timing dependency.
  //
  // HOW IT WORKS. A separate connection holds `SELECT … FOR UPDATE` on the approval row. A plain
  // SELECT does not block against a row lock, so both racers walk their opening read (both see
  // `pending`) and then park on their UPDATE. The barrier is held long enough to OBSERVE that —
  // neither promise may settle while it is held — which is the arm's proof that both racers are
  // parked at the compare-and-swap rather than one of them having already exited through (A).
  // Releasing the lock then lets exactly one UPDATE match `status = 'pending'`.
  describe('two RACING decisions on one approval (the CAS, not the authority gate)', () => {
    /** Long enough for both racers to take a pooled connection, BEGIN, read, and park on the UPDATE. */
    const BARRIER_MS = 400;

    type Decision = Awaited<ReturnType<typeof decideApproval>>;

    /** The full decided-row projection — `approvalRow` above does not carry `decision`. */
    async function decidedRow(
      id: string,
    ): Promise<{ status: string; decision: string | null; decided_by: string | null }> {
      const rows = (await db.$client.unsafe(
        `SELECT status, decision, decided_by FROM workforce_approvals WHERE id = '${id}';`,
      )) as unknown as { status: string; decision: string | null; decided_by: string | null }[];
      return rows[0] as { status: string; decision: string | null; decided_by: string | null };
    }

    /**
     * Race an approve against a reject on ONE approval, both as the row's own named approver, with
     * both provably parked at the CAS before either is allowed through.
     *
     * Told apart by their DECISION, not by their actor: racing two different principals would be
     * refused by the authority gate BEFORE the CAS ever ran — the same reason
     * `reviews.db.test.ts`'s racing-verdict arm gives for using one reviewer twice.
     */
    async function racedDecision(approvalId: string): Promise<{
      results: PromiseSettledResult<Decision>[];
      /** Observed WHILE the row lock was held: false means that racer exited without reaching the CAS. */
      parkedAtTheCas: { approve: boolean; reject: boolean };
    }> {
      let approveSettled = false;
      let rejectSettled = false;
      let settled!: Promise<PromiseSettledResult<Decision>[]>;
      let parkedAtTheCas!: { approve: boolean; reject: boolean };

      await db.$client.begin(async (sql) => {
        await sql.unsafe(
          `SELECT id FROM workforce_approvals WHERE id = '${approvalId}' FOR UPDATE;`,
        );

        const approve = decideApproval(tdb(), {
          approvalId,
          decision: 'approve',
          decidedBy: 'ops_lead',
        });
        const reject = decideApproval(tdb(), {
          approvalId,
          decision: 'reject',
          decidedBy: 'ops_lead',
          reason: 'not now',
        });
        // Mark settlement on BOTH outcomes — a rejection is exactly the case being ruled out here,
        // and `.then(onFulfilled, onRejected)` also keeps the rejection handled.
        const mark = (p: Promise<Decision>, set: () => void) => void p.then(set, set);
        mark(approve, () => {
          approveSettled = true;
        });
        mark(reject, () => {
          rejectSettled = true;
        });
        settled = Promise.allSettled([approve, reject]);

        await new Promise((resolve) => setTimeout(resolve, BARRIER_MS));
        parkedAtTheCas = { approve: !approveSettled, reject: !rejectSettled };
      });

      return { results: await settled, parkedAtTheCas };
    }

    it('admits exactly one — and the STORED row is the winner’s, never the loser’s', async () => {
      const { row } = await pendingApproval('ops_lead');

      const { results, parkedAtTheCas } = await racedDecision(row.id);

      // THE RACE ARMED. Without this the arms below are green on a run where the second caller
      // never contended at all (see the branch note above the describe).
      expect(
        parkedAtTheCas,
        'a racer settled while the approval row was still locked — it exited through the PRE-CAS ' +
          'read instead of contending on the compare-and-swap, so this run proves nothing about it',
      ).toEqual({ approve: true, reject: true });

      const wins = results.filter((r) => r.status === 'fulfilled');
      const losses = results.filter((r) => r.status === 'rejected');
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      expect((losses[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ApprovalAlreadyDecidedError,
      );

      // THE WINNER ACTUALLY WON. Anchored on the fulfilled promise's own value rather than on a
      // literal, so this cannot pass by both racers failing and it cannot pass by the row landing
      // on a status neither of them asked for.
      const winner = (wins[0] as PromiseFulfilledResult<Decision>).value;
      expect(winner.status).toMatch(/^(approved|rejected)$/);
      expect(
        await decidedRow(row.id),
        'the stored approval is not the winning decision — the CAS admitted one caller but the row ' +
          'carries the other, or a blend of the two',
      ).toEqual({
        status: winner.status,
        decision: winner.decision,
        decided_by: 'ops_lead',
      });
    });

    it('the LOSER changes nothing: one decision event, one signal, one wake', async () => {
      const { task, row } = await pendingApproval('ops_lead');

      const { results, parkedAtTheCas } = await racedDecision(row.id);
      expect(parkedAtTheCas).toEqual({ approve: true, reject: true });
      const winner = (
        results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Decision>
      ).value;

      // A refusal writes NOTHING — the suite's standing rule, applied to the racing loser rather
      // than to the unauthorized caller. Counting the journal and the signals is what catches a
      // loser that half-wrote: the row check alone cannot see a second event or a second delivery.
      expect(
        await eventCount(task.taskId, 'workforce.approval.decided'),
        'the losing racer journaled a decision it did not make',
      ).toBe(1);
      expect(await signalCount(task.taskId), 'the losing racer delivered a second wake').toBe(1);

      const events = (await db.$client.unsafe(
        `SELECT data FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.approval.decided';`,
      )) as unknown as { data: Record<string, unknown> }[];
      expect(events[0]?.data).toMatchObject({ decision: winner.decision, decidedBy: 'ops_lead' });

      // …and the ONE decision that landed did the whole job: the task is off its approval park.
      const woke = await db.$client.unsafe(
        `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
      );
      expect(woke[0]).toMatchObject({ status: 'queued', status_reason: null });
    });
  });
});
