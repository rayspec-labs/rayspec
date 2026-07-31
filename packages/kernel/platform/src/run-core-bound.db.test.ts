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
 * DOES guarantee once it has fired is asserted below: no further event from the abandoned call is
 * persisted, and the abandoned call's own settlement raises nothing.
 *
 * Both product callers reach the model through this one `runAgent`, and they differ only in the
 * handle they pass: the sync HTTP path calls it OUTSIDE any transaction; the durable worker calls it
 * INSIDE `forTenant(db, tenantId).transaction(...)` with a separate autonomous-commit `taintDb`. Both
 * invocation shapes are exercised here.
 */
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';
import { classifyUpstreamError } from '@rayspec/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunBoundTimeoutError } from './agent-bounds.js';
import { runAgent } from './run-core.js';
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

function setBound(value: string | undefined): void {
  if (value === undefined) delete process.env.RAYSPEC_AGENT_RUN_MAX_MS;
  else process.env.RAYSPEC_AGENT_RUN_MAX_MS = value;
}

const savedBound = process.env.RAYSPEC_AGENT_RUN_MAX_MS;
const open: SilentBackend[] = [];

beforeAll(async () => {
  await resetRunSchema(db);
});

beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A);
  setBound(undefined);
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
    // Run the REAL neutral classifier over it: a bounded run must surface as `timeout`, the class
    // the callers already map (504 on the sync path), not as a generic internal error.
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
