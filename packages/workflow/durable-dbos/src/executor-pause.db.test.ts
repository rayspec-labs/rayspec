/**
 * Pausing and resuming agent-run dispatch on a REAL DBOS engine, without shutting it down.
 *
 * What a source fence needs from the run queue, and what `DBOS.shutdown()` cannot give it: stop
 * dequeuing, let the runs already executing finish (and count them, so a drain knows when it is
 * done), and start dequeuing again later in the same process.
 *
 *  1. Paused BEFORE start: the queue is registered paused, so an enqueued run is recorded but not
 *     dequeued; resuming dispatches it. (Without the paused registration, `start()` would register the
 *     queue at full concurrency and the run would execute within one poll.)
 *  2. A run already executing when dispatch pauses keeps running and is counted in `inFlight`; a run
 *     enqueued once the pause has settled waits; both finish once the first is released and dispatch
 *     resumes.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec } from '@rayspec/core';
import { makeDbWithSchema } from '@rayspec/db/testing';
import type { RunJob } from '@rayspec/platform';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbosDurableExecutor, type ResolvedRun } from './executor.js';
import { type EngineDatabases, engineDatabases } from './test-support/engine-databases.js';
import { FakeSpineBackend } from './test-support/fake-backend.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_pause_${PID}`;
const DBOS_SYS_DB = `rayspec_dbos_pause_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000a1';

const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !baseUrl) {
  throw new Error(
    'executor-pause.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}

const backend = new FakeSpineBackend();
const spec: AgentSpec = {
  name: 'echo',
  instructions: 'echo the input',
  model: 'gpt-4.1-mini',
  input: 'placeholder',
  tools: [],
  maxTurns: 4,
};

let db: ReturnType<typeof makeDbWithSchema>;
let engine: EngineDatabases | undefined;
let executor: DbosDurableExecutor;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function dropSysDb(url: string): Promise<void> {
  const admin = postgres(withDbName(url, 'postgres'), { max: 1 });
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}"`);
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

async function waitFor(predicate: () => boolean | Promise<boolean>, capMs = 20_000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition did not hold within ${capMs}ms`);
}

function job(input: string): RunJob {
  return { runId: randomUUID(), tenantId: TENANT, agentId: 'echo-agent', input };
}

/** Longer than several dispatch polls (DBOS polls a queue about once a second). */
const WELL_PAST_A_POLL_MS = 3_500;

const maybe = baseUrl ? describe : describe.skip;

maybe('agent-run dispatch pauses and resumes without shutting the engine down', () => {
  beforeAll(async () => {
    const url = baseUrl as string;
    await dropSysDb(url);
    db = makeDbWithSchema(url, APP_SCHEMA);
    await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
    await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'pa', 'pa')`, [TENANT]);
    // The engine's databases: the suite's own, or in the runtime-role lane the runtime role's.
    engine = await engineDatabases({
      admin: db,
      adminUrl: url,
      schema: APP_SCHEMA,
      systemDatabaseUrl: withDbName(url, DBOS_SYS_DB),
    });
    executor = new DbosDurableExecutor(
      {
        db: engine.appDb,
        resolveRun: (j: RunJob): ResolvedRun => {
          if (j.agentId === 'echo-agent') return { backend, spec };
          throw new Error(`unknown agent '${j.agentId}'`);
        },
      },
      { name: `rayspec-pause-${PID}`, systemDatabaseUrl: engine.systemDatabaseUrl },
    );
    // Paused before the engine launches: the queue must come up paused.
    await executor.pauseDispatch();
    await executor.start();
  }, 60_000);

  afterAll(async () => {
    backend.releaseGate();
    try {
      await executor?.shutdown();
    } finally {
      await engine?.close();
      await db?.$client.end();
      if (baseUrl) await dropSysDb(baseUrl);
    }
  }, 30_000);

  it('registers the queue paused when paused before start, and dispatches after resume', async () => {
    backend.liveRuns = 0;
    const handle = await executor.enqueue(TENANT, job('waits'));
    await new Promise((r) => setTimeout(r, WELL_PAST_A_POLL_MS));
    expect(backend.liveRuns).toBe(0);
    expect(await executor.status(handle.jobId)).toBe('enqueued');

    await executor.resumeDispatch();
    await waitFor(async () => (await executor.status(handle.jobId)) === 'succeeded');
    expect(backend.liveRuns).toBe(1);
    expect(executor.inFlight).toBe(0);
  });

  it('lets a running job finish while paused, counts it in flight, and holds new ones back', async () => {
    backend.liveRuns = 0;
    backend.armGate();
    const running = await executor.enqueue(TENANT, job('running'));
    await waitFor(() => backend.liveRuns === 1);
    expect(executor.inFlight).toBe(1);

    await executor.pauseDispatch();
    // A dispatch loop that read the queue row just before the pause may still claim once; the pause
    // reports settled only after that window.
    expect(executor.dispatchSettled).toBe(false);
    await waitFor(() => executor.dispatchSettled, 10_000);
    const waiting = await executor.enqueue(TENANT, job('after the pause'));
    await new Promise((r) => setTimeout(r, WELL_PAST_A_POLL_MS));
    // The running job was not interrupted, and the new one was not dequeued.
    expect(executor.inFlight).toBe(1);
    expect(backend.liveRuns).toBe(1);
    expect(await executor.status(waiting.jobId)).toBe('enqueued');

    backend.releaseGate();
    await waitFor(async () => (await executor.status(running.jobId)) === 'succeeded');
    await waitFor(() => executor.inFlight === 0);
    expect(await executor.status(waiting.jobId)).toBe('enqueued');

    await executor.resumeDispatch();
    await waitFor(async () => (await executor.status(waiting.jobId)) === 'succeeded');
    expect(backend.liveRuns).toBe(2);
  });
});
