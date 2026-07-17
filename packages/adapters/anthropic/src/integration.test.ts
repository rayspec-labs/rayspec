/**
 * Anthropic adapter integration tests — deterministic, NO network, NO DB, NO subprocess.
 *
 * The @anthropic-ai/claude-agent-sdk surface is mocked so the adapter's REAL control flow runs:
 *   - `query()` is mocked to yield a captured-shape message STREAM (system/init, assistant with a
 *     tool_use block, user with a tool_result block, assistant text, result) AND to INVOKE the
 *     in-proc MCP tool's handler (simulating the `claude` child calling the bridged tool) so the
 *     dispatcher path actually runs;
 *   - `createSdkMcpServer` / `tool` are PARTIALLY real: `tool()` captures the (name, handler) so the
 *     mock query can invoke the handler; `createSdkMcpServer` records the tools.
 *
 * Proven here (each assertion checks the REAL thing):
 *   - the MCP tool handler routes through ctx.dispatchTool (handler invoked ONLY via the dispatcher;
 *     the adapter holds no handler); the result is opaque-wrapped; EXACTLY one `tool` journal step;
 *   - the conversation re-derivation produces correlated tool_call/tool_result parts by the REAL
 *     tool_use id, with the TRUSTED system turn;
 *   - a real per-step llm ledger (one step per assistant turn) -> stepCount > 1;
 *   - the abortController is aborted (the child is owned/torn down).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthMode, NeutralTool, RunContext, StepReport } from '@rayspec/core';
import { makeDispatchTool } from '@rayspec/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A hermetic, per-run config root (a fresh 0700 tree). The adapter now refuses a group/world-accessible
// tenant dir, so these tests must not share a persistent, world-readable location across runs.
const CONFIG_ROOT = mkdtempSync(join(tmpdir(), 'rayspec-anth-int-'));

// ---- mock the SDK: real-ish tool()/createSdkMcpServer + a controllable query() -----------------
interface CapturedTool {
  name: string;
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
}
const capturedTools: CapturedTool[] = [];
const querySpy = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: CapturedTool['handler'],
  ) => {
    const t: CapturedTool = { name, handler };
    capturedTools.push(t);
    return { name, handler };
  },
  createSdkMcpServer: (opts: { name: string; tools: unknown[] }) => ({
    type: 'sdk',
    name: opts.name,
    instance: {},
  }),
  query: (params: unknown) => querySpy(params),
}));

const { AnthropicAdapter } = await import('./index.js');

class FakeJournal {
  records: (StepReport & { authMode: AuthMode })[] = [];
  async lookup(): Promise<{ output: unknown } | null> {
    return null;
  }
  async lookupToolCache(): Promise<{ output: unknown } | null> {
    return null;
  }
  async record(step: StepReport & { authMode: AuthMode }): Promise<string> {
    this.records.push(step);
    return `step-${this.records.length}`;
  }
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
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  timeoutMs: 1000,
  idempotent: true,
});

function makeCtx(journal: FakeJournal, tools: NeutralTool[]): RunContext {
  const runId = 'run-anth-1';
  const authMode: AuthMode = 'subscription-oauth-official-harness';
  const events: unknown[] = [];
  let seq = 0;
  const wrapped = (e: unknown) => {
    events.push({ ...(e as object), seq: seq++ });
  };
  const dispatchTool =
    tools.length > 0
      ? makeDispatchTool({
          runId,
          tenantId: 't1',
          journal,
          tools,
          replay: false,
          authMode,
          onEvent: wrapped,
        })
      : undefined;
  return {
    runId,
    tenantId: 't1',
    onEvent: wrapped as RunContext['onEvent'],
    journal,
    replay: false,
    authMode,
    tools,
    dispatchTool,
  };
}

const baseSpec = {
  name: 'weather-agent',
  instructions: 'You are a concise assistant. Use get_weather when asked about weather.',
  model: 'claude-haiku-4-5',
  input: 'What is the weather in Berlin?',
  maxTurns: 8,
};

const savedTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
beforeEach(() => {
  capturedTools.length = 0;
  querySpy.mockReset();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test';
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  if (savedTok === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedTok;
  vi.restoreAllMocks();
});

/**
 * A mock query() that (a) invokes the captured MCP tool handler with the real tool_use id (the
 * `claude` child calling the bridged tool) and (b) yields a captured-shape message stream that
 * carries the tool_use + tool_result + text blocks for re-derivation.
 */
function mockQueryWithToolCall(toolCallId: string) {
  return (params: unknown) => {
    void params;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 'sess-1' };
        // Invoke the bridged MCP tool handler (the dispatcher path) BEFORE yielding the tool_result.
        for (const t of capturedTools) {
          await t.handler({ city: 'Berlin' }, { _meta: { 'claudecode/toolUseId': toolCallId } });
        }
        // assistant turn 1: a tool_use block.
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: toolCallId, name: 'get_weather', input: { city: 'Berlin' } },
            ],
            usage: { input_tokens: 50, output_tokens: 10 },
          },
        };
        // user turn: the tool_result block (CLI feeds the tool output back as a user turn). In the
        // REAL flow the MCP bridge returns the OPAQUE dispatcher result (kind:'tool_data') stringified
        // into the tool channel, so the CLI echoes THAT back — the mock mirrors it exactly.
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolCallId,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      kind: 'tool_data',
                      name: 'get_weather',
                      toolCallId,
                      data: { city: 'Berlin', tempC: 18, condition: 'cloudy' },
                    }),
                  },
                ],
              },
            ],
          },
        };
        // assistant turn 2: the final text.
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'It is 18C and cloudy in Berlin.' }],
            usage: { input_tokens: 70, output_tokens: 12 },
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'It is 18C and cloudy in Berlin.',
          usage: { input_tokens: 120, output_tokens: 22 },
          total_cost_usd: 0.0012,
          session_id: 'sess-1',
        };
      },
      interrupt: async () => {},
    };
  };
}

/**
 * A mock query() that yields a BUILT-IN tool block (ToolSearch — NOT one of our MCP tools)
 * alongside the legit MCP get_weather call. Proves the re-derivation QUARANTINE excludes the built-in
 * tool_use + its raw tool_result from the neutral transcript, and that the built-in is never
 * journaled (only the dispatched MCP tool is). The built-in is given a DISTINCT tool_use id.
 */
function mockQueryWithBuiltinAndMcpCall(builtinId: string, mcpId: string) {
  return (params: unknown) => {
    void params;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 'sess-b' };
        // The MCP bridge handler fires for the sanctioned tool only (the built-in never reaches it).
        for (const t of capturedTools) {
          await t.handler({ city: 'Berlin' }, { _meta: { 'claudecode/toolUseId': mcpId } });
        }
        // assistant turn 1: a BUILT-IN tool_use (ToolSearch) — must be QUARANTINED.
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: builtinId, name: 'ToolSearch', input: { query: 'x' } },
            ],
            usage: { input_tokens: 40, output_tokens: 8 },
          },
        };
        // user turn: the built-in's raw tool_result — must be QUARANTINED (never enters the SoT).
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: builtinId,
                content: [{ type: 'text', text: '[{"name":"Bash"}]' }],
              },
            ],
          },
        };
        // assistant turn 2: the legit MCP tool_use.
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: mcpId, name: 'get_weather', input: { city: 'Berlin' } },
            ],
            usage: { input_tokens: 50, output_tokens: 10 },
          },
        };
        // user turn: the MCP tool_result — the OPAQUE dispatcher result (kind:'tool_data'), exactly as
        // the bridge returns it into the tool channel.
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: mcpId,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      kind: 'tool_data',
                      name: 'get_weather',
                      toolCallId: mcpId,
                      data: { city: 'Berlin', tempC: 18, condition: 'cloudy' },
                    }),
                  },
                ],
              },
            ],
          },
        };
        // assistant turn 3: final text.
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'It is 18C and cloudy in Berlin.' }],
            usage: { input_tokens: 70, output_tokens: 12 },
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'It is 18C and cloudy in Berlin.',
          usage: { input_tokens: 160, output_tokens: 30 },
          total_cost_usd: 0.002,
          session_id: 'sess-b',
        };
      },
      interrupt: async () => {},
    };
  };
}

describe('Anthropic adapter: built-in-tool restriction + quarantine (the untrusted-content boundary)', () => {
  it('passes tools:[] (built-ins disabled) + a canUseTool deny hook allowing only mcp__rayspec__*', async () => {
    const calls: unknown[] = [];
    const tool = recordingTool(calls);
    const journal = new FakeJournal();
    let opts:
      | {
          tools?: unknown;
          canUseTool?: (n: string, i: Record<string, unknown>) => Promise<unknown>;
        }
      | undefined;
    querySpy.mockImplementation((params: unknown) => {
      opts = (params as { options?: typeof opts }).options;
      return mockQueryWithToolCall('toolu_X')(params);
    });

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    await adapter.run({ ...baseSpec, tools: [tool.spec] }, makeCtx(journal, [tool]));

    // The built-in-tool restrictor: tools:[] disables ALL built-in tools (the documented mechanism).
    expect(opts?.tools).toEqual([]);
    // The defense-in-depth permission hook ALLOWS the sanctioned MCP tool and DENIES everything else.
    const hook = opts?.canUseTool;
    expect(typeof hook).toBe('function');
    if (hook) {
      const allowMcp = await hook('mcp__rayspec__get_weather', { city: 'Berlin' });
      expect((allowMcp as { behavior: string }).behavior).toBe('allow');
      const allowBare = await hook('get_weather', { city: 'Berlin' });
      expect((allowBare as { behavior: string }).behavior).toBe('allow');
      for (const builtin of ['Bash', 'Read', 'Write', 'Edit', 'ToolSearch', 'WebFetch', 'Glob']) {
        const denied = await hook(builtin, {});
        expect((denied as { behavior: string }).behavior).toBe('deny');
      }
    }
  });

  it('QUARANTINES a built-in tool_use/tool_result from the transcript + never journals it; ONLY the MCP tool is dispatched', async () => {
    const calls: unknown[] = [];
    const tool = recordingTool(calls);
    const journal = new FakeJournal();
    querySpy.mockImplementation(
      mockQueryWithBuiltinAndMcpCall('toolu_BUILTIN_ToolSearch', 'toolu_MCP_weather'),
    );

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    const res = await adapter.run({ ...baseSpec, tools: [tool.spec] }, makeCtx(journal, [tool]));

    expect(res.status).toBe('completed');
    const parts = res.conversation.flatMap((t) => t.parts);

    // The built-in tool_use is EXCLUDED — no tool_call/tool_result with the built-in name or id.
    expect(parts.some((p) => p.kind === 'tool_call' && p.name === 'ToolSearch')).toBe(false);
    expect(
      parts.some(
        (p) =>
          (p.kind === 'tool_call' || p.kind === 'tool_result') &&
          p.toolCallId === 'toolu_BUILTIN_ToolSearch',
      ),
    ).toBe(false);
    // EVERY tool_result that DID survive is the opaque dispatched kind:'tool_data' (no raw built-in
    // output leaked into the SoT).
    const resultParts = parts.filter((p) => p.kind === 'tool_result');
    expect(resultParts.length).toBeGreaterThanOrEqual(1);
    for (const p of resultParts) {
      if (p.kind === 'tool_result') {
        expect((p.result as { kind?: string })?.kind).toBe('tool_data');
      }
    }
    // The ONLY surviving tool_call is the sanctioned MCP one (correlated with the journal step).
    const callNames = parts
      .filter((p) => p.kind === 'tool_call')
      .map((p) => (p as { name: string }).name);
    expect(callNames).toEqual(['get_weather']);

    // The built-in is NEVER journaled: exactly one tool step, keyed by the MCP tool_use id.
    const toolSteps = journal.records.filter((s) => s.type === 'tool');
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0]?.idempotencyKey).toBe('toolu_MCP_weather');
    expect((toolSteps[0]?.output as { kind?: string })?.kind).toBe('tool_data');
    // The dispatcher ran the MCP handler exactly once; the built-in never reached any handler.
    expect(calls).toEqual([{ city: 'Berlin' }]);
  });
});

describe('Anthropic adapter: in-proc MCP tool bridge routes through ctx.dispatchTool', () => {
  it('invokes the handler ONLY via the dispatcher, opaque-wraps, journals ONE tool step, correlates parts', async () => {
    const calls: unknown[] = [];
    const tool = recordingTool(calls);
    const journal = new FakeJournal();
    querySpy.mockImplementation(mockQueryWithToolCall('toolu_REAL_123'));

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    const res = await adapter.run({ ...baseSpec, tools: [tool.spec] }, makeCtx(journal, [tool]));

    expect(res.status).toBe('completed');
    // The handler ran EXACTLY once, ONLY through the dispatcher (the adapter holds no handler).
    expect(calls).toEqual([{ city: 'Berlin' }]);

    // EXACTLY ONE `tool` journal step (recorded by dispatchTool), opaque-wrapped.
    const toolSteps = journal.records.filter((s) => s.type === 'tool');
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0]?.status).toBe('ok');
    expect((toolSteps[0]?.output as { kind?: string })?.kind).toBe('tool_data');
    // The tool step's uniqueness key is the REAL tool_use id (journal<->transcript join).
    expect(toolSteps[0]?.idempotencyKey).toBe('toolu_REAL_123');
    // Attributed to the run's REAL subscription authMode.
    expect(toolSteps[0]?.authMode).toBe('subscription-oauth-official-harness');

    // Correlated tool_call / tool_result parts by the SAME real tool_use id.
    const parts = res.conversation.flatMap((t) => t.parts);
    const callPart = parts.find((p) => p.kind === 'tool_call');
    const resultPart = parts.find((p) => p.kind === 'tool_result');
    expect(callPart?.kind).toBe('tool_call');
    expect(resultPart?.kind).toBe('tool_result');
    if (callPart?.kind === 'tool_call' && resultPart?.kind === 'tool_result') {
      expect(callPart.toolCallId).toBe('toolu_REAL_123');
      expect(resultPart.toolCallId).toBe('toolu_REAL_123');
    }
    // EVERY tool_result in the transcript is the opaque dispatched kind:'tool_data' (no raw,
    // un-opaque-wrapped output ever lands in the SoT) AND EVERY tool_call is a sanctioned MCP tool.
    const allResults = parts.filter((p) => p.kind === 'tool_result');
    expect(allResults.length).toBeGreaterThanOrEqual(1);
    for (const p of allResults) {
      if (p.kind === 'tool_result') expect((p.result as { kind?: string })?.kind).toBe('tool_data');
    }
    for (const p of parts) {
      if (p.kind === 'tool_call') expect(p.name).toBe('get_weather');
    }
    // The trusted system turn is from spec.instructions, not the stream.
    expect(res.conversation[0]?.role).toBe('system');
    expect(res.conversation[0]?.parts).toEqual([{ kind: 'text', text: baseSpec.instructions }]);
  });

  it('journals a REAL per-step llm ledger (one step per assistant turn) -> stepCount > 1', async () => {
    const calls: unknown[] = [];
    const tool = recordingTool(calls);
    const journal = new FakeJournal();
    querySpy.mockImplementation(mockQueryWithToolCall('toolu_REAL_456'));

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    const res = await adapter.run({ ...baseSpec, tools: [tool.spec] }, makeCtx(journal, [tool]));

    const llm = journal.records.filter((s) => s.type === 'llm');
    // Two assistant turns -> two real llm steps (NOT a hard-coded 1).
    expect(llm.length).toBe(2);
    expect(llm[0]?.usage.inputTokens).toBe(50);
    expect(llm[1]?.usage.inputTokens).toBe(70);
    // stepCount = 2 llm + 1 tool = 3 (the real total).
    expect(res.stepCount).toBe(3);
    // Aggregate usage from the result message.
    expect(res.usage.inputTokens).toBe(120);
    expect(res.usage.outputTokens).toBe(22);
    expect(res.costUsd).toBe(0.0012);
  });
});

describe('Anthropic adapter: a legit tool whose sole property is named `args` is NOT unwrapped', () => {
  it('passes { args: ... } straight to the dispatcher (no single-args unwrap for a real projected shape)', async () => {
    // A tool whose object schema's ONLY property is literally named `args` (a real field, not the
    // fallback blob). The projection produces a REAL shape (type:object with properties), so the
    // single-`args` unwrap must NOT fire — the dispatcher must receive { args: 'json-ish' } verbatim.
    const received: unknown[] = [];
    const argsTool: NeutralTool = {
      spec: {
        name: 'lookup',
        description: 'A tool whose sole arg is named args.',
        parameters: {
          type: 'object',
          properties: { args: { type: 'string' } },
          required: ['args'],
          additionalProperties: false,
        },
      },
      handler: (a: unknown) => {
        received.push(a);
        return { ok: true };
      },
      inputSchema: {
        type: 'object',
        properties: { args: { type: 'string' } },
        required: ['args'],
        additionalProperties: false,
      },
      timeoutMs: 1000,
      idempotent: true,
    };
    const journal = new FakeJournal();
    // The mock query invokes the captured handler with the model's shaped object { args: '{"x":1}' }.
    querySpy.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' };
        for (const t of capturedTools) {
          await t.handler({ args: '{"x":1}' }, { _meta: { 'claudecode/toolUseId': 'toolu_args' } });
        }
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 5, output_tokens: 2 },
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          usage: { input_tokens: 5, output_tokens: 2 },
          total_cost_usd: 0.0001,
          session_id: 's',
        };
      },
      interrupt: async () => {},
    }));

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    await adapter.run({ ...baseSpec, tools: [argsTool.spec] }, makeCtx(journal, [argsTool]));

    // The handler received the FULL { args: '{"x":1}' } object — NOT the unwrapped '{"x":1}' string.
    expect(received).toEqual([{ args: '{"x":1}' }]);
  });

  it('STILL unwraps the single-args FALLBACK shape (non-object/unschemaable parameters)', async () => {
    // A tool whose parameters are NOT an object schema -> projection falls back to { args: z.unknown() },
    // and a model that wraps the call in { args: '<json>' } SHOULD be unwrapped so dispatch sees the obj.
    const received: unknown[] = [];
    const fallbackTool: NeutralTool = {
      spec: {
        name: 'freeform',
        description: 'A tool with a non-object schema (forces the args fallback).',
        // Not type:object -> jsonSchemaToZodShape falls back to { args: z.unknown() }.
        parameters: { type: 'string' },
      },
      handler: (a: unknown) => {
        received.push(a);
        return { ok: true };
      },
      // No inputSchema so the dispatcher accepts whatever (validate-in is permissive here).
      timeoutMs: 1000,
      idempotent: true,
    };
    const journal = new FakeJournal();
    querySpy.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' };
        for (const t of capturedTools) {
          await t.handler({ args: '{"y":2}' }, { _meta: { 'claudecode/toolUseId': 'toolu_fb' } });
        }
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 5, output_tokens: 2 },
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          usage: { input_tokens: 5, output_tokens: 2 },
          session_id: 's',
        };
      },
      interrupt: async () => {},
    }));

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    await adapter.run(
      { ...baseSpec, tools: [fallbackTool.spec] },
      makeCtx(journal, [fallbackTool]),
    );

    // The fallback shape DID unwrap the inner JSON string into the real object.
    expect(received).toEqual([{ y: 2 }]);
  });
});

describe('Anthropic adapter: non-success result branch (subtype !== success)', () => {
  it('a result with subtype=error_max_turns yields status=error + error message + output:null', async () => {
    const journal = new FakeJournal();
    querySpy.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' };
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'partial...' }],
            usage: { input_tokens: 9, output_tokens: 4 },
          },
        };
        // The line-~277 non-success branch: the run hit the max-turn limit (a reachable error path).
        yield {
          type: 'result',
          subtype: 'error_max_turns',
          usage: { input_tokens: 9, output_tokens: 4 },
          session_id: 's',
        };
      },
      interrupt: async () => {},
    }));

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    const res = await adapter.run({ ...baseSpec, tools: [] }, makeCtx(journal, []));

    expect(res.status).toBe('error');
    // The error message names the non-success subtype (the reachable branch is covered).
    expect(res.error).toBe('result subtype=error_max_turns');
    expect(res.output).toBeNull();
    // An errored run has no trustworthy transcript -> [] (matches the uniform error shape).
    expect(res.conversation).toEqual([]);
    // The final llm step is journaled with status 'error'.
    const llm = journal.records.filter((s) => s.type === 'llm');
    expect(llm.length).toBeGreaterThanOrEqual(1);
    expect(llm[llm.length - 1]?.status).toBe('error');
  });
});

describe('Anthropic adapter: no total_cost_usd => provider cost ABSENT (no fabricated $0, no false drift)', () => {
  it('a success result WITHOUT total_cost_usd records NO providerCostUsd on the final llm step', async () => {
    const journal = new FakeJournal();
    // A success result that omits total_cost_usd (e.g. a partial/older SDK shape). The adapter must
    // NOT fabricate providerCostUsd:0 — that would later trip a FALSE cost_drift vs the non-zero
    // computed cost. The step is left WITHOUT providerCostUsd (run-core journals provider_cost_usd=NULL).
    querySpy.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' };
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'no cost reported' }],
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        };
        // NOTE: no total_cost_usd field on this success result.
        yield {
          type: 'result',
          subtype: 'success',
          result: 'no cost reported',
          usage: { input_tokens: 100, output_tokens: 50 },
          session_id: 's',
        };
      },
      interrupt: async () => {},
    }));

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    const res = await adapter.run({ ...baseSpec, tools: [] }, makeCtx(journal, []));

    expect(res.status).toBe('completed');
    const llm = journal.records.filter((s) => s.type === 'llm');
    expect(llm.length).toBeGreaterThanOrEqual(1);
    const finalStep = llm[llm.length - 1];
    // The KEY assertion: providerCostUsd is ABSENT (undefined), NOT a fabricated 0.
    expect(finalStep?.providerCostUsd).toBeUndefined();
    expect('providerCostUsd' in (finalStep ?? {})).toBe(false);
  });

  it('a success result WITH total_cost_usd still surfaces it as the provider cost (regression guard)', async () => {
    const journal = new FakeJournal();
    querySpy.mockImplementation(mockQueryWithToolCall('toolu_cost'));
    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    await adapter.run(
      { ...baseSpec, tools: [recordingTool([]).spec] },
      makeCtx(journal, [recordingTool([])]),
    );
    const llm = journal.records.filter((s) => s.type === 'llm');
    const finalStep = llm[llm.length - 1];
    // total_cost_usd=0.0012 (from mockQueryWithToolCall) IS surfaced on the final step.
    expect(finalStep?.providerCostUsd).toBe(0.0012);
  });
});

describe('Anthropic adapter: native structured output via outputFormat (no prompt hack)', () => {
  it('passes outputFormat json_schema to query() and surfaces structured_output on the result', async () => {
    const journal = new FakeJournal();
    let passedOptions: { outputFormat?: unknown } | undefined;
    querySpy.mockImplementation((params: unknown) => {
      passedOptions = (params as { options?: { outputFormat?: unknown } }).options;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' };
          yield {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: '{"city":"Berlin"}' }],
              usage: { input_tokens: 5, output_tokens: 3 },
            },
          };
          yield {
            type: 'result',
            subtype: 'success',
            result: '{"city":"Berlin"}',
            structured_output: { city: 'Berlin' },
            usage: { input_tokens: 5, output_tokens: 3 },
            total_cost_usd: 0.0001,
            session_id: 's',
          };
        },
        interrupt: async () => {},
      };
    });

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    const res = await adapter.run(
      {
        ...baseSpec,
        tools: [],
        outputSchema: {
          name: 'city',
          schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
      makeCtx(journal, []),
    );

    // The adapter sent the NATIVE outputFormat (json_schema) — not a prompt-injection hack.
    expect(passedOptions?.outputFormat).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { city: { type: 'string' } } },
    });
    // The structured output came back NATIVELY on the result message.
    expect(res.output).toEqual({ city: 'Berlin' });
  });
});

/**
 * (fail-the-fix): the Claude Agent SDK emits MULTIPLE `type:'assistant'` STREAM FRAMES for
 * ONE real model call (e.g. a `thinking` block frame, then the `text`/`tool_use` frame), and each
 * frame carries the SAME cumulative per-turn `message.usage`. Without coalescing, the adapter records
 * ONE `llm` journal step PER FRAME — double-journaling a single model call, inflating stepCount + the
 * COMPUTED cost value-metric (and, on an api-key auth, billed_cost_usd). Coalescing frames by
 * the BetaMessage `message.id` yields ONE entry per real call, its usage counted ONCE.
 *
 * Case 1: ONE real call delivered as TWO frames (same message.id, usage 1481,4) => EXACTLY ONE `llm` step + stepCount 1.
 * Case 2 (two DISTINCT message.id ⇒ two real calls) must still yield TWO `llm` steps — proves the
 * coalesce does NOT over-collapse genuinely separate calls.
 */
describe('Anthropic adapter: coalesce assistant stream frames into real model calls', () => {
  it('ONE real call emitted as TWO frames (same message.id, same usage) => EXACTLY ONE llm step (not two)', async () => {
    const journal = new FakeJournal();
    // A SINGLE real model call delivered as a thinking-block frame + a text-block frame. Both frames
    // are the SAME BetaMessage (message.id 'msg_1') and carry the SAME cumulative per-turn usage
    // (input_tokens 1481, output_tokens 4) — exactly the real SDK behavior (sdk 0.3.185).
    querySpy.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' };
        // FRAME 1 of the call: the thinking content block.
        yield {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [{ type: 'thinking', thinking: 'Let me think about Berlin weather.' }],
            usage: { input_tokens: 1481, output_tokens: 4 },
          },
        };
        // FRAME 2 of the SAME call: the text content block — SAME message.id, SAME cumulative usage.
        yield {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [{ type: 'text', text: 'It is mild in Berlin.' }],
            usage: { input_tokens: 1481, output_tokens: 4 },
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'It is mild in Berlin.',
          usage: { input_tokens: 1481, output_tokens: 4 },
          total_cost_usd: 0.0009,
          session_id: 's',
        };
      },
      interrupt: async () => {},
    }));

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    const res = await adapter.run({ ...baseSpec, tools: [] }, makeCtx(journal, []));

    const llmSteps = journal.records.filter((s) => s.type === 'llm');
    // THE fail-the-fix assertion: ONE real call ⇒ ONE llm step (pre-fix this was 2 — one per frame).
    expect(llmSteps.length).toBe(1);
    // The single step carries the per-turn usage counted ONCE (1481, 4) — not doubled.
    expect(llmSteps[0]?.usage?.inputTokens).toBe(1481);
    expect(llmSteps[0]?.usage?.outputTokens).toBe(4);
    // stepCount reflects exactly one model call (no dispatched tools here).
    expect(res.stepCount).toBe(1);
    // The aggregate usage on the result is the single real call's usage counted once.
    expect(res.usage.inputTokens).toBe(1481);
    expect(res.usage.outputTokens).toBe(4);
  });

  it('TWO DISTINCT message.ids (two real calls) => TWO llm steps (no over-collapse)', async () => {
    const journal = new FakeJournal();
    // Two genuinely separate model calls, each one frame: distinct BetaMessage ids ('msg_1','msg_2'),
    // distinct usages. The coalesce MUST keep them as two entries (does not collapse distinct calls).
    querySpy.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' };
        yield {
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [{ type: 'text', text: 'first call' }],
            usage: { input_tokens: 100, output_tokens: 10 },
          },
        };
        yield {
          type: 'assistant',
          message: {
            id: 'msg_2',
            content: [{ type: 'text', text: 'second call' }],
            usage: { input_tokens: 200, output_tokens: 20 },
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'second call',
          usage: { input_tokens: 300, output_tokens: 30 },
          total_cost_usd: 0.002,
          session_id: 's',
        };
      },
      interrupt: async () => {},
    }));

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    const res = await adapter.run({ ...baseSpec, tools: [] }, makeCtx(journal, []));

    const llmSteps = journal.records.filter((s) => s.type === 'llm');
    // Two distinct real calls ⇒ two llm steps — the coalesce did NOT over-collapse.
    expect(llmSteps.length).toBe(2);
    expect(llmSteps[0]?.usage?.inputTokens).toBe(100);
    expect(llmSteps[1]?.usage?.inputTokens).toBe(200);
    expect(res.stepCount).toBe(2);
  });

  it('id-less fallback: TWO frames with byte-identical usage and no message.id => ONE llm step', async () => {
    const journal = new FakeJournal();
    // The defensive fallback for a (currently unexpected) id-less stream: two CONSECUTIVE frames with
    // byte-identical cumulative usage and NO message.id are coalesced into one real call.
    querySpy.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' };
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'thinking', thinking: 'thinking…' }],
            usage: { input_tokens: 80, output_tokens: 6 },
          },
        };
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'answer' }],
            usage: { input_tokens: 80, output_tokens: 6 },
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'answer',
          usage: { input_tokens: 80, output_tokens: 6 },
          total_cost_usd: 0.0005,
          session_id: 's',
        };
      },
      interrupt: async () => {},
    }));

    const adapter = new AnthropicAdapter({ configRoot: CONFIG_ROOT });
    const res = await adapter.run({ ...baseSpec, tools: [] }, makeCtx(journal, []));

    const llmSteps = journal.records.filter((s) => s.type === 'llm');
    expect(llmSteps.length).toBe(1);
    expect(res.stepCount).toBe(1);
  });
});
