/**
 * The pure spec→runtime derivations: the org configuration (with the EFFECTIVE reporting edge) and
 * the engine budgets object (with the DERIVED per-turn estimate). What is absent stays absent —
 * the engine owns its defaults, and a derivation that invented values would be a second budget
 * model.
 */
import { describe, expect, it } from 'vitest';
import { deriveWorkforceBudgets, deriveWorkforceConfig } from './workforce-config.js';
import { WorkforceBudgetWindow, WorkforceSpec } from './workforce-grammar.js';

const FULL = WorkforceSpec.parse({
  id: 'helpdesk',
  name: 'Helpdesk',
  orchestrator: 'lead',
  budgets: {
    workforce: { usd: 40 },
    task: { usd: 2.5, turns: 12 },
  },
  execution: {
    maxConcurrentWorkers: 4,
    maxTaskWallClock: '45m',
    maxReviewRounds: 2,
    onBudgetExhausted: 'block_and_escalate',
    delegation: { maxDepth: 4, maxPerTask: 12 },
  },
  departments: [
    {
      id: 'engineering',
      name: 'Engineering',
      manager: 'mgr',
      mission: 'Own the fixes.',
      members: ['dev'],
      budgets: { usd: 10, window: 'daily' },
      execution: { maxConcurrentWorkers: 2 },
    },
  ],
  employees: [
    { id: 'lead', agent: 'lead_agent', title: 'Lead', role: 'orchestrator' },
    {
      id: 'mgr',
      agent: 'mgr_agent',
      title: 'Manager',
      department: 'engineering',
      reportsTo: 'lead',
      role: 'manager',
    },
    {
      id: 'dev',
      agent: 'dev_agent',
      title: 'Developer',
      department: 'engineering',
      role: 'worker',
      labels: ['production_change', 'public_statement'],
    },
    { id: 'qa', agent: 'qa_agent', title: 'Reviewer', reportsTo: 'lead', role: 'reviewer' },
  ],
  teams: [{ id: 'fix_team', lead: 'mgr', members: ['dev', 'qa'], maxSize: 3 }],
  reviewPolicies: [
    {
      id: 'eng_default',
      appliesTo: { department: 'engineering' },
      reviewer: 'qa',
      requireWhen: { confidenceBelow: 0.75, labels: ['production_change'] },
      onReject: 'rework',
      maxReviewRounds: 2,
    },
  ],
  approvalPolicies: [
    {
      id: 'public_statement',
      requireWhen: { labels: ['public_statement'] },
      approver: 'user',
      timeout: '72h',
      onTimeout: 'escalate',
    },
  ],
});

describe('deriveWorkforceConfig', () => {
  const config = deriveWorkforceConfig(FULL);

  it('derives the effective reportsTo edge (explicit wins; department manager is the fallback)', () => {
    expect(config.employees.get('mgr')?.reportsTo).toBe('lead'); // explicit
    expect(config.employees.get('dev')?.reportsTo).toBe('mgr'); // department-manager fallback
    expect(config.employees.get('lead')?.reportsTo).toBeNull(); // the root
  });

  it('carries roles, departments, teams and labels verbatim', () => {
    expect(config.orchestrator).toBe('lead');
    expect(config.employees.get('dev')).toMatchObject({
      role: 'worker',
      department: 'engineering',
      labels: ['production_change', 'public_statement'],
    });
    expect(config.departments.get('engineering')?.manager).toBe('mgr');
    expect(config.teams.get('fix_team')).toEqual({
      lead: 'mgr',
      members: ['dev', 'qa'],
      maxSize: 3,
    });
  });

  it('review rules land in declaration order in the shared DeclaredReviewRule shape', () => {
    expect(config.reviewPolicies).toEqual([
      {
        id: 'eng_default',
        appliesTo: { department: 'engineering' },
        reviewer: 'qa',
        requireWhen: { confidenceBelow: 0.75, labels: ['production_change'] },
        onReject: 'rework',
        // DECLARED as `maxReviewRounds` (aligned with `execution.maxReviewRounds`); the runtime
        // review BINDING keeps the older `maxRounds` noun, and this derivation is where they meet.
        maxRounds: 2,
      },
    ]);
  });

  it('approval timeouts arrive pre-parsed to milliseconds', () => {
    expect(config.approvalPolicies).toEqual([
      {
        id: 'public_statement',
        labels: ['public_statement'],
        approver: 'user',
        timeoutMs: 72 * 3_600_000,
        onTimeout: 'escalate',
      },
    ]);
  });
});

describe('deriveWorkforceBudgets', () => {
  it('derives estimateUsdPerTurn as task.usd / task.turns', () => {
    const budgets = deriveWorkforceBudgets(FULL);
    expect(budgets.execution?.estimateUsdPerTurn).toBeCloseTo(2.5 / 12, 10);
  });

  it("parses maxTaskWallClock '45m' to 2700000 ms", () => {
    expect(deriveWorkforceBudgets(FULL).execution?.maxTaskWallClockMs).toBe(2_700_000);
  });

  it('collapses departments[].budgets AND departments[].execution into one engine record', () => {
    // Two AUTHORED objects (money vs. worker slots), one engine per-department record — the split
    // is a placement change in the document, not a change to what the engine receives.
    expect(deriveWorkforceBudgets(FULL).departments).toEqual({
      engineering: { usd: 10, window: 'daily', maxConcurrentWorkers: 2 },
    });
  });

  it('a department declaring ONLY execution still reaches the engine record', () => {
    const slotsOnly = WorkforceSpec.parse({
      id: 'wf',
      name: 'WF',
      orchestrator: 'lead',
      departments: [
        {
          id: 'eng',
          name: 'Eng',
          manager: 'lead',
          mission: 'Ship.',
          execution: { maxConcurrentWorkers: 3 },
        },
      ],
      employees: [{ id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' }],
    });
    expect(deriveWorkforceBudgets(slotsOnly).departments).toEqual({
      eng: { maxConcurrentWorkers: 3 },
    });
  });

  it("execution.delegation derives into the engine's own top-level delegation slot", () => {
    // The AUTHORED key moved out of `budgets:`; the ENGINE shape did not move at all.
    expect(deriveWorkforceBudgets(FULL).delegation).toEqual({ maxDepth: 4, maxPerTask: 12 });
  });

  it('omits absent budget tiers rather than defaulting them', () => {
    const minimal = WorkforceSpec.parse({
      id: 'wf',
      name: 'WF',
      orchestrator: 'lead',
      employees: [{ id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' }],
    });
    expect(deriveWorkforceBudgets(minimal)).toEqual({});
  });

  it('the full mapping lands every declared tier', () => {
    expect(deriveWorkforceBudgets(FULL)).toEqual({
      workforce: { usd: 40 },
      task: { usd: 2.5, turns: 12 },
      delegation: { maxDepth: 4, maxPerTask: 12 },
      departments: { engineering: { usd: 10, window: 'daily', maxConcurrentWorkers: 2 } },
      execution: {
        maxConcurrentWorkers: 4,
        maxTaskWallClockMs: 2_700_000,
        maxReviewRounds: 2,
        onBudgetExhausted: 'block_and_escalate',
        estimateUsdPerTurn: 2.5 / 12,
      },
    });
  });
});

describe('window vocabulary drift pin', () => {
  it("the grammar's budget windows equal the engine's calendar windows", () => {
    expect(WorkforceBudgetWindow.options).toEqual(['hourly', 'daily', 'weekly', 'monthly']);
  });
});
