/**
 * The approval primitive's decision and timeout paths. A request parks its task in
 * `waiting_for_user(approval_pending)` at zero cost (apply-intents.ts writes the row and ends the
 * turn); THIS module is what releases it: a decision resolves the row, journals it, and wakes the
 * task through an idempotent `approval_decided` signal — and the timeout sweep gives every hung
 * approval its DECLARED fate (`fail` or `escalate`), because silent indefinite waiting is a
 * defect, not a default. Both paths compare-and-swap on `status = 'pending'`, so two racing
 * deciders (or a decider racing the sweep) admit exactly one winner.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { afterTaskTerminal, lockRootFirst } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { TaskVersionConflictError } from './errors.js';
import { appendTaskEvents } from './events.js';
import { deliverSignal } from './signals.js';

export type ApprovalRecord = typeof schema.workforceApprovals.$inferSelect;

export class ApprovalNotFoundError extends Error {
  readonly approvalId: string;
  constructor(approvalId: string) {
    super(`approval '${approvalId}' not found for this tenant. Fail-closed.`);
    this.name = 'ApprovalNotFoundError';
    this.approvalId = approvalId;
  }
}

export class ApprovalAlreadyDecidedError extends Error {
  readonly approvalId: string;
  readonly status: string;
  constructor(approvalId: string, status: string) {
    super(
      `approval '${approvalId}' is '${status}' — a decision resolves an approval exactly once. ` +
        'Fail-closed.',
    );
    this.name = 'ApprovalAlreadyDecidedError';
    this.approvalId = approvalId;
    this.status = status;
  }
}

export const approvalDecisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(1).optional(),
});

export type ApprovalDecisionInput = z.output<typeof approvalDecisionSchema> & {
  readonly approvalId: string;
  /**
   * The VERIFIED deciding principal — server-derived by the caller from its authenticated
   * context, never a client-asserted body field (the approval row is the engine's human-in-the-
   * loop accountability artifact).
   */
  readonly decidedBy: string;
};

/**
 * Resolve one pending approval and wake its task. The row update, the journal event and the wake
 * signal commit together; the signal key (`approval:<id>`) makes a re-sent decision a no-op.
 */
export async function decideApproval(
  tdb: TenantDb,
  input: ApprovalDecisionInput,
): Promise<ApprovalRecord> {
  return tdb.transaction(async (tx) => {
    const updated = (await tx
      .update(schema.workforceApprovals, {
        status: input.decision === 'approve' ? 'approved' : 'rejected',
        decision: input.decision,
        decidedBy: input.decidedBy,
        reason: input.reason ?? null,
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(schema.workforceApprovals.id, input.approvalId),
          eq(schema.workforceApprovals.status, 'pending'),
        ),
      )
      .returning()) as ApprovalRecord[];
    const approval = updated[0];
    if (!approval) {
      const rows = (await tx
        .select(schema.workforceApprovals)
        .where(eq(schema.workforceApprovals.id, input.approvalId))) as ApprovalRecord[];
      const existing = rows[0];
      if (!existing) throw new ApprovalNotFoundError(input.approvalId);
      throw new ApprovalAlreadyDecidedError(input.approvalId, existing.status);
    }
    await appendTaskEvents(tx, approval.taskId, [
      {
        type: 'workforce.approval.decided',
        payload: {
          approvalId: approval.id,
          taskId: approval.taskId,
          decision: input.decision,
          decidedBy: input.decidedBy,
          reason: input.reason ?? null,
        },
      },
    ]);
    await deliverSignal(tx, {
      taskId: approval.taskId,
      kind: 'approval_decided',
      signalKey: `approval:${approval.id}`,
      payload: { approvalId: approval.id, decision: input.decision, reason: input.reason ?? null },
      actor: input.decidedBy,
    });
    return approval;
  });
}

export interface ApprovalSweepOutcome {
  readonly failed: string[];
  readonly escalated: string[];
}

/**
 * Per-tick bound on the overdue-approval scan, matching the dispatcher's own scan bounds: a sweep
 * is a BOUNDED unit of work over an unbounded table. Safe to page here because every row the sweep
 * touches LEAVES the set — the `status = 'pending'` compare-and-swap resolves it to `timed_out` or
 * `escalated` — so the oldest-first page always advances and no approval can hide behind a backlog.
 */
const APPROVAL_SWEEP_LIMIT = 500;

const SWEEP_TRANSITION_RETRIES = 3;

async function transitionWithRetry(
  tx: TenantDb,
  taskId: string,
  fn: (task: TaskRecord) => Promise<void> | undefined,
): Promise<void> {
  for (let attempt = 1; attempt <= SWEEP_TRANSITION_RETRIES; attempt++) {
    const rows = (await tx
      .select(schema.workforceTasks)
      .where(eq(schema.workforceTasks.taskId, taskId))) as TaskRecord[];
    const task = rows[0];
    if (!task) return;
    try {
      await fn(task);
      return;
    } catch (err) {
      if (err instanceof TaskVersionConflictError && attempt < SWEEP_TRANSITION_RETRIES) continue;
      throw err;
    }
  }
}

/**
 * Enforce the declared fate of every overdue pending approval. `fail` fails the parked task;
 * `escalate` closes this request, re-issues it to the DECLARED escalation target with a fresh
 * window (and a terminal `fail` fate — the chain ends at a human, never in a loop), and moves the
 * task to `blocked(approval_pending)` so the escalated decision wakes it. Concurrency-safe: the
 * per-row `status = 'pending'` compare-and-swap makes two sweepers admit one winner per approval.
 *
 * BOUNDED per tick (`APPROVAL_SWEEP_LIMIT`), like every other per-tick scan in this engine, and
 * safely so: a swept approval leaves the `pending` predicate, so the page always advances.
 */
export async function sweepApprovalTimeouts(
  tdb: TenantDb,
  now: Date = new Date(),
): Promise<ApprovalSweepOutcome> {
  const due = (await tdb
    .select(schema.workforceApprovals)
    .where(
      and(
        eq(schema.workforceApprovals.status, 'pending'),
        isNotNull(schema.workforceApprovals.timeoutAt),
        lt(schema.workforceApprovals.timeoutAt, now),
      ),
    )
    // Longest-overdue first, `id` breaking a timestamp tie, so the bounded page is deterministic
    // and the next tick resumes exactly where this one stopped.
    .orderBy(asc(schema.workforceApprovals.timeoutAt), asc(schema.workforceApprovals.id))
    .limit(APPROVAL_SWEEP_LIMIT)) as ApprovalRecord[];
  const outcome: ApprovalSweepOutcome = { failed: [], escalated: [] };
  for (const approval of due) {
    // `escalate` without a declared target cannot happen through the intent path (fail-closed at
    // planning); a row that carries it anyway degrades to the terminal `fail` fate rather than
    // guessing a target.
    const fate =
      approval.onTimeout === 'escalate' && approval.escalateTo !== null ? 'escalate' : 'fail';
    await tdb.transaction(async (tx) => {
      const claimed = (await tx
        .update(schema.workforceApprovals, {
          status: fate === 'escalate' ? 'escalated' : 'timed_out',
          decidedAt: now,
        })
        .where(
          and(
            eq(schema.workforceApprovals.id, approval.id),
            eq(schema.workforceApprovals.status, 'pending'),
          ),
        )
        .returning()) as ApprovalRecord[];
      if (claimed.length === 0) return; // a decider or another sweeper won this row
      if (fate === 'fail') {
        // The `fail` fate fans in to the parent — a SECOND task row — so the root-first locks come
        // before ANY write on this task, the journal counter's own UPDATE included
        // (apply-intents.ts's module header). `escalate` moves one row and needs no pre-lock.
        const rows = (await tx
          .select(schema.workforceTasks)
          .where(eq(schema.workforceTasks.taskId, approval.taskId))) as TaskRecord[];
        const task = rows[0];
        if (task) await lockRootFirst(tx, task);
      }
      await appendTaskEvents(tx, approval.taskId, [
        {
          type: 'workforce.approval.timed_out',
          payload: {
            approvalId: approval.id,
            taskId: approval.taskId,
            onTimeout: approval.onTimeout,
            escalateTo: approval.escalateTo,
          },
        },
      ]);
      if (fate === 'escalate') {
        const windowMs = Math.max(
          approval.timeoutAt && approval.createdAt
            ? approval.timeoutAt.getTime() - approval.createdAt.getTime()
            : 0,
          60_000,
        );
        const escalatedTo = approval.escalateTo as string;
        const inserted = await tx
          .insert(schema.workforceApprovals, {
            taskId: approval.taskId,
            question: approval.question,
            options: approval.options,
            approver: escalatedTo,
            status: 'pending',
            timeoutAt: new Date(now.getTime() + windowMs),
            onTimeout: 'fail',
            escalateTo: null,
          })
          .returning({ id: schema.workforceApprovals.id });
        await appendTaskEvents(tx, approval.taskId, [
          {
            type: 'workforce.approval.requested',
            payload: {
              approvalId: (inserted[0] as { id: string }).id,
              taskId: approval.taskId,
              question: approval.question,
              options: approval.options,
              approver: escalatedTo,
              onTimeout: 'fail',
              escalatedFrom: approval.id,
            },
          },
        ]);
        await transitionWithRetry(tx, approval.taskId, async (task) => {
          if (task.status !== 'waiting_for_user') return;
          await applyTransition(tx, {
            taskId: task.taskId,
            expectedVersion: task.version,
            to: 'blocked',
            reason: 'approval_pending',
            actor: 'scheduler',
          });
        });
        outcome.escalated.push(approval.id);
        return;
      }
      await transitionWithRetry(tx, approval.taskId, async (task) => {
        // The ancestry is already locked above, so this read is the authoritative version.
        if (task.status !== 'waiting_for_user') return;
        const failed = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'failed',
          actor: 'scheduler',
        });
        await afterTaskTerminal(tx, failed);
      });
      outcome.failed.push(approval.id);
    });
  }
  return outcome;
}
