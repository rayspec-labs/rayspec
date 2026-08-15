/**
 * The goal intake against real Postgres — `OrchestrationStrategy`'s production call site driven
 * end to end: submitted goal → plan → durable `planned` rows, with every refusal proven to leave
 * ZERO rows and every reconciliation proven to precede the strategy call.
 */

import type { ExecutionPlan, OrchestrationInput, OrchestrationStrategy } from '@rayspec/core';
import type { Db } from '@rayspec/db';
import { deriveWorkforceConfig, WorkforceSpec } from '@rayspec/spec';
import { forTenant, makeTestDb, resetTaskSchema } from '@rayspec/tasks/test-support';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildWorkforceGoalIntake } from './workforce-goal-intake.js';

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
