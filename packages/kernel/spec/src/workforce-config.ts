/**
 * PURE derivations from a validated `workforce:` section to what the runtime consumes — the
 * in-memory org configuration (employees with their EFFECTIVE reporting edge, departments, teams,
 * the review rules in core's `DeclaredReviewRule` shape, approvals with their timeout in
 * milliseconds) and the engine's declared-budgets object. Derived FRESH at every boot from the
 * deployed document; org structure is never persisted — only the derived budgets land on the
 * per-workforce runtime row.
 *
 * The budgets type here is a STRUCTURAL TWIN of the engine's declared-budgets input (the engine
 * package sits above the db package, which imports THIS package — the edge cannot reverse). A
 * drift test on the engine side parses `deriveWorkforceBudgets` output through the engine's strict
 * schema, so the twin can never drift silently.
 */
import type { DeclaredReviewRule } from '@rayspec/core';
import { durationToMs, type WorkforceRoleName, type WorkforceSpec } from './workforce-grammar.js';

export interface WorkforceEmployeeConfig {
  readonly id: string;
  readonly agent: string;
  readonly title: string;
  readonly role: WorkforceRoleName;
  readonly department: string | null;
  /**
   * The EFFECTIVE reporting edge — explicit `reportsTo`, else the declared department's manager —
   * the same rule the lint's cycle/reachability checks certified. Null only for the orchestrator.
   */
  readonly reportsTo: string | null;
  readonly capabilities: readonly string[];
}

export interface WorkforceConfig {
  readonly id: string;
  readonly name: string;
  readonly orchestrator: string;
  readonly employees: ReadonlyMap<string, WorkforceEmployeeConfig>;
  readonly departments: ReadonlyMap<
    string,
    {
      readonly name: string;
      readonly manager: string;
      readonly mission: string;
      readonly members: readonly string[];
    }
  >;
  readonly teams: ReadonlyMap<
    string,
    { readonly lead: string; readonly members: readonly string[]; readonly maxSize: number }
  >;
  /** The declared review rules, in declaration order — directly feedable to DeclaredReviewPolicy. */
  readonly reviewPolicies: readonly DeclaredReviewRule[];
  readonly approvals: readonly {
    readonly id: string;
    readonly capabilities: readonly string[];
    readonly approver: 'user';
    readonly timeoutMs: number;
    readonly onTimeout: 'fail' | 'escalate';
  }[];
}

export function deriveWorkforceConfig(workforce: WorkforceSpec): WorkforceConfig {
  const managerOf = new Map(workforce.departments.map((d) => [d.id, d.manager]));
  const employees = new Map<string, WorkforceEmployeeConfig>(
    workforce.employees.map((employee) => {
      const fallback =
        employee.department !== undefined ? (managerOf.get(employee.department) ?? null) : null;
      const reportsTo =
        employee.reportsTo ?? (fallback !== null && fallback !== employee.id ? fallback : null);
      return [
        employee.id,
        {
          id: employee.id,
          agent: employee.agent,
          title: employee.title,
          role: employee.role,
          department: employee.department ?? null,
          reportsTo,
          capabilities: employee.capabilities,
        },
      ];
    }),
  );
  return {
    id: workforce.id,
    name: workforce.name,
    orchestrator: workforce.orchestrator,
    employees,
    departments: new Map(
      workforce.departments.map((d) => [
        d.id,
        { name: d.name, manager: d.manager, mission: d.mission, members: d.members },
      ]),
    ),
    teams: new Map(
      workforce.teams.map((t) => [t.id, { lead: t.lead, members: t.members, maxSize: t.maxSize }]),
    ),
    reviewPolicies: workforce.reviewPolicies.map((policy) => ({
      id: policy.id,
      appliesTo: {
        ...(policy.appliesTo.department !== undefined
          ? { department: policy.appliesTo.department }
          : {}),
        ...(policy.appliesTo.employee !== undefined ? { employee: policy.appliesTo.employee } : {}),
      },
      reviewer: policy.reviewer,
      requireWhen: {
        ...(policy.requireWhen.confidenceBelow !== undefined
          ? { confidenceBelow: policy.requireWhen.confidenceBelow }
          : {}),
        ...(policy.requireWhen.capabilities !== undefined
          ? { capabilities: policy.requireWhen.capabilities }
          : {}),
      },
      onReject: policy.onReject,
      maxRounds: policy.maxRounds,
    })),
    approvals: workforce.approvals.map((approval) => ({
      id: approval.id,
      capabilities: approval.requireWhen.capabilities,
      approver: approval.approver,
      timeoutMs: durationToMs(approval.timeout),
      onTimeout: approval.onTimeout,
    })),
  };
}

/**
 * The engine's declared-budgets INPUT shape (structural twin — see the module header). Absent
 * tiers stay ABSENT rather than defaulted: the engine owns its own defaults, and a derivation that
 * invented values would be a second budget model.
 */
export interface DeclaredEngineBudgets {
  readonly workforce?: { readonly usd: number; readonly window?: 'hourly' | 'daily' | 'weekly' };
  readonly task?: { readonly usd: number; readonly turns: number };
  readonly delegation?: { readonly maxDepth?: number; readonly maxPerTask?: number };
  readonly departments?: Readonly<
    Record<
      string,
      {
        readonly usd?: number;
        readonly turns?: number;
        readonly window?: 'hourly' | 'daily' | 'weekly';
        readonly maxConcurrentWorkers?: number;
      }
    >
  >;
  readonly execution?: {
    readonly maxConcurrentWorkers?: number;
    readonly maxTaskWallClockMs?: number;
    readonly maxReviewRounds?: number;
    readonly onBudgetExhausted?: 'block' | 'block_and_escalate';
    readonly estimateUsdPerTurn?: number;
  };
}

/**
 * Map the declared budgets/execution onto the engine shape. The per-turn reservation estimate is
 * DERIVED — `task.usd / task.turns` — never declared: the grammar requires both members whenever
 * the task tier is present, and the lint requires the task tier whenever ANY usd ceiling exists,
 * so a derived object can never trip the engine's own coherence refusal (a usd ceiling with a
 * zero estimate). The drift test on the engine side proves exactly that.
 */
export function deriveWorkforceBudgets(workforce: WorkforceSpec): DeclaredEngineBudgets {
  const budgets = workforce.budgets;
  const execution = workforce.execution;
  const out: {
    workforce?: DeclaredEngineBudgets['workforce'];
    task?: DeclaredEngineBudgets['task'];
    delegation?: DeclaredEngineBudgets['delegation'];
    departments?: Record<
      string,
      {
        usd?: number;
        turns?: number;
        window?: 'hourly' | 'daily' | 'weekly';
        maxConcurrentWorkers?: number;
      }
    >;
    execution?: {
      maxConcurrentWorkers?: number;
      maxTaskWallClockMs?: number;
      maxReviewRounds?: number;
      onBudgetExhausted?: 'block' | 'block_and_escalate';
      estimateUsdPerTurn?: number;
    };
  } = {};

  if (budgets?.workforce !== undefined) {
    out.workforce = {
      usd: budgets.workforce.usd,
      ...(budgets.workforce.window !== undefined ? { window: budgets.workforce.window } : {}),
    };
  }
  if (budgets?.task !== undefined) {
    out.task = { usd: budgets.task.usd, turns: budgets.task.turns };
  }
  if (budgets?.delegation !== undefined) {
    out.delegation = {
      ...(budgets.delegation.maxDepth !== undefined
        ? { maxDepth: budgets.delegation.maxDepth }
        : {}),
      ...(budgets.delegation.maxPerTask !== undefined
        ? { maxPerTask: budgets.delegation.maxPerTask }
        : {}),
    };
  }
  const departmentEntries = workforce.departments.filter((d) => d.budgets !== undefined);
  if (departmentEntries.length > 0) {
    out.departments = Object.fromEntries(
      departmentEntries.map((d) => {
        const b = d.budgets as NonNullable<typeof d.budgets>;
        return [
          d.id,
          {
            ...(b.usd !== undefined ? { usd: b.usd } : {}),
            ...(b.turns !== undefined ? { turns: b.turns } : {}),
            ...(b.window !== undefined ? { window: b.window } : {}),
            ...(b.maxConcurrentWorkers !== undefined
              ? { maxConcurrentWorkers: b.maxConcurrentWorkers }
              : {}),
          },
        ];
      }),
    );
  }
  const estimate = budgets?.task !== undefined ? budgets.task.usd / budgets.task.turns : undefined;
  if (execution !== undefined || estimate !== undefined) {
    out.execution = {
      ...(execution?.maxConcurrentWorkers !== undefined
        ? { maxConcurrentWorkers: execution.maxConcurrentWorkers }
        : {}),
      ...(execution?.maxTaskWallClock !== undefined
        ? { maxTaskWallClockMs: durationToMs(execution.maxTaskWallClock) }
        : {}),
      ...(execution?.maxReviewRounds !== undefined
        ? { maxReviewRounds: execution.maxReviewRounds }
        : {}),
      ...(execution?.onBudgetExhausted !== undefined
        ? { onBudgetExhausted: execution.onBudgetExhausted }
        : {}),
      ...(estimate !== undefined ? { estimateUsdPerTurn: estimate } : {}),
    };
  }
  return out;
}
