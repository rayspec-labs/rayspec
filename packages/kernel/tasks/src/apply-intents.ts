/**
 * The turn-intent EXECUTOR — one transaction that turns a plan (intent-applier.ts) into rows.
 *
 * Everything a turn produced is applied ATOMICALLY with the task's state transition: result
 * columns, child rows + delegation records, approval/review rows, messages, the cost settlement,
 * the journal events, and the transition itself — the keystone posture that a turn's effects and
 * its state move are one fact. The transaction is IDEMPOTENT under whole-turn re-execution: the
 * first thing it does is look for the turn's RECEIPT (the partial-unique transition row keyed
 * (task, turn number)); a recovered turn whose final transaction already committed finds it and
 * no-ops, so a crash-and-replay changes no terminal outcome and duplicates no side effect.
 *
 * Fan-in lives here too: when a task reaches a terminal status and has a parent parked on
 * `blocked(awaiting_children)`, the executor LOCKS THE PARENT ROW FIRST and only then reads the
 * siblings — under READ COMMITTED the post-lock read sees the racing sibling's committed terminal
 * row, so two last children completing concurrently cannot BOTH conclude "join not yet satisfied"
 * and strand the parent. A satisfied join writes exactly ONE `child_completed` signal (the
 * signal-key UNIQUE dedupes) and re-queues the parent; the parent's next dispatch receives the
 * full results keyed by child task id, never by completion order.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE TASK LOCK ORDER — one order, every path that touches more than one task row.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Task rows are locked ROOT-FIRST: a task's ancestors before the task, the task before its
 * descendants, ties inside a level broken by task id. An operation takes the locks on its way UP
 * (`lockRootFirst`) BEFORE its first transition, and `cancelDescendants` takes the ones on its way
 * DOWN in the same order. Two operations whose row sets overlap therefore acquire the intersection
 * in the same sequence and QUEUE instead of deadlocking — an operator cancel holding a parent waits
 * for the completing child's turn to finish, rather than the two waiting on each other until
 * Postgres kills one (which turned a cancel into a 500 that did nothing, and a turn into a leaked
 * reservation). A single-row transition needs no pre-lock: it holds one row and wants nothing else,
 * so it can never be half of a cycle.
 *
 * Rank against the other row types this engine locks: workforce_runtime -> workforce_tasks ->
 * workforce_budget_ledger (established by the dispatcher's claim transaction).
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { probeSpend, settleTurn, type WorkforceBudgets } from './budget.js';
import { insertChildTask } from './create-task.js';
import { TaskNotFoundError, TaskRowCorruptError, TaskVersionConflictError } from './errors.js';
import { appendTaskEvents } from './events.js';
import { deterministicChildTaskId } from './ids.js';
import {
  invalidIntentPlan,
  planTurnOutcome,
  type TurnPlan,
  turnIntentSchema,
} from './intent-applier.js';
import { isJoinSatisfied, joinPolicySchema } from './join.js';
import { absorbPendingWakes, consumePendingCancels, deliverSignal } from './signals.js';
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

/** The turn's final application refuses a task in a state it cannot explain. */
export class TurnStateError extends Error {
  readonly taskId: string;
  constructor(taskId: string, detail: string) {
    super(
      `turn application for task '${taskId}' found ${detail} and no receipt for this turn — ` +
        'refusing to apply intents over foreign state. Fail-closed.',
    );
    this.name = 'TurnStateError';
    this.taskId = taskId;
  }
}

export interface ApplyTurnInput {
  readonly taskId: string;
  /** The dispatched turn's workflow id (journaled on the transition row + events). */
  readonly turnId: string;
  /** The 1-based turn number — the receipt key under the partial UNIQUE. */
  readonly turnNumber: number;
  /** The handler's raw turn-ending intent; validated HERE, never assumed. */
  readonly intent: unknown;
  /** Task-scoped messages the turn asked to append (context, never instructions). */
  readonly messages?: readonly { readonly recipient: string; readonly body: string }[];
  readonly budgets: WorkforceBudgets;
  /** The turn's actual cost; settled against the dispatch reservation. */
  readonly actualUsd?: number;
}

export interface ApplyTurnOutcome {
  /** True when the receipt already existed — a recovered re-execution, nothing changed. */
  readonly alreadyApplied: boolean;
  readonly plan: TurnPlan | null;
  readonly task: TaskRecord | null;
}

async function readTask(tx: TenantDb, taskId: string): Promise<TaskRecord> {
  const rows = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.taskId, taskId))) as TaskRecord[];
  const task = rows[0];
  if (!task) throw new TaskNotFoundError(taskId);
  if (!isTaskStatus(task.status)) throw new TaskRowCorruptError(taskId, `status '${task.status}'`);
  return task;
}

/**
 * Take the upward half of THE TASK LOCK ORDER (see the module header) for an operation on `task`:
 * its ancestors root-first, then the task itself, all `FOR UPDATE`, all BEFORE the operation's
 * first transition. `ancestryPath` is materialized root-first and immutable, so walking it IS the
 * canonical order. Returns the task re-read UNDER its own lock — the authoritative version a
 * compare-and-swap can then present without racing anyone.
 *
 * Every caller here touches a SECOND task row (the parent it fans into, the root it escalates to,
 * the descendants it cascades over), which is what makes the order load-bearing.
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
 * A task just reached a terminal status: settle its opening delegation record and, when its
 * parent is parked on the join, check fan-in. Exported for the cancel cascade, which terminates
 * tasks outside a turn. The parent lock this takes is already held by every caller (they went
 * through `lockRootFirst` before their transition) — re-taking it is free and keeps the fan-in
 * correct on its own terms.
 */
export async function afterTaskTerminal(tx: TenantDb, task: TaskRecord): Promise<void> {
  await tx
    .update(schema.workforceDelegations, {
      status: settlementStatus(task),
      completedAt: new Date(),
    })
    .where(eq(schema.workforceDelegations.childTaskId, task.taskId));
  if (task.parentTaskId === null) return;

  // LOCK the parent row BEFORE reading siblings (see the module header: two racing last children
  // must serialize here so the second one's sibling read sees the first one's committed terminal).
  const parentRows = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.taskId, task.parentTaskId))
    .for('update')) as TaskRecord[];
  const parent = parentRows[0];
  if (!parent) return; // the parent left with its tenant — nothing to fan into
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

/** Owners along the ancestry — the cycle-rejection input, read from rows, never from promises. */
async function ancestorOwners(tx: TenantDb, task: TaskRecord): Promise<string[]> {
  const ids = Array.isArray(task.ancestryPath) ? (task.ancestryPath as string[]) : [];
  if (ids.length === 0) return [];
  const rows = (await tx
    .select(schema.workforceTasks)
    .where(inArray(schema.workforceTasks.taskId, ids))) as TaskRecord[];
  return rows.map((r) => r.owner);
}

/**
 * Apply one finished turn. See the module header for the protocol; the receipt short-circuit is
 * the FIRST read so a recovered re-execution stays a read-only no-op.
 */
export async function applyTurnOutcome(
  tdb: TenantDb,
  input: ApplyTurnInput,
): Promise<ApplyTurnOutcome> {
  return tdb.transaction(async (tx) => {
    const receipt = await tx
      .select(schema.workforceTaskTransitions, { id: schema.workforceTaskTransitions.id })
      .where(
        and(
          eq(schema.workforceTaskTransitions.taskId, input.taskId),
          eq(schema.workforceTaskTransitions.turnNumber, input.turnNumber),
        ),
      );
    if (receipt.length > 0) return { alreadyApplied: true, plan: null, task: null };

    // Root-first BEFORE the first transition (see the module header): this turn may fan in to its
    // parent, escalate to its root, or cascade into its descendants, and the cancel cascade walks
    // the same rows from the top.
    const task = await lockRootFirst(tx, await readTask(tx, input.taskId));
    if (task.status !== 'working') {
      throw new TurnStateError(input.taskId, `status '${task.status}'`);
    }

    const cancels = await consumePendingCancels(tx, input.taskId);
    const pendingCancel = cancels.length > 0;

    // One prior tool_error re-queue means THIS offense is terminal (one retry, then failed).
    const priorReceipt = (await tx
      .select(schema.workforceTaskTransitions)
      .where(
        and(
          eq(schema.workforceTaskTransitions.taskId, input.taskId),
          eq(schema.workforceTaskTransitions.turnNumber, input.turnNumber - 1),
        ),
      )) as (typeof schema.workforceTaskTransitions.$inferSelect)[];
    const priorToolError =
      priorReceipt[0]?.toStatus === 'queued' && priorReceipt[0]?.statusReason === 'tool_error';

    const reviewRows = await tx
      .select(schema.workforceReviews, { id: schema.workforceReviews.id })
      .where(eq(schema.workforceReviews.taskId, input.taskId));
    const delegationRows = await tx
      .select(schema.workforceDelegations, { id: schema.workforceDelegations.id })
      .where(eq(schema.workforceDelegations.parentTaskId, input.taskId));

    const parsedIntent = turnIntentSchema.safeParse(input.intent);
    const plan: TurnPlan = parsedIntent.success
      ? planTurnOutcome({
          taskOwner: task.owner,
          ancestryDepth: Array.isArray(task.ancestryPath) ? task.ancestryPath.length : 0,
          ancestorOwners: await ancestorOwners(tx, task),
          existingDelegationCount: delegationRows.length,
          maxDelegationDepth: input.budgets.delegation?.maxDepth ?? null,
          maxDelegationsPerTask: input.budgets.delegation?.maxPerTask ?? null,
          maxReviewRounds: input.budgets.execution.maxReviewRounds ?? null,
          reviewRoundsUsed: reviewRows.length,
          priorToolError,
          pendingCancel,
          intent: parsedIntent.data,
        })
      : invalidIntentPlan(parsedIntent.error.message, priorToolError);

    // Settle FIRST: the task-row roll-up takes the task lock (canonical order), then the ledger.
    const actualUsd = input.actualUsd ?? 0;
    const settlement = {
      taskId: task.taskId,
      rootTaskId: task.rootTaskId,
      workforceId: task.workforceId,
      department: task.department,
      estimateUsd: input.budgets.execution.estimateUsdPerTurn,
      actualUsd,
    };
    await settleTurn(tx, input.budgets, settlement);
    await appendTaskEvents(tx, task.taskId, [
      {
        type: 'workforce.budget.settled',
        payload: {
          taskId: task.taskId,
          estimateUsd: settlement.estimateUsd,
          actualUsd,
          turnNumber: input.turnNumber,
        },
      },
    ]);

    const stamp = { actor: task.owner, turnId: input.turnId, turnNumber: input.turnNumber };
    let finalTask: TaskRecord | null = null;

    switch (plan.kind) {
      case 'cancelled': {
        finalTask = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'cancelled',
          reason: 'cancelled_by_user',
          ...stamp,
        });
        await cancelDescendants(tx, finalTask, 'system');
        await afterTaskTerminal(tx, finalTask);
        break;
      }
      case 'complete': {
        await tx
          .update(schema.workforceTasks, {
            result: plan.result,
            confidence: String(plan.result.confidence),
          })
          .where(eq(schema.workforceTasks.taskId, task.taskId));
        finalTask = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'completed',
          ...stamp,
        });
        await afterTaskTerminal(tx, finalTask);
        break;
      }
      case 'fan_out': {
        const probe = await probeSpend(
          tx,
          input.budgets,
          {
            taskId: task.taskId,
            rootTaskId: task.rootTaskId,
            workforceId: task.workforceId,
            department: task.department,
            estimateUsd: plan.children.length * input.budgets.execution.estimateUsdPerTurn,
          },
          plan.children.length,
        );
        if (!probe.allowed) {
          finalTask = await applyBudgetExhausted(tx, task, probe.denial, input.budgets, stamp);
          break;
        }
        await tx
          .update(schema.workforceTasks, { joinPolicy: plan.joinPolicy })
          .where(eq(schema.workforceTasks.taskId, task.taskId));
        for (const [index, spec] of plan.children.entries()) {
          const child = await insertChildTask(tx, task, input.turnNumber, index, spec);
          const depth = Array.isArray(child.ancestryPath) ? child.ancestryPath.length : 0;
          await tx
            .insert(schema.workforceDelegations, {
              workforceId: task.workforceId,
              parentTaskId: task.taskId,
              childTaskId: child.taskId,
              delegatedBy: task.owner,
              delegatedTo: child.owner,
              resolvedOwner: child.owner,
              goal: child.goal,
              expectedOutput: 'worker_result',
              depth,
              status: 'accepted' satisfies DelegationStatus,
            })
            .onConflictDoNothing();
          await appendTaskEvents(tx, task.taskId, [
            {
              type: 'workforce.delegation.accepted',
              payload: {
                parentTaskId: task.taskId,
                childTaskId: child.taskId,
                delegatedBy: task.owner,
                delegatedTo: child.owner,
                depth,
                goal: child.goal,
              },
            },
          ]);
        }
        finalTask = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'blocked',
          reason: 'awaiting_children',
          ...stamp,
        });
        break;
      }
      case 'request_approval': {
        const inserted = await tx
          .insert(schema.workforceApprovals, {
            taskId: task.taskId,
            question: plan.question,
            options: plan.options,
            approver: plan.approver,
            status: 'pending',
            timeoutAt: new Date(Date.now() + plan.timeoutMs),
            onTimeout: plan.onTimeout,
            escalateTo: plan.escalateTo,
          })
          .returning({ id: schema.workforceApprovals.id });
        const approvalId = (inserted[0] as { id: string }).id;
        await appendTaskEvents(tx, task.taskId, [
          {
            type: 'workforce.approval.requested',
            payload: {
              approvalId,
              taskId: task.taskId,
              question: plan.question,
              options: plan.options,
              approver: plan.approver,
              onTimeout: plan.onTimeout,
            },
          },
        ]);
        finalTask = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'waiting_for_user',
          reason: 'approval_pending',
          ...stamp,
        });
        break;
      }
      case 'request_review': {
        const inserted = await tx
          .insert(schema.workforceReviews, {
            taskId: task.taskId,
            reviewer: plan.reviewer,
            round: plan.round,
          })
          .returning({ id: schema.workforceReviews.id });
        await appendTaskEvents(tx, task.taskId, [
          {
            type: 'workforce.review.requested',
            payload: {
              reviewId: (inserted[0] as { id: string }).id,
              taskId: task.taskId,
              reviewer: plan.reviewer,
              round: plan.round,
            },
          },
        ]);
        finalTask = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'waiting_for_review',
          reason: 'review_pending',
          ...stamp,
        });
        break;
      }
      case 'review_rounds_exhausted': {
        // The round budget is spent; a human decides rather than an accept/rework loop.
        finalTask = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'waiting_for_user',
          ...stamp,
        });
        break;
      }
      case 'yield': {
        finalTask = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'queued',
          queueReason: 'turn_yield',
          ...stamp,
        });
        break;
      }
      case 'fail': {
        finalTask = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'failed',
          ...stamp,
        });
        await afterTaskTerminal(tx, finalTask);
        break;
      }
      case 'delegation_rejected': {
        // Record the refusal on the delegation table (the child ids are deterministic, so the
        // rejected rows are idempotent under re-execution too), then apply the tool-error fate.
        const intent = parsedIntent.success ? parsedIntent.data : null;
        if (intent?.kind === 'fan_out') {
          for (const [index, spec] of intent.children.entries()) {
            const childTaskId = deterministicChildTaskId(
              tx.tenantId,
              task.taskId,
              input.turnNumber,
              index,
            );
            await tx
              .insert(schema.workforceDelegations, {
                workforceId: task.workforceId,
                parentTaskId: task.taskId,
                childTaskId,
                delegatedBy: task.owner,
                delegatedTo: spec.owner,
                resolvedOwner: spec.owner,
                goal: spec.goal,
                expectedOutput: 'worker_result',
                depth: (Array.isArray(task.ancestryPath) ? task.ancestryPath.length : 0) + 1,
                status: 'rejected' satisfies DelegationStatus,
                rejectionReason: plan.reason,
              })
              .onConflictDoNothing();
            await appendTaskEvents(tx, task.taskId, [
              {
                type: 'workforce.delegation.rejected',
                payload: {
                  parentTaskId: task.taskId,
                  childTaskId,
                  delegatedBy: task.owner,
                  delegatedTo: spec.owner,
                  reason: plan.reason,
                  detail: plan.detail,
                },
              },
            ]);
          }
        }
        finalTask = await applyToolErrorFate(tx, task, plan.fate, stamp);
        break;
      }
      case 'invalid_intent': {
        finalTask = await applyToolErrorFate(tx, task, plan.fate, stamp);
        break;
      }
    }

    if (input.messages) {
      for (const message of input.messages) {
        await tx.insert(schema.workforceMessages, {
          taskId: task.taskId,
          sender: task.owner,
          recipient: message.recipient,
          body: message.body,
        });
      }
    }

    // The narrow post-turn absorption (signals.ts): a wake that arrived mid-turn and answers the
    // park this turn just applied re-queues the task NOW instead of stranding it.
    if (finalTask && finalTask.status === 'blocked') {
      const absorbed = await absorbPendingWakes(tx, finalTask);
      if (absorbed) finalTask = await readTask(tx, task.taskId);
    }

    await appendTaskEvents(tx, task.taskId, [
      {
        type: 'workforce.task.turn_ended',
        payload: {
          taskId: task.taskId,
          turnId: input.turnId,
          turnNumber: input.turnNumber,
          outcome: plan.kind,
          costUsd: actualUsd,
        },
      },
    ]);
    return { alreadyApplied: false, plan, task: finalTask };
  });
}

type Stamp = { actor: string; turnId: string; turnNumber: number };

/** One retry re-queue, then failed — both with the typed `tool_error` reason. */
async function applyToolErrorFate(
  tx: TenantDb,
  task: TaskRecord,
  fate: 'requeue' | 'fail',
  stamp: Stamp,
): Promise<TaskRecord> {
  const finalTask = await applyTransition(tx, {
    taskId: task.taskId,
    expectedVersion: task.version,
    to: fate === 'requeue' ? 'queued' : 'failed',
    reason: 'tool_error',
    ...(fate === 'requeue' ? { queueReason: 'tool_error' } : {}),
    ...stamp,
  });
  if (fate === 'fail') await afterTaskTerminal(tx, finalTask);
  return finalTask;
}

/**
 * A denied dispatch/fan-out blocks with the typed reason, journals the exceedance, and applies the
 * declared exhaustion policy (`block_and_escalate` additionally parks the ROOT for a human, with a
 * payload naming what would unblock it).
 */
export async function applyBudgetExhausted(
  tx: TenantDb,
  task: TaskRecord,
  denial: { scopeKind: string; scopeId: string; ceiling: unknown; consumed: number },
  budgets: WorkforceBudgets,
  stamp: Stamp | { actor: string },
): Promise<TaskRecord> {
  const blocked = await applyTransition(tx, {
    taskId: task.taskId,
    expectedVersion: task.version,
    to: 'blocked',
    reason: 'budget_exhausted',
    ...stamp,
  });
  await appendTaskEvents(tx, task.taskId, [
    {
      type: 'workforce.budget.exceeded',
      payload: {
        taskId: task.taskId,
        scopeKind: denial.scopeKind,
        scopeId: denial.scopeId,
        ceiling: denial.ceiling,
        consumed: denial.consumed,
        onBudgetExhausted: budgets.execution.onBudgetExhausted,
      },
    },
  ]);
  if (budgets.execution.onBudgetExhausted === 'block_and_escalate') {
    const rootId = task.rootTaskId;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const root = rootId === task.taskId ? blocked : await readTask(tx, rootId);
      if (root.status !== 'blocked' && root.status !== 'waiting_for_review') break;
      try {
        await applyTransition(tx, {
          taskId: root.taskId,
          expectedVersion: root.version,
          to: 'waiting_for_user',
          actor: 'system',
        });
        await appendTaskEvents(tx, root.taskId, [
          {
            type: 'workforce.budget.exceeded',
            payload: {
              taskId: root.taskId,
              escalatedFrom: task.taskId,
              scopeKind: denial.scopeKind,
              scopeId: denial.scopeId,
              unblock: 'raise the ceiling and send a budget_raised signal',
            },
          },
        ]);
        break;
      } catch (err) {
        // ONLY a lost version race retries; anything else is a real defect and must stay loud.
        if (!(err instanceof TaskVersionConflictError)) throw err;
      }
    }
  }
  return blocked;
}

/**
 * Cancel every non-terminal descendant, root-first; working ones absorb a cancel signal.
 *
 * The whole subtree read is a DELIBERATE full scan — a cascade that saw only a page of its
 * descendants would leave the rest running under a cancelled ancestor, so this one is bounded by
 * the subtree's own size, not by a LIMIT.
 *
 * Every row this will act on is locked FIRST, in the canonical root-first order (ancestry depth,
 * then task id — the tiebreaker matters: two cascades over overlapping subtrees must agree on the
 * order of same-depth siblings). The act-on decision is then made from the LOCKED row, never from
 * the snapshot: a descendant that ended its turn between the two reads is cancelled rather than
 * signalled into a task that will never run again.
 */
export async function cancelDescendants(
  tx: TenantDb,
  origin: TaskRecord,
  actor: string,
): Promise<{ cancelled: string[]; signalled: string[] }> {
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
  const cancelled: string[] = [];
  const signalled: string[] = [];
  for (const desc of locked) {
    if (!isTaskStatus(desc.status) || isTerminalStatus(desc.status)) continue;
    if (desc.status === 'working') {
      // Never kill a turn mid-flight: the cancel is absorbed at the turn's own boundary.
      await deliverSignal(tx, {
        taskId: desc.taskId,
        kind: 'cancel',
        signalKey: `cancel:${origin.taskId}`,
        payload: { origin: origin.taskId },
        actor,
      });
      signalled.push(desc.taskId);
      continue;
    }
    const done = await applyTransition(tx, {
      taskId: desc.taskId,
      expectedVersion: desc.version,
      to: 'cancelled',
      reason: 'cancelled_by_parent',
      actor,
    });
    await tx
      .update(schema.workforceDelegations, {
        status: 'cancelled' satisfies DelegationStatus,
        completedAt: new Date(),
      })
      .where(eq(schema.workforceDelegations.childTaskId, done.taskId));
    cancelled.push(desc.taskId);
  }
  return { cancelled, signalled };
}
