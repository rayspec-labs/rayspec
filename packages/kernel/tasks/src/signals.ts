/**
 * Wake signals — resume is a ROW, not a process.
 *
 * A signal is one row in `workforce_task_signals`, idempotent on `(tenant, task, signal_key)`: a
 * re-sent delivery collides on the UNIQUE key and no-ops instead of waking a task twice. The kind
 * set is CLOSED; free-text signal kinds are refused at the edge. Delivery wakes a parked task by
 * re-queueing it through `applyTransition` (the matrix rules: `blocked` wakes on ANY wake kind,
 * `waiting_for_user` only on a decision-shaped one), and the wake carries the signal kind as the
 * queue reason so the journal says WHY the task woke. A signal delivered to a task that is not in
 * a wakeable state stays pending and is consumed at the next turn boundary (`cancel` is exactly
 * that: recorded now, absorbed at the turn's end — never killing a turn mid-flight).
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { TaskNotFoundError, TaskRowCorruptError, TaskVersionConflictError } from './errors.js';
import { isTaskStatus, type TaskStatus } from './status.js';

/** The closed signal vocabulary. */
export const SIGNAL_KINDS = [
  'approval_decided',
  'review_verdict',
  'child_completed',
  'dependency_completed',
  'escalated',
  'user_reply',
  'budget_raised',
  'manual_unblock',
  'cancel',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const signalKindSchema = z.enum(SIGNAL_KINDS);

/**
 * Which parked statuses each kind wakes. `blocked` wakes on any wake signal (the matrix's
 * `blocked -> queued` row); `waiting_for_user` wakes only on a decision (`approval_decided`,
 * `user_reply`) — a child completing must not release a task parked on a human. `cancel` wakes
 * nothing: it is absorbed at a turn boundary or applied by the cancel cascade.
 */
const WAKES: Readonly<Record<SignalKind, readonly TaskStatus[]>> = Object.freeze({
  approval_decided: ['blocked', 'waiting_for_user'],
  review_verdict: ['blocked'],
  child_completed: ['blocked'],
  dependency_completed: ['blocked'],
  escalated: ['blocked'],
  user_reply: ['blocked', 'waiting_for_user'],
  budget_raised: ['blocked'],
  manual_unblock: ['blocked'],
  cancel: [],
});

export type SignalRecord = typeof schema.workforceTaskSignals.$inferSelect;

export interface DeliverSignalInput {
  readonly taskId: string;
  readonly kind: SignalKind;
  /** The delivery's idempotency key (e.g. `approval:<id>`, `join:<parentId>`). */
  readonly signalKey: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly actor: string;
}

export interface DeliverSignalOutcome {
  /** False when the UNIQUE key deduplicated the delivery (nothing changed). */
  readonly delivered: boolean;
  /** True when the delivery re-queued the task. */
  readonly woke: boolean;
}

const WAKE_RETRIES = 3;

/**
 * Deliver one signal: record the row (idempotent) and wake the task if its current status admits
 * this kind. The signal row and the wake transition commit together; a lost version race re-reads
 * and retries a bounded number of times (a racer that already woke the task makes the retry a
 * no-op because the status is no longer wakeable).
 */
export async function deliverSignal(
  tdb: TenantDb,
  input: DeliverSignalInput,
): Promise<DeliverSignalOutcome> {
  return tdb.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.workforceTaskSignals, {
        taskId: input.taskId,
        kind: input.kind,
        signalKey: input.signalKey,
        payload: input.payload ?? {},
      })
      .onConflictDoNothing()
      .returning({ id: schema.workforceTaskSignals.id });
    if (inserted.length === 0) return { delivered: false, woke: false };
    const signalId = (inserted[0] as { id: string }).id;

    for (let attempt = 1; attempt <= WAKE_RETRIES; attempt++) {
      const rows = (await tx
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.taskId, input.taskId))) as TaskRecord[];
      const task = rows[0];
      if (!task) throw new TaskNotFoundError(input.taskId);
      if (!isTaskStatus(task.status)) {
        throw new TaskRowCorruptError(input.taskId, `status '${task.status}'`);
      }
      if (!WAKES[input.kind].includes(task.status)) {
        // Not wakeable right now — the signal stays pending for the next turn boundary.
        return { delivered: true, woke: false };
      }
      try {
        await applyTransition(tx, {
          taskId: input.taskId,
          expectedVersion: task.version,
          to: 'queued',
          actor: input.actor,
          queueReason: input.kind,
        });
        await tx
          .update(schema.workforceTaskSignals, { consumedAt: new Date() })
          .where(eq(schema.workforceTaskSignals.id, signalId));
        return { delivered: true, woke: true };
      } catch (err) {
        if (err instanceof TaskVersionConflictError && attempt < WAKE_RETRIES) continue;
        throw err;
      }
    }
    // Unreachable: the loop either returns or rethrows on its final attempt.
    throw new TaskVersionConflictError(input.taskId, -1, -1);
  });
}

/**
 * Consume every still-pending signal for a task (marks consumed_at, returns the rows) — called by
 * the turn's final transaction so signal payloads reach the next context and a pending `cancel`
 * overrides the turn's own outcome.
 */
export async function consumePendingSignals(tx: TenantDb, taskId: string): Promise<SignalRecord[]> {
  const rows = (await tx
    .update(schema.workforceTaskSignals, { consumedAt: new Date() })
    .where(
      and(
        eq(schema.workforceTaskSignals.taskId, taskId),
        isNull(schema.workforceTaskSignals.consumedAt),
      ),
    )
    .returning()) as SignalRecord[];
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
