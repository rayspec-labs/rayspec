/**
 * THE TASK LOCK ORDER's acquisition helpers, the delegation-settlement vocabulary, and the fan-in
 * that runs when a task ends — shared by the turn executor (apply-intents.ts, whose module header
 * states the canonical order: ancestors root-first, then the task, then its descendants, ties by
 * task id; workforce_runtime -> workforce_tasks -> workforce_budget_ledger across row types) and
 * by the review verdict path (reviews.ts), which must take the SAME task locks before its
 * review-row compare-and-swap. One home, no import cycle: both consumers depend on this module and
 * never on each other's write paths.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { TaskNotFoundError, TaskRowCorruptError } from './errors.js';
import { appendTaskEvents } from './events.js';
import { isJoinSatisfied, joinPolicySchema } from './join.js';
import { deliverSignal } from './signals.js';
import { isTaskStatus, isTerminalStatus } from './status.js';

/**
 * The CLOSED delegation lifecycle — ONE vocabulary for `workforce_delegations.status`, which the
 * column carried in two halves with nothing narrowing it. A hand-off is OPENED (`accepted`) or
 * refused at planning (`rejected`); an accepted one SETTLES to the child's terminal status when the
 * child ends. Additive and CHECK-free, like every other closed vocabulary here: the column stays
 * `text`, the narrowing lives in code, and a new member is a code change with no migration.
 */
export const DELEGATION_STATUSES = [
  'accepted',
  'rejected',
  'completed',
  'failed',
  'cancelled',
] as const;

export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

export const delegationStatusSchema = z.enum(DELEGATION_STATUSES);

/**
 * Narrow a terminating task's status to the settlement half of the vocabulary. The three terminal
 * statuses are members by construction; anything else reaching a settlement is a corrupted row, not
 * a value to write through.
 */
function settlementStatus(task: TaskRecord): DelegationStatus {
  const parsed = delegationStatusSchema.safeParse(task.status);
  if (!parsed.success) {
    throw new TaskRowCorruptError(
      task.taskId,
      `status '${task.status}' cannot settle a delegation`,
    );
  }
  return parsed.data;
}

/**
 * Take the upward half of THE TASK LOCK ORDER (see apply-intents.ts's module header) for an
 * operation on `task`: its ancestors root-first, then the task itself, all `FOR UPDATE`, all
 * BEFORE the operation's first transition. `ancestryPath` is materialized root-first and
 * immutable, so walking it IS the canonical order. Returns the task re-read UNDER its own lock —
 * the authoritative version a compare-and-swap can then present without racing anyone.
 *
 * Every caller here touches a SECOND row type or task row (the parent it fans into, the root it
 * escalates to, the descendants it cascades over, the review row it decides), which is what makes
 * the order load-bearing.
 */
export async function lockRootFirst(tx: TenantDb, task: TaskRecord): Promise<TaskRecord> {
  const ancestry = Array.isArray(task.ancestryPath) ? (task.ancestryPath as string[]) : [];
  for (const ancestorId of ancestry) {
    await tx
      .select(schema.workforceTasks, { taskId: schema.workforceTasks.taskId })
      .where(eq(schema.workforceTasks.taskId, ancestorId))
      .for('update');
  }
  const rows = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.taskId, task.taskId))
    .for('update')) as TaskRecord[];
  const locked = rows[0];
  if (!locked) throw new TaskNotFoundError(task.taskId);
  if (!isTaskStatus(locked.status)) {
    throw new TaskRowCorruptError(task.taskId, `status '${locked.status}'`);
  }
  return locked;
}

/**
 * Take the downward half of THE TASK LOCK ORDER: every non-terminal descendant of `origin`,
 * shallowest first, ties by task id, all `FOR UPDATE`. Returns the LOCKED rows — the act-on
 * decisions belong to them, never to the pre-lock snapshot.
 *
 * The whole subtree read is a DELIBERATE full scan — a cascade that saw only a page of its
 * descendants would leave the rest running under a cancelled ancestor, so this one is bounded by
 * the subtree's own size, not by a LIMIT.
 *
 * Split out from `cancelDescendants` because the LOCKS and the WRITES have different deadlines: a
 * turn that will cascade must take these task locks BEFORE it touches the ledger (tasks -> ledger
 * is the rank), which is strictly earlier than the point the cascade itself runs. Re-locking rows
 * this transaction already holds is free, so a caller that pre-locked simply passes through here a
 * second time.
 */
export async function lockDescendants(tx: TenantDb, origin: TaskRecord): Promise<TaskRecord[]> {
  const subtree = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.rootTaskId, origin.rootTaskId))) as TaskRecord[];
  const descendants = subtree
    .filter(
      (t) =>
        t.taskId !== origin.taskId &&
        Array.isArray(t.ancestryPath) &&
        (t.ancestryPath as string[]).includes(origin.taskId) &&
        // Terminal is absorbing, so a terminal snapshot is a terminal row — no lock needed.
        !(isTaskStatus(t.status) && isTerminalStatus(t.status)),
    )
    .sort(
      (a, b) =>
        (Array.isArray(a.ancestryPath) ? a.ancestryPath.length : 0) -
          (Array.isArray(b.ancestryPath) ? b.ancestryPath.length : 0) ||
        a.taskId.localeCompare(b.taskId),
    );
  const locked: TaskRecord[] = [];
  for (const desc of descendants) {
    const rows = (await tx
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.taskId, desc.taskId))
      .for('update')) as TaskRecord[];
    const row = rows[0];
    if (row) locked.push(row);
  }
  return locked;
}

/**
 * A task just reached a terminal status: settle its opening delegation record and, when its parent
 * is parked, fan back in — through the JOIN when the parent awaits its children, through the
 * ESCALATION REPLY when the parent parked `blocked(escalated)` and this child carried the
 * escalation, or through the ABANDONED REVIEW when the parent parked `waiting_for_review` and this
 * child was the reviewer that never returned a verdict. Exported for the cancel cascade, which
 * terminates tasks outside a turn. The parent lock this takes is already held by every caller (they
 * went through `lockRootFirst` before their transition) — re-taking it is free and keeps the fan-in
 * correct on its own terms.
 *
 * Every branch is keyed on the parent's PARK BINDING (`joinPolicy`), never on the park's status
 * alone: a task under a parked parent is not automatically the task that park is waiting for.
 */
export async function afterTaskTerminal(tx: TenantDb, task: TaskRecord): Promise<void> {
  await tx
    .update(schema.workforceDelegations, {
      status: settlementStatus(task),
      completedAt: new Date(),
    })
    .where(eq(schema.workforceDelegations.childTaskId, task.taskId));
  if (task.parentTaskId === null) return;

  // LOCK the parent row BEFORE reading siblings (see apply-intents.ts's module header: two racing
  // last children must serialize here so the second one's sibling read sees the first one's
  // committed terminal).
  const parentRows = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.taskId, task.parentTaskId))
    .for('update')) as TaskRecord[];
  const parent = parentRows[0];
  if (!parent) return; // the parent left with its tenant — nothing to fan into
  if (parent.status === 'blocked' && parent.statusReason === 'escalated') {
    // The ESCALATION REPLY: the park is BOUND to the one child the escalate turn recorded on the
    // caller's row, and only THAT child's terminal is the reply — a detached buffered-create
    // child finishing while the caller waits delivers nothing, and the park holds until the
    // superior answers. Fail-closed: no binding wakes nobody.
    const binding = joinPolicySchema.safeParse(parent.joinPolicy);
    if (
      !binding.success ||
      binding.data.policy !== 'escalation' ||
      binding.data.escalationTaskId !== task.taskId
    ) {
      return;
    }
    // The `escalated` signal answers exactly the `blocked(escalated)` park (WAKES, signals.ts);
    // the payload stays BOUNDED (the parent's next context already carries the child's full
    // result via `childResults`). Key per escalation child: racing re-executions dedupe on the
    // receipt first and this UNIQUE second, while a later escalation (new turn, new child id)
    // re-arms cleanly.
    const summary =
      typeof (task.result as { summary?: unknown } | null)?.summary === 'string'
        ? ((task.result as { summary: string }).summary.slice(0, 500) as string)
        : null;
    await deliverSignal(tx, {
      taskId: parent.taskId,
      kind: 'escalated',
      signalKey: `escalated:${task.taskId}`,
      payload: { escalationTaskId: task.taskId, status: task.status, summary },
      actor: 'system',
    });
    return;
  }
  if (parent.status === 'waiting_for_review') {
    await releaseAbandonedReview(tx, parent, task);
    return;
  }
  if (parent.status !== 'blocked' || parent.statusReason !== 'awaiting_children') return;
  const policyParsed = joinPolicySchema.safeParse(parent.joinPolicy);
  if (!policyParsed.success) return; // no declared join — the parent is blocked on something else
  const children = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.parentTaskId, parent.taskId))) as TaskRecord[];
  if (!isJoinSatisfied(policyParsed.data, children)) return;
  // The signal key is PER FAN-OUT ROUND: `turnsUsed` is frozen while the parent is parked (no
  // turn runs), identical for every racing child in a round, and strictly larger next round — so
  // racing last children of ONE round dedupe to one wake, while a later round's join can never
  // collide with an earlier round's consumed key (a constant per-parent key would strand the
  // parent forever on its second fan-out).
  await deliverSignal(tx, {
    taskId: parent.taskId,
    kind: 'child_completed',
    signalKey: `join:${parent.taskId}:${parent.turnsUsed}`,
    payload: { childCount: children.length },
    actor: 'system',
  });
}

/**
 * THE ABANDONED REVIEW — the backstop that keeps `waiting_for_review` from being a park with no
 * exit.
 *
 * A review park is answered by its VERDICT, which is why `waiting_for_review` appears in no wake
 * set: no signal kind matches it and no timeout sweep covers it. That is sound only while the
 * dispatched reviewer can still deliver one. It cannot once its task is terminal — and a review
 * task reaches a terminal status by routes no tool error can prevent: an operator cancel, a cancel
 * cascade from an ancestor, or the second consecutive tool error that fails it outright.
 *
 * When the terminating task IS the bound review task and the review is still undecided, the
 * reviewed task is released to `waiting_for_user` — the same place a spent round budget leaves it,
 * and for the same reason: no mechanism can decide this any more, so a human does. The stored
 * result stays on the row, so the human sees the work the reviewer never judged. The review row is
 * left pending and undecided on purpose: fabricating a verdict nobody gave would be worse than
 * recording that none arrived, and the journal entry names the task that was supposed to give it.
 */
async function releaseAbandonedReview(
  tx: TenantDb,
  parent: TaskRecord,
  task: TaskRecord,
): Promise<void> {
  const binding = joinPolicySchema.safeParse(parent.joinPolicy);
  if (
    !binding.success ||
    binding.data.policy !== 'review' ||
    binding.data.reviewTaskId !== task.taskId ||
    binding.data.reviewId === undefined
  ) {
    // Not the bound reviewer — a sibling ending under a reviewed parent answers nothing.
    return;
  }
  const reviewRows = (await tx
    .select(schema.workforceReviews)
    .where(
      eq(schema.workforceReviews.id, binding.data.reviewId),
    )) as (typeof schema.workforceReviews.$inferSelect)[];
  const review = reviewRows[0];
  // A decided review is the normal path: the verdict already moved the reviewed task, and this
  // terminal is just the reviewer's own turn ending afterwards.
  if (!review || review.verdict !== null) return;
  await appendTaskEvents(tx, parent.taskId, [
    {
      type: 'workforce.review.abandoned',
      payload: {
        taskId: parent.taskId,
        reviewId: review.id,
        reviewTaskId: task.taskId,
        reviewer: review.reviewer,
        round: review.round,
        reviewTaskStatus: task.status,
        outcome: 'waiting_for_user',
      },
    },
  ]);
  await applyTransition(tx, {
    taskId: parent.taskId,
    expectedVersion: parent.version,
    to: 'waiting_for_user',
    actor: 'system',
  });
}
