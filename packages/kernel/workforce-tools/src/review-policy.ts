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
 *   - `capabilities` is matched against the EMPLOYEE's declared capability labels — a fact from the
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
      capabilities: input.employee.capabilities,
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
