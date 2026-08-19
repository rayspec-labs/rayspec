/**
 * Typed toolset errors. Every message is MODEL-FACING: it surfaces through the tool-dispatch
 * chokepoint as a fail-closed `tool_error` result the model reads and may recover from — so each
 * says what was refused and what the legitimate move is, and never leaks anything the turn's own
 * context does not already contain.
 */

/** Base class — a toolset refusal the dispatch chokepoint turns into a typed tool error. */
export class WorkforceToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkforceToolError';
  }
}

/** A second turn-ending tool call in one turn — the FIRST intent stands, this call recorded nothing. */
export class TurnAlreadyEndedError extends WorkforceToolError {
  readonly firstKind: string;
  constructor(firstKind: string) {
    super(
      `this turn already ended with '${firstKind}' — exactly one turn-ending tool may be called ` +
        'per turn, and the result of this call was NOT recorded. End the turn.',
    );
    this.name = 'TurnAlreadyEndedError';
    this.firstKind = firstKind;
  }
}

export class DelegationTargetInvalidError extends WorkforceToolError {
  constructor(raw: string, detail: string) {
    super(`delegation target '${raw}' is invalid: ${detail}`);
    this.name = 'DelegationTargetInvalidError';
  }
}

export class ManagerTargetForbiddenError extends WorkforceToolError {
  constructor(manager: string, target: string, detail?: string) {
    super(
      `manager '${manager}' may not delegate to '${target}' — a manager's legal targets are the ` +
        'members of their own department, plus the members of a team they lead while the task is ' +
        "that team's work" +
        (detail === undefined ? '.' : `: ${detail}.`),
    );
    this.name = 'ManagerTargetForbiddenError';
  }
}

/**
 * An approval rule declares `onTimeout: 'escalate'` for an employee with no superior — the
 * reporting chain roots at the orchestrator, so there is no next approver to name. The lint refuses
 * such a document at parse; this is the defense for a code-built configuration that never went
 * through it, and it keeps the refusal a typed tool error on the declared fate rather than an
 * intent the planner rejects deterministically on every retry until the task fails.
 */
export class ApprovalEscalationTargetMissingError extends WorkforceToolError {
  constructor(employeeId: string, ruleId: string) {
    super(
      `approval rule '${ruleId}' escalates on timeout, but employee '${employeeId}' has no ` +
        'superior to escalate to — an approval this seat requests can only have a human fate. ' +
        'Declare the rule with onTimeout: fail for this seat.',
    );
    this.name = 'ApprovalEscalationTargetMissingError';
  }
}

/**
 * The seat is re-asking a decision a human ALREADY RESOLVED on this task (approved or rejected).
 *
 * The engine refuses this too (`planTurnOutcome`, @rayspec/tasks) and that arm is the authority —
 * it catches every caller, toolset or not. THIS arm exists so the seat finds out INSIDE the turn,
 * while it can still call a different turn-ending tool: the engine's refusal lands only after the
 * turn ended, takes the requeue-once-then-fail fate, and a seat told nothing simply asks again and
 * fails its task. The message therefore names the decision it already holds and the legitimate
 * moves, and nothing else — the question is already in this turn's own context.
 */
export class ApprovalAlreadyResolvedError extends WorkforceToolError {
  constructor(question: string) {
    super(
      `a human has already decided '${question}' on this task — a resolved approval may not be ` +
        're-requested. Act on the decision you already hold (the wake that re-queued this task ' +
        'carries it), or ask about a genuinely different decision.',
    );
    this.name = 'ApprovalAlreadyResolvedError';
  }
}

export class EscalationTargetMissingError extends WorkforceToolError {
  constructor(employeeId: string) {
    super(
      `employee '${employeeId}' has no superior to escalate to — use request_approval or ` +
        'request_clarification to reach a human instead.',
    );
    this.name = 'EscalationTargetMissingError';
  }
}

export class ReservedToolNameError extends WorkforceToolError {
  constructor(name: string) {
    super(
      `declared tool '${name}' collides with a native workforce tool — natives are injected by ` +
        'role at dispatch and always win. Rename the declared tool.',
    );
    this.name = 'ReservedToolNameError';
  }
}

export class TaskNotVisibleError extends WorkforceToolError {
  constructor(taskId: string) {
    super(
      `task '${taskId}' is not visible from this turn — read tools answer from the caller's own ` +
        'subtree snapshot only (or it sits beyond the snapshot page).',
    );
    this.name = 'TaskNotVisibleError';
  }
}
