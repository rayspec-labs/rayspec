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
 *  - ASYNC VISIBILITY: with the run inside the transaction the durable executor wraps it in, a reader
 *    outside that transaction sees the enqueue-time status for the whole run and then the terminal one.
 *  - RECOVERY re-dispatch onto a non-terminal header (a crashed run left `running`) still runs and
 *    reconciles to the healed terminal outcome.
 *  - A run that RETURNS `status:'error'` lands at `error`; a run that THROWS reaches no completing
 *    write at all and leaves its header at `running` (the documented non-terminal residual).
 *  - The completing write records the identity the RUN resolved — an adapter that reconciles its auth
 *    mode during the run lands the RESULT's value in the header, not the pre-run one.
 *  - The enqueue-time write does NOT wait on a run transaction that holds the header row.
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
  markRunHeaderRunning,
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
  /** What `resolveAuth()` answers BEFORE the run — the pre-run check. */
  preRunAuthMode: AuthMode = 'api-key';
  /** What the RunResult carries — an adapter may reconcile the mode during the run. */
  resultAuthMode: AuthMode = 'api-key';
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
    return this.preRunAuthMode;
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
      authMode: this.resultAuthMode,
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

/** A backend that THROWS instead of returning a RunResult (a timeout / an exception mid-run). */
class ThrowingBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth(): Promise<AuthMode> {
    return 'api-key';
  }
  async run(): Promise<RunResult> {
    throw new Error('the backend threw');
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

  it('ASYNC: while the run holds its transaction an outside reader still sees enqueued, then the terminal status', async () => {
    const runId = 'async-visibility-run';
    const tdb = forTenant(db, TENANT_A);

    await insertEnqueuedRunHeader(tdb, {
      runId,
      backend: 'openai',
      agentName: spec.name,
      model: spec.model,
    });

    // The durable path runs `runAgent` INSIDE forTenant(db, tenantId).transaction() — the executor's
    // one durable step. Every header write the run makes therefore commits with the run, so the
    // `running` transition is not observable from outside it.
    const backend = new GatedBackend();
    const pending = forTenant(db, TENANT_A).transaction(async (txTdb) => {
      await runAgent(txTdb, backend, spec, { runId });
    });
    await backend.entered;

    // `readHeader` reads on a SEPARATE connection — what an API read of GET /v1/runs/{id} sees.
    expect((await readHeader(runId))?.status).toBe(RUN_STATUS_ENQUEUED);

    backend.release();
    await pending;
    expect((await readHeader(runId))?.status).toBe('completed');
  });

  it("a run that RETURNS status:'error' leaves the header at error, not at running", async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'failing-run';

    const res = await runAgent(tdb, openGate('error'), spec, { runId });
    expect(res.status).toBe('error');
    expect((await readHeader(runId))?.status).toBe('error');
  });

  it('a run that THROWS reaches no completing write, so its header stays at running (the non-terminal residual)', async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'throwing-run';

    // A backend that throws instead of returning a RunResult (a timeout / an exception) — the class
    // the run surface names separately from a returned `status:'error'`. runAgent rethrows without
    // any completing write, and on this (sync) path the `running` header has already COMMITTED.
    await expect(runAgent(tdb, new ThrowingBackend(), spec, { runId })).rejects.toThrow(
      'the backend threw',
    );
    const header = await readHeader(runId);
    expect(header?.status).toBe(RUN_STATUS_RUNNING);
    expect(isTerminalRunStatus(header?.status ?? '')).toBe(false);
  });

  it('the completing write records the authMode the RUN resolved, not the pre-run one', async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'reconciled-authmode-run';

    // An adapter may RECONCILE the auth mode during the run (the Anthropic adapter does, off the live
    // CLI init message), so `resolveAuth()`'s answer and the RunResult's can differ. The run's own
    // journal steps carry the reconciled mode; the header must carry it too.
    const backend = openGate();
    backend.preRunAuthMode = 'unauthenticated';
    backend.resultAuthMode = 'api-key';

    const res = await runAgent(tdb, backend, spec, { runId });
    expect(res.authMode).toBe('api-key');
    const header = await readHeader(runId);
    expect(header?.status).toBe('completed');
    // FAIL-THE-FIX: without the identity refresh on the completing write this reads back the pre-run
    // 'unauthenticated' the `running` transition wrote.
    expect(header?.authMode).toBe('api-key');
  });

  it('the enqueue-time write does NOT wait on the run transaction that holds the header row', async () => {
    const tdb = forTenant(db, TENANT_A);
    const runId = 'enqueue-vs-runtx-run';

    // The real order: the enqueue path writes the header BEFORE the job exists, so the row is
    // COMMITTED by the time a worker starts. The worker then runs inside its own transaction, whose
    // `running` write holds that row's lock until the run ends.
    expect(
      await insertEnqueuedRunHeader(tdb, {
        runId,
        backend: 'openai',
        agentName: spec.name,
        model: spec.model,
      }),
    ).toBe(true);

    const HELD_MS = 1_000;
    let releaseRunTx: () => void = () => {};
    const runTxHolding = new Promise<void>((resolve) => {
      const held = new Promise<void>((r) => {
        releaseRunTx = r;
      });
      void forTenant(db, TENANT_A)
        .transaction(async (txTdb) => {
          await markRunHeaderRunning(txTdb, {
            runId,
            backend: 'openai',
            authMode: 'api-key',
            agentName: spec.name,
            model: spec.model,
          });
          resolve();
          await held;
        })
        .catch(() => {});
    });
    await runTxHolding;
    setTimeout(() => releaseRunTx(), HELD_MS);

    // A second enqueue-time write for the same runId (the PINNED-runId re-enqueue) returns at once:
    // it READS the committed header first and has nothing to add, so it never issues the INSERT that
    // would wait on the open run transaction.
    const t0 = Date.now();
    const created = await insertEnqueuedRunHeader(tdb, {
      runId,
      backend: 'openai',
      agentName: spec.name,
      model: spec.model,
    });
    const elapsed = Date.now() - t0;
    expect(created).toBe(false);
    expect(elapsed).toBeLessThan(HELD_MS / 2);

    // COUNTERPROOF (the same statement WITHOUT the pre-read): an unconditional ON CONFLICT DO NOTHING
    // insert on that runId waits for the run transaction to end — measured, not asserted from theory.
    const t1 = Date.now();
    await db
      .insert(schema.runs)
      .values({
        runId,
        tenantId: TENANT_A,
        backend: 'openai',
        authMode: 'unauthenticated',
        agentName: spec.name,
        model: spec.model,
        status: RUN_STATUS_ENQUEUED,
      })
      .onConflictDoNothing();
    expect(Date.now() - t1).toBeGreaterThan(HELD_MS / 2);
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
