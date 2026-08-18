/**
 * An OUT-OF-TREE implementation of all five workforce extension seams.
 *
 * Everything here imports from `@rayspec/core` — the package entry, resolved through its `exports`
 * map to its built types, exactly the specifier a consumer outside this repository writes. Nothing
 * reaches into `packages/`, no relative path leaves this directory, and no engine file is patched.
 * That is the whole claim: a deployment can replace the judgment in every seam without forking the
 * task kernel, and `contract.test.ts` next door is what checks it rather than asserting it.
 *
 * These implementations decide DIFFERENTLY from the shipped defaults on purpose — a strategy that
 * splits a goal on a declared separator, a selector that balances load, a memory provider that
 * actually recalls, an approval provider with a queue, a cost policy with per-department ceilings.
 * They are deliberately simple; the point is the boundary they respect, not the intelligence.
 */

export { DepartmentCeilingCostPolicy } from './department-cost-policy.js';
export { KeywordMemoryProvider } from './keyword-memory.js';
export { LeastLoadedSelector } from './least-loaded-selector.js';
export { QueuedApprovalProvider } from './queued-approvals.js';
export { SeparatorPlanStrategy } from './separator-strategy.js';
