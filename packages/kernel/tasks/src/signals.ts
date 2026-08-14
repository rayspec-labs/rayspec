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
 *
 * This module owns that park vocabulary for EVERY door, not just for signals: the budget
 * escalation's door reads it through `escalationTargetsPark`. A rule enforced on one door and not
 * the next is not a rule — the same status-only coarseness that let an override dissolve a join
 * let an escalation dissolve it from the other side.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { TaskNotFoundError, TaskRowCorruptError, TaskVersionConflictError } from './errors.js';
import {
  isTaskStatus,
  REASON_RULES,
  STATUS_REASONS,
  type StatusReason,
  type TaskStatus,
} from './status.js';

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

/**
 * The signal kinds an OPERATOR may post from outside the engine.
 *
 * The rest of `SIGNAL_KINDS` are MECHANISM kinds: `child_completed` is written by the fan-in,
 * `escalated` by the escalation reply, `review_verdict`/`approval_decided` by their own decision
 * paths, `cancel` by the cascade. Each is the exit of a park that answers to it, and each is
 * written by the code that establishes the fact it reports. Accepting them from a request lets a
 * caller assert that fact by hand — posting `child_completed` releases a fan-out join with its
 * children still running, and `escalated` releases an escalation park whose child never answered,
 * which is precisely what the structural-park rule spends its effort preventing on every internal
 * door. A gate enforced on the engine's doors and not on the HTTP one is not a gate.
 *
 * The three here are the ones an operator genuinely holds the lever for: they raised the ceiling,
 * they decided to proceed, they answered the question.
 */
export const OPERATOR_SIGNAL_KINDS = [
  'manual_unblock',
  'budget_raised',
  'user_reply',
] as const satisfies readonly SignalKind[];

export type OperatorSignalKind = (typeof OPERATOR_SIGNAL_KINDS)[number];

export const operatorSignalKindSchema = z.enum(OPERATOR_SIGNAL_KINDS);

export const signalKindSchema = z.enum(SIGNAL_KINDS);

/** One park a wake kind answers: a status, and the reasons within it (`null` = the reasonless park). */
interface Park {
  readonly status: TaskStatus;
  readonly reasons: readonly (StatusReason | null)[];
}

/**
 * The parks no override may dissolve, because each waits on a CHILD TASK's terminal — a fact an
 * operator's override does not change, on a row the override does not touch:
 *
 *   - `awaiting_children` is the fan-out join. Releasing it runs the parent with no child results
 *     and orphans the children — their fan-in finds the parent no longer parked and bails, so the
 *     join is simply gone.
 *   - `escalated` is the same shape one hop up: the caller waits on the ONE escalation child bound
 *     to it on its own row (`joinPolicy`), and only that child's terminal is the reply. Releasing
 *     it erases the exit while the child is still live — the child's fan-in then finds no matching
 *     park, `afterTaskTerminal`'s binding check drops the reply, and the superior's answer vanishes
 *     with nothing journalled. An override that lands mid-turn dissolved the park INSIDE the very
 *     transaction that created it.
 *
 * The lever on either is the same: CANCEL THE CHILD. Its terminal status satisfies the park through
 * the park's own path — the join's fan-in, or the escalation reply — so the exit is taken rather
 * than erased.
 */
const STRUCTURAL_PARKS: readonly StatusReason[] = ['awaiting_children', 'escalated'];

/**
 * The parks an operator's `manual_unblock` may NOT release: the structural ones above, plus
 * `deadline_exceeded` — an ABSOLUTE fact on the row, not a condition an operator can answer from
 * here. A wake re-queues the task and the very next reserve pass re-parks it against the same
 * instant — a livelock that journals a fresh park every tick. Every OTHER blocked reason has a real
 * lever behind it (raise the ceiling, decide the approval, answer the clarification), so the
 * unblock that follows can actually succeed; this one has none, and an unblock that "works" and
 * immediately undoes itself is worse than one that honestly declines. The rescue for a
 * deadline-expired task is `cancel`.
 */
const NOT_OPERATOR_UNBLOCKABLE: readonly StatusReason[] = [
  ...STRUCTURAL_PARKS,
  'deadline_exceeded',
];

/**
 * Every reason a `blocked` task may carry except those two — DERIVED from `REASON_RULES`, so a
 * newly declared blocked reason is operator-unblockable by construction and the exclusions above
 * stay the single explicit fact.
 */
const OPERATOR_UNBLOCKABLE: readonly StatusReason[] = STATUS_REASONS.filter(
  (reason) =>
    !NOT_OPERATOR_UNBLOCKABLE.includes(reason) && REASON_RULES[reason].includes('blocked'),
);

/**
 * Parks whose exit is a MECHANISM rather than a human: the fan-in join, the escalation reply, the
 * dependency wake, the verdict route, the approval decision, the clarification reply. Each is
 * released by a specific path that matches on the park itself, so a transition OUT of the park
 * erases the exit — which is why no door may move a task sitting in one "for its own good". The
 * `STRUCTURAL_PARKS` are the strongest members (their mechanism cannot even be re-armed: the child
 * carrying the exit is already live and will never be dispatched again); the rest are listed here
 * so the rule binds on every door, not just on `WAKES`.
 *
 * `clarification_pending` belongs here for the reason `approval_pending` does: the reply is keyed
 * to the question that was asked, so a task moved out of the park leaves that reply with no park
 * to answer — it is refused on delivery and stays pending forever, while the question is never
 * asked again.
 */
const MECHANISM_PARK_REASONS: readonly StatusReason[] = [
  ...STRUCTURAL_PARKS,
  'awaiting_dependency',
  'review_pending',
  'approval_pending',
  'clarification_pending',
];

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

/**
 * The parks a BUDGET ESCALATION may transition (`applyBudgetExhausted`, apply-intents.ts). An
 * escalation moves a ROOT to `waiting_for_user` so a human can raise the ceiling — legitimate only
 * where the root is already waiting on a human, or on nothing at all. A `MECHANISM_PARK_REASONS`
 * park must survive it: the transition erases the exit and the mechanism has nowhere to land (the
 * fan-in bails and never writes its join signal; the dependency wake's scan predicate no longer
 * matches; the verdict route refuses any task outside `waiting_for_review`). `waiting_for_review`
 * is therefore absent as a status, exactly as it is absent from `WAKES`.
 *
 * The rule is `WAKES`' rule one door over: a park is released by what ANSWERS it, never by what
 * merely arrives while it is open.
 */
const BUDGET_ESCALATION_PARKS: readonly Park[] = Object.freeze([
  {
    status: 'blocked',
    reasons: [
      // The reasonless block, plus every blocked reason whose exit is already a human.
      null,
      ...STATUS_REASONS.filter(
        (reason) =>
          REASON_RULES[reason].includes('blocked') && !MECHANISM_PARK_REASONS.includes(reason),
      ),
    ],
  } satisfies Park,
]);

function isSignalKind(value: string): value is SignalKind {
  return (SIGNAL_KINDS as readonly string[]).includes(value);
}

/** Is the task's actual park — the (status, reason) pair — a member of this park set? */
function matchesPark(parks: readonly Park[], status: string, statusReason: string | null): boolean {
  return parks.some(
    (park) => park.status === status && park.reasons.some((reason) => reason === statusReason),
  );
}

/** Does this kind answer the park the task is actually sitting in? */
function answersPark(kind: SignalKind, status: string, statusReason: string | null): boolean {
  return matchesPark(WAKES[kind], status, statusReason);
}

/**
 * May a budget escalation move a root out of the park it currently sits in? False for every
 * mechanism-exit park, whose escalation the caller DEFERS instead (see `applyBudgetExhausted`).
 */
export function escalationTargetsPark(status: string, statusReason: string | null): boolean {
  return matchesPark(BUDGET_ESCALATION_PARKS, status, statusReason);
}

/**
 * Is this park one whose exit is a CHILD TASK's terminal (`STRUCTURAL_PARKS`)? Read by the deferral
 * journal, which must say whether a deferred escalation resurfaces on its own — and for these two
 * it does not when the denied task is the very child the park waits on.
 */
export function isStructuralPark(statusReason: string | null): boolean {
  return STRUCTURAL_PARKS.some((reason) => reason === statusReason);
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
 * READ the still-pending cancels without consuming or locking anything. The turn's final
 * transaction asks this BEFORE it takes its task locks, because a pending cancel is what decides
 * how many rows the turn will touch — and therefore which locks it must take. Consuming here
 * instead would put a signal-row lock ahead of the task locks, inverting the order every cancel
 * cascade takes (task rows first, then the cancel signal it delivers) and deadlocking against it.
 *
 * A cancel that lands between this read and the lock is simply one that arrived too late for this
 * turn: it stays pending and the next turn boundary absorbs it, exactly as one arriving a moment
 * later would.
 */
export async function peekPendingCancels(tx: TenantDb, taskId: string): Promise<SignalRecord[]> {
  return (await tx
    .select(schema.workforceTaskSignals)
    .where(
      and(
        eq(schema.workforceTaskSignals.taskId, taskId),
        eq(schema.workforceTaskSignals.kind, 'cancel'),
        isNull(schema.workforceTaskSignals.consumedAt),
      ),
    )) as SignalRecord[];
}

/**
 * Consume the still-pending CANCEL signals for a task (marks consumed_at, returns them) — called
 * by the turn's final transaction, UNDER its task locks, so a pending `cancel` overrides the turn's
 * own outcome without inverting the lock order (see `peekPendingCancels`). ONLY
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
 * does not speak to. The `STRUCTURAL_PARKS` are unreachable here for exactly that reason: a fan-out
 * or an escalation that ends a turn must not be dissolved by an operator override the same
 * transaction absorbs — the child carrying the park's exit is already live at that point.
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
