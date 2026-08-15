/**
 * The workforce GOAL INTAKE — the production caller of the `OrchestrationStrategy` seam: one
 * submitted goal → `strategy.plan()` → durable `planned` tasks, atomically.
 *
 * The strategy decides the SHAPE of the plan and nothing else (its own header's rule): which steps
 * exist, who owns each, which steps wait on which. THIS module is what keeps that rule true on the
 * write side — it validates the returned plan against the DECLARED workforce fail-closed BEFORE
 * the first insert (an undeclared owner, a department that is not the owner's own, a dependency
 * index outside `[0, i)`, a title outside the row bounds), and creates every step inside ONE
 * transaction, so a refused plan creates ZERO rows and a multi-step plan is never half-born.
 *
 * Plan steps become SIBLING ROOTS: `dependsOn` maps onto the engine's `dependencies` (which gates
 * `planned → queued`), so a decomposing strategy gets SEQUENCING across its steps but no fan-in —
 * there is no cross-root join, deliberately. The reference posture does not need one: the shipped
 * default hands the whole goal to the orchestrator seat as one root, and the orchestrator's own
 * turns do the real decomposition through `delegate_task`, where the engine's join machinery
 * already lives.
 *
 * TENANT RECONCILIATION lives here, not in the route: tasks must land under the deployment task
 * tenant — the only tenant the dispatcher serves — so a foreign request tenant or an unknown
 * workforce id yields `not_found` (the route's uniform 404), mirroring the manual-trigger seam.
 */
import type { WorkforceGoalIntake, WorkforceGoalOutcome } from '@rayspec/api-auth';
import type { ExecutionPlan, OrchestrationStrategy } from '@rayspec/core';
import { type Db, forTenant } from '@rayspec/db';
import type { WorkforceConfig } from '@rayspec/spec';
import { createRootTask } from '@rayspec/tasks';

export interface WorkforceGoalIntakeDeps {
  /** The WORKER pool handle (never the HTTP pool) — the same pool the dispatcher runs on. */
  readonly db: Db;
  /** The deployment task tenant (the single-deployment posture every off-request fire runs under). */
  readonly tenantId: string;
  readonly config: WorkforceConfig;
  /** The deployment's orchestration strategy; the composition supplies the shipped default. */
  readonly strategy: OrchestrationStrategy;
}

/** The row bounds `createRootTask` enforces; pre-checked so a refusal is a typed plan refusal
 * with the step named, never a mid-transaction schema throw. */
const MAX_STEP_TITLE_CHARS = 200;
const MAX_STEP_DEPENDENCIES = 100;

/**
 * Validate a returned plan against the declared workforce. Returns the refusal detail, or null
 * for a plan the intake will create verbatim. Pure — no I/O, no clock.
 */
function planRefusal(plan: ExecutionPlan, config: WorkforceConfig): string | null {
  if (plan.steps.length === 0) return 'the plan carries no steps';
  for (const [index, step] of plan.steps.entries()) {
    const employee = config.employees.get(step.owner);
    if (!employee) {
      return `step ${index} names owner '${step.owner}', which this workforce does not declare`;
    }
    if (step.department !== null && step.department !== employee.department) {
      // Department is LEDGER ATTRIBUTION — a step may not book its spend onto a department its
      // owner does not belong to. Null is always legal and resolves to the owner's own below.
      return (
        `step ${index} books department '${step.department}' for owner '${step.owner}', whose ` +
        `declared department is ${employee.department === null ? 'none' : `'${employee.department}'`}`
      );
    }
    if (step.title.length === 0 || step.title.length > MAX_STEP_TITLE_CHARS) {
      return `step ${index} carries a title outside 1..${MAX_STEP_TITLE_CHARS} characters`;
    }
    if (step.goal.length === 0) return `step ${index} carries an empty goal`;
    if (step.dependsOn.length > MAX_STEP_DEPENDENCIES) {
      return `step ${index} declares ${step.dependsOn.length} dependencies (the row bound is ${MAX_STEP_DEPENDENCIES})`;
    }
    for (const dep of step.dependsOn) {
      if (!Number.isInteger(dep) || dep < 0 || dep >= index) {
        return `step ${index} depends on index ${dep}, which is not a PRIOR step of this plan`;
      }
    }
  }
  return null;
}

/** Build the goal-intake seam over a declared workforce. */
export function buildWorkforceGoalIntake(deps: WorkforceGoalIntakeDeps): WorkforceGoalIntake {
  return {
    async submitGoal(input): Promise<WorkforceGoalOutcome> {
      // Single-deployment posture: created tasks must land under the tenant the dispatcher
      // serves, and the goal must address the workforce this document declares. Anything else is
      // a uniform not-found — no existence leak, exactly like the manual-trigger seam.
      if (input.tenantId !== deps.tenantId) return { outcome: 'not_found' };
      if (input.workforceId !== deps.config.id) return { outcome: 'not_found' };

      const plan = await deps.strategy.plan({
        workforceId: deps.config.id,
        goal: input.goal,
        requestedBy: input.requestedBy,
        defaultOwner: deps.config.orchestrator,
      });
      const refusal = planRefusal(plan, deps.config);
      if (refusal !== null) {
        return { outcome: 'invalid_plan', detail: `${refusal} (strategy '${deps.strategy.id}')` };
      }

      // ONE transaction for the whole plan: `createRootTask` nests as a savepoint, and each
      // step's dependency ids name ONLY prior steps created above it, so the existence check
      // inside the engine sees them. A throw anywhere aborts everything — zero rows.
      const tdb = forTenant(deps.db, deps.tenantId);
      const created = await tdb.transaction(async (tx) => {
        const taskIds: string[] = [];
        const tasks: { taskId: string; owner: string; title: string }[] = [];
        for (const step of plan.steps) {
          const owner = deps.config.employees.get(step.owner);
          const task = await createRootTask(tx, {
            workforceId: deps.config.id,
            title: step.title,
            goal: step.goal,
            owner: step.owner,
            requestedBy: input.requestedBy,
            // Ledger attribution: the step's own booking, else the owner's declared department.
            department: step.department ?? owner?.department ?? null,
            dependencies: step.dependsOn.map((dep) => taskIds[dep] as string),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
          });
          taskIds.push(task.taskId);
          tasks.push({ taskId: task.taskId, owner: task.owner, title: task.title });
        }
        return tasks;
      });
      return { outcome: 'created', tasks: created };
    },
  };
}
