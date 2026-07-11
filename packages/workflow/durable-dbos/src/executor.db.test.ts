/**
 * The DBOS durable-execution spine — DB-backed integration test.
 *
 * Launches the REAL DBOS engine (against the local Postgres + a throwaway DBOS SYSTEM database that
 * DBOS auto-creates) and proves the spine on GROUND TRUTH (fail-the-fix, not pass-the-shape):
 *
 *  1. `enqueue` a RunJob → the `runAgentJob` workflow runs the EXISTING `runAgent` OFF-REQUEST (the
 *     enqueue returns immediately; the run completes asynchronously on the worker) → status maps
 *     enqueued → succeeded.
 *  2. The run executes inside `forTenant(db, tenantId).transaction()` — the `app.current_tenant` GUC
 *     is POPULATED during the run (asserted by a read-back from inside a journaled step's own tx is
 *     hard; instead we assert the durable EFFECT: the journal/run_events/run header all persist
 *     tenant-scoped under the run, which is what the GUC-wrapped tx commits).
 *  3. The run header + journal steps + run_events persist (the resumable read path is populated).
 *  4. The SAFETY GUARD: a workflow body whose `run_started` marker ALREADY exists (the
 *     recovery-of-an-already-started-run case) FAILS terminally and does NOT re-run `runAgent` (no
 *     silent non-idempotent re-fire). Asserted by pre-seeding the marker + asserting liveRuns stays 0.
 *  5. Engine-level idempotency: enqueueing the SAME runId twice runs `runAgent` exactly ONCE.
 *  6. CRASH-MID-TX recovery (fix I): a backend that throws INSIDE runAgent (after the reserve marker
 *     committed, mid-run) → the marker SURVIVES runAgent's tx rollback → a same-runId re-enqueue does
 *     NOT re-run runAgent (the started-once guard holds; liveRuns delta 0, terminal-failed).
 *
 * HONEST SCOPE (behavior-verified vs doc-verified): these tests drive the REAL engine via
 * `enqueue` + an in-step throw — they BEHAVIORALLY verify the started-once guard, the marker-outside-
 * runAgent's-tx commit, the GUC-populated tx, and engine-level workflow-id idempotency. They do NOT
 * kill and restart the host PROCESS, so DBOS's launch-time crash-RECOVERY re-dispatch (a process dies
 * mid-workflow, restarts, and DBOS re-invokes the incomplete workflow) is DOC-verified against the
 * installed 4.21.6 (`system_database.js` recovery + `maxRecoveryAttempts`), not exercised here. A real
 * process-crash recovery test is out of scope here. The marker-survives-rollback test (#6) is the strongest
 * available proxy: it proves the guard refuses a SECOND execution of an already-started run, which is
 * exactly what a recovery re-dispatch would trigger.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec } from '@rayspec/core';
import { type Db, forTenant, schema, TENANT_GUC } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { RUN_TAINT_SCOPE, type RunJob } from '@rayspec/platform';
import { config as loadDotenv } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DbosDurableExecutor,
  type DbosExecutorDeps,
  type ResolvedRun,
  RUN_STARTED_SCOPE,
} from './executor.js';
import { FakeSpineBackend } from './test-support/fake-backend.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

// Ensure DATABASE_URL is present even if the runner's cwd differs (mirror the package setup file).
const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

// File-unique (pid-suffixed) names so a parallel fork of another file can never collide on the same
// sys DB / app schema (fix A — the cross-file false-green hazard).
const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_spine_${PID}`;
const DBOS_SYS_DB = `rayspec_dbos_spine_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000aa';

const backend = new FakeSpineBackend();

/** The base spec the resolver returns for the single declared agent. */
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

/**
 * Captures the `app.current_tenant` GUC value read INSIDE the run's own `tdb.transaction()` body —
 * deliverable-2 proof that the off-request run executes inside the GUC-populated transaction
 * (RLS-ready). Reset per test; written by the wrapDb proxy below.
 */
const capturedGuc: { value: string | null } = { value: null };

/**
 * Wrap the raw Db so the executor's `forTenant(db, tenantId).transaction(...)` body is OBSERVED:
 * after TenantDb's `set_config(app.current_tenant, …)` runs (inside the same tx) and the inner body
 * (runAgent) runs, read `current_setting` on the SAME tx handle (the GUC read-back pattern). Proves
 * the GUC is actually populated during the off-request run — not merely that we call `.transaction()`.
 */
function wrapDb(raw: Db): Db {
  const realTransaction = raw.transaction.bind(raw);
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (inner: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          realTransaction(
            async (tx: unknown) => {
              const r = await inner(tx);
              const rows = (await (tx as Db).execute(
                sql`select current_setting(${TENANT_GUC}, true) as tenant`,
              )) as unknown as Array<{ tenant: string | null }>;
              capturedGuc.value = rows[0]?.tenant ?? null;
              return r;
            },
            ...(rest as []),
          ) as unknown;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
}

/** Build the DBOS system DB url by swapping the db name (the composition root does the same). */
function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Drop a sys DB WITHOUT `WITH (FORCE)` (fix A): a FORCE drop terminates a still-live engine's
 * pool/notification clients and can corrupt DBOS global state for the next-ordered file. Called only
 * when no live engine should be attached (before launch / after a clean shutdown), with a short retry.
 */
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

/**
 * Probe whether ANYTHING accepts a TCP connection on `127.0.0.1:port`. Resolves to:
 *  - 'connected'  — a listener accepted the connection (a socket IS bound: the failure case);
 *  - 'refused'    — the OS refused the connection (ECONNREFUSED → NO listener bound: the pass case);
 *  - 'unreachable'— any other connect error (e.g. EHOSTUNREACH) — also counts as "no listener here".
 * Deterministic: a hard connect timeout caps the wait; we destroy the socket on every outcome so the
 * probe leaks no fd. We assert on the EXPLICIT 'refused' below (the churn-proof signal) rather than a
 * timeout, so a future SDK that re-binds 3001 makes the test go RED via 'connected', not flaky.
 */
function probePort(
  port: number,
  timeoutMs = 1_000,
): Promise<'connected' | 'refused' | 'unreachable'> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const settle = (outcome: 'connected' | 'refused' | 'unreachable') => {
      sock.destroy();
      resolve(outcome);
    };
    sock.setTimeout(timeoutMs, () => settle('unreachable'));
    sock.once('connect', () => settle('connected'));
    sock.once('error', (err: NodeJS.ErrnoException) =>
      settle(err.code === 'ECONNREFUSED' ? 'refused' : 'unreachable'),
    );
  });
}

/** Poll the executor's neutral status until terminal (succeeded/failed/cancelled) or the deadline. */
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
  if (!url) throw new Error('DATABASE_URL required for the durable-dbos spine test');
  appBaseUrl = url;
  dbosSystemUrl = withDbName(url, DBOS_SYS_DB);

  // Drop any leftover DBOS system DB from a prior run so DBOS bootstraps it clean (no live engine yet).
  await dropSysDbSafely(url, DBOS_SYS_DB);

  // The app DB handle pinned to an isolated schema (the run's journal/run_events land here). DBOS's
  // own system DB is SEPARATE (dbosSystemUrl) — it never touches this app schema.
  db = makeDbWithSchema(url, APP_SCHEMA);
  await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'spine', 'spine')`, [
    TENANT,
  ]);

  const deps: DbosExecutorDeps = {
    // The executor runs on the WRAPPED db so the run's tdb.transaction() GUC is observed (deliverable
    // 2). The DDL above ran on the UNWRAPPED handle; only the run path sees the proxy.
    db: wrapDb(db),
    resolveRun: (job: RunJob): ResolvedRun => {
      if (job.agentId !== 'echo-agent') {
        throw new Error(`unknown agent '${job.agentId}'`);
      }
      return { backend, spec: baseSpec };
    },
  };
  executor = new DbosDurableExecutor(deps, {
    name: `rayspec-spine-${PID}`,
    systemDatabaseUrl: dbosSystemUrl,
  });
  await executor.start();
}, 60_000);

beforeEach(async () => {
  backend.liveRuns = 0;
  backend.throwMidRunTimes = 0;
  capturedGuc.value = null;
  // Clean the app tables between tests (orgs cascade keeps the tenant row; clear the run data).
  await db.$client.unsafe(
    'TRUNCATE run_events, journal_steps, conversation_items, runs, idempotency_keys CASCADE',
  );
});

afterAll(async () => {
  // AWAIT the engine shutdown BEFORE dropping the sys DB (the engine is then down — no FORCE needed).
  try {
    await executor.shutdown();
  } finally {
    await db.$client.end();
    await dropSysDbSafely(appBaseUrl, DBOS_SYS_DB);
  }
}, 30_000);

describe('DBOS durable spine — runAgent off-request', () => {
  it('the REAL launched engine binds NO admin HTTP listener on :3001 (runAdminServer:false, churn-proof)', async () => {
    // The executor is ALREADY launched (beforeAll did a real executor.start() → DBOS.launch()). By
    // default DBOS.launch() binds an UNAUTHENTICATED admin HTTP server on :3001 (all interfaces); the
    // executor passes `runAdminServer:false` to suppress it (security — DEPLOY-01). The committed
    // admin-server-disabled.test.ts STUBS DBOS.launch, so it only proves the FLAG is set, not that no
    // socket binds. This probes the LIVE process: with the real engine running, NOTHING accepts a
    // connection on :3001. It is fail-the-fix: remove `runAdminServer:false` from executor.ts and the
    // SDK default re-binds :3001 → this probe returns 'connected' → RED. (Asserts the explicit OS
    // 'refused' — the churn-proof no-listener signal — not a timeout.)
    const outcome = await probePort(3001);
    expect(outcome).toBe('refused');
  });

  it('enqueue → runAgentJob runs runAgent OFF-REQUEST → journal + run_events + header persist', async () => {
    const runId = randomUUID();
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'hello world' };

    const { jobId } = await executor.enqueue(TENANT, job);
    expect(jobId).toBe(runId); // the durable workflowID IS the pre-minted runId

    const status = await waitForTerminal(jobId);
    expect(status).toBe('succeeded');
    // runAgent ran exactly once, off-request (the enqueue returned before this completed).
    expect(backend.liveRuns).toBe(1);

    // Deliverable 2: the off-request run executed inside forTenant(db,tenantId).transaction() with the
    // app.current_tenant GUC POPULATED to this tenant (RLS-ready) — read back from inside the run's own
    // tx by the wrapDb proxy. Not blind: a run NOT wrapped in tdb.transaction() would leave this null.
    expect(capturedGuc.value).toBe(TENANT);

    // The run HEADER persisted (tenant-scoped), status completed, the final text from the fake run.
    const tdb = forTenant(db, TENANT);
    const headers = (await tdb.select(schema.runs).where(eq(schema.runs.runId, runId))) as Array<{
      status: string;
      finalText: string | null;
      agentName: string;
    }>;
    expect(headers).toHaveLength(1);
    expect(headers[0]!.status).toBe('completed');
    expect(headers[0]!.finalText).toBe('echo: hello world');
    expect(headers[0]!.agentName).toBe('echo');

    // The journal recorded the llm step; run_events holds the durable, resumable stream.
    const steps = await db.$client.unsafe('SELECT type FROM journal_steps WHERE run_id = $1', [
      runId,
    ]);
    expect(steps.some((s: { type: string }) => s.type === 'llm')).toBe(true);

    const events = await db.$client.unsafe(
      'SELECT seq::int AS seq, type FROM run_events WHERE run_id = $1 ORDER BY seq',
      [runId],
    );
    const types = events.map((e: { type: string }) => e.type);
    expect(types[0]).toBe('run_started');
    expect(types[types.length - 1]).toBe('run_completed');
    // The single seq authority is contiguous from 0 (run-core stampSeq, unchanged off-request).
    const seqs = events.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it('the started-once safety guard (TAINT-AWARE): a recovery of an already-started TAINTED run FAILS without re-running runAgent', async () => {
    // Simulate "a recovery of an already-started run that fired a non-idempotent tool": pre-seed BOTH
    // the run_started marker AND the run_taint marker for this runId (as the FIRST attempt would have
    // committed before crashing — the taint marker on its own autonomous connection). Under the
    // TAINT-AWARE guard, the workflow body loses the run_started reserve, sees the run is TAINTED, and
    // REFUSES to re-run → throws DurableRunNotRetriedError → status 'failed', runAgent NOT re-run.
    // (An UNTAINTED already-started run is now ALLOWED to re-run — covered by executor-taint.db.test.ts.)
    const runId = randomUUID();
    const tdb = forTenant(db, TENANT);
    await tdb
      .insert(schema.idempotencyKeys, {
        scope: RUN_STARTED_SCOPE,
        idemKey: runId,
        bodyHash: runId,
        snapshot: { runId },
      })
      .onConflictDoNothing();
    await tdb
      .insert(schema.idempotencyKeys, {
        scope: RUN_TAINT_SCOPE,
        idemKey: runId,
        bodyHash: 'run_taint_marker',
        snapshot: { runId },
      })
      .onConflictDoNothing();

    const job: RunJob = {
      runId,
      tenantId: TENANT,
      agentId: 'echo-agent',
      input: 'should not re-run',
    };
    const { jobId } = await executor.enqueue(TENANT, job);
    const status = await waitForTerminal(jobId);

    // The quarantine fired: the tainted run is terminal-FAILED and runAgent was NEVER called (no re-fire).
    expect(status).toBe('failed');
    expect(backend.liveRuns).toBe(0);
    // No run header was written (runAgent never ran).
    const headers = await db.$client.unsafe('SELECT 1 FROM runs WHERE run_id = $1', [runId]);
    expect(headers).toHaveLength(0);
  });

  it('engine idempotency: enqueueing the SAME runId twice runs runAgent exactly ONCE', async () => {
    const runId = randomUUID();
    const job: RunJob = { runId, tenantId: TENANT, agentId: 'echo-agent', input: 'once only' };

    const first = await executor.enqueue(TENANT, job);
    const second = await executor.enqueue(TENANT, job);
    expect(first.jobId).toBe(second.jobId); // same workflowID

    await waitForTerminal(first.jobId);
    // Give any (incorrect) second execution a moment — then assert runAgent ran exactly once.
    await new Promise((r) => setTimeout(r, 200));
    expect(backend.liveRuns).toBe(1);
    const headers = await db.$client.unsafe('SELECT 1 FROM runs WHERE run_id = $1', [runId]);
    expect(headers).toHaveLength(1);
  });

  it('crash-mid-tx recovery: the run_started marker SURVIVES runAgent tx rollback → a re-enqueue does NOT re-run runAgent (fix I, fail-the-fix)', async () => {
    // The backend throws INSIDE runAgent (after the reserve marker committed, mid-run) on the FIRST
    // invocation — exactly a crash inside the run's own tdb.transaction() (the run header/journal
    // write rolls back). The started-once marker is reserved BEFORE that tx, so it MUST survive the
    // rollback. This is fail-the-fix: moving the reserve INSIDE tdb.transaction() would roll the
    // marker back too → the marker would be ABSENT and a re-enqueue WOULD re-run runAgent.
    const runId = randomUUID();
    backend.throwMidRunTimes = 1; // throw on the first run only; a (hypothetical) re-run would succeed
    const job: RunJob = {
      runId,
      tenantId: TENANT,
      agentId: 'echo-agent',
      input: 'crash mid-run',
    };

    const first = await executor.enqueue(TENANT, job);
    const firstStatus = await waitForTerminal(first.jobId);
    expect(firstStatus).toBe('failed'); // the throw made the workflow terminal-failed
    expect(backend.liveRuns).toBe(1); // runAgent was entered exactly once (it threw)

    // (a) The run_started marker IS present despite the throw — proving the reserve committed OUTSIDE
    //     runAgent's (rolled-back) tx. If the reserve were inside that tx, this row would be gone.
    const markers = await db.$client.unsafe(
      'SELECT 1 FROM idempotency_keys WHERE tenant_id = $1 AND scope = $2 AND idem_key = $3',
      [TENANT, RUN_STARTED_SCOPE, runId],
    );
    expect(markers).toHaveLength(1);
    // The run header did NOT persist (runAgent's tx rolled back on the throw).
    const headersAfterCrash = await db.$client.unsafe('SELECT 1 FROM runs WHERE run_id = $1', [
      runId,
    ]);
    expect(headersAfterCrash).toHaveLength(0);

    // (b) A same-runId re-enqueue must NOT re-invoke runAgent: the started-once guard loses the
    //     reserve (marker already present) → DurableRunNotRetriedError → terminal-failed, runAgent
    //     NEVER re-entered (liveRuns stays 1, NOT 2 — even though throwMidRunTimes is now 0 so a
    //     re-run WOULD have succeeded). This is the safety invariant: a crashed run is never re-fired.
    const second = await executor.enqueue(TENANT, { ...job, runId });
    const secondStatus = await waitForTerminal(second.jobId);
    // Same workflowID re-enqueue: DBOS may short-circuit to the existing terminal status, OR the
    // started-once guard refuses a re-execution — either way runAgent is NOT re-entered and the run
    // is terminal-failed. The load-bearing assertion is liveRuns delta === 0.
    expect(secondStatus).toBe('failed');
    expect(backend.liveRuns).toBe(1); // delta 0 — runAgent was NOT re-run (no silent re-fire)
  });
});
