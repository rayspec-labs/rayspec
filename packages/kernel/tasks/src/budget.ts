/**
 * The budget ledger — reservation/settlement over `workforce_budget_ledger`, enforced at the
 * dispatch boundary. This module is the core `CostPolicy` implementation (the interface lives in
 * @rayspec/core; the wiring seam can later swap it, the default is always present).
 *
 * PROTOCOL. `authorizeTurn` runs in ONE transaction: it locks the ledger rows for every scope the
 * proposal draws from — via `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (the upsert IS the
 * lock: the conflict path takes the same row lock the update path does, and `DO NOTHING` would
 * take none; the DO UPDATE set carries a REAL write because an empty set throws) — in ONE
 * canonical order (task < root < department < workforce, then scope id, then window), each row a
 * SEPARATE statement (a single multi-row VALUES upsert acquires its internal locks in an order the
 * caller does not control). With every row locked it checks the ceilings on the locked values,
 * parsed as numbers (driver numerics arrive as strings; a string compare would order "9" above
 * "10"); ANY refusal rolls the transaction back — A DENIAL MUTATES NOTHING, not even the rows the
 * upsert would have created — and returns the typed denial. All-clear reserves: `reserved_usd`
 * grows by the estimate and `settled_turns` by one (a DISPATCHED turn is a spent turn — counting
 * turns at settlement would let two concurrent dispatches share the last slot) in SQL arithmetic,
 * never read-modify-write in JS.
 *
 * `settleTurn` runs inside the turn's final transaction, which ALREADY holds the task row's lock
 * (the status compare-and-swap + the journal seq counter) — the global rule that the task row is
 * always locked FIRST, before any ledger row, is what makes authorize and settle deadlock-free
 * against each other. It rolls the actual into the task row (`cost_usd`, `turns_used`), then walks
 * the same canonical order releasing the reservation (floored at zero) and settling the actual.
 * OVER-SETTLEMENT IS ALLOWED ONCE: a turn that already fired a non-idempotent effect is never
 * aborted, the overrun lands in `settled_usd`, and the NEXT authorize sees consumed > ceiling and
 * denies — counted exactly once, never silently truncated.
 *
 * Windows are calendar buckets (UTC hour/day/week) keyed by `window_start`; the un-windowed scopes
 * (task, root) use the epoch sentinel so the UNIQUE scope key stays total.
 */

import type {
  BudgetDenial,
  BudgetScopeKind,
  CostPolicy,
  PolicyDecision,
  ProposedExecution,
  SettledExecution,
} from '@rayspec/core';
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { WorkforceBudgetsInvalidError } from './errors.js';

export const BUDGET_WINDOWS = ['hourly', 'daily', 'weekly'] as const;

export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];

const usdCeilingSchema = z.number().positive().finite();
const turnsCeilingSchema = z.number().int().positive();

/**
 * The declared ceiling configuration persisted on `workforce_runtime.budgets`. STRICT at every
 * nesting level — an unknown key is a refusal, not a silently ignored wish.
 */
export const workforceBudgetsSchema = z.strictObject({
  /** Whole-workforce ceilings, enforced per calendar window (UTC). */
  workforce: z
    .strictObject({
      usd: usdCeilingSchema.optional(),
      turns: turnsCeilingSchema.optional(),
      window: z.enum(BUDGET_WINDOWS).default('daily'),
    })
    .optional(),
  /** Per-task ceilings (each task's own scope row). */
  task: z
    .strictObject({
      usd: usdCeilingSchema.optional(),
      turns: turnsCeilingSchema.optional(),
    })
    .optional(),
  /** Whole-subtree ceilings (the root task's scope row). */
  subtree: z
    .strictObject({
      usd: usdCeilingSchema.optional(),
      turns: turnsCeilingSchema.optional(),
    })
    .optional(),
  /** Hand-off ceilings, enforced at fan-out acceptance (not by the ledger). */
  delegation: z
    .strictObject({
      maxDepth: z.number().int().positive().optional(),
      maxPerTask: z.number().int().positive().optional(),
    })
    .optional(),
  /** Per-department ceilings; a department may not out-spend the workforce that contains it. */
  departments: z
    .record(
      z.string().min(1),
      z.strictObject({
        usd: usdCeilingSchema.optional(),
        turns: turnsCeilingSchema.optional(),
        window: z.enum(BUDGET_WINDOWS).default('daily'),
        maxConcurrentWorkers: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  execution: z
    .strictObject({
      maxConcurrentWorkers: z.number().int().positive().optional(),
      maxTaskWallClockMs: z.number().int().positive().optional(),
      maxReviewRounds: z.number().int().positive().optional(),
      onBudgetExhausted: z.enum(['block', 'block_and_escalate']).default('block'),
      /** The per-turn reservation estimate; settled to the actual afterwards. */
      estimateUsdPerTurn: z.number().nonnegative().finite().default(0),
    })
    .prefault({}),
});

export type WorkforceBudgets = z.output<typeof workforceBudgetsSchema>;

/** Parse a runtime row's stored budgets; a row that fails the strict schema is a typed refusal. */
export function resolveWorkforceBudgets(stored: unknown, workforceId: string): WorkforceBudgets {
  const parsed = workforceBudgetsSchema.safeParse(stored ?? {});
  if (!parsed.success) {
    throw new WorkforceBudgetsInvalidError(workforceId, parsed.error.message);
  }
  return parsed.data;
}

/** The epoch sentinel `window_start` for the un-windowed scopes (keeps the UNIQUE key total). */
export const EPOCH_WINDOW_START = new Date(0);

/** The UTC calendar bucket containing `now` for a declared window. */
export function windowStartFor(window: BudgetWindow, now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMinutes(0, 0, 0);
  if (window === 'hourly') return d;
  d.setUTCHours(0);
  if (window === 'daily') return d;
  // weekly: back up to the UTC Monday of the week containing `now`.
  const dow = d.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d;
}

interface ScopeCheck {
  readonly scopeKind: BudgetScopeKind;
  readonly scopeId: string;
  readonly windowStart: Date;
  readonly ceilingUsd: number | null;
  readonly ceilingTurns: number | null;
}

const SCOPE_RANK: Record<BudgetScopeKind, number> = {
  task: 0,
  root: 1,
  department: 2,
  workforce: 3,
};

/**
 * The scopes a proposal draws from, in the canonical lock order. Every applicable scope gets a
 * ledger row even without a declared ceiling — spend visibility is not conditional on enforcement.
 */
export function ledgerScopesFor(
  proposed: ProposedExecution,
  budgets: WorkforceBudgets,
  now: Date,
): ScopeCheck[] {
  const scopes: ScopeCheck[] = [
    {
      scopeKind: 'task',
      scopeId: proposed.taskId,
      windowStart: EPOCH_WINDOW_START,
      ceilingUsd: budgets.task?.usd ?? null,
      ceilingTurns: budgets.task?.turns ?? null,
    },
    {
      scopeKind: 'root',
      scopeId: proposed.rootTaskId,
      windowStart: EPOCH_WINDOW_START,
      ceilingUsd: budgets.subtree?.usd ?? null,
      ceilingTurns: budgets.subtree?.turns ?? null,
    },
  ];
  if (proposed.department !== null) {
    const dep = budgets.departments?.[proposed.department];
    scopes.push({
      scopeKind: 'department',
      scopeId: proposed.department,
      windowStart: windowStartFor(dep?.window ?? 'daily', now),
      ceilingUsd: dep?.usd ?? null,
      ceilingTurns: dep?.turns ?? null,
    });
  }
  if (proposed.workforceId !== null) {
    scopes.push({
      scopeKind: 'workforce',
      scopeId: proposed.workforceId,
      windowStart: windowStartFor(budgets.workforce?.window ?? 'daily', now),
      ceilingUsd: budgets.workforce?.usd ?? null,
      ceilingTurns: budgets.workforce?.turns ?? null,
    });
  }
  return scopes.sort(
    (a, b) =>
      SCOPE_RANK[a.scopeKind] - SCOPE_RANK[b.scopeKind] ||
      a.scopeId.localeCompare(b.scopeId) ||
      a.windowStart.getTime() - b.windowStart.getTime(),
  );
}

type LedgerRecord = typeof schema.workforceBudgetLedger.$inferSelect;

/** Upsert-lock ONE scope row (the conflict path takes the same row lock the update path does). */
async function lockLedgerRow(tx: TenantDb, scope: ScopeCheck): Promise<LedgerRecord> {
  const rows = (await tx
    .insert(schema.workforceBudgetLedger, {
      scopeKind: scope.scopeKind,
      scopeId: scope.scopeId,
      windowStart: scope.windowStart,
    })
    .onConflictDoUpdate({
      target: [
        schema.workforceBudgetLedger.tenantId,
        schema.workforceBudgetLedger.scopeKind,
        schema.workforceBudgetLedger.scopeId,
        schema.workforceBudgetLedger.windowStart,
      ],
      // A REAL write: DO NOTHING would not lock the existing row, silently voiding the protocol.
      set: { updatedAt: sql`now()` },
      setWhere: eq(schema.workforceBudgetLedger.tenantId, tx.tenantId),
    })
    .returning()) as LedgerRecord[];
  const row = rows[0];
  if (!row) {
    throw new Error(
      `budget ledger upsert for ${scope.scopeKind}/${scope.scopeId} returned no row. Fail-closed.`,
    );
  }
  return row;
}

/** Thrown internally to roll the authorize transaction back on a denial; never escapes. */
class DenialRollback extends Error {
  readonly denial: BudgetDenial;
  constructor(denial: BudgetDenial) {
    super('budget authorize denied — rolling back the reservation transaction.');
    this.name = 'DenialRollback';
    this.denial = denial;
  }
}

/** Bound wait for a contended ledger row, so a wedged holder surfaces instead of hanging dispatch. */
const AUTHORIZE_LOCK_TIMEOUT_MS = 5_000;

/**
 * Authorize one turn at the dispatch boundary. Returns the typed decision; a denial has rolled
 * back everything (no rows created, no reservation, no counter moved).
 */
export async function authorizeTurn(
  tdb: TenantDb,
  budgets: WorkforceBudgets,
  proposed: ProposedExecution,
  now: Date = new Date(),
): Promise<PolicyDecision> {
  const scopes = ledgerScopesFor(proposed, budgets, now);
  try {
    await tdb.transaction(
      async (tx) => {
        const locked: { scope: ScopeCheck; row: LedgerRecord }[] = [];
        for (const scope of scopes) {
          locked.push({ scope, row: await lockLedgerRow(tx, scope) });
        }
        for (const { scope, row } of locked) {
          const reserved = Number(row.reservedUsd);
          const settled = Number(row.settledUsd);
          if (
            scope.ceilingUsd !== null &&
            settled + reserved + proposed.estimateUsd > scope.ceilingUsd
          ) {
            throw new DenialRollback({
              scopeKind: scope.scopeKind,
              scopeId: scope.scopeId,
              ceiling: { kind: 'usd', limit: scope.ceilingUsd },
              consumed: settled + reserved,
            });
          }
          if (scope.ceilingTurns !== null && row.settledTurns + 1 > scope.ceilingTurns) {
            throw new DenialRollback({
              scopeKind: scope.scopeKind,
              scopeId: scope.scopeId,
              ceiling: { kind: 'turns', limit: scope.ceilingTurns },
              consumed: row.settledTurns,
            });
          }
        }
        for (const { row } of locked) {
          await tx
            .update(schema.workforceBudgetLedger, {
              reservedUsd: sql`${schema.workforceBudgetLedger.reservedUsd} + ${String(proposed.estimateUsd)}`,
              settledTurns: sql`${schema.workforceBudgetLedger.settledTurns} + 1`,
              updatedAt: sql`now()`,
            })
            .where(eq(schema.workforceBudgetLedger.id, row.id));
        }
      },
      { lockTimeoutMs: AUTHORIZE_LOCK_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof DenialRollback) return { allowed: false, denial: err.denial };
    throw err;
  }
  return { allowed: true };
}

/** Thrown internally to unwind the probe's savepoint; never escapes. */
class ProbeRollback extends Error {
  readonly decision: PolicyDecision;
  constructor(decision: PolicyDecision) {
    super('budget probe complete — rolling back the savepoint.');
    this.name = 'ProbeRollback';
    this.decision = decision;
  }
}

/**
 * CHECK a spend against the wider scopes (root / department / workforce — a fan-out draws from the
 * subtree up, not from the requesting task's own scope) WITHOUT reserving anything. Runs in a
 * savepoint that is ALWAYS rolled back, so neither the check nor a first-touch row creation
 * mutates the ledger — the caller decides what the verdict means (a denied fan-out blocks the
 * parent with the typed reason; it never opens the children). Callable mid-transaction: the
 * savepoint nests inside the caller's transaction.
 */
export async function probeSpend(
  tdb: TenantDb,
  budgets: WorkforceBudgets,
  proposed: ProposedExecution,
  turnCount: number,
  now: Date = new Date(),
): Promise<PolicyDecision> {
  const scopes = ledgerScopesFor(proposed, budgets, now).filter((s) => s.scopeKind !== 'task');
  try {
    await tdb.transaction(async (tx) => {
      for (const scope of scopes) {
        const row = await lockLedgerRow(tx, scope);
        const reserved = Number(row.reservedUsd);
        const settled = Number(row.settledUsd);
        if (
          scope.ceilingUsd !== null &&
          settled + reserved + proposed.estimateUsd > scope.ceilingUsd
        ) {
          throw new ProbeRollback({
            allowed: false,
            denial: {
              scopeKind: scope.scopeKind,
              scopeId: scope.scopeId,
              ceiling: { kind: 'usd', limit: scope.ceilingUsd },
              consumed: settled + reserved,
            },
          });
        }
        if (scope.ceilingTurns !== null && row.settledTurns + turnCount > scope.ceilingTurns) {
          throw new ProbeRollback({
            allowed: false,
            denial: {
              scopeKind: scope.scopeKind,
              scopeId: scope.scopeId,
              ceiling: { kind: 'turns', limit: scope.ceilingTurns },
              consumed: row.settledTurns,
            },
          });
        }
      }
      // All clear — still roll the savepoint back: a probe reserves NOTHING.
      throw new ProbeRollback({ allowed: true });
    });
  } catch (err) {
    if (err instanceof ProbeRollback) return err.decision;
    throw err;
  }
  // Unreachable: the savepoint body always throws the sentinel.
  return { allowed: true };
}

/**
 * Settle one turn's actual inside the turn's final transaction (which already holds the task row's
 * lock — task row FIRST, ledger rows after, always). Releases the reservation (floored at zero)
 * and records the actual; the task row's own roll-up moves in the same breath.
 */
export async function settleTurn(
  tx: TenantDb,
  budgets: WorkforceBudgets,
  settled: SettledExecution,
  now: Date = new Date(),
): Promise<void> {
  await tx
    .update(schema.workforceTasks, {
      costUsd: sql`${schema.workforceTasks.costUsd} + ${String(settled.actualUsd)}`,
      turnsUsed: sql`${schema.workforceTasks.turnsUsed} + 1`,
    })
    .where(eq(schema.workforceTasks.taskId, settled.taskId));
  for (const scope of ledgerScopesFor(settled, budgets, now)) {
    await lockLedgerRow(tx, scope);
    await tx
      .update(schema.workforceBudgetLedger, {
        reservedUsd: sql`greatest(${schema.workforceBudgetLedger.reservedUsd} - ${String(settled.estimateUsd)}, 0)`,
        settledUsd: sql`${schema.workforceBudgetLedger.settledUsd} + ${String(settled.actualUsd)}`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.workforceBudgetLedger.scopeKind, scope.scopeKind),
          eq(schema.workforceBudgetLedger.scopeId, scope.scopeId),
          eq(schema.workforceBudgetLedger.windowStart, scope.windowStart),
        ),
      );
  }
}

/**
 * The core CostPolicy: the deterministic ledger check above, bound to one tenant handle and one
 * validated budgets declaration. `settle` MUST be called on the policy the turn's final
 * transaction constructed (so the task-row-first lock order holds); the seam exists so a later
 * implementation can replace the decision, never so the default can be absent.
 */
export class LedgerCostPolicy implements CostPolicy {
  readonly id = 'ledger';
  readonly #tdb: TenantDb;
  readonly #budgets: WorkforceBudgets;
  readonly #now: () => Date;

  constructor(tdb: TenantDb, budgets: WorkforceBudgets, now: () => Date = () => new Date()) {
    this.#tdb = tdb;
    this.#budgets = budgets;
    this.#now = now;
  }

  authorize(proposed: ProposedExecution): Promise<PolicyDecision> {
    return authorizeTurn(this.#tdb, this.#budgets, proposed, this.#now());
  }

  async settle(actual: SettledExecution): Promise<void> {
    await settleTurn(this.#tdb, this.#budgets, actual, this.#now());
  }
}
