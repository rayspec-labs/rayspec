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
 * `settle` is what makes the ceiling a CEILING rather than a per-turn estimate check: the confinement
 * calls the baseline authoritatively and then this method advisorily, so `#spent` accumulates and the
 * next `authorize` sees the real total. Two things follow. A failure in here is swallowed by the
 * confinement — it must never roll back the baseline's durable ledger write — so this method must be
 * able to lose an update without corrupting itself. And `#spent` is this policy's OWN accounting, not
 * the deployment's: the durable ledger the baseline reads is written by the baseline, and nothing
 * here can influence it.
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
