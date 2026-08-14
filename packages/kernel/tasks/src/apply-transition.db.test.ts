/**
 * applyTransition against real Postgres — the write protocol's whole invariant, asserted on the
 * durable artifacts (the task row, the transition log, the journal stream), never on fakes:
 *
 *   - a legal transition updates status + version, appends EXACTLY one transition-log row, and
 *     journals the transitioned event (with the lifecycle sibling the target implies);
 *   - a stale expectedVersion is a typed conflict and mutates NOTHING;
 *   - an illegal (from, to) and an off-vocabulary reason are typed refusals that mutate NOTHING;
 *   - two CONCURRENT compare-and-swaps on one version admit exactly one winner (the fail-the-fix
 *     property for double dispatch);
 *   - the tenant predicate holds: tenant B can neither see nor transition tenant A's task.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTransition } from './apply-transition.js';
import { createRootTask } from './create-task.js';
import { TaskNotFoundError, TaskVersionConflictError } from './errors.js';
import { StatusReasonInvalidError, TaskTransitionIllegalError } from './status.js';
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
    'apply-transition.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

describe.skipIf(!hasDb)('applyTransition (db)', () => {
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

  async function seedTask() {
    const tdb = forTenant(db, TENANT_A);
    return createRootTask(tdb, {
      title: 'Summarize the intake queue',
      goal: 'Produce a summary of the open intake items.',
      owner: 'user',
      requestedBy: 'user',
    });
  }

  it('applies a legal transition: status + version move, one log row, journaled before returning', async () => {
    const task = await seedTask();
    const tdb = forTenant(db, TENANT_A);
    const updated = await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'queued',
      actor: 'scheduler',
    });
    expect(updated.status).toBe('queued');
    expect(updated.version).toBe(task.version + 1);
    expect(updated.queuedAt).not.toBeNull();

    const log = await db.$client.unsafe(
      `SELECT from_status, to_status, actor FROM workforce_task_transitions WHERE task_id = '${task.taskId}' ORDER BY created_at;`,
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      from_status: 'planned',
      to_status: 'queued',
      actor: 'scheduler',
    });

    const events = await db.$client.unsafe(
      `SELECT type, seq, data FROM run_events WHERE run_id = '${task.taskId}' ORDER BY seq::numeric;`,
    );
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'workforce.task.created',
      'workforce.task.transitioned',
      'workforce.task.queued',
    ]);
    for (const e of events) expect((e.data as { v: number }).v).toBe(1);
    // The queue event carries its queue reason ('initial' — no signal absorbed it).
    expect((events[2]?.data as { queueReason?: string }).queueReason).toBe('initial');
  });

  it('a terminal transition journals the terminal event with the roll-up payload', async () => {
    const task = await seedTask();
    const tdb = forTenant(db, TENANT_A);
    const queued = await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'queued',
      actor: 'scheduler',
    });
    const working = await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
    });
    expect(working.startedAt).not.toBeNull();
    const done = await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: working.version,
      to: 'completed',
      actor: 'user',
    });
    expect(done.completedAt).not.toBeNull();
    const events = await db.$client.unsafe(
      `SELECT type FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.task.completed';`,
    );
    expect(events).toHaveLength(1);
  });

  it('a stale expectedVersion is a typed conflict and mutates nothing', async () => {
    const task = await seedTask();
    const tdb = forTenant(db, TENANT_A);
    await applyTransition(tdb, {
      taskId: task.taskId,
      expectedVersion: task.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await expect(
      applyTransition(tdb, {
        taskId: task.taskId,
        expectedVersion: task.version, // stale — the queue transition bumped it
        to: 'cancelled',
        reason: 'cancelled_by_user',
        actor: 'user',
      }),
    ).rejects.toThrow(TaskVersionConflictError);
    const rows = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(rows[0]?.status).toBe('queued');
    const log = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_transitions WHERE task_id = '${task.taskId}';`,
    );
    expect(log[0]?.c).toBe(1);
  });

  it('an illegal (from, to) and an off-vocabulary reason are typed refusals that mutate nothing', async () => {
    const task = await seedTask();
    const tdb = forTenant(db, TENANT_A);
    await expect(
      applyTransition(tdb, {
        taskId: task.taskId,
        expectedVersion: task.version,
        to: 'working', // planned -> working is not a cell in the table
        actor: 'scheduler',
      }),
    ).rejects.toThrow(TaskTransitionIllegalError);
    await expect(
      applyTransition(tdb, {
        taskId: task.taskId,
        expectedVersion: task.version,
        to: 'blocked',
        reason: 'model prose, not a reason',
        actor: 'scheduler',
      }),
    ).rejects.toThrow(StatusReasonInvalidError);
    const rows = await db.$client.unsafe(
      `SELECT status, version FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(rows[0]).toMatchObject({ status: 'planned', version: 1 });
  });

  it('an unknown task is a typed TaskNotFoundError', async () => {
    const tdb = forTenant(db, TENANT_A);
    await expect(
      applyTransition(tdb, {
        taskId: '00000000-0000-4000-8000-0000000000ff',
        expectedVersion: 1,
        to: 'queued',
        actor: 'scheduler',
      }),
    ).rejects.toThrow(TaskNotFoundError);
  });

  it('two concurrent compare-and-swaps on one version admit exactly one winner', async () => {
    const task = await seedTask();
    const attempt = () =>
      applyTransition(forTenant(db, TENANT_A), {
        taskId: task.taskId,
        expectedVersion: task.version,
        to: 'queued',
        actor: 'scheduler',
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as PromiseRejectedResult).reason).toBeInstanceOf(TaskVersionConflictError);
    // The whole invariant on the durable artifacts: one status move, one log row, one queue event.
    const log = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_transitions WHERE task_id = '${task.taskId}';`,
    );
    expect(log[0]?.c).toBe(1);
    const queuedEvents = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${task.taskId}' AND type = 'workforce.task.queued';`,
    );
    expect(queuedEvents[0]?.c).toBe(1);
  });

  it('the tenant predicate holds: tenant B cannot see or transition tenant A task', async () => {
    const task = await seedTask();
    const other = forTenant(db, TENANT_B);
    await expect(
      applyTransition(other, {
        taskId: task.taskId,
        expectedVersion: task.version,
        to: 'queued',
        actor: 'scheduler',
      }),
    ).rejects.toThrow(TaskNotFoundError);
    const rows = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${task.taskId}';`,
    );
    expect(rows[0]?.status).toBe('planned');
  });
});
