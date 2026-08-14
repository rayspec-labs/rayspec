/**
 * The budgets declaration schema + the pure scope/window derivation. Fail-the-fix properties:
 * an unknown key accepted anywhere, a widened default, a scope out of canonical lock order, or a
 * window bucket drifting off its UTC boundary each turns a test here red.
 */
import { describe, expect, it } from 'vitest';
import {
  EPOCH_WINDOW_START,
  ledgerScopesFor,
  resolveWorkforceBudgets,
  windowStartFor,
  workforceBudgetsSchema,
} from './budget.js';
import { WorkforceBudgetsInvalidError } from './errors.js';

describe('workforceBudgetsSchema', () => {
  it('accepts an empty declaration and fills the execution defaults', () => {
    const parsed = workforceBudgetsSchema.parse({});
    expect(parsed.execution.onBudgetExhausted).toBe('block');
    expect(parsed.execution.estimateUsdPerTurn).toBe(0);
  });

  it('rejects unknown keys at every nesting level (strict, fail-closed)', () => {
    expect(() => workforceBudgetsSchema.parse({ budget: {} })).toThrow();
    expect(() => workforceBudgetsSchema.parse({ workforce: { usd: 1, cap: 2 } })).toThrow();
    expect(() => workforceBudgetsSchema.parse({ execution: { retries: 3 } })).toThrow();
    expect(() => workforceBudgetsSchema.parse({ departments: { growth: { spend: 1 } } })).toThrow();
  });

  it('rejects non-positive ceilings and non-integer turn counts', () => {
    expect(() => workforceBudgetsSchema.parse({ workforce: { usd: 0 } })).toThrow();
    expect(() => workforceBudgetsSchema.parse({ task: { turns: 1.5 } })).toThrow();
    expect(() => workforceBudgetsSchema.parse({ delegation: { maxDepth: -1 } })).toThrow();
  });

  it('defaults every window to daily', () => {
    const parsed = workforceBudgetsSchema.parse({
      workforce: { usd: 5 },
      departments: { growth: { usd: 2 } },
      execution: { estimateUsdPerTurn: 0.05 },
    });
    expect(parsed.workforce?.window).toBe('daily');
    expect(parsed.departments?.growth?.window).toBe('daily');
  });

  it('a usd ceiling without a positive per-turn estimate is refused (the ceiling would never bite)', () => {
    expect(() => workforceBudgetsSchema.parse({ workforce: { usd: 5 } })).toThrow();
    expect(() => workforceBudgetsSchema.parse({ departments: { growth: { usd: 2 } } })).toThrow();
    expect(() =>
      workforceBudgetsSchema.parse({ task: { usd: 1 }, execution: { estimateUsdPerTurn: 0 } }),
    ).toThrow();
    // Turn-count ceilings alone need no estimate — they meter turns, not dollars.
    expect(() => workforceBudgetsSchema.parse({ task: { turns: 3 } })).not.toThrow();
  });
});

describe('resolveWorkforceBudgets', () => {
  it('treats a null/absent stored value as the empty declaration', () => {
    expect(resolveWorkforceBudgets(null, 'wf').execution.onBudgetExhausted).toBe('block');
  });

  it('a stored declaration outside the schema is a typed refusal, never a guess', () => {
    expect(() => resolveWorkforceBudgets({ workforce: { usd: 'lots' } }, 'wf')).toThrow(
      WorkforceBudgetsInvalidError,
    );
  });
});

describe('windowStartFor', () => {
  const now = new Date('2026-08-14T13:37:42.123Z'); // a Friday

  it('truncates to the UTC hour / day / Monday-of-week', () => {
    expect(windowStartFor('hourly', now).toISOString()).toBe('2026-08-14T13:00:00.000Z');
    expect(windowStartFor('daily', now).toISOString()).toBe('2026-08-14T00:00:00.000Z');
    expect(windowStartFor('weekly', now).toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('a Sunday belongs to the week of the preceding Monday', () => {
    expect(windowStartFor('weekly', new Date('2026-08-16T02:00:00Z')).toISOString()).toBe(
      '2026-08-10T00:00:00.000Z',
    );
  });
});

describe('ledgerScopesFor', () => {
  const budgets = workforceBudgetsSchema.parse({
    workforce: { usd: 40, turns: 100 },
    task: { usd: 2.5, turns: 12 },
    subtree: { usd: 10 },
    departments: { growth: { usd: 12 } },
    execution: { estimateUsdPerTurn: 0.1 },
  });
  const now = new Date('2026-08-14T13:00:00Z');

  it('derives task < root < department < workforce, in the canonical lock order', () => {
    const scopes = ledgerScopesFor(
      {
        taskId: 't1',
        rootTaskId: 'r1',
        workforceId: 'wf',
        department: 'growth',
        estimateUsd: 0.1,
      },
      budgets,
      now,
    );
    expect(scopes.map((s) => s.scopeKind)).toEqual(['task', 'root', 'department', 'workforce']);
    expect(scopes[0]).toMatchObject({ scopeId: 't1', ceilingUsd: 2.5, ceilingTurns: 12 });
    expect(scopes[1]).toMatchObject({ scopeId: 'r1', ceilingUsd: 10, ceilingTurns: null });
    expect(scopes[2]).toMatchObject({ scopeId: 'growth', ceilingUsd: 12 });
    expect(scopes[3]).toMatchObject({ scopeId: 'wf', ceilingUsd: 40, ceilingTurns: 100 });
  });

  it('un-windowed scopes carry the epoch sentinel; windowed scopes carry their UTC bucket', () => {
    const scopes = ledgerScopesFor(
      { taskId: 't1', rootTaskId: 'r1', workforceId: 'wf', department: null, estimateUsd: 0 },
      budgets,
      now,
    );
    expect(scopes[0]?.windowStart).toEqual(EPOCH_WINDOW_START);
    expect(scopes[1]?.windowStart).toEqual(EPOCH_WINDOW_START);
    expect(scopes[2]?.windowStart.toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });

  it('a bare platform task (no workforce, no department) draws from task + root only', () => {
    const scopes = ledgerScopesFor(
      { taskId: 't1', rootTaskId: 'r1', workforceId: null, department: null, estimateUsd: 0 },
      budgets,
      now,
    );
    expect(scopes.map((s) => s.scopeKind)).toEqual(['task', 'root']);
  });

  it('an undeclared department still gets a ledger row (visibility), just no ceiling', () => {
    const scopes = ledgerScopesFor(
      { taskId: 't1', rootTaskId: 'r1', workforceId: 'wf', department: 'ops', estimateUsd: 0 },
      budgets,
      now,
    );
    const dep = scopes.find((s) => s.scopeKind === 'department');
    expect(dep).toMatchObject({ scopeId: 'ops', ceilingUsd: null, ceilingTurns: null });
  });
});
