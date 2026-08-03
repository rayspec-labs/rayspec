/**
 * Cancelling a run the durable worker is ALREADY EXECUTING, with only the durable marker — DB-backed,
 * REAL DBOS engine, real transaction.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING PROVEN.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The existing worker-cancellation contract covers a run that has NOT started (the dispatch gate) and
 * a run that ends by failing (the post-rollback record). The gap it does not cover is the expensive
 * one: a run already inside `runAgent`, inside the executor's transaction, waiting on a backend. Until
 * the run's own process re-reads the cancellation marker, nothing ends it — the marker is durable but
 * only ever consulted before a dispatch, and the abort signal is process-local.
 *
 * With `RAYSPEC_RUN_CANCEL_POLL_MS` set, the run's process re-reads the marker while it waits and
 * delivers its own abort. This test writes NOTHING but the marker, and writes it from a SECOND,
 * INDEPENDENT connection pool — never `executor.cancel`, never `signalRunCancelled`, never
 * `recordRunCancelled`. The run is held at a manual gate that is never released before the assertion,
 * so a run that reaches a terminal state at all can only have been ended by the marker.
 *
 * THE PAIRED UNSET ARM IS WHAT MAKES IT THE POLL. Identical setup with the variable unset: the marker
 * is written, several poll intervals pass, and the run is STILL in flight — it ends only when the gate
 * is released, and then commits, so its `llm` step is in the journal beside the cancellation the
 * run itself records. The marker alone changes nothing; the poll is what reads it.
 *
 * It builds its OWN executor with a file-unique system database and application schema, as every
 * DBOS-backed file here does — DBOS is a process-global singleton, so an arm on another file's
 * executor would share that file's launch and its assertions.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec } from '@rayspec/core';
import { forTenant } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { insertEnqueuedRunHeader, markRunCancelled, type RunJob } from '@rayspec/platform';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbosDurableExecutor, type DbosExecutorDeps, type ResolvedRun } from './executor.js';
import { FakeSpineBackend } from './test-support/fake-backend.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

// File-unique (pid-suffixed) names + a DISTINCT token from every other DB file so a fork of another
// file can NEVER collide on the same sys DB / app schema (the cross-file false-green hazard).
const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_cpoll_${PID}`;
const DBOS_SYS_DB = `rayspec_dbos_cpoll_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000cc';

/** The variable under test. Saved and restored per test so no arm leaks into the next. */
const POLL_ENV = 'RAYSPEC_RUN_CANCEL_POLL_MS';

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
/** A SECOND, independent pool over the same schema — the cancelling side, as another process is. */
let markerDb: DbHandle;
let executor: DbosDurableExecutor;
let dbosSystemUrl: string;
let appBaseUrl: string;
let savedPollEnv: string | undefined;

/** The ran-guard: a skipped file must never read as a green file. */
let testsRan = 0;

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

/** The `runs` header status for `runId` (undefined when there is no header at all). */
async function runHeaderStatus(runId: string): Promise<string | undefined> {
  const rows = (await db.$client.unsafe('SELECT status FROM runs WHERE run_id = $1', [
    runId,
  ])) as unknown as { status: string }[];
  return rows[0]?.status;
}

/** Every journal step recorded for `runId`, in a deterministic order (the step's natural key). */
async function journalSteps(
  runId: string,
): Promise<Array<{ type: string; status: string; error_class: string | null }>> {
  const rows = (await db.$client.unsafe(
    'SELECT type, status, error_class, idempotency_key FROM journal_steps WHERE run_id = $1 ' +
      'ORDER BY type, idempotency_key',
    [runId],
  )) as unknown as Array<{ type: string; status: string; error_class: string | null }>;
  return rows.map((r) => ({ type: r.type, status: r.status, error_class: r.error_class }));
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

/** Put the variable back exactly as the process started with it — every arm sets its own value. */
function restorePollEnv(): void {
  if (savedPollEnv === undefined) delete process.env[POLL_ENV];
  else process.env[POLL_ENV] = savedPollEnv;
}

beforeAll(async () => {
  savedPollEnv = process.env[POLL_ENV];
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the durable-dbos cancellation-poll test');
  appBaseUrl = url;
  dbosSystemUrl = withDbName(url, DBOS_SYS_DB);

  await dropSysDbSafely(url, DBOS_SYS_DB);

  db = makeDbWithSchema(url, APP_SCHEMA);
  markerDb = makeDbWithSchema(url, APP_SCHEMA);
  await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'cp', 'cp')`, [TENANT]);

  const deps: DbosExecutorDeps = {
    db,
    resolveRun: (job: RunJob): ResolvedRun => {
      if (job.agentId === 'echo-agent') return { backend, spec: baseSpec };
      throw new Error(`unknown agent '${job.agentId}'`);
    },
  };
  executor = new DbosDurableExecutor(deps, {
    name: `rayspec-cancel-poll-${PID}`,
    systemDatabaseUrl: dbosSystemUrl,
  });
  await executor.start();
}, 60_000);

beforeEach(async () => {
  restorePollEnv();
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
  restorePollEnv();
  try {
    await executor.shutdown();
  } finally {
    backend.releaseGate();
    await markerDb.$client.end();
    await db.$client.end();
    await dropSysDbSafely(appBaseUrl, DBOS_SYS_DB);
  }
}, 30_000);

describe('DBOS worker cancellation while the run is EXECUTING', () => {
  it('a marker written by another connection ends a run held in flight — nothing signals it', async () => {
    testsRan += 1;
    process.env[POLL_ENV] = '100';
    const runId = randomUUID();
    // The enqueue-time header the run surface commits before the job is handed to the worker.
    await insertEnqueuedRunHeader(forTenant(db, TENANT), {
      runId,
      backend: backend.id,
      agentName: baseSpec.name,
      model: baseSpec.model,
    });
    // The run is held at the gate for as long as the test wants — it is NEVER released below, so a
    // terminal outcome cannot come from the run finishing.
    backend.armGate();
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'poll-cancel' };
    const handle = await executor.enqueue(TENANT, job);
    await waitFor(() => backend.liveRuns === 1);

    // The ONLY thing the cancelling side does, and it does it on an independent pool.
    await markRunCancelled(forTenant(markerDb, TENANT), runId);

    // RED-FIRST tell: without the poll nothing re-reads that marker while the run waits, so the run
    // stays in flight and this times out with the gate still shut.
    expect(await waitForTerminal(handle.jobId)).toBe('succeeded');
    expect(await runHeaderStatus(runId)).toBe('error');
    // Exactly one step: the run's transaction rolled back, so the `llm` step it journaled inside it
    // is gone and only the cancellation the executor recorded after the rollback remains.
    expect(await journalSteps(runId)).toEqual([
      { type: 'cancel', status: 'error', error_class: 'cancelled' },
    ]);
  });

  it('PAIRED UNSET ARM: the same marker, with no interval configured, does NOT end the run', async () => {
    testsRan += 1;
    const runId = randomUUID();
    await insertEnqueuedRunHeader(forTenant(db, TENANT), {
      runId,
      backend: backend.id,
      agentName: baseSpec.name,
      model: baseSpec.model,
    });
    backend.armGate();
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'poll-unset' };
    const handle = await executor.enqueue(TENANT, job);
    await waitFor(() => backend.liveRuns === 1);

    await markRunCancelled(forTenant(markerDb, TENANT), runId);
    // Fifteen times the interval the arm above used: ample for a poll to have fired, if one existed.
    await new Promise((r) => setTimeout(r, 1500));

    // The marker alone changes nothing: the workflow has not ended, and the run still holds its
    // header row inside its own transaction (another connection reads the pre-run `enqueued`, which
    // is exactly what a run ended by the marker would NOT have left — the executor writes `error`).
    expect(['succeeded', 'failed', 'cancelled']).not.toContain(await executor.status(handle.jobId));
    expect(await runHeaderStatus(runId)).toBe('enqueued');

    // It ends only when the run itself ends — and then it COMMITS, so the step it journaled inside
    // its transaction survives beside the cancellation it records for itself on the way out.
    backend.releaseGate();
    expect(await waitForTerminal(handle.jobId)).toBe('succeeded');
    expect(await runHeaderStatus(runId)).toBe('error');
    expect(await journalSteps(runId)).toEqual([
      { type: 'cancel', status: 'error', error_class: 'cancelled' },
      { type: 'llm', status: 'ok', error_class: null },
    ]);
  });
});

// The ran-guard: registered LAST + no beforeAll dependency, so a beforeAll throw that skipped the
// tests above can never read as a passing (green) file.
describe('DBOS cancellation poll — ran-guard (not skippable-as-green)', () => {
  it('the cancellation-poll tests ACTUALLY RAN (both)', () => {
    expect(testsRan).toBe(2);
  });
});
