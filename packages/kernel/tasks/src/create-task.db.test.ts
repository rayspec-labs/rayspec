/**
 * Task creation's DEPENDENCY contract against real Postgres. A declared dependency is the one input
 * that can park a task with nobody left to wake it — nothing revisits `blocked(awaiting_dependency)`
 * except a dependency reaching `completed` — so every id that can never get there is refused HERE:
 *
 *   - an id naming no task under this tenant (including one that belongs to ANOTHER tenant, which
 *     this handle cannot see and must not silently wait on);
 *   - the task's own id;
 *   - a repeated id, which is deduped at parse rather than left as an extra prerequisite the
 *     scheduler's satisfaction check could never count off.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDependenciesResolvable,
  createRootTask,
  createRootTaskInputSchema,
} from './create-task.js';
import { TaskDependenciesInvalidError } from './errors.js';
import { RESERVED_WORKFORCE_SEGMENTS } from './runtime.js';
import {
  forTenant,
  makeTestDb,
  resetTaskSchema,
  seedOrgs,
  TENANT_A,
  TENANT_B,
} from './test-support/test-db.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'create-task.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

describe.skipIf(!hasDb)('task creation dependencies (db)', () => {
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
      'TRUNCATE workforce_tasks, workforce_task_transitions, run_events CASCADE;',
    );
    await seedOrgs(db);
  });

  const tdb = (tenant = TENANT_A) => forTenant(db, tenant);

  async function seedTask(tenant = TENANT_A, title = 'Prerequisite') {
    return createRootTask(tdb(tenant), {
      title,
      goal: 'Be depended upon.',
      owner: 'worker-1',
      requestedBy: 'user',
    });
  }

  function dependent(dependencies: string[]) {
    return createRootTask(tdb(), {
      title: 'Dependent',
      goal: 'Wait for the prerequisites.',
      owner: 'coordinator',
      requestedBy: 'user',
      dependencies,
    });
  }

  it('stores a repeated id ONCE — a duplicate is one prerequisite, not an unsatisfiable count', async () => {
    const a = await seedTask();
    const task = await dependent([a.taskId, a.taskId, a.taskId]);
    expect(task.dependencies).toEqual([a.taskId]);
    const stored = await db.$client.unsafe(
      `SELECT dependencies FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(stored[0]?.dependencies).toEqual([a.taskId]);
  });

  it('refuses an id no task under this tenant carries — and creates nothing', async () => {
    await expect(dependent(['no-such-task'])).rejects.toThrow(TaskDependenciesInvalidError);
    const rows = await db.$client.unsafe(
      "SELECT count(*)::int AS c FROM workforce_tasks WHERE title = 'Dependent';",
    );
    expect(rows[0]?.c).toBe(0);
  });

  it("refuses another tenant's task id — a dependency this handle cannot see is one it cannot wait on", async () => {
    const foreign = await seedTask(TENANT_B, 'Foreign prerequisite');
    await expect(dependent([foreign.taskId])).rejects.toThrow(TaskDependenciesInvalidError);
  });

  it('refuses a self-referential dependency', async () => {
    const task = await seedTask();
    await expect(
      tdb().transaction((tx) => assertDependenciesResolvable(tx, task.taskId, [task.taskId])),
    ).rejects.toThrow(TaskDependenciesInvalidError);
  });

  it('bounds the declared list — an unbounded prerequisite list is an unbounded read', () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `dep-${i}`);
    const parsed = createRootTaskInputSchema.safeParse({
      title: 'Dependent',
      goal: 'g',
      owner: 'coordinator',
      requestedBy: 'user',
      dependencies: tooMany,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a workforce id that is a reserved path segment — an unreachable workforce is not created', async () => {
    for (const reserved of RESERVED_WORKFORCE_SEGMENTS) {
      const parsed = createRootTaskInputSchema.safeParse({
        workforceId: reserved,
        title: 'Shadowed',
        goal: 'g',
        owner: 'coordinator',
        requestedBy: 'user',
      });
      expect(parsed.success, `workforce id '${reserved}' is refused`).toBe(false);
    }
    // The routes refuse these on the `:workforceId` path, so a workforce that carried one could
    // never be paused, resumed, halted or read — it has to be refused where it is MINTED.
    await expect(
      createRootTask(tdb(), {
        workforceId: 'tasks',
        title: 'Shadowed',
        goal: 'Never reachable.',
        owner: 'coordinator',
        requestedBy: 'user',
      }),
    ).rejects.toThrow();
    const rows = await db.$client.unsafe(
      "SELECT count(*)::int AS c FROM workforce_tasks WHERE title = 'Shadowed';",
    );
    expect(rows[0]?.c).toBe(0);
  });

  it('accepts a resolvable list and parks nothing at creation', async () => {
    const a = await seedTask(TENANT_A, 'A');
    const b = await seedTask(TENANT_A, 'B');
    const task = await dependent([a.taskId, b.taskId]);
    expect(task.status).toBe('planned');
    expect(task.dependencies).toEqual([a.taskId, b.taskId]);
  });
});
