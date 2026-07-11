/**
 * OpenAI adapter integration tests — deterministic, NO network, NO DB.
 *
 * These prove the wiring against the REAL adapter code, using a fake in-memory JournalSink
 * + the REAL central `makeDispatchTool` (from @rayspec/platform) wired onto the RunContext exactly
 * as run-core does. The SDK `run()` is mocked (real Agent/tool/setDefaultOpenAIKey kept) to (a)
 * invoke the agent tools' execute closures — simulating the SDK loop calling a tool — and (b)
 * return a RunResult shaped from the REAL captured fixture, so the adapter's genuine journal /
 * derive / replay code runs deterministically.
 *
 * Proven here (each assertion checks the REAL thing):
 *   - the tool path goes through ctx.dispatchTool (handler invoked ONLY via the dispatcher; the
 *     adapter holds no handler); the result comes back opaque-wrapped; EXACTLY the dispatcher's ONE
 *     `tool` journal step exists; the transcript has correlated tool_call/tool_result parts;
 *   - stepCount reflects REAL steps (2 llm + 1 tool = 3, not a hard-coded 1) with real per-step usage;
 *   - replay reconstructs a fully-journaled run from the journal + the rehydrate hook WITHOUT
 *     calling the model (the SDK `run` is asserted NOT invoked on replay).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AuthMode,
  ConvTurn,
  JournalSink,
  NeutralTool,
  RunContext,
  StepReport,
} from '@rayspec/core';
import { makeDispatchTool } from '@rayspec/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mock @openai/agents: real Agent/tool/setDefaultOpenAIKey, controllable run() -------------
const runSpy = vi.fn();
vi.mock('@openai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return { ...actual, run: (...args: unknown[]) => runSpy(...args) };
});

const { OpenAIAdapter } = await import('./index.js');

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'openai-tool-run.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  instructions: string;
  input: string;
  finalOutput: string;
  history: unknown[];
  rawResponses: unknown[];
  stateUsage: Record<string, number>;
};

/** Fake in-memory JournalSink: records steps + serves cached OK steps on lookup (replay). */
class FakeJournal implements JournalSink {
  records: (StepReport & { authMode: AuthMode })[] = [];
  async lookup(idempotencyKey: string): Promise<{ output: unknown } | null> {
    const hit = this.records.find((r) => r.idempotencyKey === idempotencyKey && r.status === 'ok');
    return hit ? { output: hit.output } : null;
  }
  async record(step: StepReport & { authMode: AuthMode }): Promise<string> {
    this.records.push(step);
    return `step-${this.records.length}`;
  }
}

/**
 * A fake SDK run() impl: invoke each agent tool's execute closure with the captured tool-call args
 * (simulating the SDK loop calling the tool — the dispatcher routing runs), then return a RunResult
 * shaped from the REAL captured fixture.
 */
function fakeRunImpl() {
  return async (agent: { tools?: unknown[] }) => {
    for (const t of agent.tools ?? []) {
      const invoke = (t as { invoke?: (...a: unknown[]) => Promise<string> }).invoke;
      if (typeof invoke === 'function') {
        await invoke({ context: {} }, JSON.stringify({ city: 'Berlin' }), {
          toolCall: { callId: 'call_OAEM0aPEoTnxkd11KGkfc3BH' },
        });
      }
    }
    return {
      finalOutput: fixture.finalOutput,
      history: fixture.history,
      rawResponses: fixture.rawResponses,
      state: { usage: fixture.stateUsage },
    };
  };
}

const recordingTool = (calls: unknown[]): NeutralTool => ({
  spec: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
  handler: (args: unknown) => {
    calls.push(args);
    return { city: (args as { city: string }).city, tempC: 18, condition: 'cloudy' };
  },
  timeoutMs: 1000,
  idempotent: true,
});

const baseSpec = {
  name: 'weather-agent',
  instructions: fixture.instructions,
  model: 'gpt-4.1-mini',
  input: fixture.input,
  maxTurns: 8,
};

/** Build a RunContext exactly as run-core does (real dispatchTool + authMode + rehydrate). */
function makeCtx(
  journal: FakeJournal,
  tools: NeutralTool[],
  opts: { replay?: boolean; rehydrate?: () => Promise<ConvTurn[]> } = {},
): RunContext {
  const runId = 'run-1';
  const authMode: AuthMode = 'api-key';
  const dispatchTool =
    tools.length > 0
      ? makeDispatchTool({
          runId,
          tenantId: 't1',
          journal,
          tools,
          replay: Boolean(opts.replay),
          authMode,
        })
      : undefined;
  return {
    runId,
    tenantId: 't1',
    journal,
    replay: Boolean(opts.replay),
    authMode,
    tools,
    dispatchTool,
    rehydrate: opts.rehydrate,
  };
}

beforeEach(() => {
  runSpy.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAI adapter: tool path goes through ctx.dispatchTool (§10.A chokepoint)', () => {
  it('routes via the dispatcher (handler invoked once), opaque-wraps, journals ONE tool step + correlated parts', async () => {
    const calls: unknown[] = [];
    const tool = recordingTool(calls);
    const journal = new FakeJournal();
    runSpy.mockImplementation(fakeRunImpl());

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const res = await adapter.run({ ...baseSpec, tools: [tool.spec] }, makeCtx(journal, [tool]));

    expect(res.status).toBe('completed');
    // The handler ran EXACTLY once, ONLY through the dispatcher (the adapter holds no handler).
    expect(calls).toEqual([{ city: 'Berlin' }]);

    // EXACTLY ONE `tool` journal step (recorded by dispatchTool, not the adapter).
    const toolSteps = journal.records.filter((s) => s.type === 'tool');
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0]?.status).toBe('ok');
    // The journaled tool output is the OPAQUE wrapper, never the raw handler output (the untrusted-content boundary).
    expect((toolSteps[0]?.output as { kind?: string })?.kind).toBe('tool_data');
    // Attributed to the run's REAL authMode by construction.
    expect(toolSteps[0]?.authMode).toBe('api-key');

    // Correlated tool_call / tool_result parts (same toolCallId).
    const callPart = res.conversation.flatMap((t) => t.parts).find((p) => p.kind === 'tool_call');
    const resultPart = res.conversation
      .flatMap((t) => t.parts)
      .find((p) => p.kind === 'tool_result');
    expect(callPart?.kind).toBe('tool_call');
    expect(resultPart?.kind).toBe('tool_result');
    if (callPart?.kind === 'tool_call' && resultPart?.kind === 'tool_result') {
      expect(resultPart.toolCallId).toBe(callPart.toolCallId);
    }
  });
});

describe('OpenAI adapter: real per-step journal (kill stepCount=1)', () => {
  it('journals ONE llm step per real model call + the tool step; stepCount = real total (>1)', async () => {
    const calls: unknown[] = [];
    const tool = recordingTool(calls);
    const journal = new FakeJournal();
    runSpy.mockImplementation(fakeRunImpl());

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const res = await adapter.run({ ...baseSpec, tools: [tool.spec] }, makeCtx(journal, [tool]));

    const llm = journal.records.filter((s) => s.type === 'llm');
    const tools = journal.records.filter((s) => s.type === 'tool');
    // The captured run made 2 model calls -> 2 llm steps (NOT a hard-coded 1).
    expect(llm).toHaveLength(2);
    expect(tools).toHaveLength(1);

    // Per-step usage is the REAL per-response usage (first response: 72 in / 15 out).
    const first = llm.find((s) => s.idempotencyKey.endsWith(':0'));
    expect(first?.usage.inputTokens).toBe(72);
    expect(first?.usage.outputTokens).toBe(15);
    const second = llm.find((s) => s.idempotencyKey.endsWith(':1'));
    expect(second?.usage.inputTokens).toBe(110);
    expect(second?.usage.outputTokens).toBe(16);

    // stepCount = 2 llm + 1 tool = 3 (the real total, not 1).
    expect(res.stepCount).toBe(3);
    // Aggregate usage = the real RunState aggregate (182 / 31 / 213).
    expect(res.usage.inputTokens).toBe(182);
    expect(res.usage.outputTokens).toBe(31);
    expect(res.usage.totalTokens).toBe(213);
  });
});

describe('OpenAI adapter: replay reconstructs from journal + store WITHOUT a model call', () => {
  it('does NOT invoke the SDK run() on replay and reproduces the final answer + transcript', async () => {
    const calls: unknown[] = [];
    const tool = recordingTool(calls);
    const journal = new FakeJournal();
    runSpy.mockImplementation(fakeRunImpl());

    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });

    // Live run: journals the llm + tool steps; capture the transcript for the rehydrate hook.
    const live = await adapter.run({ ...baseSpec, tools: [tool.spec] }, makeCtx(journal, [tool]));
    expect(runSpy).toHaveBeenCalledTimes(1);
    const liveCalls = calls.length;
    // Live transcript's first turn is the TRUSTED system turn (role='system').
    expect(live.conversation[0]?.role).toBe('system');

    // Replay: rehydrate returns the stored transcript as the REAL untrusted-content read-path would — the
    // stored 'system' row is COERCED to 'user' (rehydrate.ts coerceRole). C3 must re-attach the
    // trusted system turn so replay matches live (the dedicated DB-backed C3 test exercises the
    // genuine rehydrateConversation; here we simulate its coercion to keep the unit test offline).
    const coerced = live.conversation.map((t, i) =>
      t.role === 'system' ? { ...t, role: 'user' as const, index: i } : t,
    );
    const replayCtx = makeCtx(journal, [tool], {
      replay: true,
      rehydrate: async () => coerced,
    });
    const replay = await adapter.run({ ...baseSpec, tools: [tool.spec] }, replayCtx);

    // The SDK run() was NOT invoked again on replay (still exactly 1 call total).
    expect(runSpy).toHaveBeenCalledTimes(1);
    // The idempotent tool handler was NOT re-fired on replay (no new calls).
    expect(calls.length).toBe(liveCalls);

    // Replay reproduces the final answer from the journal + the transcript from the store.
    expect(replay.status).toBe('completed');
    expect(replay.finalText).toBe(live.finalText);
    // C3: replay's first turn is the TRUSTED system turn (role='system'), IDENTICAL to live — the
    // coerced 'user' instructions turn was stripped + the trusted system turn re-prepended.
    expect(replay.conversation[0]?.role).toBe('system');
    expect(replay.conversation[0]?.parts).toEqual([{ kind: 'text', text: baseSpec.instructions }]);
    // No DUPLICATE system turn, and the instructions are not also left as a 'user' turn.
    expect(replay.conversation.filter((t) => t.role === 'system')).toHaveLength(1);
    const callPart = replay.conversation
      .flatMap((t) => t.parts)
      .find((p) => p.kind === 'tool_call');
    const resultPart = replay.conversation
      .flatMap((t) => t.parts)
      .find((p) => p.kind === 'tool_result');
    expect(callPart?.kind).toBe('tool_call');
    expect(resultPart?.kind).toBe('tool_result');
  });

  it('returns null-equivalent (live path) when the run is NOT journaled — no false replay', async () => {
    // A replay against an EMPTY journal must not masquerade as a completed replay: with no cached
    // first step, replayFromJournal returns null and the adapter proceeds to the (mocked) live run.
    const calls: unknown[] = [];
    const tool = recordingTool(calls);
    const journal = new FakeJournal();
    runSpy.mockImplementation(fakeRunImpl());
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });

    const ctx = makeCtx(journal, [tool], { replay: true, rehydrate: async () => [] });
    await adapter.run({ ...baseSpec, tools: [tool.spec] }, ctx);
    // No cached step -> fell through to the live run (the model WAS called).
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAI adapter: error-path RunResult shape (D1)', () => {
  it('on a model error returns the identical-shape RunResult with error set + a journaled error step', async () => {
    const journal = new FakeJournal();
    runSpy.mockImplementation(async () => {
      throw new Error('boom: model unavailable');
    });
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const res = await adapter.run({ ...baseSpec, tools: [] }, makeCtx(journal, []));

    expect(res.status).toBe('error');
    expect(res.error).toMatch(/boom: model unavailable/);
    // Key-presence: output + error always present.
    expect(Object.hasOwn(res, 'output')).toBe(true);
    expect(res.output).toBeNull();
    // The error step was journaled (status=error).
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.status).toBe('error');
    expect(journal.records[0]?.type).toBe('llm');
  });
});
