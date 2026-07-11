/**
 * The AGENT node must NOT re-fire a non-idempotent tool on a
 * crash-resume.
 *
 * THE HAZARD. An agent node runs through `runAgent` under a DETERMINISTIC per-node sub-run id. A
 * crash mid-node — AFTER the agent's non-idempotent tool fired (the `run_taint` marker committed on its
 * own connection) but BEFORE the engine journaled the node 'completed' — leaves the node un-settled, so
 * DBOS recovery re-invokes `engine.execute()` → the agent node re-runs → `runAgent` starts a FRESH run
 * (replay=false) → the tool FIRES AGAIN (double side effect + double cost). The shipped docstring claimed
 * `runAgent`'s taint quarantine self-guards this; it does NOT (the taint gate is consulted by OTHER
 * re-run paths, never by `runAgent` on a fresh id, and never by the workflow agent node).
 *
 * THE CONTRACT (fixed). Before (re-)invoking `runAgent`, the agent node consults the sub-run's durable
 * state: ATTACH to a prior COMPLETED sub-run (reconstruct its artifact, never re-run); QUARANTINE a
 * sub-run that fired a non-idempotent tool (a `run_taint` marker exists) but did not complete (attaching
 * is impossible — no terminal output — and re-running would double-fire); RUN fresh only when neither
 * holds. This test proves both on GROUND TRUTH against real Postgres (the fake backend fires a REAL
 * non-idempotent tool through `ctx.dispatchTool`, so the real `run_taint` marker is written).
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard (bottom) fails a DB-required run that lost it.
 */
import type { AgentSpec, Backend, NeutralTool, RunContext, RunResult } from '@rayspec/core';
import { forTenant } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import {
  CapabilityRegistry,
  type WorkflowInputEvent,
  type WorkflowSpec,
} from '@rayspec/foundation';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_RERUN_HAZARD_CODE, DurableWorkflowEngine } from './engine.js';
import { TenantDbWorkflowJournalStore } from './journal-store.js';
import { makeAgentNodeHandler, type ResolvedAgentNode } from './nodes/agent-node.js';
import { buildWorkflowDurableSchemaSql } from './test-support/schema-ddl.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

const PID = process.pid;
const APP_SCHEMA = `rayspec_test_wfdur_rerun_${PID}`;
const TENANT = '00000000-0000-0000-0000-0000000000e5';

type DbHandle = ReturnType<typeof makeDbWithSchema>;
let db: DbHandle;
let testsRan = 0;

/** The ground-truth side-effect counter the non-idempotent tool bumps on every REAL fire. */
const sideEffects = { count: 0 };

const chargeTool: NeutralTool = {
  spec: {
    name: 'charge_card',
    description: 'a non-idempotent side effect (charges money once)',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
  handler: (args) => {
    sideEffects.count += 1;
    return { charged: (args as { q?: string }).q ?? '' };
  },
  timeoutMs: 1000,
  idempotent: false,
};

const CHARGE_SPEC: AgentSpec = {
  name: 'charge_agent',
  instructions: 'Charge the order.',
  model: 'gpt-4.1-mini',
  input: 'placeholder',
  tools: [],
  maxTurns: 2,
};

/**
 * A deterministic fake backend that fires the REAL non-idempotent `charge_card` tool through
 * `ctx.dispatchTool` (so the chokepoint writes the `run_taint` marker before the side effect) and then
 * completes — persisting a real `runs` header exactly like an off-request agent run would.
 */
class FakeChargeBackend implements Backend {
  readonly id = 'openai' as const;
  liveRuns = 0;

  async resolveAuth() {
    return 'api-key' as const;
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.liveRuns += 1;
    // The non-idempotent side effect — routed through the SAME central dispatch path a real agent uses,
    // so `markRunTainted` writes the tenant-scoped `run_taint` marker under this sub-run id first.
    await ctx.dispatchTool?.('charge_card', { q: 'order-1' }, 'call-1');
    const output = { charged: true };
    const finalText = JSON.stringify(output);
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      costUsd: 0.001,
      model: spec.model,
      producedBy: 'fake-charge-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText,
      output,
      error: null,
      errorClass: null,
      conversation: [
        { role: 'user', index: 0, parts: [{ kind: 'text', text: spec.input }] },
        { role: 'assistant', index: 1, parts: [{ kind: 'text', text: finalText }] },
      ],
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      costUsd: 0.001,
      stepCount: 1,
    };
  }
}

function chargeWorkflow(): WorkflowSpec {
  return {
    id: 'charge_flow',
    tier: 'A',
    status: 'foundation_only',
    trigger: { event: 'order.created' },
    idempotency_key: 'order:o-1',
    steps: [
      {
        id: 'charge',
        capability: 'agent',
        operation: 'charge_agent',
        input_from_event: true,
      },
    ],
  };
}

function orderEvent(): WorkflowInputEvent {
  return {
    id: 'evt-order-1',
    type: 'order.created',
    occurred_at: '2026-07-02T00:00:00.000Z',
    payload: { order_id: 'o-1', amount: 4200 },
  };
}

function buildEngine(backend: FakeChargeBackend): DurableWorkflowEngine {
  const tdb = forTenant(db, TENANT);
  const registry = new CapabilityRegistry();
  const resolve = (agentId: string): ResolvedAgentNode | undefined =>
    agentId === 'charge_agent' ? { backend, spec: CHARGE_SPEC, tools: [chargeTool] } : undefined;
  registry.register('agent.charge_agent', makeAgentNodeHandler({ tenantDb: tdb, resolve }));
  return new DurableWorkflowEngine({
    journal: new TenantDbWorkflowJournalStore(tdb),
    registry,
    tenantId: TENANT,
  });
}

describe.skipIf(!hasDb)('workflow-durable — agent node crash-resume never re-fires', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL required');
    db = makeDbWithSchema(url, APP_SCHEMA);
    await db.$client.unsafe(buildWorkflowDurableSchemaSql(APP_SCHEMA));
    await db.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1,'e','e')`, [TENANT]);
  }, 60_000);

  beforeEach(async () => {
    sideEffects.count = 0;
    await db.$client.unsafe(
      'TRUNCATE workflow_runs, workflow_node_states, workflow_artifacts, runs, journal_steps, conversation_items, run_events, idempotency_keys CASCADE',
    );
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('QUARANTINE: a sub-run that fired the tool but did NOT complete is parked, not re-fired', async () => {
    testsRan += 1;
    const backend = new FakeChargeBackend();
    const wf = chargeWorkflow();

    // Phase 1: a real run fires the non-idempotent tool once (the `run_taint` marker commits).
    await buildEngine(backend).execute({ workflow: wf, event: orderEvent() });
    expect(sideEffects.count).toBe(1);
    expect(backend.liveRuns).toBe(1);

    // Simulate the crash window: the tool fired + tainted, but the agent sub-run's `runs` header never
    // persisted (crash before runAgent's tail) and the node-'completed' mark was lost. The taint marker
    // survives (committed on its own connection) — the durable evidence a crashed side effect leaves.
    await db.$client.unsafe('DELETE FROM runs');
    await db.$client.unsafe(
      `UPDATE workflow_node_states SET status = 'running' WHERE node_id = 'charge'`,
    );
    const workflowRunId = (
      await db.$client.unsafe('SELECT workflow_run_id FROM workflow_runs LIMIT 1')
    )[0] as { workflow_run_id: string };
    const store = new TenantDbWorkflowJournalStore(forTenant(db, TENANT));
    await store.finalizeRun(workflowRunId.workflow_run_id, {
      status: 'running',
      resumable: false,
      attempts: 0,
    });

    // Resume. The FIXED engine must QUARANTINE the node (a prior non-idempotent tool fired, no completed
    // sub-run to attach to) — never re-fire. The OLD code re-ran the agent → a SECOND charge (count 2).
    const resumed = await buildEngine(backend).execute({ workflow: wf, event: orderEvent() });

    expect(sideEffects.count).toBe(1); // NOT re-fired — the double-charge is prevented
    const node = resumed.nodes.find((n) => n.nodeId === 'charge');
    expect(node?.status).toBe('quarantined');
    expect(node?.error?.code).toBe(AGENT_RERUN_HAZARD_CODE);
    expect(resumed.run.status).toBe('quarantined');
    expect(resumed.run.resumable).toBe(true);
  });

  it('ATTACH: a completed sub-run whose node mark was lost is reconciled, not re-run', async () => {
    testsRan += 1;
    const backend = new FakeChargeBackend();
    const wf = chargeWorkflow();

    // Phase 1: a full run — the agent completes + persists its `runs` header ('completed'), tool fired once.
    const done = await buildEngine(backend).execute({ workflow: wf, event: orderEvent() });
    expect(sideEffects.count).toBe(1);
    expect(done.run.status).toBe('completed');

    // Simulate the crash window AFTER the agent completed but BEFORE the engine journaled the node
    // 'completed': reset the node + workflow header to 'running', but KEEP the completed `runs` header.
    await db.$client.unsafe(
      `UPDATE workflow_node_states SET status = 'running' WHERE node_id = 'charge'`,
    );
    const store = new TenantDbWorkflowJournalStore(forTenant(db, TENANT));
    await store.finalizeRun(done.run.workflowRunId, {
      status: 'running',
      resumable: false,
      attempts: 0,
    });

    // Resume. The FIXED engine ATTACHES to the completed sub-run (reconstructs the artifact) — never
    // re-runs. The OLD code re-ran the agent → a SECOND charge (count 2).
    const resumed = await buildEngine(backend).execute({ workflow: wf, event: orderEvent() });

    expect(sideEffects.count).toBe(1); // NOT re-fired
    expect(backend.liveRuns).toBe(1); // the agent backend was NOT invoked a second time
    const node = resumed.nodes.find((n) => n.nodeId === 'charge');
    expect(node?.status).toBe('completed');
    expect(resumed.run.status).toBe('completed');
    // The reconstructed artifact carries the sub-run's real output (attached from the header).
    expect((node?.output as { output?: { charged?: boolean } } | null)?.output?.charged).toBe(true);
  });
});

/**
 * Un-skippable ran-guard: a SEPARATE, NON-skipped describe that FAILS a DB-required run
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) which lost DATABASE_URL and silently skipped the proof above.
 */
describe('workflow-durable agent-node crash-resume (DB) — ran-guard', () => {
  it('the crash-resume tests ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(testsRan).toBe(2);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
