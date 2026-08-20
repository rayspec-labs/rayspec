/**
 * The task state machine — the CLOSED nine-status set, the CLOSED status-reason set, and the frozen
 * transition table that is the SINGLE authority on which moves are legal.
 *
 * Three rules carry the whole design:
 *   - `ALLOWED_TRANSITIONS` spells out EVERY (from, to) pair explicitly — all 81 of them, no
 *     defaulting, no wildcards — and the three terminal rows (`completed`, `failed`, `cancelled`)
 *     are all-false unconditionally: re-opening finished work means a NEW task with `parentTaskId`
 *     set, never a resurrected row. The exhaustiveness gate
 *     (scripts/check-state-machine-exhaustive.mjs) fails the build if a cell goes missing or a
 *     terminal row gains a truthy cell.
 *   - The only way back into execution is `queued`: the `working` column is true ONLY on the
 *     `queued` row. Nothing resumes "in place"; every re-entry is a fresh, journaled turn dispatch.
 *     That single invariant is what makes restart survival free — a wait state is a row with no
 *     process attached.
 *   - `statusReason` is a CLOSED union, never free text. Operators grep on reasons; strings written
 *     by models are not operator UX. `REASON_RULES` names, per reason, the statuses it may
 *     accompany, and `assertTransition` enforces it — the gate asserts the rule set covers every
 *     reason so an added reason without a rule is a build failure, not a runtime surprise.
 *
 * Transitions are enforced by THIS module and applied by `applyTransition()` (apply-transition.ts),
 * the sole writer of the status column — never by prose, never by a second code path.
 */

/** The closed nine-status set. No tenth status ships without a design review. */
export const TASK_STATUSES = [
  'planned',
  'queued',
  'working',
  'blocked',
  'waiting_for_review',
  'waiting_for_user',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The three terminal statuses — no outgoing transitions whatsoever. */
export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminalStatus(status: TaskStatus): status is TerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * The closed status-reason set. A reason names WHY a task sits in its current status — a typed,
 * greppable fact, never model prose. Free-text reasons are rejected at the type level and at
 * runtime (`assertTransition`).
 */
export const STATUS_REASONS = [
  'awaiting_children',
  'awaiting_dependency',
  /** A declared dependency ended terminal without completing — the wait can never be satisfied. */
  'dependency_failed',
  'escalated',
  'budget_exhausted',
  'deadline_exceeded',
  'approval_pending',
  'review_pending',
  'clarification_pending',
  'tool_error',
  'owner_undeclared',
  'cancelled_by_user',
  'cancelled_by_parent',
  'quarantined',
] as const;

export type StatusReason = (typeof STATUS_REASONS)[number];

type TransitionRow = Readonly<Record<TaskStatus, boolean>>;

/**
 * The frozen transition table. EVERY cell explicit; the exhaustiveness gate holds this shape.
 * Row = from, column = to. The justification for each true cell, in row order:
 *
 *   planned → queued        dependencies met and dispatchable
 *   planned → blocked       unmet dependencies (`awaiting_dependency`)
 *   planned → failed        creation-time validation failure; a decided dependency
 *                           (`dependency_failed`)
 *   planned → cancelled     cancelled before ever dispatching
 *   queued  → working       scheduler dispatch — THE one door into execution
 *   queued  → blocked       dispatch-boundary denial (`budget_exhausted`, `deadline_exceeded`)
 *   queued  → failed        pre-dispatch failure (e.g. retry budget exhausted)
 *   queued  → cancelled     cancelled while waiting for a slot
 *   working → queued        normal end of a non-terminal turn (more to do)
 *   working → blocked       fan-out (`awaiting_children`), clarification, escalation
 *   working → waiting_for_review   a review was requested
 *   working → waiting_for_user     an approval was requested (`approval_pending`)
 *   working → completed     a schema-valid result with no review demanded
 *   working → failed        the turn failed terminally
 *   working → cancelled     a cancel signal absorbed at the turn boundary
 *   blocked → queued        any wake signal
 *   blocked → waiting_for_user     escalation to a human (incl. block-and-escalate exhaustion, and
 *                           a REJECTED approval gate: the work stands, the release does not)
 *   blocked → completed     THE APPROVAL GATE, and nothing else. A declared `approvalPolicies` rule
 *                           intercepts a completion: the result is stored, the task parks in
 *                           `blocked(approval_pending)`, and a human's `approve` releases it
 *                           (approvals.ts `decideApproval`, under the park's own binding). It is
 *                           the ONLY cell in this table whose driver is a human decision rather
 *                           than a turn or a mechanism, and the only edge into `completed` that
 *                           does not come from `working` or `waiting_for_review`. Without it a
 *                           declared gate could park a completion and never release it — which is
 *                           why `requireWhen` could not previously require anything at all.
 *   blocked → failed        an enforced fate (quarantine retry budget spent; `dependency_failed`;
 *                           an escalated approval's own timeout, whose park is the blocked one;
 *                           an approval gate's `onTimeout: fail`, which now costs a finished
 *                           result rather than an unanswered question — see docs/spec-reference.md)
 *   blocked → cancelled     cancel cascade
 *   waiting_for_review → queued    reviewer rejected and the policy says rework
 *   waiting_for_review → blocked   the review round itself hit a ceiling
 *   waiting_for_review → waiting_for_user  review rounds exhausted — a human decides
 *   waiting_for_review → completed reviewer accepted
 *   waiting_for_review → failed    terminal failure during review
 *   waiting_for_review → cancelled cancel cascade
 *   waiting_for_user → queued      an `approval_decided` / `user_reply` signal
 *   waiting_for_user → blocked     approval timeout escalated to the next approver
 *   waiting_for_user → failed      approval timeout with `onTimeout: fail`
 *   waiting_for_user → cancelled   cancel cascade
 *
 * Terminal rows: every cell false, unconditionally.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, TransitionRow>> = Object.freeze({
  planned: Object.freeze({
    planned: false,
    queued: true,
    working: false,
    blocked: true,
    waiting_for_review: false,
    waiting_for_user: false,
    completed: false,
    failed: true,
    cancelled: true,
  }),
  queued: Object.freeze({
    planned: false,
    queued: false,
    working: true,
    blocked: true,
    waiting_for_review: false,
    waiting_for_user: false,
    completed: false,
    failed: true,
    cancelled: true,
  }),
  working: Object.freeze({
    planned: false,
    queued: true,
    working: false,
    blocked: true,
    waiting_for_review: true,
    waiting_for_user: true,
    completed: true,
    failed: true,
    cancelled: true,
  }),
  blocked: Object.freeze({
    planned: false,
    queued: true,
    working: false,
    blocked: false,
    waiting_for_review: false,
    waiting_for_user: true,
    // THE APPROVAL GATE's release, and nothing else — see the row-by-row justification above.
    completed: true,
    failed: true,
    cancelled: true,
  }),
  waiting_for_review: Object.freeze({
    planned: false,
    queued: true,
    working: false,
    blocked: true,
    waiting_for_review: false,
    waiting_for_user: true,
    completed: true,
    failed: true,
    cancelled: true,
  }),
  waiting_for_user: Object.freeze({
    planned: false,
    queued: true,
    working: false,
    blocked: true,
    waiting_for_review: false,
    waiting_for_user: false,
    completed: false,
    failed: true,
    cancelled: true,
  }),
  completed: Object.freeze({
    planned: false,
    queued: false,
    working: false,
    blocked: false,
    waiting_for_review: false,
    waiting_for_user: false,
    completed: false,
    failed: false,
    cancelled: false,
  }),
  failed: Object.freeze({
    planned: false,
    queued: false,
    working: false,
    blocked: false,
    waiting_for_review: false,
    waiting_for_user: false,
    completed: false,
    failed: false,
    cancelled: false,
  }),
  cancelled: Object.freeze({
    planned: false,
    queued: false,
    working: false,
    blocked: false,
    waiting_for_review: false,
    waiting_for_user: false,
    completed: false,
    failed: false,
    cancelled: false,
  }),
});

/**
 * Per reason: the CLOSED set of target statuses it may accompany. Exhaustive over STATUS_REASONS —
 * the gate asserts key-set equality, so a reason added without a rule fails the build. A transition
 * whose reason is absent from its target's rule set is refused (`assertTransition`).
 */
export const REASON_RULES: Readonly<Record<StatusReason, readonly TaskStatus[]>> = Object.freeze({
  awaiting_children: ['blocked'],
  awaiting_dependency: ['blocked'],
  dependency_failed: ['failed'],
  escalated: ['blocked'],
  budget_exhausted: ['blocked'],
  deadline_exceeded: ['blocked'],
  approval_pending: ['waiting_for_user', 'blocked'],
  review_pending: ['waiting_for_review'],
  clarification_pending: ['blocked'],
  tool_error: ['queued', 'failed'],
  owner_undeclared: ['blocked'],
  cancelled_by_user: ['cancelled'],
  cancelled_by_parent: ['cancelled'],
  quarantined: ['blocked', 'failed'],
});

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isStatusReason(value: string): value is StatusReason {
  return (STATUS_REASONS as readonly string[]).includes(value);
}

export class TaskTransitionIllegalError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  constructor(from: TaskStatus, to: TaskStatus) {
    super(
      `task transition ${from} -> ${to} is not in ALLOWED_TRANSITIONS — refusing to apply it. ` +
        'This is a fail-closed rejection, not a silent no-op.',
    );
    this.name = 'TaskTransitionIllegalError';
    this.from = from;
    this.to = to;
  }
}

export class StatusReasonInvalidError extends Error {
  readonly to: TaskStatus;
  readonly reason: string;
  constructor(to: TaskStatus, reason: string) {
    super(
      `status reason '${reason}' is not legal for target status '${to}' — reasons are a closed, ` +
        'per-status set (REASON_RULES), never free text. Fail-closed.',
    );
    this.name = 'StatusReasonInvalidError';
    this.to = to;
    this.reason = reason;
  }
}

/**
 * Validate one proposed transition against the table and the reason rules. Throws typed errors;
 * returns the narrowed reason. This is the ONLY legality check — `applyTransition()` calls it and
 * nothing else re-implements it. `reason` is accepted as a plain string because it arrives from
 * rows and request bodies; membership in the closed set is checked HERE, not assumed.
 */
export function assertTransition(
  from: TaskStatus,
  to: TaskStatus,
  reason: string | null,
): StatusReason | null {
  if (!ALLOWED_TRANSITIONS[from][to]) {
    throw new TaskTransitionIllegalError(from, to);
  }
  if (reason === null) return null;
  if (!isStatusReason(reason)) {
    throw new StatusReasonInvalidError(to, reason);
  }
  if (!REASON_RULES[reason].includes(to)) {
    throw new StatusReasonInvalidError(to, reason);
  }
  return reason;
}
