/**
 * Run cancellation in run-core, DB-backed with a fake backend — NO LLM.
 *
 * A run that has been cancelled must STOP: run-core rejects with a {@link RunCancelledError} and the
 * backend call it stopped waiting for is treated exactly like a run the wall-clock bound abandoned —
 * every seam the RunContext handed it goes inert (event sink, journal, tool dispatch, rehydrate), so a
 * cancelled run writes nothing further. The seams are the SAME machinery the bound already uses; what
 * differs is only what the refusal says happened.
 *
 * The signal reaches the adapter too: `ctx.signal` is the run's own AbortSignal, so a backend that can
 * abort its SDK call learns about the cancellation directly rather than only being left in flight.
 *
 * UNSET (no cancellation anywhere): a run behaves exactly as it did before this existed — the whole
 * point of the additive design, asserted here rather than assumed.
 */
import type { AgentSpec, Backend, NeutralTool, RunContext, RunResult } from '@rayspec/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunAbandonedError } from './agent-bounds.js';
import {
  isRunCancelled,
  markRunCancelled,
  RunCancelledError,
  recordRunCancelled,
  signalRunCancelled,
} from './run-cancel.js';
import { runAgent } from './run-core.js';
import { insertEnqueuedRunHeader } from './run-header.js';
import { isRunTainted } from './run-taint.js';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
  TENANT_B,
} from './test-support/test-db.js';

const db = makeTestDb();

const spec: AgentSpec = {
  name: 'extract',
  instructions: 'extract fields',
  model: 'gpt-4.1-mini',
  input: 'a transcript',
  tools: [],
  maxTurns: 8,
};

function completedResult(ctx: RunContext): RunResult {
  return {
    runId: ctx.runId,
    backend: 'openai',
    authMode: 'api-key',
    status: 'completed',
    finalText: 'done',
    output: null,
    error: null,
    errorClass: null,
    conversation: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    costUsd: 0,
    stepCount: 0,
  };
}

/**
 * A backend that never settles on its own and REPORTS what it saw on `ctx.signal`. It keeps the
 * RunContext so a test can use the run's seams after run-core has given up on it.
 */
class SilentBackend implements Backend {
  readonly id = 'openai' as const;
  entered = 0;
  ctx?: RunContext;
  /** Set by the signal's own abort listener — proof the adapter is told, not merely left hanging. */
  sawAbort = false;
  private release?: () => void;

  async resolveAuth() {
    return 'api-key' as const;
  }

  run(_spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.entered += 1;
    this.ctx = ctx;
    ctx.signal?.addEventListener('abort', () => {
      this.sawAbort = true;
    });
    return new Promise<RunResult>((resolve) => {
      this.release = () => resolve(completedResult(ctx));
    });
  }

  /** Let the abandoned call finish, so no promise is left pending when the suite ends. */
  finish(): void {
    this.release?.();
    this.release = undefined;
  }
}

/** A backend that takes `delayMs` to answer — the unbounded, uncancelled control. */
class SlowBackend implements Backend {
  readonly id = 'openai' as const;
  /** What `ctx.signal` looked like when the run started (the UNSET assertion reads this). */
  sawAborted?: boolean;
  constructor(private readonly delayMs: number) {}
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(_spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.sawAborted = ctx.signal?.aborted;
    await new Promise((r) => setTimeout(r, this.delayMs));
    return completedResult(ctx);
  }
}

/** How many times the side-effecting handler ACTUALLY fired (the real effect counter). */
let sideEffectFires = 0;

/** A NON-IDEMPOTENT tool: firing it once more for a cancelled run is a real double-effect. */
function nonIdempotentTool(): NeutralTool {
  return {
    spec: {
      name: 'charge_card',
      description: 'Charge the customer (SIDE EFFECT — moves money).',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
        additionalProperties: false,
      },
    },
    handler: (args: unknown) => {
      sideEffectFires += 1;
      const { amount } = (args ?? {}) as { amount?: number };
      return { charged: amount ?? 0 };
    },
    timeoutMs: 5000,
    idempotent: false,
  };
}

async function countJournalSteps(runId: string): Promise<number> {
  const rows = (await db.$client.unsafe(
    'SELECT count(*)::int AS n FROM journal_steps WHERE run_id = $1',
    [runId],
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

async function runHeaderStatus(runId: string): Promise<string | undefined> {
  const rows = (await db.$client.unsafe('SELECT status FROM runs WHERE run_id = $1', [
    runId,
  ])) as unknown as { status: string }[];
  return rows[0]?.status;
}

const open: { finish(): void }[] = [];

beforeAll(async () => {
  await resetRunSchema(db);
});

beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A, TENANT_B);
  sideEffectFires = 0;
});

afterEach(() => {
  for (const b of open.splice(0)) b.finish();
});

afterAll(async () => {
  await db.$client.end();
});

describe('cancelling a run in flight', () => {
  it('SYNC invocation shape (no transaction): a cancelled run rejects with RunCancelledError', async () => {
    const backend = new SilentBackend();
    open.push(backend);
    const running = runAgent(forTenant(db, TENANT_A), backend, spec, { runId: 'cancel-sync' });
    // The run is registered while it executes, so it can be named and ended by id.
    await waitFor(() => backend.entered === 1);
    expect(signalRunCancelled('cancel-sync')).toBe(true);
    await expect(running).rejects.toBeInstanceOf(RunCancelledError);
    // The adapter was TOLD: the signal it was handed aborted, it was not merely left in flight.
    expect(backend.sawAbort).toBe(true);
  });

  it('DURABLE invocation shape (inside the run transaction, with a taintDb): the same cancellation applies', async () => {
    const backend = new SilentBackend();
    open.push(backend);
    const running = forTenant(db, TENANT_A).transaction((txTdb) =>
      runAgent(txTdb, backend, spec, {
        runId: 'cancel-durable',
        taintDb: forTenant(db, TENANT_A),
      }),
    );
    await waitFor(() => backend.entered === 1);
    expect(signalRunCancelled('cancel-durable')).toBe(true);
    await expect(running).rejects.toBeInstanceOf(RunCancelledError);
  });

  it('a CALLER-SUPPLIED signal cancels the run too (the additive RunOptions.signal seam)', async () => {
    const backend = new SilentBackend();
    open.push(backend);
    const controller = new AbortController();
    const running = runAgent(forTenant(db, TENANT_A), backend, spec, {
      runId: 'cancel-opt-signal',
      signal: controller.signal,
    });
    await waitFor(() => backend.entered === 1);
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(RunCancelledError);
    expect(backend.sawAbort).toBe(true);
  });

  it('a signal that is ALREADY aborted stops the run before the backend is called at all', async () => {
    const backend = new SilentBackend();
    open.push(backend);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAgent(forTenant(db, TENANT_A), backend, spec, {
        runId: 'cancel-pre-aborted',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunCancelledError);
    expect(backend.entered).toBe(0);
  });

  it('names the run and says what was cancelled — and does NOT claim to have stopped the model call', async () => {
    const backend = new SilentBackend();
    open.push(backend);
    const running = runAgent(forTenant(db, TENANT_A), backend, spec, { runId: 'cancel-message' });
    await waitFor(() => backend.entered === 1);
    signalRunCancelled('cancel-message');
    const err = await running.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunCancelledError);
    expect((err as Error).message).toContain('cancel-message');
    expect((err as Error).message).toContain('cancelled');
  });

  it('the seams of a CANCELLED run are inert: no event, no journal write, no rehydrate, no tool fire', async () => {
    const backend = new SilentBackend();
    open.push(backend);
    const running = runAgent(forTenant(db, TENANT_A), backend, spec, {
      runId: 'cancel-seams',
      tools: [nonIdempotentTool()],
    });
    await waitFor(() => backend.entered === 1);
    signalRunCancelled('cancel-seams');
    await expect(running).rejects.toBeInstanceOf(RunCancelledError);

    // The cancelled call keeps going and reaches for the run's seams. Every one refuses.
    await expect(
      backend.ctx?.onEvent?.({ type: 'run_started', runId: 'cancel-seams', seq: 0 }),
    ).resolves.toBeUndefined();
    await expect(
      backend.ctx?.journal.record({
        type: 'llm',
        idempotencyKey: 'llm:after-the-cancel',
        inputHash: 'hash:after-the-cancel',
        output: { finalText: 'late' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        costUsd: 0,
        model: spec.model,
        producedBy: 'silent-backend',
        latencyMs: 1,
        status: 'ok',
        authMode: 'api-key',
      }),
    ).rejects.toBeInstanceOf(RunAbandonedError);
    await expect(backend.ctx?.rehydrate()).rejects.toBeInstanceOf(RunAbandonedError);
    const dispatched = await backend.ctx?.dispatchTool?.(
      'charge_card',
      { amount: 42 },
      'call-late',
    );
    expect(dispatched?.kind).toBe('tool_error');
    // The handler did NOT run — a cancelled run never fires a fresh side effect.
    expect(sideEffectFires).toBe(0);
    expect(await countJournalSteps('cancel-seams')).toBe(0);
    expect(await isRunTainted(forTenant(db, TENANT_A), 'cancel-seams')).toBe(false);
  });

  it('the refusal a cancelled run’s seam gives NAMES the cancellation, not the wall-clock bound', async () => {
    const backend = new SilentBackend();
    open.push(backend);
    const running = runAgent(forTenant(db, TENANT_A), backend, spec, { runId: 'cancel-refusal' });
    await waitFor(() => backend.entered === 1);
    signalRunCancelled('cancel-refusal');
    await expect(running).rejects.toBeInstanceOf(RunCancelledError);
    const err = await backend.ctx?.rehydrate().catch((e: unknown) => e);
    expect((err as Error).message).toContain('cancelled');
    expect((err as Error).message).not.toContain('RAYSPEC_AGENT_RUN_MAX_MS');
  });

  it('a run that has ENDED is no longer cancellable by id (the registration is released)', async () => {
    const result = await runAgent(forTenant(db, TENANT_A), new SlowBackend(10), spec, {
      runId: 'cancel-after-end',
    });
    expect(result.status).toBe('completed');
    expect(signalRunCancelled('cancel-after-end')).toBe(false);
  });
});

describe('the persisted cancellation record', () => {
  it('marks, reads back, and is tenant-scoped (a foreign tenant reads no marker)', async () => {
    await markRunCancelled(forTenant(db, TENANT_A), 'marker-run');
    expect(await isRunCancelled(forTenant(db, TENANT_A), 'marker-run')).toBe(true);
    expect(await isRunCancelled(forTenant(db, TENANT_B), 'marker-run')).toBe(false);
    // Idempotent: a repeated mark is a no-op, never a unique-violation.
    await markRunCancelled(forTenant(db, TENANT_A), 'marker-run');
    expect(await isRunCancelled(forTenant(db, TENANT_A), 'marker-run')).toBe(true);
  });

  it('journals the terminal outcome of a not-yet-started run: header `error`, step class `cancelled`', async () => {
    const tdb = forTenant(db, TENANT_A);
    await insertEnqueuedRunHeader(tdb, {
      runId: 'record-enqueued',
      backend: 'openai',
      agentName: spec.name,
      model: spec.model,
    });
    const outcome = await recordRunCancelled(tdb, 'record-enqueued');
    expect(outcome.cancelled).toBe(true);
    expect(await runHeaderStatus('record-enqueued')).toBe('error');
    const rows = (await db.$client.unsafe(
      'SELECT status, error_class FROM journal_steps WHERE run_id = $1',
      ['record-enqueued'],
    )) as unknown as Array<{ status: string; error_class: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'error', error_class: 'cancelled' });
  });

  it('leaves a run that ALREADY finished exactly as it was (a finished run keeps its outcome)', async () => {
    const result = await runAgent(forTenant(db, TENANT_A), new SlowBackend(5), spec, {
      runId: 'record-finished',
    });
    expect(result.status).toBe('completed');
    const outcome = await recordRunCancelled(forTenant(db, TENANT_A), 'record-finished');
    expect(outcome.cancelled).toBe(false);
    expect(await runHeaderStatus('record-finished')).toBe('completed');
  });
});

describe('UNSET — no cancellation anywhere', () => {
  it('a run nobody cancels completes exactly as before, with an un-aborted signal', async () => {
    const backend = new SlowBackend(120);
    const result = await runAgent(forTenant(db, TENANT_A), backend, spec, {
      runId: 'cancel-unset',
    });
    expect(result.status).toBe('completed');
    expect(backend.sawAborted).toBe(false);
    expect(await runHeaderStatus('cancel-unset')).toBe('completed');
    expect(await isRunCancelled(forTenant(db, TENANT_A), 'cancel-unset')).toBe(false);
  });

  it('cancelling an id NOTHING is running under changes nothing and reports it did nothing', () => {
    expect(signalRunCancelled('no-such-run')).toBe(false);
  });
});

/** Poll `predicate` until it holds (bounded) — a deterministic barrier, never a fixed sleep. */
async function waitFor(predicate: () => boolean, capMs = 2000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`condition did not hold within ${capMs}ms`);
}
