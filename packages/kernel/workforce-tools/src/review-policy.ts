/**
 * The declared-review-policy binding — a THIN adapter from the workforce configuration and a
 * submitted result to the engine's trusted review channel. The matching itself is core's
 * `DeclaredReviewPolicy` (the honest default of the review seam); this module only assembles its
 * inputs and shapes its decision, so the rule "policy is runtime code, never prompt text" has
 * exactly one implementation. The composition calls this AFTER the run — the model has no path to
 * it (tool arguments are the model's only input, and this reads none of them beyond the validated
 * result).
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
  return {
    reviewer: decision.reviewer,
    dispatchReviewer: decision.reviewer !== 'user' && config.employees.has(decision.reviewer),
    maxRounds: decision.maxRounds,
  };
}
