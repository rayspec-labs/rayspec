/**
 * The spec→engine budgets DRIFT LOCK. The spec package derives a structural twin of this engine's
 * declared-budgets shape (it cannot import this package — the dependency edge runs the other way),
 * so this test closes the loop from THIS side: a maximal declared section derives an object the
 * engine's STRICT schema parses, with a positive per-turn estimate wherever a usd ceiling exists —
 * the engine's own coherence refusal can therefore never fire on a derived object.
 */
import { deriveWorkforceBudgets, WorkforceSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { workforceBudgetsSchema } from './budget.js';

describe('spec-derived budgets parse under the engine schema (drift lock)', () => {
  it('a maximal declared section round-trips strictly with a derived positive estimate', () => {
    const declared = WorkforceSpec.parse({
      id: 'wf',
      name: 'WF',
      orchestrator: 'lead',
      budgets: {
        workforce: { usd: 40, window: 'daily' },
        task: { usd: 2.5, turns: 12 },
        delegation: { maxDepth: 4, maxPerTask: 12 },
      },
      execution: {
        maxConcurrentWorkers: 6,
        maxTaskWallClock: '45m',
        maxReviewRounds: 2,
        onBudgetExhausted: 'block_and_escalate',
      },
      departments: [
        {
          id: 'eng',
          name: 'Engineering',
          manager: 'mgr',
          mission: 'Own it.',
          members: ['dev'],
          budgets: { usd: 15, window: 'daily', maxConcurrentWorkers: 2 },
        },
      ],
      employees: [
        { id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' },
        {
          id: 'mgr',
          agent: 'a',
          title: 'M',
          department: 'eng',
          reportsTo: 'lead',
          role: 'manager',
        },
        { id: 'dev', agent: 'a', title: 'D', department: 'eng', role: 'worker' },
      ],
    });
    const parsed = workforceBudgetsSchema.parse(deriveWorkforceBudgets(declared));
    expect(parsed.execution.estimateUsdPerTurn).toBeGreaterThan(0);
    expect(parsed.workforce?.usd).toBe(40);
    expect(parsed.departments?.eng?.maxConcurrentWorkers).toBe(2);
    expect(parsed.execution.maxTaskWallClockMs).toBe(2_700_000);
  });

  it('an undeclared budgets section parses as the engine defaults (nothing invented)', () => {
    const declared = WorkforceSpec.parse({
      id: 'wf',
      name: 'WF',
      orchestrator: 'lead',
      employees: [{ id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' }],
    });
    const parsed = workforceBudgetsSchema.parse(deriveWorkforceBudgets(declared));
    expect(parsed.workforce).toBeUndefined();
    expect(parsed.execution.onBudgetExhausted).toBe('block');
    expect(parsed.execution.estimateUsdPerTurn).toBe(0);
  });
});
