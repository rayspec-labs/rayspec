import { createHash, randomUUID } from 'node:crypto';

/**
 * Task ids. A ROOT task gets a random UUID — its identity is born at creation. A CHILD task's id is
 * DETERMINISTIC in `(tenant, parent task, turn, slot index)`: a fan-out is applied inside a turn
 * whose whole body re-executes on crash recovery, so a re-derived application collides on the
 * primary key (plus the delegation UNIQUE) and aborts loudly instead of opening a second set of
 * children — the defense-in-depth layer beneath the receipt guard that makes re-execution a clean
 * no-op in the first place. Same construction as `durableWorkflowRunId` in @rayspec/workflow-durable:
 * tenant-namespaced by construction, formatted as a v5-shaped UUID over a SHA-256 so it reads as a
 * normal UUID while staying a pure function of the inputs. NOT security-sensitive — determinism and
 * tenant-disjointness are the contract, not RFC-4122 namespace semantics.
 */

export function newRootTaskId(): string {
  return randomUUID();
}

export function deterministicChildTaskId(
  tenantId: string,
  parentTaskId: string,
  turnNumber: number,
  slotIndex: number,
): string {
  const h = createHash('sha256')
    .update(`${tenantId}:${parentTaskId}:${turnNumber}:${slotIndex}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
