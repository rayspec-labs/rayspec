/**
 * Wake signals — resume is a ROW, not a process.
 *
 * A signal is one row in `workforce_task_signals`, idempotent on `(tenant, task, signal_key)`: a
 * re-sent delivery collides on the UNIQUE key and no-ops instead of waking a task twice. The kind
 * set is CLOSED; free-text signal kinds are refused at the edge. Delivery wakes a parked task by
 * re-queueing it through `applyTransition`, and the wake carries the signal kind as the queue
 * reason so the journal says WHY the task woke. A signal delivered to a task that is not in a
 * wakeable state stays pending and is consumed at the next turn boundary (`cancel` is exactly that:
 * recorded now, absorbed at the turn's end — never killing a turn mid-flight).
 *
 * WHAT A SIGNAL MAY RELEASE is matched on the PARK — the (status, reason) pair — not on the status
 * alone, on BOTH paths (delivery and turn-boundary absorption). A status-only match is what lets a
 * signal dissolve a park it says nothing about: a raised ceiling releasing a task waiting on a
 * dependency, an operator override dissolving a fan-out join. See `WAKES`.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { TaskNotFoundError, TaskRowCorruptError, TaskVersionConflictError } from './errors.js';
import { isTaskStatus, REASON_RULES, STATUS_REASONS, type StatusReason, type TaskStatus } from './status.js';

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

/** One park a wake kind answers: a status, and the reasons within it (`null` = the reasonless park). */
interface Park {
  readonly status: TaskStatus;
  readonly reasons: readonly (StatusReason | null)[];
}

/**
 * The ONE park no override may dissolve. A fan-out join is STRUCTURAL: the parent waits on a fact
 * about its children, which an operator's override does not change. Releasing it runs the parent
 * with no child results and orphans the children — their fan-in finds the parent no longer parked
 * and bails, so the join is simply gone. The lever on a wedged join is cancelling the blocking
 * child: its terminal status satisfies the join through the join's own path.
 */
const STRUCTURAL_PARK: StatusReason = 'awaiting_children';

/**
 * Every reason a `blocked` task may carry except the structural one — DERIVED from `REASON_RULES`,
 * so a newly declared blocked reason is operator-unblockable by construction and the exclusion
 * above stays the single explicit fact.
 */
const OPERATOR_UNBLOCKABLE: readonly StatusReason[] = STATUS_REASONS.filter(
  (reason) => reason !== STRUCTURAL_PARK && REASON_RULES[reason].includes('blocked'),
);

/**
 * The PARK each kind answers. Reason-matched, so a signal releases only what its meaning speaks to:
 * a raised ceiling answers `blocked(budget_exhausted)` and nothing else; a decision answers the
 * approval park it was made against, not a task parked on a dependency or on its children.
 *
 * `waiting_for_review` appears nowhere, and neither does `review_verdict`'s park: a review's exit is
 * its verdict route, which decides once under its own compare-and-swap — a posted signal must not
 * be a second door into it. `cancel` wakes nothing either: it is absorbed at a turn boundary or
 * applied by the cancel cascade.
 */
const WAKES: Readonly<Record<SignalKind, readonly Park[]>> = Object.freeze({
  approval_decided: [
    { status: 'waiting_for_user', reasons: ['approval_pending'] },
    { status: 'blocked', reasons: ['approval_pending'] },
  ],
  review_verdict: [],
  child_completed: [{ status: 'blocked', reasons: ['awaiting_children'] }],
  dependency_completed: [{ status: 'blocked', reasons: ['awaiting_dependency'] }],
  escalated: [{ status: 'blocked', reasons: ['escalated'] }],
  user_reply: [
    // The reasonless `waiting_for_user` park — "a human decides" (review rounds spent, an
    // escalated budget). An approval park has its own decision path and is not this.
    { status: 'waiting_for_user', reasons: [null] },
    { status: 'blocked', reasons: ['clarification_pending'] },
  ],
  budget_raised: [{ status: 'blocked', reasons: ['budget_exhausted'] }],
  manual_unblock: [{ status: 'blocked', reasons: OPERATOR_UNBLOCKABLE }],
  cancel: [],
});

function isSignalKind(value: string): value is SignalKind {
  return (SIGNAL_KINDS as readonly string[]).includes(value);
}

/** Does this kind answer the park the task is actually sitting in? */
function answersPark(kind: SignalKind, status: string, statusReason: string | null): boolean {
  return WAKES[kind].some(
    (park) => park.status === status && park.reasons.some((reason) => reason === statusReason),
  );
}

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
      if (!answersPark(input.kind, task.status, task.statusReason)) {
        // This kind does not answer the park the task sits in (or the task is not parked at all) —
        // the signal stays pending for the next turn boundary.
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
 * Consume the still-pending CANCEL signals for a task (marks consumed_at, returns them) — called
 * by the turn's final transaction so a pending `cancel` overrides the turn's own outcome. ONLY
 * cancels are consumed here: every other pending signal is left pending, because a wake-shaped
 * signal that arrived mid-turn must survive the turn boundary (a `budget_raised` delivered while
 * the task was `working` has to be able to wake the `blocked(budget_exhausted)` the turn is about
 * to park into — consuming it here would strand the task with no wake path). Non-cancel signals
 * reach the handler as CONTEXT regardless of consumption state.
 */
export async function consumePendingCancels(tx: TenantDb, taskId: string): Promise<SignalRecord[]> {
  const rows = (await tx
    .update(schema.workforceTaskSignals, { consumedAt: new Date() })
    .where(
      and(
        eq(schema.workforceTaskSignals.taskId, taskId),
        eq(schema.workforceTaskSignals.kind, 'cancel'),
        isNull(schema.workforceTaskSignals.consumedAt),
      ),
    )
    .returning()) as SignalRecord[];
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * The signal kinds a TURN BOUNDARY may absorb: a wake that landed while the task was `working`
 * (never wakeable) and answers the park the turn just applied. Decision-shaped signals
 * (`approval_decided`, `user_reply`, …) are deliberately absent — a stale decision pending from an
 * earlier request must never release a NEW park; those wake only through their own delivery path,
 * keyed per request.
 */
const ABSORBED_AT_TURN_BOUNDARY: readonly SignalKind[] = ['budget_raised', 'manual_unblock'];

/**
 * The NARROW post-turn absorption rule: after a turn's final transition, a still-pending signal may
 * wake the task it just parked — but only an absorbable kind, and only where it ANSWERS the park
 * (the same `WAKES` match the delivery path uses), so a stale signal can never release a park it
 * does not speak to. `awaiting_children` is unreachable here for exactly that reason: a fan-out
 * that ends a turn must not be dissolved by an operator override the same transaction absorbs.
 * Returns the absorbed signal when a wake applied, null otherwise.
 */
export async function absorbPendingWakes(
  tx: TenantDb,
  task: { taskId: string; status: string; statusReason: string | null; version: number },
): Promise<SignalRecord | null> {
  const pending = (await tx
    .select(schema.workforceTaskSignals)
    .where(
      and(
        eq(schema.workforceTaskSignals.taskId, task.taskId),
        isNull(schema.workforceTaskSignals.consumedAt),
      ),
    )) as SignalRecord[];
  const applicable = pending
    .filter(
      (s) =>
        isSignalKind(s.kind) &&
        ABSORBED_AT_TURN_BOUNDARY.includes(s.kind) &&
        answersPark(s.kind, task.status, task.statusReason),
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const wake = applicable[0];
  if (!wake) return null;
  await applyTransition(tx, {
    taskId: task.taskId,
    expectedVersion: task.version,
    to: 'queued',
    actor: 'system',
    queueReason: wake.kind,
  });
  await tx
    .update(schema.workforceTaskSignals, { consumedAt: new Date() })
    .where(eq(schema.workforceTaskSignals.id, wake.id));
  return wake;
}
