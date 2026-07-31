/**
 * The WORKER cancellation contract test (DB-backed, REAL DBOS engine).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING PROVEN.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A run can be ended on demand. The clean case is a run that has NOT started: the engine is asked to
 * cancel the workflow before the queue ever dequeues it, and the run's persisted cancellation marker
 * is what makes a DISPATCH refuse to execute it. The marker is OUR OWN record, and it is authoritative
 * for exactly the reason the `run_started` guard is: the engine memoizes step outcomes, not our Drizzle
 * writes, so a dispatch (fresh OR a recovery re-dispatch) must consult it before running anything.
 *
 * RED-FIRST: without the guard in `#runAgentJobBody`, a dispatch of a cancelled run invokes `runAgent`
 * and `liveRuns` reaches 1 — a run the caller ended still burns a model call. With the guard it stays 0.
 *
 * SIMULATING A RECOVERY RE-EXECUTION follows the same honest technique the taint / short-circuit files
 * use: pre-seed the `run_started` marker a first attempt committed (outside the run's own transaction,
 * so it survived the crash) and enqueue under that runId, so the workflow BODY runs, its reserve finds
 * the marker taken, and the recovery branch is what the cancellation gate stands in front of. A guard
 * runs the SAME seeding plus a taint marker and requires the QUARANTINE — the one outcome only the
 * recovery branch produces — so the seeding is load-bearing rather than decorative. The gate also
 * RECORDS what it refuses: seeding the enqueue-time header alongside those markers reproduces the run
 * that was cancelled WHILE EXECUTING and whose worker died before it could unwind — the one case
 * neither side had written down — and the re-dispatch is what makes it terminal. The other
 * fail-the-fix guards prove the gate does not blunt anything else: an uncancelled run still runs, and a
 * cancelled run's marker is tenant-scoped.
 *
 * The harder case is a run ALREADY EXECUTING when it is ended: it holds its header row inside its own
 * transaction, so the cancel surface gives up on the terminal record rather than waiting the run out,
 * and a run that then ends by FAILING rolls back everything that transaction wrote — including any
 * record the run itself made. The executor is what records the outcome once that rollback has happened,
 * and the last two tests are that contract plus the guard that an UNCANCELLED failure still fails.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec } from '@rayspec/core';
import { forTenant, schema } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import {
  insertEnqueuedRunHeader,
  isRunCancelled,
  markRunCancelled,
  RUN_TAINT_SCOPE,
  type RunJob,
  recordRunCancelled,
} from '@rayspec/platform';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DbosDurableExecutor,
  type DbosExecutorDeps,
  type ResolvedRun,
  RUN_STARTED_BODY_HASH,
  RUN_STARTED_SCOPE,
} from './executor.js';
import { FakeSpineBackend } from './test-support/fake-backend.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

// File-unique (pid-suffixed) names + a DISTINCT token from every other DB file so a fork of another
// file can NEVER collide on the same sys DB / app schema (the cross-file false-green hazard).
const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_cancel_${PID}`;
const DBOS_SYS_DB = `rayspec_dbos_cancel_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000ca';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000cb';

const backend = new FakeSpineBackend();

const baseSpec: AgentSpec = {
  name: 'echo',
  instructions: 'echo the input',
  model: 'gpt-4.1-mini',
  input: 'placeholder',
  tools: [],
  maxTurns: 4,
};

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let executor: DbosDurableExecutor;
let dbosSystemUrl: string;
let appBaseUrl: string;

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** Drop a sys DB without FORCE (a FORCE drop can corrupt a still-attached engine's global state). */
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

/** The ran-guard: a skipped file must never read as a green file. */
let testsRan = 0;

/**
 * Pre-seed a `run_started` marker for `runId` — exactly what a first attempt commits before it calls
 * `runAgent`, and what SURVIVES the crash that lost it (the reserve runs outside the run's own
 * transaction). Seeding it is what makes the next dispatch a RECOVERY: the body's started-once reserve
 * finds the marker taken and takes the recovery branch instead of the first-dispatch one.
 */
async function seedRunStarted(runId: string): Promise<void> {
  await forTenant(db, TENANT)
    .insert(schema.idempotencyKeys, {
      scope: RUN_STARTED_SCOPE,
      idemKey: runId,
      bodyHash: RUN_STARTED_BODY_HASH,
      snapshot: { runId },
    })
    .onConflictDoNothing();
}

/** Pre-seed a `run_taint` marker for `runId` (as a crashed-after-non-idempotent-tool run would have). */
async function seedRunTaint(runId: string): Promise<void> {
  await forTenant(db, TENANT)
    .insert(schema.idempotencyKeys, {
      scope: RUN_TAINT_SCOPE,
      idemKey: runId,
      bodyHash: 'run_taint_marker',
      snapshot: { runId },
    })
    .onConflictDoNothing();
}

/** The `runs` header status for `runId` (undefined when there is no header at all). */
async function runHeaderStatus(runId: string): Promise<string | undefined> {
  const rows = (await db.$client.unsafe('SELECT status FROM runs WHERE run_id = $1', [
    runId,
  ])) as unknown as { status: string }[];
  return rows[0]?.status;
}

/** Every journal step recorded for `runId`, in write order. */
async function journalSteps(
  runId: string,
): Promise<Array<{ type: string; status: string; error_class: string | null }>> {
  return (await db.$client.unsafe(
    'SELECT type, status, error_class FROM journal_steps WHERE run_id = $1 ORDER BY created_at',
    [runId],
  )) as unknown as Array<{ type: string; status: string; error_class: string | null }>;
}

/** Poll `predicate` until it holds (bounded) — a deterministic barrier, never a fixed sleep. */
async function waitFor(predicate: () => boolean, capMs = 20_000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`condition did not hold within ${capMs}ms`);
}

async function waitForTerminal(jobId: string, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await executor.status(jobId);
    if (s === 'succeeded' || s === 'failed' || s === 'cancelled') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflow ${jobId} did not reach a terminal status within ${ms}ms`);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the durable-dbos cancellation test');
  appBaseUrl = url;
  dbosSystemUrl = withDbName(url, DBOS_SYS_DB);

  await dropSysDbSafely(url, DBOS_SYS_DB);

  db = makeDbWithSchema(url, APP_SCHEMA);
  await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'cx', 'cx')`, [TENANT]);
  await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'cy', 'cy')`, [
    OTHER_TENANT,
  ]);

  const deps: DbosExecutorDeps = {
    db,
    resolveRun: (job: RunJob): ResolvedRun => {
      if (job.agentId === 'echo-agent') return { backend, spec: baseSpec };
      throw new Error(`unknown agent '${job.agentId}'`);
    },
  };
  executor = new DbosDurableExecutor(deps, {
    name: `rayspec-cancel-${PID}`,
    systemDatabaseUrl: dbosSystemUrl,
  });
  await executor.start();
}, 60_000);

beforeEach(async () => {
  backend.liveRuns = 0;
  backend.throwMidRunTimes = 0;
  backend.fireToolBeforeProceeding = false;
  backend.releaseGate();
  backend.throwOnGateRelease = false;
  await db.$client.unsafe(
    'TRUNCATE run_events, journal_steps, conversation_items, runs, idempotency_keys CASCADE',
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

describe('DBOS worker cancellation', () => {
  it('a run cancelled BEFORE it starts is never executed: the dispatch refuses and runAgent is not called', async () => {
    testsRan += 1;
    const runId = randomUUID();
    // The cancel surface persists the marker BEFORE anything is dispatched — that ordering is what
    // makes the guard load-bearing (a marker written after a dispatch would be too late).
    await markRunCancelled(forTenant(db, TENANT), runId);
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'cancelled' };

    const handle = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(handle.jobId)).toBe('succeeded');
    // RED-FIRST tell: WITHOUT the guard the body runs runAgent and this is 1 — a cancelled run still
    // burning a model call. WITH the guard it stays 0.
    expect(backend.liveRuns).toBe(0);
  });

  it('a RECOVERY re-dispatch of a cancelled run is refused too (recovery can never resurrect it)', async () => {
    testsRan += 1;
    const runId = randomUUID();
    // Seed what an interrupted first attempt left behind — the `run_started` marker, which its reserve
    // committed OUTSIDE the run's transaction and which therefore survived the crash. THAT is what makes
    // this dispatch a recovery: the body's reserve finds the marker taken and takes the recovery branch.
    // (The guard below proves the seed really does reach that branch: without the cancellation, the very
    // same shape re-runs.) The cancellation is consulted BEFORE any of that machinery decides anything.
    await seedRunStarted(runId);
    await markRunCancelled(forTenant(db, TENANT), runId);
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'recovered' };

    const handle = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(handle.jobId)).toBe('succeeded');
    await new Promise((r) => setTimeout(r, 200));
    expect(backend.liveRuns).toBe(0);
  });

  it('a RECOVERY re-dispatch RECORDS the outcome of a run cancelled while it was executing', async () => {
    testsRan += 1;
    const runId = randomUUID();
    const tdb = forTenant(db, TENANT);
    // Seed exactly what a worker that died mid-run leaves behind. The run was EXECUTING when it was
    // cancelled, so it held its own header row and the cancel surface gave up on the terminal record
    // (`cancelled: false` — the run was expected to write it when it ended). Then the process died, so
    // the run never wrote anything: the enqueue-time header survives at `enqueued`, the `run_started`
    // marker survives because its reserve committed outside the run's transaction, and the cancellation
    // marker survives because it was written by the cancel surface, not by the run.
    await insertEnqueuedRunHeader(tdb, {
      runId,
      backend: backend.id,
      agentName: baseSpec.name,
      model: baseSpec.model,
    });
    await seedRunStarted(runId);
    await markRunCancelled(tdb, runId);
    expect(await runHeaderStatus(runId)).toBe('enqueued');

    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'crashed' };
    const handle = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(handle.jobId)).toBe('succeeded');

    // The gate still refuses to execute it — that half was already true.
    expect(backend.liveRuns).toBe(0);
    // RED-FIRST tell: without the gate recording what it refuses, the header stays 'enqueued' and the
    // journal stays empty forever, so `GET /v1/runs/{id}` reports a run that is still waiting to start
    // — to a caller who was told it had been ended.
    expect(await runHeaderStatus(runId)).toBe('error');
    const steps = await journalSteps(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'cancel', status: 'error', error_class: 'cancelled' });
  });

  it('FAIL-THE-FIX GUARD: the seeded marker really does land on the RECOVERY branch (the same seed, plus a taint, quarantines)', async () => {
    testsRan += 1;
    const runId = randomUUID();
    // The seeding above is only meaningful if it actually changes which branch the body takes, and the
    // ONE externally visible difference between a first dispatch and a recovery is what a TAINT does
    // there: a first dispatch runs the agent, the recovery branch refuses a tainted run outright. So
    // seed both markers a crashed-after-side-effect attempt left, cancel NOTHING, and require the
    // quarantine — a run that executed (or a workflow that succeeded) would mean the seed was inert.
    await seedRunStarted(runId);
    await seedRunTaint(runId);
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'quarantined' };

    const handle = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(handle.jobId)).toBe('failed');
    expect(backend.liveRuns).toBe(0);
  });

  it('FAIL-THE-FIX GUARD: an UNCANCELLED run still executes exactly as before', async () => {
    testsRan += 1;
    const runId = randomUUID();
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'normal' };
    const handle = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(handle.jobId)).toBe('succeeded');
    expect(backend.liveRuns).toBe(1);
    expect(await isRunCancelled(forTenant(db, TENANT), runId)).toBe(false);
  });

  it('FAIL-THE-FIX GUARD: the marker is TENANT-SCOPED — another tenant’s cancellation does not stop this run', async () => {
    testsRan += 1;
    const runId = randomUUID();
    // A marker under a DIFFERENT tenant must be invisible to this run (the chokepoint's predicate is
    // structural), so the run executes normally — a cross-tenant cancel is impossible by construction.
    await markRunCancelled(forTenant(db, OTHER_TENANT), runId);
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'foreign-marker' };
    const handle = await executor.enqueue(TENANT, job);
    expect(await waitForTerminal(handle.jobId)).toBe('succeeded');
    expect(backend.liveRuns).toBe(1);
  });

  it('a cancelled run that ends by FAILING is still recorded terminal, after its transaction rolled back', async () => {
    testsRan += 1;
    const runId = randomUUID();
    // The enqueue-time header the run surface commits before the job is handed to the worker.
    await insertEnqueuedRunHeader(forTenant(db, TENANT), {
      runId,
      backend: 'openai',
      agentName: baseSpec.name,
      model: baseSpec.model,
    });
    // The run is held in flight and will FAIL when it is released — the run that has no result to
    // record its own outcome with.
    backend.armGate();
    backend.throwOnGateRelease = true;
    const job: RunJob = {
      runId,
      tenantId: TENANT,
      agentId: 'echo-agent',
      input: 'cancel-then-fail',
    };
    const handle = await executor.enqueue(TENANT, job);
    await waitFor(() => backend.liveRuns === 1);

    // The cancel surface's sequence for a run its SIGNAL cannot reach (one executing on another worker
    // process): the marker, then the bounded terminal write — which gives up, because the run holds its
    // own header row for as long as it runs and a cancel never waits out the run it is ending.
    const tdb = forTenant(db, TENANT);
    await markRunCancelled(tdb, runId);
    expect(await recordRunCancelled(tdb, runId, { lockWaitMs: 200 })).toEqual({
      cancelled: false,
      status: 'enqueued',
    });

    // The run now ends by FAILING. Its transaction rolls back, so nothing it wrote survives — the
    // `running` header transition and the step it journaled are both gone. RED-FIRST tell: without the
    // executor recording the outcome after that rollback, the header stays 'enqueued' forever and the
    // run reads as if nobody had ended it, for a caller who was told it was.
    backend.releaseGate();
    expect(await waitForTerminal(handle.jobId)).toBe('succeeded');
    expect(await runHeaderStatus(runId)).toBe('error');
    const steps = await journalSteps(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'cancel', status: 'error', error_class: 'cancelled' });
  });

  it('FAIL-THE-FIX GUARD: an UNCANCELLED run that fails still fails, and gains no cancellation record', async () => {
    testsRan += 1;
    const runId = randomUUID();
    await insertEnqueuedRunHeader(forTenant(db, TENANT), {
      runId,
      backend: 'openai',
      agentName: baseSpec.name,
      model: baseSpec.model,
    });
    // The SAME shape as the test above with the one difference that matters: nobody ends this run. The
    // recording must be reached by a cancellation and by nothing else — a run's own failure is still
    // the failure it was, never absorbed into a cancellation it never had.
    backend.armGate();
    backend.throwOnGateRelease = true;
    const job: RunJob = {
      runId,
      tenantId: TENANT,
      agentId: 'echo-agent',
      input: 'fail-uncancelled',
    };
    const handle = await executor.enqueue(TENANT, job);
    await waitFor(() => backend.liveRuns === 1);
    backend.releaseGate();

    expect(await waitForTerminal(handle.jobId)).toBe('failed');
    expect(await runHeaderStatus(runId)).toBe('enqueued');
    expect(await journalSteps(runId)).toEqual([]);
  });

  it('the engine cancel ends an enqueued workflow (the neutral `cancel` seam reaches the engine)', async () => {
    testsRan += 1;
    const runId = randomUUID();
    // Cancel through the NEUTRAL executor seam, then dispatch: the engine reports the workflow
    // cancelled rather than running it. (The marker half above is what a WORKER consults; this is the
    // engine half — the two together are what "cancelled before it starts" means.)
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'engine-cancel' };
    await markRunCancelled(forTenant(db, TENANT), runId);
    await executor.enqueue(TENANT, job);
    // PREMISE, asserted rather than assumed: the queue has not dequeued this job yet. The marker makes
    // the body a fast no-op, so a poller that fired between the enqueue and the cancel would carry the
    // workflow to `succeeded` — a correct outcome, but produced by the WORKER's marker gate (covered
    // above) rather than by the engine seam this test is about. Asserting the premise turns that
    // ordering into a one-line diagnosis instead of a confusing failure on the line below.
    expect(await executor.status(runId)).toBe('enqueued');
    await executor.cancel(runId);
    expect(await executor.status(runId)).toBe('cancelled');
    expect(backend.liveRuns).toBe(0);
  });
});

// The ran-guard: registered LAST + no beforeAll dependency, so a beforeAll throw that skipped the
// tests above can never read as a passing (green) file.
describe('DBOS worker cancellation — ran-guard (not skippable-as-green)', () => {
  it('the cancellation tests ACTUALLY RAN (all nine)', () => {
    expect(testsRan).toBe(9);
  });
});
