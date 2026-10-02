/**
 * The per-run wall-clock bound (RAYSPEC_AGENT_RUN_MAX_MS), DB-backed with a fake backend — NO LLM.
 *
 * A provider that accepts a request and never answers keeps `backend.run()` pending for as long as
 * the SDK's own retry window lasts; on the durable path that occupies a worker slot for the whole
 * time. The bound ENDS such a run: when it expires, run-core aborts the run's signal — so a backend
 * that honours `ctx.signal` stops its provider call — waits at most the kill grace for the call to
 * settle, records the run terminal with the neutral `timeout` class and what happened to the call
 * (`call-aborted` when it settled, `outcome-unknown` when it did not), and rejects.
 *
 * Once the bound has fired the run's seams are inert, asserted below seam by seam: an event the
 * abandoned call emits is dropped, a journal read or write it makes is refused, a transcript
 * rehydrate is refused, and a tool dispatch it STARTS after that point is refused closed (no handler
 * run, no step, no taint marker). A dispatch already inside the dispatcher is the separate case: it is
 * not stopped, so its handler runs and its journal step is then refused.
 *
 * Both product callers reach the model through this one `runAgent`; neither holds a transaction across
 * it, and the durable worker passes a `taintDb`. Both invocation shapes are exercised here.
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
import { resolveExecutionPolicy } from './execution-policy.js';
import { CALL_SETTLE_MARGIN_MS, RUN_END_RECORD_BUDGET_MS, runAgent } from './run-core.js';
import { insertEnqueuedRunHeader } from './run-header.js';
import { isRunTainted } from './run-taint.js';
import {
  forTenant,
  makeTestAppDb,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const db = makeTestDb();
// The handle code under test runs over: `db` itself, or in the runtime-role lane the runtime role's
// (see `makeTestAppDb`); `db` stays the one the suite seeds and inspects through.
let appDb: ReturnType<typeof makeTestDb> = db;
let closeAppDb: () => Promise<void> = async () => {};

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
  /** Whether the run's signal aborted while the call was held — the bound telling it to stop. */
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
    // Observed by the test later; a handler now keeps its rejection from reading as unhandled while
    // run-core waits for the stopped call.
    this.dispatched?.catch(() => {});
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
 * The provider that honours its signal: `run()` never answers on its own, and an abort ends the call
 * at once with an `AbortError`, as a provider SDK does.
 */
class AbortableBackend implements Backend {
  readonly id = 'openai' as const;
  sawAbort = false;
  async resolveAuth() {
    return 'api-key' as const;
  }
  run(_spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    return new Promise<RunResult>((_resolve, reject) => {
      ctx.signal?.addEventListener('abort', () => {
        this.sawAbort = true;
        const err = new Error('the provider call was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
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

/**
 * journal_steps rows for a run OTHER than the bound's own outcome step, read on the pool (so only
 * COMMITTED rows are counted) — the steps the abandoned call could have written.
 */
async function countJournalSteps(runId: string): Promise<number> {
  const rows = (await db.$client.unsafe(
    "SELECT count(*)::int AS n FROM journal_steps WHERE run_id = $1 AND type <> 'bound'",
    [runId],
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** The bound's recorded outcome step: its class and what it states about the provider call. */
async function boundOutcome(
  runId: string,
): Promise<{ errorClass: string | null; phase: string | null } | undefined> {
  const rows = (await db.$client.unsafe(
    "SELECT error_class, output->>'phase' AS phase FROM journal_steps WHERE run_id = $1 AND type = 'bound'",
    [runId],
  )) as unknown as { error_class: string | null; phase: string | null }[];
  const row = rows[0];
  return row === undefined ? undefined : { errorClass: row.error_class, phase: row.phase };
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
const savedGrace = process.env.RAYSPEC_AGENT_KILL_GRACE_MS;
const open: { finish(): void }[] = [];

beforeAll(async () => {
  await resetRunSchema(db);
  ({ appDb, close: closeAppDb } = await makeTestAppDb(db));
});

beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A);
  setBound(undefined);
  // A short kill grace: a call that ignores its signal is recorded unknown quickly.
  process.env.RAYSPEC_AGENT_KILL_GRACE_MS = '50';
  sideEffectFires = 0;
});

afterEach(() => {
  for (const b of open.splice(0)) b.finish();
  setBound(savedBound);
  if (savedGrace === undefined) delete process.env.RAYSPEC_AGENT_KILL_GRACE_MS;
  else process.env.RAYSPEC_AGENT_KILL_GRACE_MS = savedGrace;
});

afterAll(async () => {
  await closeAppDb();
  await db.$client.end();
});

describe('per-run wall-clock bound', () => {
  it('SYNC invocation shape: a run that outlives the bound is told to stop, recorded, and rejects', async () => {
    setBound('120');
    const backend = new AbortableBackend();
    const started = Date.now();
    await expect(
      runAgent(forTenant(appDb, TENANT_A), backend, spec, { runId: 'bound-sync' }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    // The bound ENDS the run: the backend's signal aborted, so it stopped its call — and the
    // rejection landed no earlier than the bound and promptly after it (the call settled at once).
    expect(backend.sawAbort).toBe(true);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(110);
    expect(elapsed).toBeLessThan(1_000);
    expect(await runHeaderStatus('bound-sync')).toBe('error');
    expect(await boundOutcome('bound-sync')).toEqual({
      errorClass: 'timeout',
      phase: 'call-aborted',
    });
  });

  it('a call that IGNORES its signal is recorded `outcome-unknown`, never claimed stopped', async () => {
    setBound('120');
    const backend = new SilentBackend();
    open.push(backend);
    await expect(
      runAgent(forTenant(appDb, TENANT_A), backend, spec, { runId: 'bound-unknown' }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    expect(backend.sawAbort).toBe(true);
    expect(await runHeaderStatus('bound-unknown')).toBe('error');
    expect(await boundOutcome('bound-unknown')).toEqual({
      errorClass: 'timeout',
      phase: 'outcome-unknown',
    });
  });

  it('DURABLE invocation shape (with a taintDb): the same bound applies', async () => {
    setBound('120');
    const backend = new SilentBackend();
    open.push(backend);
    await expect(
      runAgent(forTenant(appDb, TENANT_A), backend, spec, {
        runId: 'bound-durable',
        taintDb: forTenant(appDb, TENANT_A),
      }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    expect(backend.entered).toBe(1);
  });

  it('names the variable and the elapsed bound, and classifies as the neutral `timeout`', async () => {
    setBound('80');
    const backend = new SilentBackend();
    open.push(backend);
    const err = await runAgent(forTenant(appDb, TENANT_A), backend, spec, {
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
      runAgent(forTenant(appDb, TENANT_A), backend, spec, { runId: 'bound-abandoned' }),
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
      runAgent(forTenant(appDb, TENANT_A), backend, spec, { runId: 'bound-journal' }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    // The abandoned SDK call settles LATER and journals its step then — that is the normal shape of
    // an adapter's error/success branch. The run's outcome is already recorded, so the call is
    // refused rather than issued.
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
      runAgent(forTenant(appDb, TENANT_A), backend, spec, {
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
    expect(await isRunTainted(forTenant(appDb, TENANT_A), 'bound-tool')).toBe(false);
  });

  it('a dispatch ALREADY IN FLIGHT when the bound fires is NOT stopped: the handler runs, its journal step is refused', async () => {
    setBound('120');
    const backend = new InFlightDispatchBackend();
    open.push(backend);
    // The handler is held for 600ms — five times the bound — so the dispatch is provably still inside
    // the dispatcher when the bound fires. run-core then waits up to the kill grace plus the settle
    // margin for the call it stopped; the backend never settles, so the handler finishes meanwhile.
    await expect(
      runAgent(forTenant(appDb, TENANT_A), backend, spec, {
        runId: 'bound-in-flight',
        tools: [nonIdempotentTool(600)],
      }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    // The run-core gate covers a dispatch that ARRIVES once the flag is set. This one was already
    // past it, so nothing refuses it: the side effect fires although the run was given up on.
    const dispatched = backend.dispatched;
    expect(dispatched).toBeDefined();
    // What the dispatch returns to the abandoned call is the journal seam's refusal, NOT the neutral
    // `tool_error` a dispatch arriving after the flag gets: recordToolStep runs before emitResult.
    await expect(dispatched).rejects.toBeInstanceOf(RunAbandonedError);
    expect(sideEffectFires).toBe(1);
    // The taint marker was committed BEFORE the handler (the dispatcher's fail-closed ordering), so it
    // is on record even though the run had been given up on. The step is not: the journal refused it,
    // so an effect that really happened is unjournaled.
    expect(await isRunTainted(forTenant(appDb, TENANT_A), 'bound-in-flight')).toBe(true);
    expect(await countJournalSteps('bound-in-flight')).toBe(0);
  });

  it('DURABLE shape, header PRE-WRITTEN by the enqueue: the bound leaves it terminal `error`', async () => {
    setBound('120');
    const backend = new SilentBackend();
    open.push(backend);
    // The API enqueue path writes the `enqueued` header BEFORE the job is handed to the worker.
    await insertEnqueuedRunHeader(forTenant(appDb, TENANT_A), {
      runId: 'bound-durable-header',
      backend: 'openai',
      agentName: spec.name,
      model: spec.model,
    });
    await expect(
      runAgent(forTenant(appDb, TENANT_A), backend, spec, {
        runId: 'bound-durable-header',
        taintDb: forTenant(appDb, TENANT_A),
      }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    // A bounded run reads back as ended with the neutral `timeout` class — never as `enqueued` or
    // `running` for ever.
    expect(await runHeaderStatus('bound-durable-header')).toBe('error');
    expect((await boundOutcome('bound-durable-header'))?.errorClass).toBe('timeout');
  });

  it("DURABLE shape, NO header pre-written: run-core's own header is moved terminal", async () => {
    setBound('120');
    const backend = new SilentBackend();
    open.push(backend);
    await expect(
      runAgent(forTenant(appDb, TENANT_A), backend, spec, {
        runId: 'bound-durable-no-header',
        taintDb: forTenant(appDb, TENANT_A),
      }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    expect(await runHeaderStatus('bound-durable-no-header')).toBe('error');
  });

  it('the caller learns of the timeout within the bound, the kill grace, the settle margin and the record budget, even when the terminal record cannot be written', async () => {
    setBound('120');
    const backend = new SilentBackend();
    open.push(backend);
    // The handle the terminal outcome is recorded through hands out no connection: its transaction
    // never starts, as on a pool every connection of which is held by other runs.
    const real = forTenant(appDb, TENANT_A);
    const stalled = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'transaction') return () => new Promise<never>(() => {});
        return Reflect.get(target, prop, receiver);
      },
    });
    const started = Date.now();
    await expect(
      runAgent(forTenant(appDb, TENANT_A), backend, spec, {
        runId: 'bound-record-stalled',
        taintDb: stalled,
      }),
    ).rejects.toBeInstanceOf(RunBoundTimeoutError);
    const elapsed = Date.now() - started;
    const stated = 120 + 50 + CALL_SETTLE_MARGIN_MS + RUN_END_RECORD_BUDGET_MS;
    // It waited for the record up to its budget, and not longer.
    expect(elapsed).toBeGreaterThanOrEqual(stated - 100);
    expect(elapsed).toBeLessThan(stated + 2_000);
    // The record never landed, so the run reads as running: what the operator docs state.
    expect(await runHeaderStatus('bound-record-stalled')).toBe('running');
  }, 30_000);

  it('an auth preflight that never answers is refused at the provider-call timeout, before anything is written', async () => {
    const backend = {
      id: 'openai' as const,
      async resolveAuth() {
        return 'api-key' as const;
      },
      preflightAuth: () => new Promise<never>(() => {}),
      async run(_spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
        return completedResult(ctx);
      },
    };
    const started = Date.now();
    const err = await runAgent(forTenant(appDb, TENANT_A), backend as unknown as Backend, spec, {
      runId: 'bound-preflight',
      policy: resolveExecutionPolicy({ RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: '150' }),
    }).catch((e: unknown) => e);
    expect(classifyUpstreamError(err).errorClass).toBe('timeout');
    expect((err as Error).message).toContain('auth preflight');
    expect(Date.now() - started).toBeLessThan(2_000);
    // Refused before the header transition: nothing about the run was written.
    expect(await runHeaderStatus('bound-preflight')).toBeUndefined();
    expect(await countJournalSteps('bound-preflight')).toBe(0);
  });

  it('UNSET: a run slower than any bound still completes (today’s unbounded behaviour)', async () => {
    setBound(undefined);
    const result = await runAgent(forTenant(appDb, TENANT_A), new SlowBackend(300), spec, {
      runId: 'bound-unset',
    });
    expect(result.status).toBe('completed');
  });

  it('MALFORMED: an unparsable value leaves the run unbounded', async () => {
    setBound('later');
    const result = await runAgent(forTenant(appDb, TENANT_A), new SlowBackend(300), spec, {
      runId: 'bound-malformed',
    });
    expect(result.status).toBe('completed');
  });

  it('a run that finishes INSIDE the bound is unaffected', async () => {
    setBound('5000');
    const result = await runAgent(forTenant(appDb, TENANT_A), new SlowBackend(20), spec, {
      runId: 'bound-inside',
    });
    expect(result.status).toBe('completed');
  });
});
