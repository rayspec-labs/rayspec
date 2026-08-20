/**
 * The declared-review-policy binding — a THIN adapter from the workforce configuration and a
 * submitted result to the engine's trusted review channel. The matching itself is core's
 * `DeclaredReviewPolicy` (the honest default of the review seam); this module only assembles its
 * inputs and shapes its decision, so the rule "policy is runtime code, never prompt text" has
 * exactly one implementation. The composition calls this AFTER the run — the model has no path to
 * it (tool arguments are the model's only input, and this reads none of them beyond the validated
 * result).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE `confidenceBelow` LIMITATION — stated plainly, because the module it feeds claims policies
 * cannot be talked past.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The two `requireWhen` triggers are NOT equally trustworthy, and the difference is which side
 * supplies the value:
 *
 *   - `labels` is matched against the EMPLOYEE's declared policy labels — a fact from the
 *     deployed document, which the turn cannot change. A rule keyed on it fires whenever it applies,
 *     and this is the branch to write a rule on when the rule must hold.
 *   - `confidenceBelow` is matched against `result.confidence`, a number the SUBMITTING TURN wrote.
 *     A result claiming 0.99 does not trip a `confidenceBelow: 0.75` rule, and one omitting the
 *     field fails the schema rather than the rule — so the threshold is a HEURISTIC over
 *     self-report, not an enforcement. It is genuinely useful (an honest low-confidence submission
 *     routes itself to review, which is most of them), and it is genuinely not a control.
 *
 * The runtime-not-prompt-text property is intact either way: no model output STEERS which rule
 * matches, and no prose reaches the matcher. What a self-reported confidence can do is fail to
 * trip a threshold — a rule not firing, never a rule being redirected. Closing it needs a
 * confidence signal the submitter does not author (a judge, a calibration model, a measured
 * outcome), which is a seam this design has room for and does not yet have.
 */
import { DeclaredReviewPolicy } from '@rayspec/core';
import type { WorkforceConfig, WorkforceEmployeeConfig } from '@rayspec/spec';
import type { WorkerResult } from '@rayspec/tasks';

export interface MatchedReviewPolicy {
  readonly reviewer: string;
  /** True when the reviewer is a declared employee — the engine then dispatches the review turn. */
  readonly dispatchReviewer: boolean;
  readonly maxRounds: number;
}

export interface MatchedApprovalRule {
  readonly id: string;
  /**
   * WHO the declared rule names as the decider. v1 pins it to `'user'`
   * (`WorkforceApprovalPolicySpec.approver`, a `z.literal`), so this carries a constant today — and
   * it is carried rather than re-derived because the engine now WRITES it onto the approval row it
   * opens for a gated completion. Re-hardcoding `'user'` at a third site is the drift this codebase
   * keeps paying for; the trusted channel carries its own accountability fact instead.
   */
  readonly approver: 'user';
  readonly timeoutMs: number;
  readonly onTimeout: 'fail' | 'escalate';
}

/**
 * The declared approval policy covering this employee's labels, or null. ONE predicate with
 * THREE consumers — the `request_approval` handler (which binds the matched window and fate onto
 * the intent), the turn scaffolding (which presents the same rule as a fact before the model
 * runs), and the composition's trusted approval channel (which carries it to the engine, where it
 * INTERCEPTS a completion) — so what a turn is told, what its request gets, and what the engine
 * enforces can never diverge. First declared match wins, like the review rules.
 *
 * IT READS NO TURN OUTPUT, and that is the property the whole gate rests on. The signature takes a
 * config and an employee: the match is a function of the DEPLOYED DOCUMENT and the seat's DECLARED
 * labels only. Contrast `matchReviewPolicy` below, which reads `result.confidence` — a number the
 * submitting turn wrote about itself, and therefore a heuristic rather than a control (see this
 * module's header). Because the approval match cannot be steered, a seat covered by both policies
 * cannot choose whether it is gated by choosing a confidence: both review outcomes and the direct
 * completion end at this same rule.
 */
export function matchApprovalRule(
  config: WorkforceConfig,
  employee: WorkforceEmployeeConfig,
): MatchedApprovalRule | null {
  const rule = config.approvalPolicies.find((candidate) =>
    candidate.labels.some((label) => employee.labels.includes(label)),
  );
  if (!rule) return null;
  return {
    id: rule.id,
    approver: rule.approver,
    timeoutMs: rule.timeoutMs,
    onTimeout: rule.onTimeout,
  };
}

/** Evaluate the declared rules against a completing turn's result; null when no rule fires. */
export async function matchReviewPolicy(
  config: WorkforceConfig,
  input: {
    readonly employee: WorkforceEmployeeConfig;
    readonly taskId: string;
    readonly result: WorkerResult;
  },
): Promise<MatchedReviewPolicy | null> {
  const decision = await new DeclaredReviewPolicy(config.reviewPolicies).evaluate(
    {
      taskId: input.taskId,
      owner: input.employee.id,
      department: input.employee.department,
      labels: input.employee.labels,
    },
    { output: input.result, confidence: input.result.confidence },
  );
  if (!decision.required) return null;
  // A rule may end up covering its own reviewer (a department policy whose reviewer sits inside
  // that department). Review is independent by definition — a submitter never decides their own
  // work — so the demand STANDS but the decision falls to the human.
  if (decision.reviewer === input.employee.id) {
    return { reviewer: 'user', dispatchReviewer: false, maxRounds: decision.maxRounds };
  }
  return {
    reviewer: decision.reviewer,
    dispatchReviewer: decision.reviewer !== 'user' && config.employees.has(decision.reviewer),
    maxRounds: decision.maxRounds,
  };
}
