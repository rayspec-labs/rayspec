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
 * What the COLUMN may carry — the FAN-OUT BINDING (`all`, naming the children that fan-out opened)
 * plus the ESCALATION BINDING the escalate executor writes (`escalation`, naming the one child that
 * carries the caller's escalation, so `blocked(escalated)` is answered by exactly that child's
 * terminal and by nothing else).
 *
 * `childTaskIds` is OPTIONAL for one reason only: a parent parked by a fan-out written before the
 * ids were recorded carries `{policy:'all'}` alone, and must keep the behaviour it parked under
 * rather than strand on a binding it never had. Every fan-out this engine writes names its children.
 */
export const joinPolicySchema = z.strictObject({
  policy: z.enum(['all', 'escalation']),
  /** `all` only: the children THAT fan-out opened — the round the join waits on. */
  childTaskIds: z.array(z.string().min(1)).optional(),
  /** `escalation` only: the one child whose terminal answers the park. */
  escalationTaskId: z.string().min(1).optional(),
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
      if (policy.childTaskIds === undefined) {
        // A pre-binding park: the whole child set is what it was parked against.
        return children.length > 0 && children.every(terminal);
      }
      const terminalIds = new Set(children.filter(terminal).map((c) => c.taskId));
      return (
        policy.childTaskIds.length > 0 && policy.childTaskIds.every((id) => terminalIds.has(id))
      );
    }
    case 'escalation':
      // Never consulted through the awaiting_children branch (an escalated park is answered by
      // the reply fan-in, not by a join) — honest anyway: only the bound child's terminal counts.
      return children.some((c) => c.taskId === policy.escalationTaskId && terminal(c));
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
