/**
 * The SAFE reliability half (DB-backed, REAL DBOS engine + Postgres). Built alongside
 * the spine (an un-drained worker orphans a job; the concept makes at-least-once + idempotent binding):
 *
 *  1. CONCURRENCY CAP — the worker runs at most `workerConcurrency` `runAgentJob`s at once (the
 *     semaphore discipline, DBOS-native via `registerQueue({workerConcurrency})`). Asserted on the REAL
 *     engine: enqueue 4 GATED runs under a cap of 2 → peak in-flight concurrency is exactly 2, not 4.
 *  2. GRACEFUL DRAIN — `shutdown()` finishes in-flight work and stops dequeuing. Asserted: a run that is
 *     in flight when shutdown begins COMPLETES (its run header persists) before shutdown resolves; no
 *     new run is dequeued after the drain starts.
 *  3. CROSS-TENANT DEQUEUE — tenant B can never observe tenant A's job: the worker binds `forTenant`
 *     per job and every read is tenant-scoped, so a tenant-B-scoped read of A's runId yields ZERO rows.
 *  4. OBSERVABILITY — `getRunObservability` surfaces a run's status + step/event counts derived purely
 *     from the already-persisted journal/run_events (no new store); a foreign runId reads `exists:false`.
 *
 * Each is a real assertion against the real engine — not a shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DETERMINISM (the prior per-test executor churn was a false-green hazard).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The earlier version built a NEW executor + a NEW throwaway sys DB PER TEST and `deregisterOnShutdown`-ed
 * the PROCESS-GLOBAL DBOS singleton four times — which RACED (duplicate-DB create, "code registered after
 * launch", `DROP DATABASE WITH (FORCE)` terminating a still-live engine) and could corrupt DBOS global
 * state for the next-ordered file, so the security file (executor-taint.db.test.ts) could fail or be
 * silently skipped (a skip reads as a passing file = false-green on the quarantine invariant). This file
 * now follows the SAFE pattern:
 *   - cross-tenant (#3) + observability (#4) share ONE executor (beforeAll/afterAll, per-test TRUNCATE);
 *   - the concurrency-cap (#1) and graceful-drain (#2) tests genuinely need lifecycle control (a custom
 *     workerConcurrency, and a mid-test shutdown), so each lives in its OWN describe with its OWN single
 *     executor + OWN uniquely-named sys DB — structured so they can never race each other or another file;
 *   - ALL sys-DB + app-schema names are process.pid-suffixed (mirrors packages/server) so a parallel
 *     fork of another file can NEVER collide on the same sys DB / schema;
 *   - teardown AWAITS `exec.shutdown()` (DBOS quiesces the engine) BEFORE dropping the sys DB, and drops
 *     WITHOUT `WITH (FORCE)` (the engine is already down — FORCE is what terminated a lingering live
 *     engine's pool/notification clients and corrupted the next file). Teardown runs in afterAll/finally.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec } from '@rayspec/core';
import { forTenant } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { getRunObservability, type RunJob } from '@rayspec/platform';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbosDurableExecutor, type DbosExecutorDeps, type ResolvedRun } from './executor.js';
import { FakeSpineBackend } from './test-support/fake-backend.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

// File-unique names (pid-suffixed) so a parallel fork of another file can never collide on the same
// sys DB / schema. Each describe that needs its OWN engine adds a distinct sub-suffix.
const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_safe_${PID}`;
const DBOS_SYS_DB_BASE = `rayspec_dbos_safe_${PID}`;
const TENANT_A = '00000000-0000-0000-0000-0000000000ca';
const TENANT_B = '00000000-0000-0000-0000-0000000000cb';

const backend = new FakeSpineBackend();

const baseSpec: AgentSpec = {
  name: 'echo',
  instructions: 'echo',
  model: 'gpt-4.1-mini',
  input: 'placeholder',
  tools: [],
  maxTurns: 4,
};

type DbHandle = ReturnType<typeof makeDbWithSchema>;

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function appBaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the durable-dbos SAFE-half test');
  return url;
}

/** Provision the shared app schema (run tables) + seed the two tenants. Idempotent per file. */
async function provisionSchema(db: DbHandle): Promise<void> {
  await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await db.$client.unsafe(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, 'a', 'a'), ($2, 'b', 'b')`,
    [TENANT_A, TENANT_B],
  );
}

/** Build a started executor against the shared app schema with its OWN uniquely-named sys DB. */
async function makeExecutor(
  db: DbHandle,
  sysSuffix: string,
  workerConcurrency?: number,
): Promise<{ exec: DbosDurableExecutor; sysDb: string }> {
  const sysDb = `${DBOS_SYS_DB_BASE}_${sysSuffix}`;
  // Drop any leftover sys DB from a prior aborted run BEFORE the engine launches (no live engine yet,
  // so a plain drop suffices — no WITH (FORCE) needed here either).
  await dropSysDbSafely(sysDb);
  const deps: DbosExecutorDeps = {
    db,
    resolveRun: (job: RunJob): ResolvedRun => {
      if (job.agentId !== 'echo-agent') throw new Error(`unknown agent '${job.agentId}'`);
      return { backend, spec: baseSpec };
    },
  };
  const exec = new DbosDurableExecutor(deps, {
    name: `rayspec-safe-${sysSuffix}`,
    systemDatabaseUrl: withDbName(appBaseUrl(), sysDb),
    // TEST-ONLY: deregister on shutdown so a FRESH executor (the next describe's) can re-register
    // runAgentJob in the same process (DBOS is a process-global singleton).
    deregisterOnShutdown: true,
    ...(workerConcurrency !== undefined ? { workerConcurrency } : {}),
  });
  await exec.start();
  return { exec, sysDb };
}

/**
 * Shut the executor down (AWAITING DBOS quiescence — the engine's pool/notification clients are torn
 * down), THEN drop the sys DB WITHOUT `WITH (FORCE)`: the engine is already down, so there is no live
 * backend to terminate. (FORCE against a still-live engine is exactly what corrupted the next file.)
 */
async function teardownExecutor(
  exec: DbosDurableExecutor | undefined,
  sysDb: string,
): Promise<void> {
  try {
    if (exec) await exec.shutdown();
  } finally {
    await dropSysDbSafely(sysDb);
  }
}

/** Drop a sys DB with a short retry (a freshly-quiesced DB may briefly still show a closing backend). */
async function dropSysDbSafely(sysDb: string): Promise<void> {
  const admin = postgres(withDbName(appBaseUrl(), 'postgres'), { max: 1 });
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${sysDb}"`);
        return;
      } catch (e) {
        // "being accessed by other users" can linger for a beat after a clean shutdown — retry briefly
        // (NOT WITH FORCE, which would terminate a still-live engine and corrupt the next file).
        if (attempt === 5) throw e;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  } finally {
    await admin.end();
  }
}

async function waitForTerminal(
  exec: DbosDurableExecutor,
  jobId: string,
  ms = 30_000,
): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await exec.status(jobId);
    if (s === 'succeeded' || s === 'failed' || s === 'cancelled') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflow ${jobId} did not reach a terminal status within ${ms}ms`);
}

function resetBackend(): void {
  backend.liveRuns = 0;
  backend.liveConcurrency = 0;
  backend.peakConcurrency = 0;
  backend.gate = undefined;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// #3 + #4 — the steady-state describe: ONE shared executor (default concurrency, no mid-test shutdown),
// per-test TRUNCATE. cross-tenant dequeue + observability never need lifecycle control, so they share it.
// ──────────────────────────────────────────────────────────────────────────────────────────────
describe('SAFE half — cross-tenant dequeue + observability (shared executor)', () => {
  let db: DbHandle;
  let exec: DbosDurableExecutor;
  let sysDb: string;

  beforeAll(async () => {
    db = makeDbWithSchema(appBaseUrl(), APP_SCHEMA);
    await provisionSchema(db);
    const made = await makeExecutor(db, 'shared');
    exec = made.exec;
    sysDb = made.sysDb;
  }, 60_000);

  beforeEach(async () => {
    resetBackend();
    await db.$client.unsafe(
      'TRUNCATE run_events, journal_steps, conversation_items, runs, idempotency_keys CASCADE',
    );
  });

  afterAll(async () => {
    try {
      await teardownExecutor(exec, sysDb);
    } finally {
      await db.$client.end();
    }
  }, 30_000);

  it("cross-tenant: tenant B can NEVER observe tenant A's job (a tenant-B-scoped read of A's runId yields zero rows)", async () => {
    const runId = randomUUID();
    await exec.enqueue(TENANT_A, {
      runId,
      tenantId: TENANT_A,
      agentId: 'echo-agent',
      input: 'a-only',
    });
    expect(await waitForTerminal(exec, runId)).toBe('succeeded');

    const obsA = await getRunObservability(forTenant(db, TENANT_A), runId);
    const obsB = await getRunObservability(forTenant(db, TENANT_B), runId);
    expect(obsA.exists).toBe(true);
    expect(obsA.status).toBe('completed');
    expect(obsB.exists).toBe(false);
    expect(obsB.status).toBeNull();
    expect(obsB.stepCount).toBe(0);
    expect(obsB.eventCount).toBe(0);
  }, 40_000);

  it('observability: surfaces status + step/event counts from the persisted journal/run_events; a foreign runId reads exists:false', async () => {
    const runId = randomUUID();
    await exec.enqueue(TENANT_A, {
      runId,
      tenantId: TENANT_A,
      agentId: 'echo-agent',
      input: 'observe-me',
    });
    expect(await waitForTerminal(exec, runId)).toBe('succeeded');

    const tdb = forTenant(db, TENANT_A);
    const obs = await getRunObservability(tdb, runId);
    expect(obs.exists).toBe(true);
    expect(obs.status).toBe('completed');
    expect(obs.tainted).toBe(false); // no non-idempotent tool fired
    expect(obs.quarantined).toBe(false);
    expect(obs.stepCount).toBeGreaterThanOrEqual(1); // the llm step
    expect(obs.eventCount).toBeGreaterThanOrEqual(2); // run_started … run_completed

    const missing = await getRunObservability(tdb, randomUUID());
    expect(missing.exists).toBe(false);
    expect(missing.status).toBeNull();
  }, 40_000);
});

// ──────────────────────────────────────────────────────────────────────────────────────────────
// #1 — concurrency cap: needs workerConcurrency:2, so its OWN single executor + OWN sys DB.
// ──────────────────────────────────────────────────────────────────────────────────────────────
describe('SAFE half — concurrency cap (own executor, workerConcurrency:2)', () => {
  let db: DbHandle;
  let exec: DbosDurableExecutor;
  let sysDb: string;

  beforeAll(async () => {
    db = makeDbWithSchema(appBaseUrl(), APP_SCHEMA);
    await provisionSchema(db);
    const made = await makeExecutor(db, 'cap', 2);
    exec = made.exec;
    sysDb = made.sysDb;
  }, 60_000);

  beforeEach(async () => {
    resetBackend();
    await db.$client.unsafe(
      'TRUNCATE run_events, journal_steps, conversation_items, runs, idempotency_keys CASCADE',
    );
  });

  afterAll(async () => {
    backend.releaseGate();
    try {
      await teardownExecutor(exec, sysDb);
    } finally {
      await db.$client.end();
    }
  }, 30_000);

  it('the worker-concurrency cap BOUNDS concurrent runs (4 gated runs under a cap of 2 → peak 2, not 4)', async () => {
    backend.armGate(); // every run blocks at the gate until released → they pile up to the cap
    const jobs = [0, 1, 2, 3].map((i) => ({
      runId: randomUUID(),
      tenantId: TENANT_A,
      agentId: 'echo-agent',
      input: `cap-${i}`,
    }));
    for (const j of jobs) await exec.enqueue(TENANT_A, j);

    // Poll until the cap is saturated (2 runs in flight) — the worker must NOT exceed it.
    const deadline = Date.now() + 10_000;
    while (backend.liveConcurrency < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // Give any (incorrect) over-admission a chance to manifest before asserting the peak.
    await new Promise((r) => setTimeout(r, 300));
    expect(backend.peakConcurrency).toBe(2); // exactly the cap — never 4

    backend.releaseGate();
    for (const j of jobs) await waitForTerminal(exec, j.runId);
    expect(backend.liveRuns).toBe(4); // all four eventually ran (the cap throttles, never drops)
  }, 40_000);
});

// ──────────────────────────────────────────────────────────────────────────────────────────────
// #2 — graceful drain: calls shutdown() MID-TEST, so its OWN single executor + OWN sys DB. afterAll
// only drops the sys DB (the test already shut the executor down; teardownExecutor tolerates a
// second shutdown via the executor's #started guard).
// ──────────────────────────────────────────────────────────────────────────────────────────────
describe('SAFE half — graceful drain (own executor; shutdown() mid-test)', () => {
  let db: DbHandle;
  let exec: DbosDurableExecutor;
  let sysDb: string;

  beforeAll(async () => {
    db = makeDbWithSchema(appBaseUrl(), APP_SCHEMA);
    await provisionSchema(db);
    const made = await makeExecutor(db, 'drain', 2);
    exec = made.exec;
    sysDb = made.sysDb;
  }, 60_000);

  beforeEach(async () => {
    resetBackend();
    await db.$client.unsafe(
      'TRUNCATE run_events, journal_steps, conversation_items, runs, idempotency_keys CASCADE',
    );
  });

  afterAll(async () => {
    backend.releaseGate();
    try {
      // The test calls exec.shutdown() itself; teardownExecutor's shutdown is a no-op then (#started
      // guard), and it drops the sys DB without WITH (FORCE).
      await teardownExecutor(exec, sysDb);
    } finally {
      await db.$client.end();
    }
  }, 30_000);

  it('shutdown() finishes an in-flight run before resolving (the run header persists; no orphan)', async () => {
    let shutdownDone = false;
    backend.armGate();
    const runId = randomUUID();
    await exec.enqueue(TENANT_A, {
      runId,
      tenantId: TENANT_A,
      agentId: 'echo-agent',
      input: 'drain-me',
    });
    // Wait until the run is genuinely in flight (holding work at the gate).
    const deadline = Date.now() + 10_000;
    while (backend.liveConcurrency < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(backend.liveConcurrency).toBe(1);

    // Begin shutdown WHILE the run is in flight; release the gate a beat later so the run can finish.
    const shutdownP = exec.shutdown().then(() => {
      shutdownDone = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    backend.releaseGate();
    await shutdownP;
    expect(shutdownDone).toBe(true);

    // GRACEFUL DRAIN: the in-flight run COMPLETED before shutdown resolved — its header persisted.
    const tdb = forTenant(db, TENANT_A);
    const obs = await getRunObservability(tdb, runId);
    expect(obs.exists).toBe(true);
    expect(obs.status).toBe('completed'); // not orphaned mid-run
  }, 40_000);
});
