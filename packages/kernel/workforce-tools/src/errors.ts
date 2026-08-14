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
  constructor(manager: string, target: string) {
    super(
      `manager '${manager}' may not delegate to '${target}' — a manager's legal targets are the ` +
        'members of their own department, the teams they lead, and the members of those teams.',
    );
    this.name = 'ManagerTargetForbiddenError';
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
