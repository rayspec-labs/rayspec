/**
 * Operator control — the workforce-level verbs (pause / resume / halt) and the cancel cascade.
 *
 * `pause` is a FLAG on the workforce_runtime row, deliberately not a task status: a paused
 * workforce's tasks stay visibly `queued` (the scheduler just stops reserving them), so an
 * operator who pauses at night and resumes in the morning loses nothing and burns nothing. With
 * `drain: true` the call returns only when every `working` task has ended its own turn — drained,
 * never killed. `halt` is pause-with-drain followed by a root-first cancel of every non-terminal
 * task. All three journal `workforce.control.*` events on the workforce's own stream.
 *
 * The cancel cascade is root-first and never mid-flight: a parked task transitions to `cancelled`
 * immediately; a `working` task gets a `cancel` signal its own turn absorbs at the boundary (the
 * turn finishes and settles, then its outcome IS the cancellation, and its descendants cascade
 * from there).
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterTaskTerminal, cancelDescendants } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { TaskNotFoundError, TaskRowCorruptError } from './errors.js';
import { appendWorkforceEvents } from './events.js';
import { ensureWorkforceRuntime, type WorkforceRuntimeRecord } from './runtime.js';
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

/** How long a drain politely waits for in-flight turns before refusing (fail-loud, not forever). */
const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const DRAIN_POLL_MS = 250;

export class WorkforceDrainTimeoutError extends Error {
  readonly workforceId: string;
  readonly stillWorking: number;
  constructor(workforceId: string, stillWorking: number, timeoutMs: number) {
    super(
      `workforce '${workforceId}' still has ${stillWorking} working task(s) after draining for ` +
        `${timeoutMs}ms — the pause is in force (nothing new reserves) but the drain did not ` +
        'complete in time. Re-issue the drain, or wait for the turns to end. Fail-closed.',
    );
    this.name = 'WorkforceDrainTimeoutError';
    this.workforceId = workforceId;
    this.stillWorking = stillWorking;
  }
}

async function workingCount(tdb: TenantDb, workforceId: string): Promise<number> {
  const rows = await tdb
    .select(schema.workforceTasks, { taskId: schema.workforceTasks.taskId })
    .where(
      and(
        eq(schema.workforceTasks.workforceId, workforceId),
        eq(schema.workforceTasks.status, 'working'),
      ),
    );
  return rows.length;
}

export interface PauseWorkforceInput {
  readonly workforceId: string;
  readonly actor: string;
  /** With drain, the call returns only when every working task has ended its turn. */
  readonly drain?: boolean;
  readonly drainTimeoutMs?: number;
}

/**
 * Stop reserving for this workforce. The flag write and the control event commit together; the
 * optional drain then POLLS (outside any transaction — a held transaction would block the very
 * turns it waits for) until no task is `working`.
 */
export async function pauseWorkforce(
  tdb: TenantDb,
  input: PauseWorkforceInput,
): Promise<WorkforceRuntimeRecord> {
  const runtime = await tdb.transaction(async (tx) => {
    await ensureWorkforceRuntime(tx, input.workforceId);
    const rows = (await tx
      .update(schema.workforceRuntime, {
        paused: true,
        pausedAt: new Date(),
        pausedBy: input.actor,
      })
      .where(eq(schema.workforceRuntime.workforceId, input.workforceId))
      .returning()) as WorkforceRuntimeRecord[];
    await appendWorkforceEvents(tx, input.workforceId, [
      {
        type: 'workforce.control.paused',
        payload: {
          workforceId: input.workforceId,
          actor: input.actor,
          drain: input.drain === true,
        },
      },
    ]);
    return rows[0] as WorkforceRuntimeRecord;
  });
  if (input.drain === true) {
    const timeoutMs = input.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const working = await workingCount(tdb, input.workforceId);
      if (working === 0) break;
      if (Date.now() >= deadline) {
        throw new WorkforceDrainTimeoutError(input.workforceId, working, timeoutMs);
      }
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  }
  return runtime;
}

/** Reserving restarts. Nothing needs re-queueing, because nothing ever left `queued`. */
export async function resumeWorkforce(
  tdb: TenantDb,
  input: { readonly workforceId: string; readonly actor: string },
): Promise<WorkforceRuntimeRecord> {
  return tdb.transaction(async (tx) => {
    await ensureWorkforceRuntime(tx, input.workforceId);
    const rows = (await tx
      .update(schema.workforceRuntime, {
        paused: false,
        pausedAt: null,
        pausedBy: null,
      })
      .where(eq(schema.workforceRuntime.workforceId, input.workforceId))
      .returning()) as WorkforceRuntimeRecord[];
    await appendWorkforceEvents(tx, input.workforceId, [
      {
        type: 'workforce.control.resumed',
        payload: { workforceId: input.workforceId, actor: input.actor },
      },
    ]);
    return rows[0] as WorkforceRuntimeRecord;
  });
}

export interface HaltWorkforceOutcome {
  readonly cancelled: string[];
  readonly signalled: string[];
}

/**
 * Pause with drain, then cancel every non-terminal task ROOT-FIRST (cascades cannot race their
 * parents). Drained first, never killed mid-turn: with the drain complete nothing is `working`, so
 * the cascade transitions parked rows only. The halt event carries the affected count.
 */
export async function haltWorkforce(
  tdb: TenantDb,
  input: {
    readonly workforceId: string;
    readonly actor: string;
    readonly reason: string;
    readonly drainTimeoutMs?: number;
  },
): Promise<HaltWorkforceOutcome> {
  await pauseWorkforce(tdb, {
    workforceId: input.workforceId,
    actor: input.actor,
    drain: true,
    drainTimeoutMs: input.drainTimeoutMs,
  });
  const roots = (await tdb
    .select(schema.workforceTasks)
    .where(
      and(
        eq(schema.workforceTasks.workforceId, input.workforceId),
        isNull(schema.workforceTasks.parentTaskId),
      ),
    )) as TaskRecord[];
  const outcome: { cancelled: string[]; signalled: string[] } = { cancelled: [], signalled: [] };
  for (const root of roots) {
    if (!isTaskStatus(root.status) || isTerminalStatus(root.status)) continue;
    const cascade = await cancelTaskCascade(tdb, {
      taskId: root.taskId,
      actor: input.actor,
      reason: input.reason,
    });
    outcome.cancelled.push(...cascade.cancelled);
    outcome.signalled.push(...cascade.signalled);
  }
  await tdb.transaction(async (tx) => {
    await tx
      .update(schema.workforceRuntime, { haltReason: input.reason, haltedAt: new Date() })
      .where(eq(schema.workforceRuntime.workforceId, input.workforceId));
    await appendWorkforceEvents(tx, input.workforceId, [
      {
        type: 'workforce.control.halted',
        payload: {
          workforceId: input.workforceId,
          actor: input.actor,
          reason: input.reason,
          affectedTaskCount: outcome.cancelled.length + outcome.signalled.length,
        },
      },
    ]);
  });
  return outcome;
}
