/**
 * The turn scaffolding's facts, proven against the SAME predicates the enforcement path uses:
 * legal targets per role (including the led-team grant's activeTeamIds gate), applicable review
 * rules, the shared approval matcher, and the budget/depth arithmetic. Pure.
 */
import { describe, expect, it } from 'vitest';
import { computeTurnFacts } from './facts.js';
import { matchApprovalRule } from './review-policy.js';
import { emptySnapshot, fixtureConfig, fixtureTask } from './test-support/fixtures.js';

const config = fixtureConfig();
const employee = (id: string) =>
  config.employees.get(id) as NonNullable<ReturnType<typeof config.employees.get>>;

describe('computeTurnFacts', () => {
  it('gives the orchestrator every department, team and employee but itself, in declaration order', () => {
    const task = fixtureTask({ owner: 'lead', department: null });
    const facts = computeTurnFacts({
      config,
      employee: employee('lead'),
      task,
      snapshot: emptySnapshot(task),
    });
    expect(facts.legalTargets).toEqual([
      'department:eng',
      'department:growth',
      'team:fix_team',
      'employee:mgr',
      'employee:dev',
      'employee:qa',
      'employee:copy',
      'employee:cmo',
    ]);
  });

  it("gives a manager their own members, and a led team's members ONLY on that team's work", () => {
    const task = fixtureTask({ owner: 'mgr' });
    const offTeamWork = computeTurnFacts({
      config,
      employee: employee('mgr'),
      task,
      snapshot: emptySnapshot(task),
    });
    // Off team work: own department members only — qa (a fix_team member) is NOT reachable.
    expect(offTeamWork.legalTargets).toEqual(['employee:dev']);

    const onTeamWork = computeTurnFacts({
      config,
      employee: employee('mgr'),
      task,
      snapshot: emptySnapshot(task, { activeTeamIds: ['fix_team'] }),
    });
    // On the team's work the led-team grant opens — deduped, declaration order, first wins.
    expect(onTeamWork.legalTargets).toEqual(['employee:dev', 'employee:qa']);
  });

  it('gives workers and reviewers no delegation targets — and empty is the stated fact', () => {
    for (const id of ['dev', 'qa']) {
      const task = fixtureTask({ owner: id });
      const facts = computeTurnFacts({
        config,
        employee: employee(id),
        task,
        snapshot: emptySnapshot(task),
      });
      expect(facts.legalTargets).toEqual([]);
    }
  });

  it('lists exactly the review rules covering the employee, with the triggers the employee can trip', () => {
    const task = fixtureTask();
    const dev = computeTurnFacts({
      config,
      employee: employee('dev'),
      task,
      snapshot: emptySnapshot(task),
    });
    expect(dev.reviewRules).toEqual([
      {
        id: 'eng_default',
        reviewer: 'qa',
        confidenceBelow: 0.75,
        firesOnCapabilities: ['production_change'],
        maxRounds: 2,
      },
    ]);
    // The copywriter sits in growth — the eng rule does not cover them.
    const copy = computeTurnFacts({
      config,
      employee: employee('copy'),
      task: fixtureTask({ owner: 'copy', department: 'growth' }),
      snapshot: emptySnapshot(task),
    });
    expect(copy.reviewRules).toEqual([]);
  });

  it('presents the SAME approval rule the request_approval handler will bind — for seats that HOLD the tool', () => {
    // The manager holds both the capability and the tool: the rule is a fact for its turns.
    const task = fixtureTask({ owner: 'cmo' });
    const facts = computeTurnFacts({
      config,
      employee: employee('cmo'),
      task,
      snapshot: emptySnapshot(task),
    });
    expect(facts.approvalRule).toEqual(matchApprovalRule(config, employee('cmo')));
    expect(facts.approvalRule).toEqual({
      id: 'public_statement',
      timeoutMs: 72 * 3_600_000,
      onTimeout: 'escalate',
    });
    // The copywriter holds the capability but is a WORKER — no request_approval in its toolset,
    // so no approval fact: a turn is never told about a tool the runtime will refuse it.
    const worker = computeTurnFacts({
      config,
      employee: employee('copy'),
      task: fixtureTask({ owner: 'copy' }),
      snapshot: emptySnapshot(task),
    });
    expect(worker.approvalRule).toBeNull();
    const uncovered = computeTurnFacts({
      config,
      employee: employee('mgr'),
      task: fixtureTask({ owner: 'mgr' }),
      snapshot: emptySnapshot(task),
    });
    expect(uncovered.approvalRule).toBeNull(); // a decision seat NO rule covers
  });

  it('computes depth remaining from the declared ceiling and the immutable ancestry', () => {
    const task = fixtureTask({ ancestryPath: ['task_root', 'task_mid'] });
    const snapshot = emptySnapshot(task, {
      budgets: {
        ...emptySnapshot(task).budgets,
        delegation: { maxDepth: 3, maxPerTask: 4 },
      },
    });
    const facts = computeTurnFacts({ config, employee: employee('mgr'), task, snapshot });
    expect(facts.delegationDepthRemaining).toBe(1);
    expect(facts.delegationsPerTaskLimit).toBe(4);

    const unbounded = computeTurnFacts({
      config,
      employee: employee('mgr'),
      task,
      snapshot: emptySnapshot(task),
    });
    expect(unbounded.delegationDepthRemaining).toBeNull();
    expect(unbounded.delegationsPerTaskLimit).toBeNull();
  });

  it('reports live workforce spend only where the snapshot carries the state view', () => {
    const task = fixtureTask({ owner: 'lead' });
    const withState = computeTurnFacts({
      config,
      employee: employee('lead'),
      task,
      snapshot: emptySnapshot(task, {
        budgets: {
          ...emptySnapshot(task).budgets,
          workforce: { usd: 25, window: 'daily' },
        },
        workforceState: {
          paused: false,
          departments: [],
          openByStatus: {},
          budget: { ceilingUsd: 25, consumedUsd: 3.2, headroomUsd: 21.8 },
        },
      }),
    });
    expect(withState.budget).toMatchObject({
      workforceCeilingUsd: 25,
      workforceConsumedUsd: 3.2,
      workforceHeadroomUsd: 21.8,
    });

    const withoutState = computeTurnFacts({
      config,
      employee: employee('dev'),
      task: fixtureTask(),
      snapshot: emptySnapshot(task, {
        budgets: { ...emptySnapshot(task).budgets, workforce: { usd: 25, window: 'daily' } },
      }),
    });
    // The ceiling is declared truth; the live numbers are UNKNOWN from this seat, never invented.
    expect(withoutState.budget).toMatchObject({
      workforceCeilingUsd: 25,
      workforceConsumedUsd: null,
      workforceHeadroomUsd: null,
    });
  });
});
