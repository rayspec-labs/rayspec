/**
 * An out-of-tree `ApprovalProvider`: park the question on a queue a human surface can drain.
 *
 * The one rule this seam has is that `request` returns a TICKET and never an answer. That is not a
 * style preference — a provider that could resolve the decision inline would turn an approval into a
 * blocking call, and the engine has no process to block: a waiting task is a row, and its resolution
 * arrives later through the resume surface. So the most a provider may do is record that somebody
 * was asked.
 *
 * `pending()` is this implementation's own surface for whatever drains the queue. It is deliberately
 * NOT part of the seam: the engine never reads it, and nothing about the decision travels back
 * through this object.
 */
import type { ApprovalProvider, ApprovalRequest, ApprovalTicket } from '@rayspec/core';

export interface QueuedApproval {
  readonly ticketId: string;
  readonly taskId: string;
  readonly approver: string;
  readonly reason: string;
  readonly requestedAt: string;
}

export class QueuedApprovalProvider implements ApprovalProvider {
  readonly id = 'queued-approvals';
  readonly #queue = new Map<string, QueuedApproval>();
  readonly #now: () => Date;
  #next = 0;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  request(request: ApprovalRequest): Promise<ApprovalTicket> {
    this.#next += 1;
    const ticket: ApprovalTicket = {
      ticketId: `queued-${this.#next}`,
      status: 'pending',
      requestedAt: this.#now().toISOString(),
    };
    this.#queue.set(ticket.ticketId, {
      ticketId: ticket.ticketId,
      taskId: request.taskId,
      approver: request.approver,
      reason: request.reason,
      requestedAt: ticket.requestedAt,
    });
    return Promise.resolve(ticket);
  }

  cancel(ticketId: string, _reason: string): Promise<void> {
    // A task that no longer needs the answer must not leave a dangling question on the queue.
    this.#queue.delete(ticketId);
    return Promise.resolve();
  }

  /** This provider's own surface, not the seam's: whatever drains the queue reads it here. */
  pending(): readonly QueuedApproval[] {
    return [...this.#queue.values()];
  }
}
