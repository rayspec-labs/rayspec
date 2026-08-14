/**
 * The task dispatcher over a REAL DBOS engine + real Postgres — the dispatch law's whole invariant
 * on durable artifacts:
 *
 *   - a queued task is dispatched as its own workflow, claimed exactly once, and finished through
 *     the receipt-guarded application (racing passes dedupe at the workflow id — no double turn);
 *   - a fan-out runs each child as its OWN workflow and the join wakes the parent whose next turn
 *     receives the results keyed by child id;
 *   - a SATURATED concurrency cap leaves tasks `queued` and transitions NOTHING (no ledger row, no
 *     event, no version move) — a queue, not a state;
 *   - a denied budget parks the task blocked(budget_exhausted) with the exceedance journaled and
 *     NO reservation leaked, and a raised ceiling + budget_raised signal resumes it (the
 *     version-salted workflow id makes the re-dispatch a FRESH claim);
 *   - a PAUSED workforce accrues zero cost — its tasks stay visibly queued;
 *   - halt DRAINS first: an in-flight turn ends on its own terms, then the parked remainder
 *     cancels root-first.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { forTenant } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import {
  applyTransition,
  createRootTask,
  deliverSignal,
  ensureWorkforceRuntime,
  haltWorkforce,
  type MergedChildResult,
  pauseWorkforce,
  resumeWorkforce,
} from '@rayspec/tasks';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbosDurableExecutor, type DbosExecutorDeps } from './executor.js';
import {
  DbosTaskScheduler,
  type TaskTurnContext,
  type TaskTurnHandler,
  taskTurnWorkflowId,
} from './task-scheduler.js';
import { buildSpineSchemaSql, buildWorkforceSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

// File-unique (pid-suffixed) names so a parallel fork of another file can never collide on the
// same sys DB / app schema (the cross-file false-green hazard the cron suite fixed).
const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_tasks_${PID}`;
const DBOS_SYS_DB = `rayspec_dbos_tasks_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000aa';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'task-scheduler.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a correctness-load-bearing suite.',
  );
}

// A schedule that never fires inside a test run (Jan 1 midnight) — the suite drives every pass
// DETERMINISTICALLY through runReservePass()/runSweep(); the scheduled ticks are registration-only.
const NEVER = '0 0 0 1 1 *';

let db: ReturnType<typeof makeDbWithSchema>;
let executor: DbosDurableExecutor;
let scheduler: DbosTaskScheduler;
let appBaseUrl = '';
let deadWorkflow: () => Promise<void>;

/** owner -> handler; workers resolve by prefix so fan-out specs need no per-test registration. */
const handlers = new Map<string, TaskTurnHandler>();
const workerHandler: TaskTurnHandler = async (ctx) => ({
  intent: {
    kind: 'complete',
    result: { status: 'completed', summary: `worker ${ctx.task.owner} done`, confidence: 0.9 },
  },
});

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function dropSysDbSafely(baseUrl: string, sysDb: string): Promise<void> {
  const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${sysDb}"`);
        return;
      } catch (e) {
        if (attempt === 5) throw e;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  } finally {
    await admin.end();
  }
}

const tdb = () => forTenant(db, TENANT);

async function taskRow(taskId: string): Promise<Record<string, unknown>> {
  const rows = await db.$client.unsafe(
    `SELECT * FROM workforce_tasks WHERE task_id = '${taskId}';`,
  );
  return rows[0] as Record<string, unknown>;
}

/** What the task's OWN ledger scope currently holds reserved (0 when it has no row yet). */
async function reservedUsd(taskId: string): Promise<number> {
  const rows = await db.$client.unsafe(
    `SELECT reserved_usd FROM workforce_budget_ledger WHERE scope_kind = 'task' AND scope_id = '${taskId}';`,
  );
  return Number(rows[0]?.reserved_usd ?? 0);
}

/** Pump reserve passes until the predicate holds (the deterministic stand-in for the cron tick). */
async function pumpUntil(predicate: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await scheduler.runReservePass();
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not reached within ${ms}ms`);
}

async function newRoot(owner: string, over: Record<string, unknown> = {}) {
  return createRootTask(tdb(), {
    workforceId: 'wf',
    title: `${owner} root`,
    goal: 'Drive the dispatcher.',
    owner,
    requestedBy: 'user',
    ...over,
  });
}

describe.skipIf(!hasDb)('DBOS task dispatcher — exactly-once turns over the shared engine', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    appBaseUrl = url;
    await dropSysDbSafely(url, DBOS_SYS_DB);

    db = makeDbWithSchema(url, APP_SCHEMA);
    await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
    await db.$client.unsafe(buildWorkforceSchemaSql(APP_SCHEMA));
    await db.$client.unsafe(
      `INSERT INTO orgs (id, name, slug) VALUES ('${TENANT}', 'tasks', 'tasks')`,
    );

    const deps: DbosExecutorDeps = {
      db,
      resolveRun: () => {
        throw new Error('this suite dispatches no agent runs');
      },
    };
    executor = new DbosDurableExecutor(deps, {
      name: `rayspec-tasks-${PID}`,
      systemDatabaseUrl: withDbName(url, DBOS_SYS_DB),
    });
    scheduler = new DbosTaskScheduler({
      db,
      tenantId: TENANT,
      tenantExists: async () => true,
      resolveTurnHandler: (owner) =>
        handlers.get(owner) ?? (owner.startsWith('worker-') ? workerHandler : undefined),
      reserveSchedule: NEVER,
      sweepSchedule: NEVER,
    });
    executor.attachPreLaunchHook(() => scheduler.registerScheduledWorkflows());
    executor.attachPreLaunchHook(() => {
      // A workflow that dies without touching any row — the corpse the salted-dispatch test buries
      // under a task's base dispatch id.
      deadWorkflow = DBOS.registerWorkflow(
        async () => {
          throw new Error('synthetic dead turn attempt');
        },
        { name: `test-dead-turn-${PID}` },
      );
    });
    await executor.start();
    await scheduler.registerQueue();
  }, 60_000);

  beforeEach(async () => {
    handlers.clear();
    await db.$client.unsafe(
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_task_signals, workforce_delegations, workforce_approvals, workforce_reviews, workforce_messages, workforce_budget_ledger, workforce_runtime, run_events, idempotency_keys CASCADE',
    );
  });

  afterAll(async () => {
    try {
      await executor.shutdown();
    } finally {
      await db.$client.end();
      await dropSysDbSafely(appBaseUrl, DBOS_SYS_DB);
    }
  }, 30_000);

  it('dispatches a queued task, claims once, applies once — and racing passes cannot double it', async () => {
    handlers.set('solo', async () => ({
      intent: { kind: 'complete', result: { status: 'completed', summary: 'ok', confidence: 1 } },
      actualUsd: 0.05,
    }));
    const root = await newRoot('solo');
    // Two passes RACING (the two-schedulers-one-queue shape: dedup happens at the engine).
    await Promise.all([scheduler.runReservePass(), scheduler.runReservePass()]);
    await pumpUntil(async () => (await taskRow(root.taskId)).status === 'completed');

    const row = await taskRow(root.taskId);
    expect(row.turns_used).toBe(1);
    expect(Number(row.cost_usd)).toBe(0.05);
    const workingClaims = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_transitions WHERE task_id = '${root.taskId}' AND to_status = 'working';`,
    );
    expect(workingClaims[0]?.c).toBe(1);
    const eventTypes = (
      await db.$client.unsafe(
        `SELECT type FROM run_events WHERE run_id = '${root.taskId}' ORDER BY seq::numeric;`,
      )
    ).map((r) => r.type);
    for (const expected of [
      'workforce.task.created',
      'workforce.task.queued',
      'workforce.budget.reserved',
      'workforce.task.turn_started',
      'workforce.budget.settled',
      'workforce.task.turn_ended',
      'workforce.task.completed',
    ]) {
      expect(eventTypes, `journal carries ${expected}`).toContain(expected);
    }
    expect(eventTypes.filter((t) => t === 'workforce.task.turn_started')).toHaveLength(1);
  });

  it('runs the whole fan-out story: children as own workflows, join wakes the parent with keyed results', async () => {
    let secondTurnResults: Readonly<Record<string, MergedChildResult>> | null = null;
    handlers.set('coordinator', async (ctx: TaskTurnContext) => {
      if (ctx.childResults === null) {
        return {
          intent: {
            kind: 'fan_out',
            children: [1, 2, 3, 4].map((i) => ({
              title: `Slice ${i}`,
              goal: `Handle slice ${i}.`,
              owner: `worker-${i}`,
            })),
          },
        };
      }
      secondTurnResults = ctx.childResults;
      return {
        intent: {
          kind: 'complete',
          result: {
            status: 'completed',
            summary: `merged ${Object.keys(ctx.childResults).length} children`,
            confidence: 0.95,
          },
        },
      };
    });
    const root = await newRoot('coordinator');
    await pumpUntil(async () => (await taskRow(root.taskId)).status === 'completed', 30_000);

    const children = await db.$client.unsafe(
      `SELECT task_id, status FROM workforce_tasks WHERE parent_task_id = '${root.taskId}';`,
    );
    expect(children).toHaveLength(4);
    for (const c of children) expect(c.status).toBe('completed');
    expect(secondTurnResults).not.toBeNull();
    expect(Object.keys(secondTurnResults ?? {})).toHaveLength(4);
    for (const c of children) {
      expect(secondTurnResults?.[c.task_id as string]?.status).toBe('completed');
    }
    const joinSignals = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_task_signals WHERE task_id = '${root.taskId}' AND kind = 'child_completed';`,
    );
    expect(joinSignals[0]?.c).toBe(1);
    // Each child claimed under its OWN workflow id (separate workflows, never one shared process).
    const childTurnIds = await db.$client.unsafe(
      `SELECT DISTINCT turn_id FROM workforce_task_transitions WHERE to_status = 'working' AND task_id != '${root.taskId}';`,
    );
    expect(childTurnIds).toHaveLength(4);
  });

  it('a saturated cap leaves tasks queued and transitions NOTHING — no ledger row, no event, no version move', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handlers.set('slow', async () => {
      await gate;
      return {
        intent: { kind: 'complete', result: { status: 'completed', summary: 'ok', confidence: 1 } },
      };
    });
    await ensureWorkforceRuntime(tdb(), 'wf', { execution: { maxConcurrentWorkers: 1 } });
    const first = await newRoot('slow');
    const second = await newRoot('slow');
    const third = await newRoot('slow');

    await pumpUntil(async () => (await taskRow(first.taskId)).status === 'working');
    const before = await Promise.all([taskRow(second.taskId), taskRow(third.taskId)]);
    const saturatedPass = await scheduler.runReservePass();
    expect(saturatedPass.saturated).toBeGreaterThanOrEqual(2);
    const after = await Promise.all([taskRow(second.taskId), taskRow(third.taskId)]);
    for (const [i, row] of after.entries()) {
      expect(row.status).toBe('queued');
      expect(row.version).toBe((before[i] as { version: number }).version); // no transition at all
    }
    const ledgerRows = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM workforce_budget_ledger WHERE scope_id IN ('${second.taskId}', '${third.taskId}');`,
    );
    expect(ledgerRows[0]?.c).toBe(0);

    release();
    await pumpUntil(async () => {
      const rows = await db.$client.unsafe(
        "SELECT count(*)::int AS c FROM workforce_tasks WHERE status = 'completed';",
      );
      return (rows[0] as { c: number }).c === 3;
    }, 30_000);
  });

  it('a denied dispatch parks blocked(budget_exhausted) with no leaked reservation; budget_raised resumes it', async () => {
    handlers.set('solo', async () => ({
      intent: { kind: 'complete', result: { status: 'completed', summary: 'ok', confidence: 1 } },
    }));
    await ensureWorkforceRuntime(tdb(), 'wf', {
      workforce: { usd: 0.5 },
      execution: { estimateUsdPerTurn: 1 },
    });
    const root = await newRoot('solo');
    await pumpUntil(async () => (await taskRow(root.taskId)).status === 'blocked');
    const parked = await taskRow(root.taskId);
    expect(parked.status_reason).toBe('budget_exhausted');
    const exceeded = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${root.taskId}' AND type = 'workforce.budget.exceeded';`,
    );
    expect(exceeded[0]?.c).toBe(1);
    // The denied claim rolled back whole: nothing reserved, nothing settled, no turn consumed.
    const ledger = await db.$client.unsafe(
      'SELECT count(*)::int AS c FROM workforce_budget_ledger;',
    );
    expect(ledger[0]?.c).toBe(0);

    // Raise the ceiling, signal budget_raised — the task re-queues and a FRESH claim completes it.
    await ensureWorkforceRuntime(tdb(), 'wf', {
      workforce: { usd: 10 },
      execution: { estimateUsdPerTurn: 1 },
    });
    await deliverSignal(tdb(), {
      taskId: root.taskId,
      kind: 'budget_raised',
      signalKey: 'raise-1',
      actor: 'user',
    });
    await pumpUntil(async () => (await taskRow(root.taskId)).status === 'completed');
  });

  it('a paused workforce accrues ZERO cost: tasks stay visibly queued; resume loses nothing', async () => {
    handlers.set('solo', async () => ({
      intent: { kind: 'complete', result: { status: 'completed', summary: 'ok', confidence: 1 } },
    }));
    await pauseWorkforce(tdb(), { workforceId: 'wf', actor: 'operator' });
    const a = await newRoot('solo');
    const b = await newRoot('solo');
    for (let i = 0; i < 3; i++) await scheduler.runReservePass();

    for (const t of [a, b]) {
      expect((await taskRow(t.taskId)).status).toBe('queued');
    }
    const spent = await db.$client.unsafe(
      'SELECT count(*)::int AS c FROM workforce_budget_ledger;',
    );
    expect(spent[0]?.c).toBe(0);
    const turnEvents = await db.$client.unsafe(
      "SELECT count(*)::int AS c FROM run_events WHERE type IN ('workforce.task.turn_started', 'workforce.budget.reserved');",
    );
    expect(turnEvents[0]?.c).toBe(0);

    await resumeWorkforce(tdb(), { workforceId: 'wf', actor: 'operator' });
    await pumpUntil(async () => {
      const rows = await db.$client.unsafe(
        "SELECT count(*)::int AS c FROM workforce_tasks WHERE status = 'completed';",
      );
      return (rows[0] as { c: number }).c === 2;
    });
  });

  it('halt drains before it cancels: the in-flight turn ends on its own terms, the parked rest cancels', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handlers.set('slow', async () => {
      await gate;
      return {
        intent: { kind: 'complete', result: { status: 'completed', summary: 'ok', confidence: 1 } },
      };
    });
    // Cap at one worker so exactly one root is in flight and the other is genuinely parked.
    await ensureWorkforceRuntime(tdb(), 'wf', { execution: { maxConcurrentWorkers: 1 } });
    const inFlight = await newRoot('slow');
    const parked = await newRoot('slow');
    await pumpUntil(async () => (await taskRow(inFlight.taskId)).status === 'working');

    const haltPromise = haltWorkforce(tdb(), {
      workforceId: 'wf',
      actor: 'operator',
      reason: 'maintenance window',
      drainTimeoutMs: 20_000,
    });
    // Let the drain observe the working turn, then let the turn END on its own terms.
    await new Promise((r) => setTimeout(r, 400));
    release();
    const outcome = await haltPromise;

    // The in-flight turn was NEVER killed: it completed its own application…
    expect((await taskRow(inFlight.taskId)).status).toBe('completed');
    const turnEnded = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${inFlight.taskId}' AND type = 'workforce.task.turn_ended';`,
    );
    expect(turnEnded[0]?.c).toBe(1);
    // …and only the parked remainder was cancelled, root-first.
    expect((await taskRow(parked.taskId)).status).toBe('cancelled');
    expect(outcome.cancelled).toContain(parked.taskId);
    const halted = await db.$client.unsafe(
      "SELECT count(*)::int AS c FROM run_events WHERE run_id = 'workforce:wf' AND type = 'workforce.control.halted';",
    );
    expect(halted[0]?.c).toBe(1);
    // Reserving is off after a halt; nothing new dispatches until an operator resumes.
    const runtime = await db.$client.unsafe(
      "SELECT paused, halt_reason FROM workforce_runtime WHERE workforce_id = 'wf';",
    );
    expect(runtime[0]).toMatchObject({ paused: true, halt_reason: 'maintenance window' });
  });

  it('the sweep enforces an overdue approval fate end to end through the scheduler seam', async () => {
    handlers.set('asker', async () => ({
      intent: {
        kind: 'request_approval',
        question: 'Proceed with the rollout?',
        timeoutMs: 1,
      },
    }));
    const root = await newRoot('asker');
    await pumpUntil(async () => (await taskRow(root.taskId)).status === 'waiting_for_user');
    await new Promise((r) => setTimeout(r, 10));
    const swept = await scheduler.runSweep();
    expect(swept.failed).toHaveLength(1);
    expect((await taskRow(root.taskId)).status).toBe('failed');
  });

  it('a DEAD prior attempt does not consume the dispatch id forever — the pass salts past it', async () => {
    handlers.set('solo', async () => ({
      intent: { kind: 'complete', result: { status: 'completed', summary: 'ok', confidence: 1 } },
    }));
    const root = await newRoot('solo');
    // Promote by hand so the base dispatch id is known BEFORE any pass runs…
    const queued = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });
    const baseId = taskTurnWorkflowId(root.taskId, 1, queued.version);
    // …then bury a corpse under it: a workflow that ERRORS without ever moving the row (the shape
    // an unexpected throw inside the claim leaves behind).
    const handle = await DBOS.startWorkflow(deadWorkflow, { workflowID: baseId })();
    await expect(handle.getResult()).rejects.toThrow();

    // Before the salted probe, every later pass minted the identical id and deduped into the
    // corpse — the task sat queued forever. The salt walks past it and a fresh claim completes.
    await pumpUntil(async () => (await taskRow(root.taskId)).status === 'completed');
    const claim = await db.$client.unsafe(
      `SELECT turn_id FROM workforce_task_transitions WHERE task_id = '${root.taskId}' AND to_status = 'working';`,
    );
    expect(claim).toHaveLength(1);
    expect(claim[0]?.turn_id).toBe(`${baseId}:r1`);
  });

  it('the sweep reaps a working row whose claimed workflow is dead, and a fresh dispatch finishes it', async () => {
    handlers.set('solo', async () => ({
      intent: { kind: 'complete', result: { status: 'completed', summary: 'ok', confidence: 1 } },
    }));
    const root = await newRoot('solo');
    // Forge the residue a crashed-past-recovery turn leaves: a committed claim (`working`, turnId
    // stamped) whose workflow id the engine has no live record of.
    const queued = await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: root.version,
      to: 'queued',
      actor: 'scheduler',
    });
    await applyTransition(tdb(), {
      taskId: root.taskId,
      expectedVersion: queued.version,
      to: 'working',
      actor: 'scheduler',
      turnId: `wf-task-turn:${root.taskId}:1:dead-attempt`,
    });

    const swept = await scheduler.runSweep();
    expect(swept.reaped).toContain(root.taskId);
    const row = await taskRow(root.taskId);
    expect(row.status).toBe('queued');
    const reQueued = await db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${root.taskId}' AND type = 'workforce.task.queued' AND data->>'queueReason' = 'turn_reaped';`,
    );
    expect(reQueued[0]?.c).toBe(1);
    // The reclaimed slot is real: the next passes dispatch a fresh turn and the task completes.
    await pumpUntil(async () => (await taskRow(root.taskId)).status === 'completed');
  });

  it('a dependency that FAILS decides the dependent: failed with the typed reason, not parked forever', async () => {
    handlers.set('doomed', async () => ({
      intent: { kind: 'fail', message: 'the prerequisite could not be produced' },
    }));
    handlers.set('waiter', async () => ({
      intent: { kind: 'complete', result: { status: 'completed', summary: 'ok', confidence: 1 } },
    }));
    const prerequisite = await newRoot('doomed');
    const dependent = await newRoot('waiter', { dependencies: [prerequisite.taskId] });

    // The dependent parks on the dependency while the prerequisite runs…
    await pumpUntil(async () => (await taskRow(dependent.taskId)).status === 'blocked');
    expect((await taskRow(dependent.taskId)).status_reason).toBe('awaiting_dependency');
    await pumpUntil(async () => (await taskRow(prerequisite.taskId)).status === 'failed');

    // …and once the prerequisite's outcome is DECIDED, so is the dependent's. Nothing else ever
    // revisits this park, so waiting on a failed dependency is waiting forever.
    await pumpUntil(async () => (await taskRow(dependent.taskId)).status === 'failed');
    const row = await taskRow(dependent.taskId);
    expect(row.status_reason).toBe('dependency_failed');
    const journal = await db.$client.unsafe(
      `SELECT data FROM run_events WHERE run_id = '${dependent.taskId}' AND type = 'workforce.task.dependency_failed';`,
    );
    expect(journal).toHaveLength(1);
    expect((journal[0]?.data as { dependencies: { taskId: string; status: string }[] }).dependencies)
      .toEqual([{ taskId: prerequisite.taskId, status: 'failed' }]);
  });

  it('reaping a REAL claim gives its budget reservation back — nothing is stranded in the ledger', async () => {
    // The turn that dies mid-flight holds the gate; the fresh dispatch after the reap does not.
    let releaseDeadTurn: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseDeadTurn = resolve;
    });
    let dispatches = 0;
    handlers.set('solo', async () => {
      if (++dispatches === 1) await held;
      return {
        intent: { kind: 'complete', result: { status: 'completed', summary: 'ok', confidence: 1 } },
      };
    });
    await ensureWorkforceRuntime(tdb(), 'wf', { execution: { estimateUsdPerTurn: 0.25 } });
    const root = await newRoot('solo');
    await pumpUntil(async () => (await taskRow(root.taskId)).status === 'working');

    // The claim reserved for real, over the canonical scope set.
    expect(await reservedUsd(root.taskId)).toBe(0.25);
    const claim = await db.$client.unsafe(
      `SELECT turn_id FROM workforce_task_transitions WHERE task_id = '${root.taskId}' AND to_status = 'working';`,
    );
    const turnId = claim[0]?.turn_id as string;

    // Kill the claimed workflow: the engine now reports it terminal, which is what the reaper acts
    // on — the turn's final transaction (the only other release) never runs.
    await DBOS.cancelWorkflow(turnId);
    const swept = await scheduler.runSweep();
    expect(swept.reaped).toContain(root.taskId);
    expect((await taskRow(root.taskId)).status).toBe('queued');
    // Before the reap released it, every reap stranded one estimate in a scope that never rolls
    // over — enough of them and the task is denied at a ceiling it has spent nothing against.
    expect(await reservedUsd(root.taskId)).toBe(0);
    const rootScope = await db.$client.unsafe(
      `SELECT reserved_usd FROM workforce_budget_ledger WHERE scope_kind = 'root' AND scope_id = '${root.taskId}';`,
    );
    expect(Number(rootScope[0]?.reserved_usd)).toBe(0);
    // A dispatched turn stays a spent turn: the reap gives back money, never a turn count.
    const turns = await db.$client.unsafe(
      `SELECT settled_turns FROM workforce_budget_ledger WHERE scope_kind = 'task' AND scope_id = '${root.taskId}';`,
    );
    expect(turns[0]?.settled_turns).toBe(1);

    releaseDeadTurn();
    await pumpUntil(async () => (await taskRow(root.taskId)).status === 'completed');
    expect(await reservedUsd(root.taskId)).toBe(0);
  });
});
