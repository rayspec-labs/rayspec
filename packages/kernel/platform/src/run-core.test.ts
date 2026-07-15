/**
 * run-core DB-backed tests. Validates the central reliability primitive that
 * had ZERO unit coverage originally: live run journals steps under the right tenant,
 * replay returns cached steps WITHOUT re-calling the model, and the replay header upsert
 * is idempotent (no duplicate conversation rows).
 *
 * Uses a FAKE in-memory Backend (no network) + a REAL Postgres-backed journal/db.
 */
import type { AgentSpec, Backend, NeutralTool, RunContext, RunResult } from '@rayspec/core';
import { schema } from '@rayspec/db';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeJournalSink, runAgent } from './run-core.js';
import { getRunObservability } from './run-observability.js';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const db = makeTestDb();

/**
 * A fake backend that journals exactly one `llm` step on a live run and, on replay,
 * returns the cached step's output WITHOUT producing a fresh one. It records how many
 * times its live path actually executed so tests can assert "model NOT re-called".
 */
class FakeBackend implements Backend {
  readonly id = 'openai' as const;
  liveCalls = 0;

  async resolveAuth() {
    return 'api-key' as const;
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const idemKey = `llm:${spec.name}`;
    if (ctx.replay) {
      const cached = await ctx.journal.lookup(idemKey);
      if (cached) {
        const co = cached.output as { finalText?: string } | null;
        return this.result(ctx, co?.finalText ?? '', 0);
      }
    }
    this.liveCalls += 1;
    const finalText = `answer for ${spec.input}`;
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: idemKey,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      costUsd: 0.0001,
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    return this.result(ctx, finalText, 1);
  }

  private result(ctx: RunContext, finalText: string, stepCount: number): RunResult {
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText,
      output: null,
      error: null,
      errorClass: null,
      // ConvTurn/ConvPart shape: 3 turns -> 3 parts -> 3 persisted part rows.
      conversation: [
        { role: 'system', index: 0, parts: [{ kind: 'text', text: 'sys' }] },
        { role: 'user', index: 1, parts: [{ kind: 'text', text: 'in' }] },
        { role: 'assistant', index: 2, parts: [{ kind: 'text', text: finalText }] },
      ],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      costUsd: 0.0001,
      stepCount,
    };
  }
}

/**
 * A fake 'pi' backend for the C1 capability-gate test. Its run() asserts it is NEVER reached when
 * the spec is rejected up front (it bumps a counter the test checks stays 0).
 */
class FakePiBackend implements Backend {
  readonly id = 'pi' as const;
  runCalls = 0;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(_spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.runCalls += 1;
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText: '',
      output: null,
      error: null,
      errorClass: null,
      conversation: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      stepCount: 0,
    };
  }
}

const spec: AgentSpec = {
  name: 'extract',
  instructions: 'extract fields',
  model: 'gpt-4.1-mini',
  input: 'a transcript',
  tools: [],
  maxTurns: 8,
};

const specWithOutput: AgentSpec = {
  ...spec,
  outputSchema: { name: 'Out', schema: { type: 'object' } },
};

beforeAll(async () => {
  await resetRunSchema(db);
});

beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A);
});

afterAll(async () => {
  await db.$client.end();
});

describe('run-core live run', () => {
  it('journals a step under the correct tenant_id and persists a run header + conversation', async () => {
    const backend = new FakeBackend();
    const res = await runAgent(forTenant(db, TENANT_A), backend, spec, {});

    expect(res.status).toBe('completed');
    expect(backend.liveCalls).toBe(1);

    const steps = await db
      .select()
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, res.runId));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.tenantId).toBe(TENANT_A);

    const header = await db.select().from(schema.runs).where(eq(schema.runs.runId, res.runId));
    expect(header).toHaveLength(1);
    expect(header[0]?.tenantId).toBe(TENANT_A);

    const conv = await db
      .select()
      .from(schema.conversationItems)
      .where(eq(schema.conversationItems.runId, res.runId))
      .orderBy(asc(schema.conversationItems.seq));
    expect(conv).toHaveLength(3);

    // Assert the PERSISTED ConvPart row SHAPE, not just the count — a wrong-shape persist must
    // fail. The FakeBackend returns 3 turns (system/user/assistant), each one text part.
    expect(
      conv.map((r) => ({
        seq: String(r.seq),
        turnIndex: String(r.turnIndex),
        role: r.role,
        kind: r.kind,
        toolCallId: r.toolCallId,
        payload: r.payload,
      })),
    ).toEqual([
      {
        seq: '0',
        turnIndex: '0',
        role: 'system',
        kind: 'text',
        toolCallId: null,
        payload: { kind: 'text', text: 'sys' },
      },
      {
        seq: '1',
        turnIndex: '1',
        role: 'user',
        kind: 'text',
        toolCallId: null,
        payload: { kind: 'text', text: 'in' },
      },
      {
        seq: '2',
        turnIndex: '2',
        role: 'assistant',
        kind: 'text',
        toolCallId: null,
        payload: { kind: 'text', text: `answer for ${spec.input}` },
      },
    ]);
  });
});

describe('run-core capability gate (C1, fail-closed)', () => {
  it('rejects an outputSchema spec on pi when requireNativeStructuredOutput=true BEFORE backend.run', async () => {
    const backend = new FakePiBackend();
    await expect(
      runAgent(forTenant(db, TENANT_A), backend, specWithOutput, {
        requireNativeStructuredOutput: true,
      }),
    ).rejects.toThrow(/fail-closed/);
    // The model was NEVER run — the gate rejected up front (no journal/header side effects).
    expect(backend.runCalls).toBe(0);
    const steps = await db
      .select()
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.backend, 'pi'));
    expect(steps).toHaveLength(0);
  });

  it('ACCEPTS the same outputSchema spec on openai (native structured output)', async () => {
    const backend = new FakeBackend();
    const res = await runAgent(forTenant(db, TENANT_A), backend, specWithOutput, {
      requireNativeStructuredOutput: true,
    });
    expect(res.status).toBe('completed');
    expect(backend.liveCalls).toBe(1);
  });

  it('ACCEPTS an outputSchema spec on pi when native is NOT demanded (pi emulates)', async () => {
    const backend = new FakePiBackend();
    const res = await runAgent(forTenant(db, TENANT_A), backend, specWithOutput, {});
    expect(res.status).toBe('completed');
    expect(backend.runCalls).toBe(1);
  });
});

/**
 * A fake backend that EMITS a NeutralEvent stream through ctx.onEvent (run_started → text_delta →
 * tool_called → tool_result → run_completed) so the run_events persist (via the pipeline)
 * can be asserted against a real Postgres run_events table.
 */
class EmittingBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const finalText = `answer for ${spec.input}`;
    // The adapter emits seq-less; run-core stamps the single per-run seq + persists to run_events.
    await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);
    await ctx.onEvent?.({ type: 'text_delta', runId: ctx.runId, text: 'an' } as never);
    await ctx.onEvent?.({
      type: 'tool_called',
      runId: ctx.runId,
      toolCallId: 'tc-1',
      name: 'lookup',
      args: { q: 1 },
    } as never);
    await ctx.onEvent?.({
      type: 'tool_result',
      runId: ctx.runId,
      toolCallId: 'tc-1',
      name: 'lookup',
      // C2: match what the REAL dispatchTool emits — the tool_result `result` is the UNWRAPPED handler
      // output (dispatch.ts emitResult emits `result: result.data`), NOT the { kind:'tool_data', ... }
      // opaque wrapper. (The wrapper is what dispatchTool RETURNS to the adapter + journals; the EVENT
      // carries the bare data.) The previous test asserted the wrapper shape the event never has.
      result: 42,
    } as never);
    await ctx.onEvent?.({
      type: 'run_completed',
      runId: ctx.runId,
      status: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
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
      output: null,
      error: null,
      errorClass: null,
      conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: finalText }] }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

describe('run-core run_events persistence', () => {
  it('persists EVERY emitted NeutralEvent to run_events in seq order under the right tenant', async () => {
    const backend = new EmittingBackend();
    const res = await runAgent(forTenant(db, TENANT_A), backend, spec, {});
    expect(res.status).toBe('completed');

    const events = await db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, res.runId))
      .orderBy(asc(schema.runEvents.seq));

    // All five frames are durable, in contiguous seq order, under tenant A.
    expect(events.map((e) => ({ seq: Number(e.seq), type: e.type }))).toEqual([
      { seq: 0, type: 'run_started' },
      { seq: 1, type: 'text_delta' },
      { seq: 2, type: 'tool_called' },
      { seq: 3, type: 'tool_result' },
      { seq: 4, type: 'run_completed' },
    ]);
    expect(events.every((e) => e.tenantId === TENANT_A)).toBe(true);

    // The persisted `data` is the full neutral NeutralEvent (the SSE replay source).
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect((toolResult?.data as { toolCallId?: string })?.toolCallId).toBe('tc-1');
    // C2: the tool_result EVENT's `result` is the UNWRAPPED dispatched data — exactly what the REAL
    // dispatchTool emits (dispatch.ts emitResult: `result: result.data`). The previous test asserted
    // `result.kind === 'tool_data'` (the opaque WRAPPER), a shape the event never carries — a blind
    // assertion that did not match production. Assert the real bare data AND that it is NOT the wrapper.
    expect((toolResult?.data as { result?: unknown })?.result).toBe(42);
    expect((toolResult?.data as { result?: { kind?: string } })?.result?.kind).toBeUndefined();
  });

  it('persists run_events even with NO live sink (a real durable read path for GET /runs/{id}/events)', async () => {
    const backend = new EmittingBackend();
    // No onEvent supplied — the pipeline still persists every frame durably.
    const res = await runAgent(forTenant(db, TENANT_A), backend, spec, {});
    const events = await db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, res.runId));
    expect(events.length).toBe(5);
  });
});

/**
 * A fake backend that RECORDS the `spec.tools` it is handed by run-core. A REAL adapter builds its
 * SDK tool list from `spec.tools` (e.g. OpenAI: `spec.tools.map(...)`) — so this captures exactly
 * what a real model would be OFFERED. (The other fakes dispatch via `ctx.dispatchTool` directly and
 * thus never noticed when `spec.tools` arrived empty — the gap this test closes.)
 */
class SpecToolsRecordingBackend implements Backend {
  readonly id = 'openai' as const;
  recordedToolNames: string[] | undefined;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    // Capture the model-facing tool LIST run-core handed us (NOT ctx.dispatchTool, which a real
    // adapter ignores when building its SDK tool list).
    this.recordedToolNames = spec.tools.map((t) => t.name);
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}`,
      inputHash: `hash:${spec.input}`,
      output: { finalText: 'ok' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText: 'ok',
      output: null,
      error: null,
      errorClass: null,
      conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'ok' }] }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

describe('run-core effective-spec tool wiring (fail-the-fix)', () => {
  it('passes the run’s per-run tools (opts.tools) into backend.run as POPULATED spec.tools', async () => {
    // Mirror a DECLARED agent: the base AgentSpec carries spec.tools: [] (its per-run tools live only
    // in opts.tools), exactly as build-agent-registry's baseAgentSpec does. A real model must STILL be
    // offered the tool — so the effective spec run-core hands the backend MUST carry it.
    const declaredAgentSpec: AgentSpec = { ...spec, tools: [] };
    const lookupTool: NeutralTool = {
      spec: {
        name: 'lookup',
        description: 'look something up',
        parameters: { type: 'object', properties: {} },
      },
      handler: () => ({ found: true }),
      timeoutMs: 1000,
      idempotent: true,
    };

    const backend = new SpecToolsRecordingBackend();
    const res = await runAgent(forTenant(db, TENANT_A), backend, declaredAgentSpec, {
      tools: [lookupTool],
    });

    expect(res.status).toBe('completed');
    // The model was OFFERED the tool by name. With the bug (backend.run(spec, ctx)), this is [] and
    // the assertion FAILS — the fail-the-fix guard the fake-backend tests lacked.
    expect(backend.recordedToolNames).toEqual(['lookup']);
  });
});

describe('run-core replay', () => {
  it('returns the cached step WITHOUT re-calling the model', async () => {
    const backend = new FakeBackend();
    const tdb = forTenant(db, TENANT_A);
    const live = await runAgent(tdb, backend, spec, {});
    expect(backend.liveCalls).toBe(1);

    const replay = await runAgent(tdb, backend, spec, { replayRunId: live.runId });

    // The model was NOT re-called on replay.
    expect(backend.liveCalls).toBe(1);
    expect(replay.finalText).toBe(live.finalText);
    expect(replay.stepCount).toBe(0);
  });

  it('replay header upsert is idempotent — no duplicate run rows or conversation rows', async () => {
    const backend = new FakeBackend();
    const tdb = forTenant(db, TENANT_A);
    const live = await runAgent(tdb, backend, spec, {});

    await runAgent(tdb, backend, spec, { replayRunId: live.runId });
    await runAgent(tdb, backend, spec, { replayRunId: live.runId });

    const headers = await db.select().from(schema.runs).where(eq(schema.runs.runId, live.runId));
    expect(headers).toHaveLength(1);

    const conv = await db
      .select()
      .from(schema.conversationItems)
      .where(eq(schema.conversationItems.runId, live.runId));
    // Conversation persisted only once (on the live run); replays add nothing.
    expect(conv).toHaveLength(3);

    const steps = await db
      .select()
      .from(schema.journalSteps)
      .where(
        and(eq(schema.journalSteps.runId, live.runId), eq(schema.journalSteps.tenantId, TENANT_A)),
      );
    expect(steps).toHaveLength(1);
  });
});

/**
 * A backend whose first (live) attempt at a step fails transiently — it journals a `status='error'`
 * step (a 429/5xx class) and returns an error — but whose re-run of that SAME step succeeds. On the
 * re-run the journal `lookup()` finds no cached OK row (the error is filtered out), so the backend
 * re-executes and re-records under the SAME idempotency key — the exact path that a plain insert
 * would collide on (the failed row still occupies the unique slot). Used to prove the error step is
 * HEALED (replaced by the success) rather than permanently bricking the re-run.
 */
class TransientThenHealBackend implements Backend {
  readonly id = 'openai' as const;
  liveExecutions = 0;

  async resolveAuth() {
    return 'api-key' as const;
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const idemKey = `llm:${spec.name}`;
    if (ctx.replay) {
      const cached = await ctx.journal.lookup(idemKey);
      if (cached) {
        // A previously-succeeded step: return it verbatim WITHOUT re-executing (ok-replay).
        const co = cached.output as { finalText?: string } | null;
        return this.result(ctx, co?.finalText ?? '', 'completed', 0);
      }
      // No OK row (the earlier attempt errored) → re-execute and record the success (the heal).
      this.liveExecutions += 1;
      await ctx.journal.record({
        type: 'llm',
        idempotencyKey: idemKey,
        inputHash: `hash:${spec.input}`,
        output: { finalText: 'healed answer' },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        costUsd: 0,
        latencyMs: 1,
        status: 'ok',
        authMode: 'api-key',
      });
      return this.result(ctx, 'healed answer', 'completed', 1);
    }
    // First, LIVE attempt: the step fails transiently (a 429) → journal an error row + return an error.
    this.liveExecutions += 1;
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: idemKey,
      inputHash: `hash:${spec.input}`,
      output: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      latencyMs: 1,
      status: 'error',
      authMode: 'api-key',
    });
    return this.result(ctx, '', 'error', 1);
  }

  private result(
    ctx: RunContext,
    finalText: string,
    status: 'completed' | 'error',
    stepCount: number,
  ): RunResult {
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status,
      finalText,
      output: null,
      error: status === 'error' ? 'transient upstream error' : null,
      errorClass: null,
      conversation:
        status === 'error'
          ? []
          : [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: finalText }] }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      stepCount,
    };
  }
}

describe('run-core error-step healing on re-run', () => {
  const cost = { model: 'gpt-4.1-mini', at: '2026-01-01T00:00:00.000Z' };
  const RUN = 'heal-run';
  const KEY = 'llm:heal';

  it('heals a failed step end-to-end: a re-run of a step that errored persists the success with NO conflict', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = new TransientThenHealBackend();

    // First live run: the step fails transiently → one error row in the journal.
    const live = await runAgent(tdb, backend, spec, {});
    expect(live.status).toBe('error');
    const afterLive = await db
      .select()
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, live.runId));
    expect(afterLive).toHaveLength(1);
    expect(afterLive[0]?.status).toBe('error');

    // Re-run the SAME run via the replay path. WITHOUT the conflict handling the re-record collides
    // on the unique index (23505) → runAgent rejects → the paid success is discarded. WITH it, the
    // error row is REPLACED by the success and the run completes.
    const replay = await runAgent(tdb, backend, spec, { replayRunId: live.runId });
    expect(replay.status).toBe('completed');
    expect(replay.finalText).toBe('healed answer');

    const afterReplay = await db
      .select()
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, live.runId));
    // Exactly ONE row for the step (the error was healed, not duplicated), now status='ok'.
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0]?.status).toBe('ok');
    expect(afterReplay[0]?.output).toEqual({ finalText: 'healed answer' });
  });

  it('heals a failed step at the sink: re-recording an error step under the same key REPLACES it', async () => {
    const sink = makeJournalSink(forTenant(db, TENANT_A), RUN, 'openai', false, cost);
    // First attempt fails transiently → an error row occupies the (tenant,run,key) unique slot.
    await sink.record({
      type: 'llm',
      idempotencyKey: KEY,
      inputHash: 'h',
      output: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      latencyMs: 1,
      status: 'error',
      authMode: 'api-key',
    });
    // The re-run succeeds under the SAME key. Without the fix this throws 23505; with it the error
    // row is replaced by the success.
    await sink.record({
      type: 'llm',
      idempotencyKey: KEY,
      inputHash: 'h',
      output: { finalText: 'healed' },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      costUsd: 0,
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });

    const rows = await db
      .select()
      .from(schema.journalSteps)
      .where(and(eq(schema.journalSteps.runId, RUN), eq(schema.journalSteps.idempotencyKey, KEY)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ok');
    expect(rows[0]?.output).toEqual({ finalText: 'healed' });
  });

  it('never overwrites an ok row: a later same-key record leaves the completed output authoritative', async () => {
    const sink = makeJournalSink(forTenant(db, TENANT_A), RUN, 'openai', false, cost);
    await sink.record({
      type: 'llm',
      idempotencyKey: KEY,
      inputHash: 'h',
      output: { finalText: 'ORIGINAL' },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      costUsd: 0,
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    // A later attempt under the SAME key must NOT clobber the succeeded row — only error rows are
    // replaced (the setWhere guard). A naive unconditional upsert would overwrite ORIGINAL with STALE
    // (this assertion fails it); the missing conflict handling would 23505 (also a failure). Only the
    // conditional heal leaves the completed output authoritative.
    await sink.record({
      type: 'llm',
      idempotencyKey: KEY,
      inputHash: 'h',
      output: { finalText: 'STALE' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });

    const rows = await db
      .select()
      .from(schema.journalSteps)
      .where(and(eq(schema.journalSteps.runId, RUN), eq(schema.journalSteps.idempotencyKey, KEY)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ok');
    expect(rows[0]?.output).toEqual({ finalText: 'ORIGINAL' });
  });

  it('double error under the same key: the later attempt wins cleanly, no conflict', async () => {
    const sink = makeJournalSink(forTenant(db, TENANT_A), RUN, 'openai', false, cost);
    await sink.record({
      type: 'llm',
      idempotencyKey: KEY,
      inputHash: 'h',
      output: { attempt: 1 },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      latencyMs: 1,
      status: 'error',
      authMode: 'api-key',
    });
    await sink.record({
      type: 'llm',
      idempotencyKey: KEY,
      inputHash: 'h',
      output: { attempt: 2 },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      latencyMs: 1,
      status: 'error',
      authMode: 'api-key',
    });

    const rows = await db
      .select()
      .from(schema.journalSteps)
      .where(and(eq(schema.journalSteps.runId, RUN), eq(schema.journalSteps.idempotencyKey, KEY)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.output).toEqual({ attempt: 2 });
  });

  it('an ok step is left untouched by a re-run: the same row (stepId + output) survives replay', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = new FakeBackend();
    const live = await runAgent(tdb, backend, spec, {});
    expect(backend.liveCalls).toBe(1);

    const before = await db
      .select()
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, live.runId));
    expect(before).toHaveLength(1);
    expect(before[0]?.status).toBe('ok');

    await runAgent(tdb, backend, spec, { replayRunId: live.runId });
    // The model was NOT re-called on replay (the ok-replay short-circuit — no re-record).
    expect(backend.liveCalls).toBe(1);

    const after = await db
      .select()
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, live.runId));
    expect(after).toHaveLength(1);
    // Same row identity (never replaced) + byte-identical output — a completed step is authoritative.
    expect(after[0]?.stepId).toBe(before[0]?.stepId);
    expect(after[0]?.status).toBe('ok');
    expect(after[0]?.output).toEqual(before[0]?.output);
  });
});

/**
 * A backend that models the durable executor's recovery RE-DISPATCH: the first dispatch of a runId
 * fails transiently (journals a `status='error'` step, returns an error run with no conversation), and
 * a SECOND dispatch of the SAME runId (replay=false — exactly how the executor re-runs a lost-checkpoint
 * job) succeeds, re-recording the step under the same key (healing the journal error→ok) and returning a
 * COMPLETED run. Used to prove the `runs` HEADER is reconciled to the healed terminal outcome, not left
 * stale at 'error'.
 */
class RedispatchHealBackend implements Backend {
  readonly id = 'openai' as const;
  attempts = 0;

  async resolveAuth() {
    return 'api-key' as const;
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.attempts += 1;
    const idemKey = `llm:${spec.name}`;
    if (this.attempts === 1) {
      // First dispatch: a transient (e.g. 429) failure — one error step, an error run, no transcript.
      await ctx.journal.record({
        type: 'llm',
        idempotencyKey: idemKey,
        inputHash: `hash:${spec.input}`,
        output: null,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costUsd: 0,
        latencyMs: 1,
        status: 'error',
        authMode: 'api-key',
      });
      return {
        runId: ctx.runId,
        backend: this.id,
        authMode: 'api-key',
        status: 'error',
        finalText: '',
        output: null,
        error: 'transient upstream error',
        errorClass: null,
        conversation: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costUsd: 0,
        stepCount: 1,
      };
    }
    // Recovery re-dispatch (same runId, replay=false): the transient error cleared — re-execute the
    // step (healing the journal error row → ok) and return a COMPLETED run.
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: idemKey,
      inputHash: `hash:${spec.input}`,
      output: { finalText: 'healed answer' },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      costUsd: 0,
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText: 'healed answer',
      output: null,
      error: null,
      errorClass: null,
      conversation: [
        { role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'healed answer' }] },
      ],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

/**
 * A backend that succeeds on its first dispatch then, on a SPURIOUS re-dispatch of the SAME (already
 * completed) runId, hits a transient error. Proves a completed header is TERMINAL: the re-run's error
 * must NEVER downgrade it back to 'error' (the header reconcile's `setWhere` forbids that).
 */
class CompleteThenSpuriousErrorBackend implements Backend {
  readonly id = 'openai' as const;
  attempts = 0;

  async resolveAuth() {
    return 'api-key' as const;
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.attempts += 1;
    const idemKey = `llm:${spec.name}`;
    if (this.attempts === 1) {
      await ctx.journal.record({
        type: 'llm',
        idempotencyKey: idemKey,
        inputHash: `hash:${spec.input}`,
        output: { finalText: 'good answer' },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        costUsd: 0,
        latencyMs: 1,
        status: 'ok',
        authMode: 'api-key',
      });
      return {
        runId: ctx.runId,
        backend: this.id,
        authMode: 'api-key',
        status: 'completed',
        finalText: 'good answer',
        output: null,
        error: null,
        errorClass: null,
        conversation: [
          { role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'good answer' }] },
        ],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        costUsd: 0,
        stepCount: 1,
      };
    }
    // Spurious re-dispatch of an already-completed run: a transient error. The journal step is already
    // 'ok' (record()'s setWhere leaves it untouched); the backend returns an error run.
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: idemKey,
      inputHash: `hash:${spec.input}`,
      output: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      latencyMs: 1,
      status: 'error',
      authMode: 'api-key',
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'error',
      finalText: '',
      output: null,
      error: 'transient upstream error',
      errorClass: null,
      conversation: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

describe('run-core run-header reconcile on heal', () => {
  it('reconciles the run header error→completed when a re-dispatch heals the run', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = new RedispatchHealBackend();
    const runId = 'heal-header-run';

    // First dispatch fails transiently → the header is persisted at status='error', finalText=''.
    const first = await runAgent(tdb, backend, spec, { runId });
    expect(first.status).toBe('error');
    const errHeader = await db.select().from(schema.runs).where(eq(schema.runs.runId, runId));
    expect(errHeader).toHaveLength(1);
    expect(errHeader[0]?.status).toBe('error');
    expect(errHeader[0]?.finalText).toBe('');

    // Recovery re-dispatch (same runId, replay=false — the durable executor's recovery path) heals it.
    const second = await runAgent(tdb, backend, spec, { runId });
    expect(second.status).toBe('completed');

    // FAIL-THE-FIX: with the header persisted via .onConflictDoNothing() this row STAYS 'error'/'' for
    // a run that actually completed; the conditional upsert reconciles it to the healed outcome.
    const healed = await db.select().from(schema.runs).where(eq(schema.runs.runId, runId));
    expect(healed).toHaveLength(1);
    expect(healed[0]?.status).toBe('completed');
    expect(healed[0]?.finalText).toBe('healed answer');
  });

  it('a healed run reads as completed via observability and satisfies the double-bill short-circuit', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = new RedispatchHealBackend();
    const runId = 'heal-observe-run';

    await runAgent(tdb, backend, spec, { runId }); // errors
    const res = await runAgent(tdb, backend, spec, { runId }); // heals
    expect(res.status).toBe('completed');

    // The observability read reports the run as completed (it derives status from the header). With the
    // stale header it would report 'error' — a completed run mislabeled as errored.
    const obs = await getRunObservability(tdb, runId);
    expect(obs.exists).toBe(true);
    expect(obs.status).toBe('completed');
    expect(obs.quarantined).toBe(false);

    // The durable executor's double-bill short-circuit keys STRICTLY on runs.status==='completed'
    // (RUN_STATUS_SUCCEEDED). A stale 'error' header would make it return false → the untainted run is
    // re-dispatched and re-billed. Assert the exact column value that guard reads.
    const header = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.runId, runId));
    expect(header[0]?.status).toBe('completed');
  });

  it('never downgrades an already-completed header: a spurious error re-run leaves it completed', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = new CompleteThenSpuriousErrorBackend();
    const runId = 'no-downgrade-run';

    const first = await runAgent(tdb, backend, spec, { runId });
    expect(first.status).toBe('completed');

    const second = await runAgent(tdb, backend, spec, { runId });
    expect(second.status).toBe('error');

    // The header MUST stay 'completed' — the reconcile's setWhere (only a NON-completed header is
    // updated) forbids a completed→error downgrade. A naive unconditional upsert would flip it to
    // 'error' (this is the guard against the fix's own regression).
    const header = await db.select().from(schema.runs).where(eq(schema.runs.runId, runId));
    expect(header).toHaveLength(1);
    expect(header[0]?.status).toBe('completed');
    expect(header[0]?.finalText).toBe('good answer');

    // The journal step stayed 'ok' too (the step-row heal only supersedes an error row, never an ok one).
    const steps = await db
      .select()
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.runId, runId));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe('ok');
  });
});
