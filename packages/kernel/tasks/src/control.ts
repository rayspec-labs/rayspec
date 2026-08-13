/**
 * Operator cancellation — the cascade a route-level cancel (and, transitively, a halt) applies.
 * Root-first, never mid-flight: a parked task transitions to `cancelled` immediately; a `working`
 * task gets a `cancel` signal its own turn absorbs at the boundary (the turn finishes and settles,
 * then its outcome IS the cancellation, and its descendants cascade from there).
 */
import { schema, type TenantDb } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { afterTaskTerminal, cancelDescendants } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { TaskNotFoundError, TaskRowCorruptError } from './errors.js';
import { deliverSignal } from './signals.js';
import { isTaskStatus, isTerminalStatus } from './status.js';

export interface CancelCascadeOutcome {
  /** Task ids transitioned to `cancelled` in this call. */
  readonly cancelled: string[];
  /** Working task ids that received the absorb-at-turn-boundary cancel signal instead. */
  readonly signalled: string[];
}

export async function cancelTaskCascade(
  tdb: TenantDb,
  input: { readonly taskId: string; readonly actor: string; readonly reason?: string },
): Promise<CancelCascadeOutcome> {
  return tdb.transaction(async (tx) => {
    const rows = (await tx
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.taskId, input.taskId))) as TaskRecord[];
    const task = rows[0];
    if (!task) throw new TaskNotFoundError(input.taskId);
    if (!isTaskStatus(task.status)) {
      throw new TaskRowCorruptError(input.taskId, `status '${task.status}'`);
    }
    if (isTerminalStatus(task.status)) return { cancelled: [], signalled: [] };

    const outcome: { cancelled: string[]; signalled: string[] } = { cancelled: [], signalled: [] };
    if (task.status === 'working') {
      // Never kill a turn mid-flight: the target absorbs the cancel at its own boundary (and its
      // turn's cancellation cascades to the descendants it still owns then). Descendants that are
      // NOT mid-turn cancel now — schedules are cancelled, in-flight work is not.
      await deliverSignal(tx, {
        taskId: task.taskId,
        kind: 'cancel',
        signalKey: `cancel:${input.taskId}`,
        payload: { requestedBy: input.actor, reason: input.reason ?? null },
        actor: input.actor,
      });
      outcome.signalled.push(task.taskId);
      const cascade = await cancelDescendants(tx, task, input.actor);
      outcome.cancelled.push(...cascade.cancelled);
      outcome.signalled.push(...cascade.signalled);
      return outcome;
    }
    const done = await applyTransition(tx, {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'cancelled',
      reason: 'cancelled_by_user',
      actor: input.actor,
    });
    outcome.cancelled.push(done.taskId);
    const cascade = await cancelDescendants(tx, done, input.actor);
    outcome.cancelled.push(...cascade.cancelled);
    outcome.signalled.push(...cascade.signalled);
    await afterTaskTerminal(tx, done);
    return outcome;
  });
}
