/**
 * The planner's every branch — this module carries the 100%-branch threshold, so each decision
 * path is pinned by a test: the cancel override, every fan-out rejection reason (and the ceilings
 * being absent), the escalate-without-target refusal, review-round exhaustion, both tool-error
 * fates, and the strictness of the intent/result schemas at every level.
 */
import { describe, expect, it } from 'vitest';
import {
  invalidIntentPlan,
  type PlanTurnInput,
  planTurnOutcome,
  turnIntentSchema,
  workerResultSchema,
} from './intent-applier.js';

const RESULT = {
  status: 'completed',
  summary: 'Done.',
  confidence: 0.9,
} as const;

function input(over: Partial<PlanTurnInput> = {}): PlanTurnInput {
  return {
    taskOwner: 'parent-owner',
    ancestryDepth: 0,
    ancestorOwners: [],
    existingDelegationCount: 0,
    maxDelegationDepth: null,
    maxDelegationsPerTask: null,
    maxReviewRounds: null,
    reviewRoundsUsed: 0,
    priorToolError: false,
    pendingCancel: false,
    intent: turnIntentSchema.parse({ kind: 'complete', result: RESULT }),
    ...over,
  };
}

const child = (owner: string) => ({ title: 'T', goal: 'G', owner });

function fanOut(owners: string[], over: Partial<PlanTurnInput> = {}): PlanTurnInput {
  return input({
    intent: turnIntentSchema.parse({ kind: 'fan_out', children: owners.map(child) }),
    ...over,
  });
}

describe('schemas are strict and closed', () => {
  it('rejects unknown intent kinds and unknown keys at every level', () => {
    expect(turnIntentSchema.safeParse({ kind: 'delegate' }).success).toBe(false);
    expect(turnIntentSchema.safeParse({ kind: 'complete', result: RESULT, extra: 1 }).success).toBe(
      false,
    );
    expect(
      turnIntentSchema.safeParse({
        kind: 'fan_out',
        children: [{ title: 'T', goal: 'G', owner: 'w', tools: ['shell'] }],
      }).success,
    ).toBe(false);
  });

  it('the result contract is closed: status enum, required confidence in [0,1]', () => {
    expect(workerResultSchema.safeParse({ ...RESULT, status: 'done' }).success).toBe(false);
    expect(workerResultSchema.safeParse({ status: 'completed', summary: 'x' }).success).toBe(false);
    expect(
      workerResultSchema.safeParse({ status: 'completed', summary: 'x', confidence: 1.5 }).success,
    ).toBe(false);
    expect(workerResultSchema.safeParse(RESULT).success).toBe(true);
  });

  it('an approval intent requires the enforced-fate window (timeoutMs)', () => {
    expect(
      turnIntentSchema.safeParse({ kind: 'request_approval', question: 'Ship it?' }).success,
    ).toBe(false);
  });
});

describe('the cancel override', () => {
  it('a pending cancel overrides EVERY intent kind', () => {
    expect(planTurnOutcome(input({ pendingCancel: true }))).toEqual({ kind: 'cancelled' });
    expect(planTurnOutcome(fanOut(['w1'], { pendingCancel: true }))).toEqual({ kind: 'cancelled' });
  });
});

describe('complete / yield / fail pass through', () => {
  it('complete carries the validated result', () => {
    const plan = planTurnOutcome(input());
    expect(plan.kind).toBe('complete');
    if (plan.kind === 'complete') expect(plan.result.summary).toBe('Done.');
  });

  it('yield and fail are direct plans', () => {
    expect(planTurnOutcome(input({ intent: turnIntentSchema.parse({ kind: 'yield' }) }))).toEqual({
      kind: 'yield',
    });
    expect(
      planTurnOutcome(
        input({ intent: turnIntentSchema.parse({ kind: 'fail', message: 'no path forward' }) }),
      ),
    ).toEqual({ kind: 'fail', message: 'no path forward' });
  });
});

describe('fan-out acceptance rules', () => {
  it('accepts a clean fan-out and carries the default join policy', () => {
    const plan = planTurnOutcome(fanOut(['w1', 'w2']));
    expect(plan.kind).toBe('fan_out');
    if (plan.kind === 'fan_out') {
      expect(plan.children).toHaveLength(2);
      expect(plan.joinPolicy).toEqual({ policy: 'all' });
    }
  });

  it('rejects past the depth ceiling (checked on the materialized ancestry)', () => {
    const plan = planTurnOutcome(fanOut(['w1'], { ancestryDepth: 2, maxDelegationDepth: 2 }));
    expect(plan).toMatchObject({
      kind: 'delegation_rejected',
      reason: 'depth_exceeded',
      fate: 'requeue',
    });
  });

  it('permits at the depth ceiling boundary', () => {
    expect(planTurnOutcome(fanOut(['w1'], { ancestryDepth: 1, maxDelegationDepth: 2 })).kind).toBe(
      'fan_out',
    );
  });

  it('rejects past the per-task fan-out cap (counted on the table, plus this request)', () => {
    const plan = planTurnOutcome(
      fanOut(['w1', 'w2'], { existingDelegationCount: 2, maxDelegationsPerTask: 3 }),
    );
    expect(plan).toMatchObject({ kind: 'delegation_rejected', reason: 'fanout_exceeded' });
  });

  it('rejects self-hand-off unconditionally', () => {
    const plan = planTurnOutcome(fanOut(['parent-owner']));
    expect(plan).toMatchObject({ kind: 'delegation_rejected', reason: 'self_delegation' });
  });

  it('rejects a cycle: a child owner already owning an ancestor', () => {
    const plan = planTurnOutcome(fanOut(['w1'], { ancestorOwners: ['w1', 'boss'] }));
    expect(plan).toMatchObject({ kind: 'delegation_rejected', reason: 'delegation_cycle' });
  });

  it('a second consecutive tool-error offense is terminal (fate: fail)', () => {
    const plan = planTurnOutcome(fanOut(['parent-owner'], { priorToolError: true }));
    expect(plan).toMatchObject({ kind: 'delegation_rejected', fate: 'fail' });
  });
});

describe('approval planning', () => {
  it("escalate without a target is refused — there is no implicit 'next approver up'", () => {
    const plan = planTurnOutcome(
      input({
        intent: turnIntentSchema.parse({
          kind: 'request_approval',
          question: 'Publish the statement?',
          timeoutMs: 60_000,
          onTimeout: 'escalate',
        }),
      }),
    );
    expect(plan).toMatchObject({ kind: 'invalid_intent', fate: 'requeue' });
  });

  it('a named escalation target passes and lands in the plan', () => {
    const plan = planTurnOutcome(
      input({
        intent: turnIntentSchema.parse({
          kind: 'request_approval',
          question: 'Publish the statement?',
          timeoutMs: 60_000,
          onTimeout: 'escalate',
          escalateTo: 'ops',
        }),
      }),
    );
    expect(plan).toMatchObject({ kind: 'request_approval', escalateTo: 'ops' });
  });

  it('the default fate is fail with a null escalation target', () => {
    const plan = planTurnOutcome(
      input({
        intent: turnIntentSchema.parse({
          kind: 'request_approval',
          question: 'Ship?',
          timeoutMs: 1000,
        }),
      }),
    );
    expect(plan).toMatchObject({ kind: 'request_approval', onTimeout: 'fail', escalateTo: null });
  });
});

describe('review planning', () => {
  const review = turnIntentSchema.parse({ kind: 'request_review', reviewer: 'reviewer-1' });

  it('a request inside the round budget carries the next round number', () => {
    const plan = planTurnOutcome(
      input({ intent: review, maxReviewRounds: 2, reviewRoundsUsed: 1 }),
    );
    expect(plan).toEqual({ kind: 'request_review', reviewer: 'reviewer-1', round: 2 });
  });

  it('a request past the round budget parks for a human', () => {
    const plan = planTurnOutcome(
      input({ intent: review, maxReviewRounds: 2, reviewRoundsUsed: 2 }),
    );
    expect(plan).toEqual({ kind: 'review_rounds_exhausted', reviewer: 'reviewer-1' });
  });

  it('no declared ceiling means no exhaustion', () => {
    const plan = planTurnOutcome(input({ intent: review, reviewRoundsUsed: 40 }));
    expect(plan).toMatchObject({ kind: 'request_review', round: 41 });
  });
});

describe('invalid intents', () => {
  it('first offense re-queues, second consecutive offense fails', () => {
    expect(invalidIntentPlan('bad', false)).toMatchObject({
      kind: 'invalid_intent',
      fate: 'requeue',
    });
    expect(invalidIntentPlan('bad', true)).toMatchObject({ kind: 'invalid_intent', fate: 'fail' });
  });
});

describe('clarification planning', () => {
  it('request_clarification passes through with its question', () => {
    expect(
      planTurnOutcome(
        input({
          intent: turnIntentSchema.parse({
            kind: 'request_clarification',
            question: 'Which environment is the target?',
          }),
        }),
      ),
    ).toEqual({ kind: 'request_clarification', question: 'Which environment is the target?' });
  });

  it('the question is required and unknown keys are refused', () => {
    expect(turnIntentSchema.safeParse({ kind: 'request_clarification' }).success).toBe(false);
    expect(
      turnIntentSchema.safeParse({ kind: 'request_clarification', question: 'q', to: 'user' })
        .success,
    ).toBe(false);
  });
});
