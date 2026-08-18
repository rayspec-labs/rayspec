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
export const WorkforceBudgetWindow = z.enum(['hourly', 'daily', 'weekly', 'monthly']);
export type WorkforceBudgetWindowName = z.infer<typeof WorkforceBudgetWindow>;

/**
 * BOUNDED CONTEXT (invariant §4.8) — the caps on the three free-text fields that render into the
 * turn frame. The frame is byte-bounded per section (`@rayspec/workforce-tools` context.ts:
 * identity 1 024 B, roleFrame 4 096 B, whole input 65 536 B) and the mandatory sections REFUSE
 * typed rather than truncating. Unbounded here, an oversized `mission` parses clean at `doctor` and
 * then throws `ContextSectionOverflowError` at every dispatch for that department's seats — a late
 * failure against a document the author was told was valid.
 *
 * What the caps buy and what they do NOT, stated so nobody over-reads them: they make an UNBOUNDED
 * input BOUNDED, so a single pathological field is refused at validation. They are not a proof that
 * a section fits — the orchestrator's role frame renders one line PER DEPARTMENT, so many
 * departments each near their cap still compose past the section budget, and
 * `ContextSectionOverflowError` remains the aggregate guard (it already names the fix: shorter
 * missions). `.max()` counts UTF-16 CODE UNITS; a code unit costs at most 3 utf-8 bytes (an astral
 * character is 4 bytes but spends two code units), so the worst-case byte costs are 600 / 600 /
 * 6 000.
 */
export const MAX_WORKFORCE_NAME_LENGTH = 200;
export const MAX_EMPLOYEE_TITLE_LENGTH = 200;
export const MAX_DEPARTMENT_MISSION_LENGTH = 2_000;

export const WorkforceEmployeeSpec = z
  .object({
    id: SafeIdentifier,
    /** The declared agent (agents[].id) that runs this employee — lint-resolved. */
    agent: z.string().min(1),
    /** Renders into the identity section AND the head line — bounded, see the caps above. */
    title: z.string().min(1).max(MAX_EMPLOYEE_TITLE_LENGTH),
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
    /** The department's routing description — renders into every covered seat's role frame. */
    mission: z.string().min(1).max(MAX_DEPARTMENT_MISSION_LENGTH),
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

/**
 * The "at least one of" rule expressed IN THE SHAPE, as a union of `.strict()` variants — one per
 * member, each requiring that member and leaving the other optional.
 *
 * Why a union and not a `.refine()`: a refinement is invisible to `z.toJSONSchema`, so the exported
 * `spec.schema.json` carried `required: []` and every third-party consumer (an editor, another
 * language's validator, a CI schema check) accepted `{}` — a selector that can never fire. A union
 * exports as `anyOf` with real `required` arrays, so the published contract refuses exactly what
 * the lint always refused. The lint rules STAY: they are the defense-in-depth path for a spec built
 * in code rather than parsed, the same posture `assertSafeIdentifier` takes.
 */
export const WorkforceReviewAppliesTo = z.union(
  [
    z.object({ department: SafeIdentifier, employee: SafeIdentifier.optional() }).strict(),
    z.object({ department: SafeIdentifier.optional(), employee: SafeIdentifier }).strict(),
  ],
  {
    error:
      "appliesTo must name at least one of 'department' or 'employee' (and no other key) — an " +
      'unselectable rule can never fire',
  },
);

const ConfidenceBelow = z.number().gt(0).lte(1);
const CapabilityLabels = z.array(z.string().min(1)).min(1);

export const WorkforceReviewRequireWhen = z.union(
  [
    z
      .object({ confidenceBelow: ConfidenceBelow, capabilities: CapabilityLabels.optional() })
      .strict(),
    z
      .object({ confidenceBelow: ConfidenceBelow.optional(), capabilities: CapabilityLabels })
      .strict(),
  ],
  {
    error:
      "requireWhen must name at least one of 'confidenceBelow' or 'capabilities' (and no other " +
      'key) — a rule that can never demand review is dead',
  },
);

export const WorkforceReviewPolicySpec = z
  .object({
    id: SafeIdentifier,
    /** Which submissions the rule covers; AT LEAST ONE selector — enforced by the shape itself. */
    appliesTo: WorkforceReviewAppliesTo,
    /** An employee id holding role `reviewer` or `manager` — lint-checked. */
    reviewer: SafeIdentifier,
    requireWhen: WorkforceReviewRequireWhen,
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
    /** The whole-workforce ceilings per calendar window. */
    workforce: z
      .object({
        usd: z.number().positive().finite(),
        turns: z.number().int().positive().optional(),
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
    /**
     * Whole-SUBTREE ceilings — the ROOT task's scope row, shared by every task descended from one
     * submitted goal. The fourth ledger tier (task / root / department / workforce); without this
     * key the root scope of every declared document carried no ceiling and enforced nothing.
     *
     * Deliberately NOT both-required like `task`: the both-required rule there exists because the
     * per-turn reservation estimate is `task.usd / task.turns`, and nothing derives an estimate
     * from the subtree tier. This mirrors the engine's own shape, and matches the other
     * non-estimate-bearing tier (`departments[].budgets`). Unlike the windowed tiers the root
     * scope is UN-WINDOWED (the epoch sentinel): a subtree ceiling bounds one goal's whole tree
     * for its lifetime, not a calendar rate — which is also why the widening rule that orders
     * department budgets against the workforce ceiling has no meaning here.
     */
    subtree: z
      .object({
        usd: z.number().positive().finite().optional(),
        turns: z.number().int().positive().optional(),
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
    /** The display name — renders into the orchestrator's role frame; bounded, see the caps above. */
    name: z.string().min(1).max(MAX_WORKFORCE_NAME_LENGTH),
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
