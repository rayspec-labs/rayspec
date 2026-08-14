/**
 * ApprovalProvider — the neutral human-decision seam.
 *
 * `request` MUST return a TICKET, never a resolved decision. Approval is asynchronous by contract:
 * the task parks with no process attached, a human decides out-of-band, and the resolution arrives
 * through the resume surface — a provider that could block on the decision would reintroduce the
 * long-lived wait the engine's whole design forbids. `cancel` withdraws a pending ticket (a task
 * that no longer needs the answer must not leave a dangling question).
 *
 * The durable engine binds its own persistent, swept, CLI-decidable implementation over the
 * approval rows — the same arrangement CostPolicy has with its ledger-backed implementation. The
 * default here is for compositions where NO decision surface is bound: it fails closed and loudly
 * instead of pretending a question was asked.
 */

export interface ApprovalRequest {
  readonly taskId: string;
  readonly requestedBy: string;
  /** Who decides; 'user' names the deployment's human operator surface. */
  readonly approver: string;
  readonly reason: string;
  /** The enforced fate window; null means the caller declared no timeout. */
  readonly timeoutMs: number | null;
  readonly onTimeout: 'fail' | 'escalate';
}

/** A PENDING handle. Never a decision — resolution arrives through the resume surface. */
export interface ApprovalTicket {
  readonly ticketId: string;
  readonly status: 'pending';
  readonly requestedAt: string;
}

/** No decision surface is bound in this composition. Fail-closed, never a fabricated ticket. */
export class ApprovalUnroutedError extends Error {
  constructor(operation: 'request' | 'cancel') {
    super(
      `approval ${operation} has no bound decision surface in this composition — ` +
        'a question nobody can answer must fail loudly, not park forever. Fail-closed.',
    );
    this.name = 'ApprovalUnroutedError';
  }
}

export interface ApprovalProvider {
  readonly id: string;
  /** MUST return a ticket, never a resolved decision. Resolution arrives via the resume surface. */
  request(request: ApprovalRequest): Promise<ApprovalTicket>;
  cancel(ticketId: string, reason: string): Promise<void>;
}

/**
 * The honest default for a composition with no decision surface: both operations throw the typed
 * refusal. The durable engine's approval rows are the real implementation; this default exists so
 * the seam is never silently absent.
 */
export class UnroutedApprovalProvider implements ApprovalProvider {
  readonly id = 'unrouted';

  request(_request: ApprovalRequest): Promise<ApprovalTicket> {
    return Promise.reject(new ApprovalUnroutedError('request'));
  }

  cancel(_ticketId: string, _reason: string): Promise<void> {
    return Promise.reject(new ApprovalUnroutedError('cancel'));
  }
}
