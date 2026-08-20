/**
 * The transition table's contract, asserted cell by cell. Fail-the-fix properties: dropping a cell,
 * softening a terminal row, widening a reason rule, or letting a free-text reason through each turns
 * a test here red — these are the invariants the exhaustiveness gate re-checks structurally in CI.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  isStatusReason,
  isTaskStatus,
  isTerminalStatus,
  REASON_RULES,
  STATUS_REASONS,
  StatusReasonInvalidError,
  TASK_STATUSES,
  type TaskStatus,
  TaskTransitionIllegalError,
  TERMINAL_STATUSES,
} from './status.js';

describe('ALLOWED_TRANSITIONS shape', () => {
  it('covers all 81 (from, to) pairs explicitly — 9 rows, 9 explicit boolean cells each', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS)).toEqual([...TASK_STATUSES]);
    for (const from of TASK_STATUSES) {
      const row = ALLOWED_TRANSITIONS[from];
      expect(Object.keys(row), `row '${from}'`).toEqual([...TASK_STATUSES]);
      for (const to of TASK_STATUSES) {
        expect(typeof row[to], `${from} -> ${to}`).toBe('boolean');
      }
    }
  });

  it('terminal rows are all-false, unconditionally', () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(ALLOWED_TRANSITIONS[from][to], `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('is deeply frozen — the table cannot be edited at runtime', () => {
    expect(Object.isFrozen(ALLOWED_TRANSITIONS)).toBe(true);
    for (const from of TASK_STATUSES) expect(Object.isFrozen(ALLOWED_TRANSITIONS[from])).toBe(true);
  });

  it('matches the normative matrix exactly (every allowed pair, no extras)', () => {
    const allowed: Record<TaskStatus, TaskStatus[]> = {
      planned: ['queued', 'blocked', 'failed', 'cancelled'],
      queued: ['working', 'blocked', 'failed', 'cancelled'],
      working: [
        'queued',
        'blocked',
        'waiting_for_review',
        'waiting_for_user',
        'completed',
        'failed',
        'cancelled',
      ],
      blocked: ['queued', 'waiting_for_user', 'completed', 'failed', 'cancelled'],
      waiting_for_review: [
        'queued',
        'blocked',
        'waiting_for_user',
        'completed',
        'failed',
        'cancelled',
      ],
      waiting_for_user: ['queued', 'blocked', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
    };
    for (const from of TASK_STATUSES) {
      const truthy = TASK_STATUSES.filter((to) => ALLOWED_TRANSITIONS[from][to]);
      expect(truthy, `row '${from}'`).toEqual(allowed[from]);
    }
  });

  it('blocked -> completed exists for exactly ONE reason: the approval gate releasing stored work', () => {
    // K-002. A policy-intercepted completion stores its result and parks in
    // `blocked(approval_pending)`; the human's `approve` is what releases it. Without this cell the
    // gate cannot exist at all — every other park an approval can occupy has no edge to `completed`
    // either. It is the only cell in the table whose driver is a HUMAN DECISION rather than a turn.
    expect(ALLOWED_TRANSITIONS.blocked.completed).toBe(true);
    // And it stays narrow: no OTHER park gained an edge to completed.
    expect(ALLOWED_TRANSITIONS.waiting_for_user.completed).toBe(false);
    expect(ALLOWED_TRANSITIONS.queued.completed).toBe(false);
    expect(ALLOWED_TRANSITIONS.planned.completed).toBe(false);
    // The reject fate needs no new cell — the table already carries "escalation to a human".
    expect(ALLOWED_TRANSITIONS.blocked.waiting_for_user).toBe(true);
  });

  it('no status transitions to ITSELF — the diagonal is false in every row', () => {
    // Pinned because K-002 considered a `waiting_for_user -> waiting_for_user` reason-change edge
    // and rejected it: a self-transition is a shape this table has never carried, and the park it
    // was wanted for is reachable without one.
    for (const from of TASK_STATUSES) {
      expect(ALLOWED_TRANSITIONS[from][from], `${from} -> ${from}`).toBe(false);
    }
  });

  it("the only way back into execution is 'queued' — the working column is true only on that row", () => {
    for (const from of TASK_STATUSES) {
      expect(ALLOWED_TRANSITIONS[from].working, `${from} -> working`).toBe(from === 'queued');
    }
  });
});

describe('REASON_RULES', () => {
  it('covers every StatusReason (key-set equality — an added reason without a rule fails)', () => {
    expect(Object.keys(REASON_RULES).sort()).toEqual([...STATUS_REASONS].sort());
  });

  it('every rule targets only real statuses, and every target admits the transition from somewhere', () => {
    for (const reason of STATUS_REASONS) {
      const targets = REASON_RULES[reason];
      expect(targets.length, `reason '${reason}' has at least one target`).toBeGreaterThan(0);
      for (const to of targets) {
        expect(isTaskStatus(to), `${reason} -> ${to}`).toBe(true);
        const reachable = TASK_STATUSES.some((from) => ALLOWED_TRANSITIONS[from][to]);
        expect(reachable, `'${to}' (for reason '${reason}') is reachable`).toBe(true);
      }
    }
  });
});

describe('assertTransition', () => {
  it('returns the narrowed reason on a legal (from, to, reason)', () => {
    expect(assertTransition('working', 'blocked', 'awaiting_children')).toBe('awaiting_children');
    expect(assertTransition('queued', 'working', null)).toBeNull();
  });

  it('throws TaskTransitionIllegalError on a pair outside the table', () => {
    expect(() => assertTransition('completed', 'queued', null)).toThrow(TaskTransitionIllegalError);
    expect(() => assertTransition('planned', 'working', null)).toThrow(TaskTransitionIllegalError);
  });

  it('throws StatusReasonInvalidError on free text — reasons are a closed set, never prose', () => {
    expect(() => assertTransition('working', 'blocked', 'the model felt like it')).toThrow(
      StatusReasonInvalidError,
    );
  });

  it('throws StatusReasonInvalidError when a real reason lands on a status outside its rule', () => {
    expect(() => assertTransition('working', 'completed', 'budget_exhausted')).toThrow(
      StatusReasonInvalidError,
    );
  });
});

describe('vocabulary guards', () => {
  it('isTaskStatus / isStatusReason accept exactly the closed sets', () => {
    for (const s of TASK_STATUSES) expect(isTaskStatus(s)).toBe(true);
    expect(isTaskStatus('paused')).toBe(false);
    for (const r of STATUS_REASONS) expect(isStatusReason(r)).toBe(true);
    expect(isStatusReason('because')).toBe(false);
  });

  it('isTerminalStatus names exactly completed/failed/cancelled', () => {
    for (const s of TASK_STATUSES) {
      expect(isTerminalStatus(s)).toBe(s === 'completed' || s === 'failed' || s === 'cancelled');
    }
  });
});
