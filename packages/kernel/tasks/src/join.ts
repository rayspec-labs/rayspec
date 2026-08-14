/**
 * Fan-in — the parent's declared join policy and the DETERMINISTIC merge of child results.
 *
 * `joinPolicy` is a strict object whose `policy` is a closed enum with ONE member today (`all`).
 * The object shape (not a bare string) is deliberate: a later policy is an enum addition, never a
 * schema change, and a policy that needs parameters adds optional keys beside it.
 *
 * The merge rule protects replay: results are keyed by CHILD TASK ID and serialized with sorted
 * keys at every level, so NOTHING downstream can observe which child finished first — the merged
 * bytes are a pure function of the children's terminal rows, byte-identical across runs whatever
 * the completion order (the 100-run identity test pins exactly that).
 */
import { z } from 'zod';
import type { TaskRecord } from './apply-transition.js';
import { isTaskStatus, isTerminalStatus } from './status.js';

export const joinPolicySchema = z.strictObject({
  policy: z.enum(['all']),
});

export type JoinPolicy = z.output<typeof joinPolicySchema>;

/**
 * `all`: the join is satisfied when EVERY child holds a terminal status.
 *
 * NOTE for a future policy: `children` is every child the parent has EVER opened, across fan-out
 * ROUNDS, not the current round's. `all` is immune — an earlier round's children are terminal by
 * the time the parent fans out again, so they neither block nor satisfy anything. A counting or
 * quorum policy (`any`, `n_of_m`) would NOT be: round one's completions would satisfy round two's
 * quorum before a single new child finished. Such a policy must take the round's children, which
 * the deterministic child ids already carry (`(tenant, parent, turn, slot)` — the parent's
 * `turnsUsed` at fan-out IS the round, the same key the join signal is scoped by).
 */
export function isJoinSatisfied(policy: JoinPolicy, children: readonly TaskRecord[]): boolean {
  switch (policy.policy) {
    case 'all':
      return (
        children.length > 0 &&
        children.every((c) => isTaskStatus(c.status) && isTerminalStatus(c.status))
      );
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
