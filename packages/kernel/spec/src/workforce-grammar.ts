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
 * and nothing else. There is no label-based routing: `labels[]` are opaque policy labels, matched
 * by review/approval rules, never interpreted.
 */
export const WorkforceRole = z.enum(['orchestrator', 'manager', 'worker', 'reviewer']);
export type WorkforceRoleName = z.infer<typeof WorkforceRole>;

/**
 * A POLICY LABEL — the token `reviewPolicies[].requireWhen.labels` and
 * `approvalPolicies[].requireWhen.labels` match against `employees[].labels`.
 *
 * Named `labels` and not `capabilities` because this repo already spends "capability" on two other
 * meanings a reader meets on the same page: the Product-YAML platform ingress contract
 * (`docs/spec-reference.md`, a closed set of nine ids) and `@rayspec/core`'s BACKEND model
 * capabilities, whose `capability_violation` check runs in the very lint file that validates these
 * (`workforce-lint.ts`).
 *
 * MATCH RULE — exact string equality, case-sensitive, no inheritance, ANY-of within one array. The
 * matchers are `labels.some((l) => holder.labels.includes(l))` (`@rayspec/core` review-policy.ts
 * `requiresReview`, `workforce-tools` review-policy.ts `matchApprovalRule`); there is no
 * department- or team-level label field anywhere in this grammar, so nothing is inherited.
 *
 * CONSTRAINED to `SafeIdentifier` rather than an open string, because this token is the SOLE
 * selector for `approvalPolicies[]` and a typo in an open string silently defeats a declared
 * approval gate. Precisely what it defeats, since the loose version of this sentence has already
 * misled once: approval policies are never read by the ENGINE, and `request_approval` is offered by
 * ROLE (`workforce-tools` roles.ts), so an uncovered seat can still park. What a typo costs is the
 * DECLARED window and fate — the handler falls back to `?? 'fail'` and a 72h default
 * (`workforce-tools` toolset.ts) — plus the turn-frame line that tells the seat it is covered. The
 * companion control is the lint's `workforce_label_unheld` ERROR: a label no declared employee
 * holds is refused, not warned about.
 *
 * `:`/`.` are deliberately NOT admitted: `:` is already this section's delegation separator
 * (`employee:<id>` / `department:<id>` / `team:<id>`), and admitting a namespacing spelling whose
 * hierarchy semantics do not exist would invite an affordance the matcher ignores. Widening the
 * pattern later accepts strictly more documents, so nothing here is foreclosed.
 */
export const WorkforceLabel = SafeIdentifier;

/** Mirrors the engine's calendar windows; a drift test pins the two enums to each other. */
export const WorkforceBudgetWindow = z.enum(['hourly', 'daily', 'weekly', 'monthly']);
export type WorkforceBudgetWindowName = z.infer<typeof WorkforceBudgetWindow>;

/**
 * BOUNDED CONTEXT — the deterministic bounded-context invariant, applied at the declaration: these
 * are the caps on the four free-text fields that render into the turn frame, which is
 * byte-bounded per section (`@rayspec/workforce-tools` context.ts:
 * identity 1 024 B, roleFrame 4 096 B, whole input 65 536 B) and the mandatory sections REFUSE
 * typed rather than truncating. Unbounded here, an oversized `mission` parses clean at `doctor` and
 * then throws `ContextSectionOverflowError` at every dispatch for that department's seats — a late
 * failure against a document the author was told was valid. `departments[].name` renders on the
 * SAME role-frame line as `mission` and is bounded for the same reason.
 *
 * What the caps buy and what they do NOT, stated so nobody over-reads them: they make an UNBOUNDED
 * input BOUNDED, so a single pathological field is refused at validation. They are not a proof that
 * a section fits — the orchestrator's role frame renders one line PER DEPARTMENT, so many
 * departments each near their cap still compose past the section budget, and
 * `ContextSectionOverflowError` remains the aggregate guard (it already names the fix: shorter
 * missions). `.max()` counts UTF-16 CODE UNITS; a code unit costs at most 3 utf-8 bytes (an astral
 * character is 4 bytes but spends two code units), so the worst-case byte costs are 600 / 600 /
 * 600 / 6 000.
 */
export const MAX_WORKFORCE_NAME_LENGTH = 200;
export const MAX_EMPLOYEE_TITLE_LENGTH = 200;
export const MAX_DEPARTMENT_NAME_LENGTH = 200;
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
    labels: z.array(WorkforceLabel).default([]),
  })
  .strict();
export type WorkforceEmployeeSpec = z.infer<typeof WorkforceEmployeeSpec>;

export const WorkforceDepartmentBudgets = z
  .object({
    usd: z.number().positive().finite().optional(),
    turns: z.number().int().positive().optional(),
    /** Absent ⇒ the engine's default calendar window (daily). */
    window: WorkforceBudgetWindow.optional(),
  })
  .strict();

/**
 * A department's non-monetary ceilings. Split out of `departments[].budgets` because a worker-slot
 * cap is a STRUCTURAL ceiling, not money — the same reason the workforce-level `execution:` block
 * exists. `budgets:` now holds only what the ledger meters.
 */
export const WorkforceDepartmentExecution = z
  .object({
    maxConcurrentWorkers: z.number().int().positive().optional(),
  })
  .strict();

export const WorkforceDepartmentSpec = z
  .object({
    id: SafeIdentifier,
    /** Renders into the orchestrator's role frame, one line per department — bounded, see above. */
    name: z.string().min(1).max(MAX_DEPARTMENT_NAME_LENGTH),
    /** An employee id — must hold role `manager` (or be the orchestrator); lint-checked. */
    manager: SafeIdentifier,
    /** The department's routing description — renders into every covered seat's role frame. */
    mission: z.string().min(1).max(MAX_DEPARTMENT_MISSION_LENGTH),
    members: z.array(SafeIdentifier).default([]),
    budgets: WorkforceDepartmentBudgets.optional(),
    execution: WorkforceDepartmentExecution.optional(),
  })
  .strict();
export type WorkforceDepartmentSpec = z.infer<typeof WorkforceDepartmentSpec>;

export const WorkforceTeamSpec = z
  .object({
    id: SafeIdentifier,
    lead: SafeIdentifier,
    members: z.array(SafeIdentifier).min(1),
    /**
     * OPTIONAL. It is an author-declared intent bound, not a runtime input: the only code that
     * reads it is the lint rule refusing `members.length > maxSize` (workforce-lint.ts) — nothing
     * at dispatch, delegation or join consults it, so an absent cap is the same runtime as a cap
     * equal to `members.length`. Kept (rather than dropped) because dropping it is the more
     * breaking choice and the declaration still documents an author's intended headroom.
     */
    maxSize: z.number().int().positive().optional(),
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
const PolicyLabels = z.array(WorkforceLabel).min(1);

export const WorkforceReviewRequireWhen = z.union(
  [
    z.object({ confidenceBelow: ConfidenceBelow, labels: PolicyLabels.optional() }).strict(),
    z.object({ confidenceBelow: ConfidenceBelow.optional(), labels: PolicyLabels }).strict(),
  ],
  {
    error:
      "requireWhen must name at least one of 'confidenceBelow' or 'labels' (and no other " +
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
    /**
     * This rule's review/rework ceiling. Named to match `execution.maxReviewRounds` (the
     * workforce-wide ceiling) because they count the same thing at two scopes — the bare
     * `maxRounds` said nothing about which rounds, nor that the two are the same unit.
     */
    maxReviewRounds: z.number().int().positive(),
  })
  .strict();
export type WorkforceReviewPolicySpec = z.infer<typeof WorkforceReviewPolicySpec>;

export const WorkforceApprovalPolicySpec = z
  .object({
    id: SafeIdentifier,
    requireWhen: z.object({ labels: PolicyLabels }).strict(),
    /** v1 pins the approver to the deployment's human operator surface. */
    approver: z.literal('user'),
    timeout: DurationString,
    onTimeout: z.enum(['fail', 'escalate']),
  })
  .strict();
export type WorkforceApprovalPolicySpec = z.infer<typeof WorkforceApprovalPolicySpec>;

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
    /**
     * Hand-off ceilings, enforced at fan-out acceptance rather than by the ledger. They live here
     * and not under `budgets:` because neither meters money: they bound the SHAPE of the task tree
     * (how deep a chain nests, how many children one task may open), which is what `execution:` is
     * for. The derived engine input keeps them in its own `delegation` slot — only the authored
     * placement moved.
     */
    delegation: z
      .object({
        maxDepth: z.number().int().positive().optional(),
        maxPerTask: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
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
    /** Named for its sibling `reviewPolicies`: both are declared policy RULE SETS, not instances. */
    approvalPolicies: z.array(WorkforceApprovalPolicySpec).default([]),
  })
  .strict();
export type WorkforceSpec = z.infer<typeof WorkforceSpec>;
