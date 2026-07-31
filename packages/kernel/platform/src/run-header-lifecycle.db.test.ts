/**
 * Run-HEADER lifecycle (DB-backed, fake backend — no LLM).
 *
 * A run's header row must exist while the run is IN FLIGHT, not only once it finishes — otherwise the
 * runId an async `202` hands out 404s on the run-read routes for the whole run (#121). This suite
 * proves the header lifecycle against ground truth:
 *
 *  - SYNC: the header is present at `running`, with the identity the run resolved, WHILE the backend
 *    is still executing — and reads `completed` afterwards.
 *  - ASYNC: an enqueue-time `enqueued` header transitions to `running` and then to the terminal
 *    status, keeping its enqueue-time `created_at` and healing its identity to what the run resolved.
 *  - RECOVERY re-dispatch onto a non-terminal header (a crashed run left `running`) still runs and
 *    reconciles to the healed terminal outcome.
 *  - A run that FAILS lands at `error`.
 *  - EXACTLY-ONCE is untouched: neither non-terminal write can move a `completed` header, and neither
 *    can overwrite a finished `error` header with `running`.
 */
import type { AgentSpec, AuthMode, Backend, RunContext, RunResult } from '@rayspec/core';
import { schema } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from './run-core.js';
import {
  insertEnqueuedRunHeader,
  isTerminalRunStatus,
  RUN_STATUS_ENQUEUED,
  RUN_STATUS_RUNNING,
} from './run-header.js';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const db = makeTestDb();

const spec: AgentSpec = {
  name: 'lifecycle_agent',
  instructions: 'answer',
  model: 'gpt-4o-mini',
  input: 'a question',
  tools: [],
  maxTurns: 4,
};

/**
 * A backend whose `run()` BLOCKS until the test releases it, so the header can be read while the run
 * is genuinely in flight. `outcome` selects the terminal status it returns.
 */
class GatedBackend implements Backend {
  readonly id = 'openai' as const;
  runs = 0;
  outcome: RunResult['status'] = 'completed';
  /** Resolves once `run()` has been entered (the run is in flight). */
  readonly entered: Promise<void>;
  #entered!: () => void;
  #released: Promise<void>;
  #release!: () => void;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.#entered = resolve;
    });
    this.#released = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  /** Let the blocked `run()` finish. */
  release(): void {
    this.#release();
  }

  async resolveAuth(): Promise<AuthMode> {
    return 'api-key';
  }

  async run(runSpec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.runs += 1;
    this.#entered();
    await this.#released;
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${runSpec.name}:${this.runs}`,
      inputHash: `hash:${runSpec.input}`,
      output: { finalText: 'answered' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      latencyMs: 1,
      status: this.outcome === 'completed' ? 'ok' : 'error',
      authMode: 'api-key',
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: this.outcome,
      finalText: this.outcome === 'completed' ? 'answered' : '',
      output: null,
      error: this.outcome === 'completed' ? null : 'the backend failed',
      errorClass: this.outcome === 'completed' ? null : 'internal',
      conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'answered' }] }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

/** An already-released gate — for the tests that do not need to observe the in-flight window. */
function openGate(outcome: RunResult['status'] = 'completed'): GatedBackend {
  const backend = new GatedBackend();
  backend.outcome = outcome;
  backend.release();
  return backend;
}

async function readHeader(runId: string) {
  const rows = await db.select().from(schema.runs).where(eq(schema.runs.runId, runId));
  return rows[0];
}

describe('terminal-status vocabulary', () => {
  it('classifies the two RunResult statuses as terminal and the two in-flight ones as not', () => {
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('error')).toBe(true);
    expect(isTerminalRunStatus(RUN_STATUS_ENQUEUED)).toBe(false);
    expect(isTerminalRunStatus(RUN_STATUS_RUNNING)).toBe(false);
  });
});

describe('run-header lifecycle', () => {
  beforeAll(async () => {
    await resetRunSchema(db);
    await seedOrgs(db, TENANT_A);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  beforeEach(async () => {
    await db.$client.unsafe(
      'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
    );
  });

  it('SYNC: the header is present at running WHILE the backend executes, and completed afterwards', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = new GatedBackend();
    const runId = 'sync-in-flight-run';

    const pending = runAgent(tdb, backend, spec, { runId });
    await backend.entered;

    // FAIL-THE-FIX: with the header written only at completion there is NO row here at all.
    const inFlight = await readHeader(runId);
    expect(inFlight?.status).toBe(RUN_STATUS_RUNNING);
    // The identity is the one the run resolved — not a placeholder.
    expect(inFlight?.backend).toBe('openai');
    expect(inFlight?.authMode).toBe('api-key');
    expect(inFlight?.agentName).toBe(spec.name);
    expect(inFlight?.model).toBe(spec.model);
    expect(inFlight?.tenantId).toBe(TENANT_A);

    backend.release();
    expect((await pending).status).toBe('completed');
    const done = await readHeader(runId);
    expect(done?.status).toBe('completed');
    expect(done?.finalText).toBe('answered');
  });

  it('ASYNC: an enqueued header transitions enqueued → running → completed, keeping its enqueue instant', async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'async-lifecycle-run';

    await insertEnqueuedRunHeader(tdb, {
      runId,
      backend: 'openai',
      agentName: spec.name,
      model: spec.model,
    });
    const enqueued = await readHeader(runId);
    expect(enqueued?.status).toBe(RUN_STATUS_ENQUEUED);
    // No credential is resolved before the run starts.
    expect(enqueued?.authMode).toBe('unauthenticated');
    const enqueuedAt = enqueued?.createdAt;

    const backend = new GatedBackend();
    const pending = runAgent(tdb, backend, spec, { runId });
    await backend.entered;

    const running = await readHeader(runId);
    expect(running?.status).toBe(RUN_STATUS_RUNNING);
    // The transition healed the identity to what the run actually resolved.
    expect(running?.authMode).toBe('api-key');
    // …and PRESERVED the run's first-seen instant (the enqueue), which is not part of the transition.
    expect(running?.createdAt).toEqual(enqueuedAt);

    backend.release();
    expect((await pending).status).toBe('completed');
    const done = await readHeader(runId);
    expect(done?.status).toBe('completed');
    expect(done?.createdAt).toEqual(enqueuedAt);
  });

  it('a run that FAILS leaves the header at error, not at running', async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'failing-run';

    const res = await runAgent(tdb, openGate('error'), spec, { runId });
    expect(res.status).toBe('error');
    expect((await readHeader(runId))?.status).toBe('error');
  });

  it('RECOVERY: a re-dispatch onto a non-terminal header runs and reconciles it to the terminal outcome', async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'recovery-redispatch-run';

    // A crashed first attempt: the header exists at `running`, the run never reached a terminal write.
    const crashed = new GatedBackend();
    const abandoned = runAgent(tdb, crashed, spec, { runId });
    await crashed.entered;
    expect((await readHeader(runId))?.status).toBe(RUN_STATUS_RUNNING);

    // The recovery re-dispatch (same runId, replay=false — exactly how the durable executor re-runs a
    // lost-checkpoint job) is NOT blocked by the in-flight header, and completes the run.
    const recovered = openGate();
    const res = await runAgent(tdb, recovered, spec, { runId });
    expect(res.status).toBe('completed');
    expect(recovered.runs).toBe(1);
    expect((await readHeader(runId))?.status).toBe('completed');

    // Let the abandoned attempt drain: its own completing upsert finds a `completed` header and
    // cannot downgrade it.
    crashed.release();
    await abandoned;
    expect((await readHeader(runId))?.status).toBe('completed');
  });

  it('EXACTLY-ONCE: neither non-terminal write can move a completed header', async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'completed-header-run';

    expect((await runAgent(tdb, openGate(), spec, { runId })).status).toBe('completed');
    expect((await readHeader(runId))?.status).toBe('completed');

    // A late enqueue-time write for the same runId is a no-op (onConflictDoNothing).
    await insertEnqueuedRunHeader(tdb, {
      runId,
      backend: 'openai',
      agentName: spec.name,
      model: spec.model,
    });
    expect((await readHeader(runId))?.status).toBe('completed');

    // …and so is a re-dispatch's `running` transition: it applies only to an `enqueued` header, so the
    // completed run stays authoritative and terminal for the whole re-run.
    const redispatch = new GatedBackend();
    const pending = runAgent(tdb, redispatch, spec, { runId });
    await redispatch.entered;
    expect((await readHeader(runId))?.status).toBe('completed');
    redispatch.release();
    await pending;
    expect((await readHeader(runId))?.status).toBe('completed');
  });

  it('EXACTLY-ONCE: a finished error header is not overwritten with running by a re-dispatch', async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'error-header-run';

    expect((await runAgent(tdb, openGate('error'), spec, { runId })).status).toBe('error');
    expect((await readHeader(runId))?.status).toBe('error');

    const redispatch = new GatedBackend();
    const pending = runAgent(tdb, redispatch, spec, { runId });
    await redispatch.entered;
    // The `running` transition applies only to an `enqueued` header — the recorded outcome stands.
    expect((await readHeader(runId))?.status).toBe('error');
    redispatch.release();
    expect((await pending).status).toBe('completed');
    // The completing upsert then reconciles the healed run, exactly as before.
    expect((await readHeader(runId))?.status).toBe('completed');
  });
});
