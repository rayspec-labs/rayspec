/**
 * `applyTransition()` — the ONLY writer of `workforce_tasks.status`.
 *
 * Every transition, whoever asks for it (scheduler, turn application, approval decision, sweep,
 * operator control), goes through this one function, and the exhaustiveness gate fails the build on
 * any other status write. The write protocol:
 *
 *   1. Read the row; refuse an unknown task, a corrupted status, or a version other than the one
 *      the caller presented (typed errors — the caller re-reads and retries, never force-writes).
 *   2. Validate (from, to, reason) against ALLOWED_TRANSITIONS + REASON_RULES (status.ts).
 *   3. Compare-and-swap UPDATE keyed on `version = expected`: sets status, statusReason,
 *      version + 1 and the lifecycle timestamps in ONE statement. Zero rows ⇒ a racer won between
 *      our read and our write ⇒ the same typed conflict. The UPDATE's row lock is held to COMMIT,
 *      so the transition-log append and the journal events below are serialized per task with the
 *      status write — the log and the row can never disagree.
 *   4. Append the workforce_task_transitions row (the audit spine; `turnNumber` set only by a
 *      turn's final application — its idempotency receipt under the partial UNIQUE).
 *   5. Journal `workforce.task.transitioned` (+ the lifecycle event the target status implies:
 *      `.queued` with its queue reason, `.completed`/`.failed`/`.cancelled` with the roll-up
 *      payload) BEFORE returning — a transition that did not journal did not happen.
 *
 * Runs in its own transaction (a savepoint when the caller is already transactional), so a caller
 * composing intents + transition atomically passes its transactional TenantDb and the whole
 * application commits or rolls back as one.
 */

import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, sql } from 'drizzle-orm';
import { TaskNotFoundError, TaskRowCorruptError, TaskVersionConflictError } from './errors.js';
import { appendTaskEvents, type WorkforceEventInput } from './events.js';
import { assertTransition, isTaskStatus, isTerminalStatus, type TaskStatus } from './status.js';

/** A workforce_tasks row as read back from the database. */
export type TaskRecord = typeof schema.workforceTasks.$inferSelect;

export interface ApplyTransitionInput {
  readonly taskId: string;
  /** The version the caller read; the compare-and-swap token. */
  readonly expectedVersion: number;
  readonly to: TaskStatus;
  /** A member of the closed StatusReason set, or null. Validated here, never assumed. */
  readonly reason?: string | null;
  /** Who drove the transition: an owner id, 'user', 'scheduler', or 'system'. */
  readonly actor: string;
  /** The dispatched turn's workflow id, when the transition belongs to a turn. */
  readonly turnId?: string;
  /** Set ONLY by a turn's final intent application — the receipt under the partial UNIQUE. */
  readonly turnNumber?: number;
  /** For `to: 'queued'` — what queued the task ('initial' or the absorbing signal kind). */
  readonly queueReason?: string;
  /**
   * For `to: 'working'` — the instant this claim's LEASE expires (`claim_expires_at`), written in
   * the same compare-and-swap UPDATE as the status so the lease can never disagree with the claim
   * it describes. Omitted (or on any other target) the column is set to NULL: leaving `working`
   * always releases the lease, and a `working` row driven there outside a dispatch holds none.
   */
  readonly leaseUntil?: Date;
}

export async function applyTransition(
  tdb: TenantDb,
  input: ApplyTransitionInput,
): Promise<TaskRecord> {
  return tdb.transaction(async (tx) => {
    const rows = (await tx
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.taskId, input.taskId))) as TaskRecord[];
    const current = rows[0];
    if (!current) throw new TaskNotFoundError(input.taskId);
    if (!isTaskStatus(current.status)) {
      throw new TaskRowCorruptError(input.taskId, `status '${current.status}'`);
    }
    if (current.version !== input.expectedVersion) {
      throw new TaskVersionConflictError(input.taskId, input.expectedVersion, current.version);
    }
    const from = current.status;
    const reason = assertTransition(from, input.to, input.reason ?? null);

    const terminal = isTerminalStatus(input.to);
    const updated = await tx
      .update(schema.workforceTasks, {
        status: input.to,
        statusReason: reason,
        version: input.expectedVersion + 1,
        ...(input.to === 'queued' ? { queuedAt: sql`now()` } : {}),
        // First entry into execution stamps startedAt; later turns keep the original.
        ...(input.to === 'working'
          ? { startedAt: sql`coalesce(${schema.workforceTasks.startedAt}, now())` }
          : {}),
        // THE CLAIM LEASE moves with the status, in this one statement: a claim stamps its expiry,
        // and EVERY exit from `working` clears it — a stale expiry must never be readable on a row
        // that holds no claim, or the reaper would re-reap a task it already re-queued. A `working`
        // target with no lease (a test/operator drive, not a dispatch) writes NULL, which the reaper
        // reads as "not a leased claim" and leaves alone.
        claimExpiresAt: input.to === 'working' ? (input.leaseUntil ?? null) : null,
        ...(terminal ? { completedAt: sql`now()` } : {}),
      })
      .where(
        and(
          eq(schema.workforceTasks.taskId, input.taskId),
          eq(schema.workforceTasks.version, input.expectedVersion),
        ),
      )
      .returning();
    const row = updated[0] as TaskRecord | undefined;
    if (!row) {
      // A racer committed between our read and our write; report what is there NOW.
      const again = (await tx
        .select(schema.workforceTasks)
        .where(eq(schema.workforceTasks.taskId, input.taskId))) as TaskRecord[];
      const now = again[0];
      if (!now) throw new TaskNotFoundError(input.taskId);
      throw new TaskVersionConflictError(input.taskId, input.expectedVersion, now.version);
    }

    await tx.insert(schema.workforceTaskTransitions, {
      taskId: input.taskId,
      fromStatus: from,
      toStatus: input.to,
      statusReason: reason,
      actor: input.actor,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.turnNumber !== undefined ? { turnNumber: input.turnNumber } : {}),
    });

    const events: WorkforceEventInput[] = [
      {
        type: 'workforce.task.transitioned',
        payload: {
          taskId: input.taskId,
          from,
          to: input.to,
          statusReason: reason,
          actor: input.actor,
        },
      },
    ];
    if (input.to === 'queued') {
      events.push({
        type: 'workforce.task.queued',
        payload: {
          taskId: input.taskId,
          parentTaskId: row.parentTaskId,
          owner: row.owner,
          requestedBy: row.requestedBy,
          priority: row.priority,
          queueReason: input.queueReason ?? 'initial',
        },
      });
    }
    if (terminal) {
      const terminalType =
        input.to === 'completed'
          ? 'workforce.task.completed'
          : input.to === 'failed'
            ? 'workforce.task.failed'
            : 'workforce.task.cancelled';
      const summary =
        row.result !== null && typeof row.result === 'object' && 'summary' in row.result
          ? (row.result as { summary?: unknown }).summary
          : null;
      events.push({
        type: terminalType,
        payload: {
          taskId: input.taskId,
          statusReason: reason,
          resultSummary: typeof summary === 'string' ? summary : null,
          confidence: row.confidence,
          totalCostUsd: row.costUsd,
          turnsUsed: row.turnsUsed,
        },
      });
    }
    await appendTaskEvents(tx, input.taskId, events);
    return row;
  });
}
