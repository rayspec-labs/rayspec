/**
 * An out-of-tree `OrchestrationStrategy`: split the submitted goal on a declared separator and chain
 * the pieces, so step N waits on step N-1.
 *
 * WHAT IT DECIDES: how many steps there are, what each one says, and the order they run in.
 *
 * WHAT IT DOES NOT DECIDE, and could not if it tried: who exists. Every step is owned by the
 * `defaultOwner` the engine supplied, because the strategy has no way to learn another employee id
 * — the input carries facts, not a directory. Naming an owner the workforce does not declare would
 * be refused by the intake before any row is written, so inventing one buys nothing.
 *
 * Note what is missing and why: no clock, no network, no database handle, no tenant. A strategy is
 * given the goal and told who the default owner is; that is the whole of its world.
 */
import {
  type ExecutionPlan,
  type OrchestrationInput,
  type OrchestrationStrategy,
  SEAM_MAX_PLAN_STEPS,
  SEAM_MAX_STEP_TITLE_CHARS,
} from '@rayspec/core';

export class SeparatorPlanStrategy implements OrchestrationStrategy {
  readonly id = 'separator-plan';
  readonly #separator: string;

  constructor(separator = ' THEN ') {
    this.#separator = separator;
  }

  plan(input: OrchestrationInput): Promise<ExecutionPlan> {
    const pieces = input.goal
      .split(this.#separator)
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0)
      // The seam ceiling is enforced HERE rather than discovered at the intake: an implementation
      // that knows the bound produces a plan that is accepted, instead of one that is refused.
      .slice(0, SEAM_MAX_PLAN_STEPS);

    // A goal that carries no separator is one step — the same honest answer the shipped default
    // gives. Never zero steps: a plan with nothing in it is refused, and rightly.
    const steps = (pieces.length === 0 ? [input.goal] : pieces).map((piece, index) => ({
      title: title(piece),
      goal: piece,
      owner: input.defaultOwner,
      department: null,
      // A strict chain: each step waits on the one before it, which is the only dependency shape
      // that is always valid, because every index it names is strictly prior.
      dependsOn: index === 0 ? [] : [index - 1],
    }));

    return Promise.resolve({ steps });
  }
}

/** Bound the title to the row's own ceiling without splitting an astral pair at the trim. */
function title(goal: string): string {
  if (goal.length <= SEAM_MAX_STEP_TITLE_CHARS) return goal;
  const head = goal.slice(0, SEAM_MAX_STEP_TITLE_CHARS - 3).replace(/[\uD800-\uDBFF]$/, '');
  return `${head}...`;
}
