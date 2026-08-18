/**
 * The goal intake against real Postgres — `OrchestrationStrategy`'s production call site driven
 * end to end: submitted goal → plan → durable `planned` rows, with every refusal proven to leave
 * ZERO rows and every reconciliation proven to precede the strategy call.
 */

import type { ExecutionPlan, OrchestrationInput, OrchestrationStrategy } from '@rayspec/core';
import { SEAM_MAX_PLAN_STEPS, SEAM_MAX_STEP_TITLE_CHARS } from '@rayspec/core';
import type { Db } from '@rayspec/db';
import { deriveWorkforceConfig, WorkforceSpec } from '@rayspec/spec';
import { MAX_TASK_DEPENDENCIES, MAX_TASK_TITLE_CHARS } from '@rayspec/tasks';
import { makeTestDb, resetTaskSchema } from '@rayspec/tasks/test-support';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildWorkforceGoalIntake } from './workforce-goal-intake.js';

/**
 * The seam contract kit tells an out-of-tree strategy author what title length is acceptable; the
 * task row is what actually refuses one. The two constants live in packages that cannot import each
 * other, so this pin is what keeps the kit from blessing a plan the engine would then reject. It is
 * here rather than in @rayspec/core because this is the only package that can see both.
 */
describe('the seam kit and the engine agree on the row bounds', () => {
  it('the contract kit’s step-title ceiling IS the engine’s task-title row bound', () => {
    expect(SEAM_MAX_STEP_TITLE_CHARS).toBe(MAX_TASK_TITLE_CHARS);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'workforce-goal-intake.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip.',
  );
}

const TENANT = '00000000-0000-4000-8000-0000000000d1';

const DECLARED = WorkforceSpec.parse({
  id: 'intake_wf',
  name: 'Intake Workforce',
  orchestrator: 'lead',
  departments: [
    { id: 'eng', name: 'Engineering', manager: 'mgr', mission: 'Own it.', members: ['dev'] },
  ],
  employees: [
    { id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' },
    { id: 'mgr', agent: 'a', title: 'M', department: 'eng', reportsTo: 'lead', role: 'manager' },
    { id: 'dev', agent: 'a', title: 'D', department: 'eng', role: 'worker' },
  ],
});
const config = deriveWorkforceConfig(DECLARED);

/** A strategy that records its input and answers a canned plan — the seam under observation. */
function scripted(plan: ExecutionPlan): {
  strategy: OrchestrationStrategy;
  inputs: OrchestrationInput[];
} {
  const inputs: OrchestrationInput[] = [];
  return {
    inputs,
    strategy: {
      id: 'scripted',
      plan: (input) => {
        inputs.push(input);
        return Promise.resolve(plan);
      },
    },
  };
}

describe.skipIf(!hasDb)('the goal intake (db)', () => {
  let db: ReturnType<typeof makeTestDb>;

  beforeAll(async () => {
    db = makeTestDb();
    await resetTaskSchema(db);
    return async () => {
      await db.$client.end();
    };
  });

  beforeEach(async () => {
    await db.$client.unsafe(
      `TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals,
       workforce_delegations, workforce_approvals, workforce_reviews, workforce_messages,
       workforce_budget_ledger, workforce_runtime, run_events CASCADE;
       INSERT INTO orgs (id, name) VALUES ('${TENANT}', 'Intake Org') ON CONFLICT DO NOTHING;`,
    );
  });

  async function taskRows(): Promise<
    Array<{ task_id: string; owner: string; title: string; goal: string; status: string }>
  > {
    return (await db.$client.unsafe(
      'SELECT task_id, owner, title, goal, status, department, dependencies, priority, description, workforce_id, requested_by FROM workforce_tasks ORDER BY created_at, task_id;',
    )) as never;
  }

  function intakeWith(strategy: OrchestrationStrategy) {
    return buildWorkforceGoalIntake({
      db: db as unknown as Db,
      tenantId: TENANT,
      config,
      strategy,
    });
  }

  it('the shipped default hands the whole goal to the declared orchestrator as ONE planned root, journaled', async () => {
    const { SingleTaskPlanStrategy } = await import('@rayspec/core');
    const intake = intakeWith(new SingleTaskPlanStrategy());
    const result = await intake.submitGoal({
      tenantId: TENANT,
      workforceId: 'intake_wf',
      goal: 'Analyze onboarding friction and draft the fix announcement.',
      requestedBy: 'api-key:k1',
      priority: 'high',
      description: 'Requester context for every step.',
    });
    expect(result.outcome).toBe('created');
    const rows = (await taskRows()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'lead',
      status: 'planned',
      goal: 'Analyze onboarding friction and draft the fix announcement.',
      title: 'Analyze onboarding friction and draft the fix announcement.',
      workforce_id: 'intake_wf',
      requested_by: 'api-key:k1',
      priority: 'high',
      description: 'Requester context for every step.',
      department: null,
    });
    const created = await db.$client.unsafe(
      `SELECT type FROM run_events WHERE run_id = '${(rows[0] as { task_id: string }).task_id}';`,
    );
    expect(created.map((r: { type: string }) => r.type)).toContain('workforce.task.created');
  });

  it('a multi-step plan lands atomically as sibling roots with dependsOn mapped onto dependencies and departments derived', async () => {
    const { strategy, inputs } = scripted({
      steps: [
        { title: 'Research', goal: 'Research it.', owner: 'dev', department: null, dependsOn: [] },
        { title: 'Draft', goal: 'Draft it.', owner: 'dev', department: 'eng', dependsOn: [0] },
        { title: 'Merge', goal: 'Merge both.', owner: 'lead', department: null, dependsOn: [0, 1] },
      ],
    });
    const result = await intakeWith(strategy).submitGoal({
      tenantId: TENANT,
      workforceId: 'intake_wf',
      goal: 'The umbrella goal.',
      requestedBy: 'user:u1',
    });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('unreachable');
    expect(result.tasks.map((t) => t.title)).toEqual(['Research', 'Draft', 'Merge']);

    // The strategy saw the verified facts, including the declared orchestrator as defaultOwner.
    expect(inputs).toEqual([
      {
        workforceId: 'intake_wf',
        goal: 'The umbrella goal.',
        requestedBy: 'user:u1',
        defaultOwner: 'lead',
      },
    ]);

    const rows = (await taskRows()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    const byTitle = new Map(rows.map((r) => [r.title as string, r]));
    // A null step department resolves to the OWNER's declared department (ledger attribution).
    expect(byTitle.get('Research')).toMatchObject({ owner: 'dev', department: 'eng' });
    expect(byTitle.get('Draft')).toMatchObject({ owner: 'dev', department: 'eng' });
    expect(byTitle.get('Merge')).toMatchObject({ owner: 'lead', department: null });
    expect(byTitle.get('Draft')?.dependencies).toEqual([byTitle.get('Research')?.task_id]);
    expect(byTitle.get('Merge')?.dependencies).toEqual([
      byTitle.get('Research')?.task_id,
      byTitle.get('Draft')?.task_id,
    ]);
  });

  it('refuses an invalid plan typed, with ZERO rows: undeclared owner, foreign department, bad index', async () => {
    const cases: Array<{ plan: ExecutionPlan; detail: string }> = [
      {
        plan: {
          steps: [{ title: 'X', goal: 'x', owner: 'ghost', department: null, dependsOn: [] }],
        },
        detail: "owner 'ghost'",
      },
      {
        plan: {
          steps: [{ title: 'X', goal: 'x', owner: 'lead', department: 'eng', dependsOn: [] }],
        },
        detail: "books department 'eng'",
      },
      {
        plan: {
          steps: [
            { title: 'A', goal: 'a', owner: 'dev', department: null, dependsOn: [] },
            { title: 'B', goal: 'b', owner: 'dev', department: null, dependsOn: [1] },
          ],
        },
        detail: 'not a PRIOR step',
      },
      { plan: { steps: [] }, detail: 'no steps' },
    ];
    for (const { plan, detail } of cases) {
      const result = await intakeWith(scripted(plan).strategy).submitGoal({
        tenantId: TENANT,
        workforceId: 'intake_wf',
        goal: 'g',
        requestedBy: 'user:u1',
      });
      expect(result.outcome).toBe('invalid_plan');
      if (result.outcome !== 'invalid_plan') throw new Error('unreachable');
      expect(result.detail).toContain(detail);
      expect(result.detail).toContain("strategy 'scripted'");
    }
    expect(await taskRows()).toHaveLength(0); // every refusal preceded the first insert
  });

  /**
   * THE ADVERSARIAL MATRIX. The strategy is out-of-tree code, so every cell here is a plan a hostile
   * or merely broken implementation could return, enumerated so coverage is visible rather than
   * trusted. Each cell must be a typed refusal that leaves ZERO rows — the refusal runs before the
   * first insert and the whole plan is one transaction, so a half-born plan is not a possible
   * outcome to begin with.
   */
  it('refuses every over-reaching plan shape typed, with ZERO rows', async () => {
    const step = (over: Partial<ExecutionPlan['steps'][number]> = {}) => ({
      title: 'A',
      goal: 'a',
      owner: 'dev',
      department: null,
      dependsOn: [],
      ...over,
    });
    const cases: Array<{ label: string; plan: ExecutionPlan; detail: string }> = [
      {
        label: 'a step that depends on ITSELF',
        plan: { steps: [step({ dependsOn: [0] })] },
        detail: 'depends on index 0, which is not a PRIOR step',
      },
      {
        label: 'a FRACTIONAL dependency index',
        plan: { steps: [step(), step({ dependsOn: [0.5] })] },
        detail: 'depends on index 0.5, which is not a PRIOR step',
      },
      {
        label: 'a NEGATIVE dependency index',
        plan: { steps: [step(), step({ dependsOn: [-1] })] },
        detail: 'depends on index -1, which is not a PRIOR step',
      },
      {
        label: 'more dependencies than a row can carry',
        plan: {
          steps: [step(), step({ dependsOn: Array.from({ length: 101 }, () => 0) })],
        },
        detail: `declares 101 dependencies (the row bound is ${MAX_TASK_DEPENDENCIES})`,
      },
      {
        label: 'a title one character past the row bound',
        plan: { steps: [step({ title: 'T'.repeat(MAX_TASK_TITLE_CHARS + 1) })] },
        detail: `outside 1..${MAX_TASK_TITLE_CHARS} characters`,
      },
      {
        label: 'an EMPTY title',
        plan: { steps: [step({ title: '' })] },
        detail: `outside 1..${MAX_TASK_TITLE_CHARS} characters`,
      },
      { label: 'an EMPTY goal', plan: { steps: [step({ goal: '' })] }, detail: 'empty goal' },
      {
        label: 'a step booking a department its owner does not belong to',
        plan: { steps: [step({ owner: 'lead', department: 'eng' })] },
        detail: "books department 'eng'",
      },
      {
        label: 'a step naming an owner the workforce does not declare',
        plan: { steps: [step({ owner: 'ghost' })] },
        detail: "owner 'ghost'",
      },
      {
        label: 'an UNBOUNDED plan — one goal cannot become an unbounded write',
        plan: {
          steps: Array.from({ length: SEAM_MAX_PLAN_STEPS + 1 }, (_v, i) =>
            step({ title: `T${i}`, goal: `g${i}` }),
          ),
        },
        detail: `carries ${SEAM_MAX_PLAN_STEPS + 1} steps (the bound is ${SEAM_MAX_PLAN_STEPS})`,
      },
    ];
    for (const { label, plan, detail } of cases) {
      const result = await intakeWith(scripted(plan).strategy).submitGoal({
        tenantId: TENANT,
        workforceId: 'intake_wf',
        goal: 'g',
        requestedBy: 'user:u1',
      });
      expect(result.outcome, label).toBe('invalid_plan');
      if (result.outcome !== 'invalid_plan') throw new Error('unreachable');
      expect(result.detail, label).toContain(detail);
      expect(result.detail, label).toContain("strategy 'scripted'");
      expect(await taskRows(), label).toHaveLength(0);
    }
  });

  it('a plan AT the step bound is created — the bound refuses excess, not decomposition', async () => {
    const plan: ExecutionPlan = {
      steps: Array.from({ length: SEAM_MAX_PLAN_STEPS }, (_v, i) => ({
        title: `T${i}`,
        goal: `g${i}`,
        owner: 'dev',
        department: null,
        dependsOn: [],
      })),
    };
    const result = await intakeWith(scripted(plan).strategy).submitGoal({
      tenantId: TENANT,
      workforceId: 'intake_wf',
      goal: 'g',
      requestedBy: 'user:u1',
    });
    expect(result.outcome).toBe('created');
    expect(await taskRows()).toHaveLength(SEAM_MAX_PLAN_STEPS);
  });

  it('reconciles tenant and workforce BEFORE the strategy runs: a foreign pair is not_found and plans nothing', async () => {
    const { strategy, inputs } = scripted({ steps: [] });
    const intake = intakeWith(strategy);
    const foreignTenant = await intake.submitGoal({
      tenantId: '00000000-0000-4000-8000-0000000000d2',
      workforceId: 'intake_wf',
      goal: 'g',
      requestedBy: 'user:u1',
    });
    const foreignWorkforce = await intake.submitGoal({
      tenantId: TENANT,
      workforceId: 'someone_else',
      goal: 'g',
      requestedBy: 'user:u1',
    });
    expect(foreignTenant).toEqual({ outcome: 'not_found' });
    expect(foreignWorkforce).toEqual({ outcome: 'not_found' });
    expect(inputs).toHaveLength(0); // the strategy never saw either
    expect(await taskRows()).toHaveLength(0);
  });
});
