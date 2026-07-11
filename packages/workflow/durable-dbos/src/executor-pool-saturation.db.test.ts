/**
 * The worker app-DB pool sizing under the autonomous taint write. `N+1` is the
 * PROVEN minimum (DB-backed, REAL DBOS engine + Postgres) — proven on ground truth in BOTH directions.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE MECHANISM (why `N+1`, and why `pool==N` deadlocks).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A run that fires a NON-idempotent tool acquires a SECOND connection — the chokepoint's autonomous
 * `markRunTainted` INSERT runs on a separate non-transactional `forTenant(workerDb,…)` (= `taintDb`, so
 * the marker commits on its OWN connection and survives the run's tx rollback) WHILE the run still holds
 * its run-tx connection. A held postgres-js `tdb.transaction()` DOES pin its pool slot for the whole
 * transaction (empirically confirmed: 2 held txs on a `max:2` pool leave a 3rd autonomous query PENDING
 * >3s until a held tx releases). So at `workerConcurrency=N` with a pool of EXACTLY N, the N run-tx
 * transactions pin all N slots, none of the N autonomous taint INSERTs can acquire a connection, and the
 * worker DEADLOCKS (every run TIMES OUT).
 *
 * `N+1` is what makes it SAFE: the N held run-tx connections leave ≥1 free slot, so the N autonomous taint
 * INSERTs SERIALIZE through that single headroom slot — each acquires it, does its fast one-shot INSERT,
 * and releases — without ever blocking the held run-tx transactions. The autonomous writes are short and
 * serialized, so one free slot suffices (they never need N free slots at once). The same `+1` slot also
 * covers the started-once reserve + the taint READ (both run BEFORE the run-tx opens).
 *
 * THIS TEST drives the REAL executor (the same DbosDurableExecutor the composition root builds) and PROVES
 * BOTH directions — making the `+1` a proven minimum, not a guess:
 *  - SHIPPED `N+1` arm: pool pinned to `workerConcurrency + 1`, all N runs gated to hold their run-tx
 *    connection SIMULTANEOUSLY, then released to all fire a NON-idempotent tool at once (each needing the
 *    2nd autonomous taint connection). Asserts all N COMPLETE with the side effect firing N times — the
 *    autonomous writes serialized through the one free slot, no hang. NON-VACUOUS (every run succeeds AND
 *    the taint write succeeded N times).
 *  - UNDERSIZED `pool==N` arm (fail-the-fix): pool pinned to EXACTLY `workerConcurrency`, same N concurrent
 *    non-idempotent runs. Asserts the deadlock MANIFESTS — all N TIME OUT within a bounded wait — because
 *    no slot is free for any autonomous taint INSERT. This is the regression a `+1`-removing change would
 *    re-introduce, so it locks in `N+1` as the proven minimum. The arm INTENTIONALLY deadlocks the engine,
 *    so its teardown force-drops its OWN unique sys DB and bounds the shutdown — the deadlocked engine can
 *    never hang the suite/CI.
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
): Promise<{ exec: DbosDurableExecutor; teardown: () => Promise<void> }> {
  const sysDb = `${DBOS_SYS_DB}_${sysSuffix}`;
  await dropSysDb(appBaseUrl, sysDb);
  // A worker DB handle pinned to the SAME isolated schema but with the pool cap under test.
  const workerDb = makeDbWithSchema(appBaseUrl, APP_SCHEMA, poolMax);
  const deps: DbosExecutorDeps = {
    db: workerDb,
    resolveRun: (job: RunJob): ResolvedRun => {
      if (job.agentId !== 'charge-agent') throw new Error(`unknown agent '${job.agentId}'`);
      return { backend, spec: baseSpec, tools: [chargeTool] };
    },
  };
  const exec = new DbosDurableExecutor(deps, {
    name: `rayspec-poolsat-${sysSuffix}`,
    systemDatabaseUrl: withDbName(appBaseUrl, sysDb),
    workerConcurrency: N,
    deregisterOnShutdown: true,
  });
  await exec.start();
  return {
    exec,
    teardown: async () => {
      // Bound the graceful shutdown so a (shadow-mutation-induced) deadlocked workflow cannot hang the
      // suite forever: if shutdown does not resolve quickly, force-terminate the worker pool's backends
      // and force-drop the sys DB instead (the WITH (FORCE) drop terminates the lingering engine).
      await Promise.race([
        exec.shutdown().catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 5_000)),
      ]);
      await workerDb.$client.end({ timeout: 5 }).catch(() => {});
      await dropSysDb(appBaseUrl, sysDb);
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

/** Enqueue N gated non-idempotent runs, wait until all N hold their run-tx conn, return their runIds. */
async function enqueueAndBarrier(exec: DbosDurableExecutor): Promise<string[]> {
  let holding = 0;
  const allHolding = new Promise<void>((resolve) => {
    backend.onHoldingRunTx = () => {
      holding += 1;
      if (holding >= N) resolve();
    };
  });
  backend.gateBeforeTool = true;
  backend.fireToolBeforeProceeding = true; // each run fires the non-idempotent tool (needs a 2nd conn)
  const runIds = Array.from({ length: N }, () => randomUUID());
  for (const runId of runIds) {
    await exec.enqueue(TENANT, { runId, tenantId: TENANT, agentId: 'charge-agent', input: runId });
  }
  // Wait until all N runs hold their run-tx connection (bounded so a sizing bug cannot hang the suite).
  await Promise.race([
    allHolding,
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error('not all runs reached the run-tx barrier in time')),
        15_000,
      ),
    ),
  ]);
  return runIds;
}

describe('worker pool sizing under the autonomous taint write (fix E)', () => {
  it(`SHIPPED sizing N+1: ${N} concurrent non-idempotent runs ALL COMPLETE (no pool-exhaustion hang)`, async () => {
    // Pin the worker pool to the SHIPPED `workerConcurrency + 1` sizing (the composition root's value).
    const { exec, teardown } = await makeExecutor(N + 1, 'ok');
    try {
      const runIds = await enqueueAndBarrier(exec);
      // All N hold their run-tx conn (pinning N of the N+1 slots); release them to all fire the
      // non-idempotent tool at once (each needs a 2nd autonomous taint conn). With one free slot the
      // N autonomous taint INSERTs SERIALIZE through it, so all N complete with no pool-exhaustion hang.
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

  it(`UNDERSIZED pool==N (fail-the-fix): ${N} concurrent non-idempotent runs DEADLOCK (all TIME OUT)`, async () => {
    // Pin the worker pool to EXACTLY `workerConcurrency` (NO headroom — the `+1` removed). This locks in
    // `N+1` as a PROVEN minimum: reverting the production `+1` would re-introduce exactly this deadlock.
    // The arm uses its OWN pid+suffix-unique sys DB ('undersized') so it cannot collide with the N+1 arm.
    const { exec, teardown } = await makeExecutor(N, 'undersized');
    try {
      // All N runs reach the run-tx barrier first — each pins one of the N slots (the pool is exactly N,
      // so the barrier itself is still reachable; the deadlock manifests only AFTER they fire the tool).
      const runIds = await enqueueAndBarrier(exec);
      // Release them to all fire the non-idempotent tool at once. Each now needs a 2nd autonomous taint
      // connection, but all N slots are pinned by the held run-tx transactions and NONE is free → every
      // autonomous taint INSERT blocks forever → the worker DEADLOCKS. Asserted by ground truth: NO run
      // reaches a terminal status within a bounded wait (all TIME OUT). `exec.status` reads the SEPARATE
      // DBOS system-DB pool, so the status polling is not itself starved by the app-pool deadlock.
      backend.releasePreTool();
      const outcomes = await Promise.all(runIds.map((id) => waitForTerminal(exec, id, 8_000)));
      // The fail-the-fix direction: the undersized pool deadlocks, so NONE of the runs complete in time.
      expect(outcomes.every((o) => o === 'TIMEOUT')).toBe(true);
    } finally {
      // The engine is deadlocked; `teardown()` bounds the graceful shutdown and FORCE-drops this arm's
      // OWN unique sys DB (WITH (FORCE)) so the hung engine cannot leak a DB or hang the suite/CI.
      backend.releasePreTool();
      await teardown();
    }
  }, 60_000);
});
