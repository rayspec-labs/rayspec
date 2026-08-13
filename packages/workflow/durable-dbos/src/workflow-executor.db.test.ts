/**
 * The DBOS durable path for the WORKFLOW runtime — DB-backed integration test.
 *
 * Launches the REAL DBOS engine (shared `DbosDurableExecutor` launch + the attached
 * `DbosWorkflowExecutor`) against the local Postgres + a throwaway DBOS SYSTEM db, and proves the
 * workflow spine on GROUND TRUTH:
 *  1. `enqueueWorkflowRun` → `runWorkflowJob` runs `engine.execute` OFF-REQUEST → workflow_runs +
 *     workflow_node_states + workflow_artifacts persist; status maps enqueued → succeeded.
 *  2. SINGLE-FLIGHT: enqueueing the SAME (tenant, workflow, idempotency) twice — the DBOS
 *     workflowID is the tenant-namespaced durableWorkflowRunId — runs the engine (and its nodes)
 *     EXACTLY once (a node counter proves it), and the second enqueue reports deduped.
 *  3. FENCE: the `applicationVersion` the executor is booted with lands in the DBOS system database's
 *     `workflow_status.application_version` — the column DBOS's dequeue predicate is scoped by.
 *  4. TERMINAL JOURNAL: a job whose resolver THROWS still gets a `workflow_runs` row, settled at
 *     `terminal_failure`, plus the one log line — and the original resolver error still fails the job.
 *  5. …and that write NEVER overwrites a header an earlier execution of the same run wrote: a
 *     pre-seeded `running` header with real attempts survives the resolve failure untouched.
 *
 * Booted like executor.db.test.ts (drop sys db → makeDbWithSchema → spine+workflow DDL → one launch).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, forTenant } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import {
  CapabilityRegistry,
  type WorkflowInputEvent,
  type WorkflowSpec,
} from '@rayspec/foundation';
import { createArtifactPersistHandler } from '@rayspec/grounding-runtime';
import type { RunJob } from '@rayspec/platform';
import { durableWorkflowRunId, TenantDbArtifactStore } from '@rayspec/workflow-durable';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbosDurableExecutor, type DbosExecutorDeps, type ResolvedRun } from './executor.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';
import {
  DbosWorkflowExecutor,
  WORKFLOW_RESOLVE_FAILED_CODE,
  type WorkflowJob,
  workflowResolveFailureHeaderKeptLog,
  workflowResolveFailureLog,
} from './workflow-executor.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_wf_spine_${PID}`;
const DBOS_SYS_DB = `rayspec_wf_spine_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000ab';
/** The per-document DBOS application version this launch is fenced to (shape: the server's helper). */
const DOC_APP_VERSION = 'doc-0f1e2d3c4b5a6978';
/** A workflow id the module-level resolver refuses — the shape of a foreign / undeployed document. */
const UNKNOWN_WORKFLOW_ID = 'not_deployed_here';

// A module-level node counter proving single-flight: the capability node bumps it on each REAL run.
let nodeRuns = 0;
// Every line the workflow executor's injected logger sink received (asserted by the terminal-journal test).
const workerWarnings: string[] = [];

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let executor: DbosDurableExecutor;
let wfExecutor: DbosWorkflowExecutor;
let appBaseUrl: string;

function counterWorkflow(): WorkflowSpec {
  return {
    id: 'counter_flow',
    tier: 'A',
    status: 'foundation_only',
    trigger: { event: 'thing.happened' },
    idempotency_key: 'unused',
    steps: [
      { id: 'count', capability: 'count', operation: 'increment', input_from_event: true },
      {
        id: 'persist',
        capability: 'artifact',
        operation: 'persist',
        depends_on: ['count'],
        input: {
          artifact: { kind: 'counter_result', content: { ok: true } },
          namespace: 'counter',
          scope: 'run',
        },
      },
    ],
  };
}

function resolveWorkflowRun(job: WorkflowJob, tdb: ReturnType<typeof forTenant>) {
  // The production resolvers throw exactly here for a workflow id the deployed document does not
  // carry (product-boot.ts's "durable worker: unknown workflow '…' (fail-closed)."). Reproducing that
  // throw on a sentinel id reuses this file's single DBOS launch.
  if (job.workflowId === UNKNOWN_WORKFLOW_ID) {
    throw new Error(`durable worker: unknown workflow '${job.workflowId}' (fail-closed).`);
  }
  const registry = new CapabilityRegistry();
  registry.register('count.increment', ({ step }) => {
    nodeRuns += 1;
    return {
      status: 'completed',
      artifact_refs: [
        { id: `${step.id}:c`, kind: 'counter', source_node_id: step.id, value: { n: nodeRuns } },
      ],
      output: { n: nodeRuns },
    };
  });
  registry.register(
    'artifact.persist',
    createArtifactPersistHandler({ store: new TenantDbArtifactStore(tdb) }),
  );
  return { workflow: counterWorkflow(), registry };
}

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

function buildWorkflowTablesSql(schema: string): string {
  return `
  CREATE TABLE IF NOT EXISTS ${schema}.workflow_runs (
    workflow_run_id text PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    workflow_id text NOT NULL, idempotency_key text NOT NULL, trigger_event text NOT NULL,
    input_event jsonb NOT NULL, status text NOT NULL, resumable boolean NOT NULL DEFAULT false,
    error jsonb, attempts numeric NOT NULL DEFAULT '0',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_tenant_wf_idem_idx ON ${schema}.workflow_runs (tenant_id, workflow_id, idempotency_key);
  CREATE TABLE IF NOT EXISTS ${schema}.workflow_node_states (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    workflow_run_id text NOT NULL, node_id text NOT NULL, position numeric NOT NULL DEFAULT '0',
    capability text NOT NULL, operation text NOT NULL, status text NOT NULL,
    attempts jsonb NOT NULL DEFAULT '[]'::jsonb, attempt_count numeric NOT NULL DEFAULT '0',
    artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb, output jsonb, error jsonb,
    skipped_reason text, produced_by text, cost_usd numeric NOT NULL DEFAULT '0',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workflow_node_states_run_node_idx ON ${schema}.workflow_node_states (tenant_id, workflow_run_id, node_id);
  CREATE TABLE IF NOT EXISTS ${schema}.workflow_artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES ${schema}.orgs(id) ON DELETE CASCADE,
    artifact_id text NOT NULL, workflow_run_id text, kind text NOT NULL,
    namespace text NOT NULL, scope text NOT NULL, content_hash text NOT NULL,
    version numeric NOT NULL DEFAULT '1', content jsonb NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workflow_artifacts_tenant_artifact_idx ON ${schema}.workflow_artifacts (tenant_id, artifact_id);
`;
}

async function waitForTerminal(runId: string, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await wfExecutor.status(runId);
    if (s === 'succeeded' || s === 'failed' || s === 'cancelled') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`workflow ${runId} did not reach terminal within ${ms}ms`);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the durable-dbos workflow spine test');
  appBaseUrl = url;
  await dropSysDbSafely(url, DBOS_SYS_DB);

  db = makeDbWithSchema(url, APP_SCHEMA);
  await db.$client.unsafe(buildSpineSchemaSql(APP_SCHEMA));
  await db.$client.unsafe(buildWorkflowTablesSql(APP_SCHEMA));
  await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'wf', 'wf')`, [TENANT]);

  const deps: DbosExecutorDeps = {
    db: db as unknown as Db,
    // No agent runs in this test — a fail-closed resolver documents that.
    resolveRun: (job: RunJob): ResolvedRun => {
      throw new Error(`no agent runs in the workflow spine test (got '${job.agentId}')`);
    },
  };
  executor = new DbosDurableExecutor(deps, {
    name: `rayspec-wf-spine-${PID}`,
    systemDatabaseUrl: withDbName(url, DBOS_SYS_DB),
    applicationVersion: DOC_APP_VERSION,
  });
  wfExecutor = new DbosWorkflowExecutor({
    db: db as unknown as Db,
    resolveWorkflowRun,
    logger: { warn: (m) => workerWarnings.push(m) },
  });
  executor.attachPreLaunchHook(() => wfExecutor.registerWorkflowJob());
  await executor.start();
  await wfExecutor.registerQueueAfterLaunch();
}, 60_000);

beforeEach(async () => {
  nodeRuns = 0;
  workerWarnings.length = 0;
  await db.$client.unsafe(
    'TRUNCATE workflow_runs, workflow_node_states, workflow_artifacts CASCADE',
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

function event(): WorkflowInputEvent {
  return {
    id: 'evt-1',
    type: 'thing.happened',
    occurred_at: '2026-07-02T00:00:00.000Z',
    payload: { thing: 'x' },
  };
}

describe('DBOS workflow spine — engine.execute off-request', () => {
  it('enqueue → runWorkflowJob runs the engine OFF-REQUEST → journal + artifact persist', async () => {
    const { workflowRunId } = await wfExecutor.enqueueWorkflowRun({
      tenantId: TENANT,
      workflow: counterWorkflow(),
      event: event(),
      idempotencyKey: 'k-1',
    });

    const status = await waitForTerminal(workflowRunId);
    expect(status).toBe('succeeded');
    expect(nodeRuns).toBe(1); // the node ran once, off-request

    // workflow_runs header persisted, completed, tenant-scoped.
    const runs = await db.$client.unsafe(
      'SELECT status FROM workflow_runs WHERE workflow_run_id = $1 AND tenant_id = $2',
      [workflowRunId, TENANT],
    );
    expect(runs).toHaveLength(1);
    expect((runs[0] as { status: string }).status).toBe('completed');

    // both node states + the persisted artifact are there.
    const nodes = await db.$client.unsafe(
      'SELECT node_id, status FROM workflow_node_states WHERE workflow_run_id = $1 ORDER BY position',
      [workflowRunId],
    );
    expect(nodes.map((n: { node_id: string }) => n.node_id)).toEqual(['count', 'persist']);
    const artifacts = await db.$client.unsafe(
      'SELECT kind FROM workflow_artifacts WHERE tenant_id = $1',
      [TENANT],
    );
    expect(artifacts).toHaveLength(1);
    expect((artifacts[0] as { kind: string }).kind).toBe('counter_result');

    // DUR-HONESTY-2: liveness reconciles the (settled) journal header against DBOS — a completed run is
    // `terminal` (not forever-live), and a run with no header is `absent`. The `stalled` dead-letter
    // classification is proven deterministically in workflow-liveness.unit.test.ts.
    expect(await wfExecutor.liveness(TENANT, workflowRunId)).toBe('terminal');
    expect(await wfExecutor.liveness(TENANT, 'no-such-run')).toBe('absent');
  });

  it('SINGLE-FLIGHT: enqueueing the same (tenant, workflow, idempotency) twice runs the engine ONCE', async () => {
    const first = await wfExecutor.enqueueWorkflowRun({
      tenantId: TENANT,
      workflow: counterWorkflow(),
      event: event(),
      idempotencyKey: 'k-2',
    });
    await waitForTerminal(first.workflowRunId);
    const second = await wfExecutor.enqueueWorkflowRun({
      tenantId: TENANT,
      workflow: counterWorkflow(),
      event: event(),
      idempotencyKey: 'k-2',
    });
    expect(second.workflowRunId).toBe(first.workflowRunId); // same durable workflow id
    expect(second.deduped).toBe(true);
    await waitForTerminal(second.workflowRunId);
    await new Promise((r) => setTimeout(r, 200));
    expect(nodeRuns).toBe(1); // the node ran EXACTLY once across both enqueues (single-flight)
  });

  it('SINGLE-FLIGHT (CONCURRENT): a genuinely concurrent double-enqueue of the same id runs the engine ONCE', async () => {
    // PYD2-01: the sequential test above proves engine-level dedup (ensureRun after the first run is
    // terminal). This proves the DBOS `workflowID` idempotency LAW under a real RACE: both enqueues are
    // fired WITHOUT awaiting between them (the barrier is the single Promise.all), so two `startWorkflow`
    // calls hit the SAME tenant-namespaced workflowID concurrently. DBOS must collapse them to ONE
    // workflow ⇒ the engine (and its node) executes EXACTLY once. Deterministic: `waitForTerminal` blocks
    // on the shared id, and DBOS guarantees one workflow per workflowID (there is no second execution to
    // race) — the assertion does not depend on a sleep.
    const [a, b] = await Promise.all([
      wfExecutor.enqueueWorkflowRun({
        tenantId: TENANT,
        workflow: counterWorkflow(),
        event: event(),
        idempotencyKey: 'k-concurrent',
      }),
      wfExecutor.enqueueWorkflowRun({
        tenantId: TENANT,
        workflow: counterWorkflow(),
        event: event(),
        idempotencyKey: 'k-concurrent',
      }),
    ]);
    expect(a.workflowRunId).toBe(b.workflowRunId); // both resolve the same tenant-namespaced durable id
    await waitForTerminal(a.workflowRunId);
    expect(nodeRuns).toBe(1); // DBOS workflowID idempotency ⇒ the engine + its node ran EXACTLY once
  });

  it('the enqueued job carries the boot application version in the DBOS fence column', async () => {
    // GROUND TRUTH for the fence: `DbosExecutorConfig.applicationVersion` → `DBOS.setConfig` →
    // `globalParams.appVersion` → the `application_version` column DBOS's dequeue predicate is scoped
    // by (`application_version IS NULL OR application_version = $3`, system_database.js:1824). This
    // asserts the VALUE lands in that column; it does not run a second process (DBOS's config and
    // launch state are process-global, so one process holds exactly one version at a time).
    const { workflowRunId } = await wfExecutor.enqueueWorkflowRun({
      tenantId: TENANT,
      workflow: counterWorkflow(),
      event: event(),
      idempotencyKey: 'k-appversion',
    });
    expect(await waitForTerminal(workflowRunId)).toBe('succeeded');

    const sys = postgres(withDbName(appBaseUrl, DBOS_SYS_DB), { max: 1 });
    try {
      const rows = await sys.unsafe(
        'SELECT application_version FROM dbos.workflow_status WHERE workflow_uuid = $1',
        [workflowRunId],
      );
      expect(rows).toHaveLength(1);
      expect((rows[0] as { application_version: string }).application_version).toBe(
        DOC_APP_VERSION,
      );
    } finally {
      await sys.end();
    }
  });

  it('a resolver failure is JOURNALLED as a terminal run and still fails the durable job', async () => {
    // The fail-closed resolver throws BEFORE the engine is constructed, so neither `ensureRun` nor
    // `finalizeRun` is ever reached and the run has no header at all — the loss the journal is meant
    // to record. The worker now writes the terminal header itself, best-effort, and rethrows.
    const { workflowRunId } = await wfExecutor.enqueueWorkflowRun({
      tenantId: TENANT,
      workflow: { ...counterWorkflow(), id: UNKNOWN_WORKFLOW_ID },
      event: event(),
      idempotencyKey: 'k-unknown',
    });

    expect(await waitForTerminal(workflowRunId)).toBe('failed'); // the original error still surfaces
    expect(nodeRuns).toBe(0); // nothing ran

    const runs = await db.$client.unsafe(
      'SELECT status, trigger_event, error, resumable, attempts FROM workflow_runs ' +
        'WHERE workflow_run_id = $1 AND tenant_id = $2',
      [workflowRunId, TENANT],
    );
    expect(runs).toHaveLength(1); // EXACTLY one header — today there is none
    const row = runs[0] as {
      status: string;
      trigger_event: string;
      error: { code: string; message: string; retryable: boolean };
      resumable: boolean;
      attempts: string;
    };
    expect(row.status).toBe('terminal_failure');
    expect(row.trigger_event).toBe('thing.happened'); // the job's own event type
    expect(row.error.code).toBe(WORKFLOW_RESOLVE_FAILED_CODE);
    expect(row.error.message).toContain(UNKNOWN_WORKFLOW_ID); // the resolver's own reason is on the row
    expect(row.error.retryable).toBe(false);
    expect(row.resumable).toBe(false);
    expect(Number(row.attempts)).toBe(0);

    // No node states were invented for a run that never entered the engine.
    const nodes = await db.$client.unsafe(
      'SELECT node_id FROM workflow_node_states WHERE workflow_run_id = $1',
      [workflowRunId],
    );
    expect(nodes).toHaveLength(0);

    // The header exists and is settled ⇒ liveness is `terminal` (it was `absent` before this).
    expect(await wfExecutor.liveness(TENANT, workflowRunId)).toBe('terminal');

    // …and the deployment's own log surface carries the one line, with the same wording the pure
    // builder produces (pinned in workflow-resolve-failure.unit.test.ts).
    expect(workerWarnings).toContain(
      workflowResolveFailureLog({
        workflowRunId,
        tenantId: TENANT,
        workflowId: UNKNOWN_WORKFLOW_ID,
      }),
    );
  });

  it('a resolver failure LEAVES a header an earlier execution wrote exactly as it is', async () => {
    // The reachable shape: the engine ran nodes, the process died mid-run (header still `running`,
    // node states carrying real attempt counts), and DBOS's crash recovery re-invokes the workflow
    // against a document that no longer carries that workflow — so the resolver throws on a run that
    // ALREADY has a journal header. `finalizeRun` is a plain UPDATE, so writing this failure's patch
    // would replace that row's real `attempts`/`resumable`/`error` with zeroes while the node states
    // below still hold the attempts. Pre-seed exactly that row, then drive the failing resolver.
    const idempotencyKey = 'k-preexisting';
    const runId = durableWorkflowRunId(TENANT, UNKNOWN_WORKFLOW_ID, idempotencyKey);
    await db.$client.unsafe(
      `INSERT INTO workflow_runs (workflow_run_id, tenant_id, workflow_id, idempotency_key,
         trigger_event, input_event, status, resumable, error, attempts)
       VALUES ($1, $2, $3, $4, 'thing.happened', $5, 'running', true, $6, '7')`,
      [
        runId,
        TENANT,
        UNKNOWN_WORKFLOW_ID,
        idempotencyKey,
        JSON.stringify(event()),
        JSON.stringify({ code: 'node_boom', message: 'a node failed', retryable: true }),
      ],
    );
    await db.$client.unsafe(
      `INSERT INTO workflow_node_states (tenant_id, workflow_run_id, node_id, position, capability,
         operation, status, attempt_count)
       VALUES ($1, $2, 'count', '0', 'count', 'increment', 'completed', '3')`,
      [TENANT, runId],
    );

    const { workflowRunId } = await wfExecutor.enqueueWorkflowRun({
      tenantId: TENANT,
      workflow: { ...counterWorkflow(), id: UNKNOWN_WORKFLOW_ID },
      event: event(),
      idempotencyKey,
    });
    expect(workflowRunId).toBe(runId);
    expect(await waitForTerminal(workflowRunId)).toBe('failed'); // the resolver error still fails the job

    const runs = await db.$client.unsafe(
      'SELECT status, resumable, attempts, error FROM workflow_runs WHERE workflow_run_id = $1 AND tenant_id = $2',
      [runId, TENANT],
    );
    expect(runs).toHaveLength(1);
    const row = runs[0] as {
      status: string;
      resumable: boolean;
      attempts: string;
      error: { code: string };
    };
    // UNTOUCHED — every field the terminal patch would have overwritten.
    expect(row.status).toBe('running');
    expect(row.resumable).toBe(true);
    expect(Number(row.attempts)).toBe(7);
    expect(row.error.code).toBe('node_boom');
    // …and the node journal that row accounts for is still there.
    const nodes = await db.$client.unsafe(
      'SELECT attempt_count FROM workflow_node_states WHERE workflow_run_id = $1',
      [runId],
    );
    expect(nodes).toHaveLength(1);
    expect(Number((nodes[0] as { attempt_count: string }).attempt_count)).toBe(3);

    // A `running` header whose DBOS workflow is no longer active is the DEAD-LETTER classification —
    // `stalled`, the state an operator must act on — not a manufactured `terminal`.
    expect(await wfExecutor.liveness(TENANT, runId)).toBe('stalled');

    // The log surface says which line it emitted: the header was kept, not rewritten.
    expect(workerWarnings).toContain(
      workflowResolveFailureHeaderKeptLog(
        { workflowRunId: runId, tenantId: TENANT, workflowId: UNKNOWN_WORKFLOW_ID },
        'running',
      ),
    );
    expect(workerWarnings).not.toContain(
      workflowResolveFailureLog({
        workflowRunId: runId,
        tenantId: TENANT,
        workflowId: UNKNOWN_WORKFLOW_ID,
      }),
    );
  });
});
