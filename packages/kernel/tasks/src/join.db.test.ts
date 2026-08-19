/**
 * CHILD-RESULT DETERMINISM at the DATABASE layer — the wiring the pure suite cannot reach.
 *
 * `join.test.ts:136` proves `mergeChildResults` is order-independent by shuffling an IN-MEMORY
 * array. What it cannot prove is the wiring: `task-scheduler.ts:1289-1304` reads a parent's children
 * with `where(eq(parentTaskId, ...))` and NO `order by`, so the row order it hands the merge is
 * whatever Postgres returns — in practice the heap order, which follows the order the rows were last
 * updated, i.e. the order the children actually COMPLETED. The pure test inherits determinism from
 * the function; this one demonstrates it end to end on real rows produced by real turns.
 *
 * Two full runs, the same four children with the same four results, completed in two DIFFERENT real
 * orders. What is compared is everything the parent's next turn actually receives.
 *
 * WHY THE IDS ARE RE-KEYED TO THEIR SLOT before the comparison: a child's id is deterministic in
 * `(tenant, parent, turn, slot)` (ids.ts:19-29), but a ROOT's id is a fresh random UUID
 * (`newRootTaskId`), so two runs necessarily have different parents and therefore different child
 * ids — raw bytes could never match, for a reason that has nothing to do with ordering. The slot map
 * is a bijection fixed by the fan-out and completely independent of completion order, so re-keying
 * removes exactly the nuisance variable and leaves the ones under test: the KEY ORDER, the per-child
 * payload, and the canonicalization. The real hash ids are not let off the hook either — within each
 * run the merge is asserted to key by id in sorted order, on the ids the engine actually derived.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTurnOutcome } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { workforceBudgetsSchema } from './budget.js';
import { createRootTask } from './create-task.js';
import { deterministicChildTaskId } from './ids.js';
import { mergeChildResults } from './join.js';
import { isTaskStatus, isTerminalStatus } from './status.js';
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
    'join.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

const NO_BUDGETS = workforceBudgetsSchema.parse({});

/** Four children whose results DIFFER, so the merged bytes are sensitive to which slot is which. */
const CHILDREN = [
  { title: 'Alpha', goal: 'Draft the intro.', owner: 'writer-a' },
  { title: 'Bravo', goal: 'Check the numbers.', owner: 'analyst-b' },
  { title: 'Charlie', goal: 'Pull the quotes.', owner: 'researcher-c' },
  { title: 'Delta', goal: 'Proof the whole thing.', owner: 'editor-d' },
] as const;

const RESULT_FOR = (slot: number) => ({
  status: 'completed',
  summary: `Slot ${slot} finished.`,
  findings: [`finding-${slot}`],
  confidence: 0.5 + slot / 10,
});

describe.skipIf(!hasDb)('merged child results at the db layer', () => {
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
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals, workforce_delegations, workforce_messages, workforce_budget_ledger, workforce_runtime, run_events CASCADE;',
    );
    await seedOrgs(db);
  });

  const tdb = () => forTenant(db, TENANT_A);

  function turnIdFor(taskId: string, turnNumber: number): string {
    return `wf-task-turn:${taskId}:${turnNumber}`;
  }

  async function versionOf(taskId: string): Promise<number> {
    const rows = (await db.$client.unsafe(
      `SELECT version FROM workforce_tasks WHERE task_id = '${taskId}';`,
    )) as unknown as { version: number }[];
    return (rows[0] as { version: number }).version;
  }

  async function driveToWorking(taskId: string, turnNumber = 1): Promise<void> {
    const queued = await applyTransition(tdb(), {
      taskId,
      expectedVersion: await versionOf(taskId),
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

  /**
   * One whole run: fan four children out of a fresh root, then complete them through REAL turns in
   * `completionOrder` (slot indices). Returns the parent's child ids by slot and the children as the
   * scheduler reads them — same predicate, same absence of an `order by`.
   */
  async function runWithCompletionOrder(completionOrder: readonly number[]): Promise<{
    childIdBySlot: string[];
    rows: TaskRecord[];
  }> {
    const root = await createRootTask(tdb(), {
      workforceId: 'wf',
      title: 'Root',
      goal: 'Fan out and merge.',
      owner: 'coordinator',
      requestedBy: 'user',
    });
    await driveToWorking(root.taskId);
    await applyTurnOutcome(tdb(), {
      taskId: root.taskId,
      turnId: turnIdFor(root.taskId, 1),
      turnNumber: 1,
      intent: { kind: 'fan_out', children: [...CHILDREN] },
      budgets: NO_BUDGETS,
    });
    const childIdBySlot = CHILDREN.map((_child, slot) =>
      deterministicChildTaskId(TENANT_A, root.taskId, 1, slot),
    );

    for (const slot of completionOrder) {
      const childId = childIdBySlot[slot] as string;
      await driveToWorking(childId);
      await applyTurnOutcome(tdb(), {
        taskId: childId,
        turnId: turnIdFor(childId, 1),
        turnNumber: 1,
        intent: { kind: 'complete', result: RESULT_FOR(slot) },
        budgets: NO_BUDGETS,
        actualUsd: 0,
      });
    }

    // The scheduler's own read (task-scheduler.ts:1289-1292): the parent predicate, no ordering.
    const rows = (await db.$client.unsafe(
      `SELECT * FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    )) as unknown as Record<string, unknown>[];
    const asRecords = rows.map(
      (r) =>
        ({
          taskId: r.task_id,
          status: r.status,
          statusReason: r.status_reason,
          result: r.result,
          confidence: r.confidence,
          costUsd: r.cost_usd,
          turnsUsed: r.turns_used,
        }) as unknown as TaskRecord,
    );
    return { childIdBySlot, rows: asRecords };
  }

  /** Re-key each row to its SLOT — the only difference between two runs that is not under test. */
  function bySlot(childIdBySlot: readonly string[], rows: readonly TaskRecord[]): TaskRecord[] {
    return rows.map((row) => {
      const slot = childIdBySlot.indexOf(row.taskId);
      expect(slot, `row ${row.taskId} must be one of the four fan-out children`).toBeGreaterThan(
        -1,
      );
      return { ...row, taskId: `child-${slot}` } as TaskRecord;
    });
  }

  it('two different real completion orders produce byte-identical merged results', async () => {
    const first = await runWithCompletionOrder([0, 1, 2, 3]);
    const firstSlotOrder = first.rows.map((r) => first.childIdBySlot.indexOf(r.taskId));

    // A fresh run of the SAME four children with the SAME four results, completed the other way
    // round. (The TRUNCATE is the beforeEach's; this run seeds its own root.)
    await db.$client.unsafe(
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals, workforce_delegations, workforce_budget_ledger, workforce_runtime, run_events CASCADE;',
    );
    const second = await runWithCompletionOrder([3, 1, 0, 2]);
    const secondSlotOrder = second.rows.map((r) => second.childIdBySlot.indexOf(r.taskId));

    // Every child really ended terminal in both runs, so the merge has four inputs and not fewer.
    for (const run of [first, second]) {
      expect(run.rows).toHaveLength(CHILDREN.length);
      for (const row of run.rows) {
        expect(isTaskStatus(row.status) && isTerminalStatus(row.status)).toBe(true);
      }
    }
    // The variable under test actually moved: the unordered read handed the two runs their children
    // in different orders. (If this ever stops holding, the assertion below has gone vacuous and the
    // suite must say so rather than quietly proving nothing.)
    expect(
      secondSlotOrder,
      'the unordered child read returned the same physical order for both completion orders — the ' +
        'determinism assertion below would be vacuous',
    ).not.toEqual(firstSlotOrder);

    const merged = (run: { childIdBySlot: string[]; rows: TaskRecord[] }) =>
      mergeChildResults(bySlot(run.childIdBySlot, run.rows));
    const a = merged(first);
    const b = merged(second);

    // THE LOAD-BEARING ONE. `canonicalJson` is canonicalized (join.ts:116-125 sorts every object's
    // keys, including the top level), so it is order-independent whatever the merge does — which
    // makes it a weak witness on its own. `byChildId` is NOT canonicalized, and `byChildId` is
    // precisely what the scheduler hands the parent's next turn (task-scheduler.ts:1303-1304) and
    // what the context renderer walks (workforce-tools/src/context.ts:612-613). Its key order is the
    // merge's `.sort()` and nothing else, so this is the assertion the wiring rests on.
    expect(Object.keys(b.byChildId)).toEqual(Object.keys(a.byChildId));
    expect(b.byChildId).toEqual(a.byChildId);
    expect(b.canonicalJson).toBe(a.canonicalJson);
    // Not vacuously equal: all four children, each carrying its OWN result.
    expect(Object.keys(a.byChildId)).toEqual(['child-0', 'child-1', 'child-2', 'child-3']);
    for (const [slot, key] of Object.keys(a.byChildId).entries()) {
      expect(
        (a.byChildId[key]?.result as { summary?: string } | null)?.summary,
        `slot ${slot}'s own result must ride its own key`,
      ).toBe(`Slot ${slot} finished.`);
    }
  });

  it('within one run the merge keys by REAL child id, sorted, whatever order the rows arrive in', async () => {
    const { childIdBySlot, rows } = await runWithCompletionOrder([2, 0, 3, 1]);
    // On the ids the engine actually derived — hashes, whose sort order has nothing to do with slot
    // order — so the sort in mergeChildResults is exercised on non-trivial keys.
    const sortedIds = [...childIdBySlot].sort();
    expect(Object.keys(mergeChildResults(rows).byChildId)).toEqual(sortedIds);
    // And the object the parent's turn receives does not depend on the order the read handed the
    // rows over — asserted on the KEY ORDER, which `canonicalJson` alone would hide.
    expect(Object.keys(mergeChildResults([...rows].reverse()).byChildId)).toEqual(sortedIds);
    expect(mergeChildResults([...rows].reverse()).canonicalJson).toBe(
      mergeChildResults(rows).canonicalJson,
    );
  });
});
