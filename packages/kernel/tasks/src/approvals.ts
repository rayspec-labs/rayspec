/**
 * The approval primitive's decision and timeout paths. A request parks its task in
 * `waiting_for_user(approval_pending)` at zero cost (apply-intents.ts writes the row and ends the
 * turn); THIS module is what releases it: a decision resolves the row, journals it, and wakes the
 * task through an idempotent `approval_decided` signal — and the timeout sweep gives every hung
 * approval its DECLARED fate (`fail` or `escalate`), because silent indefinite waiting is a
 * defect, not a default. Both paths compare-and-swap on `status = 'pending'`, so two racing
 * deciders (or a decider racing the sweep) admit exactly one winner.
 *
 * A DECLARED APPROVAL POLICY MAKES THIS DOOR DO MORE THAN WAKE. When the park is a GATED COMPLETION
 * — a finished, stored result held back by a declared `approvalPolicies` rule (approval-gate.ts) —
 * `approve` COMPLETES the task here and `reject` parks it for a human, rather than re-queueing the
 * seat. That is what makes `requireWhen` require: a park whose only exit was a wake could never be
 * a gate, because the seat would simply run again and complete. It also drags the whole task lock
 * order into this module, which `decideApproval` takes explicitly and for a stated reason.
 *
 * THE ROW'S `approver` BINDS ITS DECIDER (decision-authority.ts). `'user'` is the open sentinel —
 * the deployment's human operator surface, what every shipped example declares — and stays open to
 * any permitted principal. A row that NAMES someone is the escalation case the sweep below mints:
 * `approver: escalateTo`, journaled as an accountability fact. Deciding that row as anyone else is
 * refused, unless the caller carries an AUTHORIZED break-glass override, which the journal then
 * records (`overriddenApprover`) so the trail stays honest about what happened.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { afterTaskTerminal, lockRootFirst } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { bindGatedCompletionPark, gatedCompletionApprovalId } from './approval-gate.js';
import { mayDecide } from './decision-authority.js';
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

/**
 * A decision this approval NAMED someone else to make. The row's `approver` is an accountability
 * fact the engine journaled; resolving it as anyone else would let `decided_by` contradict the
 * trail, so it is refused unless a caller carries an authorized break-glass override.
 */
export class ApprovalApproverMismatchError extends Error {
  readonly approvalId: string;
  /** Who the row names. */
  readonly approver: string;
  /** Who tried. */
  readonly actor: string;
  constructor(approvalId: string, approver: string, actor: string) {
    super(
      `approval '${approvalId}' names '${approver}' as its approver — '${actor}' is not that ` +
        'principal, and the engine journaled that name as an accountability fact. Decide it as ' +
        'the named approver, or break the glass with the override permission (the journal ' +
        'records the override). Fail-closed.',
    );
    this.name = 'ApprovalApproverMismatchError';
    this.approvalId = approvalId;
    this.approver = approver;
    this.actor = actor;
  }
}

export const approvalDecisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(1).optional(),
  /**
   * BREAK-GLASS INTENT — never break-glass AUTHORITY. A door that admits this field must AND it
   * with a server-side permission check before passing `overrideNamedApprover` down; the flag says
   * only that the caller ASKED, which is what makes the override deliberate rather than a silent
   * side effect of holding a role.
   */
  override: z.boolean().default(false),
});

export type ApprovalDecisionInput = Omit<z.output<typeof approvalDecisionSchema>, 'override'> & {
  readonly approvalId: string;
  /**
   * The VERIFIED deciding principal — server-derived by the caller from its authenticated
   * context, never a client-asserted body field (the approval row is the engine's human-in-the-
   * loop accountability artifact).
   */
  readonly decidedBy: string;
  /**
   * The caller has VERIFIED that this principal may override a named approver (an authorization
   * decision the caller owns — the kernel is deliberately roster- and permission-free). Set only
   * where a request both asked for the override and passed the permission gate. The override lands
   * in the journal as `overriddenApprover`.
   */
  readonly overrideNamedApprover?: boolean;
};

/**
 * The task this decision RELEASES, or null when the decision merely wakes one.
 *
 * A GATED COMPLETION park (`blocked(approval_pending)` with a `policy: 'approval'` binding naming
 * this approval — see approval-gate.ts) holds a finished, stored result that only a human decision
 * can release. Everything else — a seat's own `request_approval`, or a gate park waiting on a
 * DIFFERENT approval — is decided the way it always was: journal, signal, and let the wake set
 * re-queue the task.
 *
 * THE TASK LOCK ORDER, and why this function exists rather than an inline read. Releasing a gate
 * reaches a SECOND task row (`afterTaskTerminal` fans in to the parent on `approve`), so the
 * root-first task locks must be taken BEFORE the approval-row compare-and-swap — `tasks` then
 * `approvals`, the same direction every turn acquires them (a turn holds its task locks and then
 * writes approval rows). Taking them the other way round would be an `approvals -> tasks`
 * acquisition against the turn's `tasks -> approvals`, i.e. a deadlock by design; it is exactly the
 * hazard reviews.ts's module header exists to prevent, and `applyReviewVerdictInTx` takes its locks
 * in this same order for this same reason. The plain SELECTs above and inside here take no lock, so
 * they impose no order of their own.
 *
 * A SINGLE-THREADED TEST CANNOT DEMONSTRATE THIS. Nothing in the suite interleaves two
 * transactions on these rows, so a green run is not evidence about the lock order — the argument
 * above is, and the protocol is copied from the one path that already had to get it right.
 */
async function lockGatedCompletionPark(
  tx: TenantDb,
  approval: ApprovalRecord,
): Promise<TaskRecord | null> {
  const rows = (await tx
    .select(schema.workforceTasks)
    .where(eq(schema.workforceTasks.taskId, approval.taskId))) as TaskRecord[];
  const snapshot = rows[0];
  if (!snapshot) return null;
  if (gatedCompletionApprovalId(snapshot) !== approval.id) return null;
  const task = await lockRootFirst(tx, snapshot);
  // RE-CHECK UNDER THE LOCK. A racer (the timeout sweep, an operator unblock, a cancel cascade) may
  // have moved the task while we waited. Fail-closed to the ordinary decision path: the approval
  // still resolves and still journals, and nothing completes a task whose park is gone. The CAS
  // below remains the race arbiter for the approval row itself.
  if (task.status !== 'blocked' || task.statusReason !== 'approval_pending') return null;
  if (gatedCompletionApprovalId(task) !== approval.id) return null;
  return task;
}

/**
 * Resolve one pending approval and either RELEASE its task or wake it. The row update, the journal
 * event, any transition and the signal commit together; the signal key (`approval:<id>`) makes a
 * re-sent decision a no-op.
 *
 * PROTOCOL. The authority gate runs FIRST, on a plain read, so a refusal writes NOTHING — no CAS,
 * no journal-counter UPDATE, no signal, no lock. It cannot be the race arbiter and does not try to
 * be: the `status = 'pending'` compare-and-swap below is still the only thing that admits one
 * winner (two authorized racers both read `pending`, both CAS, and the loser lands in the same
 * already-decided branch as before). `approver` is written once at insert and never updated, so
 * reading it outside the CAS is sound. THEN the task locks (root-first, before the CAS — see
 * `lockGatedCompletionPark`), then the CAS, then the journal, then the outcome.
 *
 * WHAT A DECISION DOES depends on the park's own BINDING, never on the approval row alone:
 *
 *   - a GATED COMPLETION park, `approve` — the task COMPLETES here and fans in to its parent. The
 *     seat is NOT re-dispatched to "finish": it already finished, the result is stored on the row,
 *     and the human authorised exactly those bytes. Re-running it would re-spend budget and could
 *     produce a different result than the one that was signed off.
 *   - a GATED COMPLETION park, `reject` — the task parks in `waiting_for_user` (reasonless), which
 *     a `user_reply` releases. NOT rework: no approval round counter exists and the re-request cap
 *     never sees a `complete` intent, so a rework fate is unbounded by construction. NOT `fail`: a
 *     rejection is "you are not authorised to release this", not "your work is wrong", and the
 *     stored result stays for the human who now owns the decision.
 *   - anything else — the historical behaviour: journal and signal, and the wake set decides.
 *
 * THE SIGNAL IS DELIVERED LAST, AFTER any transition. `deliverSignal` records the row always and
 * re-queues only when the kind ANSWERS the park the task is in (`answersPark`, signals.ts). Ordered
 * this way the decision is still journalled as a signal a later turn can read, while a released
 * task — now `completed`, or `waiting_for_user` with no reason — matches no `approval_decided` park
 * and cannot be spuriously re-queued.
 */
export async function decideApproval(
  tdb: TenantDb,
  input: ApprovalDecisionInput,
): Promise<ApprovalRecord> {
  return tdb.transaction(async (tx) => {
    const claim = (await tx
      .select(schema.workforceApprovals)
      .where(eq(schema.workforceApprovals.id, input.approvalId))) as ApprovalRecord[];
    const named = claim[0];
    // A tenant-scoped miss is the uniform not-found; an already-resolved row is the conflict. Both
    // answer BEFORE the authority gate, so the gate never becomes an oracle for a row's state that
    // the caller could not otherwise read.
    if (!named) throw new ApprovalNotFoundError(input.approvalId);
    if (named.status !== 'pending') {
      throw new ApprovalAlreadyDecidedError(input.approvalId, named.status);
    }
    const overrode = !mayDecide(named.approver, input.decidedBy);
    if (overrode && input.overrideNamedApprover !== true) {
      throw new ApprovalApproverMismatchError(input.approvalId, named.approver, input.decidedBy);
    }
    const gated = await lockGatedCompletionPark(tx, named);
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
          // PRESENT ONLY ON A BREAK-GLASS DECISION. An audit trail that can be contradicted by the
          // next write is worse than no claim, so the one case where `decided_by` does NOT match
          // the recorded approver says so, in the journal, naming who was overridden.
          ...(overrode ? { overriddenApprover: approval.approver } : {}),
          // PRESENT ONLY ON A GATED COMPLETION — this decision did not merely answer a question,
          // it decided whether finished work ships. An operator reading the trail must be able to
          // tell the two apart.
          ...(gated !== null ? { gatedCompletion: true, outcome: input.decision } : {}),
        },
      },
    ]);
    if (gated !== null) {
      if (input.decision === 'approve') {
        // THE RELEASE. The result is already on the row (the interception stored it), so this is
        // the completion the turn asked for, authorised.
        const done = await applyTransition(tx, {
          taskId: gated.taskId,
          expectedVersion: gated.version,
          to: 'completed',
          actor: input.decidedBy,
        });
        await afterTaskTerminal(tx, done);
      } else {
        // REJECTED. The work stands and stays stored; the RELEASE does not happen. The reasonless
        // `waiting_for_user` park is the one a spent review-round budget and an abandoned review
        // both use, and `user_reply` is its exit (WAKES, signals.ts).
        await applyTransition(tx, {
          taskId: gated.taskId,
          expectedVersion: gated.version,
          to: 'waiting_for_user',
          actor: input.decidedBy,
        });
      }
    }
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
 * Enforce the declared fate of every overdue pending approval. `fail` fails the task parked on the
 * approval — in EITHER of the two parks an approval wait can occupy, the `waiting_for_user` one a
 * request opens and the `blocked` one an escalation moves it to (and a declared approval GATE opens
 * directly), so the chain's terminal fate lands where the chain actually left the task.
 *
 * WHAT `onTimeout: fail` NOW COSTS, said out loud because the word did not change and its price
 * did: on a `request_approval` the task had produced NOTHING, so the fate cost an unanswered
 * question. On a GATED COMPLETION (approval-gate.ts) the task holds a finished, stored result, and
 * failing it throws that release away. That is the fail-CLOSED posture — a release nobody
 * authorised does not ship — but an operator declaring `onTimeout: fail` on an approval policy is
 * declaring something more expensive than the same word means on a request, and
 * `docs/spec-reference.md` says so. It is pinned by a test.
 *
 * `escalate` closes this request, re-issues it to the
 * DECLARED escalation target with a fresh window (and that terminal `fail` fate — the chain ends at
 * a human, never in a loop), and moves the task to `blocked(approval_pending)` so the escalated
 * decision wakes it. Concurrency-safe: the per-row `status = 'pending'` compare-and-swap makes two
 * sweepers admit one winner per approval.
 *
 * The RETURN VALUE reports what was applied, not what was attempted: an approval whose task had
 * already moved beyond any approval park resolves to `timed_out` and appears in neither list.
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
        const reissuedId = (inserted[0] as { id: string }).id;
        await appendTaskEvents(tx, approval.taskId, [
          {
            type: 'workforce.approval.requested',
            payload: {
              approvalId: reissuedId,
              taskId: approval.taskId,
              question: approval.question,
              options: approval.options,
              approver: escalatedTo,
              onTimeout: 'fail',
              escalatedFrom: approval.id,
            },
          },
        ]);
        // RE-BIND A GATED COMPLETION PARK to the re-issued request. The park names the ONE approval
        // that may release it (fail-closed, approval-gate.ts), and the escalation mints a NEW row —
        // so a binding left naming the escalated-away id would make the superior's `approve` fall
        // through to the ordinary wake, which re-queues the task and RE-DISPATCHES the seat with a
        // finished result. The gate would survive its own escalation as a re-run. The chain hands
        // the same question one hop along; the binding follows it.
        const parkRows = (await tx
          .select(schema.workforceTasks)
          .where(eq(schema.workforceTasks.taskId, approval.taskId))) as TaskRecord[];
        const parked = parkRows[0];
        if (parked && gatedCompletionApprovalId(parked) === approval.id) {
          await bindGatedCompletionPark(tx, approval.taskId, reissuedId);
        }
        await transitionWithRetry(tx, approval.taskId, async (task) => {
          // A GATED completion already sits in `blocked(approval_pending)` — the park the escalate
          // branch moves a request's task INTO — so this guard correctly leaves it where it is, and
          // `WAKES.approval_decided` covers that park either way.
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
        //
        // TWO PARKS, ONE LINKAGE. A request parks its task in `waiting_for_user(approval_pending)`;
        // an ESCALATED request's own timeout finds the task in `blocked(approval_pending)`, where
        // the escalate branch above moved it — the same wait one hop along the chain, which the
        // wake set already treats as one park (`WAKES.approval_decided`, signals.ts). A fail fate
        // that knew only the first park reached nothing for exactly the requests a re-issue covers,
        // and the chain's terminal fate silently became "parked until an operator notices".
        // The REASON is the linkage and nothing wider is admitted: a task blocked on its children,
        // on a dependency or on a clarification is not waiting on this approval.
        if (
          task.status !== 'waiting_for_user' &&
          !(task.status === 'blocked' && task.statusReason === 'approval_pending')
        ) {
          return;
        }
        const failed = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'failed',
          actor: 'scheduler',
        });
        await afterTaskTerminal(tx, failed);
        // RECORDED ONLY WHERE IT APPLIED. The sweep's return is what a scheduler tick journals, so
        // an unconditional push outside the callback asserted a failure for every row whose task
        // had moved on (cancelled, already terminal) — a return value that lies about the work.
        outcome.failed.push(approval.id);
      });
    });
  }
  return outcome;
}
