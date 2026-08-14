/**
 * The workforce boot wiring against real Postgres: the REDEPLOY GATE (live non-terminal state
 * pins the declarations it references; pure additions always deploy) and the derived-budget
 * persistence onto the runtime row. Uses the task engine's own test schema helpers — the gate
 * reads exactly the rows the engine writes.
 */
import { WorkforceSpec } from '@rayspec/spec';
import { createRootTask, resolveWorkforceBudgets } from '@rayspec/tasks';
import { forTenant, makeTestDb, resetTaskSchema } from '@rayspec/tasks/test-support';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertWorkforceSpecCompatible,
  ensureDeclaredWorkforceRuntime,
  parseDelegatedTo,
  WorkforceSpecChangeError,
} from './workforce-boot.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'workforce-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip.',
  );
}

const TENANT = '00000000-0000-4000-8000-0000000000b1';

const DECLARED = WorkforceSpec.parse({
  id: 'helpdesk',
  name: 'Helpdesk',
  orchestrator: 'lead',
  budgets: {
    workforce: { usd: 40 },
    task: { usd: 2.5, turns: 12 },
  },
  execution: { maxTaskWallClock: '45m' },
  departments: [
    {
      id: 'eng',
      name: 'Engineering',
      manager: 'mgr',
      mission: 'Own it.',
      members: ['dev'],
      budgets: { usd: 10 },
    },
  ],
  employees: [
    { id: 'lead', agent: 'a', title: 'Lead', role: 'orchestrator' },
    { id: 'mgr', agent: 'a', title: 'M', department: 'eng', reportsTo: 'lead', role: 'manager' },
    { id: 'dev', agent: 'a', title: 'D', department: 'eng', role: 'worker' },
  ],
  teams: [{ id: 'fix_team', lead: 'mgr', members: ['dev'], maxSize: 2 }],
});

describe.skipIf(!hasDb)('workforce boot wiring (db)', () => {
  // The task engine's dedicated test schema (its DDL mirrors the committed migration).
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
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals, workforce_delegations, workforce_approvals, workforce_reviews, workforce_messages, workforce_budget_ledger, workforce_runtime, run_events CASCADE;',
    );
    await db.$client.unsafe(
      `INSERT INTO orgs (id, name) VALUES ('${TENANT}', 'boot-test') ON CONFLICT DO NOTHING;`,
    );
  });

  const tdb = () => forTenant(db, TENANT);

  it('an empty database (the first deploy) passes trivially', async () => {
    await expect(assertWorkforceSpecCompatible(tdb(), DECLARED)).resolves.toBeUndefined();
  });

  it('pure additions always deploy — live tasks on still-declared owners never refuse', async () => {
    await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Live work',
      goal: 'G',
      owner: 'dev',
      requestedBy: 'user',
      department: 'eng',
    });
    await expect(assertWorkforceSpecCompatible(tdb(), DECLARED)).resolves.toBeUndefined();
  });

  it('refuses a redeploy that removes an employee with a non-terminal task, naming the task ids', async () => {
    const task = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Live work',
      goal: 'G',
      owner: 'dev',
      requestedBy: 'user',
      department: 'eng',
    });
    const withoutDev = WorkforceSpec.parse({
      ...JSON.parse(JSON.stringify(DECLARED)),
      employees: DECLARED.employees.filter((e) => e.id !== 'dev'),
      departments: [{ ...DECLARED.departments[0], members: [] }],
      teams: [{ id: 'fix_team', lead: 'mgr', members: ['mgr'], maxSize: 2 }],
    });
    const refusal = assertWorkforceSpecCompatible(tdb(), withoutDev);
    await expect(refusal).rejects.toBeInstanceOf(WorkforceSpecChangeError);
    await expect(refusal).rejects.toMatchObject({ taskIds: [task.taskId] });
    await expect(assertWorkforceSpecCompatible(tdb(), withoutDev)).rejects.toThrow(task.taskId);
  });

  describe('the WHOLE workforce is a declaration too — the maximal removal is checked', () => {
    async function liveTask(workforceId: string) {
      return createRootTask(tdb(), {
        workforceId,
        title: 'Live work',
        goal: 'G',
        owner: 'dev',
        requestedBy: 'user',
        department: 'eng',
      });
    }

    it('refuses a redeploy that drops the workforce section while live work runs under it', async () => {
      const task = await liveTask('helpdesk');
      // Removing ONE employee refuses; removing every employee, every department and every team at
      // once is the same removal, maximal — and it used to skip the gate entirely, because a gate
      // that only runs when a workforce is declared cannot see a workforce that no longer is.
      const refusal = assertWorkforceSpecCompatible(tdb(), undefined);
      await expect(refusal).rejects.toBeInstanceOf(WorkforceSpecChangeError);
      await expect(refusal).rejects.toMatchObject({ taskIds: [task.taskId] });
      await expect(assertWorkforceSpecCompatible(tdb(), undefined)).rejects.toThrow('helpdesk');
    });

    it('refuses a redeploy that RENAMES the workforce id out from under live work', async () => {
      const task = await liveTask('helpdesk');
      // Every gate query filtered on the NEW id, so a rename matched zero rows and passed
      // trivially — while the live tasks kept dispatching under the old id, against a runtime row
      // nothing would ever refresh again.
      const renamed = WorkforceSpec.parse({
        ...JSON.parse(JSON.stringify(DECLARED)),
        id: 'helpdesk_v2',
      });
      const refusal = assertWorkforceSpecCompatible(tdb(), renamed);
      await expect(refusal).rejects.toBeInstanceOf(WorkforceSpecChangeError);
      await expect(refusal).rejects.toMatchObject({ taskIds: [task.taskId] });
      await expect(assertWorkforceSpecCompatible(tdb(), renamed)).rejects.toThrow(
        "workforce 'helpdesk'",
      );
    });

    it('a workforce-free document with no live workforce work deploys, as it always has', async () => {
      // A bare platform task carries no workforce id and is not a workforce declaration.
      await createRootTask(tdb(), {
        title: 'Bare platform task',
        goal: 'G',
        owner: 'user',
        requestedBy: 'user',
      });
      await expect(assertWorkforceSpecCompatible(tdb(), undefined)).resolves.toBeUndefined();
    });

    it('terminal work under a departed workforce id never refuses', async () => {
      const done = await liveTask('helpdesk');
      await db.$client.unsafe(
        `UPDATE workforce_tasks SET status = 'completed' WHERE task_id = '${done.taskId}';`,
      );
      await expect(assertWorkforceSpecCompatible(tdb(), undefined)).resolves.toBeUndefined();
      const renamed = WorkforceSpec.parse({
        ...JSON.parse(JSON.stringify(DECLARED)),
        id: 'helpdesk_v2',
      });
      await expect(assertWorkforceSpecCompatible(tdb(), renamed)).resolves.toBeUndefined();
    });
  });

  it("terminal tasks referencing removed owners do not refuse, and 'user'-owned tasks never do", async () => {
    const done = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Finished work',
      goal: 'G',
      owner: 'departed',
      requestedBy: 'user',
    });
    await db.$client.unsafe(
      `UPDATE workforce_tasks SET status = 'completed' WHERE task_id = '${done.taskId}';`,
    );
    await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Human-owned',
      goal: 'G',
      owner: 'user',
      requestedBy: 'user',
    });
    await expect(assertWorkforceSpecCompatible(tdb(), DECLARED)).resolves.toBeUndefined();
  });

  it('refuses a redeploy that removes a team referenced by a live delegation target', async () => {
    const parent = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Parent',
      goal: 'G',
      owner: 'lead',
      requestedBy: 'user',
    });
    const child = await createRootTask(tdb(), {
      workforceId: 'helpdesk',
      title: 'Team-carried',
      goal: 'G',
      owner: 'mgr',
      requestedBy: 'lead',
    });
    await db.$client.unsafe(
      `INSERT INTO workforce_delegations (tenant_id, workforce_id, parent_task_id, child_task_id, delegated_by, delegated_to, resolved_owner, goal, expected_output, depth, status)
       VALUES ('${TENANT}', 'helpdesk', '${parent.taskId}', '${child.taskId}', 'lead', 'team:fix_team', 'mgr', 'G', 'worker_result', 1, 'accepted');`,
    );
    const withoutTeam = WorkforceSpec.parse({
      ...JSON.parse(JSON.stringify(DECLARED)),
      teams: [],
    });
    await expect(assertWorkforceSpecCompatible(tdb(), withoutTeam)).rejects.toBeInstanceOf(
      WorkforceSpecChangeError,
    );
    // The same declaration WITH the team stays deployable.
    await expect(assertWorkforceSpecCompatible(tdb(), DECLARED)).resolves.toBeUndefined();
  });

  it('boot persists the declared budgets onto workforce_runtime and the engine parses them back', async () => {
    await ensureDeclaredWorkforceRuntime(tdb(), DECLARED);
    const rows = (await db.$client.unsafe(
      `SELECT budgets FROM workforce_runtime WHERE workforce_id = 'helpdesk';`,
    )) as unknown as { budgets: Record<string, unknown> }[];
    expect(rows).toHaveLength(1);
    const resolved = resolveWorkforceBudgets(rows[0]?.budgets, 'helpdesk');
    expect(resolved.workforce?.usd).toBe(40);
    expect(resolved.execution.estimateUsdPerTurn).toBeCloseTo(2.5 / 12, 10);
    expect(resolved.execution.maxTaskWallClockMs).toBe(2_700_000);
    expect(resolved.departments?.eng?.usd).toBe(10);
  });
});

describe('the delegated_to parser', () => {
  it('parses the three prefixes and treats a bare value as an employee id', () => {
    expect(parseDelegatedTo('employee:dev')).toEqual({ kind: 'employee', id: 'dev' });
    expect(parseDelegatedTo('department:eng')).toEqual({ kind: 'department', id: 'eng' });
    expect(parseDelegatedTo('team:fix_team')).toEqual({ kind: 'team', id: 'fix_team' });
    expect(parseDelegatedTo('dev')).toEqual({ kind: 'employee', id: 'dev' });
  });
});
