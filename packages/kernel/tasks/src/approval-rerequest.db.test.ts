/**
 * THE APPROVAL RE-REQUEST CAP (finding L-1), end to end against real Postgres.
 *
 * The live acceptance run watched a manager whose approval had just been GRANTED wake up, take the
 * next turn, and ask for the same approval again — bounded only by the turn budget and the approval
 * timeout, capped by nothing. This suite pins the cap that closes it and, just as importantly, pins
 * what it must NOT close: a genuinely different decision on the same task, and the rows the timeout
 * chain writes that carry no human answer at all.
 *
 * Every negative assertion here is proven by PLANTING the thing it denies:
 *   - "no second approval row is written" is a count, and the different-question test writes a real
 *     second row and asserts the count SEES it (2). A blind count fails that test.
 *   - "a row carrying no human answer does not block" plants `pending`/`timed_out`/`escalated` rows
 *     directly — the durable shapes the sweep produces — and watches a request go through.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTurnOutcome } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { decideApproval } from './approvals.js';
import { workforceBudgetsSchema } from './budget.js';
import { createRootTask } from './create-task.js';
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
    'approval-rerequest.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

const NO_BUDGETS = workforceBudgetsSchema.parse({});
const QUESTION = 'Ship the announcement?';

describe.skipIf(!hasDb)('the approval re-request cap (db)', () => {
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

  const claim = (taskId: string, expectedVersion: number, n: number) =>
    applyTransition(tdb(), {
      taskId,
      expectedVersion,
      to: 'working',
      actor: 'scheduler',
      turnId: turnIdFor(taskId, n),
    });

  const turn = (taskId: string, n: number, intent: unknown) =>
    applyTurnOutcome(tdb(), {
      taskId,
      turnId: turnIdFor(taskId, n),
      turnNumber: n,
      intent,
      budgets: NO_BUDGETS,
    });

  const ask = (question: string) => ({
    kind: 'request_approval',
    question,
    options: ['ship', 'hold'],
    timeoutMs: 7_200_000,
  });

  async function newWorkingRoot(): Promise<TaskRecord> {
    const root = await createRootTask(tdb(), {
      workforceId: 'wf',
      title: 'Root',
      goal: 'Drive the flows.',
      owner: 'mgr_growth',
      requestedBy: 'user',
    });
    const queued = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });
    return claim(root.taskId, queued.version, 1);
  }

  async function taskRow(
    taskId: string,
  ): Promise<{ status: string; status_reason: string | null }> {
    const rows = (await db.$client.unsafe(
      `SELECT status, status_reason FROM workforce_tasks WHERE task_id = '${taskId}';`,
    )) as unknown as { status: string; status_reason: string | null }[];
    return rows[0] as { status: string; status_reason: string | null };
  }

  async function version(taskId: string): Promise<number> {
    const rows = (await db.$client.unsafe(
      `SELECT version FROM workforce_tasks WHERE task_id = '${taskId}';`,
    )) as unknown as { version: number }[];
    return rows[0]?.version as number;
  }

  async function approvals(
    taskId: string,
  ): Promise<
    { id: string; status: string; question: string | null; turn_number: number | null }[]
  > {
    return (await db.$client.unsafe(
      `SELECT id, status, question, turn_number FROM workforce_approvals WHERE task_id = '${taskId}' ORDER BY created_at, id;`,
    )) as unknown as {
      id: string;
      status: string;
      question: string | null;
      turn_number: number | null;
    }[];
  }

  async function requestedEvents(taskId: string): Promise<number> {
    const rows = (await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${taskId}' AND type = 'workforce.approval.requested';`,
    )) as unknown as { c: number }[];
    return rows[0]?.c as number;
  }

  /** Turn 1 asks; a human decides; the wake re-queues; turn `n` is claimed and ready to end. */
  async function grantedThenClaim(
    decision: 'approve' | 'reject' = 'approve',
    question = QUESTION,
  ): Promise<TaskRecord> {
    const root = await newWorkingRoot();
    const first = await turn(root.taskId, 1, ask(question));
    expect(first.task?.status).toBe('waiting_for_user');
    const [row] = await approvals(root.taskId);
    await decideApproval(tdb(), {
      approvalId: (row as { id: string }).id,
      decision,
      decidedBy: 'api-key:be09f824-5900-4641-bf9b-89b1a4a29c3f',
      ...(decision === 'reject' ? { reason: 'No.' } : {}),
    });
    expect((await taskRow(root.taskId)).status).toBe('queued');
    return claim(root.taskId, await version(root.taskId), 2);
  }

  // ---- THE CAP ---------------------------------------------------------------------------------

  it('a GRANTED decision may not be re-requested: the turn is refused and no second row is written', async () => {
    const root = await grantedThenClaim('approve');
    const second = await turn(root.taskId, 2, ask(QUESTION));

    expect(second.plan?.kind).toBe('invalid_intent');
    // The refusal takes the declared tool-error fate — requeue once, with the typed reason.
    const after = await taskRow(root.taskId);
    expect(after).toMatchObject({ status: 'queued', status_reason: 'tool_error' });

    // The negative: exactly ONE approval row, still the granted one. (The different-question test
    // below is the plant that proves this count can see a second row at all.)
    const rows = await approvals(root.taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'approved', turn_number: 1 });
    // And the journal did not record a request that never happened.
    expect(await requestedEvents(root.taskId)).toBe(1);
  });

  it('a REJECTED decision may not be re-requested either — the identical hole one status over', async () => {
    const root = await grantedThenClaim('reject');
    const second = await turn(root.taskId, 2, ask(QUESTION));

    expect(second.plan?.kind).toBe('invalid_intent');
    expect(await taskRow(root.taskId)).toMatchObject({
      status: 'queued',
      status_reason: 'tool_error',
    });
    const rows = await approvals(root.taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'rejected' });
  });

  it.each([
    ['leading/trailing whitespace', `  ${QUESTION}  `],
    ['internal whitespace', 'Ship   the\tannouncement?'],
    ['case', 'SHIP THE ANNOUNCEMENT?'],
  ])('a re-ask differing only in %s is the same decision and is refused', async (_l, variant) => {
    const root = await grantedThenClaim('approve');
    const second = await turn(root.taskId, 2, ask(variant));
    expect(second.plan?.kind).toBe('invalid_intent');
    expect(await approvals(root.taskId)).toHaveLength(1);
  });

  // ---- THE PLANT: what the cap must NOT close --------------------------------------------------

  it('a DIFFERENT decision on the same task still parks — and the count SEES the second row', async () => {
    const root = await grantedThenClaim('approve');
    const second = await turn(root.taskId, 2, ask('Also notify legal?'));

    expect(second.plan?.kind).toBe('request_approval');
    expect(await taskRow(root.taskId)).toMatchObject({
      status: 'waiting_for_user',
      status_reason: 'approval_pending',
    });
    const rows = await approvals(root.taskId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'approved', question: QUESTION, turn_number: 1 });
    expect(rows[1]).toMatchObject({
      status: 'pending',
      question: 'Also notify legal?',
      turn_number: 2,
    });
    expect(await requestedEvents(root.taskId)).toBe(2);
  });

  it('a REWORDED question is not capped — the deliberate, documented limit of the cap', async () => {
    const root = await grantedThenClaim('approve');
    const second = await turn(root.taskId, 2, ask('Should I ship the announcement?'));
    expect(second.plan?.kind).toBe('request_approval');
    expect(await approvals(root.taskId)).toHaveLength(2);
  });

  it.each([
    ['pending'],
    ['timed_out'],
    ['escalated'],
  ])('a %s row carries no human answer and does not block the same question', async (status) => {
    const root = await newWorkingRoot();
    // PLANT the durable shape the timeout chain produces, without needing the park it implies:
    // a row for THIS question in a status that is not a human's answer.
    await db.$client.unsafe(
      `INSERT INTO workforce_approvals (tenant_id, task_id, question, options, approver, status, on_timeout)
         VALUES ('${TENANT_A}', '${root.taskId}', '${QUESTION}', '[]'::jsonb, 'user', '${status}', 'fail');`,
    );
    const out = await turn(root.taskId, 1, ask(QUESTION));
    expect(out.plan?.kind).toBe('request_approval');
    expect(await taskRow(root.taskId)).toMatchObject({
      status: 'waiting_for_user',
      status_reason: 'approval_pending',
    });
    // The planted row plus the one this turn opened.
    expect(await approvals(root.taskId)).toHaveLength(2);
  });

  it("another task's granted decision does not restrict this one — the cap is keyed on the task row", async () => {
    const other = await grantedThenClaim('approve');
    expect((await approvals(other.taskId))[0]).toMatchObject({ status: 'approved' });

    const fresh = await newWorkingRoot();
    const out = await turn(fresh.taskId, 1, ask(QUESTION));
    expect(out.plan?.kind).toBe('request_approval');
    expect(await approvals(fresh.taskId)).toHaveLength(1);
  });

  // ---- THE FATE --------------------------------------------------------------------------------

  it('a second consecutive re-request FAILS the task rather than requeueing forever', async () => {
    const root = await grantedThenClaim('approve');
    await turn(root.taskId, 2, ask(QUESTION));
    expect(await taskRow(root.taskId)).toMatchObject({
      status: 'queued',
      status_reason: 'tool_error',
    });

    await claim(root.taskId, await version(root.taskId), 3);
    const third = await turn(root.taskId, 3, ask(QUESTION));
    expect(third.plan).toMatchObject({ kind: 'invalid_intent', fate: 'fail' });
    expect((await taskRow(root.taskId)).status).toBe('failed');
    expect(await approvals(root.taskId)).toHaveLength(1);
  });

  it('the seat can route around the refusal: the next turn completes normally', async () => {
    const root = await grantedThenClaim('approve');
    await turn(root.taskId, 2, ask(QUESTION));
    await claim(root.taskId, await version(root.taskId), 3);
    const third = await turn(root.taskId, 3, {
      kind: 'complete',
      result: { status: 'completed', summary: 'Shipped.', confidence: 0.9 },
    });
    expect(third.task?.status).toBe('completed');
    expect(await approvals(root.taskId)).toHaveLength(1);
  });

  // ---- APPLICATION-LEVEL EXACTLY-ONCE ----------------------------------------------------------
  // A model call may be repeated after a mid-turn crash; applying its effects may not. The refusal
  // is an APPLIED outcome like any other, so it has to obey the receipt too.

  it('re-applying the refused turn is a no-op — the receipt still governs', async () => {
    const root = await grantedThenClaim('approve');
    await turn(root.taskId, 2, ask(QUESTION));
    const afterFirst = await taskRow(root.taskId);

    const replay = await turn(root.taskId, 2, ask(QUESTION));
    expect(replay.alreadyApplied).toBe(true);
    expect(await taskRow(root.taskId)).toEqual(afterFirst);
    expect(await approvals(root.taskId)).toHaveLength(1);
    expect(await requestedEvents(root.taskId)).toBe(1);
  });
});
