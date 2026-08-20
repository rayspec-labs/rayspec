/**
 * OrchestrationStrategy — the neutral goal-decomposition seam.
 *
 * A workforce turns one submitted goal into an execution plan: which steps exist, who owns each,
 * and which steps wait on which. The strategy decides the SHAPE of that plan and nothing else —
 * creating the durable tasks, enforcing budgets and dispatching turns stay with the engine, so a
 * strategy can never spend, skip a ceiling, or touch a row. Deterministic scaffolding computes the
 * facts; the strategy makes the judgment call.
 *
 * The default is honest rather than clever: the whole goal as one step for the default owner. A
 * deployment always runs without any replacement — the seam exists so a later implementation can
 * improve the decomposition, never so the default can be absent.
 *
 * THIS MODULE IMPORTS NOTHING, and that is enforced rather than intended: `seam-wiring.test.ts`'s
 * *"no seam interface imports anything — a seam is handed plain data, never a capability"* asserts
 * the import list of every seam interface module is EMPTY, so an out-of-tree implementer can read
 * this one file and know the whole contract. That rule is why the trim below carries its own copy
 * of the tree's truncation guard instead of calling `truncateCodeUnits` — see the trim.
 */

/** The facts a plan is made from. Everything here is DATA the caller verified — never model text. */
export interface OrchestrationInput {
  readonly workforceId: string;
  /** The submitted goal, verbatim. */
  readonly goal: string;
  /** Who asked (an employee id, 'user', or 'trigger:<name>'). */
  readonly requestedBy: string;
  /** The employee a non-decomposing plan hands the whole goal to. */
  readonly defaultOwner: string;
}

/** One planned step. `dependsOn` holds 0-based indexes of prior steps in the same plan. */
export interface ExecutionPlanStep {
  readonly title: string;
  readonly goal: string;
  readonly owner: string;
  readonly department: string | null;
  readonly dependsOn: readonly number[];
}

export interface ExecutionPlan {
  readonly steps: readonly ExecutionPlanStep[];
}

export interface OrchestrationStrategy {
  readonly id: string;
  plan(input: OrchestrationInput): Promise<ExecutionPlan>;
}

/** The step-title bound, and the three characters the ellipsis spends out of it. */
const TITLE_MAX_CHARS = 200;
const TITLE_ELLIPSIS = '...';

/**
 * The local mirror of `truncateCodeUnits` — see the trim's comment for why this module copies it
 * rather than importing it. Byte-for-byte the same predicate: cut, then give back a HIGH surrogate
 * the cut orphaned. A prefix cut can only ever orphan the high half.
 */
function trimToTitleBound(goal: string): string {
  const sliced = goal.slice(0, TITLE_MAX_CHARS - TITLE_ELLIPSIS.length);
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
}

/**
 * The honest default: no decomposition. The whole goal becomes ONE step owned by the default
 * owner. It never invents structure it cannot justify — a deployment that wants real planning
 * replaces the strategy, and until then every goal still executes.
 */
export class SingleTaskPlanStrategy implements OrchestrationStrategy {
  readonly id = 'single-task';

  plan(input: OrchestrationInput): Promise<ExecutionPlan> {
    return Promise.resolve({
      steps: [
        {
          // Never split an astral pair at the trim: `slice` cuts UTF-16 CODE UNITS, so a cut
          // between the halves of a pair leaves a lone surrogate — mangled text here, and a write
          // PostgreSQL REFUSES (`22P02`) at the jsonb sites elsewhere in the tree.
          //
          // THE ONE DELIBERATE COPY of `truncateCodeUnits` (@rayspec/core text-utils.ts), which is
          // where the hazard, the contract and the caller list are documented. Every other
          // truncation in the workforce packages calls it; this one cannot, because a seam
          // interface module may import NOTHING (see the module header — the rule is asserted, not
          // merely stated). The rule is worth more than the deduplication: it is what lets an
          // out-of-tree implementer read one self-contained file. So the copy is intentional and
          // labelled, rather than one more SILENT one of the kind that produced the defect this
          // guard exists for, and `strategy-defaults.test.ts` gives THIS site its own astral arm.
          title:
            input.goal.length <= TITLE_MAX_CHARS
              ? input.goal
              : `${trimToTitleBound(input.goal)}${TITLE_ELLIPSIS}`,
          goal: input.goal,
          owner: input.defaultOwner,
          department: null,
          dependsOn: [],
        },
      ],
    });
  }
}
