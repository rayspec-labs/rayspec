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
  readonly firesOnCapabilities: readonly string[];
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
  /** The declared approval rule covering this employee's capabilities, or null. */
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
  /** How many children one task may open in total; null when no ceiling is declared. */
  readonly delegationsPerTaskLimit: number | null;
}

/**
 * The legal-target computation mirrors the resolver's enforcement (`resolve-target.ts`), stated
 * once here as a comment pair so a drift is a review finding, not a surprise:
 *   - an orchestrator addresses any department, any team, and any employee but itself;
 *   - a manager addresses their own department's members, plus the members of a team they LEAD
 *     while this task is that team's work (`snapshot.activeTeamIds` — the delegation-chain fact);
 *   - workers and reviewers hold no delegation tool.
 */
function legalTargetsFor(
  config: WorkforceConfig,
  employee: WorkforceEmployeeConfig,
  snapshot: WorkforceReadSnapshot,
): readonly string[] {
  if (employee.role === 'orchestrator') {
    return [
      ...[...config.departments.keys()].map((id) => `department:${id}`),
      ...[...config.teams.keys()].map((id) => `team:${id}`),
      ...[...config.employees.keys()]
        .filter((id) => id !== employee.id)
        .map((id) => `employee:${id}`),
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
    return [...new Set([...own, ...led])].map((id) => `employee:${id}`);
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
      firesOnCapabilities: (rule.requireWhen.capabilities ?? []).filter((label) =>
        employee.capabilities.includes(label),
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
  const ancestryDepth = Array.isArray(task.ancestryPath)
    ? (task.ancestryPath as string[]).length
    : 0;
  return {
    legalTargets: legalTargetsFor(config, employee, snapshot),
    reviewRules: applicableReviewRules(config.reviewPolicies, employee),
    approvalRule: matchApprovalRule(config, employee),
    budget: {
      workforceCeilingUsd: budgets.workforce?.usd ?? null,
      workforceConsumedUsd: stateBudget?.consumedUsd ?? null,
      workforceHeadroomUsd: stateBudget?.headroomUsd ?? null,
      taskCeilingUsd: budgets.task?.usd ?? null,
      taskCeilingTurns: budgets.task?.turns ?? null,
    },
    delegationDepthRemaining: maxDepth !== null ? Math.max(maxDepth - ancestryDepth, 0) : null,
    delegationsPerTaskLimit: budgets.delegation?.maxPerTask ?? null,
  };
}
