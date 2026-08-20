/**
 * The deterministic TURN SCAFFOLDING — every fact the runtime can compute before the model is
 * invoked, computed here and presented as data, so the model is never asked a question the
 * runtime can answer: which delegation targets are legal for THIS seat on THIS task, which
 * declared review and approval rules cover it, how much budget headroom and delegation depth
 * remain. Pure over its inputs (config + task row + snapshot) — no I/O, no clock — and every fact
 * uses the SAME predicate the enforcement path uses (`reviewRuleAppliesTo`, `matchApprovalRule`,
 * the resolver's target rules), so a turn can never be told it may do what the runtime will
 * refuse, nor refused what it was told.
 */
import { type DeclaredReviewRule, reviewRuleAppliesTo } from '@rayspec/core';
import type { WorkforceConfig, WorkforceEmployeeConfig } from '@rayspec/spec';
import type { TaskRecord } from '@rayspec/tasks';
import { type MatchedApprovalRule, matchApprovalRule } from './review-policy.js';
import type { WorkforceReadSnapshot } from './snapshot.js';

/** One declared review rule that COVERS this employee, in declaration order (first match wins). */
export interface ApplicableReviewRuleFact {
  readonly id: string;
  readonly reviewer: string;
  /** Fires on a submitted confidence below this — the self-report heuristic; null when unkeyed. */
  readonly confidenceBelow: number | null;
  /** Fires UNCONDITIONALLY when the employee holds one of these labels (the enforcement branch). */
  readonly firesOnLabels: readonly string[];
  readonly maxRounds: number;
}

export interface TurnFacts {
  /**
   * The delegation targets THIS seat may legally address from THIS task, in the target grammar
   * (`employee:<id>` / `department:<id>` / `team:<id>`), declaration order. Empty for a seat
   * whose toolset carries no delegation tool (worker, reviewer) — and empty is a fact too.
   */
  readonly legalTargets: readonly string[];
  /** Declared review rules covering this employee, declaration order. */
  readonly reviewRules: readonly ApplicableReviewRuleFact[];
  /**
   * The declared approval policy covering this employee's labels — null when none matches,
   * and null for a seat whose toolset carries no `request_approval` at all (worker, reviewer):
   * a fact the seat cannot act on is not a fact for its turn, and stating one would tell the
   * model about a tool the runtime will refuse.
   */
  readonly approvalRule: MatchedApprovalRule | null;
  readonly budget: {
    readonly workforceCeilingUsd: number | null;
    /** Live spend, present only where the snapshot carries the state view (orchestrator turns);
     * null elsewhere — stated as unknown rather than invented. */
    readonly workforceConsumedUsd: number | null;
    readonly workforceHeadroomUsd: number | null;
    readonly taskCeilingUsd: number | null;
    readonly taskCeilingTurns: number | null;
  };
  /** Delegations from here may nest this many more levels; null when no ceiling is declared. */
  readonly delegationDepthRemaining: number | null;
  /**
   * How many MORE children this task may still open — the declared `maxPerTask` minus the fan-out
   * already spent from it, so a second delegating turn (rework, post-join synthesis) is told the
   * REMAINING allowance, never the static cap (the planner refuses `existing + created > maxPerTask`
   * — R-3-of-#400). Stated as a remaining count exactly the way depth is; null when no ceiling is
   * declared.
   */
  readonly delegationsPerTaskRemaining: number | null;
}

/**
 * The legal-target computation mirrors the FULL enforcement — the resolver's role rules AND the
 * planner's hand-off refusals — stated once here as a comment pair so a drift is a review
 * finding, not a surprise:
 *   - an orchestrator addresses any department, any team, and any employee but itself;
 *   - a manager addresses their own department's members, plus the members of a team they LEAD
 *     while this task is that team's work (`snapshot.activeTeamIds` — the delegation-chain fact);
 *   - workers and reviewers hold no delegation tool;
 *   - a target RESOLVING to a seat that already owns an ancestor of this task is subtracted
 *     (the planner refuses it as `delegation_cycle`, terminally after a retry — a fact list
 *     advertising it would steer the model into the requeue-then-fail fate);
 *   - at delegation depth 0 nothing is legal at all.
 */
function legalTargetsFor(
  config: WorkforceConfig,
  employee: WorkforceEmployeeConfig,
  snapshot: WorkforceReadSnapshot,
  depthRemaining: number | null,
): readonly string[] {
  if (depthRemaining !== null && depthRemaining <= 0) return [];
  const ancestors = new Set(snapshot.ancestorOwners);
  // The RESOLVED owner is what the cycle AND self-delegation rules see: a department resolves to its
  // manager, a team to its lead — the same resolution `resolve-target.ts` applies. The lint permits
  // the ORCHESTRATOR to manage a department, so a department resolving to the caller itself is a
  // `self_delegation` refusal and must be subtracted here too — the same `id !== self && !ancestor`
  // test `employeeLegal` applies to a resolved owner (a team lead is always a manager, never the
  // orchestrator, so `team:` can never resolve to the orchestrator caller — no self test needed).
  const departmentLegal = (id: string): boolean => {
    const manager = config.departments.get(id)?.manager ?? '';
    return manager !== employee.id && !ancestors.has(manager);
  };
  const teamLegal = (id: string): boolean => !ancestors.has(config.teams.get(id)?.lead ?? '');
  const employeeLegal = (id: string): boolean => id !== employee.id && !ancestors.has(id);

  if (employee.role === 'orchestrator') {
    return [
      ...[...config.departments.keys()].filter(departmentLegal).map((id) => `department:${id}`),
      ...[...config.teams.keys()].filter(teamLegal).map((id) => `team:${id}`),
      ...[...config.employees.keys()].filter(employeeLegal).map((id) => `employee:${id}`),
    ];
  }
  if (employee.role === 'manager') {
    const own =
      employee.department !== null
        ? (config.departments.get(employee.department)?.members ?? [])
        : [];
    const led = [...config.teams.entries()]
      .filter(
        ([teamId, team]) => team.lead === employee.id && snapshot.activeTeamIds.includes(teamId),
      )
      .flatMap(([, team]) => team.members);
    // Declaration order, first occurrence wins — a member reachable through both grants renders once.
    return [...new Set([...own, ...led])].filter(employeeLegal).map((id) => `employee:${id}`);
  }
  return [];
}

function applicableReviewRules(
  rules: readonly DeclaredReviewRule[],
  employee: WorkforceEmployeeConfig,
): readonly ApplicableReviewRuleFact[] {
  return rules
    .filter((rule) =>
      reviewRuleAppliesTo(rule, { owner: employee.id, department: employee.department }),
    )
    .map((rule) => ({
      id: rule.id,
      reviewer: rule.reviewer,
      confidenceBelow: rule.requireWhen.confidenceBelow ?? null,
      firesOnLabels: (rule.requireWhen.labels ?? []).filter((label) =>
        employee.labels.includes(label),
      ),
      maxRounds: rule.maxRounds,
    }));
}

/** Compute the scaffolding facts for one dispatched turn. Pure; same inputs → same facts. */
export function computeTurnFacts(input: {
  readonly config: WorkforceConfig;
  readonly employee: WorkforceEmployeeConfig;
  readonly task: TaskRecord;
  readonly snapshot: WorkforceReadSnapshot;
}): TurnFacts {
  const { config, employee, task, snapshot } = input;
  const budgets = snapshot.budgets;
  const stateBudget = snapshot.workforceState?.budget ?? null;
  const maxDepth = budgets.delegation?.maxDepth ?? null;
  const maxPerTask = budgets.delegation?.maxPerTask ?? null;
  const ancestryDepth = Array.isArray(task.ancestryPath)
    ? (task.ancestryPath as string[]).length
    : 0;
  const depthRemaining = maxDepth !== null ? Math.max(maxDepth - ancestryDepth, 0) : null;
  return {
    legalTargets: legalTargetsFor(config, employee, snapshot, depthRemaining),
    reviewRules: applicableReviewRules(config.reviewPolicies, employee),
    // COMPUTED FOR EVERY SEAT, not only the ones holding `request_approval`. It used to be gated
    // on the toolset, on the reasoning that "a fact a seat cannot act on is not a fact for its
    // turn" — sound while an approval policy only decorated a request the seat chose to make. A
    // matched rule now INTERCEPTS the seat's completion whatever its role, so the rule is a fact
    // ABOUT the seat rather than about its tools, and a covered worker that is not told is a turn
    // frame withholding the one thing that will happen to its result.
    approvalRule: matchApprovalRule(config, employee),
    budget: {
      workforceCeilingUsd: budgets.workforce?.usd ?? null,
      workforceConsumedUsd: stateBudget?.consumedUsd ?? null,
      workforceHeadroomUsd: stateBudget?.headroomUsd ?? null,
      taskCeilingUsd: budgets.task?.usd ?? null,
      taskCeilingTurns: budgets.task?.turns ?? null,
    },
    delegationDepthRemaining: depthRemaining,
    delegationsPerTaskRemaining:
      maxPerTask !== null ? Math.max(maxPerTask - snapshot.delegationsFromTask, 0) : null,
  };
}
