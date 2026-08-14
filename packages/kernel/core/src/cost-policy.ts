/**
 * CostPolicy — the neutral budget-enforcement seam.
 *
 * Spend is authorized at the DISPATCH BOUNDARY between turns — the one place a unit of work can be
 * denied without killing anything in flight — and settled from what actually ran. `authorize` is a
 * deterministic decision over durable ledger state (the core implementation lives in
 * @rayspec/tasks); `settle` records the actual so the next authorize sees the truth. Authorization
 * without settlement is not enforcement, which is why the interface carries both halves.
 *
 * The contract's two load-bearing rules:
 *   - A DENIAL MUTATES NOTHING. The caller parks the work with a typed reason; nothing is spent,
 *     nothing is truncated.
 *   - Settlement may exceed the reservation ONCE — a unit of work that already fired a
 *     non-idempotent effect is never aborted mid-flight — and the overrun counts against the next
 *     authorize. Exhaustion is always an explicit, typed outcome, never silent truncation.
 */

/** The ledger scopes a proposed execution draws from, narrowest to widest. */
export type BudgetScopeKind = 'task' | 'root' | 'department' | 'workforce';

/** One proposed unit of work (a task turn) and the scopes it would draw from. */
export interface ProposedExecution {
  readonly taskId: string;
  /** The subtree anchor (the root task's id) — the 'root' scope identity. */
  readonly rootTaskId: string;
  readonly workforceId: string | null;
  readonly department: string | null;
  /** The reservation estimate in USD; settled to the actual afterwards. */
  readonly estimateUsd: number;
}

/** The settled truth for a previously authorized execution. */
export interface SettledExecution extends ProposedExecution {
  readonly actualUsd: number;
}

/** Why an authorization was denied: the scope that refused, its ceiling, and what is consumed. */
export interface BudgetDenial {
  readonly scopeKind: BudgetScopeKind;
  readonly scopeId: string;
  /** Which ceiling refused. */
  readonly ceiling:
    | { readonly kind: 'usd'; readonly limit: number }
    | { readonly kind: 'turns'; readonly limit: number };
  /** What the scope has consumed (settled + reserved for usd; dispatched turns for turns). */
  readonly consumed: number;
}

export type PolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly denial: BudgetDenial };

export interface CostPolicy {
  readonly id: string;
  authorize(proposed: ProposedExecution): Promise<PolicyDecision>;
  settle(actual: SettledExecution): Promise<void>;
}
