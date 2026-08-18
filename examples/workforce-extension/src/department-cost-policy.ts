/**
 * An out-of-tree `CostPolicy`: an extra per-department ceiling on top of whatever the deployment
 * already enforces.
 *
 * READ THIS BEFORE COPYING IT. An injected cost policy is an OPINION, not an authority. It is meant
 * to be composed with the deployment's deterministic, ledger-backed policy through
 * `confineCostPolicy(baseline, extension)`, which asks the baseline first and only consults the
 * extension when the baseline already allowed. The consequence is worth stating plainly: NOTHING
 * this class returns can authorize spend the baseline denied. Its `allowed: true` is not an
 * approval, it is the absence of an additional objection. Its only real power is to deny.
 *
 * The same composition is why `settle` here is bookkeeping and nothing more: the confinement routes
 * settlement to the baseline alone, so this method is never called through it. Keeping a local total
 * is useful for this policy's OWN future denials and for nothing else — the durable ledger the next
 * authorization reads is written by the baseline.
 */
import type {
  BudgetScopeKind,
  CostPolicy,
  PolicyDecision,
  ProposedExecution,
  SettledExecution,
} from '@rayspec/core';

export class DepartmentCeilingCostPolicy implements CostPolicy {
  readonly id = 'department-ceiling';
  readonly #ceilings: ReadonlyMap<string, number>;
  readonly #spent = new Map<string, number>();

  constructor(ceilingsUsdByDepartment: Readonly<Record<string, number>>) {
    this.#ceilings = new Map(Object.entries(ceilingsUsdByDepartment));
  }

  authorize(proposed: ProposedExecution): Promise<PolicyDecision> {
    const department = proposed.department;
    if (department === null) return Promise.resolve({ allowed: true });
    const ceiling = this.#ceilings.get(department);
    if (ceiling === undefined) return Promise.resolve({ allowed: true });

    const consumed = this.#spent.get(department) ?? 0;
    if (consumed + proposed.estimateUsd <= ceiling) return Promise.resolve({ allowed: true });

    // A denial names the scope that refused, the ceiling it refused against, and what is already
    // consumed — so the park reason a human reads says WHY, not merely "denied".
    return Promise.resolve({
      allowed: false,
      denial: {
        scopeKind: 'department' satisfies BudgetScopeKind,
        scopeId: department,
        ceiling: { kind: 'usd', limit: ceiling },
        consumed,
      },
    });
  }

  settle(actual: SettledExecution): Promise<void> {
    if (actual.department !== null) {
      this.#spent.set(
        actual.department,
        (this.#spent.get(actual.department) ?? 0) + actual.actualUsd,
      );
    }
    return Promise.resolve();
  }
}
