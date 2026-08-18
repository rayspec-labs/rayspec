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
 * `releaseTurnReservation` is the settle-less counterpart for a turn that never reaches its final
 * transaction at all (the sweep's reaper): the reservation goes back, nothing is settled.
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

export const BUDGET_WINDOWS = ['hourly', 'daily', 'weekly', 'monthly'] as const;

export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];

const usdCeilingSchema = z.number().positive().finite();
const turnsCeilingSchema = z.number().int().positive();

/**
 * The declared ceiling configuration persisted on `workforce_runtime.budgets`. STRICT at every
 * nesting level — an unknown key is a refusal, not a silently ignored wish.
 *
 * The strictness is why `declaredAt` below is DECLARED here rather than written past this schema:
 * the runtime row's payload is re-parsed on every dispatch, so a loose key stamped onto it would
 * not be ignored — it would make the row unreadable and stop the workforce.
 */
const rawWorkforceBudgetsSchema = z.strictObject({
  /**
   * NOT A CEILING — the DECLARATION MARKER, and the only member here that is not one.
   *
   * An ISO instant stamped by the boot that deployed a document declaring this workforce id, and
   * by nothing else. The engine ignores it; it exists so the REDEPLOY GATE can tell a workforce a
   * document once declared from a workforce id that only ever labelled engine-owned tasks. Those
   * two are otherwise indistinguishable on every row — same tasks, same runtime row (the scheduler
   * creates one on first dispatch), same delegations — and telling them apart is what makes
   * "the document no longer declares this workforce" a decidable question instead of a guess that
   * would abort every engine-only deployment. See workforce-boot.ts for the full mechanism.
   *
   * It lives on this object because the runtime row has exactly one jsonb column, and recording it
   * needed no DDL. Nothing may READ it as a budget: it is carried, never enforced.
   */
  declaredAt: z.string().min(1).optional(),
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

/**
 * FAIL-CLOSED coherence rule: a USD ceiling with a ZERO per-turn reservation estimate cannot bound
 * CONCURRENT dispatch — every racing authorize would read `settled + reserved + 0 <= ceiling` and
 * admit, and the ceiling would bite only after the money is spent. A declaration that names a usd
 * ceiling anywhere must therefore also declare a positive `execution.estimateUsdPerTurn`; refusing
 * at validation beats discovering the overrun in the ledger. Turns-only ceilings are unaffected
 * (dispatched turns are counted at authorize, so they bound concurrency on their own).
 */
export const workforceBudgetsSchema = rawWorkforceBudgetsSchema.superRefine((value, ctx) => {
  const declaresUsd =
    value.workforce?.usd !== undefined ||
    value.task?.usd !== undefined ||
    value.subtree?.usd !== undefined ||
    Object.values(value.departments ?? {}).some((d) => d.usd !== undefined);
  if (declaresUsd && value.execution.estimateUsdPerTurn <= 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['execution', 'estimateUsdPerTurn'],
      message:
        'a usd ceiling is declared but execution.estimateUsdPerTurn is 0 — a zero reservation ' +
        'cannot bound concurrent dispatch, so the ceiling would only bite after the overrun. ' +
        'Declare a positive per-turn estimate. Fail-closed.',
    });
  }
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

/**
 * The UTC calendar bucket containing `now` for a declared window.
 *
 * EXHAUSTIVE BY CONSTRUCTION: every member of `BUDGET_WINDOWS` gets its OWN branch and the tail is
 * a `never` refusal, so adding a window without a bucket rule is a COMPILE error here rather than a
 * silent fallthrough into whichever branch happened to be last (before `monthly` existed, the tail
 * was an unguarded weekly fallthrough — a new member would have bucketed as weekly and enforced the
 * wrong window). `budget.test.ts` additionally asserts that no two windows produce the same bucket.
 */
export function windowStartFor(window: BudgetWindow, now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMinutes(0, 0, 0);
  if (window === 'hourly') return d;
  d.setUTCHours(0);
  if (window === 'daily') return d;
  if (window === 'weekly') {
    // back up to the UTC Monday of the week containing `now`.
    const dow = d.getUTCDay();
    const daysSinceMonday = (dow + 6) % 7;
    d.setUTCDate(d.getUTCDate() - daysSinceMonday);
    return d;
  }
  if (window === 'monthly') {
    // The first UTC instant of the calendar month. Months are 28–31 days: the bucket is a real
    // calendar boundary, never a fixed offset (`workforce-lint.ts`'s per-hour normalization uses a
    // NOMINAL month for ORDERING only — the amount enforced is always this bucket's).
    d.setUTCDate(1);
    return d;
  }
  const unhandled: never = window;
  throw new Error(
    `unhandled budget window ${JSON.stringify(unhandled)} — every BUDGET_WINDOWS member needs its ` +
      'own calendar bucket rule. Fail-closed.',
  );
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

/**
 * Bound wait for a contended ledger row, so a wedged holder surfaces instead of hanging dispatch.
 *
 * The seam sets it with `set_config('lock_timeout', …, is_local := true)`. When `authorizeTurn`
 * runs NESTED (the dispatcher's claim transaction calls it, so the "transaction" is a SAVEPOINT),
 * a RELEASED savepoint keeps the setting: the bound stays in force for the remainder of the
 * enclosing claim. That is deliberate, not a leak — the claim's remaining statements touch the rows
 * this bound already covers, and a claim that hangs on a lock is exactly what the bound exists to
 * surface. A DENIED authorize rolls its savepoint back and the setting goes with it.
 */
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
 *
 * The verdict is ADVISORY, and deliberately so: the rollback that undoes the probe's writes also
 * releases the row locks it took, so between this verdict and whatever the caller does with it a
 * concurrent authorize may consume the headroom the probe just saw. An `allowed` probe is "the
 * ceilings had room a moment ago", never a reservation — the enforcement that cannot be raced is
 * `authorizeTurn`, which locks, checks and reserves in one transaction. A fan-out reads the probe
 * as a fail-closed pre-check on opening N children whose OWN dispatches each authorize for real.
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
 *
 * WINDOW-BOUNDARY honesty: scopes are derived with the settle-time clock, so a turn that crosses a
 * window boundary releases from (and settles into) the NEW bucket while its reservation sits in
 * the OLD one. That is deliberate and self-limiting: authorization only ever reads the CURRENT
 * bucket, so a phantom reservation in a past bucket can never deny a future turn, and settling
 * into the current bucket counts the spend against the window that is actually enforcing — the
 * conservative direction.
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
 * Give ONE dispatched turn's reservation back without settling anything — for a turn that never
 * reaches its final transaction. `settleTurn` is the only other release, and it runs from
 * `applyTurnOutcome`; a turn whose workflow died never gets there, so without this the estimate the
 * claim reserved would sit in the ledger forever. The `task` and `root` scopes are keyed on the
 * epoch sentinel and never roll over, so a stranded estimate is permanent: enough reaps and the
 * task is denied at a ceiling it has spent nothing against.
 *
 * Walks the same canonical scope order under the same lock discipline (the caller holds the task
 * row first), floors at zero, and leaves `settled_turns` alone — a DISPATCHED turn is a spent turn,
 * exactly as `authorizeTurn` counts it, and the reaped turn did occupy a dispatch slot. Same
 * WINDOW-BOUNDARY honesty as `settleTurn`: scopes come from the release-time clock, so a release
 * that crosses a boundary works the CURRENT bucket while the reservation sits in the old one — a
 * phantom reservation in a past bucket can never deny a future turn.
 */
export async function releaseTurnReservation(
  tx: TenantDb,
  budgets: WorkforceBudgets,
  proposed: ProposedExecution,
  now: Date = new Date(),
): Promise<void> {
  for (const scope of ledgerScopesFor(proposed, budgets, now)) {
    await lockLedgerRow(tx, scope);
    await tx
      .update(schema.workforceBudgetLedger, {
        reservedUsd: sql`greatest(${schema.workforceBudgetLedger.reservedUsd} - ${String(proposed.estimateUsd)}, 0)`,
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
