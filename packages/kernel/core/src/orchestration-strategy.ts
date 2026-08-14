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
          title: input.goal.length <= 200 ? input.goal : `${input.goal.slice(0, 197)}...`,
          goal: input.goal,
          owner: input.defaultOwner,
          department: null,
          dependsOn: [],
        },
      ],
    });
  }
}
