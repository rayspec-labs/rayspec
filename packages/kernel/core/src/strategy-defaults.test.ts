/**
 * The five workforce strategy seams and their honest inline defaults. Each default is asserted for
 * WHAT IT PROMISES — the single-step plan, the deterministic first-qualified selection, the
 * empty-and-retention-free recall, the declared-rule review matching, and the fail-closed unrouted
 * approval — because "the default is always present so a workforce always runs" is only true if
 * every default actually behaves.
 */
import { describe, expect, it } from 'vitest';
import { ApprovalUnroutedError, UnroutedApprovalProvider } from './approval-provider.js';
import { EmptyRecallMemoryProvider } from './memory-provider.js';
import { SingleTaskPlanStrategy } from './orchestration-strategy.js';
import { DeclaredReviewPolicy, type DeclaredReviewRule } from './review-policy.js';
import { CapabilityMatchSelector, WorkerSelectionError } from './worker-selector.js';

describe('SingleTaskPlanStrategy', () => {
  it('plans the whole goal as one step for the default owner', async () => {
    const plan = await new SingleTaskPlanStrategy().plan({
      workforceId: 'wf',
      goal: 'Ship the release notes',
      requestedBy: 'user',
      defaultOwner: 'lead',
    });
    expect(plan.steps).toEqual([
      {
        title: 'Ship the release notes',
        goal: 'Ship the release notes',
        owner: 'lead',
        department: null,
        dependsOn: [],
      },
    ]);
  });

  it('bounds the step title while keeping the goal verbatim', async () => {
    const goal = 'x'.repeat(300);
    const plan = await new SingleTaskPlanStrategy().plan({
      workforceId: 'wf',
      goal,
      requestedBy: 'user',
      defaultOwner: 'lead',
    });
    expect(plan.steps[0]?.title.length).toBe(200);
    expect(plan.steps[0]?.goal).toBe(goal);
  });

  it('bounds an ASTRAL goal without splitting a pair — the arm above is pure ASCII', async () => {
    // `'x'.repeat(300)` is pure BMP, so its cut can never land inside a surrogate pair. A submitted
    // goal is requester-authored text and carries emoji routinely, so the cut position is not
    // something the engine picks.
    // The cut is at 197 (the title bound is 200, of which '...' takes three), so the LAST KEPT
    // index is 196 — the surrogate must sit THERE, not at 197. Getting this off by one produces a
    // fixture that still contains astral text and still passes a naive "is there a surrogate near
    // the cut" check while never exercising the guard, so the index is named rather than inlined.
    const lastKept = 197 - 1;
    const goal = `${'x'.repeat(lastKept)}${'\u{1F600}'.repeat(60)}`;
    // The fixture proves itself BEFORE anything else is asserted.
    expect(goal.length).toBeGreaterThan(200);
    expect(goal.charCodeAt(lastKept)).toBeGreaterThanOrEqual(0xd800);
    expect(goal.charCodeAt(lastKept)).toBeLessThanOrEqual(0xdbff);

    const plan = await new SingleTaskPlanStrategy().plan({
      workforceId: 'wf',
      goal,
      requestedBy: 'user',
      defaultOwner: 'lead',
    });
    const title = plan.steps[0]?.title as string;
    expect(title.isWellFormed()).toBe(true);
    // 196 kept + '...' — one shorter than the ASCII case, which IS the evidence that the guard
    // fired on a cut that really landed inside a pair.
    expect(title.length).toBe(199);
    expect(title.endsWith('...')).toBe(true);
    // The GOAL itself is never trimmed — the title bound must not touch it.
    expect(plan.steps[0]?.goal).toBe(goal);
  });
});

describe('CapabilityMatchSelector', () => {
  const selector = new CapabilityMatchSelector();
  const candidates = [
    { employeeId: 'a', role: 'worker', department: 'growth', capabilities: ['writing'] },
    { employeeId: 'b', role: 'worker', department: 'eng', capabilities: ['writing', 'review'] },
    { employeeId: 'c', role: 'worker', department: 'eng', capabilities: ['review'] },
  ] as const;

  it('selects the first candidate holding every required capability', async () => {
    const selection = await selector.select(
      { taskId: 't1', requiredCapabilities: ['writing'], department: null },
      candidates,
    );
    expect(selection.employeeId).toBe('a');
  });

  it('prefers a department match among the qualified', async () => {
    const selection = await selector.select(
      { taskId: 't2', requiredCapabilities: ['writing'], department: 'eng' },
      candidates,
    );
    expect(selection.employeeId).toBe('b');
    expect(selection.reason).toContain('task department');
  });

  it('fails closed when no candidate qualifies', async () => {
    await expect(
      selector.select({ taskId: 't3', requiredCapabilities: ['piloting'], department: null }, [
        ...candidates,
      ]),
    ).rejects.toBeInstanceOf(WorkerSelectionError);
  });

  it('fails closed on an empty candidate list', async () => {
    await expect(
      selector.select({ taskId: 't4', requiredCapabilities: [], department: null }, []),
    ).rejects.toBeInstanceOf(WorkerSelectionError);
  });
});

describe('EmptyRecallMemoryProvider', () => {
  it('returns no hits and retains nothing', async () => {
    const memory = new EmptyRecallMemoryProvider();
    await memory.remember({ text: 'a fact worth keeping' });
    await expect(memory.search({ text: 'fact' })).resolves.toEqual([]);
  });
});

describe('DeclaredReviewPolicy', () => {
  const rules: DeclaredReviewRule[] = [
    {
      id: 'eng-default',
      appliesTo: { department: 'eng' },
      reviewer: 'qa',
      requireWhen: { confidenceBelow: 0.75, labels: ['production_change'] },
      onReject: 'rework',
      maxRounds: 2,
    },
    {
      id: 'writer-check',
      appliesTo: { employee: 'copywriter' },
      reviewer: 'editor',
      requireWhen: { confidenceBelow: 0.9 },
      onReject: 'rework',
      maxRounds: 1,
    },
  ];
  const policy = new DeclaredReviewPolicy(rules);
  const subject = { taskId: 't', owner: 'dev', department: 'eng', labels: [] as string[] };

  it('matches a declared policy by department and confidence threshold', async () => {
    const decision = await policy.evaluate(subject, { output: {}, confidence: 0.6 });
    expect(decision).toEqual({
      required: true,
      policyId: 'eng-default',
      reviewer: 'qa',
      onReject: 'rework',
      maxRounds: 2,
    });
  });

  it('policy-label overlap triggers review even at high confidence', async () => {
    const decision = await policy.evaluate(
      { ...subject, labels: ['production_change'] },
      { output: {}, confidence: 0.99 },
    );
    expect(decision.required).toBe(true);
  });

  it('no matching rule means no review required', async () => {
    const decision = await policy.evaluate(
      { taskId: 't', owner: 'dev', department: 'growth', labels: [] },
      { output: {}, confidence: 0.1 },
    );
    expect(decision).toEqual({ required: false });
  });

  it('a confidence-free result does not trip a confidence threshold', async () => {
    const decision = await policy.evaluate(subject, { output: {}, confidence: null });
    expect(decision).toEqual({ required: false });
  });

  it('the first matching rule in declaration order wins', async () => {
    const decision = await policy.evaluate(
      { taskId: 't', owner: 'copywriter', department: 'eng', labels: [] },
      { output: {}, confidence: 0.5 },
    );
    expect(decision.required && decision.policyId).toBe('eng-default');
  });
});

describe('UnroutedApprovalProvider', () => {
  it('an unrouted approval request fails closed with a typed error', async () => {
    const approvals = new UnroutedApprovalProvider();
    await expect(
      approvals.request({
        taskId: 't',
        requestedBy: 'dev',
        approver: 'user',
        reason: 'publish',
        timeoutMs: 1000,
        onTimeout: 'fail',
      }),
    ).rejects.toBeInstanceOf(ApprovalUnroutedError);
    await expect(approvals.cancel('ticket-1', 'no longer needed')).rejects.toBeInstanceOf(
      ApprovalUnroutedError,
    );
  });
});
