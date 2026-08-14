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
});
