/**
 * The planner's every branch — this module carries the 100%-branch threshold, so each decision
 * path is pinned by a test: the cancel override, every fan-out rejection reason (and the ceilings
 * being absent), the escalate-without-target refusal, the approval RE-REQUEST cap and its question
 * normalizer, review-round exhaustion, both tool-error fates, and the strictness of the
 * intent/result schemas at every level.
 */
import { describe, expect, it } from 'vitest';
import { delegationChildSpecSchema } from './create-task.js';
import {
  invalidIntentPlan,
  normalizeApprovalQuestion,
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
    resolvedApprovalQuestions: [],
    priorToolError: false,
    pendingCancel: false,
    matchedReviewPolicy: null,
    createdChildren: [],
    cancelTarget: null,
    reviewAssignment: null,
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

describe('the approval re-request cap (L-1)', () => {
  const ask = (question: string) =>
    turnIntentSchema.parse({ kind: 'request_approval', question, timeoutMs: 60_000 });

  it('refuses a question a human already resolved on this task', () => {
    const plan = planTurnOutcome(
      input({
        intent: ask('Ship the announcement?'),
        resolvedApprovalQuestions: ['Ship the announcement?'],
      }),
    );
    expect(plan).toMatchObject({ kind: 'invalid_intent', fate: 'requeue' });
    expect((plan as { detail: string }).detail).toContain('already carries a human decision');
  });

  it('a DIFFERENT question still passes — the cap is on repetition, not on the action', () => {
    const plan = planTurnOutcome(
      input({
        intent: ask('Also notify legal?'),
        resolvedApprovalQuestions: ['Ship the announcement?'],
      }),
    );
    expect(plan).toMatchObject({ kind: 'request_approval', question: 'Also notify legal?' });
  });

  it('with no resolved decisions on the task, nothing is refused', () => {
    const plan = planTurnOutcome(
      input({ intent: ask('Ship the announcement?'), resolvedApprovalQuestions: [] }),
    );
    expect(plan).toMatchObject({ kind: 'request_approval' });
  });

  // ---- the NORMALIZER, exercised independently of the membership check ------------------------
  // These four arms are what mutation M2 (normalize -> identity) attacks; the exact-match arm above
  // stays green under M2, which is the proof they are different predicates.
  it.each([
    ['leading/trailing whitespace', '  Ship the announcement?  '],
    ['collapsed internal whitespace', 'Ship   the\tannouncement?'],
    ['case', 'SHIP THE ANNOUNCEMENT?'],
    ['all three at once', '  ship   THE\nannouncement?  '],
  ])('a re-ask differing only in %s is still the same decision', (_label, variant) => {
    const plan = planTurnOutcome(
      input({ intent: ask(variant), resolvedApprovalQuestions: ['Ship the announcement?'] }),
    );
    expect(plan).toMatchObject({ kind: 'invalid_intent' });
  });

  it('normalization applies to the STORED side too, not only the asked side', () => {
    const plan = planTurnOutcome(
      input({
        intent: ask('Ship the announcement?'),
        resolvedApprovalQuestions: ['   SHIP   the announcement?  '],
      }),
    );
    expect(plan).toMatchObject({ kind: 'invalid_intent' });
  });

  it('a reworded question is NOT capped — the documented, deliberate limit', () => {
    const plan = planTurnOutcome(
      input({
        intent: ask('Should I ship the announcement?'),
        resolvedApprovalQuestions: ['Ship the announcement?'],
      }),
    );
    expect(plan).toMatchObject({ kind: 'request_approval' });
  });

  it('the second consecutive offence FAILS the task rather than requeueing forever', () => {
    const plan = planTurnOutcome(
      input({
        intent: ask('Ship the announcement?'),
        resolvedApprovalQuestions: ['Ship the announcement?'],
        priorToolError: true,
      }),
    );
    expect(plan).toMatchObject({ kind: 'invalid_intent', fate: 'fail' });
  });

  it('the cap runs AFTER the escalate-target refusal — the more specific detail wins', () => {
    const plan = planTurnOutcome(
      input({
        intent: turnIntentSchema.parse({
          kind: 'request_approval',
          question: 'Ship the announcement?',
          timeoutMs: 60_000,
          onTimeout: 'escalate',
        }),
        resolvedApprovalQuestions: ['Ship the announcement?'],
      }),
    );
    expect((plan as { detail: string }).detail).toContain('must name escalateTo');
  });

  it('a pending cancel still overrides the cap — cancellation outranks every intent', () => {
    const plan = planTurnOutcome(
      input({
        intent: ask('Ship the announcement?'),
        resolvedApprovalQuestions: ['Ship the announcement?'],
        pendingCancel: true,
      }),
    );
    expect(plan).toEqual({ kind: 'cancelled' });
  });
});

describe('normalizeApprovalQuestion', () => {
  it.each([
    ['  padded  ', 'padded'],
    ['MiXeD CaSe', 'mixed case'],
    ['a\t\tb\n c', 'a b c'],
    ['already normal', 'already normal'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeApprovalQuestion(raw)).toBe(expected);
  });

  it('is idempotent — normalizing a normalized question changes nothing', () => {
    const once = normalizeApprovalQuestion('  Ship   THE announcement?  ');
    expect(normalizeApprovalQuestion(once)).toBe(once);
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
    expect(plan).toEqual({ kind: 'review_rounds_exhausted', reviewer: 'reviewer-1', result: null });
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

describe('escalation planning', () => {
  const escalate = (over: Record<string, unknown> = {}) =>
    turnIntentSchema.parse({
      kind: 'escalate',
      reason: 'capability_missing',
      escalateTo: 'mgr',
      ...over,
    });

  it('escalate passes through with its resolved target and defaults', () => {
    expect(planTurnOutcome(input({ intent: escalate() }))).toEqual({
      kind: 'escalate',
      reason: 'capability_missing',
      detail: null,
      escalateTo: 'mgr',
      escalateToDepartment: null,
    });
  });

  it('detail and the target department ride along when given', () => {
    expect(
      planTurnOutcome(
        input({ intent: escalate({ detail: 'needs prod access', escalateToDepartment: 'eng' }) }),
      ),
    ).toMatchObject({ detail: 'needs prod access', escalateToDepartment: 'eng' });
  });

  it('self-escalation is a typed invalid intent (requeue first, fail after a prior offense)', () => {
    expect(
      planTurnOutcome(input({ intent: escalate({ escalateTo: 'parent-owner' }) })),
    ).toMatchObject({ kind: 'invalid_intent', fate: 'requeue' });
    expect(
      planTurnOutcome(
        input({ intent: escalate({ escalateTo: 'parent-owner' }), priorToolError: true }),
      ),
    ).toMatchObject({ kind: 'invalid_intent', fate: 'fail' });
  });

  it('escalating to an ANCESTOR owner is legal — escalation is not delegation', () => {
    expect(
      planTurnOutcome(
        input({
          intent: escalate({ escalateTo: 'grandparent-owner' }),
          ancestorOwners: ['grandparent-owner', 'parent-owner'],
          ancestryDepth: 2,
          maxDelegationDepth: 2,
        }),
      ),
    ).toMatchObject({ kind: 'escalate', escalateTo: 'grandparent-owner' });
  });

  it('the reason set is closed and unknown keys are refused', () => {
    expect(
      turnIntentSchema.safeParse({ kind: 'escalate', reason: 'because', escalateTo: 'mgr' })
        .success,
    ).toBe(false);
    expect(
      turnIntentSchema.safeParse({
        kind: 'escalate',
        reason: 'risk',
        escalateTo: 'mgr',
        override: true,
      }).success,
    ).toBe(false);
  });
});

describe('policy-intercepted completion', () => {
  const policy = { reviewer: 'qa', dispatchReviewer: true, maxRounds: 2 };

  it('a matched policy turns a completion into a review with the stored result', () => {
    expect(planTurnOutcome(input({ matchedReviewPolicy: policy }))).toEqual({
      kind: 'complete_with_review',
      result: workerResultSchema.parse(RESULT),
      reviewer: 'qa',
      dispatchReviewer: true,
      round: 1,
      maxRounds: 2,
    });
  });

  it('the plan carries the EFFECTIVE ceiling so the verdict path enforces the same one', () => {
    // The rule's 2 against an execution-wide 1: the plan records 1, and the review park's binding
    // carries it to the verdict — which previously saw only the budgets' half of the rule.
    expect(
      planTurnOutcome(input({ matchedReviewPolicy: policy, maxReviewRounds: 1 })),
    ).toMatchObject({ kind: 'complete_with_review', maxRounds: 1 });
    // No execution ceiling at all: the rule's own number is the whole ceiling.
    expect(planTurnOutcome(input({ matchedReviewPolicy: policy }))).toMatchObject({
      maxRounds: 2,
    });
  });

  it('policy rounds spent parks for a human WITH the result stored', () => {
    expect(planTurnOutcome(input({ matchedReviewPolicy: policy, reviewRoundsUsed: 2 }))).toEqual({
      kind: 'review_rounds_exhausted',
      reviewer: 'qa',
      result: workerResultSchema.parse(RESULT),
    });
  });

  it('the effective ceiling is the TIGHTER of the rule and the execution-wide one', () => {
    // Execution-wide 1 beats the rule's 2.
    expect(
      planTurnOutcome(
        input({ matchedReviewPolicy: policy, maxReviewRounds: 1, reviewRoundsUsed: 1 }),
      ),
    ).toMatchObject({ kind: 'review_rounds_exhausted' });
    // The rule's 2 beats an execution-wide 5.
    expect(
      planTurnOutcome(
        input({ matchedReviewPolicy: policy, maxReviewRounds: 5, reviewRoundsUsed: 2 }),
      ),
    ).toMatchObject({ kind: 'review_rounds_exhausted' });
    // Below both, the review dispatches.
    expect(
      planTurnOutcome(
        input({ matchedReviewPolicy: policy, maxReviewRounds: 5, reviewRoundsUsed: 1 }),
      ),
    ).toMatchObject({ kind: 'complete_with_review', round: 2 });
  });

  it('a human-decided policy keeps dispatchReviewer false', () => {
    expect(
      planTurnOutcome(
        input({ matchedReviewPolicy: { reviewer: 'user', dispatchReviewer: false, maxRounds: 1 } }),
      ),
    ).toMatchObject({ kind: 'complete_with_review', reviewer: 'user', dispatchReviewer: false });
  });
});

describe('a review child’s legal endings', () => {
  const assigned = { reviewAssignment: { reviewId: 'rev_1' } };

  it('refuses `complete` — the reviewed task would park on a verdict that can never arrive', () => {
    const plan = planTurnOutcome(input(assigned));
    expect(plan).toMatchObject({ kind: 'invalid_intent', fate: 'requeue' });
    expect((plan as { detail: string }).detail).toContain('rev_1');
  });

  it('refuses `request_review` — a review decides, it does not commission another', () => {
    expect(
      planTurnOutcome(
        input({
          ...assigned,
          intent: turnIntentSchema.parse({ kind: 'request_review', reviewer: 'qa2' }),
        }),
      ),
    ).toMatchObject({ kind: 'invalid_intent' });
  });

  it('takes the terminal fate on a second consecutive offense, like any malformed ending', () => {
    expect(planTurnOutcome(input({ ...assigned, priorToolError: true }))).toMatchObject({
      kind: 'invalid_intent',
      fate: 'fail',
    });
  });

  it('leaves every other ending alone — a reviewer may still escalate, yield or be cancelled', () => {
    expect(planTurnOutcome(input({ ...assigned, intent: { kind: 'yield' } }))).toEqual({
      kind: 'yield',
    });
    expect(
      planTurnOutcome(
        input({
          ...assigned,
          intent: turnIntentSchema.parse({
            kind: 'submit_review',
            reviewId: 'rev_1',
            verdict: 'accept',
          }),
        }),
      ),
    ).toMatchObject({ kind: 'submit_review', verdict: 'accept' });
    expect(planTurnOutcome(input({ ...assigned, pendingCancel: true }))).toEqual({
      kind: 'cancelled',
    });
  });
});

describe('review dispatch and reviewer verdicts', () => {
  it('request_review with dispatchReviewer plans the dispatched variant', () => {
    expect(
      planTurnOutcome(
        input({
          intent: turnIntentSchema.parse({
            kind: 'request_review',
            reviewer: 'qa',
            dispatchReviewer: true,
          }),
        }),
      ),
    ).toEqual({ kind: 'request_review_dispatch', reviewer: 'qa', round: 1 });
  });

  it('submit_review passes through verbatim', () => {
    expect(
      planTurnOutcome(
        input({
          intent: turnIntentSchema.parse({
            kind: 'submit_review',
            reviewId: 'rev-1',
            verdict: 'reject',
            reasons: ['thin evidence'],
            requiredChanges: ['add the table'],
          }),
        }),
      ),
    ).toEqual({
      kind: 'submit_review',
      reviewId: 'rev-1',
      verdict: 'reject',
      reasons: ['thin evidence'],
      requiredChanges: ['add the table'],
    });
  });

  it('the verdict enum is closed and unknown keys are refused', () => {
    expect(
      turnIntentSchema.safeParse({ kind: 'submit_review', reviewId: 'r', verdict: 'maybe' })
        .success,
    ).toBe(false);
    expect(
      turnIntentSchema.safeParse({
        kind: 'submit_review',
        reviewId: 'r',
        verdict: 'accept',
        force: true,
      }).success,
    ).toBe(false);
  });
});

describe('buffered created children', () => {
  const created = (owner: string) =>
    delegationChildSpecSchema.parse({ title: 'T', goal: 'G', owner });

  it('an empty buffer changes nothing', () => {
    expect(planTurnOutcome(input({ createdChildren: [] })).kind).toBe('complete');
  });

  it('buffered creates answer to the depth ceiling like any child', () => {
    expect(
      planTurnOutcome(
        input({
          createdChildren: [created('parent-owner')],
          ancestryDepth: 2,
          maxDelegationDepth: 2,
        }),
      ),
    ).toMatchObject({ kind: 'delegation_rejected', reason: 'depth_exceeded', fate: 'requeue' });
    expect(
      planTurnOutcome(
        input({
          createdChildren: [created('parent-owner')],
          ancestryDepth: 2,
          maxDelegationDepth: 2,
          priorToolError: true,
        }),
      ),
    ).toMatchObject({ kind: 'delegation_rejected', fate: 'fail' });
  });

  it('only HAND-OFFS count against the fan-out cap; self-owned planning children do not', () => {
    // Two self-owned + one hand-off against a cap of 1: the hand-off fits, the plan proceeds.
    expect(
      planTurnOutcome(
        input({
          createdChildren: [created('parent-owner'), created('parent-owner'), created('w1')],
          maxDelegationsPerTask: 1,
        }),
      ).kind,
    ).toBe('complete');
    // Two hand-offs against a cap of 1: rejected.
    expect(
      planTurnOutcome(
        input({
          createdChildren: [created('w1'), created('w2')],
          maxDelegationsPerTask: 1,
        }),
      ),
    ).toMatchObject({ kind: 'delegation_rejected', reason: 'fanout_exceeded' });
  });

  it('buffered hand-offs and a same-turn fan-out share ONE cap', () => {
    expect(
      planTurnOutcome(
        fanOut(['w2'], { createdChildren: [created('w1')], maxDelegationsPerTask: 1 }),
      ),
    ).toMatchObject({ kind: 'delegation_rejected', reason: 'fanout_exceeded' });
    expect(
      planTurnOutcome(
        fanOut(['w2'], { createdChildren: [created('w1')], maxDelegationsPerTask: 2 }),
      ).kind,
    ).toBe('fan_out');
  });

  it('a pending cancel still overrides a turn with buffered creates', () => {
    expect(
      planTurnOutcome(input({ createdChildren: [created('w1')], pendingCancel: true })),
    ).toEqual({ kind: 'cancelled' });
  });
});

describe('cancel_task planning', () => {
  const cancel = turnIntentSchema.parse({ kind: 'cancel_task', taskId: 'task_target' });

  it('a target in the caller subtree plans the cancellation with its detail', () => {
    expect(
      planTurnOutcome(
        input({
          intent: turnIntentSchema.parse({
            kind: 'cancel_task',
            taskId: 'task_target',
            detail: 'superseded by the merged approach',
          }),
          cancelTarget: { exists: true, inCallerSubtree: true },
        }),
      ),
    ).toEqual({
      kind: 'cancel_task',
      targetTaskId: 'task_target',
      detail: 'superseded by the merged approach',
    });
  });

  it('detail is optional and lands as null', () => {
    expect(
      planTurnOutcome(
        input({ intent: cancel, cancelTarget: { exists: true, inCallerSubtree: true } }),
      ),
    ).toEqual({ kind: 'cancel_task', targetTaskId: 'task_target', detail: null });
  });

  it('an unknown target or one outside the caller subtree is a typed invalid intent', () => {
    expect(
      planTurnOutcome(
        input({ intent: cancel, cancelTarget: { exists: false, inCallerSubtree: false } }),
      ),
    ).toMatchObject({ kind: 'invalid_intent', fate: 'requeue' });
    expect(
      planTurnOutcome(
        input({ intent: cancel, cancelTarget: { exists: true, inCallerSubtree: false } }),
      ),
    ).toMatchObject({ kind: 'invalid_intent' });
  });

  it('missing pre-read facts refuse defensively', () => {
    expect(planTurnOutcome(input({ intent: cancel, cancelTarget: null }))).toMatchObject({
      kind: 'invalid_intent',
    });
  });
});
