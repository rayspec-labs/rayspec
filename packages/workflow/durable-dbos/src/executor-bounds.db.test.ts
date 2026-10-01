/**
 * The durable worker's execution bounds — DB-backed, REAL DBOS engine.
 *
 *  - ONE EXECUTION AT A TIME. The run holds no transaction across its model call, so what keeps a
 *    second dispatch of the same run from executing alongside the first is the lease the started-once
 *    marker carries. A dispatch that finds a live lease waits; it runs only once the lease lapses, and
 *    the re-run starts from a clean record. An execution whose lease is taken over stops its run.
 *  - QUEUE ADMISSION. With a per-tenant and a global bound configured, a burst of enqueues is admitted
 *    exactly up to the bound and every enqueue past it is refused with `RunAdmissionRefusedError` —
 *    nothing is queued for a refused run. A re-enqueue of a run that already exists is never refused.
 *
 * It builds its OWN executor with a file-unique system database and application schema, as every
 * DBOS-backed file here does (DBOS is a process-global singleton).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec } from '@rayspec/core';
import { forTenant, schema } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { RunAdmissionRefusedError, type RunJob } from '@rayspec/platform';
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
import { type EngineDatabases, engineDatabases } from './test-support/engine-databases.js';
import { FakeSpineBackend } from './test-support/fake-backend.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_bounds_${PID}`;
const DBOS_SYS_DB = `rayspec_dbos_bounds_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000b1';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000b2';

/** The lease this file's executor runs with: short, so a lapse is observable in a test. */
const LEASE_TTL_MS = 600;
const QUEUE_MAX_PER_TENANT = 3;
const QUEUE_MAX = 5;

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
let engine: EngineDatabases | undefined;
let executor: DbosDurableExecutor;
let appBaseUrl: string;
let testsRan = 0;

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

async function waitForTerminal(jobId: string, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await executor.status(jobId);
    if (s === 'succeeded' || s === 'failed' || s === 'cancelled') return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`workflow ${jobId} did not reach a terminal status within ${ms}ms`);
}

async function waitFor(predicate: () => boolean, capMs = 20_000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not reached in time');
}

/** Seed the started-once marker with a lease held by ANOTHER execution until `leaseUntil`. */
async function seedForeignLease(runId: string, leaseUntil: number): Promise<void> {
  await forTenant(db, TENANT)
    .insert(schema.idempotencyKeys, {
      scope: RUN_STARTED_SCOPE,
      idemKey: runId,
      bodyHash: RUN_STARTED_BODY_HASH,
      snapshot: { runId, executionId: 'another-worker', leaseUntil },
    })
    .onConflictDoNothing();
}

async function countRows(table: string, runId: string): Promise<number> {
  const rows = (await db.$client.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE run_id = $1`,
    [runId],
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the durable-dbos bounds test');
  appBaseUrl = url;
  await dropSysDbSafely(url, DBOS_SYS_DB);
  db = makeDbWithSchema(url, APP_SCHEMA);
  await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await db.$client.unsafe(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, 'b1', 'b1'), ($2, 'b2', 'b2')`,
    [TENANT, OTHER_TENANT],
  );
  engine = await engineDatabases({
    admin: db,
    adminUrl: url,
    schema: APP_SCHEMA,
    systemDatabaseUrl: withDbName(url, DBOS_SYS_DB),
  });
  const deps: DbosExecutorDeps = {
    db: engine.appDb,
    resolveRun: (job: RunJob): ResolvedRun => {
      if (job.agentId === 'echo-agent') return { backend, spec: baseSpec };
      throw new Error(`unknown agent '${job.agentId}'`);
    },
  };
  executor = new DbosDurableExecutor(deps, {
    name: `rayspec-bounds-${PID}`,
    systemDatabaseUrl: engine.systemDatabaseUrl,
    workerConcurrency: 1,
    runLeaseTtlMs: LEASE_TTL_MS,
    admission: { queueMax: QUEUE_MAX, queueMaxPerTenant: QUEUE_MAX_PER_TENANT },
  });
  await executor.start();
}, 60_000);

beforeEach(async () => {
  backend.liveRuns = 0;
  backend.releaseGate();
  backend.throwOnGateRelease = false;
  delete process.env.RAYSPEC_AGENT_KILL_GRACE_MS;
  await db.$client.unsafe(
    'TRUNCATE run_events, journal_steps, conversation_items, runs, idempotency_keys CASCADE',
  );
});

afterAll(async () => {
  delete process.env.RAYSPEC_AGENT_KILL_GRACE_MS;
  backend.releaseGate();
  try {
    await executor.shutdown();
  } finally {
    await engine?.close();
    await db.$client.end();
    await dropSysDbSafely(appBaseUrl, DBOS_SYS_DB);
  }
}, 30_000);

describe('one execution at a time — the started-once lease', () => {
  it('a dispatch that finds a LIVE lease waits, and runs only once the lease lapses', async () => {
    testsRan += 1;
    const runId = randomUUID();
    const leaseUntil = Date.now() + 1_500;
    await seedForeignLease(runId, leaseUntil);
    const handle = await executor.enqueue(TENANT, {
      runId,
      tenantId: TENANT,
      agentId: 'echo-agent',
      input: 'wait-for-lease',
    });
    // While the other execution's lease is live, this dispatch does not run the backend.
    await new Promise((r) => setTimeout(r, 900));
    expect(Date.now()).toBeLessThan(leaseUntil);
    expect(backend.liveRuns).toBe(0);
    // Once it lapses, the (untainted) run is taken over and runs.
    expect(await waitForTerminal(handle.jobId)).toBe('succeeded');
    expect(backend.liveRuns).toBe(1);
  });

  it('the run taken over starts from a clean record: what the interrupted attempt left is removed', async () => {
    testsRan += 1;
    const runId = randomUUID();
    await seedForeignLease(runId, Date.now() - 1);
    // What an interrupted attempt leaves now that nothing rolls it back: its events and a step.
    const tdb = forTenant(db, TENANT);
    await tdb.insert(schema.runEvents, {
      runId,
      seq: '0',
      type: 'run_started',
      data: { type: 'run_started', runId, seq: 0 },
    });
    await tdb.insert(schema.journalSteps, {
      runId,
      backend: 'openai',
      type: 'llm',
      idempotencyKey: 'llm:interrupted:0',
      inputHash: 'interrupted',
      output: { finalText: 'from the interrupted attempt' },
      status: 'ok',
      authMode: 'api-key',
    });
    const handle = await executor.enqueue(TENANT, {
      runId,
      tenantId: TENANT,
      agentId: 'echo-agent',
      input: 'clean-rerun',
    });
    expect(await waitForTerminal(handle.jobId)).toBe('succeeded');
    const steps = (await db.$client.unsafe(
      'SELECT idempotency_key FROM journal_steps WHERE run_id = $1',
      [runId],
    )) as unknown as Array<{ idempotency_key: string }>;
    // Only the re-run's own step: the interrupted attempt's step is gone.
    expect(steps.map((r) => r.idempotency_key)).toEqual(['llm:echo:0']);
    // And the event log restarts at the re-run's first event.
    expect(await countRows('run_events', runId)).toBeGreaterThan(0);
    const first = (await db.$client.unsafe(
      "SELECT data->>'type' AS type FROM run_events WHERE run_id = $1 AND seq = 0",
      [runId],
    )) as unknown as Array<{ type: string }>;
    expect(first[0]?.type).toBe('run_started');
  });

  it('an execution whose lease is taken over stops its own run', async () => {
    testsRan += 1;
    process.env.RAYSPEC_AGENT_KILL_GRACE_MS = '100';
    const runId = randomUUID();
    backend.armGate();
    const handle = await executor.enqueue(TENANT, {
      runId,
      tenantId: TENANT,
      agentId: 'echo-agent',
      input: 'lease-stolen',
    });
    await waitFor(() => backend.liveRuns === 1);
    // Another execution takes the lease over (what a recovery does once a lease lapsed).
    await db.$client.unsafe(
      `UPDATE idempotency_keys SET snapshot = jsonb_build_object('runId', $1::text,
         'executionId', 'thief', 'leaseUntil', (extract(epoch from now()) * 1000 + 60000)::bigint)
       WHERE scope = $2 AND idem_key = $1`,
      [runId, RUN_STARTED_SCOPE],
    );
    // The executing worker's next renewal sees it and stops the run: the workflow fails rather than
    // completing alongside the other execution — although the backend's gate is never released.
    expect(await waitForTerminal(handle.jobId, 10_000)).toBe('failed');
    backend.releaseGate();
  });
});

describe('queue admission under a burst', () => {
  it('a burst is admitted exactly up to the per-tenant bound, and the rest is refused with nothing queued', async () => {
    testsRan += 1;
    backend.armGate(); // every admitted run stays queued or executing for the whole test
    const runIds = Array.from({ length: 10 }, () => randomUUID());
    const outcomes = await Promise.allSettled(
      runIds.map((runId) =>
        executor.enqueue(TENANT, { runId, tenantId: TENANT, agentId: 'echo-agent', input: runId }),
      ),
    );
    const admitted = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(admitted).toHaveLength(QUEUE_MAX_PER_TENANT);
    expect(refused).toHaveLength(10 - QUEUE_MAX_PER_TENANT);
    for (const r of refused) {
      expect(r.reason).toBeInstanceOf(RunAdmissionRefusedError);
      expect((r.reason as RunAdmissionRefusedError).scope).toBe('tenant');
      expect((r.reason as RunAdmissionRefusedError).limit).toBe(QUEUE_MAX_PER_TENANT);
    }
    // Nothing was queued for a refused run: the engine does not know it.
    const refusedIds = runIds.filter((_, i) => outcomes[i]?.status === 'rejected');
    for (const id of refusedIds) expect(await executor.status(id)).toBe('unknown');

    // A re-enqueue of an ADMITTED run is not a new run, and is not refused even though the bound is
    // reached.
    const admittedIds = runIds.filter((_, i) => outcomes[i]?.status === 'fulfilled');
    const first = admittedIds[0] as string;
    await expect(
      executor.enqueue(TENANT, {
        runId: first,
        tenantId: TENANT,
        agentId: 'echo-agent',
        input: first,
      }),
    ).resolves.toEqual({ jobId: first });

    // The global bound counts every tenant: another tenant gets the remaining global room and no more.
    const otherIds = Array.from({ length: 4 }, () => randomUUID());
    const otherOutcomes = await Promise.allSettled(
      otherIds.map((runId) =>
        executor.enqueue(OTHER_TENANT, {
          runId,
          tenantId: OTHER_TENANT,
          agentId: 'echo-agent',
          input: runId,
        }),
      ),
    );
    expect(otherOutcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(
      QUEUE_MAX - QUEUE_MAX_PER_TENANT,
    );
    const globalRefusals = otherOutcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );
    expect(globalRefusals.length).toBe(4 - (QUEUE_MAX - QUEUE_MAX_PER_TENANT));
    for (const r of globalRefusals) {
      expect((r.reason as RunAdmissionRefusedError).scope).toBe('global');
    }

    // Draining the queue makes room again.
    backend.releaseGate();
    const allAdmitted = [
      ...admittedIds,
      ...otherIds.filter((_, i) => otherOutcomes[i]?.status === 'fulfilled'),
    ];
    for (const id of allAdmitted) expect(await waitForTerminal(id)).toBe('succeeded');
    const later = randomUUID();
    await expect(
      executor.enqueue(TENANT, {
        runId: later,
        tenantId: TENANT,
        agentId: 'echo-agent',
        input: 'x',
      }),
    ).resolves.toEqual({ jobId: later });
    expect(await waitForTerminal(later)).toBe('succeeded');
  }, 60_000);
});

describe('execution bounds — ran-guard (not skippable-as-green)', () => {
  it('the bounds tests ACTUALLY RAN', () => {
    expect(testsRan).toBe(4);
  });
});
