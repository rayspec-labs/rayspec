/**
 * The `workforce:` section grammar — a declared organization of agent-backed employees: who exists
 * (employees, with a role from a closed set), how they are organized (departments with a manager
 * and a mission; static teams with a lead), what they may spend (budgets + execution ceilings the
 * ENGINE enforces — this grammar declares, it never enforces), and the policies that route work
 * through review and human approval.
 *
 * Strictness matches the rest of the grammar: `.strict()` at every level, closed enums, exact
 * references (resolved by the lint pass, workforce-lint.ts). The section is EXPERIMENTAL and
 * additionally gated at parse (`experimental_section_disabled`, parse.ts) — the shape here is
 * always defined so the gate can name what it refused.
 *
 * Ids are `SafeIdentifier`s: they land in URL path segments, in `workforce_tasks.owner`, and in
 * `delegated_to` target strings — the same injection-guard posture store names carry.
 */
import { z } from 'zod';
import { SafeIdentifier } from './identifier.js';

/**
 * One closed duration surface: '30s' / '45m' / '2h' / '1d'. A `.regex()` (never `.refine()`) so the
 * exported JSON-Schema carries the constraint as `pattern`. The engine consumes MILLISECONDS —
 * `durationToMs` is the one conversion.
 */
export const DURATION_RE = /^([1-9]\d{0,8})(s|m|h|d)$/;
export const DurationString = z
  .string()
  .regex(DURATION_RE, "duration must look like '30s', '45m', '2h' or '1d'");

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Convert a declared duration to milliseconds. THROWS on a non-matching value (defense in depth
 *  for a code-built spec that bypassed parse). */
export function durationToMs(value: string): number {
  const match = DURATION_RE.exec(value);
  const unit = match === null ? undefined : DURATION_UNIT_MS[match[2] as string];
  if (match === null || unit === undefined) {
    throw new Error(
      `unparseable duration ${JSON.stringify(value)} — expected /${DURATION_RE.source}/. Fail-closed.`,
    );
  }
  return Number(match[1]) * unit;
}

/**
 * The closed role set. A role determines which NATIVE toolset an employee receives at dispatch —
 * and nothing else. There is no capability-based routing: `capabilities[]` are opaque policy
 * labels, matched by review/approval rules, never interpreted.
 */
export const WorkforceRole = z.enum(['orchestrator', 'manager', 'worker', 'reviewer']);
export type WorkforceRoleName = z.infer<typeof WorkforceRole>;

/** Mirrors the engine's calendar windows; a drift test pins the two enums to each other. */
export const WorkforceBudgetWindow = z.enum(['hourly', 'daily', 'weekly']);

export const WorkforceEmployeeSpec = z
  .object({
    id: SafeIdentifier,
    /** The declared agent (agents[].id) that runs this employee — lint-resolved. */
    agent: z.string().min(1),
    title: z.string().min(1),
    department: SafeIdentifier.optional(),
    /** The reporting edge; absent, the employee's department manager is the effective superior. */
    reportsTo: SafeIdentifier.optional(),
    role: WorkforceRole,
    /** Opaque policy labels — matched for equality by requireWhen rules, never interpreted. */
    capabilities: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type WorkforceEmployeeSpec = z.infer<typeof WorkforceEmployeeSpec>;

export const WorkforceDepartmentBudgets = z
  .object({
    usd: z.number().positive().finite().optional(),
    turns: z.number().int().positive().optional(),
    /** Absent ⇒ the engine's default calendar window (daily). */
    window: WorkforceBudgetWindow.optional(),
    maxConcurrentWorkers: z.number().int().positive().optional(),
  })
  .strict();

export const WorkforceDepartmentSpec = z
  .object({
    id: SafeIdentifier,
    name: z.string().min(1),
    /** An employee id — must hold role `manager` (or be the orchestrator); lint-checked. */
    manager: SafeIdentifier,
    mission: z.string().min(1),
    members: z.array(SafeIdentifier).default([]),
    budgets: WorkforceDepartmentBudgets.optional(),
  })
  .strict();
export type WorkforceDepartmentSpec = z.infer<typeof WorkforceDepartmentSpec>;

export const WorkforceTeamSpec = z
  .object({
    id: SafeIdentifier,
    lead: SafeIdentifier,
    members: z.array(SafeIdentifier).min(1),
    maxSize: z.number().int().positive(),
  })
  .strict();
export type WorkforceTeamSpec = z.infer<typeof WorkforceTeamSpec>;

export const WorkforceReviewPolicySpec = z
  .object({
    id: SafeIdentifier,
    /** Which submissions the rule covers; at least one selector is required (lint-checked). */
    appliesTo: z
      .object({ department: SafeIdentifier.optional(), employee: SafeIdentifier.optional() })
      .strict(),
    /** An employee id holding role `reviewer` or `manager` — lint-checked. */
    reviewer: SafeIdentifier,
    requireWhen: z
      .object({
        confidenceBelow: z.number().gt(0).lte(1).optional(),
        capabilities: z.array(z.string().min(1)).min(1).optional(),
      })
      .strict(),
    onReject: z.literal('rework'),
    maxRounds: z.number().int().positive(),
  })
  .strict();
export type WorkforceReviewPolicySpec = z.infer<typeof WorkforceReviewPolicySpec>;

export const WorkforceApprovalSpec = z
  .object({
    id: SafeIdentifier,
    requireWhen: z.object({ capabilities: z.array(z.string().min(1)).min(1) }).strict(),
    /** v1 pins the approver to the deployment's human operator surface. */
    approver: z.literal('user'),
    timeout: DurationString,
    onTimeout: z.enum(['fail', 'escalate']),
  })
  .strict();
export type WorkforceApprovalSpec = z.infer<typeof WorkforceApprovalSpec>;

export const WorkforceBudgetsSpec = z
  .object({
    /** The whole-workforce usd ceiling per calendar window. */
    workforce: z
      .object({
        usd: z.number().positive().finite(),
        window: WorkforceBudgetWindow.optional(),
      })
      .strict()
      .optional(),
    /**
     * Per-task ceilings. BOTH members are required when the object is present: the engine's
     * per-turn reservation estimate derives from `usd / turns`, and a usd ceiling that cannot
     * reserve per turn cannot bound concurrent dispatch (the engine refuses exactly that).
     */
    task: z
      .object({
        usd: z.number().positive().finite(),
        turns: z.number().int().positive(),
      })
      .strict()
      .optional(),
    delegation: z
      .object({
        maxDepth: z.number().int().positive().optional(),
        maxPerTask: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkforceBudgetsSpec = z.infer<typeof WorkforceBudgetsSpec>;

export const WorkforceExecutionSpec = z
  .object({
    maxConcurrentWorkers: z.number().int().positive().optional(),
    maxTaskWallClock: DurationString.optional(),
    maxReviewRounds: z.number().int().positive().optional(),
    /** Absent ⇒ the engine default (`block`). */
    onBudgetExhausted: z.enum(['block', 'block_and_escalate']).optional(),
  })
  .strict();
export type WorkforceExecutionSpec = z.infer<typeof WorkforceExecutionSpec>;

/** The one `workforce:` block a document may declare. */
export const WorkforceSpec = z
  .object({
    id: SafeIdentifier,
    name: z.string().min(1),
    /** The entry-point employee — must hold role `orchestrator`; lint-checked. */
    orchestrator: SafeIdentifier,
    budgets: WorkforceBudgetsSpec.optional(),
    execution: WorkforceExecutionSpec.optional(),
    departments: z.array(WorkforceDepartmentSpec).default([]),
    employees: z.array(WorkforceEmployeeSpec).min(1),
    teams: z.array(WorkforceTeamSpec).default([]),
    reviewPolicies: z.array(WorkforceReviewPolicySpec).default([]),
    approvals: z.array(WorkforceApprovalSpec).default([]),
  })
  .strict();
export type WorkforceSpec = z.infer<typeof WorkforceSpec>;
