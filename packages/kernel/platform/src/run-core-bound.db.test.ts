/**
 * The per-run wall-clock bound (RAYSPEC_AGENT_RUN_MAX_MS), DB-backed with a fake backend — NO LLM.
 *
 * A provider that accepts a request and never answers keeps `backend.run()` pending for as long as
 * the SDK's own retry window lasts; on the durable path that occupies a worker slot for the whole
 * time. The bound puts a ceiling on how long run-core WAITS: when it expires, `runAgent` rejects.
 *
 * WHAT THE BOUND DOES NOT DO: it does not cancel the in-flight SDK call. There is no cancellation
 * path in run-core, so the model call keeps running until it settles on its own — the bound frees the
 * caller (and, on the durable path, the worker slot), it does not abort the provider request. What it
 * DOES guarantee once it has fired is asserted below, seam by seam: an event the abandoned call emits
 * is dropped, a journal read or write it makes is refused, a transcript rehydrate is refused, and a
 * tool dispatch it STARTS after that point is refused closed (no handler run, no step, no taint
 * marker). A dispatch already inside the dispatcher is the separate case asserted alongside them: it
 * is not stopped, so its handler runs and its journal step is then refused.
 *
 * Both product callers reach the model through this one `runAgent`, and they differ only in the
 * handle they pass: the sync HTTP path calls it OUTSIDE any transaction; the durable worker calls it
 * INSIDE `forTenant(db, tenantId).transaction(...)` with a separate autonomous-commit `taintDb`. Both
 * invocation shapes are exercised here.
 */
import type {
  AgentSpec,
  Backend,
  NeutralTool,
  RunContext,
  RunResult,
  ToolDispatchResult,
} from '@rayspec/core';
import { classifyUpstreamError } from '@rayspec/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunAbandonedError, RunBoundTimeoutError } from './agent-bounds.js';
import { runAgent } from './run-core.js';
import { insertEnqueuedRunHeader } from './run-header.js';
import { isRunTainted } from './run-taint.js';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
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
 * The silent provider: `run()` emits one event, then never settles until the test releases it. It
 * keeps the RunContext so a test can emit through the run's sink AFTER the bound has fired — exactly
 * what an abandoned SDK call does when it eventually produces something.
 */
class SilentBackend implements Backend {
  readonly id = 'openai' as const;
  entered = 0;
  ctx?: RunContext;
  private release?: () => void;

  async resolveAuth() {
    return 'api-key' as const;
  }

  run(_spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.entered += 1;
    this.ctx = ctx;
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

/**
 * A provider that dispatches ONE tool call and then never settles: the shape where a dispatch is
 * ALREADY INSIDE the dispatcher at the instant the bound fires (as opposed to one the abandoned call
 * makes afterwards).
 */
class InFlightDispatchBackend implements Backend {
  readonly id = 'openai' as const;
  dispatched?: Promise<ToolDispatchResult>;
  private release?: () => void;

  async resolveAuth() {
    return 'api-key' as const;
  }

  run(_spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.dispatched = ctx.dispatchTool?.('charge_card', { amount: 42 }, 'call-in-flight');
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

/** A backend that takes `delayMs` to answer — slower than any bound the unbounded tests set. */
class SlowBackend implements Backend {
  readonly id = 'openai' as const;
  constructor(private readonly delayMs: number) {}
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(_spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return completedResult(ctx);
  }
}

async function countRunEvents(runId: string): Promise<number> {
  const rows = (await db.$client.unsafe(
    'SELECT count(*)::int AS n FROM run_events WHERE run_id = $1',
    [runId],
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** journal_steps rows for a run, read on the pool (so only COMMITTED rows are counted). */
async function countJournalSteps(runId: string): Promise<number> {
  const rows = (await db.$client.unsafe(
    'SELECT count(*)::int AS n FROM journal_steps WHERE run_id = $1',
    [runId],
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** The run's header status, or undefined when no header row exists. */
async function runHeaderStatus(runId: string): Promise<string | undefined> {
  const rows = (await db.$client.unsafe('SELECT status FROM runs WHERE run_id = $1', [
    runId,
  ])) as unknown as { status: string }[];
  return rows[0]?.status;
}

/** How many times the side-effecting handler ACTUALLY fired (the real effect counter). */
let sideEffectFires = 0;

/**
 * A NON-IDEMPOTENT tool: firing it once more for an abandoned run is a real double-effect.
 * `handlerDelayMs` holds the handler inside the dispatcher, so a test can have a dispatch still in
 * flight when the bound fires.
 */
function nonIdempotentTool(handlerDelayMs = 0): NeutralTool {
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
    handler: async (args: unknown) => {
      if (handlerDelayMs > 0) await new Promise((r) => setTimeout(r, handlerDelayMs));
      sideEffectFires += 1; // the real, irreversible effect
      const { amount } = (args ?? {}) as { amount?: number };
      return { charged: amount ?? 0 };
    },
    timeoutMs: 5000,
    idempotent: false,
  };
}

function setBound(value: string | undefined): void {
  if (value === undefined) delete process.env.RAYSPEC_AGENT_RUN_MAX_MS;
  else process.env.RAYSPEC_AGENT_RUN_MAX_MS = value;
}

const savedBound = process.env.RAYSPEC_AGENT_RUN_MAX_MS;
const open: { finish(): void }[] = [];

beforeAll(async () => {
  await resetRunSchema(db);
});

beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A);
  setBound(undefined);
  sideEffectFires = 0;
});

afterEach(() => {
  for (const b of open.splice(0)) b.finish();
  setBound(savedBound);
});

afterAll(async () => {
  await db.$client.end();
});

describe('per-run wall-clock bound', () => {
  it('SYNC invocation shape (no transaction): a run that outlives the bound rejects', async () => {
    setBound('120');
    const backend = new SilentBackend();
    open.push(backend);
    const started = Date.now();
    await expect(
      runAgent(forTenant(db, TENANT_A), backend, spec, { runId: 'bound-sync' }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    expect(backend.entered).toBe(1);
    // It rejected because the bound expired, not because the backend answered: the backend is still
    // pending, and the rejection landed no earlier than the bound.
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  it('DURABLE invocation shape (inside the run transaction, with a taintDb): the same bound applies', async () => {
    setBound('120');
    const backend = new SilentBackend();
    open.push(backend);
    // Mirror the durable executor: runAgent runs INSIDE forTenant(db,tenant).transaction() and gets a
    // SEPARATE autonomous-commit TenantDb for the taint marker.
    await expect(
      forTenant(db, TENANT_A).transaction((txTdb) =>
        runAgent(txTdb, backend, spec, {
          runId: 'bound-durable',
          taintDb: forTenant(db, TENANT_A),
        }),
      ),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    expect(backend.entered).toBe(1);
  });

  it('names the variable and the elapsed bound, and classifies as the neutral `timeout`', async () => {
    setBound('80');
    const backend = new SilentBackend();
    open.push(backend);
    const err = await runAgent(forTenant(db, TENANT_A), backend, spec, {
      runId: 'bound-message',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunBoundTimeoutError);
    const message = (err as Error).message;
    expect(message).toContain('RAYSPEC_AGENT_RUN_MAX_MS');
    expect(message).toContain('80');
    expect(message).toContain('bound-message');
    // Run the REAL neutral classifier over it: a bounded run classifies as `timeout`, not as a
    // generic internal error. What each CALLER does with the rejection is asserted where that caller
    // lives — the sync JSON/SSE surface in the api-auth run-route tests, not here.
    expect(classifyUpstreamError(err).errorClass).toBe('timeout');
  });

  it('an event emitted by the ABANDONED call after the bound fired is not persisted', async () => {
    setBound('100');
    const backend = new SilentBackend();
    open.push(backend);
    await expect(
      runAgent(forTenant(db, TENANT_A), backend, spec, { runId: 'bound-abandoned' }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    const before = await countRunEvents('bound-abandoned');
    // The abandoned SDK call keeps going and emits through the run's sink. It must neither throw
    // back into that call nor land a row after the run was given up on.
    await expect(
      backend.ctx?.onEvent?.({ type: 'run_started', runId: 'bound-abandoned', seq: 0 }),
    ).resolves.toBeUndefined();
    expect(await countRunEvents('bound-abandoned')).toBe(before);
  });

  it('a journal call from the ABANDONED call after the bound fired is refused, and writes nothing', async () => {
    setBound('100');
    const backend = new SilentBackend();
    open.push(backend);
    await expect(
      runAgent(forTenant(db, TENANT_A), backend, spec, { runId: 'bound-journal' }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    // The abandoned SDK call settles LATER and journals its step then — that is the normal shape of
    // an adapter's error/success branch. The journal is bound to the run's tdb (on the durable path a
    // transaction that has already rolled back), so the call is refused rather than issued.
    await expect(
      backend.ctx?.journal.record({
        type: 'llm',
        idempotencyKey: 'llm:after-the-bound',
        inputHash: 'hash:after-the-bound',
        output: { finalText: 'late' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        costUsd: 0,
        model: spec.model,
        producedBy: 'silent-backend',
        latencyMs: 1,
        status: 'ok',
        authMode: 'api-key',
      }),
    ).rejects.toThrow(/RAYSPEC_AGENT_RUN_MAX_MS/);
    expect(await countJournalSteps('bound-journal')).toBe(0);
    // The READS are on the same handle, so they are refused too — the containment is "no statement
    // through this run's handle once the bound fired", not "no write".
    await expect(backend.ctx?.journal.lookup('llm:after-the-bound')).rejects.toThrow(
      /RAYSPEC_AGENT_RUN_MAX_MS/,
    );
    await expect(backend.ctx?.rehydrate()).rejects.toThrow(/RAYSPEC_AGENT_RUN_MAX_MS/);
  });

  it('a tool dispatch from the ABANDONED call is refused CLOSED: no handler, no step, no taint', async () => {
    setBound('100');
    const backend = new SilentBackend();
    open.push(backend);
    await expect(
      runAgent(forTenant(db, TENANT_A), backend, spec, {
        runId: 'bound-tool',
        tools: [nonIdempotentTool()],
      }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    // The abandoned call marshals a tool call the way an adapter does when the model finally answers.
    const dispatched = await backend.ctx?.dispatchTool?.(
      'charge_card',
      { amount: 42 },
      'call-late',
    );
    expect(dispatched?.kind).toBe('tool_error');
    // The handler did NOT run: no side effect for a run that was already given up on.
    expect(sideEffectFires).toBe(0);
    expect(await countJournalSteps('bound-tool')).toBe(0);
    expect(await isRunTainted(forTenant(db, TENANT_A), 'bound-tool')).toBe(false);
  });

  it('a dispatch ALREADY IN FLIGHT when the bound fires is NOT stopped: the handler runs, its journal step is refused', async () => {
    setBound('120');
    const backend = new InFlightDispatchBackend();
    open.push(backend);
    // The handler is held for 600ms — five times the bound — so the dispatch is provably still inside
    // the dispatcher when the bound fires.
    await expect(
      runAgent(forTenant(db, TENANT_A), backend, spec, {
        runId: 'bound-in-flight',
        tools: [nonIdempotentTool(600)],
      }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    // The run-core gate covers a dispatch that ARRIVES once the flag is set. This one was already
    // past it, so nothing refuses it: the side effect had not fired when the run rejected, and it
    // fires afterwards.
    expect(sideEffectFires).toBe(0);
    const dispatched = backend.dispatched;
    expect(dispatched).toBeDefined();
    // What the dispatch returns to the abandoned call is the journal seam's refusal, NOT the neutral
    // `tool_error` a dispatch arriving after the flag gets: recordToolStep runs before emitResult.
    await expect(dispatched).rejects.toBeInstanceOf(RunAbandonedError);
    expect(sideEffectFires).toBe(1);
    // The taint marker was committed BEFORE the handler (the dispatcher's fail-closed ordering), so it
    // is on record even though the run had been given up on. The step is not: the journal refused it,
    // so an effect that really happened is unjournaled.
    expect(await isRunTainted(forTenant(db, TENANT_A), 'bound-in-flight')).toBe(true);
    expect(await countJournalSteps('bound-in-flight')).toBe(0);
  });

  it('DURABLE shape, header PRE-WRITTEN by the enqueue: the bound leaves it at `enqueued`', async () => {
    setBound('120');
    const backend = new SilentBackend();
    open.push(backend);
    // The API enqueue path writes the `enqueued` header BEFORE the job is handed to the worker (#164).
    await insertEnqueuedRunHeader(forTenant(db, TENANT_A), {
      runId: 'bound-durable-header',
      backend: 'openai',
      agentName: spec.name,
      model: spec.model,
    });
    await expect(
      forTenant(db, TENANT_A).transaction((txTdb) =>
        runAgent(txTdb, backend, spec, {
          runId: 'bound-durable-header',
          taintDb: forTenant(db, TENANT_A),
        }),
      ),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    // run-core's `enqueued` → `running` write is inside the run transaction, which rolls back with the
    // rejection, and no completing write is reached. So a bounded durable run leaves NO terminal
    // header: the row reads exactly as the enqueue wrote it. This is what the CHANGELOG states.
    expect(await runHeaderStatus('bound-durable-header')).toBe('enqueued');
  });

  it('DURABLE shape, NO header pre-written: the bound leaves no `runs` row at all', async () => {
    setBound('120');
    const backend = new SilentBackend();
    open.push(backend);
    // The other way a job reaches the durable executor: the cron scheduler's agent action enqueues
    // straight onto the executor without writing a header first (cron-scheduler.ts, `AGENT action`).
    // run-core's own header write is inside the run transaction, so the rejection rolls it back and
    // nothing about this run is left in `runs` — there is no header to test for terminality.
    await expect(
      forTenant(db, TENANT_A).transaction((txTdb) =>
        runAgent(txTdb, backend, spec, {
          runId: 'bound-durable-no-header',
          taintDb: forTenant(db, TENANT_A),
        }),
      ),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    expect(await runHeaderStatus('bound-durable-no-header')).toBeUndefined();
  });

  it('UNSET: a run slower than any bound still completes (today’s unbounded behaviour)', async () => {
    setBound(undefined);
    const result = await runAgent(forTenant(db, TENANT_A), new SlowBackend(300), spec, {
      runId: 'bound-unset',
    });
    expect(result.status).toBe('completed');
  });

  it('MALFORMED: an unparsable value leaves the run unbounded', async () => {
    setBound('later');
    const result = await runAgent(forTenant(db, TENANT_A), new SlowBackend(300), spec, {
      runId: 'bound-malformed',
    });
    expect(result.status).toBe('completed');
  });

  it('a run that finishes INSIDE the bound is unaffected', async () => {
    setBound('5000');
    const result = await runAgent(forTenant(db, TENANT_A), new SlowBackend(20), spec, {
      runId: 'bound-inside',
    });
    expect(result.status).toBe('completed');
  });
});
