/**
 * THE ENGINE'S LOCK RANKS against real Postgres — the interleavings a single-threaded suite never
 * reaches, driven deterministically by parking one operation on a row lock a third session holds.
 *
 * The declared order (apply-intents.ts's module header, restated at task-scheduler.ts:1127-1133 and
 * docs/workforce-architecture.md:191-193) is four ranks, and this file covers all four:
 *
 *   1. INTRA-TASK, root-first: ancestors before the task, the task before its descendants, ties by
 *      id. root -> middle(working) -> leaf: the middle task's completing turn cascades DOWN into the
 *      leaf and fans IN to the root, while an operator cancel of the root cascades down into the
 *      same leaf. Locked in opposite orders these two wait on each other and Postgres kills one —
 *      the cascade 500s wholesale, or the turn dies and its dispatch reservation leaks. One
 *      documented root-first order makes them QUEUE instead. (Plus: a cancel racing the reserve
 *      pass's `planned -> queued` promotion completes instead of throwing the whole cascade away.)
 *   2. `workforce_tasks` -> `workforce_budget_ledger`: BOTH halves of the task order before the
 *      FIRST ledger row, so a cascading turn is never a tasks -> ledger -> tasks acquisition.
 *   3. `workforce_runtime` -> `workforce_tasks`: the dispatcher's claim transaction establishes it
 *      and every path touching both row types follows.
 *   4. INTRA-LEDGER scope order: `task < root < department < workforce`, then scope id, then window.
 *
 * DEADLOCK ABSENCE IS ASSERTED, NOT INFERRED. Every race here settles both sides and checks the
 * Postgres SQLSTATE: `40P01` (deadlock_detected) must never be raised. "Both promises resolved" is a
 * weaker claim — it cannot distinguish "the rank held" from "the interleaving never formed" — so the
 * arming step additionally proves each side really PARKED on a lock (`waitForBlocked`) before the
 * holder lets go.
 */
import { schema } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTurnOutcome, lockRootFirst } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { authorizeTurn, releaseTurnReservation, workforceBudgetsSchema } from './budget.js';
import { cancelTaskCascade } from './control.js';
import { createRootTask } from './create-task.js';
import { ensureWorkforceRuntime } from './runtime.js';
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

/** `deadlock_detected` — what Postgres raises on the victim when it finds a lock cycle. */
const DEADLOCK_SQLSTATE = '40P01';

/**
 * The SQLSTATE carried by `err` or a bounded `.cause`-chain ancestor.
 *
 * The driver (postgres.js) puts the code on a `PostgresError`; drizzle-orm then WRAPS that in a
 * `DrizzleQueryError` that carries NO code of its own, so the code must be found by WALKING the
 * cause chain — the same bounded, cycle-safe shape packages/kernel/db/src/pg-errors.ts uses for
 * 23505/23503/55P03. Duplicated here rather than exported from @rayspec/db on purpose: this suite is
 * the only consumer, and a new exported detector would be a production change in a test-only PR.
 */
function pgSqlState(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let node: unknown = err;
  for (let depth = 0; depth < 5 && node !== null && typeof node === 'object'; depth++) {
    if (seen.has(node)) return undefined;
    seen.add(node);
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Settle every side of a race and REFUSE `40P01` explicitly.
 *
 * This is the assertion the suite used to leave implicit. A deadlock victim rejects, so
 * `await expect(p).resolves.*` does catch it — but only as "something threw", which reads in CI as a
 * flake rather than as "the two sides took the shared rows in OPPOSITE orders and Postgres killed
 * one". Naming the SQLSTATE makes the lock-rank regression self-describing, and it distinguishes a
 * genuine no-deadlock from a run that got lucky on timing (the `waitForBlocked` arming is the other
 * half of that: it proves both sides really parked before the holder released).
 *
 * Leaves the promises settled, so the caller's own `resolves` / value assertions run afterwards
 * against already-settled promises and still report the underlying error for a NON-deadlock failure.
 */
async function expectNoDeadlock(sides: Readonly<Record<string, Promise<unknown>>>): Promise<void> {
  const names = Object.keys(sides);
  const results = await Promise.allSettled(Object.values(sides));
  const victims = results.flatMap((result, i) =>
    result.status === 'rejected' && pgSqlState(result.reason) === DEADLOCK_SQLSTATE
      ? [`${names[i]}: ${String(result.reason)}`]
      : [],
  );
  expect(
    victims,
    `Postgres raised SQLSTATE ${DEADLOCK_SQLSTATE} (deadlock detected): the sides of this race ` +
      'acquired their shared rows in OPPOSITE orders and one was killed. That is the lock-rank ' +
      'regression this suite exists to catch, not a flake.',
  ).toEqual([]);
}

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

  /** The dispatch id a turn claims under — the same id its application then presents. */
  function turnIdFor(taskId: string, turnNumber: number): string {
    return `wf-task-turn:${taskId}:${turnNumber}`;
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

  /**
   * `to: 'working'` STAMPS the claim with the dispatching turn's own id, exactly as `#claimTurn`
   * does — an application refuses to apply over a claim it does not own.
   */
  async function driveTo(
    taskId: string,
    to: 'queued' | 'working',
    turnNumber = 1,
  ): Promise<TaskRecord> {
    const rows = (await db.$client.unsafe(
      `SELECT version FROM workforce_tasks WHERE task_id = '${taskId}';`,
    )) as unknown as { version: number }[];
    return applyTransition(tdb(), {
      taskId,
      expectedVersion: (rows[0] as { version: number }).version,
      to,
      actor: 'scheduler',
      ...(to === 'working' ? { turnId: turnIdFor(taskId, turnNumber) } : {}),
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
    await driveTo(middle, 'working', 2);
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

  /**
   * Hold ONE budget-ledger row's lock on a separate session. The row must already exist for a
   * `FOR UPDATE` to hold anything, so the caller materializes the scope set first.
   */
  async function holdLedgerRow(scopeKind: string, scopeId: string): Promise<() => Promise<void>> {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken: () => void = () => {};
    const acquired = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const session = holder.$client.begin(async (sql) => {
      const rows =
        await sql`SELECT id FROM workforce_budget_ledger WHERE scope_kind = ${scopeKind} AND scope_id = ${scopeId} FOR UPDATE`;
      if (rows.length === 0) throw new Error(`no ${scopeKind} ledger row for ${scopeId} to hold`);
      taken();
      await held;
    });
    await acquired;
    return async () => {
      release();
      await session;
    };
  }

  /**
   * Hold the WORKFORCE RUNTIME row's lock on a separate session. The row must already exist — the
   * `ensureWorkforceRuntime` upsert takes the existing row's lock on its conflict path, but with no
   * row present it simply INSERTs and blocks on nothing.
   */
  async function holdRuntimeRow(workforceId: string): Promise<() => Promise<void>> {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken: () => void = () => {};
    const acquired = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const session = holder.$client.begin(async (sql) => {
      const rows =
        await sql`SELECT id FROM workforce_runtime WHERE workforce_id = ${workforceId} FOR UPDATE`;
      if (rows.length === 0) throw new Error(`no runtime row for ${workforceId} to hold`);
      taken();
      await held;
    });
    await acquired;
    return async () => {
      release();
      await session;
    };
  }

  /** Materialize a task's canonical ledger scope rows without reserving anything. */
  async function materializeLedgerScopes(taskId: string, rootTaskId: string): Promise<void> {
    await tdb().transaction(async (tx) => {
      await releaseTurnReservation(tx, NO_BUDGETS, {
        taskId,
        rootTaskId,
        workforceId: 'wf',
        department: null,
        estimateUsd: 0,
      });
    });
  }

  /**
   * A claim transaction shaped exactly like the dispatcher's `#claimTurn`: the runtime row, then
   * the task row's compare-and-swap, then the ledger rows in canonical scope order.
   */
  async function claimTurnFor(taskId: string, rootTaskId: string): Promise<void> {
    const rows = (await db.$client.unsafe(
      `SELECT version FROM workforce_tasks WHERE task_id = '${taskId}';`,
    )) as unknown as { version: number }[];
    const expectedVersion = (rows[0] as { version: number }).version;
    await tdb().transaction(async (tx) => {
      await ensureWorkforceRuntime(tx, 'wf');
      await applyTransition(tx, {
        taskId,
        expectedVersion,
        to: 'working',
        actor: 'scheduler',
        turnId: turnIdFor(taskId, 1),
      });
      await authorizeTurn(tx, NO_BUDGETS, {
        taskId,
        rootTaskId,
        workforceId: 'wf',
        department: null,
        estimateUsd: 0,
      });
    });
  }

  /**
   * A DENIED-CLAIM PARK transaction, shaped exactly like the dispatcher's `#parkDenied`
   * (task-scheduler.ts:1259-1272): the runtime row first (`ensureWorkforceRuntime`), then the task
   * rows root-first (`lockRootFirst`) — the second composite `runtime -> tasks` shape in the engine,
   * beside `claimTurnFor`'s claim shape and the reaper's release shape (task-scheduler.ts:944-955).
   * Both halves are the REAL engine primitives; only the composition lives here, exactly as
   * `claimTurnFor` mirrors `#claimTurn`.
   */
  async function parkDeniedFor(taskId: string): Promise<TaskRecord> {
    return tdb().transaction(async (tx) => {
      const snapshot = (
        (await tx
          .select(schema.workforceTasks)
          .where(eq(schema.workforceTasks.taskId, taskId))) as TaskRecord[]
      )[0] as TaskRecord;
      await ensureWorkforceRuntime(tx, 'wf');
      return lockRootFirst(tx, snapshot);
    });
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
    await expectNoDeadlock({
      'the completing turn': completingTurn,
      'the operator cancel': operatorCancel,
    });
    await expect(completingTurn).resolves.toBeDefined();
    await expect(operatorCancel).resolves.toBeDefined();

    expect(await statusOf(middle)).toBe('cancelled');
    expect(await statusOf(leaf)).toBe('cancelled');
    expect(await statusOf(root)).toBe('cancelled');
  });

  it('a cancelling turn and a descendant claim QUEUE: the turn takes no ledger row before its task locks', async () => {
    const { root, middle, leaf } = await threeDeep();
    await driveTo(leaf, 'queued');
    // The leaf's own scope rows have to EXIST for a third session to hold one of them.
    await materializeLedgerScopes(leaf, root);
    // The middle task's turn will absorb this cancel, so its plan cascades DOWN into the leaf.
    await deliverSignal(tdb(), {
      taskId: middle,
      kind: 'cancel',
      signalKey: `cancel:${middle}`,
      actor: 'user',
    });

    // The claim parks on its FIRST ledger row (task scope, canonical rank 0) holding the leaf's
    // TASK row — the wrong-order half of the cycle is now armed and waiting.
    const releaseLedger = await holdLedgerRow('task', leaf);
    const claim = claimTurnFor(leaf, root);
    await waitForBlocked(1);

    // The cancelling turn wants that same leaf task row. Taking the subtree's ledger rows first
    // (settle, then cascade) makes this tasks -> ledger -> tasks: the claim then wants the `root:`
    // ledger row the turn is sitting on, Postgres finds the cycle, and one of them is killed — the
    // cancel 500s having cancelled nothing, or the turn dies leaking its reservation.
    const cancellingTurn = turn(middle, 2, { kind: 'complete', result: RESULT });
    await waitForBlocked(2);

    await releaseLedger();
    await expectNoDeadlock({
      'the descendant claim': claim,
      'the cancelling turn': cancellingTurn,
    });
    await expect(claim).resolves.toBeUndefined();
    await expect(cancellingTurn).resolves.toBeDefined();

    expect(await statusOf(middle)).toBe('cancelled');
    // The leaf won its claim, so the cascade signalled it rather than cancelling it mid-turn.
    expect(await statusOf(leaf)).toBe('working');
    const signalled = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_signals WHERE task_id = '${leaf}' AND kind = 'cancel';`,
    );
    expect(signalled[0]?.c).toBe(1);
  });

  it('a turn whose PLAN fans in takes the root-first locks, whatever its intent looked like', async () => {
    // A schema-valid `request_approval` the PLANNER rejects: `onTimeout: 'escalate'` with no
    // `escalateTo` parses (the field is optional) and plans `invalid_intent`. After a prior
    // tool error its fate is `fail` — which fans in to the parent. An exemption granted on the
    // INTENT hands that turn the single-row fast path and no root-first lock at all.
    const MALFORMED_APPROVAL = {
      kind: 'request_approval',
      question: 'Publish the statement?',
      timeoutMs: 60_000,
      onTimeout: 'escalate',
    };
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
      children: [{ title: 'Child', goal: 'Child work.', owner: 'worker-child' }],
    });
    const child = await childOf(rootTask.taskId);

    // Turn 1 leaves the child re-queued with the typed tool_error receipt…
    await driveTo(child, 'queued');
    await driveTo(child, 'working');
    const first = await turn(child, 1, MALFORMED_APPROVAL);
    expect(first.plan).toMatchObject({ kind: 'invalid_intent', fate: 'requeue' });
    expect(await statusOf(child)).toBe('queued');
    // …so THIS turn's fate is terminal, and a terminal child fans in to its parent.
    await driveTo(child, 'working', 2);

    // The turn parks inside `afterTaskTerminal`, holding the child row, one statement short of
    // wanting the parent.
    const release = await holdDelegationOf(child);
    const failingTurn = turn(child, 2, MALFORMED_APPROVAL);
    await waitForBlocked(1);
    // The operator cancel walks the same subtree from the top: it holds the parent and wants the
    // child. Without the root-first locks these two wait on each other and Postgres kills one.
    const operatorCancel = cancelTaskCascade(tdb(), { taskId: rootTask.taskId, actor: 'user' });
    await waitForBlocked(2);

    await release();
    await expectNoDeadlock({
      'the failing turn': failingTurn,
      'the operator cancel': operatorCancel,
    });
    await expect(failingTurn).resolves.toBeDefined();
    await expect(operatorCancel).resolves.toBeDefined();
    expect(await statusOf(child)).toBe('failed');
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
    // The RAW attempt is kept so the deadlock check can see its rejection: the `.catch` below
    // deliberately swallows a lost compare-and-swap (both outcomes are fine here), and swallowing a
    // 40P01 with it would hide exactly what this suite is for.
    const promotionAttempt = applyTransition(tdb(), {
      taskId: leaf,
      expectedVersion: plannedVersion,
      to: 'queued',
      actor: 'scheduler',
    });
    const promotion = promotionAttempt
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
    await expectNoDeadlock({
      'the cancel cascade': cancel,
      'the reserve-pass promotion': promotionAttempt,
    });
    // Before the subtree was locked root-first, the cascade applied the leaf's stale version here and
    // the whole cancel threw TaskVersionConflictError — a 500 that cancelled nothing below.
    const outcome = await cancel;
    expect(outcome.cancelled).toContain(root);
    expect(outcome.cancelled).toContain(middle);
    expect(outcome.cancelled).toContain(leaf);
    expect(await statusOf(leaf)).toBe('cancelled');
    await promotion;
  });

  it('a claim and a denied-claim park QUEUE: the runtime row is taken before any task row', async () => {
    // RANK 3, `workforce_runtime -> workforce_tasks`. A cycle here needs BOTH shared rows: the one
    // runtime row of a workforce, and one task row. Two independent roots in the SAME workforce give
    // exactly that, one task row per round.
    const first = await createRootTask(tdb(), {
      workforceId: 'wf',
      title: 'First',
      goal: 'Race the runtime row.',
      owner: 'worker-a',
      requestedBy: 'user',
    });
    const second = await createRootTask(tdb(), {
      workforceId: 'wf',
      title: 'Second',
      goal: 'Race the runtime row the other way round.',
      owner: 'worker-b',
      requestedBy: 'user',
    });
    await driveTo(first.taskId, 'queued');
    await driveTo(second.taskId, 'queued');
    // The row must EXIST before a third session can hold it: an upsert with no row present INSERTs
    // and blocks on nothing.
    await ensureWorkforceRuntime(tdb(), 'wf');

    /**
     * One round: park `firstWaiter` on the held runtime row, park `secondWaiter` behind it, release.
     *
     * The arming is what makes the failure mode reachable at all. Both sides queue on the runtime
     * row holding NO task row, so when the holder lets go they simply serialize. Had the SECOND
     * waiter taken its task row first, it would be sitting on that row while waiting for the runtime
     * row — and the first waiter, on acquiring the runtime row, would want the same task row.
     * That is the cycle, and Postgres kills one of them with 40P01.
     */
    async function raceOnTheRuntimeRow(
      label: string,
      firstWaiter: () => Promise<unknown>,
      secondWaiter: () => Promise<unknown>,
    ): Promise<void> {
      const releaseRuntime = await holdRuntimeRow('wf');
      const a = firstWaiter();
      await waitForBlocked(1);
      const b = secondWaiter();
      await waitForBlocked(2);
      await releaseRuntime();
      await expectNoDeadlock({ [`${label} (first waiter)`]: a, [`${label} (second waiter)`]: b });
      await a;
      await b;
    }

    // Round 1 puts the PARK shape second, round 2 puts the CLAIM shape second — so an inversion in
    // EITHER composite shape closes the cycle in one of the two rounds.
    await raceOnTheRuntimeRow(
      'claim then park',
      () => claimTurnFor(first.taskId, first.taskId),
      () => parkDeniedFor(first.taskId),
    );
    await raceOnTheRuntimeRow(
      'park then claim',
      () => parkDeniedFor(second.taskId),
      () => claimTurnFor(second.taskId, second.taskId),
    );

    // Both claims went through: the queue was a queue, not a casualty list.
    expect(await statusOf(first.taskId)).toBe('working');
    expect(await statusOf(second.taskId)).toBe('working');
  });

  it('an authorize and a reservation release QUEUE: ledger rows follow ONE canonical scope order', async () => {
    // RANK 4, intra-ledger: `task < root < department < workforce`, then scope id, then window
    // (budget.ts:195-200, sorted :246-251). Two sibling tasks under one root share the `root:` and
    // `workforce:` rows and differ only in their own `task:` row — the shape where a walker going
    // the other way closes a cycle against one going canonically.
    //
    // A GLOBAL inversion of SCOPE_RANK is harmless (every walker stays consistent), so the
    // regression this guards is ONE walker disagreeing: `settleTurn` or `releaseTurnReservation`
    // iterating `ledgerScopesFor(...)` in reverse, e.g. "release from the widest scope down".
    const { root, middle, leaf } = await threeDeep();
    await materializeLedgerScopes(leaf, root);
    await materializeLedgerScopes(middle, root);

    const releaseLedger = await holdLedgerRow('root', root);
    // The authorize parks on `root:` holding `task:leaf` — canonical rank 0 taken, rank 1 wanted.
    const authorize = authorizeTurn(tdb(), NO_BUDGETS, {
      taskId: leaf,
      rootTaskId: root,
      workforceId: 'wf',
      department: null,
      estimateUsd: 0,
    });
    await waitForBlocked(1);
    // The release parks behind it holding `task:middle`. Walking the scopes the other way, it would
    // hold `workforce:` here instead — and the authorize, once past `root:`, wants exactly that.
    const reservationRelease = tdb().transaction((tx) =>
      releaseTurnReservation(tx, NO_BUDGETS, {
        taskId: middle,
        rootTaskId: root,
        workforceId: 'wf',
        department: null,
        estimateUsd: 0,
      }),
    );
    await waitForBlocked(2);

    await releaseLedger();
    await expectNoDeadlock({
      'the authorize': authorize,
      'the reservation release': reservationRelease,
    });
    await expect(authorize).resolves.toMatchObject({ allowed: true });
    await reservationRelease;

    // The authorize really ran under the contended row: a dispatched turn is a spent turn, counted
    // on every scope it drew from.
    const counted = (await db.$client.unsafe(
      `SELECT scope_kind, settled_turns FROM workforce_budget_ledger
         WHERE (scope_kind = 'task' AND scope_id = '${leaf}')
            OR (scope_kind = 'root' AND scope_id = '${root}')
            OR (scope_kind = 'workforce' AND scope_id = 'wf')
         ORDER BY scope_kind;`,
    )) as unknown as { scope_kind: string; settled_turns: number }[];
    expect(counted.map((r) => [r.scope_kind, r.settled_turns])).toEqual([
      ['root', 1],
      ['task', 1],
      ['workforce', 1],
    ]);
  });
});
