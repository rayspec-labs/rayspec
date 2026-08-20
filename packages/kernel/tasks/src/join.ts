/**
 * Fan-in — the parent's declared join policy and the DETERMINISTIC merge of child results.
 *
 * `joinPolicy` is the BINDING of the park the parent currently sits in: a strict object whose
 * `policy` is a closed enum — `all` (the one join a fan-out may declare) and `escalation` (the
 * engine-written binding naming the child that carries a park's escalation). The object shape (not
 * a bare string) is deliberate: a later policy is an enum addition, never a schema change, and a
 * policy that needs parameters adds optional keys beside it. A binding is inert once its park
 * resolves; the next fan-out or escalation overwrites it.
 *
 * BOTH members NAME THE CHILDREN THEY WAIT ON, for one reason: a parent's children are not all
 * from the same round. The buffered create tools open ordinary dispatchable rows under the parent
 * at any turn, so "every child" is a set that grows behind the join's back — a fire-and-forget
 * child parking on an approval would hold the parent in `awaiting_children` forever, the one park
 * no operator signal may release. The fan-out records the ids it opened; the join waits on exactly
 * those and on nothing that merely shares the parent.
 *
 * The merge rule protects replay: results are keyed by CHILD TASK ID and serialized with sorted
 * keys at every level, so NOTHING downstream can observe which child finished first — the merged
 * bytes are a pure function of the children's terminal rows, byte-identical across runs whatever
 * the completion order (the 100-run identity test pins exactly that). The merge stays UNSCOPED on
 * purpose: the parent's next turn should see every result that exists, not only the round's.
 */
import { z } from 'zod';
import type { TaskRecord } from './apply-transition.js';
import { isTaskStatus, isTerminalStatus } from './status.js';

/** The join a FAN-OUT intent may declare — the model-reachable half stays 'all'-only. */
export const fanOutJoinPolicySchema = z.strictObject({
  policy: z.enum(['all']),
});

/**
 * THE APPROVAL GATE a declared `approvalPolicies` rule imposes on a completion — the matched rule
 * as the ENGINE sees it.
 *
 * It lives here, beside the park binding, for the reason `maxRounds` does: the kernel is
 * deliberately roster-free and cannot read the workforce document, so a fact from that document
 * reaches a later decision point ONLY by riding the binding on the task's own row. The composition
 * computes it (`matchApprovalRule` over the employee's declared labels — never over anything the
 * turn wrote) and hands it to the engine on the trusted channel; the engine writes it here.
 *
 * `escalateTo` is NOT a grammar field: `WorkforceApprovalPolicySpec` declares no escalation target,
 * and the composition resolves it from the employee's `reportsTo` reporting edge exactly as the
 * `request_approval` tool door does. `null` means the seat has no superior, and the planner then
 * degrades an `escalate` fate to `fail` rather than refusing the completion.
 */
export const approvalGateSchema = z.strictObject({
  /** The DECLARED rule's id — journaled, so an operator can see which policy gated a release. */
  id: z.string().min(1),
  /** v1 pins this to the deployment's human operator surface; carried, never re-hardcoded. */
  approver: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  onTimeout: z.enum(['fail', 'escalate']),
  /** Resolved from the reporting edge by the composition; null when the seat has no superior. */
  escalateTo: z.string().min(1).nullable(),
});

export type ApprovalGate = z.output<typeof approvalGateSchema>;

/**
 * What the COLUMN may carry — one binding per park the engine can leave a task sitting in:
 *
 *   - `all`         the FAN-OUT binding, naming the children that fan-out opened;
 *   - `escalation`  the one child that carries the caller's escalation, so `blocked(escalated)` is
 *                   answered by exactly that child's terminal and by nothing else;
 *   - `review`      the pending review a `waiting_for_review` park waits on: which review row, the
 *                   dispatched review task (when there is one), the ROUND CEILING the matched
 *                   policy declared, and the APPROVAL GATE a completing verdict must open instead
 *                   of completing — all facts that live in a document the kernel deliberately
 *                   cannot read, and that the verdict path would otherwise never see;
 *   - `approval`    the pending approval a `blocked(approval_pending)` park waits on when the park
 *                   holds a FINISHED, stored result: the decision route completes the task on
 *                   `approve` rather than merely waking it, so it must know WHICH approval
 *                   authorises this release and refuse any other.
 *
 * `childTaskIds` stays OPTIONAL in the SCHEMA (the column is jsonb and a row could carry anything)
 * but is not optional in MEANING: every fan-out this engine writes names its children, and a park
 * that names none waits on nothing. There is deliberately no whole-child fallback — that reading is
 * the bug the binding exists to fix. `approvalId` is optional on the same terms and read the same
 * fail-closed way: a park that cannot say which approval it waits on releases nothing.
 */
export const joinPolicySchema = z.strictObject({
  policy: z.enum(['all', 'escalation', 'review', 'approval']),
  /** `all` only: the children THAT fan-out opened — the round the join waits on. */
  childTaskIds: z.array(z.string().min(1)).optional(),
  /** `escalation` only: the one child whose terminal answers the park. */
  escalationTaskId: z.string().min(1).optional(),
  /** `review` only: the pending review row this park waits on. */
  reviewId: z.string().min(1).optional(),
  /** `review` only: the dispatched review task, or null when a human decides the review. */
  reviewTaskId: z.string().min(1).nullable().optional(),
  /** `review` only: the matched policy's own round ceiling; absent when no policy declared one. */
  maxRounds: z.number().int().positive().optional(),
  /**
   * `review` only: the approval gate an ACCEPT verdict must open instead of completing. Absent when
   * no approval policy covers the seat — review then completes the task as it always has.
   */
  approvalGate: approvalGateSchema.optional(),
  /** `approval` only: the pending approval row whose `approve` releases this stored result. */
  approvalId: z.string().min(1).optional(),
});

export type JoinPolicy = z.output<typeof joinPolicySchema>;

/**
 * `all`: the join is satisfied when every child THE FAN-OUT OPENED holds a terminal status.
 *
 * `children` is every child the parent has EVER opened — across fan-out ROUNDS and including the
 * detached rows the buffered create tools write on any turn — which is why the round's own ids are
 * the predicate rather than the whole set. Without them a fire-and-forget child that parks on an
 * approval or a clarification holds the parent in `awaiting_children` for as long as it lives.
 *
 * NOTE for a future policy: a counting or quorum policy (`any`, `n_of_m`) reads the same binding
 * and is correct by the same construction — round one's completions are not in round two's id list,
 * so they cannot satisfy its quorum.
 */
export function isJoinSatisfied(policy: JoinPolicy, children: readonly TaskRecord[]): boolean {
  const terminal = (c: TaskRecord): boolean => isTaskStatus(c.status) && isTerminalStatus(c.status);
  switch (policy.policy) {
    case 'all': {
      // NO fallback for a binding-less `all`: every fan-out this engine writes names its children,
      // and a second join semantic living beside the real one is a standing trap — the whole-child
      // reading is exactly the bug the binding exists to fix, kept alive for rows that do not
      // exist. A park with no ids waits on nothing and is not satisfied.
      const terminalIds = new Set(children.filter(terminal).map((c) => c.taskId));
      const bound = policy.childTaskIds ?? [];
      return bound.length > 0 && bound.every((id) => terminalIds.has(id));
    }
    case 'escalation':
      // Never consulted through the awaiting_children branch (an escalated park is answered by
      // the reply fan-in, not by a join) — honest anyway: only the bound child's terminal counts.
      return children.some((c) => c.taskId === policy.escalationTaskId && terminal(c));
    case 'review':
      // Also never consulted through that branch (a review park is answered by the verdict route,
      // or released by `afterTaskTerminal` when the review task ends without one). Same rule: only
      // the bound review task counts, and a review nobody was dispatched for has no child answer.
      return (
        policy.reviewTaskId !== undefined &&
        policy.reviewTaskId !== null &&
        children.some((c) => c.taskId === policy.reviewTaskId && terminal(c))
      );
    case 'approval':
      // An approval park is answered by the DECISION route (approvals.ts) or by the timeout sweep,
      // never by a child's terminal — and it is not an `awaiting_children` park, so this branch is
      // never consulted for it. No child satisfies it, which is the honest answer rather than a
      // fallback that could release a gate nobody decided.
      return false;
  }
}

/** The per-child slice the parent's next turn receives — outcomes, never ordering. */
export interface MergedChildResult {
  readonly status: string;
  readonly statusReason: string | null;
  readonly result: unknown;
  readonly confidence: string | null;
  readonly costUsd: string;
  readonly turnsUsed: number;
}

/** Recursively sort object keys so serialization is a pure function of the VALUE. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

/**
 * Merge terminal children into the object the parent's next dispatch receives: keyed by child task
 * id, canonically serialized. Returns both the object and its canonical bytes (the tested form).
 */
export function mergeChildResults(children: readonly TaskRecord[]): {
  readonly byChildId: Readonly<Record<string, MergedChildResult>>;
  readonly canonicalJson: string;
} {
  const byChildId: Record<string, MergedChildResult> = {};
  for (const child of [...children].sort((a, b) => a.taskId.localeCompare(b.taskId))) {
    byChildId[child.taskId] = {
      status: child.status,
      statusReason: child.statusReason,
      result: child.result,
      confidence: child.confidence,
      costUsd: child.costUsd,
      turnsUsed: child.turnsUsed,
    };
  }
  return { byChildId, canonicalJson: JSON.stringify(canonicalize(byChildId)) };
}
