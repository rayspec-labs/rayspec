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
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, inArray } from 'drizzle-orm';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { probeSpend, settleTurn, type WorkforceBudgets } from './budget.js';
import { insertChildTask } from './create-task.js';
import { TaskNotFoundError, TaskRowCorruptError } from './errors.js';
import { appendTaskEvents } from './events.js';
import { deterministicChildTaskId } from './ids.js';
import {
  invalidIntentPlan,
  planTurnOutcome,
  type TurnPlan,
  turnIntentSchema,
} from './intent-applier.js';
import { isJoinSatisfied, joinPolicySchema } from './join.js';
import { consumePendingSignals, deliverSignal } from './signals.js';
import { isTaskStatus, isTerminalStatus } from './status.js';

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
 * A task just reached a terminal status: settle its opening delegation record and, when its
 * parent is parked on the join, check fan-in. Exported for the cancel cascade, which terminates
 * tasks outside a turn.
 */
export async function afterTaskTerminal(tx: TenantDb, task: TaskRecord): Promise<void> {
  await tx
    .update(schema.workforceDelegations, { status: task.status, completedAt: new Date() })
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
  await deliverSignal(tx, {
    taskId: parent.taskId,
    kind: 'child_completed',
    signalKey: `join:${parent.taskId}`,
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

    const task = await readTask(tx, input.taskId);
    if (task.status !== 'working') {
      throw new TurnStateError(input.taskId, `status '${task.status}'`);
    }

    const signals = await consumePendingSignals(tx, input.taskId);
    const pendingCancel = signals.some((s) => s.kind === 'cancel');

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
              depth: Array.isArray(child.ancestryPath) ? child.ancestryPath.length : 0,
              status: 'accepted',
            })
            .onConflictDoNothing();
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
        await tx.insert(schema.workforceReviews, {
          taskId: task.taskId,
          reviewer: plan.reviewer,
          round: plan.round,
        });
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
            await tx
              .insert(schema.workforceDelegations, {
                workforceId: task.workforceId,
                parentTaskId: task.taskId,
                childTaskId: deterministicChildTaskId(
                  tx.tenantId,
                  task.taskId,
                  input.turnNumber,
                  index,
                ),
                delegatedBy: task.owner,
                delegatedTo: spec.owner,
                resolvedOwner: spec.owner,
                goal: spec.goal,
                expectedOutput: 'worker_result',
                depth: (Array.isArray(task.ancestryPath) ? task.ancestryPath.length : 0) + 1,
                status: 'rejected',
                rejectionReason: plan.reason,
              })
              .onConflictDoNothing();
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
      } catch {
        // A racer moved the root; re-read and retry (bounded), else leave it be.
      }
    }
  }
  return blocked;
}

/** Cancel every non-terminal descendant, root-first; working ones absorb a cancel signal. */
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
        (t.ancestryPath as string[]).includes(origin.taskId),
    )
    .sort(
      (a, b) =>
        (Array.isArray(a.ancestryPath) ? a.ancestryPath.length : 0) -
        (Array.isArray(b.ancestryPath) ? b.ancestryPath.length : 0),
    );
  const cancelled: string[] = [];
  const signalled: string[] = [];
  for (const desc of descendants) {
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
      .update(schema.workforceDelegations, { status: 'cancelled', completedAt: new Date() })
      .where(eq(schema.workforceDelegations.childTaskId, done.taskId));
    cancelled.push(desc.taskId);
  }
  return { cancelled, signalled };
}
