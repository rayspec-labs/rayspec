/**
 * ReviewPolicy — the neutral review-demand seam.
 *
 * When a result is submitted, the policy decides whether independent review is REQUIRED before the
 * task may complete — and the decision OVERRIDES whatever the submitting turn asked for. Policy is
 * runtime code over declared rules, never prompt text: a model can neither name its reviewer nor
 * talk its way past a rule that MATCHES. Applying the decision (parking the task, dispatching the
 * reviewer, counting rounds) stays with the engine.
 *
 * Whether a rule matches is a different question from whether it can be argued with, and the two
 * `requireWhen` triggers differ there. A `capabilities` rule is matched against the deployed
 * document and holds unconditionally. A `confidenceBelow` rule is matched against
 * `ReviewedResult.confidence` — which the SUBMITTER wrote — so a result claiming high confidence
 * simply does not trip it. That is a heuristic over self-report, useful and not a control; see
 * `packages/kernel/workforce-tools/src/review-policy.ts` for the full statement of the limitation.
 *
 * The default evaluates the DECLARED rules and is itself the runtime matcher the engine binds —
 * one implementation, not a default and a twin.
 */

/** What a rule is matched against. Capability labels are opaque — compared, never interpreted. */
export interface ReviewSubject {
  readonly taskId: string;
  readonly owner: string;
  readonly department: string | null;
  /** The owner's declared capability labels. */
  readonly capabilities: readonly string[];
}

export interface ReviewedResult {
  /** The submitted result payload — opaque to the policy. */
  readonly output: unknown;
  /** The submitter's self-reported confidence in [0,1]; null when the result carries none. */
  readonly confidence: number | null;
}

/** One declared review rule — the spec's `reviewPolicies[]` entry, parsed and resolved. */
export interface DeclaredReviewRule {
  readonly id: string;
  /** Which subjects the rule covers; at least one selector is present on a valid rule. */
  readonly appliesTo: { readonly department?: string; readonly employee?: string };
  /** The reviewing employee id, or 'user' for a human decision. */
  readonly reviewer: string;
  /** When a covered subject's submission demands review. */
  readonly requireWhen: {
    readonly confidenceBelow?: number;
    readonly capabilities?: readonly string[];
  };
  readonly onReject: 'rework';
  readonly maxRounds: number;
}

export type ReviewDecision =
  | { readonly required: false }
  | {
      readonly required: true;
      readonly policyId: string;
      readonly reviewer: string;
      readonly onReject: 'rework';
      readonly maxRounds: number;
    };

export interface ReviewPolicy {
  readonly id: string;
  evaluate(task: ReviewSubject, result: ReviewedResult): Promise<ReviewDecision>;
}

/**
 * The declared-rules matcher, and the honest default. `appliesTo` selects the rules that cover the
 * subject (department match, or employee match); `requireWhen` fires when the submitted confidence
 * is BELOW the threshold, or when the subject holds ANY listed capability label. The FIRST matching
 * rule in declaration order wins — deterministic, order-stable, no scoring.
 */
export class DeclaredReviewPolicy implements ReviewPolicy {
  readonly id = 'declared';
  readonly #rules: readonly DeclaredReviewRule[];

  constructor(rules: readonly DeclaredReviewRule[]) {
    this.#rules = rules;
  }

  evaluate(task: ReviewSubject, result: ReviewedResult): Promise<ReviewDecision> {
    for (const rule of this.#rules) {
      if (!appliesTo(rule, task)) continue;
      if (!requiresReview(rule, task, result)) continue;
      return Promise.resolve({
        required: true,
        policyId: rule.id,
        reviewer: rule.reviewer,
        onReject: rule.onReject,
        maxRounds: rule.maxRounds,
      });
    }
    return Promise.resolve({ required: false });
  }
}

function appliesTo(rule: DeclaredReviewRule, task: ReviewSubject): boolean {
  if (rule.appliesTo.department !== undefined && rule.appliesTo.department === task.department) {
    return true;
  }
  return rule.appliesTo.employee !== undefined && rule.appliesTo.employee === task.owner;
}

function requiresReview(
  rule: DeclaredReviewRule,
  task: ReviewSubject,
  result: ReviewedResult,
): boolean {
  if (
    rule.requireWhen.confidenceBelow !== undefined &&
    result.confidence !== null &&
    result.confidence < rule.requireWhen.confidenceBelow
  ) {
    return true;
  }
  return (rule.requireWhen.capabilities ?? []).some((label) => task.capabilities.includes(label));
}
