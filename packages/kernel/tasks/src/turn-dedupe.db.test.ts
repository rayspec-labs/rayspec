/**
 * THE DURABLE SECOND LAYER beneath the turn receipt, for the two effects that had none.
 *
 * Children get two layers against a re-applied turn: a deterministic primary key
 * (`deterministicChildTaskId`) AND `workforce_delegations_tenant_child_idx` UNIQUE, both beneath
 * the receipt. Reviews and approvals got neither — `workforce_reviews` carried only a NON-unique
 * `(tenant_id, task_id, round)` index and `workforce_approvals` carried no uniqueness at all, so
 * the receipt read at the top of `applyTurnOutcome` was the ONLY thing standing between a replayed
 * turn and a second row.
 *
 * WHY THE KEY IS `turn_number` AND NOT `round`. `round` is not an input to the turn — it is
 * DERIVED from the number of review rows that already exist (`reviewRoundsUsed = reviewRows.length`
 * in apply-intents.ts, `round = input.reviewRoundsUsed + 1` in intent-applier.ts). A second
 * application of the SAME turn therefore computes a DIFFERENT round, and a UNIQUE on
 * `(tenant_id, task_id, round)` would admit exactly the duplicate it was added to prevent. The
 * test 'the second layer is what stops it, and a (tenant, task, round) UNIQUE would not have'
 * below demonstrates that on real rows. `turn_number` is an INPUT (`ApplyTurnInput.turnNumber`),
 * so it is stable across replay — the same key, and the same partial-UNIQUE shape, the transition
 * receipt itself uses.
 *
 * The out-of-turn insert stays legal: the approval-timeout sweep re-issues an escalated request
 * with NO turn at all (approvals.ts), writes `turn_number = NULL`, and is deduped by the
 * `status = 'pending'` compare-and-swap that claimed the row rather than by this key. The index is
 * PARTIAL to declare that and to match the transition receipt's shape — not because it has to be:
 * NULLs are DISTINCT for uniqueness in Postgres, so a total UNIQUE would admit those rows too. The
 * turn-less tests below therefore pin that such rows stay legal; they do NOT discriminate a partial
 * index from a total one, and nothing here should be read as evidence that they do.
 */
import { schema } from '@rayspec/db';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTurnOutcome } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
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
    'turn-dedupe.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a correctness-load-bearing suite.',
  );
}

const NO_BUDGETS = workforceBudgetsSchema.parse({});

describe.skipIf(!hasDb)('the durable dedupe key beneath the turn receipt (db)', () => {
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

  const newRoot = (over: Record<string, unknown> = {}): Promise<TaskRecord> =>
    createRootTask(tdb(), {
      workforceId: 'wf',
      title: 'Root',
      goal: 'Drive the flows.',
      owner: 'coordinator',
      requestedBy: 'user',
      ...over,
    });

  const turnIdFor = (taskId: string, turnNumber: number) => `wf-task-turn:${taskId}:${turnNumber}`;

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
      turnId: turnIdFor(task.taskId, 1),
    });
  }

  const turn = (taskId: string, turnNumber: number, intent: unknown) =>
    applyTurnOutcome(tdb(), {
      taskId,
      turnId: turnIdFor(taskId, turnNumber),
      turnNumber,
      intent,
      budgets: NO_BUDGETS,
      actualUsd: 0,
    });

  const reviewRows = (taskId: string) =>
    db.$client.unsafe(
      `SELECT id, round, turn_number FROM workforce_reviews WHERE task_id = '${taskId}' ORDER BY round;`,
    ) as unknown as Promise<{ id: string; round: number; turn_number: number | null }[]>;

  const approvalRows = (taskId: string) =>
    db.$client.unsafe(
      `SELECT id, question, turn_number FROM workforce_approvals WHERE task_id = '${taskId}' ORDER BY created_at;`,
    ) as unknown as Promise<{ id: string; question: string; turn_number: number | null }[]>;

  /**
   * The SQLSTATE of a refused write, or a thrown failure if it was not refused at all. Asserting on
   * `23505` (unique_violation) rather than on the message pins WHICH guarantee refused: the driver
   * error's own message is only `Failed query: …`, which would pass for a NOT NULL violation, a
   * missing column, or any other write failure.
   */
  async function refusalCode(write: Promise<unknown>): Promise<string> {
    try {
      await write;
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } };
      return String(e.code ?? e.cause?.code ?? 'no-sqlstate');
    }
    throw new Error('expected the database to REFUSE this write, but it succeeded');
  }

  /**
   * SIMULATE A LOST RECEIPT. `workforce_task_transitions` is append-only by DISCIPLINE, not by
   * constraint (schema.ts says so), so a repaired/partially-restored database — or any future
   * refactor that moves an effect out of the receipt's transaction — can present a turn whose
   * effects committed but whose receipt row is absent. That is precisely the case the second layer
   * exists for, and the ONLY way to observe it without the receipt short-circuiting first.
   */
  async function loseTheReceipt(taskId: string, turnNumber: number): Promise<void> {
    await db.$client.unsafe(
      `DELETE FROM workforce_task_transitions WHERE task_id = '${taskId}' AND turn_number = ${turnNumber};`,
    );
    // Put the row back under the SAME claim the turn presents (the queued -> working transition,
    // with its turn id, is untouched above) so the identical turn can legitimately re-enter.
    await db.$client.unsafe(
      `UPDATE workforce_tasks SET status = 'working', status_reason = NULL WHERE task_id = '${taskId}';`,
    );
  }

  // ── reviews ────────────────────────────────────────────────────────────────────────────────

  it('a replayed request_review turn is a receipt no-op and leaves exactly one review row', async () => {
    const root = await driveToWorking(await newRoot());
    const first = await turn(root.taskId, 1, { kind: 'request_review', reviewer: 'qa' });
    expect(first.alreadyApplied).toBe(false);
    expect(first.task?.status).toBe('waiting_for_review');
    expect(await reviewRows(root.taskId)).toHaveLength(1);

    const replay = await turn(root.taskId, 1, { kind: 'request_review', reviewer: 'qa' });
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.task).toBeNull();
    expect(await reviewRows(root.taskId)).toHaveLength(1);
  });

  it('the review row carries its turn number — the key the receipt uses', async () => {
    const root = await driveToWorking(await newRoot());
    await turn(root.taskId, 1, { kind: 'request_review', reviewer: 'qa' });
    expect(await reviewRows(root.taskId)).toEqual([
      { id: expect.any(String), round: 1, turn_number: 1 },
    ]);
  });

  it('the database REFUSES a second review row for one (task, turn), and onConflictDoNothing makes it a clean no-op', async () => {
    const root = await newRoot();
    await tdb().insert(schema.workforceReviews, {
      taskId: root.taskId,
      reviewer: 'qa',
      round: 1,
      turnNumber: 7,
    });

    // A bare second insert is a REAL unique violation (SQLSTATE 23505) — the constraint is in the
    // database, not in a read the application chose to perform first. Note the different `round`:
    // this is the shape a replay actually presents, and a (tenant, task, round) UNIQUE would let
    // it through.
    expect(
      await refusalCode(
        tdb().insert(schema.workforceReviews, {
          taskId: root.taskId,
          reviewer: 'qa',
          round: 2,
          turnNumber: 7,
        }),
      ),
    ).toBe('23505');

    // The production shape: the conflict is absorbed, nothing is inserted, no error surfaces.
    const noop = await tdb()
      .insert(schema.workforceReviews, {
        taskId: root.taskId,
        reviewer: 'qa',
        round: 2,
        turnNumber: 7,
      })
      .onConflictDoNothing()
      .returning({ id: schema.workforceReviews.id });
    expect(noop).toHaveLength(0);
    expect(await reviewRows(root.taskId)).toHaveLength(1);
  });

  it('a replayed turn whose RECEIPT IS GONE still opens exactly one review — and a (tenant, task, round) UNIQUE would NOT have caught it', async () => {
    const root = await driveToWorking(await newRoot());
    await turn(root.taskId, 1, { kind: 'request_review', reviewer: 'qa' });
    const [firstRow] = await reviewRows(root.taskId);
    expect(firstRow).toEqual({ id: expect.any(String), round: 1, turn_number: 1 });

    await loseTheReceipt(root.taskId, 1);

    // The receipt is gone, so the turn REALLY re-applies — this is not the receipt short-circuit.
    const replay = await turn(root.taskId, 1, { kind: 'request_review', reviewer: 'qa' });
    expect(replay.alreadyApplied).toBe(false);
    expect(replay.task?.status).toBe('waiting_for_review');

    // Still exactly one row, and it is the FIRST one — the replay converged on it rather than
    // adding its own. The row the replay would have written carried round = 2 (the round counter
    // is derived from the rows that already exist), so a UNIQUE on (tenant_id, task_id, round)
    // would have admitted it. `turn_number` is what collides.
    const after = await reviewRows(root.taskId);
    expect(after).toEqual([firstRow]);
  });

  it('two review rows with NO turn number coexist — the UNIQUE is partial, exactly like the transition receipt', async () => {
    const root = await newRoot();
    await tdb().insert(schema.workforceReviews, { taskId: root.taskId, reviewer: 'qa', round: 1 });
    await tdb().insert(schema.workforceReviews, { taskId: root.taskId, reviewer: 'qa', round: 2 });
    const rows = await reviewRows(root.taskId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.turn_number)).toEqual([null, null]);
  });

  // ── approvals ──────────────────────────────────────────────────────────────────────────────

  it('a replayed request_approval turn is a receipt no-op and leaves exactly one approval row', async () => {
    const root = await driveToWorking(await newRoot());
    const first = await turn(root.taskId, 1, {
      kind: 'request_approval',
      question: 'Proceed?',
      timeoutMs: 60_000,
    });
    expect(first.alreadyApplied).toBe(false);
    expect(first.task?.status).toBe('waiting_for_user');
    expect(await approvalRows(root.taskId)).toHaveLength(1);

    const replay = await turn(root.taskId, 1, {
      kind: 'request_approval',
      question: 'Proceed?',
      timeoutMs: 60_000,
    });
    expect(replay.alreadyApplied).toBe(true);
    expect(await approvalRows(root.taskId)).toHaveLength(1);
  });

  it('the approval row carries its turn number — the key the receipt uses', async () => {
    const root = await driveToWorking(await newRoot());
    await turn(root.taskId, 1, {
      kind: 'request_approval',
      question: 'Proceed?',
      timeoutMs: 60_000,
    });
    const rows = await approvalRows(root.taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.turn_number).toBe(1);
  });

  it('the database REFUSES a second approval row for one (task, turn)', async () => {
    const root = await newRoot();
    await tdb().insert(schema.workforceApprovals, {
      taskId: root.taskId,
      question: 'Proceed?',
      approver: 'user',
      status: 'pending',
      onTimeout: 'fail',
      turnNumber: 3,
    });
    expect(
      await refusalCode(
        tdb().insert(schema.workforceApprovals, {
          taskId: root.taskId,
          question: 'Proceed again?',
          approver: 'user',
          status: 'pending',
          onTimeout: 'fail',
          turnNumber: 3,
        }),
      ),
    ).toBe('23505');
    expect(await approvalRows(root.taskId)).toHaveLength(1);
  });

  it('a replayed turn whose RECEIPT IS GONE still opens exactly one approval', async () => {
    const root = await driveToWorking(await newRoot());
    await turn(root.taskId, 1, {
      kind: 'request_approval',
      question: 'Proceed?',
      timeoutMs: 60_000,
    });
    const [firstRow] = await approvalRows(root.taskId);
    expect(firstRow?.turn_number).toBe(1);

    await loseTheReceipt(root.taskId, 1);

    const replay = await turn(root.taskId, 1, {
      kind: 'request_approval',
      question: 'Proceed?',
      timeoutMs: 60_000,
    });
    expect(replay.alreadyApplied).toBe(false);
    expect(replay.task?.status).toBe('waiting_for_user');
    expect(await approvalRows(root.taskId)).toEqual([firstRow]);
  });

  it('the out-of-turn escalation re-issue is UNCONSTRAINED — two turn-less approvals on one task coexist', async () => {
    // The approval sweep re-issues an escalated request with no turn at all; its dedupe is the
    // `status = 'pending'` compare-and-swap, not this key. This pins that turn-less rows stay
    // LEGAL — it is NOT evidence for the partial predicate, and it must not be read as such: it
    // passes under a total UNIQUE too, because Postgres treats NULLs as DISTINCT for uniqueness.
    const root = await newRoot();
    for (const question of ['Proceed?', 'Escalated: proceed?']) {
      await tdb().insert(schema.workforceApprovals, {
        taskId: root.taskId,
        question,
        approver: 'user',
        status: 'pending',
        onTimeout: 'fail',
      });
    }
    const rows = await approvalRows(root.taskId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.turn_number)).toEqual([null, null]);
  });
});
