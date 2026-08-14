/**
 * The task-engine journal vocabulary and its ONE writer — no shadow observability system.
 *
 * Events land in the EXISTING append-only `run_events` table: task-scoped events under
 * `run_id = <taskId>`, workforce-scoped control events under `run_id = workforce:<workforceId>`.
 * `run_id` is a plain text key with no FK, and nothing joins run_events against `runs`, so the two
 * namespaces coexist with the agent-run streams without touching them; the per-task events route
 * replays `run_id = <taskId>` ordered by `seq` exactly as the run replay does.
 *
 * Seq allocation is the `tenant_event_streams.last_seq` mechanism applied per task: the counter
 * lives ON the task row (`workforce_tasks.last_event_seq`), the allocating UPDATE's row lock is
 * held until COMMIT, so ALLOCATION ORDER EQUALS COMMIT ORDER and a `seq > cursor` replay can never
 * skip an event that committed late. Because every transition already updates the task row,
 * allocation and status write share one lock — and an event-only writer's counter UPDATE *is* its
 * lock, with no separate SELECT ... FOR UPDATE step to forget. Control events allocate from
 * `workforce_runtime.last_event_seq` the same way.
 *
 * Every event's `data` carries `v: 1` — the versioned-vocabulary contract. Adding an event type is
 * a minor change; changing a payload field is a major one.
 */

import { schema, type TenantDb } from '@rayspec/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { TaskNotFoundError, WorkforceUnknownError } from './errors.js';

/** The version stamped into every event's `data.v`. */
export const WORKFORCE_EVENT_VERSION = 1;

/** The closed event vocabulary this engine emits. */
export const WORKFORCE_EVENT_TYPES = [
  'workforce.task.created',
  'workforce.task.queued',
  'workforce.task.turn_started',
  'workforce.task.turn_ended',
  'workforce.task.transitioned',
  'workforce.task.completed',
  'workforce.task.failed',
  'workforce.task.cancelled',
  'workforce.task.dependency_failed',
  'workforce.approval.requested',
  'workforce.approval.decided',
  'workforce.approval.timed_out',
  'workforce.review.requested',
  'workforce.review.decided',
  'workforce.delegation.accepted',
  'workforce.delegation.rejected',
  'workforce.budget.reserved',
  'workforce.budget.settled',
  'workforce.budget.exceeded',
  /** An exceedance whose escalation the root's park refuses; it surfaces at the next denial. */
  'workforce.budget.escalation_deferred',
  'workforce.control.paused',
  'workforce.control.resumed',
  'workforce.control.halted',
] as const;

export type WorkforceEventType = (typeof WORKFORCE_EVENT_TYPES)[number];

/** One event to append: the closed type plus its payload fields (merged into `data` beside `v`). */
export interface WorkforceEventInput {
  readonly type: WorkforceEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The read-side envelope validator. Stored `data` is validated ON READ before it is served (the
 * conversation-payload lesson: rows are DATA and a row that does not match the envelope is dropped
 * by the reader, never trusted). The envelope is strict on `v` and `type`; the per-type payload
 * fields ride alongside and are passed through as data.
 */
export const workforceJournalEventSchema = z
  .looseObject({
    v: z.literal(WORKFORCE_EVENT_VERSION),
    type: z.enum(WORKFORCE_EVENT_TYPES),
  })
  .readonly();

/** The run_events `run_id` under which a workforce's control events are journaled. */
export function workforceControlStreamId(workforceId: string): string {
  return `workforce:${workforceId}`;
}

function eventRows(
  streamId: string,
  lastSeq: number,
  events: readonly WorkforceEventInput[],
): Record<string, unknown>[] {
  const firstSeq = lastSeq - events.length + 1;
  return events.map((ev, i) => ({
    runId: streamId,
    seq: String(firstSeq + i),
    type: ev.type,
    data: { v: WORKFORCE_EVENT_VERSION, type: ev.type, ...ev.payload },
  }));
}

/**
 * Append events to a TASK's journal stream. The counter UPDATE on the task row is the lock; the
 * inserts commit (or roll back) with the caller's transaction, so the stream never carries an
 * event for work that did not happen. Returns the allocated seq range.
 */
export async function appendTaskEvents(
  tdb: TenantDb,
  taskId: string,
  events: readonly WorkforceEventInput[],
): Promise<{ firstSeq: number; lastSeq: number } | undefined> {
  if (events.length === 0) return undefined;
  const alloc = await tdb
    .update(schema.workforceTasks, {
      lastEventSeq: sql`${schema.workforceTasks.lastEventSeq} + ${events.length}`,
    })
    .where(eq(schema.workforceTasks.taskId, taskId))
    .returning({ lastEventSeq: schema.workforceTasks.lastEventSeq });
  const head = alloc[0];
  if (!head) throw new TaskNotFoundError(taskId);
  await tdb.insert(schema.runEvents, eventRows(taskId, head.lastEventSeq, events));
  return { firstSeq: head.lastEventSeq - events.length + 1, lastSeq: head.lastEventSeq };
}

/**
 * Append control events to a WORKFORCE's journal stream (`workforce:<id>`), allocating from the
 * runtime row's counter under the same lock discipline.
 */
export async function appendWorkforceEvents(
  tdb: TenantDb,
  workforceId: string,
  events: readonly WorkforceEventInput[],
): Promise<{ firstSeq: number; lastSeq: number } | undefined> {
  if (events.length === 0) return undefined;
  const alloc = await tdb
    .update(schema.workforceRuntime, {
      lastEventSeq: sql`${schema.workforceRuntime.lastEventSeq} + ${events.length}`,
      updatedAt: sql`now()`,
    })
    .where(eq(schema.workforceRuntime.workforceId, workforceId))
    .returning({ lastEventSeq: schema.workforceRuntime.lastEventSeq });
  const head = alloc[0];
  if (!head) throw new WorkforceUnknownError(workforceId);
  await tdb.insert(
    schema.runEvents,
    eventRows(workforceControlStreamId(workforceId), head.lastEventSeq, events),
  );
  return { firstSeq: head.lastEventSeq - events.length + 1, lastSeq: head.lastEventSeq };
}
