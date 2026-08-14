/**
 * The turn-intent PLANNER — the pure decision core of intent application.
 *
 * A turn handler returns exactly ONE turn-ending intent (a strict discriminated union — unknown
 * kinds and unknown keys are refused at the edge, and a `complete` carries a result that must
 * validate against the closed structured-result contract). This module turns (task snapshot,
 * intent, ceilings, pending-cancel) into a typed PLAN and nothing else: no I/O, no clock, no
 * database — which is why the build enforces 100% branch coverage HERE. An untested branch in this
 * module is a corrupted task graph; keeping it pure is what makes that bar honest in every lane.
 *
 * The safety rules the planner owns:
 *   - a pending `cancel` signal OVERRIDES the turn's own intent (the turn ran to its natural end —
 *     nothing is killed mid-flight — but its outcome is the cancellation);
 *   - fan-out acceptance checks: depth against the declared ceiling (on the materialized ancestry,
 *     never on promises), the per-task fan-out cap (counted on the delegation table), unconditional
 *     self-hand-off rejection, and cycle rejection when a child's owner already appears among the
 *     ancestor owners — each a CLOSED rejection reason, no override flag anywhere;
 *   - an approval with `onTimeout: 'escalate'` must NAME its escalation target — there is no
 *     implicit "next approver up" to guess at;
 *   - review rounds are a ceiling: a request past `maxReviewRounds` parks for a human instead of
 *     looping;
 *   - a malformed intent (or malformed result) never completes a task: it re-queues once with the
 *     typed `tool_error` reason and FAILS on the second consecutive offense.
 */
import { z } from 'zod';
import { type DelegationChildSpec, delegationChildSpecSchema } from './create-task.js';
import { type JoinPolicy, joinPolicySchema } from './join.js';

/** The closed structured-result contract. A result that fails this never completes a task. */
export const workerResultSchema = z.strictObject({
  status: z.enum(['completed', 'partial', 'failed', 'needs_clarification']),
  summary: z.string().min(1),
  findings: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
  artifacts: z
    .array(
      z.strictObject({ kind: z.string().min(1), id: z.string().min(1), title: z.string().min(1) }),
    )
    .default([]),
  confidence: z.number().min(0).max(1),
  needsFollowUp: z.boolean().default(false),
  suggestedFollowUp: z.string().min(1).optional(),
});

export type WorkerResult = z.output<typeof workerResultSchema>;

/**
 * WHY a task is being handed up the reporting line — a CLOSED set, journaled and greppable, never
 * model prose. The free-text `detail` rides beside it as data.
 */
export const ESCALATION_REASONS = [
  'out_of_scope',
  'insufficient_context',
  'budget',
  'capability_missing',
  'policy_conflict',
  'risk',
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** The one turn-ending intent a handler returns. Strict at every level. */
export const turnIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('complete'), result: workerResultSchema }),
  z.strictObject({
    kind: z.literal('fan_out'),
    children: z.array(delegationChildSpecSchema).min(1),
    joinPolicy: joinPolicySchema.prefault({ policy: 'all' }),
  }),
  z.strictObject({
    kind: z.literal('request_approval'),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).default([]),
    approver: z.string().min(1).default('user'),
    /** The enforced fate window: a hung approval is swept, never left waiting silently. */
    timeoutMs: z.number().int().positive(),
    onTimeout: z.enum(['fail', 'escalate']).default('fail'),
    escalateTo: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal('request_review'),
    reviewer: z.string().min(1),
    /**
     * True when the reviewer is a DECLARED EMPLOYEE whose verdict arrives through a dispatched
     * review turn — the application then also opens the reviewer's child task. Set by the caller's
     * TRUSTED layer from declared structure (the kernel stays roster-free); false means a human
     * decides through the verdict route, exactly as before.
     */
    dispatchReviewer: z.boolean().default(false),
  }),
  z.strictObject({
    /**
     * A reviewer turn's verdict on the task under review — its PARENT. `reviewId` is resolved by
     * the caller's trusted layer from the pending review row, never accepted from model text; the
     * application re-checks that the row belongs to the parent before any verdict applies.
     */
    kind: z.literal('submit_review'),
    reviewId: z.string().min(1),
    verdict: z.enum(['accept', 'reject']),
    reasons: z.array(z.string().min(1)).default([]),
    requiredChanges: z.array(z.string().min(1)).default([]),
  }),
  z.strictObject({
    /** Ask the requesting party a typed question; the task parks until a `user_reply` answers it. */
    kind: z.literal('request_clarification'),
    question: z.string().min(1),
  }),
  z.strictObject({
    /**
     * Hand the task up the reporting line. The caller parks `blocked(escalated)`; a FRESH child
     * task owned by the superior carries the escalation (their own open task, if any, is
     * structurally parked on a join and may not be woken — see `afterTaskTerminal`'s reply branch
     * for the way back). `escalateTo` is RESOLVED BY THE CALLER's trusted layer from the declared
     * reporting edge — never a model-supplied guess the kernel would have to verify.
     */
    kind: z.literal('escalate'),
    reason: z.enum(ESCALATION_REASONS),
    detail: z.string().min(1).optional(),
    escalateTo: z.string().min(1),
    /** Ledger attribution for the escalation child (the superior's department), when known. */
    escalateToDepartment: z.string().min(1).nullable().default(null),
  }),
  z.strictObject({
    /**
     * Cancel one task the caller owns or roots — the target must sit in the caller's own subtree
     * (checked against the immutable ancestry, planner + executor both). Cascades to the target's
     * descendants; the caller re-queues and keeps working. Not an operator kill switch.
     */
    kind: z.literal('cancel_task'),
    taskId: z.string().min(1),
    /** Journaled free text riding the turn record — never a status reason. */
    detail: z.string().min(1).optional(),
  }),
  z.strictObject({ kind: z.literal('yield') }),
  z.strictObject({ kind: z.literal('fail'), message: z.string().min(1) }),
]);

export type TurnIntent = z.output<typeof turnIntentSchema>;

export const DELEGATION_REJECTION_REASONS = [
  'depth_exceeded',
  'fanout_exceeded',
  'self_delegation',
  'delegation_cycle',
] as const;

export type DelegationRejectionReason = (typeof DELEGATION_REJECTION_REASONS)[number];

/** What a malformed/rejected turn outcome does to the task: one retry, then failure. */
export type ToolErrorFate = 'requeue' | 'fail';

export type TurnPlan =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'complete'; readonly result: WorkerResult }
  | {
      readonly kind: 'fan_out';
      readonly children: readonly ReturnType<typeof delegationChildSpecSchema.parse>[];
      readonly joinPolicy: JoinPolicy;
    }
  | {
      readonly kind: 'request_approval';
      readonly question: string;
      readonly options: readonly string[];
      readonly approver: string;
      readonly timeoutMs: number;
      readonly onTimeout: 'fail' | 'escalate';
      readonly escalateTo: string | null;
    }
  | { readonly kind: 'request_review'; readonly reviewer: string; readonly round: number }
  | {
      /** A review demanded WITH a dispatched reviewer turn — the application opens the child. */
      readonly kind: 'request_review_dispatch';
      readonly reviewer: string;
      readonly round: number;
    }
  | {
      /**
       * A schema-valid result whose completion a MATCHED REVIEW POLICY intercepts: the result is
       * stored, the task parks for review instead of completing — policy overrides what the turn
       * asked for.
       */
      readonly kind: 'complete_with_review';
      readonly result: WorkerResult;
      readonly reviewer: string;
      readonly dispatchReviewer: boolean;
      readonly round: number;
    }
  | {
      readonly kind: 'review_rounds_exhausted';
      readonly reviewer: string;
      /** A schema-valid result that arrived with the rounds already spent is STORED, never dropped. */
      readonly result: WorkerResult | null;
    }
  | {
      readonly kind: 'submit_review';
      readonly reviewId: string;
      readonly verdict: 'accept' | 'reject';
      readonly reasons: readonly string[];
      readonly requiredChanges: readonly string[];
    }
  | { readonly kind: 'request_clarification'; readonly question: string }
  | {
      readonly kind: 'escalate';
      readonly reason: EscalationReason;
      readonly detail: string | null;
      readonly escalateTo: string;
      readonly escalateToDepartment: string | null;
    }
  | {
      readonly kind: 'cancel_task';
      readonly targetTaskId: string;
      readonly detail: string | null;
    }
  | { readonly kind: 'yield' }
  | { readonly kind: 'fail'; readonly message: string }
  | {
      readonly kind: 'delegation_rejected';
      readonly reason: DelegationRejectionReason;
      readonly detail: string;
      readonly fate: ToolErrorFate;
    }
  | { readonly kind: 'invalid_intent'; readonly detail: string; readonly fate: ToolErrorFate };

export interface PlanTurnInput {
  /** The owner of the task whose turn ended (self-hand-off rejection input). */
  readonly taskOwner: string;
  /** Materialized ancestry depth (ancestryPath.length) — the depth-ceiling input. */
  readonly ancestryDepth: number;
  /** The OWNERS along the ancestry — the cycle-rejection input. */
  readonly ancestorOwners: readonly string[];
  /** Delegations this task has already opened (counted on the table, not on promises). */
  readonly existingDelegationCount: number;
  /** Declared ceilings (absent = unlimited). */
  readonly maxDelegationDepth: number | null;
  readonly maxDelegationsPerTask: number | null;
  readonly maxReviewRounds: number | null;
  /** Review rounds this task has already consumed. */
  readonly reviewRoundsUsed: number;
  /** True when the immediately preceding turn already ended in `tool_error` re-queue. */
  readonly priorToolError: boolean;
  /** True when a pending `cancel` signal was consumed at this turn's boundary. */
  readonly pendingCancel: boolean;
  /**
   * The TRUSTED review-policy match for a completing turn — computed by the caller's trusted layer
   * from declared rules and the submitted result, never model-reachable (tool arguments are the
   * model's only input; this field is not one). Null when no declared rule fires. The effective
   * round ceiling is the TIGHTER of the rule's own `maxRounds` and the execution-wide ceiling.
   */
  readonly matchedReviewPolicy: {
    readonly reviewer: string;
    readonly dispatchReviewer: boolean;
    readonly maxRounds: number;
  } | null;
  /**
   * Children the turn BUFFERED for creation (the non-turn-ending create tools) — validated by the
   * executor, applied atomically with the turn whatever its ending intent. They occupy the depth
   * tier a fan-out child would, and the ones that are HAND-OFFS (owner differs from the task's
   * own) count against the per-task fan-out cap exactly as delegation rows do; self-owned planning
   * children are not hand-offs and do not.
   */
  readonly createdChildren: readonly ReturnType<typeof delegationChildSpecSchema.parse>[];
  /**
   * Pre-read facts about a `cancel_task` intent's target (null for every other intent). Read from
   * the immutable ancestry, so no lock is needed for the membership fact.
   */
  readonly cancelTarget: { readonly exists: boolean; readonly inCallerSubtree: boolean } | null;
  readonly intent: TurnIntent;
}

function toolErrorFate(priorToolError: boolean): ToolErrorFate {
  return priorToolError ? 'fail' : 'requeue';
}

/** The plan for a turn whose intent (or result) failed validation at the edge. */
export function invalidIntentPlan(detail: string, priorToolError: boolean): TurnPlan {
  return { kind: 'invalid_intent', detail, fate: toolErrorFate(priorToolError) };
}

export function planTurnOutcome(input: PlanTurnInput): TurnPlan {
  if (input.pendingCancel) return { kind: 'cancelled' };
  const bufferedRejection = rejectBufferedCreates(input);
  if (bufferedRejection) return bufferedRejection;
  const intent = input.intent;
  switch (intent.kind) {
    case 'complete': {
      const policy = input.matchedReviewPolicy;
      if (policy === null) return { kind: 'complete', result: intent.result };
      // Policy OVERRIDES what the turn asked for: a matched rule intercepts the completion. The
      // effective ceiling is the tighter of the rule's own rounds and the execution-wide one; a
      // result that arrives with the rounds already spent is STORED and a human decides.
      const effectiveMax =
        input.maxReviewRounds !== null
          ? Math.min(policy.maxRounds, input.maxReviewRounds)
          : policy.maxRounds;
      if (input.reviewRoundsUsed >= effectiveMax) {
        return {
          kind: 'review_rounds_exhausted',
          reviewer: policy.reviewer,
          result: intent.result,
        };
      }
      return {
        kind: 'complete_with_review',
        result: intent.result,
        reviewer: policy.reviewer,
        dispatchReviewer: policy.dispatchReviewer,
        round: input.reviewRoundsUsed + 1,
      };
    }
    case 'fan_out': {
      const rejection = rejectFanOut(input, intent.children);
      if (rejection) return rejection;
      return { kind: 'fan_out', children: intent.children, joinPolicy: intent.joinPolicy };
    }
    case 'request_approval': {
      if (intent.onTimeout === 'escalate' && intent.escalateTo === undefined) {
        return invalidIntentPlan(
          "request_approval with onTimeout 'escalate' must name escalateTo — there is no implicit escalation target. Fail-closed.",
          input.priorToolError,
        );
      }
      return {
        kind: 'request_approval',
        question: intent.question,
        options: intent.options,
        approver: intent.approver,
        timeoutMs: intent.timeoutMs,
        onTimeout: intent.onTimeout,
        escalateTo: intent.escalateTo ?? null,
      };
    }
    case 'request_review': {
      if (input.maxReviewRounds !== null && input.reviewRoundsUsed >= input.maxReviewRounds) {
        return { kind: 'review_rounds_exhausted', reviewer: intent.reviewer, result: null };
      }
      const round = input.reviewRoundsUsed + 1;
      return intent.dispatchReviewer
        ? { kind: 'request_review_dispatch', reviewer: intent.reviewer, round }
        : { kind: 'request_review', reviewer: intent.reviewer, round };
    }
    case 'submit_review':
      return {
        kind: 'submit_review',
        reviewId: intent.reviewId,
        verdict: intent.verdict,
        reasons: intent.reasons,
        requiredChanges: intent.requiredChanges,
      };
    case 'request_clarification':
      return { kind: 'request_clarification', question: intent.question };
    case 'escalate': {
      if (intent.escalateTo === input.taskOwner) {
        return invalidIntentPlan(
          'escalate names the escalating task’s own owner — self-escalation resolves ' +
            'nothing and would loop. Fail-closed.',
          input.priorToolError,
        );
      }
      // DELIBERATELY not routed through `rejectFanOut`. Escalation is not delegation: the cycle
      // check would refuse handing UP to an ancestor's owner (the normal case — the reporting
      // chain usually owns the ancestors), and the depth ceiling would gag exactly the deep worker
      // whose situation most needs a superior. What bounds escalation instead is the DECLARED
      // reporting edge the caller resolved (acyclic, rooted — certified at validation) and the
      // fact that each hop is one fresh child, budget-probed before its row is written.
      return {
        kind: 'escalate',
        reason: intent.reason,
        detail: intent.detail ?? null,
        escalateTo: intent.escalateTo,
        escalateToDepartment: intent.escalateToDepartment,
      };
    }
    case 'cancel_task': {
      if (input.cancelTarget === null) {
        // Defensive: the executor always pre-reads the target for this intent kind.
        return invalidIntentPlan(
          'cancel_task arrived without its pre-read target facts. Fail-closed.',
          input.priorToolError,
        );
      }
      if (!input.cancelTarget.exists || !input.cancelTarget.inCallerSubtree) {
        return invalidIntentPlan(
          `cancel_task target '${intent.taskId}' does not exist in this task's own subtree — a ` +
            'turn may cancel only work it owns or roots. Fail-closed.',
          input.priorToolError,
        );
      }
      return { kind: 'cancel_task', targetTaskId: intent.taskId, detail: intent.detail ?? null };
    }
    case 'yield':
      return { kind: 'yield' };
    case 'fail':
      return { kind: 'fail', message: intent.message };
  }
}

/**
 * The ceilings buffered creates answer to: the DEPTH tier they would occupy (they are children,
 * exactly as a fan-out's) and — for the HAND-OFFS among them (owner differs from the task's own) —
 * the per-task fan-out cap, counted with the existing delegation rows. Self- and cycle-hand-off
 * rules deliberately do NOT apply: a self-owned planning child is the create tool's whole point,
 * and none of these children carries execution away from the caller's declared structure (the
 * trusted layer resolved each owner before buffering).
 */
function rejectBufferedCreates(input: PlanTurnInput): TurnPlan | null {
  if (input.createdChildren.length === 0) return null;
  if (input.maxDelegationDepth !== null && input.ancestryDepth + 1 > input.maxDelegationDepth) {
    return {
      kind: 'delegation_rejected',
      reason: 'depth_exceeded',
      detail: `created-child depth ${input.ancestryDepth + 1} exceeds maxDelegationDepth ${input.maxDelegationDepth}`,
      fate: toolErrorFate(input.priorToolError),
    };
  }
  const handOffs = input.createdChildren.filter((child) => child.owner !== input.taskOwner).length;
  if (
    input.maxDelegationsPerTask !== null &&
    handOffs > 0 &&
    input.existingDelegationCount + handOffs > input.maxDelegationsPerTask
  ) {
    return {
      kind: 'delegation_rejected',
      reason: 'fanout_exceeded',
      detail: `${input.existingDelegationCount} existing + ${handOffs} created hand-offs exceeds maxDelegationsPerTask ${input.maxDelegationsPerTask}`,
      fate: toolErrorFate(input.priorToolError),
    };
  }
  return null;
}

function rejectFanOut(
  input: PlanTurnInput,
  children: readonly DelegationChildSpec[],
): TurnPlan | null {
  if (input.maxDelegationDepth !== null && input.ancestryDepth + 1 > input.maxDelegationDepth) {
    return {
      kind: 'delegation_rejected',
      reason: 'depth_exceeded',
      detail: `child depth ${input.ancestryDepth + 1} exceeds maxDelegationDepth ${input.maxDelegationDepth}`,
      fate: toolErrorFate(input.priorToolError),
    };
  }
  // Buffered created hand-offs land in the SAME turn — they occupy cap slots beside these.
  const bufferedHandOffs = input.createdChildren.filter(
    (child) => child.owner !== input.taskOwner,
  ).length;
  if (
    input.maxDelegationsPerTask !== null &&
    input.existingDelegationCount + bufferedHandOffs + children.length > input.maxDelegationsPerTask
  ) {
    return {
      kind: 'delegation_rejected',
      reason: 'fanout_exceeded',
      detail: `${input.existingDelegationCount} existing + ${bufferedHandOffs} created + ${children.length} requested exceeds maxDelegationsPerTask ${input.maxDelegationsPerTask}`,
      fate: toolErrorFate(input.priorToolError),
    };
  }
  for (const child of children) {
    const owner = delegationChildSpecSchema.parse(child).owner;
    if (owner === input.taskOwner) {
      return {
        kind: 'delegation_rejected',
        reason: 'self_delegation',
        detail: `child owner '${owner}' is the delegating task's own owner`,
        fate: toolErrorFate(input.priorToolError),
      };
    }
    if (input.ancestorOwners.includes(owner)) {
      return {
        kind: 'delegation_rejected',
        reason: 'delegation_cycle',
        detail: `child owner '${owner}' already owns an ancestor task`,
        fate: toolErrorFate(input.priorToolError),
      };
    }
  }
  return null;
}
