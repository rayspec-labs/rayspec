/**
 * The cancel cascade's LOCK ORDER against real Postgres — the interleavings a single-threaded suite
 * never reaches, driven deterministically by parking one operation on a row lock a third session
 * holds:
 *
 *   - root -> middle(working) -> leaf: the middle task's completing turn cascades DOWN into the
 *     leaf and fans IN to the root, while an operator cancel of the root cascades down into the
 *     same leaf. Locked in opposite orders these two wait on each other and Postgres kills one —
 *     the cascade 500s wholesale, or the turn dies and its dispatch reservation leaks. One
 *     documented root-first order makes them QUEUE instead;
 *   - a cancel racing the reserve pass's `planned -> queued` promotion completes (the subtree is
 *     locked before any transition, and a lost compare-and-swap retries) instead of throwing the
 *     whole cascade away.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTurnOutcome } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { workforceBudgetsSchema } from './budget.js';
import { cancelTaskCascade } from './control.js';
import { createRootTask } from './create-task.js';
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
    'cascade-locking.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

const NO_BUDGETS = workforceBudgetsSchema.parse({});
const RESULT = { status: 'completed', summary: 'Done.', confidence: 0.9 };

describe.skipIf(!hasDb)('cascade locking (db)', () => {
  let db: ReturnType<typeof makeTestDb>;
  /** A SECOND pool: the session that parks an operation mid-cascade by holding one row lock. */
  let holder: ReturnType<typeof makeTestDb>;

  beforeAll(async () => {
    db = makeTestDb();
    holder = makeTestDb();
    await resetTaskSchema(db);
    return async () => {
      await holder.$client.end();
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

  function turn(taskId: string, turnNumber: number, intent: unknown) {
    return applyTurnOutcome(tdb(), {
      taskId,
      turnId: `wf-task-turn:${taskId}:${turnNumber}`,
      turnNumber,
      intent,
      budgets: NO_BUDGETS,
    });
  }

  async function driveTo(taskId: string, to: 'queued' | 'working'): Promise<TaskRecord> {
    const rows = (await db.$client.unsafe(
      `SELECT version FROM workforce_tasks WHERE task_id = '${taskId}';`,
    )) as unknown as { version: number }[];
    return applyTransition(tdb(), {
      taskId,
      expectedVersion: (rows[0] as { version: number }).version,
      to,
      actor: 'scheduler',
    });
  }

  async function childOf(parentTaskId: string): Promise<string> {
    const rows = (await db.$client.unsafe(
      `SELECT task_id FROM workforce_tasks WHERE parent_task_id = '${parentTaskId}';`,
    )) as unknown as { task_id: string }[];
    return (rows[0] as { task_id: string }).task_id;
  }

  async function statusOf(taskId: string): Promise<string> {
    const rows = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${taskId}';`,
    );
    return rows[0]?.status as string;
  }

  /**
   * Build root -> middle -> leaf as the engine does (two fan-out rounds), then leave the middle
   * task `working`: the shape where one subtree is walked from the top by a cancel and from the
   * middle by a turn.
   */
  async function threeDeep(): Promise<{ root: string; middle: string; leaf: string }> {
    const rootTask = await createRootTask(tdb(), {
      workforceId: 'wf',
      title: 'Root',
      goal: 'Drive the cascade.',
      owner: 'coordinator',
      requestedBy: 'user',
    });
    await driveTo(rootTask.taskId, 'queued');
    await driveTo(rootTask.taskId, 'working');
    await turn(rootTask.taskId, 1, {
      kind: 'fan_out',
      children: [{ title: 'Middle', goal: 'Middle work.', owner: 'worker-middle' }],
    });
    const middle = await childOf(rootTask.taskId);
    await driveTo(middle, 'queued');
    await driveTo(middle, 'working');
    await turn(middle, 1, {
      kind: 'fan_out',
      children: [{ title: 'Leaf', goal: 'Leaf work.', owner: 'worker-leaf' }],
    });
    const leaf = await childOf(middle);
    // The middle task back into execution: its join is real, but this suite needs it mid-turn.
    await driveTo(middle, 'queued');
    await driveTo(middle, 'working');
    return { root: rootTask.taskId, middle, leaf };
  }

  /**
   * Hold ONE delegation row's lock on a separate session and return the release. Every cascade
   * touches its descendant's delegation record right after transitioning it, so this parks a
   * cascade at a precise point with its task locks already taken.
   */
  async function holdDelegationOf(childTaskId: string): Promise<() => Promise<void>> {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken: () => void = () => {};
    const acquired = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const session = holder.$client.begin(async (sql) => {
      await sql`SELECT id FROM workforce_delegations WHERE child_task_id = ${childTaskId} FOR UPDATE`;
      taken();
      await held;
    });
    await acquired;
    return async () => {
      release();
      await session;
    };
  }

  /** Backends currently waiting on a lock — how the suite knows an operation has parked. */
  async function blockedBackends(): Promise<number> {
    const rows = await db.$client.unsafe(
      'SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0;',
    );
    return (rows[0] as { c: number }).c;
  }

  async function waitForBlocked(atLeast: number, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((await blockedBackends()) >= atLeast) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no ${atLeast} blocked backend(s) within ${ms}ms`);
  }

  it('a completing turn and an operator cancel of its ancestor QUEUE instead of deadlocking', async () => {
    const { root, middle, leaf } = await threeDeep();
    // The middle task's turn will end as a cancellation (a cancel absorbed at its own boundary), so
    // it cascades DOWN into the leaf and then fans IN to the root — both directions, one transaction.
    await deliverSignal(tdb(), {
      taskId: middle,
      kind: 'cancel',
      signalKey: `cancel:${middle}`,
      actor: 'user',
    });

    const release = await holdDelegationOf(leaf);
    // The turn parks holding the middle task and the leaf, one statement short of wanting the root.
    const completingTurn = turn(middle, 2, { kind: 'complete', result: RESULT });
    await waitForBlocked(1);
    // The cancel walks the same subtree from the top and wants the leaf.
    const operatorCancel = cancelTaskCascade(tdb(), { taskId: root, actor: 'user' });
    await waitForBlocked(2);

    await release();
    // Locked in opposite orders these two wait on each other and Postgres kills one: the turn dies
    // (leaking its dispatch reservation) or the cancel 500s having changed nothing.
    await expect(completingTurn).resolves.toBeDefined();
    await expect(operatorCancel).resolves.toBeDefined();

    expect(await statusOf(middle)).toBe('cancelled');
    expect(await statusOf(leaf)).toBe('cancelled');
    expect(await statusOf(root)).toBe('cancelled');
  });

  it('a cancel racing the reserve pass completes the cascade instead of throwing it away', async () => {
    const { root, middle, leaf } = await threeDeep();
    // Park the middle task so the whole subtree is cancellable without a turn in flight.
    await applyTransition(tdb(), {
      taskId: middle,
      expectedVersion: (
        (await db.$client.unsafe(
          `SELECT version FROM workforce_tasks WHERE task_id = '${middle}';`,
        )) as unknown as { version: number }[]
      )[0]?.version as number,
      to: 'blocked',
      reason: 'awaiting_children',
      actor: 'scheduler',
    });
    const plannedVersion = (
      (await db.$client.unsafe(
        `SELECT version FROM workforce_tasks WHERE task_id = '${leaf}';`,
      )) as unknown as { version: number }[]
    )[0]?.version as number;

    const release = await holdDelegationOf(middle);
    // The cascade parks after transitioning the middle task, with the leaf still ahead of it.
    const cancel = cancelTaskCascade(tdb(), { taskId: root, actor: 'user' });
    await waitForBlocked(1);

    // The reserve pass promotes the leaf out from under the cascade's snapshot. Settled or parked —
    // both are fine; what matters is that it happens BEFORE the cascade reaches it.
    let promotionSettled = false;
    const promotion = applyTransition(tdb(), {
      taskId: leaf,
      expectedVersion: plannedVersion,
      to: 'queued',
      actor: 'scheduler',
    })
      .then(() => 'promoted')
      .catch(() => 'lost')
      .finally(() => {
        promotionSettled = true;
      });
    const deadline = Date.now() + 10_000;
    while (!promotionSettled && (await blockedBackends()) < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    await release();
    // Before the subtree was locked root-first, the cascade applied the leaf's stale version here and
    // the whole cancel threw TaskVersionConflictError — a 500 that cancelled nothing below.
    const outcome = await cancel;
    expect(outcome.cancelled).toContain(root);
    expect(outcome.cancelled).toContain(middle);
    expect(outcome.cancelled).toContain(leaf);
    expect(await statusOf(leaf)).toBe('cancelled');
    await promotion;
  });
});
