/**
 * THE APPLICATION-VERSION FENCE, MEASURED IN THE DIRECTION THAT CARRIES THE SAFETY PROPERTY (#359).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE OTHER PINS COVER, AND WHAT THEY CANNOT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `app-version-fence.test.ts` proves the FORWARDING: a configured `applicationVersion` reaches
 * `DBOS.setConfig` verbatim, and no key is sent when none is configured. `workflow-executor.db.test.ts`
 * proves the value LANDS in `dbos.workflow_status.application_version`. Together they say the fence is
 * WIRED. Neither says it FENCES — that a row stamped with ANOTHER deployment's version is not claimed
 * by this one. That is the direction a regression breaks silently: two deployments would simply run
 * each other's jobs while every forwarding and column assertion stayed green.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE STAGES — TWO DEPLOYMENTS, ONE SYSTEM DATABASE, ONE QUEUE NAME.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DBOS's config and launch state are PROCESS-GLOBAL: `DBOS.setConfig` asserts the engine is not
 * launched (dbos.js:139) and `DBOS.shutdown` resets `globalParams.appVersion` (dbos.js:306). One
 * process therefore holds exactly one version at a time, so the two deployments run SEQUENTIALLY
 * against the SAME throwaway system database — the shared job pool the fence has to separate. What
 * the sequencing costs is only wall-clock overlap; the dequeue predicate this measures reads a
 * COLUMN, not a clock.
 *
 *   Deployment A boots on {@link DOC_VERSION_A} with `workerConcurrency:1` and holds one run in
 *   flight at the backend gate. That pins its only slot: `findAndMarkStartableWorkflows` computes
 *   `maxTasks = workerConcurrency - localRunningForQueue` and returns with no claim once it hits 0
 *   (system_database.js:1793-1810), so the NEXT job A enqueues is stamped with A's version and left
 *   ENQUEUED — exactly the row a live deployment leaves behind. A's shutdown then stops the queue
 *   runner BEFORE it drains the in-flight run (`deactivateEventReceivers()` aborts the dispatch loops
 *   and awaits them, dbos-executor.js:737-759, and only then does `destroy()` await running
 *   workflows), so the gate is released only after nothing can dequeue any more.
 *
 *   Deployment B then boots on {@link DOC_VERSION_B} against that SAME system database and enqueues
 *   its own job.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ACCEPT CONTROL IS PART OF THE MEASUREMENT, NOT DECORATION.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A worker that dequeues NOTHING — a mis-registered queue, an engine that never launched, a harness
 * that enqueued onto the wrong name — looks exactly like a perfect fence. So B's own job must RUN to
 * SUCCESS in the same window, and every null reading taken on the foreign row is taken again on the
 * control row, where it must read POSITIVE. A `0` is only evidence next to the `1` beside it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * FAIL-THE-FIX.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Remove the `applicationVersion` spread from `DbosDurableExecutor.start()` and both launches fall
 * back to DBOS's own value: an md5 over the source of the registered workflow functions plus the SDK
 * version (`computeAppVersion`, dbos-executor.js:887-898), recomputed each launch because shutdown
 * resets the global to `''`. Both deployments here register the SAME closure source, so both compute
 * the SAME string, B claims A's row, and the guard below goes red on its own assertion.
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
import {
  DbosDurableExecutor,
  type DbosExecutorDeps,
  type ResolvedRun,
  RUN_STARTED_SCOPE,
} from './executor.js';
import { FakeSpineBackend } from './test-support/fake-backend.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

// File-unique (pid-suffixed) names so a parallel fork of another file can never collide.
const PID = process.pid;
const APP_SCHEMA = `rayspec_test_dbos_fence_${PID}`;
/** ONE system database for BOTH deployments — sharing it is the whole point of the measurement. */
const DBOS_SYS_DB = `rayspec_dbos_fence_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000fe';

/**
 * The two document versions. Shape matches what `deriveDbosApplicationVersion` emits (`doc-` + 16 hex
 * chars) so the values exercise the same string lengths a real deployment carries into the column and
 * into DBOS's `application_name`; the digests themselves are fixtures, not derived.
 */
const DOC_VERSION_A = 'doc-a11a11a11a11a11a';
const DOC_VERSION_B = 'doc-b22b22b22b22b22b';

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
let db: DbHandle;
/** Deployment B, kept on the module so `afterAll` can tear it down if a test aborts mid-way. */
let deploymentB: DbosDurableExecutor | undefined;

/** What deployment A stamped on the row it left ENQUEUED, and what B reported as its live identity. */
let stampedOnForeignRow: string | undefined;
let liveVersionOfB: string | undefined;

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function appBaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL required for the durable-dbos application-version fence test');
  }
  return url;
}

/** Drop the shared sys DB with a short retry (a freshly-quiesced DB can briefly show a closing backend). */
async function dropSysDbSafely(): Promise<void> {
  const admin = postgres(withDbName(appBaseUrl(), 'postgres'), { max: 1 });
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}"`);
        return;
      } catch (e) {
        // NOT `WITH (FORCE)`: forcing a drop against a still-live engine is what has corrupted the
        // next-ordered file before. Retry briefly instead — both engines here shut down cleanly.
        if (attempt === 5) throw e;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  } finally {
    await admin.end();
  }
}

/**
 * Boot one deployment: its own DBOS application name and application version, the SHARED system
 * database, and a single worker slot (what lets a gated run leave the next enqueue ENQUEUED).
 * `deregisterOnShutdown` is the TEST-ONLY flag that lets the second deployment re-register
 * `runAgentJob` in this process after the first has gone.
 */
async function bootDeployment(
  documentName: string,
  applicationVersion: string,
): Promise<DbosDurableExecutor> {
  const deps: DbosExecutorDeps = {
    db,
    resolveRun: (job: RunJob): ResolvedRun => {
      if (job.agentId !== 'echo-agent') throw new Error(`unknown agent '${job.agentId}'`);
      return { backend, spec: baseSpec };
    },
  };
  const exec = new DbosDurableExecutor(deps, {
    name: documentName,
    systemDatabaseUrl: withDbName(appBaseUrl(), DBOS_SYS_DB),
    applicationVersion,
    workerConcurrency: 1,
    deregisterOnShutdown: true,
  });
  await exec.start();
  return exec;
}

/** Read a workflow's DBOS row straight out of the shared system database (ground truth, not an API). */
async function readDbosRow(
  workflowId: string,
): Promise<{ status: string; applicationVersion: string | null } | undefined> {
  const sys = postgres(withDbName(appBaseUrl(), DBOS_SYS_DB), { max: 1 });
  try {
    const rows = await sys.unsafe(
      'SELECT status, application_version FROM dbos.workflow_status WHERE workflow_uuid = $1',
      [workflowId],
    );
    const row = rows[0] as { status: string; application_version: string | null } | undefined;
    return row ? { status: row.status, applicationVersion: row.application_version } : undefined;
  } finally {
    await sys.end();
  }
}

/** How many rows the given table holds for a runId — the app-side trace a dequeued job leaves. */
async function countFor(sql: string, params: unknown[]): Promise<number> {
  const rows = await db.$client.unsafe(sql, params as never[]);
  const row = rows[0] as { n: string } | undefined;
  if (!row) throw new Error(`count query returned no row: ${sql}`);
  return Number(row.n);
}

/** The `run_started` marker the workflow body reserves BEFORE it runs anything — its earliest write. */
function countStartedMarkers(runId: string): Promise<number> {
  return countFor(
    'SELECT count(*) AS n FROM idempotency_keys WHERE tenant_id = $1 AND scope = $2 AND idem_key = $3',
    [TENANT, RUN_STARTED_SCOPE, runId],
  );
}

/** The `runs` header run-core writes for a run that actually executed. */
function countRunHeaders(runId: string): Promise<number> {
  return countFor('SELECT count(*) AS n FROM runs WHERE tenant_id = $1 AND run_id = $2', [
    TENANT,
    runId,
  ]);
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

async function waitForLiveRun(ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (backend.liveConcurrency < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (backend.liveConcurrency < 1) {
    throw new Error('the gating run never reached the backend — the worker did not dequeue it');
  }
}

beforeAll(async () => {
  await dropSysDbSafely(); // a leftover sys DB from an aborted run must not seed this measurement
  db = makeDbWithSchema(appBaseUrl(), APP_SCHEMA);
  await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'fence', 'fence')`, [
    TENANT,
  ]);
}, 60_000);

afterAll(async () => {
  backend.releaseGate();
  try {
    if (deploymentB) await deploymentB.shutdown();
  } finally {
    try {
      const admin = postgres(appBaseUrl(), { max: 1 });
      try {
        await admin.unsafe(`DROP SCHEMA IF EXISTS "${APP_SCHEMA}" CASCADE`);
      } finally {
        await admin.end();
      }
      await db.$client.end();
    } finally {
      await dropSysDbSafely();
    }
  }
}, 60_000);

describe('the durable fence refuses work stamped with a foreign document version', () => {
  it('deployment B runs its OWN queued job and NEVER dequeues the row deployment A left behind', async () => {
    // ── Deployment A: leave one ENQUEUED row stamped with A's version ────────────────────────────
    const deploymentA = await bootDeployment('rayspec-fence-doc-a', DOC_VERSION_A);
    const foreignRunId = randomUUID();
    try {
      backend.armGate();
      const gatingRunId = randomUUID();
      await deploymentA.enqueue(TENANT, {
        runId: gatingRunId,
        tenantId: TENANT,
        agentId: 'echo-agent',
        input: 'holds-the-single-slot',
      });
      await waitForLiveRun(); // the one worker slot is now occupied

      // Enqueued behind the occupied slot: DBOS stamps it with A's version and leaves it ENQUEUED.
      await deploymentA.enqueue(TENANT, {
        runId: foreignRunId,
        tenantId: TENANT,
        agentId: 'echo-agent',
        input: 'belongs-to-deployment-a',
      });

      // Stop A. The queue runner is aborted and awaited FIRST, so releasing the gate afterwards frees
      // the slot into an engine that can no longer claim anything.
      const shuttingDown = deploymentA.shutdown();
      await new Promise((r) => setTimeout(r, 750));
      backend.releaseGate();
      await shuttingDown;
    } finally {
      backend.releaseGate();
    }

    // STAGING PRECONDITION — asserted, not assumed. If A had drained this row the rest of the test
    // would measure nothing at all.
    const staged = await readDbosRow(foreignRunId);
    expect(staged?.status).toBe('ENQUEUED');
    stampedOnForeignRow = staged?.applicationVersion ?? undefined;

    // ── Deployment B: a DIFFERENT document version, the SAME system database ─────────────────────
    deploymentB = await bootDeployment('rayspec-fence-doc-b', DOC_VERSION_B);
    liveVersionOfB = deploymentB.identity().applicationVersion;

    // THE ACCEPT CONTROL. B's own job is enqueued AFTER A's row already exists, and the dequeue
    // ordering is `priority ASC, created_at ASC` (system_database.js:1826) — so an unfenced B would
    // reach the older foreign row FIRST. The control succeeding therefore proves the worker was live
    // and polling this very queue while the foreign row sat in front of it.
    const controlRunId = randomUUID();
    await deploymentB.enqueue(TENANT, {
      runId: controlRunId,
      tenantId: TENANT,
      agentId: 'echo-agent',
      input: 'belongs-to-deployment-b',
    });
    expect(await waitForTerminal(deploymentB, controlRunId)).toBe('succeeded');

    // A further grace window on top of the control's own round trip, so a merely SLOW claim of the
    // foreign row cannot read as a refused one.
    await new Promise((r) => setTimeout(r, 4_000));

    // ── The guard ────────────────────────────────────────────────────────────────────────────────
    // Every reading below is taken on BOTH rows. The control's positive is the instrument check that
    // makes the foreign row's zero mean "refused" rather than "the query looks in the wrong place".
    const foreignAfter = await readDbosRow(foreignRunId);
    const controlAfter = await readDbosRow(controlRunId);
    expect(controlAfter?.status).toBe('SUCCESS');
    expect(foreignAfter?.status).toBe('ENQUEUED'); // never claimed: no PENDING, no terminal status

    expect(backend.realRunsFor(controlRunId)).toBe(1);
    expect(backend.realRunsFor(foreignRunId)).toBe(0); // the workflow body was never entered

    expect(await countStartedMarkers(controlRunId)).toBe(1);
    expect(await countStartedMarkers(foreignRunId)).toBe(0); // not even the body's FIRST write happened

    expect(await countRunHeaders(controlRunId)).toBe(1);
    expect(await countRunHeaders(foreignRunId)).toBe(0);
  }, 120_000);

  it('the two deployments held DIFFERENT versions, which is why the row was refused', async () => {
    // The reason the guard above holds, recorded separately from the guard itself: the column on the
    // refused row carries deployment A's document version, the live engine that skipped it carries
    // B's, and DBOS's predicate (`application_version IS NULL OR application_version = $3`,
    // system_database.js:1824) admits neither NULL nor a match between them.
    expect(stampedOnForeignRow).toBe(DOC_VERSION_A);
    expect(liveVersionOfB).toBe(DOC_VERSION_B);
    expect(stampedOnForeignRow).not.toBe(liveVersionOfB);
  });
});
