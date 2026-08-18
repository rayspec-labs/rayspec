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

  it('subtracts targets the cycle rule refuses, and zeroes everything at depth 0', () => {
    // The manager owns an ancestor (an escalation chain): handing work back to a seat above the
    // task is the planner's delegation_cycle refusal, so the fact list must not advertise it —
    // employee:mgr goes, and department:eng goes WITH it (it RESOLVES to mgr).
    const task = fixtureTask({ owner: 'lead', ancestryPath: ['task_root', 'task_mid'] });
    const withAncestors = computeTurnFacts({
      config,
      employee: employee('lead'),
      task,
      snapshot: emptySnapshot(task, { ancestorOwners: ['mgr'] }),
    });
    expect(withAncestors.legalTargets).not.toContain('employee:mgr');
    expect(withAncestors.legalTargets).not.toContain('department:eng');
    expect(withAncestors.legalTargets).not.toContain('team:fix_team'); // its lead IS mgr
    expect(withAncestors.legalTargets).toContain('department:growth');
    expect(withAncestors.legalTargets).toContain('employee:dev');

    // Depth spent: every hand-off is refused depth_exceeded, so nothing is legal at all.
    const spent = computeTurnFacts({
      config,
      employee: employee('lead'),
      task: fixtureTask({ owner: 'lead', ancestryPath: ['a', 'b', 'c'] }),
      snapshot: emptySnapshot(task, {
        budgets: { ...emptySnapshot(task).budgets, delegation: { maxDepth: 3 } },
      }),
    });
    expect(spent.delegationDepthRemaining).toBe(0);
    expect(spent.legalTargets).toEqual([]);
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
        firesOnLabels: ['production_change'],
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
    // The manager holds both the label and the tool: the rule is a fact for its turns.
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
    // The copywriter holds the label but is a WORKER — no request_approval in its toolset,
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
    // No fan-out spent yet on this task → the full allowance remains.
    expect(facts.delegationsPerTaskRemaining).toBe(4);

    const unbounded = computeTurnFacts({
      config,
      employee: employee('mgr'),
      task,
      snapshot: emptySnapshot(task),
    });
    expect(unbounded.delegationDepthRemaining).toBeNull();
    expect(unbounded.delegationsPerTaskRemaining).toBeNull();
  });

  it('C3a: states the REMAINING fan-out allowance (maxPerTask minus what this task already spent)', () => {
    const task = fixtureTask({ owner: 'mgr', department: 'eng' });
    // Three hand-offs already opened from this task, cap 4 → one child left, not "up to 4".
    const partlySpent = computeTurnFacts({
      config,
      employee: employee('mgr'),
      task,
      snapshot: emptySnapshot(task, {
        delegationsFromTask: 3,
        budgets: { ...emptySnapshot(task).budgets, delegation: { maxPerTask: 4 } },
      }),
    });
    expect(partlySpent.delegationsPerTaskRemaining).toBe(1);

    // Spent past the cap (a re-queued turn) never advertises a negative allowance.
    const overspent = computeTurnFacts({
      config,
      employee: employee('mgr'),
      task,
      snapshot: emptySnapshot(task, {
        delegationsFromTask: 6,
        budgets: { ...emptySnapshot(task).budgets, delegation: { maxPerTask: 4 } },
      }),
    });
    expect(overspent.delegationsPerTaskRemaining).toBe(0);
  });

  it('C3b: does not advertise a department the ORCHESTRATOR itself manages (resolves to self)', () => {
    // The lint permits the orchestrator to manage a department; `department:eng` then resolves to the
    // orchestrator and the planner refuses it as self_delegation, so the fact list must omit it.
    const managed = fixtureConfig();
    const eng = managed.departments.get('eng') as NonNullable<
      ReturnType<typeof managed.departments.get>
    >;
    managed.departments.set('eng', { ...eng, manager: 'lead' });
    const task = fixtureTask({ owner: 'lead', department: null });
    const facts = computeTurnFacts({
      config: managed,
      employee: managed.employees.get('lead') as NonNullable<
        ReturnType<typeof managed.employees.get>
      >,
      task,
      snapshot: emptySnapshot(task),
    });
    expect(facts.legalTargets).not.toContain('department:eng'); // resolves to self
    expect(facts.legalTargets).toContain('department:growth'); // still legal
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
