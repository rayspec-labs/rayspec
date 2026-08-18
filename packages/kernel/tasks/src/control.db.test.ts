/**
 * OPERATOR CONTROL against real Postgres — `haltWorkforce`'s ROOT SCAN, at depth.
 *
 * Halt is the verb an operator reaches for when the workforce must STOP. Its contract
 * (control.ts's `haltWorkforce` doc comment) is that the roots read is a deliberate FULL scan
 * "because a halt that stopped at a page would leave the rest of the workforce running, which is
 * the one thing a halt may not do". This suite holds that contract on the two shapes the existing
 * coverage never reached:
 *
 *   1. DEPTH. The only other `haltWorkforce` test (task-scheduler.db.test.ts, "halt drains before
 *      it cancels") builds two sibling roots at DEPTH 1. The per-root loop, the drain-then-cancel
 *      ordering and the cascade's root-first provenance were never exercised over a three-level
 *      tree, so a halt that reached roots and their direct children but not their grandchildren
 *      would have been green.
 *
 *   2. A TERMINAL ROOT WITH LIVE DESCENDANTS. The root scan reads ROOTS ONLY
 *      (`parent_task_id IS NULL`); descendants are reached exclusively through `cancelTaskCascade`
 *      -> `cancelDescendants`. So skipping a root skips its WHOLE SUBTREE at every depth, and a
 *      halt can return having left live work running.
 *
 * That second shape is reachable on the engine's own happy path, not a contrivance. A BUFFERED
 * CREATE (`applyTurnOutcome`'s `createdChildren`) makes a child deliberately NOT bound to the
 * parent's join — engine.db.test.ts's "a live buffered child does NOT wedge the parent's next
 * fan-out join" leaves exactly that child parked while the parent's join is satisfied and the
 * parent wakes; one more ordinary turn and the parent is terminal with a live child. The engine
 * already handles the state one module over: `applyBudgetExhausted`'s escalation branches on "a
 * root that has already ended" while processing a LIVE descendant's budget denial. And
 * `#failOnDecidedDependency` (task-scheduler.ts) terminates a task with `blocked -> failed
 * (dependency_failed)` outside any fan-in — the exact pair these arms drive the root through.
 *
 * WHAT IS NOT COVERED HERE, stated rather than implied: a `working` descendant beneath a terminal
 * root at halt time. The halt drains first, so post-drain no row is `working`; `cancelDescendants`
 * would signal such a row rather than transition it (the absorb-at-turn-boundary contract), and
 * that branch is covered on the cancel path by engine.db.test.ts and cascade-locking.db.test.ts.
 * Reproducing it under a halt needs a race the drain exists to exclude.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTurnOutcome } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { workforceBudgetsSchema } from './budget.js';
import { haltWorkforce } from './control.js';
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
    'control.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

const NO_BUDGETS = workforceBudgetsSchema.parse({});

/** A halt over a quiet tree drains instantly; a low bound turns a hang into a fast, loud failure. */
const DRAIN_TIMEOUT_MS = 5_000;

describe.skipIf(!hasDb)('operator control — halt (db)', () => {
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

  /** `to: 'working'` STAMPS the claim with the dispatching turn's own id, exactly as `#claimTurn`. */
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

  async function rowOf(
    taskId: string,
  ): Promise<{ status: string; status_reason: string | null; version: number }> {
    const rows = (await db.$client.unsafe(
      `SELECT status, status_reason, version FROM workforce_tasks WHERE task_id = '${taskId}';`,
    )) as unknown as { status: string; status_reason: string | null; version: number }[];
    return rows[0] as { status: string; status_reason: string | null; version: number };
  }

  /**
   * root -> middle -> leaf, built by two REAL fan-out rounds, left QUIET: nothing is `working`.
   *
   * This is cascade-locking.db.test.ts's `threeDeep()` with one deliberate difference. That helper
   * ends by driving the middle task back to `working` (turn 2), because its suite needs a subtree
   * walked from the top by a cancel and from the middle by a live turn. A halt cannot use that
   * shape: `haltWorkforce` pauses WITH DRAIN, and the drain polls `workingCount` until no row is
   * `working` — a `working` middle would block every arm here for the drain timeout and then throw
   * `WorkforceDrainTimeoutError`, testing the drain instead of the scan. So the middle is left at
   * `queued` (`working -> queued` is the state machine's normal end-of-non-terminal-turn move).
   *
   * Resulting shape: root `blocked(awaiting_children)` -> middle `queued` -> leaf `planned`.
   */
  async function threeDeepQuiet(
    title = 'Root',
  ): Promise<{ root: string; middle: string; leaf: string }> {
    const rootTask = await createRootTask(tdb(), {
      workforceId: 'wf',
      title,
      goal: 'Drive the halt.',
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
    // The middle out of `working` so the halt's drain returns immediately. This is the ONE
    // statement that differs from `threeDeep()`.
    await driveTo(middle, 'queued');
    return { root: rootTask.taskId, middle, leaf };
  }

  /**
   * Terminate a root through the SINGLE STATUS WRITER with a legal move — `blocked -> failed`
   * carrying `dependency_failed`, the exact status+reason pair `#failOnDecidedDependency` writes
   * (task-scheduler.ts). Nothing is hand-written into the row: the shape under test is one
   * `applyTransition` produces, not a corrupted row a test invented.
   */
  async function failRoot(rootId: string): Promise<void> {
    const before = await rowOf(rootId);
    await applyTransition(tdb(), {
      taskId: rootId,
      expectedVersion: before.version,
      to: 'failed',
      reason: 'dependency_failed',
      actor: 'scheduler',
    });
  }

  function halt(reason = 'maintenance window') {
    return haltWorkforce(tdb(), {
      workforceId: 'wf',
      actor: 'operator',
      reason,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });
  }

  async function haltedEventCount(): Promise<number> {
    const rows = await db.$client.unsafe(
      "SELECT (data->>'affectedTaskCount')::int AS n FROM run_events WHERE run_id = 'workforce:wf' AND type = 'workforce.control.halted';",
    );
    return (rows[0] as { n: number }).n;
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Clause 1b — the terminal-root skip. A halt must not spare a live subtree.
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('cancels the LIVE SUBTREE beneath a root that has already gone terminal', async () => {
    const { root, middle, leaf } = await threeDeepQuiet();
    await failRoot(root);
    expect((await rowOf(root)).status).toBe('failed');

    const outcome = await halt();

    // The root scan reads roots only, so a skipped root is a skipped SUBTREE — at every depth.
    expect(
      { middle: (await rowOf(middle)).status, leaf: (await rowOf(leaf)).status },
      'the halt returned with live work still running beneath a terminal root: the root scan ' +
        'skips terminal roots, and descendants are only ever reached THROUGH their root',
    ).toEqual({ middle: 'cancelled', leaf: 'cancelled' });
    expect((await rowOf(middle)).status_reason).toBe('cancelled_by_parent');
    expect((await rowOf(leaf)).status_reason).toBe('cancelled_by_parent');
    expect(outcome.cancelled).toEqual(expect.arrayContaining([middle, leaf]));
    expect(outcome.signalled).toEqual([]);
  });

  it('leaves the terminal root itself untouched — no second status write, no version bump', async () => {
    const { root } = await threeDeepQuiet();
    await failRoot(root);
    const before = await rowOf(root);

    await halt();

    // `applyTransition` is the single status writer and the three terminal rows of
    // ALLOWED_TRANSITIONS are all-false, so re-terminalising a terminal root is a write the state
    // machine must refuse. The VERSION is the load-bearing half of this assertion: a stray write
    // that happened to land on the same status would still bump it.
    expect(
      await rowOf(root),
      'the halt wrote to a row that was already terminal — the cascade must visit a terminal ' +
        "root's descendants without touching the root",
    ).toEqual(before);
    const transitions = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_transitions WHERE task_id = '${root}' AND to_status = 'cancelled';`,
    );
    expect((transitions[0] as { c: number }).c).toBe(0);
  });

  it('reports what it actually cancelled: the halt event counts the subtree, not zero', async () => {
    const { root } = await threeDeepQuiet();
    await failRoot(root);

    await halt();

    // An operator reads this number. A halt that cancelled two tasks and journaled `0` is its own
    // defect even once the rows are right.
    expect(await haltedEventCount()).toBe(2);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Clause 1a — the halt cascade past depth 1.
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('cancels a THREE-LEVEL tree, root-first — not just the root and its direct child', async () => {
    const { root, middle, leaf } = await threeDeepQuiet();

    const outcome = await halt();

    expect({
      root: (await rowOf(root)).status,
      middle: (await rowOf(middle)).status,
      leaf: (await rowOf(leaf)).status,
    }).toEqual({ root: 'cancelled', middle: 'cancelled', leaf: 'cancelled' });
    // PROVENANCE, not just outcome: the root was cancelled by the operator and the two below it BY
    // THEIR PARENT, which is what makes this a root-first cascade rather than three independent
    // cancellations that happened to land.
    expect((await rowOf(root)).status_reason).toBe('cancelled_by_user');
    expect((await rowOf(middle)).status_reason).toBe('cancelled_by_parent');
    expect((await rowOf(leaf)).status_reason).toBe('cancelled_by_parent');
    expect(outcome.cancelled).toEqual(expect.arrayContaining([root, middle, leaf]));
    expect(await haltedEventCount()).toBe(3);
  });

  it('walks EVERY root: depth in the first subtree does not end the scan before the second', async () => {
    const { root, middle, leaf } = await threeDeepQuiet('Deep root');
    const shallow = await createRootTask(tdb(), {
      workforceId: 'wf',
      title: 'Shallow root',
      goal: 'A second, independent root.',
      owner: 'coordinator',
      requestedBy: 'user',
    });
    await driveTo(shallow.taskId, 'queued');

    const outcome = await halt();

    expect(outcome.cancelled).toEqual(expect.arrayContaining([root, middle, leaf, shallow.taskId]));
    expect((await rowOf(shallow.taskId)).status).toBe('cancelled');
    expect((await rowOf(leaf)).status).toBe('cancelled');
    const live = await db.$client.unsafe(
      "SELECT count(*)::int AS c FROM workforce_tasks WHERE workforce_id = 'wf' AND status NOT IN ('completed', 'failed', 'cancelled');",
    );
    expect(
      (live[0] as { c: number }).c,
      'a halt that leaves ANY non-terminal task in the workforce did not halt the workforce',
    ).toBe(0);
    expect(await haltedEventCount()).toBe(4);
  });

  it('handles a terminal-rooted subtree and a live-rooted subtree in ONE halt', async () => {
    const dead = await threeDeepQuiet('Dead root');
    await failRoot(dead.root);
    const live = await threeDeepQuiet('Live root');

    const outcome = await halt();

    // The whole point of the shape an operator actually has: both kinds of root in one workforce.
    expect({
      deadRoot: (await rowOf(dead.root)).status,
      deadMiddle: (await rowOf(dead.middle)).status,
      deadLeaf: (await rowOf(dead.leaf)).status,
      liveRoot: (await rowOf(live.root)).status,
      liveMiddle: (await rowOf(live.middle)).status,
      liveLeaf: (await rowOf(live.leaf)).status,
    }).toEqual({
      deadRoot: 'failed',
      deadMiddle: 'cancelled',
      deadLeaf: 'cancelled',
      liveRoot: 'cancelled',
      liveMiddle: 'cancelled',
      liveLeaf: 'cancelled',
    });
    expect(outcome.cancelled).toEqual(
      expect.arrayContaining([dead.middle, dead.leaf, live.root, live.middle, live.leaf]),
    );
    expect(outcome.cancelled).not.toContain(dead.root);
    const stillLive = await db.$client.unsafe(
      "SELECT count(*)::int AS c FROM workforce_tasks WHERE workforce_id = 'wf' AND status NOT IN ('completed', 'failed', 'cancelled');",
    );
    expect((stillLive[0] as { c: number }).c).toBe(0);
    expect(await haltedEventCount()).toBe(5);
  });

  it('drains BEFORE it cancels, over a deep tree: the pause is journaled before the first cancel', async () => {
    const { root, middle, leaf } = await threeDeepQuiet();

    // No `WorkforceDrainTimeoutError`: a quiet tree drains at once, and a halt that hung here
    // would fail loudly inside DRAIN_TIMEOUT_MS rather than silently doing the right thing late.
    await expect(halt()).resolves.toBeDefined();

    const pausedAt = await db.$client.unsafe(
      "SELECT created_at FROM run_events WHERE run_id = 'workforce:wf' AND type = 'workforce.control.paused' ORDER BY seq LIMIT 1;",
    );
    const firstCancel = await db.$client.unsafe(
      `SELECT min(created_at) AS at FROM workforce_task_transitions WHERE to_status = 'cancelled' AND task_id IN ('${root}', '${middle}', '${leaf}');`,
    );
    // `unsafe` hands timestamps back untyped, so both sides are normalized before comparison —
    // otherwise this arm compares strings and passes for the wrong reason.
    const pausedMs = new Date((pausedAt[0] as { created_at: string }).created_at).getTime();
    const firstCancelMs = new Date((firstCancel[0] as { at: string }).at).getTime();
    expect(Number.isNaN(pausedMs) || Number.isNaN(firstCancelMs)).toBe(false);
    expect(
      pausedMs,
      'the cancel cascade ran before the pause was journaled — halt is pause-with-drain THEN cancel',
    ).toBeLessThanOrEqual(firstCancelMs);
    // …and the pause that ran was the DRAINING one.
    const drained = await db.$client.unsafe(
      "SELECT (data->>'drain') AS drain FROM run_events WHERE run_id = 'workforce:wf' AND type = 'workforce.control.paused' ORDER BY seq LIMIT 1;",
    );
    expect((drained[0] as { drain: string }).drain).toBe('true');
  });
});
