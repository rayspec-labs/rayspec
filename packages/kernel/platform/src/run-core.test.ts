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
import { runAgent } from './run-core.js';
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
