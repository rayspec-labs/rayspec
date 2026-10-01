/**
 * The worker's application-database pool stays BOUNDED while runs wait on slow providers (DB-backed,
 * REAL DBOS engine + Postgres).
 *
 * The off-request run holds no transaction across the model call: its statements — the started-once
 * reserve, the header, the journal, the events, the autonomous taint marker a non-idempotent tool
 * writes before it fires — each borrow a connection for one statement and give it back. So the number
 * of runs waiting on a provider is bounded by the worker concurrency, and the number of database
 * sessions by the pool size, independently of each other.
 *
 *  - SHIPPED sizing (`workerConcurrency + 1`): N concurrent runs, each firing a non-idempotent tool,
 *    all complete.
 *  - A pool FAR SMALLER than the concurrency (2 sessions for 6 runs): all 6 runs are held waiting on a
 *    slow provider AT ONCE — which a run holding a transaction could never reach with 2 connections —
 *    while the pool holds at most 2 sessions and none of them sits in a transaction; released, all 6
 *    complete and each fires its tool exactly once. Before the transaction was removed this pool
 *    could not even get the 6 runs started.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, NeutralTool } from '@rayspec/core';
import { makeDbWithSchema } from '@rayspec/db/testing';
import type { RunJob } from '@rayspec/platform';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbosDurableExecutor, type DbosExecutorDeps, type ResolvedRun } from './executor.js';
import { engineDatabases } from './test-support/engine-databases.js';
import { FakeSpineBackend } from './test-support/fake-backend.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

// File-unique (pid-suffixed) names so a parallel fork of another file can never collide (fix A).
const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_poolsat_${PID}`;
const DBOS_SYS_DB = `rayspec_dbos_poolsat_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000dd';
const N = 3; // worker concurrency for this test (small but >1 so the two-connection contention is real)

const sideEffects = { count: 0 };

const chargeTool: NeutralTool = {
  spec: {
    name: 'charge_card',
    description: 'a non-idempotent side effect',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
  handler: (args) => {
    sideEffects.count += 1;
    return { charged: (args as { q?: string }).q ?? '' };
  },
  timeoutMs: 2000,
  idempotent: false,
};

const baseSpec: AgentSpec = {
  name: 'echo',
  instructions: 'echo',
  model: 'gpt-4.1-mini',
  input: 'placeholder',
  tools: [],
  maxTurns: 4,
};

const backend = new FakeSpineBackend();

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * This file's per-arm sys DBs are NEVER shared with another file (pid- + suffix-unique), so a FORCE drop
 * here cannot corrupt another file's engine. FORCE is RETAINED deliberately for the ONE case it is needed:
 * the PM's fail-the-fix shadow-mutation pins the pool to the deadlock size, which can leave a hung engine
 * that a plain drop cannot remove — FORCE recovers it so the suite does not hang. The teardown bounds the
 * graceful shutdown first; this is the last-resort cleanup of THIS file's own throwaway sys DB only.
 */
async function dropSysDb(appBaseUrl: string, sysDb: string): Promise<void> {
  const admin = postgres(withDbName(appBaseUrl, 'postgres'), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${sysDb}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let appBaseUrl: string;
let ddlDb: DbHandle; // a default-pool handle used ONLY to provision the schema + read ground truth

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the durable-dbos pool-saturation test');
  appBaseUrl = url;
  ddlDb = makeDbWithSchema(url, APP_SCHEMA);
  await ddlDb.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await ddlDb.$client.unsafe(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, 'poolsat', 'poolsat')`,
    [TENANT],
  );
}, 60_000);

beforeEach(async () => {
  backend.liveRuns = 0;
  backend.gateBeforeTool = false;
  backend.fireToolBeforeProceeding = false;
  backend.onHoldingRunTx = undefined;
  sideEffects.count = 0;
  await ddlDb.$client.unsafe(
    'TRUNCATE run_events, journal_steps, conversation_items, runs, idempotency_keys CASCADE',
  );
});

afterAll(async () => {
  // Drop this file's isolated app schema (provisioned in beforeAll) so a repeated CI/local run does not
  // accumulate per-pid `rayspec_test_dbos_poolsat_<pid>` schemas. Drop via a fresh admin handle BEFORE
  // ending ddlDb's client (its connection pins the search_path to the schema being dropped).
  const admin = postgres(appBaseUrl, { max: 1 });
  try {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${APP_SCHEMA}" CASCADE`);
  } finally {
    await admin.end();
  }
  await ddlDb.$client.end();
  await dropSysDb(appBaseUrl, DBOS_SYS_DB);
});

/**
 * Build an executor whose worker DB pool is pinned to `poolMax`, with a uniquely-named sys DB so each
 * arm cannot collide. Returns the executor + a teardown that shuts it down and drops the sys DB.
 */
async function makeExecutor(
  poolMax: number,
  sysSuffix: string,
  concurrency: number = N,
): Promise<{ exec: DbosDurableExecutor; teardown: () => Promise<void>; appName?: string }> {
  const sysDb = `${DBOS_SYS_DB}_${sysSuffix}`;
  await dropSysDb(appBaseUrl, sysDb);
  // A worker DB handle pinned to the SAME isolated schema but with the pool cap under test — in the
  // runtime-role lane the runtime role's. Outside the lane its sessions carry an application name, so
  // the test can count exactly this pool's sessions in pg_stat_activity.
  const engine = await engineDatabases({
    admin: ddlDb,
    adminUrl: appBaseUrl,
    schema: APP_SCHEMA,
    systemDatabaseUrl: withDbName(appBaseUrl, sysDb),
    poolMax,
  });
  const appName = engine.runtimeRole ? undefined : `rayspec-poolsat-${PID}-${sysSuffix}`;
  const workerDb = engine.runtimeRole
    ? engine.appDb
    : makeDbWithSchema(appBaseUrl, APP_SCHEMA, poolMax, { applicationName: appName });
  const deps: DbosExecutorDeps = {
    db: workerDb,
    resolveRun: (job: RunJob): ResolvedRun => {
      if (job.agentId !== 'charge-agent') throw new Error(`unknown agent '${job.agentId}'`);
      return { backend, spec: baseSpec, tools: [chargeTool] };
    },
  };
  const exec = new DbosDurableExecutor(deps, {
    name: `rayspec-poolsat-${sysSuffix}`,
    systemDatabaseUrl: engine.systemDatabaseUrl,
    workerConcurrency: concurrency,
    deregisterOnShutdown: true,
  });
  await exec.start();
  return {
    exec,
    ...(appName === undefined ? {} : { appName }),
    teardown: async () => {
      // Bound the graceful shutdown so a hung workflow cannot hang the suite: if shutdown does not
      // resolve quickly, end the worker pool and force-drop the sys DB instead.
      await Promise.race([
        exec.shutdown().catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 5_000)),
      ]);
      await workerDb.$client.end({ timeout: 5 }).catch(() => {});
      await dropSysDb(appBaseUrl, sysDb);
      await engine.close();
    },
  };
}

async function waitForTerminal(
  exec: DbosDurableExecutor,
  jobId: string,
  ms: number,
): Promise<string | 'TIMEOUT'> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await exec.status(jobId);
    if (s === 'succeeded' || s === 'failed' || s === 'cancelled') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return 'TIMEOUT';
}

/** Enqueue `count` gated non-idempotent runs, wait until all are held waiting, return their runIds. */
async function enqueueAndBarrier(exec: DbosDurableExecutor, count: number = N): Promise<string[]> {
  let holding = 0;
  const allHolding = new Promise<void>((resolve) => {
    backend.onHoldingRunTx = () => {
      holding += 1;
      if (holding >= count) resolve();
    };
  });
  backend.gateBeforeTool = true;
  backend.fireToolBeforeProceeding = true; // each run fires the non-idempotent tool once released
  const runIds = Array.from({ length: count }, () => randomUUID());
  for (const runId of runIds) {
    await exec.enqueue(TENANT, { runId, tenantId: TENANT, agentId: 'charge-agent', input: runId });
  }
  // Wait until every run is held (bounded so a sizing bug cannot hang the suite).
  await Promise.race([
    allHolding,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('not all runs reached the barrier in time')), 15_000),
    ),
  ]);
  return runIds;
}

/** This pool's sessions right now: how many, and how many sit idle inside an open transaction. */
async function poolSessions(appName: string): Promise<{ total: number; inTransaction: number }> {
  const rows = (await ddlDb.$client.unsafe(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS in_tx
       FROM pg_stat_activity WHERE application_name = $1`,
    [appName],
  )) as unknown as Array<{ total: number; in_tx: number }>;
  return { total: rows[0]?.total ?? 0, inTransaction: rows[0]?.in_tx ?? 0 };
}

describe('the worker pool stays bounded while runs wait on slow providers', () => {
  it(`SHIPPED sizing N+1: ${N} concurrent non-idempotent runs ALL COMPLETE (no pool-exhaustion hang)`, async () => {
    // Pin the worker pool to the SHIPPED `workerConcurrency + 1` sizing (the composition root's value).
    const { exec, teardown } = await makeExecutor(N + 1, 'ok');
    try {
      const runIds = await enqueueAndBarrier(exec);
      // All N are held waiting; release them to all fire the non-idempotent tool at once.
      backend.releasePreTool();
      const outcomes = await Promise.all(runIds.map((id) => waitForTerminal(exec, id, 20_000)));
      expect(outcomes.every((o) => o === 'succeeded')).toBe(true);
      // Each run fired its non-idempotent tool exactly once (the taint write succeeded for all N).
      expect(sideEffects.count).toBe(N);
    } finally {
      backend.releasePreTool();
      await teardown();
    }
  }, 60_000);

  it('a pool far smaller than the concurrency: 6 runs wait on a slow provider at once on 2 sessions, none in a transaction, and all complete', async () => {
    const RUNS = 6;
    const POOL = 2;
    const { exec, teardown, appName } = await makeExecutor(POOL, 'small', RUNS);
    try {
      // All 6 runs reach the provider wait at the same time. A run holding a transaction across the
      // wait would pin a session each, so 2 sessions could never get 6 runs this far.
      const runIds = await enqueueAndBarrier(exec, RUNS);
      if (appName !== undefined) {
        // Sample the pool while all 6 wait: never more sessions than the pool allows, and none of
        // them inside a transaction.
        for (let i = 0; i < 5; i += 1) {
          const sessions = await poolSessions(appName);
          expect(sessions.total).toBeLessThanOrEqual(POOL);
          expect(sessions.inTransaction).toBe(0);
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      backend.releasePreTool();
      const outcomes = await Promise.all(runIds.map((id) => waitForTerminal(exec, id, 20_000)));
      expect(outcomes.every((o) => o === 'succeeded')).toBe(true);
      // Each run fired its non-idempotent tool exactly once.
      expect(sideEffects.count).toBe(RUNS);
    } finally {
      backend.releasePreTool();
      await teardown();
    }
  }, 60_000);
});
