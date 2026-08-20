/**
 * THE APPROVAL GATE — one implementation of "a declared approval policy intercepts a completion",
 * shared by BOTH completion chokepoints.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS AT ALL, stated first because it is the whole design.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A worked task reaches `completed` at exactly TWO sites, and a gate on one of them is not a gate:
 *
 *   A. apply-intents.ts `case 'complete'` — a turn's complete intent with no matched review policy;
 *   B. reviews.ts, verdict `accept`     — which NEVER re-enters the planner.
 *
 * A matched review policy DIVERTS every completion from A to B. So a gate written only into the
 * planner looks complete, passes every test anyone would naturally write, and leaves every
 * review-covered seat ungated. Worse, it would be MODEL-STEERABLE: a review rule may trigger on
 * `confidenceBelow`, a number the submitting turn writes about ITSELF, so a seat covered by both
 * policies would pick which chokepoint it faces — and therefore whether it is gated — by choosing a
 * number. Both chokepoints call into this module, so both fates end at the same gate and the choice
 * buys nothing.
 *
 * (A third `to: 'completed'` exists — the reviewer's own child task after `submit_review`. It is
 * deliberately NOT gated: that completion records a VERDICT, it does not release a work product,
 * and parking it behind an approval would strand the reviewed task in `waiting_for_review`, a park
 * no signal and no sweep can reach.
 *
 * WHAT ENFORCES THAT IS THE ENGINE, not the composition, and the difference matters to anyone
 * deciding what is safe to remove. `readReviewAssignment` (apply-intents.ts) derives the assignment
 * from the PARENT's park binding, inside this package, where no composition can influence it; the
 * planner then refuses a `complete` from such a task outright with `invalid_intent`, BEFORE any
 * policy is read — pinned by `intent-applier.test.ts`'s `a review CHILD is never gated — its
 * completion is refused before any policy is read` and `refuses \`complete\` — the reviewed task
 * would park on a verdict that can never arrive`. A `request_review` from a review child is refused
 * on the same terms. The composition ALSO computes no policy channel for a task carrying a pending
 * review (`workforce-turn-handlers.ts`, the same rule review itself uses), and that is genuine
 * defence in depth — but it is the removable half, and removing it changes no outcome because the
 * engine has already refused every ending that could reach a gate from such a task.)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PARK, and why it is `blocked` rather than `waiting_for_user`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A gated completion parks in `blocked(approval_pending)` — NOT in the `waiting_for_user`
 * (`approval_pending`) park a `request_approval` opens. The two are genuinely different situations:
 * a request parks a task that has produced NOTHING and needs an answer before it can go on, while a
 * gate parks a task that has produced EVERYTHING and is blocked from releasing it.
 *
 * The mechanical consequence is what settles it. `ALLOWED_TRANSITIONS` (status.ts) had no edge from
 * either approval park to `completed`, so this feature needs a new cell whichever park it picks;
 * `blocked` needs exactly ONE (`blocked -> completed`) where `waiting_for_user` would need THREE —
 * the same completion edge, plus `blocked -> completed` anyway for the escalated case (the sweep
 * moves a `waiting_for_user` approval park to `blocked`), plus an unprecedented
 * `waiting_for_user -> waiting_for_user` self-transition for the reject fate. From `blocked`, the
 * reject fate is `blocked -> waiting_for_user` reasonless, which the table already carries and
 * already justifies as "escalation to a human".
 *
 * Everything else about the park is unchanged and shared with the request path:
 * `WAKES.approval_decided` already covers both parks (signals.ts), the timeout sweep's `fail`
 * branch already covers both (approvals.ts), and `approval_pending` is already a
 * `MECHANISM_PARK_REASONS` member so a budget escalation may not dissolve it.
 *
 * ONE STATED COST: `blocked(approval_pending)` is reachable by an operator `manual_unblock`
 * (`OPERATOR_UNBLOCKABLE`, signals.ts), where `waiting_for_user` is reachable by no operator signal
 * at all. So an operator CAN re-queue a task holding a stored result and a live approval, and the
 * seat then runs again. That is pre-existing behaviour of the escalated-approval park rather than
 * something this gate introduces, it cannot complete the task (the gate re-applies on the next
 * completion), and it is pinned by a test rather than argued about.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq } from 'drizzle-orm';
import type { TaskRecord } from './apply-transition.js';
import { appendTaskEvents } from './events.js';
import { type ApprovalGate, joinPolicySchema } from './join.js';

export type { ApprovalGate } from './join.js';

/**
 * The gate a `waiting_for_review` park carries, or null. Read from the park's OWN binding — the
 * same row the park lives on, so the fact cannot disagree with the park it describes, and the
 * verdict path (which is roster-free and cannot read the workforce document) has no other way to
 * learn it. Exactly how `maxRounds` reaches the same place.
 */
export function reviewParkApprovalGate(task: TaskRecord): ApprovalGate | null {
  const binding = joinPolicySchema.safeParse(task.joinPolicy);
  if (!binding.success || binding.data.policy !== 'review') return null;
  return binding.data.approvalGate ?? null;
}

/**
 * The approval a GATED COMPLETION park is waiting on, or null when this task is not sitting on one.
 *
 * FAIL-CLOSED on the binding, never on the row: a pending approval row is not proof that its task's
 * park is a gate, and releasing a completion against an approval the park does not name would
 * complete work nobody authorised. A binding with no `approvalId` therefore certifies nothing.
 */
export function gatedCompletionApprovalId(task: TaskRecord): string | null {
  const binding = joinPolicySchema.safeParse(task.joinPolicy);
  if (!binding.success || binding.data.policy !== 'approval') return null;
  return binding.data.approvalId ?? null;
}

/**
 * The question the human decides. ENGINE-COMPOSED and deterministic — it names the task, its owner
 * and the DECLARED rule, and deliberately carries no model-authored text: not the result summary,
 * not even the task title. Two reasons, both concrete. A title is authored text of unbounded length
 * that would need a truncation this file has no business owning (and a naive cut can split an
 * astral pair — see the `truncateCodeUnits` guards). And the question string is the identity the
 * re-request cap compares on (`normalizeApprovalQuestion`), so a gate question that varied with
 * model prose would collide unpredictably with a seat's own `request_approval` questions.
 */
export function gateApprovalQuestion(task: TaskRecord, gate: ApprovalGate): string {
  return (
    `Approve release of the completed result of task '${task.taskId}' (owner '${task.owner}')? ` +
    `The declared approval policy '${gate.id}' requires a human decision before this task ` +
    'completes. Rejecting keeps the stored result and hands the task to a human.'
  );
}

/**
 * Open the gate's approval row.
 *
 * `turnNumber` is the turn whose application opened it, or NULL when no turn did — the verdict path
 * (chokepoint B) runs on an HTTP route or inside a REVIEWER's turn, and stamping the reviewer's own
 * turn number onto the REVIEWED task's approval would collide with that task's own receipt key.
 * A NULL is exactly the shape the schema documents for a turn-less request (the sweep's escalation
 * re-issue writes one), and the partial UNIQUE `workforce_approvals_turn_receipt_idx` does not
 * dedupe it. Its dedupe is instead the caller's own compare-and-swap: the verdict's
 * `verdict IS NULL` CAS admits exactly one accept per review, so exactly one gate is opened.
 *
 * With a turn number the insert is IDEMPOTENT under whole-turn re-execution, the same second layer
 * beneath the receipt that `openReview`/`openApproval` rely on: a replay collides on the partial
 * UNIQUE, `onConflictDoNothing` makes that a no-op, and the returned id is the row the first
 * application wrote — so the park binding and the journal name the approval that actually exists.
 */
export async function openGateApproval(
  tx: TenantDb,
  task: TaskRecord,
  gate: ApprovalGate,
  turnNumber: number | null,
  now: Date = new Date(),
): Promise<string> {
  const row = {
    taskId: task.taskId,
    question: gateApprovalQuestion(task, gate),
    // Deliberately EMPTY: the decision route's own vocabulary is `approve` / `reject`
    // (`approvalDecisionSchema`), and restating it as free-text options would be a second,
    // drifting copy of a closed set.
    options: [],
    approver: gate.approver,
    status: 'pending',
    timeoutAt: new Date(now.getTime() + gate.timeoutMs),
    onTimeout: gate.onTimeout,
    escalateTo: gate.escalateTo,
    turnNumber,
  };
  const inserted = (await tx
    .insert(schema.workforceApprovals, row)
    .onConflictDoNothing()
    .returning({ id: schema.workforceApprovals.id })) as { id: string }[];
  const fresh = inserted[0];
  if (fresh) return fresh.id;
  // Only reachable with a turn number: the partial UNIQUE is the only conflict target, and a NULL
  // turn number is outside its predicate, so a turn-less insert always writes.
  const existing = (await tx
    .select(schema.workforceApprovals, { id: schema.workforceApprovals.id })
    .where(
      and(
        eq(schema.workforceApprovals.taskId, task.taskId),
        eq(schema.workforceApprovals.turnNumber, turnNumber as number),
      ),
    )) as { id: string }[];
  const row0 = existing[0];
  if (!row0) {
    throw new Error(
      `the gate approval for task '${task.taskId}' turn ${String(turnNumber)} neither inserted ` +
        'nor exists — refusing to bind a completion gate to an approval that is not there. ' +
        'Fail-closed.',
    );
  }
  return row0.id;
}

/**
 * BIND a `blocked(approval_pending)` park to the approval that releases it, on the same row the
 * park lives on (`joinPolicy`, the park-binding column — see join.ts). The decision route reads this
 * to tell a GATED completion from an ordinary `request_approval` wait, so a park that does not
 * carry it is decided the way it always was: journal, signal, re-queue.
 *
 * Overwrites whatever binding the row carried, which is the column's stated contract — a binding is
 * inert once its park resolves. At chokepoint B this replaces the `review` binding whose park the
 * verdict has just resolved.
 */
export async function bindGatedCompletionPark(
  tx: TenantDb,
  taskId: string,
  approvalId: string,
): Promise<void> {
  await tx
    .update(schema.workforceTasks, { joinPolicy: { policy: 'approval', approvalId } })
    .where(eq(schema.workforceTasks.taskId, taskId));
}

/**
 * Journal the gate's request under the EXISTING `workforce.approval.requested` type, with a
 * `policy` flag and the declared rule's id beside it — mirroring `workforce.review.requested`'s own
 * `policy` key, and keeping the frozen event vocabulary frozen (`events-docs-drift.test.ts` pins
 * the TYPE table; a new type would fail it, a new payload key on an existing type does not — which
 * is a reason to document the key, not a licence to skip it).
 */
export async function journalGateApprovalRequested(
  tx: TenantDb,
  task: TaskRecord,
  approvalId: string,
  gate: ApprovalGate,
): Promise<void> {
  await appendTaskEvents(tx, task.taskId, [
    {
      type: 'workforce.approval.requested',
      payload: {
        approvalId,
        taskId: task.taskId,
        question: gateApprovalQuestion(task, gate),
        options: [],
        approver: gate.approver,
        onTimeout: gate.onTimeout,
        // The two facts that distinguish a GATE from a seat's own request: policy imposed it, and
        // this is which policy. An operator reading the journal can otherwise not tell whether a
        // human was summoned by the seat or by the document.
        policy: true,
        policyId: gate.id,
      },
    },
  ]);
}
