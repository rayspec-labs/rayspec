/**
 * `pauseWorkforce`'s DRAIN against real Postgres — the two properties an operator's `pause --drain`
 * is worth nothing without, and which nothing else in the tree pinned:
 *
 *   - a drain that CANNOT finish fails LOUD and FAIL-CLOSED: it rejects with the typed
 *     `WorkforceDrainTimeoutError` carrying the count it still saw, and the pause it already
 *     committed STAYS IN FORCE. The flag write and the drain are deliberately separate
 *     transactions, so a timing-out drain must never look like a rolled-back pause — an operator
 *     whose drain timed out has to be able to re-issue it, or wait, against a workforce that is
 *     still not reserving.
 *   - a drain over a GENUINELY QUIET workforce returns on its FIRST read and never sleeps. Proven
 *     deterministically rather than by a stopwatch: with `drainTimeoutMs: 0` the deadline is
 *     already past on entry, so a poll loop that slept, retried, or consulted the deadline before
 *     the count would reject. It resolves — which is only possible if the zero-work read short
 *     circuits before any wait. That is the load-independent statement of "no hang, no busy-wait";
 *     a wall-clock bound would only measure the host.
 *
 * The dispatched-but-unclaimed half of the drain story (B-015e) lives where its enforcement does —
 * `@rayspec/durable-dbos` task-scheduler.db.test.ts, because the refusal is in the claim
 * transaction, which is the only writer of `status = 'working'`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyTransition } from './apply-transition.js';
import { pauseWorkforce, WorkforceDrainTimeoutError } from './control.js';
import { createRootTask } from './create-task.js';
import { ensureWorkforceRuntime } from './runtime.js';
import {
  forTenant,
  makeTestDb,
  resetTaskSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'control.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip a correctness-load-bearing suite.',
  );
}

describe.skipIf(!hasDb)('pauseWorkforce drain (db)', () => {
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
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals, workforce_runtime, run_events CASCADE;',
    );
    await seedOrgs(db);
  });

  const tdb = () => forTenant(db, TENANT_A);

  async function pausedFlag(workforceId: string): Promise<boolean> {
    const rows = await db.$client.unsafe(
      `SELECT paused FROM workforce_runtime WHERE workforce_id = '${workforceId}';`,
    );
    return (rows[0] as { paused: boolean } | undefined)?.paused === true;
  }

  /** A root task driven to `working` by hand — the drain's only unit of account. */
  async function workingTask(workforceId: string): Promise<string> {
    const root = await createRootTask(tdb(), {
      workforceId,
      title: 'Summarize the intake queue',
      goal: 'Produce a summary of the open intake items.',
      owner: 'user',
      requestedBy: 'user',
    });
    const queued = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await applyTransition(tdb(), {
      taskId: queued.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: 'drain-suite-claim',
    });
    return root.taskId;
  }

  it('a drain that times out rejects TYPED — and leaves the pause it already committed IN FORCE', async () => {
    await workingTask('wf-stuck');

    const err = await pauseWorkforce(tdb(), {
      workforceId: 'wf-stuck',
      actor: 'operator',
      drain: true,
      drainTimeoutMs: 300,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err, 'a drain over a working task must not resolve').toBeInstanceOf(
      WorkforceDrainTimeoutError,
    );
    const typed = err as WorkforceDrainTimeoutError;
    expect(typed.name).toBe('WorkforceDrainTimeoutError');
    expect(typed.workforceId).toBe('wf-stuck');
    expect(typed.stillWorking).toBe(1);

    // FAIL-CLOSED, and the half that actually matters at 2am: the rejection is about the DRAIN,
    // never about the pause. Nothing reserves for this workforce, and a re-issued drain starts
    // from a workforce that is already stopped.
    expect(await pausedFlag('wf-stuck'), 'a timed-out drain must leave paused = true').toBe(true);
    const paused = await db.$client.unsafe(
      "SELECT count(*)::int AS c FROM run_events WHERE run_id = 'workforce:wf-stuck' AND type = 'workforce.control.paused';",
    );
    expect(paused[0]?.c, 'the pause event is journaled once, before the drain ever polls').toBe(1);
  });

  it('a genuinely quiet drain returns on its FIRST read — it never sleeps and never waits out a deadline', async () => {
    await ensureWorkforceRuntime(tdb(), 'wf-quiet');
    // A task that is NOT working: present, so the count query has rows to reject, and queued, so
    // the assertion is about `working` specifically rather than about an empty table.
    const root = await createRootTask(tdb(), {
      workforceId: 'wf-quiet',
      title: 'Draft the release note',
      goal: 'Write the release note for the next tag.',
      owner: 'user',
      requestedBy: 'user',
    });
    await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });

    // `drainTimeoutMs: 0` puts the deadline in the past before the loop starts. A drain that
    // slept, that polled twice, or that checked the deadline before the count would reject here.
    const runtime = await pauseWorkforce(tdb(), {
      workforceId: 'wf-quiet',
      actor: 'operator',
      drain: true,
      drainTimeoutMs: 0,
    });

    expect(runtime.paused).toBe(true);
    expect(await pausedFlag('wf-quiet')).toBe(true);
    // …and a quiet drain moved nothing: the queued task is still queued.
    const rows = await db.$client.unsafe(
      `SELECT status FROM workforce_tasks WHERE task_id = '${root.taskId}';`,
    );
    expect((rows[0] as { status: string }).status).toBe('queued');
  });
});
