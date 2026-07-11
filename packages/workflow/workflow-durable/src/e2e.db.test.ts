/**
 * Product-neutral end-to-end: a support-triage workflow — a CAPABILITY node
 * (intake parse) → an AGENT node (classifier, through the REAL runAgent path) → a VALIDATE node
 * (grounding.check) → a STORE_WRITE node (artifact.persist) — runs end-to-end on the DURABLE journaled
 * path against a real Postgres. Product-free (no product vocabulary). Deterministic +
 * CI-safe (fake backend, no network). Proves the composed gate: an agent + a capability + a validation +
 * a store write, journaled + replay/debuggable, tenant-scoped, mixing node kinds.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard (bottom) fails a DB-required run that lost it.
 */
import type { AgentSpec } from '@rayspec/core';
import { forTenant, schema } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import {
  CapabilityRegistry,
  type WorkflowInputEvent,
  type WorkflowSpec,
} from '@rayspec/foundation';
import {
  createArtifactPersistHandler,
  createGroundingCheckHandler,
} from '@rayspec/grounding-runtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DurableWorkflowEngine } from './engine.js';
import { TenantDbWorkflowJournalStore } from './journal-store.js';
import { makeAgentNodeHandler, type ResolvedAgentNode } from './nodes/agent-node.js';
import { TenantDbArtifactStore } from './nodes/store.js';
import { getWorkflowRunObservability } from './observability.js';
import { FakeClassifierBackend } from './test-support/fake-backend.js';
import { buildWorkflowDurableSchemaSql } from './test-support/schema-ddl.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_wfdur_e2e_${PID}`;
const TENANT = '00000000-0000-0000-0000-0000000000c3';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000d4';

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let testsRan = 0;

const CLASSIFIER_SPEC: AgentSpec = {
  name: 'support_classifier',
  instructions: 'Classify the support ticket into a category and priority.',
  model: 'gpt-4.1-mini',
  input: 'placeholder',
  tools: [],
  maxTurns: 2,
};

function triageWorkflow(): WorkflowSpec {
  return {
    id: 'support_triage',
    tier: 'A',
    status: 'foundation_only',
    trigger: { event: 'ticket.created' },
    idempotency_key: 'ticket:t-1',
    steps: [
      {
        id: 'parse',
        capability: 'intake',
        operation: 'parse_ticket',
        input_from_event: true,
        output_artifact_refs: ['ticket.parsed'],
      },
      {
        id: 'classify',
        capability: 'agent',
        operation: 'support_classifier',
        depends_on: ['parse'],
      },
      {
        id: 'validate',
        capability: 'grounding',
        operation: 'check',
        depends_on: ['classify'],
        input: {
          source_artifact: { kind: 'ticket', content: { text: 'I want a refund' } },
          candidate_artifact: { kind: 'classification', content: { category: 'billing' } },
          references: [{ id: 'ref-1' }],
          closed_reference_ids: ['ref-1'],
        },
      },
      {
        id: 'persist',
        capability: 'artifact',
        operation: 'persist',
        depends_on: ['validate'],
        input: {
          artifact: { kind: 'triage_result', content: { category: 'billing', priority: 'high' } },
          namespace: 'triage',
          scope: 'ticket-t-1',
        },
      },
    ],
  };
}

function ticketEvent(): WorkflowInputEvent {
  return {
    id: 'evt-ticket-1',
    type: 'ticket.created',
    occurred_at: '2026-07-02T00:00:00.000Z',
    payload: { ticket_id: 't-1', text: 'I want a refund' },
  };
}

function buildEngine(tenantId: string, backend: FakeClassifierBackend): DurableWorkflowEngine {
  const tdb = forTenant(db, tenantId);
  const registry = new CapabilityRegistry();
  // CAPABILITY node — a Tier B capability the deployment composes (here: parse an intake ticket).
  registry.register('intake.parse_ticket', ({ input, step }) => ({
    status: 'completed',
    artifact_refs: [
      {
        id: `ticket.parsed:${input.ticket_id}`,
        kind: 'ticket.parsed',
        source_node_id: step.id,
        value: input,
      },
    ],
    output: input,
  }));
  // AGENT node — through the REAL runAgent path (fake backend, no network).
  const resolve = (agentId: string): ResolvedAgentNode | undefined =>
    agentId === 'support_classifier' ? { backend, spec: CLASSIFIER_SPEC } : undefined;
  registry.register('agent.support_classifier', makeAgentNodeHandler({ tenantDb: tdb, resolve }));
  // VALIDATE node — the Tier B grounding capability.
  registry.register('grounding.check', createGroundingCheckHandler());
  // STORE_WRITE node — TenantDb-backed artifact store.
  registry.register(
    'artifact.persist',
    createArtifactPersistHandler({ store: new TenantDbArtifactStore(tdb) }),
  );

  return new DurableWorkflowEngine({
    journal: new TenantDbWorkflowJournalStore(tdb),
    registry,
    tenantId,
  });
}

describe.skipIf(!hasDb)(
  'workflow-durable e2e — product-neutral support triage on the durable path (DB)',
  () => {
    beforeAll(async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL required');
      db = makeDbWithSchema(url, APP_SCHEMA);
      await db.$client.unsafe(buildWorkflowDurableSchemaSql(APP_SCHEMA));
      await db.$client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1,'c','c'),($2,'d','d')`,
        [TENANT, OTHER_TENANT],
      );
    }, 60_000);

    beforeEach(async () => {
      await db.$client.unsafe(
        'TRUNCATE workflow_runs, workflow_node_states, workflow_artifacts, runs, journal_steps, conversation_items, run_events CASCADE',
      );
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it('runs capability→agent→validate→store_write end-to-end, all journaled + tenant-scoped', async () => {
      testsRan += 1;
      const backend = new FakeClassifierBackend();
      const view = await buildEngine(TENANT, backend).execute({
        workflow: triageWorkflow(),
        event: ticketEvent(),
      });

      // Every node completed, in order.
      expect(view.run.status).toBe('completed');
      expect(view.nodes.map((n) => [n.nodeId, n.status])).toEqual([
        ['parse', 'completed'],
        ['classify', 'completed'],
        ['validate', 'completed'],
        ['persist', 'completed'],
      ]);

      // The AGENT node ran through the REAL runAgent path exactly once — a `runs` header persisted.
      expect(backend.liveRuns).toBe(1);
      const tdb = forTenant(db, TENANT);
      const runs = (await tdb.select(schema.runs).all()) as Array<{
        agentName: string;
        status: string;
      }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]?.agentName).toBe('support_classifier');
      expect(runs[0]?.status).toBe('completed');

      // The STORE_WRITE node persisted the triage result to the tenant-scoped artifact store.
      const artifacts = (await tdb.select(schema.workflowArtifacts).all()) as Array<{
        kind: string;
        content: unknown;
      }>;
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.kind).toBe('triage_result');
      expect(artifacts[0]?.content).toEqual({ category: 'billing', priority: 'high' });

      // The VALIDATE node's grounding verdict is journaled on its node output (grounded — ref-1 in the set).
      const validateNode = view.nodes.find((n) => n.nodeId === 'validate');
      expect((validateNode?.output as { verdict?: string } | null)?.verdict).toBe('grounded');
    });

    it('observability: the run + nodes are queryable with per-status counts (tenant-scoped)', async () => {
      testsRan += 1;
      const backend = new FakeClassifierBackend();
      const view = await buildEngine(TENANT, backend).execute({
        workflow: triageWorkflow(),
        event: ticketEvent(),
      });

      const obs = await getWorkflowRunObservability(forTenant(db, TENANT), view.run.workflowRunId);
      expect(obs?.run.status).toBe('completed');
      expect(obs?.nodeStatusCounts.completed).toBe(4);
      expect(obs?.nodes).toHaveLength(4);

      // A DIFFERENT tenant cannot read this run (tenant-scoped observability).
      const foreign = await getWorkflowRunObservability(
        forTenant(db, OTHER_TENANT),
        view.run.workflowRunId,
      );
      expect(foreign).toBeUndefined();
    });

    it('DEDUP: re-executing the same ticket does NOT re-run the agent (single-flight)', async () => {
      testsRan += 1;
      const backend = new FakeClassifierBackend();
      const wf = triageWorkflow();
      const first = await buildEngine(TENANT, backend).execute({
        workflow: wf,
        event: ticketEvent(),
      });
      const second = await buildEngine(TENANT, backend).execute({
        workflow: wf,
        event: ticketEvent(),
      });
      expect(first.run.workflowRunId).toBe(second.run.workflowRunId);
      expect(second.run.status).toBe('completed');
      // The agent (and every node) ran EXACTLY once across both executes (dedup on the run id).
      expect(backend.liveRuns).toBe(1);
      const artifacts = await forTenant(db, TENANT).select(schema.workflowArtifacts).all();
      expect(artifacts).toHaveLength(1);
    });

    it('RESUME: a crashed run (agent completed, store absent) resumes at store WITHOUT re-running the agent', async () => {
      testsRan += 1;
      const backend = new FakeClassifierBackend();
      const wf = triageWorkflow();
      const tdb = forTenant(db, TENANT);
      const store = new TenantDbWorkflowJournalStore(tdb);
      const engine = buildEngine(TENANT, backend);

      // First: run the whole thing once to get a real completed run, then SIMULATE a crash by resetting
      // the store node to un-run (delete it) + the run header back to 'running'. On re-execute, the agent
      // + validate nodes are completed-in-journal (not re-run); only the store node re-runs.
      const done = await engine.execute({ workflow: wf, event: ticketEvent() });
      expect(backend.liveRuns).toBe(1);
      await db.$client.unsafe('DELETE FROM workflow_node_states WHERE node_id = $1', ['persist']);
      await db.$client.unsafe('DELETE FROM workflow_artifacts');
      await store.finalizeRun(done.run.workflowRunId, {
        status: 'running',
        resumable: false,
        attempts: 0,
      });

      const resumed = await engine.execute({ workflow: wf, event: ticketEvent() });
      expect(resumed.run.status).toBe('completed');
      expect(backend.liveRuns).toBe(1); // the agent node was NOT re-run (resumed from journal)
      const artifacts = await tdb.select(schema.workflowArtifacts).all();
      expect(artifacts).toHaveLength(1); // the store node re-ran and re-persisted
    });
  },
);

/**
 * Un-skippable ran-guard: a SEPARATE, NON-skipped describe that FAILS a DB-required run (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) which lost DATABASE_URL and silently skipped the e2e proof above.
 */
describe('workflow-durable e2e (DB) — ran-guard', () => {
  it('the durable e2e tests ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(testsRan).toBe(4);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
