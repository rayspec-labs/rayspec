/**
 * The DBOS durable path for the WORKFLOW runtime — DB-backed integration test.
 *
 * Launches the REAL DBOS engine (shared `DbosDurableExecutor` launch + the attached
 * `DbosWorkflowExecutor`) against the local Postgres + a throwaway DBOS SYSTEM db, and proves the
 * workflow spine on GROUND TRUTH:
 *  1. `enqueueWorkflowRun` → `runWorkflowJob` runs `engine.execute` OFF-REQUEST → workflow_runs +
 *     workflow_node_states + workflow_artifacts persist; status maps enqueued → succeeded.
 *  2. SINGLE-FLIGHT (C10): enqueueing the SAME (tenant, workflow, idempotency) twice — the DBOS
 *     workflowID is the tenant-namespaced durableWorkflowRunId — runs the engine (and its nodes)
 *     EXACTLY once (a node counter proves it), and the second enqueue reports deduped.
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
import { TenantDbArtifactStore } from '@rayspec/workflow-durable';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbosDurableExecutor, type DbosExecutorDeps, type ResolvedRun } from './executor.js';
import { buildSpineSchemaSql } from './test-support/schema-ddl.js';
import { DbosWorkflowExecutor, type WorkflowJob } from './workflow-executor.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_wf_spine_${PID}`;
const DBOS_SYS_DB = `rayspec_wf_spine_${PID}_sys`;
const TENANT = '00000000-0000-0000-0000-0000000000ab';

// A module-level node counter proving single-flight: the capability node bumps it on each REAL run.
let nodeRuns = 0;

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

function resolveWorkflowRun(_job: WorkflowJob, tdb: ReturnType<typeof forTenant>) {
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
  });
  wfExecutor = new DbosWorkflowExecutor({ db: db as unknown as Db, resolveWorkflowRun });
  executor.attachPreLaunchHook(() => wfExecutor.registerWorkflowJob());
  await executor.start();
  await wfExecutor.registerQueueAfterLaunch();
}, 60_000);

beforeEach(async () => {
  nodeRuns = 0;
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
});
