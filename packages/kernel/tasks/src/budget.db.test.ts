/**
 * The ledger's enforcement protocol against real Postgres — the invariants asserted on durable
 * ledger rows, under real concurrency, never on fakes:
 *
 *   - ceilings hold under CONCURRENT spend: N racing authorizations against one ceiling admit
 *     exactly the affordable count (the row-lock protocol closes the check-then-reserve window);
 *   - a DENIAL MUTATES NOTHING — not even the ledger rows the locking upsert would have created;
 *   - over-settlement lands once and is counted against the NEXT authorize (never truncated);
 *   - settlement releases the reservation, records the actual, and rolls the task row up;
 *   - subtree spend shares one root scope across sibling tasks.
 */
import { deriveWorkforceBudgets, WorkforceSpec } from '@rayspec/spec';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authorizeTurn, settleTurn, workforceBudgetsSchema } from './budget.js';
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
    'budget.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip an enforcement-load-bearing suite.',
  );
}

describe.skipIf(!hasDb)('budget ledger (db)', () => {
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
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_budget_ledger, run_events CASCADE;',
    );
    await seedOrgs(db);
  });

  const proposal = (
    taskId: string,
    estimateUsd: number,
    over: Partial<Record<string, string | null>> = {},
  ) => ({
    taskId,
    rootTaskId: (over.rootTaskId as string) ?? taskId,
    workforceId: over.workforceId !== undefined ? over.workforceId : 'wf',
    department: over.department !== undefined ? over.department : null,
    estimateUsd,
  });

  it('a workforce usd ceiling admits exactly the affordable turns, then denies with the typed scope', async () => {
    const tdb = forTenant(db, TENANT_A);
    const budgets = workforceBudgetsSchema.parse({
      workforce: { usd: 2.5 },
      execution: { estimateUsdPerTurn: 1 },
    });
    expect((await authorizeTurn(tdb, budgets, proposal('t1', 1))).allowed).toBe(true);
    expect((await authorizeTurn(tdb, budgets, proposal('t2', 1))).allowed).toBe(true);
    const third = await authorizeTurn(tdb, budgets, proposal('t3', 1));
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.denial).toMatchObject({
        scopeKind: 'workforce',
        scopeId: 'wf',
        ceiling: { kind: 'usd', limit: 2.5 },
        consumed: 2,
      });
    }
  });

  it('ceilings hold under CONCURRENT spend: 6 racers, usd 3, estimate 1 — exactly 3 admitted', async () => {
    const budgets = workforceBudgetsSchema.parse({
      workforce: { usd: 3 },
      execution: { estimateUsdPerTurn: 1 },
    });
    const race = Array.from({ length: 6 }, (_, i) =>
      authorizeTurn(forTenant(db, TENANT_A), budgets, proposal(`t${i}`, 1)),
    );
    const results = await Promise.all(race);
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.filter((r) => !r.allowed)).toHaveLength(3);
    const ledger = await db.$client.unsafe(
      "SELECT reserved_usd, settled_turns FROM workforce_budget_ledger WHERE scope_kind = 'workforce';",
    );
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]?.reserved_usd)).toBe(3);
    expect(ledger[0]?.settled_turns).toBe(3);
  });

  it('a denial mutates nothing — no ledger rows exist after a denied first authorize', async () => {
    const tdb = forTenant(db, TENANT_A);
    const budgets = workforceBudgetsSchema.parse({
      workforce: { usd: 0.5 },
      execution: { estimateUsdPerTurn: 1 },
    });
    const denied = await authorizeTurn(tdb, budgets, proposal('t1', 1));
    expect(denied.allowed).toBe(false);
    const rows = await db.$client.unsafe('SELECT count(*)::int AS c FROM workforce_budget_ledger;');
    expect(rows[0]?.c).toBe(0);
  });

  it('a task turns ceiling counts DISPATCHED turns and denies the one past the limit', async () => {
    const tdb = forTenant(db, TENANT_A);
    const budgets = workforceBudgetsSchema.parse({ task: { turns: 2 } });
    expect((await authorizeTurn(tdb, budgets, proposal('t1', 0))).allowed).toBe(true);
    expect((await authorizeTurn(tdb, budgets, proposal('t1', 0))).allowed).toBe(true);
    const third = await authorizeTurn(tdb, budgets, proposal('t1', 0));
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.denial).toMatchObject({
        scopeKind: 'task',
        scopeId: 't1',
        ceiling: { kind: 'turns', limit: 2 },
        consumed: 2,
      });
    }
  });

  it('settlement releases the reservation, records the actual, and rolls the task row up', async () => {
    const tdb = forTenant(db, TENANT_A);
    const budgets = workforceBudgetsSchema.parse({
      workforce: { usd: 10 },
      execution: { estimateUsdPerTurn: 1 },
    });
    const task = await createRootTask(tdb, {
      workforceId: 'wf',
      title: 'Roll-up subject',
      goal: 'Exercise settlement.',
      owner: 'user',
      requestedBy: 'user',
    });
    const p = proposal(task.taskId, 0.5);
    expect((await authorizeTurn(tdb, budgets, p)).allowed).toBe(true);
    await tdb.transaction(async (tx) => {
      await settleTurn(tx, budgets, { ...p, actualUsd: 0.3 });
    });
    const ledger = await db.$client.unsafe(
      "SELECT reserved_usd, settled_usd FROM workforce_budget_ledger WHERE scope_kind = 'workforce';",
    );
    expect(Number(ledger[0]?.reserved_usd)).toBe(0);
    expect(Number(ledger[0]?.settled_usd)).toBe(0.3);
    const row = await db.$client.unsafe(
      `SELECT cost_usd, turns_used FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(Number(row[0]?.cost_usd)).toBe(0.3);
    expect(row[0]?.turns_used).toBe(1);
  });

  it('over-settlement lands once and the NEXT authorize is the denial — never a truncation', async () => {
    const tdb = forTenant(db, TENANT_A);
    const budgets = workforceBudgetsSchema.parse({
      workforce: { usd: 1 },
      execution: { estimateUsdPerTurn: 1 },
    });
    const task = await createRootTask(tdb, {
      workforceId: 'wf',
      title: 'Overrun subject',
      goal: 'Exercise the one allowed overrun.',
      owner: 'user',
      requestedBy: 'user',
    });
    const p = proposal(task.taskId, 0.5);
    expect((await authorizeTurn(tdb, budgets, p)).allowed).toBe(true);
    // The turn actually cost 2.0 — far past the ceiling. Settlement MUST succeed (the turn already
    // ran; aborting it now would be worse), and the overrun lands in settled_usd exactly once.
    await tdb.transaction(async (tx) => {
      await settleTurn(tx, budgets, { ...p, actualUsd: 2 });
    });
    const ledger = await db.$client.unsafe(
      "SELECT settled_usd, reserved_usd FROM workforce_budget_ledger WHERE scope_kind = 'workforce';",
    );
    expect(Number(ledger[0]?.settled_usd)).toBe(2);
    expect(Number(ledger[0]?.reserved_usd)).toBe(0);
    const next = await authorizeTurn(tdb, budgets, proposal('t2', 0.1));
    expect(next.allowed).toBe(false);
    if (!next.allowed) {
      expect(next.denial).toMatchObject({
        scopeKind: 'workforce',
        ceiling: { kind: 'usd', limit: 1 },
        consumed: 2,
      });
    }
  });

  it('sibling tasks share one root scope: concurrent subtree spend holds the subtree ceiling', async () => {
    const budgets = workforceBudgetsSchema.parse({
      subtree: { usd: 2 },
      execution: { estimateUsdPerTurn: 1 },
    });
    const race = Array.from({ length: 5 }, (_, i) =>
      authorizeTurn(
        forTenant(db, TENANT_A),
        budgets,
        proposal(`child-${i}`, 1, { rootTaskId: 'root-1' }),
      ),
    );
    const results = await Promise.all(race);
    expect(results.filter((r) => r.allowed)).toHaveLength(2);
    const root = await db.$client.unsafe(
      "SELECT reserved_usd FROM workforce_budget_ledger WHERE scope_kind = 'root' AND scope_id = 'root-1';",
    );
    expect(Number(root[0]?.reserved_usd)).toBe(2);
  });

  it('windowed workforce scopes bucket by UTC day — separate rows, separate headroom', async () => {
    const tdb = forTenant(db, TENANT_A);
    const budgets = workforceBudgetsSchema.parse({
      workforce: { usd: 1, window: 'daily' },
      execution: { estimateUsdPerTurn: 1 },
    });
    const day1 = new Date('2026-08-14T09:00:00Z');
    const day2 = new Date('2026-08-15T09:00:00Z');
    expect((await authorizeTurn(tdb, budgets, proposal('t1', 1), day1)).allowed).toBe(true);
    expect((await authorizeTurn(tdb, budgets, proposal('t2', 1), day1)).allowed).toBe(false);
    // The next day's bucket has its own row and its own headroom.
    expect((await authorizeTurn(tdb, budgets, proposal('t3', 1), day2)).allowed).toBe(true);
    const rows = await db.$client.unsafe(
      "SELECT window_start FROM workforce_budget_ledger WHERE scope_kind = 'workforce' ORDER BY window_start;",
    );
    expect(rows).toHaveLength(2);
  });

  /**
   * THE FOURTH TIER, END TO END FROM A DOCUMENT. Every other subtree test in this file hand-builds
   * the engine object; this one goes through the GRAMMAR (`WorkforceSpec.parse`) and the
   * DERIVATION (`deriveWorkforceBudgets`), which is where the hole was: with no `budgets.subtree`
   * key, a declared document could not put a ceiling on the root scope at all, so `authorizeTurn`
   * admitted forever. The CONTROL arm — the byte-identical document minus the tier — is what makes
   * this a denial that previously would not have happened, rather than a denial somewhere else.
   */
  describe('a DECLARED subtree ceiling denies at the root scope', () => {
    const document = (subtree?: { usd: number }) => ({
      id: 'wf',
      name: 'WF',
      orchestrator: 'lead',
      budgets: {
        task: { usd: 1, turns: 10 }, // ⇒ estimateUsdPerTurn 0.1
        ...(subtree !== undefined ? { subtree } : {}),
      },
      employees: [{ id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' }],
    });
    const budgetsFor = (subtree?: { usd: number }) =>
      workforceBudgetsSchema.parse(deriveWorkforceBudgets(WorkforceSpec.parse(document(subtree))));
    const sibling = (n: number) => proposal(`child-${n}`, 0.1, { rootTaskId: 'root-1' });

    it('CONTROL — the same document without the tier admits both siblings', async () => {
      const tdb = forTenant(db, TENANT_A);
      const budgets = budgetsFor();
      expect(budgets.subtree).toBeUndefined();
      expect((await authorizeTurn(tdb, budgets, sibling(1))).allowed).toBe(true);
      expect((await authorizeTurn(tdb, budgets, sibling(2))).allowed).toBe(true);
    });

    it('with subtree declared the second sibling is denied at scopeKind root', async () => {
      const tdb = forTenant(db, TENANT_A);
      const budgets = budgetsFor({ usd: 0.15 });
      expect(budgets.subtree?.usd).toBe(0.15);
      expect((await authorizeTurn(tdb, budgets, sibling(1))).allowed).toBe(true);
      const second = await authorizeTurn(tdb, budgets, sibling(2));
      expect(second.allowed).toBe(false);
      if (!second.allowed) {
        expect(second.denial).toMatchObject({
          scopeKind: 'root',
          scopeId: 'root-1',
          ceiling: { kind: 'usd', limit: 0.15 },
          consumed: 0.1,
        });
      }
      // A DENIAL MUTATES NOTHING: the root row still carries only the first sibling's reservation.
      const root = await db.$client.unsafe(
        "SELECT reserved_usd FROM workforce_budget_ledger WHERE scope_kind = 'root' AND scope_id = 'root-1';",
      );
      expect(Number(root[0]?.reserved_usd)).toBe(0.1);
    });
  });

  /**
   * THE DEPARTMENT TIER, AGAINST A DATABASE AND UNDER A RACE (B-015 clause 2).
   *
   * Every arm above this one leaves `proposal()`'s `department` at its `null` default, so the
   * department scope is never even PUSHED onto the check list (`ledgerScopesFor` adds it only
   * `if (proposed.department !== null)`). The tier's only existing coverage is in the pure-unit
   * file — lock order, the absent case, the undeclared-but-visible case — none of which touches
   * Postgres and none of which contends. So the third of the four ledger tiers had never had its
   * check-then-reserve window closed by anything an executing test observed.
   *
   * WHAT MAKES THE DEPARTMENT TIER ITS OWN CASE rather than a rename of the workforce one:
   *   - it is WINDOWED (`windowStartFor(dep?.window ?? 'daily', now)`) where task and root carry
   *     the epoch sentinel, so its ledger key includes a bucket the other two contended rows do
   *     not have — a mis-bucketing splits the very row the ceiling is supposed to share, and the
   *     race would then admit every racer while every individual assertion still looked right;
   *   - it sits at SCOPE_RANK 2, between root and workforce, so it is also the tier that proves
   *     the canonical lock order holds with a windowed row in the middle of it.
   *
   * DETERMINISM: every arm passes an explicit `now`. The default would take the wall clock, and a
   * suite that races across a UTC midnight would split its own contended row and pass while
   * proving nothing.
   */
  describe('a DECLARED department ceiling binds against real rows, and holds under contention', () => {
    // Deliberately the ONLY declared ceiling. With no workforce and no subtree tier, a denial can
    // come from nowhere else — the CONTROL arm below is what turns that from a claim into a check.
    const budgets = workforceBudgetsSchema.parse({
      departments: { growth: { usd: 3 } },
      execution: { estimateUsdPerTurn: 1 },
    });
    /** One fixed instant, so every racer lands in ONE daily bucket. */
    const NOW = new Date('2026-08-14T13:00:00Z');
    const inGrowth = (taskId: string) => proposal(taskId, 1, { department: 'growth' });

    async function departmentRows(): Promise<
      Array<{ scope_id: string; reserved_usd: string; settled_turns: number; window_start: Date }>
    > {
      return (await db.$client.unsafe(
        "SELECT scope_id, reserved_usd, settled_turns, window_start FROM workforce_budget_ledger WHERE scope_kind = 'department' ORDER BY scope_id, window_start;",
      )) as unknown as Array<{
        scope_id: string;
        reserved_usd: string;
        settled_turns: number;
        window_start: Date;
      }>;
    }

    it('CONTROL — the SAME budgets deny nothing when the proposal names no department', async () => {
      const tdb = forTenant(db, TENANT_A);
      // Four turns at estimate 1 against a `usd: 3` ceiling — past it twice over. Every one is
      // admitted, because a departmentless proposal never reaches the department scope at all.
      for (const id of ['t1', 't2', 't3', 't4']) {
        expect(
          (await authorizeTurn(tdb, budgets, proposal(id, 1), NOW)).allowed,
          `${id} was denied with no department declared on the proposal`,
        ).toBe(true);
      }
      expect(await departmentRows()).toHaveLength(0);
    });

    it('admits exactly the affordable turns, then denies with the typed DEPARTMENT scope', async () => {
      const tdb = forTenant(db, TENANT_A);
      expect((await authorizeTurn(tdb, budgets, inGrowth('t1'), NOW)).allowed).toBe(true);
      expect((await authorizeTurn(tdb, budgets, inGrowth('t2'), NOW)).allowed).toBe(true);
      expect((await authorizeTurn(tdb, budgets, inGrowth('t3'), NOW)).allowed).toBe(true);
      const fourth = await authorizeTurn(tdb, budgets, inGrowth('t4'), NOW);
      expect(fourth.allowed).toBe(false);
      if (!fourth.allowed) {
        // The SCOPE is the load-bearing half: a denial that fired at the wrong tier would still
        // report `allowed: false`, and this suite's other arms would not notice.
        expect(fourth.denial).toMatchObject({
          scopeKind: 'department',
          scopeId: 'growth',
          ceiling: { kind: 'usd', limit: 3 },
          consumed: 3,
        });
      }
    });

    it('holds under CONCURRENT spend: 6 racers, usd 3, estimate 1 — exactly 3 admitted', async () => {
      const race = Array.from({ length: 6 }, (_, i) =>
        authorizeTurn(forTenant(db, TENANT_A), budgets, inGrowth(`t${i}`), NOW),
      );
      const results = await Promise.all(race);
      expect(results.filter((r) => r.allowed)).toHaveLength(3);
      expect(results.filter((r) => !r.allowed)).toHaveLength(3);
      // Every denial is the DEPARTMENT's. Three refusals could otherwise be three refusals for
      // three different reasons, which is not what a ceiling holding means.
      for (const denied of results.filter((r) => !r.allowed)) {
        if (!denied.allowed) {
          expect(denied.denial).toMatchObject({ scopeKind: 'department', scopeId: 'growth' });
        }
      }
      // ONE row, not six: the windowed key bucketed every racer together. Six rows would mean the
      // ceiling was never shared, and the "exactly 3" above would have been an accident.
      const rows = await departmentRows();
      expect(
        rows,
        'the department ledger split into more than one row — the racers did not contend on one ceiling',
      ).toHaveLength(1);
      expect(Number(rows[0]?.reserved_usd)).toBe(3);
      expect(rows[0]?.settled_turns).toBe(3);
    });

    it('one department’s spend leaves ANOTHER department’s headroom untouched', async () => {
      const tdb = forTenant(db, TENANT_A);
      const twoDepartments = workforceBudgetsSchema.parse({
        departments: { growth: { usd: 1 }, ops: { usd: 1 } },
        execution: { estimateUsdPerTurn: 1 },
      });
      expect(
        (await authorizeTurn(tdb, twoDepartments, proposal('g1', 1, { department: 'growth' }), NOW))
          .allowed,
      ).toBe(true);
      expect(
        (await authorizeTurn(tdb, twoDepartments, proposal('g2', 1, { department: 'growth' }), NOW))
          .allowed,
        'growth was still admitting past its own ceiling',
      ).toBe(false);
      // `ops` is exhausted by nothing: the ceilings are per-scope-id, not a shared pool.
      expect(
        (await authorizeTurn(tdb, twoDepartments, proposal('o1', 1, { department: 'ops' }), NOW))
          .allowed,
        "growth's spend consumed ops's headroom — the department scope id is not binding",
      ).toBe(true);
      expect((await departmentRows()).map((r) => r.scope_id)).toEqual(['growth', 'ops']);
    });

    it('the department tier is WINDOWED: a new UTC day is a new row with its own headroom', async () => {
      const tdb = forTenant(db, TENANT_A);
      const daily = workforceBudgetsSchema.parse({
        departments: { growth: { usd: 1 } },
        execution: { estimateUsdPerTurn: 1 },
      });
      const day1 = new Date('2026-08-14T09:00:00Z');
      const day2 = new Date('2026-08-15T09:00:00Z');
      expect((await authorizeTurn(tdb, daily, inGrowth('t1'), day1)).allowed).toBe(true);
      expect((await authorizeTurn(tdb, daily, inGrowth('t2'), day1)).allowed).toBe(false);
      // The next day's bucket has its own row and its own headroom. This is what distinguishes the
      // department tier from task/root, which carry the epoch sentinel and never roll over — and it
      // is what the single-row assertion in the race arm above is implicitly relying on.
      expect(
        (await authorizeTurn(tdb, daily, inGrowth('t3'), day2)).allowed,
        'the second day was denied against the first day’s spend — the department key is not windowed',
      ).toBe(true);
      const rows = await departmentRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => new Date(r.window_start).toISOString())).toEqual([
        '2026-08-14T00:00:00.000Z',
        '2026-08-15T00:00:00.000Z',
      ]);
    });
  });
});
