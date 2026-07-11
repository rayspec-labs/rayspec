/**
 * Codex adapter unit tests — deterministic, NO real `codex` spawn, NO network beyond loopback.
 *
 * These prove the adapter wiring against the REAL adapter code, using a fake in-memory JournalSink +
 * the REAL central `makeDispatchTool` (from @rayspec/platform) wired onto the RunContext exactly as
 * run-core does. `@openai/codex-sdk` is MOCKED so `Codex.startThread().runStreamed()` returns a
 * controllable ThreadEvent stream — AND the mock can drive the run's tools by making a REAL MCP call
 * over the loopback bridge the adapter hosted (so the genuine MCP-bridge → ctx.dispatchTool tool-dispatch path
 * runs end-to-end, opaque-wrapping + journaling for real). The MCP `McpServer`/transport + the curated
 * env / auth / confinement / journal / derive / replay code are all the REAL adapter code.
 *
 * Each assertion checks the REAL thing (fail-the-fix, not pass-the-shape):
 *   - resolveAuth: an OAuth auth.json → codex-subscription-oauth; an api-key auth.json / missing →
 *     unauthenticated; a stray OPENAI_API_KEY is DETECTED but does NOT change the mode.
 *   - the curated env STRIPS OPENAI_API_KEY/CODEX_API_KEY/*_BASE_URL (structural mis-billing guard).
 *   - the sandbox confinement options (read-only/no-network/no-web-search/never-approve/empty cwd) are
 *     passed to startThread, and the MCP server config carries default_tools_approval_mode:'approve'.
 *   - a tool flows through ctx.dispatchTool (handler invoked ONLY via the dispatcher; opaque-wrapped;
 *     EXACTLY one `tool` journal step keyed by a per-call id; one tool_called event — no double-emit).
 *   - native structured output: outputSchema → parsed object `output`; the llm step shape; RunResult
 *     identical key-set to the other backends.
 *   - replay reconstructs the run from the journal + rehydrate WITHOUT a startThread call.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AuthMode,
  ConvTurn,
  JournalSink,
  NeutralEvent,
  NeutralEventInput,
  NeutralTool,
  RunContext,
  StepReport,
} from '@rayspec/core';
import { makeDispatchTool } from '@rayspec/platform';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mock @openai/codex-sdk: a controllable Codex/Thread that we drive per test ---------------
// Each test sets `codexBehavior` to decide what the streamed turn does (emit a final message, call the
// run's MCP tool over the REAL bridge, fail, etc.). The mock captures the CodexOptions + ThreadOptions
// the adapter passed so we can assert the curated env + the confinement options + the MCP config.
interface CodexCall {
  options: Record<string, unknown>;
  threadOptions: Record<string, unknown>;
  input: string;
  turnOptions: Record<string, unknown>;
}
const codexCalls: CodexCall[] = [];
let codexBehavior: (call: CodexCall) => AsyncGenerator<Record<string, unknown>> =
  async function* () {
    yield { type: 'turn.started' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: 'default' } };
    yield {
      type: 'turn.completed',
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    };
  };
const startThreadSpy = vi.fn();

vi.mock('@openai/codex-sdk', () => {
  class FakeThread {
    constructor(
      private readonly options: Record<string, unknown>,
      private readonly threadOptions: Record<string, unknown>,
    ) {}
    async runStreamed(input: string, turnOptions: Record<string, unknown>) {
      const call: CodexCall = {
        options: this.options,
        threadOptions: this.threadOptions,
        input,
        turnOptions,
      };
      codexCalls.push(call);
      const events = codexBehavior(call);
      return { events };
    }
    async run(input: string, turnOptions: Record<string, unknown>) {
      const events = codexBehavior({
        options: this.options,
        threadOptions: this.threadOptions,
        input,
        turnOptions,
      });
      let finalResponse = '';
      for await (const ev of events) {
        if (
          ev.type === 'item.completed' &&
          (ev.item as { type?: string })?.type === 'agent_message'
        ) {
          finalResponse = String((ev.item as { text?: string }).text ?? '');
        }
      }
      return { items: [], finalResponse, usage: null };
    }
  }
  class FakeCodex {
    constructor(private readonly options: Record<string, unknown> = {}) {}
    startThread(threadOptions: Record<string, unknown> = {}) {
      startThreadSpy(threadOptions);
      return new FakeThread(this.options, threadOptions);
    }
  }
  return { Codex: FakeCodex };
});

const { CodexAdapter, buildCuratedCodexEnv, CODEX_FORBIDDEN_ENV_KEYS } = await import('./index.js');

/** Fake in-memory JournalSink: records steps + serves cached OK steps on lookup (replay). */
class FakeJournal implements JournalSink {
  records: (StepReport & { authMode: AuthMode })[] = [];
  async lookup(idempotencyKey: string): Promise<{ output: unknown } | null> {
    const hit = this.records.find((r) => r.idempotencyKey === idempotencyKey && r.status === 'ok');
    return hit ? { output: hit.output } : null;
  }
  async lookupToolCache(inputHash: string): Promise<{ output: unknown } | null> {
    const hit = this.records.find(
      (r) => r.type === 'tool' && r.inputHash === inputHash && r.status === 'ok',
    );
    return hit ? { output: hit.output } : null;
  }
  async record(step: StepReport & { authMode: AuthMode }): Promise<string> {
    this.records.push(step);
    return `step-${this.records.length}`;
  }
}

/** Build a RunContext wired EXACTLY like run-core (single seq authority + real dispatchTool). */
function makeCtx(opts: {
  journal: FakeJournal;
  tools?: NeutralTool[];
  replay?: boolean;
  rehydrate?: () => Promise<ConvTurn[]>;
  authMode?: AuthMode;
}): { ctx: RunContext; events: NeutralEvent[] } {
  const events: NeutralEvent[] = [];
  let seq = 0;
  const stampSeq = (e: NeutralEventInput | NeutralEvent): NeutralEvent =>
    ({ ...e, seq: seq++ }) as NeutralEvent;
  const wrappedOnEvent = (e: NeutralEventInput | NeutralEvent): void => {
    events.push(stampSeq(e));
  };
  const tools = opts.tools ?? [];
  const dispatchTool =
    tools.length > 0
      ? makeDispatchTool({
          runId: 'run-codex-test',
          tenantId: 'tenant-test',
          journal: opts.journal,
          tools,
          replay: opts.replay ?? false,
          authMode: opts.authMode ?? 'codex-subscription-oauth',
          onEvent: wrappedOnEvent,
        })
      : undefined;
  const ctx: RunContext = {
    runId: 'run-codex-test',
    tenantId: 'tenant-test',
    onEvent: wrappedOnEvent as RunContext['onEvent'],
    journal: opts.journal,
    replay: opts.replay ?? false,
    authMode: opts.authMode ?? 'codex-subscription-oauth',
    tools,
    dispatchTool,
    ...(opts.rehydrate ? { rehydrate: opts.rehydrate } : {}),
  };
  return { ctx, events };
}

function weatherTool(): NeutralTool {
  return {
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
      const { city } = (args ?? {}) as { city?: string };
      return { city: city ?? 'unknown', tempC: 18, condition: 'cloudy' };
    },
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    timeoutMs: 5000,
    idempotent: true,
  };
}

const baseSpec = {
  name: 'agent',
  instructions: 'You are concise.',
  model: 'gpt-5.5',
  input: 'Say ok.',
  tools: [],
  maxTurns: 8,
} as const;

/** Drive the run's MCP tool over the REAL loopback bridge, using the config the adapter passed codex. */
async function callBridgeTool(
  call: CodexCall,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string }> {
  const cfg = call.options.config as
    | { mcp_servers?: Record<string, { url?: string; bearer_token_env_var?: string }> }
    | undefined;
  const server = cfg?.mcp_servers?.rayspec;
  if (!server?.url) throw new Error('no MCP server url in codex config');
  // The bearer token the adapter set in the curated env under RAYSPEC_MCP_TOKEN.
  const env = call.options.env as Record<string, string>;
  const token = env.RAYSPEC_MCP_TOKEN;
  const client = new Client({ name: 'test-codex', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const res = (await client.callTool({ name: toolName, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (res.content ?? []).map((c) => c.text ?? '').join('');
    return { isError: res.isError, text };
  } finally {
    await client.close();
  }
}

let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  codexCalls.length = 0;
  startThreadSpy.mockClear();
});
afterEach(() => {
  process.env = savedEnv;
  vi.restoreAllMocks();
});

// ===============================================================================================
// AUTH (the #1 mis-billing audit target)
// ===============================================================================================
describe('resolveAuth — subscription-ONLY, stray-key stripped', () => {
  function withCodexHome(auth: Record<string, unknown> | null): string {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    mkdirSync(home, { recursive: true });
    if (auth) writeFileSync(join(home, 'auth.json'), JSON.stringify(auth));
    return home;
  }

  it('an OAuth/ChatGPT auth.json (tokens, no api key) → codex-subscription-oauth', async () => {
    const home = withCodexHome({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'tok', refresh_token: 'r', account_id: 'a' },
    });
    const adapter = new CodexAdapter({ codexHome: home });
    expect(await adapter.resolveAuth()).toBe('codex-subscription-oauth');
    rmSync(home, { recursive: true, force: true });
  });

  it('an api-key auth.json (no tokens / api key baked in) → unauthenticated (never api-key)', async () => {
    const home = withCodexHome({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-real-key' });
    const adapter = new CodexAdapter({ codexHome: home });
    // The codex adapter is subscription-ONLY: an api-key file is NOT its job (the @openai/agents
    // adapter is the api-key path). It must NOT report 'api-key' or 'codex-subscription-oauth'.
    expect(await adapter.resolveAuth()).toBe('unauthenticated');
    rmSync(home, { recursive: true, force: true });
  });

  it('a missing auth.json → unauthenticated', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-empty-'));
    const adapter = new CodexAdapter({ codexHome: home });
    expect(await adapter.resolveAuth()).toBe('unauthenticated');
    rmSync(home, { recursive: true, force: true });
  });

  it('a STRAY OPENAI_API_KEY is DETECTED but does NOT change the subscription mode', async () => {
    const home = withCodexHome({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'tok' },
    });
    process.env.OPENAI_API_KEY = 'sk-STRAY';
    process.env.CODEX_API_KEY = 'sk-STRAY2';
    const adapter = new CodexAdapter({ codexHome: home });
    const check = adapter.authSelfCheck();
    expect(check.strayApiKeyDetected).toBe(true); // detected
    expect(check.oauthSessionPresent).toBe(true);
    expect(check.authMode).toBe('codex-subscription-oauth'); // mode unchanged (stray is stripped at run)
    rmSync(home, { recursive: true, force: true });
  });
});

// ===============================================================================================
// CURATED ENV (structural mis-billing guard)
// ===============================================================================================
describe('buildCuratedCodexEnv — the structural mis-billing guard', () => {
  it('STRIPS OPENAI_API_KEY / CODEX_API_KEY / *_BASE_URL; carries HOME/PATH + the MCP token', () => {
    const source = {
      HOME: '/home/u',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      OPENAI_API_KEY: 'sk-STRAY',
      CODEX_API_KEY: 'sk-STRAY2',
      OPENAI_BASE_URL: 'https://evil.example',
      CODEX_BASE_URL: 'https://evil2.example',
      SOME_SECRET: 'nope',
    } as unknown as NodeJS.ProcessEnv;
    const env = buildCuratedCodexEnv(source, 'tok-123');
    // The forbidden keys NEVER appear (fail-the-fix: if the allowlist ever leaked a key, this fails).
    for (const k of CODEX_FORBIDDEN_ENV_KEYS) expect(env[k]).toBeUndefined();
    // An arbitrary ambient secret is NOT copied (it is an allowlist, not a denylist).
    expect(env.SOME_SECRET).toBeUndefined();
    // The needed vars ARE carried, plus the per-run MCP bearer token.
    expect(env.HOME).toBe('/home/u');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.RAYSPEC_MCP_TOKEN).toBe('tok-123');
  });
});

// ===============================================================================================
// Sandbox CONFINEMENT options + native structured output + RunResult shape (no tools)
// ===============================================================================================
describe('run — §10.A confinement + native structured output + RunResult shape', () => {
  it('passes the read-only / no-network / no-web-search / never-approve / empty-cwd confinement to startThread', async () => {
    codexBehavior = async function* () {
      yield { type: 'turn.started' };
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } };
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 5,
          cached_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0,
        },
      };
    };
    const journal = new FakeJournal();
    const { ctx } = makeCtx({ journal });
    const adapter = new CodexAdapter();
    await adapter.run({ ...baseSpec }, ctx);
    const to = startThreadSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(to.sandboxMode).toBe('read-only');
    expect(to.networkAccessEnabled).toBe(false);
    expect(to.webSearchEnabled).toBe(false);
    expect(to.approvalPolicy).toBe('never');
    expect(to.skipGitRepoCheck).toBe(true);
    expect(typeof to.workingDirectory).toBe('string'); // a fresh empty temp dir
    expect(to.model).toBe('gpt-5.5');
  });

  it('native structured output: outputSchema → the finalResponse JSON parses into `output`', async () => {
    codexBehavior = async function* () {
      yield { type: 'turn.started' };
      yield {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({ city: 'Berlin', condition: 'cloudy' }),
        },
      };
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      };
    };
    const journal = new FakeJournal();
    const { ctx } = makeCtx({ journal });
    const adapter = new CodexAdapter();
    const res = await adapter.run(
      {
        ...baseSpec,
        outputSchema: {
          name: 'weather',
          schema: {
            type: 'object',
            properties: { city: { type: 'string' }, condition: { type: 'string' } },
            required: ['city', 'condition'],
            additionalProperties: false,
          },
        },
      },
      ctx,
    );
    expect(res.status).toBe('completed');
    expect(res.output).toEqual({ city: 'Berlin', condition: 'cloudy' });
    // The outputSchema was forwarded to codex as turnOptions.outputSchema (native path).
    expect(codexCalls[0]?.turnOptions.outputSchema).toBeDefined();
    // RunResult key-set is the neutral one (always-present output/error/errorClass).
    expect(Object.keys(res).sort()).toEqual(
      [
        'authMode',
        'backend',
        'conversation',
        'costUsd',
        'error',
        'errorClass',
        'finalText',
        'output',
        'runId',
        'status',
        'stepCount',
        'usage',
      ].sort(),
    );
    expect(res.backend).toBe('codex');
    expect(res.error).toBeNull();
    expect(res.errorClass).toBeNull();
  });

  it('records exactly ONE llm journal step (one turn) with codex usage mapped neutrally', async () => {
    codexBehavior = async function* () {
      yield { type: 'turn.started' };
      yield { type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } };
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } };
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 20,
          reasoning_output_tokens: 8,
        },
      };
    };
    const journal = new FakeJournal();
    const { ctx, events } = makeCtx({ journal });
    const adapter = new CodexAdapter();
    const res = await adapter.run({ ...baseSpec }, ctx);
    const llmSteps = journal.records.filter((r) => r.type === 'llm');
    expect(llmSteps.length).toBe(1);
    expect(llmSteps[0]?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 40,
      reasoningTokens: 8,
    });
    expect(res.usage.cacheReadTokens).toBe(40);
    expect(res.usage.reasoningTokens).toBe(8);
    // The transcript carries the reasoning part + the final assistant text (re-derived).
    const kinds = res.conversation.flatMap((t) => t.parts.map((p) => p.kind));
    expect(kinds).toContain('reasoning');
    expect(kinds).toContain('text');
    // Single seq authority: events are 0,1,2,... contiguous.
    expect(events.every((e, i) => e.seq === i)).toBe(true);
    // run_started + run_completed present.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run_started');
    expect(types).toContain('run_completed');
  });
});

// ===============================================================================================
// TOOL DISPATCH through the REAL MCP bridge → ctx.dispatchTool (untrusted-content-boundary chokepoint)
// ===============================================================================================
describe('run — a tool flows through the in-proc MCP bridge → ctx.dispatchTool (no double-emit)', () => {
  it('the MCP handler routes to ctx.dispatchTool; result opaque-wrapped; ONE tool journal step; ONE tool_called event', async () => {
    let bridgeResult: { isError?: boolean; text: string } | undefined;
    codexBehavior = async function* (call) {
      yield { type: 'turn.started' };
      // Simulate codex calling our MCP tool over the REAL loopback bridge (drives the dispatcher).
      bridgeResult = await callBridgeTool(call, 'get_weather', { city: 'Berlin' });
      // Real codex ALSO surfaces an `mcp_tool_call` item for the call. The adapter MUST IGNORE it for
      // event emission (dispatchTool is the single tool-event authority) — so emitting this here makes
      // the no-double-emit assertion FAIL-THE-FIX: if the adapter ever emitted a tool_called for this
      // item, #tool_called would be 2, not 1.
      yield {
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          server: 'rayspec',
          tool: 'get_weather',
          status: 'completed',
        },
      };
      yield {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'It is cloudy in Berlin.' },
      };
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 50,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      };
    };
    const journal = new FakeJournal();
    const tools = [weatherTool()];
    const { ctx, events } = makeCtx({ journal, tools });
    const adapter = new CodexAdapter();
    const res = await adapter.run({ ...baseSpec, tools: [weatherTool().spec] }, ctx);

    // The bridge returned the dispatcher's OPAQUE wrapper (never the raw handler output).
    expect(bridgeResult).toBeDefined();
    const wrapped = JSON.parse((bridgeResult as { text: string }).text) as {
      kind?: string;
      data?: unknown;
    };
    expect(wrapped.kind).toBe('tool_data');
    expect(wrapped.data).toEqual({ city: 'Berlin', tempC: 18, condition: 'cloudy' });

    // EXACTLY ONE `tool` journal step (the dispatcher journaled it — the untrusted-content-boundary chokepoint).
    const toolSteps = journal.records.filter((r) => r.type === 'tool');
    expect(toolSteps.length).toBe(1);

    // The MCP config carried the auto-approve key (else codex would cancel the call live).
    const cfg = codexCalls[0]?.options.config as {
      mcp_servers?: {
        rayspec?: { default_tools_approval_mode?: string; bearer_token_env_var?: string };
      };
    };
    expect(cfg?.mcp_servers?.rayspec?.default_tools_approval_mode).toBe('approve');
    expect(cfg?.mcp_servers?.rayspec?.bearer_token_env_var).toBe('RAYSPEC_MCP_TOKEN');

    // NO DOUBLE-EMIT: exactly ONE tool_called event == the number of tool journal steps. The mcp_tool_call
    // item is NEVER emitted as a neutral tool event (dispatchTool is the single tool authority).
    const toolCalled = events.filter((e) => e.type === 'tool_called').length;
    expect(toolCalled).toBe(toolSteps.length);
    expect(toolCalled).toBe(1);

    // The transcript has a correlated tool_call + tool_result joined by the SAME callId, and the
    // journal step's idempotencyKey JOINS that id.
    const parts = res.conversation.flatMap((t) => t.parts);
    const call = parts.find((p) => p.kind === 'tool_call');
    const result = parts.find((p) => p.kind === 'tool_result');
    expect(call?.kind).toBe('tool_call');
    expect(result?.kind).toBe('tool_result');
    if (call?.kind === 'tool_call' && result?.kind === 'tool_result') {
      expect(call.toolCallId).toBe(result.toolCallId);
      expect(toolSteps.map((s) => s.idempotencyKey)).toContain(call.toolCallId);
    }
    // stepCount = 1 llm + 1 tool.
    expect(res.stepCount).toBe(2);
  });
});

// ===============================================================================================
// ERROR PATH (uniform fail-closed neutral shape)
// ===============================================================================================
describe('run — error path yields the uniform neutral error shape', () => {
  it('turn.failed → status=error, error:string, output:null, conversation:[], errorClass set', async () => {
    codexBehavior = async function* () {
      yield { type: 'turn.started' };
      yield { type: 'turn.failed', error: { message: 'rate limit exceeded: too many requests' } };
    };
    const journal = new FakeJournal();
    const { ctx } = makeCtx({ journal });
    const adapter = new CodexAdapter();
    const res = await adapter.run({ ...baseSpec }, ctx);
    expect(res.status).toBe('error');
    expect(typeof res.error).toBe('string');
    expect(res.output).toBeNull();
    expect(res.conversation).toEqual([]);
    expect(res.errorClass).toBe('rate_limited'); // classified from the message
    // The error llm step is journaled with status='error' + the class in its output.
    const llm = journal.records.find((r) => r.type === 'llm');
    expect(llm?.status).toBe('error');
    expect((llm?.output as { errorClass?: string }).errorClass).toBe('rate_limited');
  });
});

// ===============================================================================================
// SETUP-FAILURE resilience (MUST-FIX): a bridge/cwd-init throw → a NEUTRAL error RunResult + NO LEAK
// ===============================================================================================
describe('run — a bridge-init failure yields a neutral error RunResult (no throw, no leaked server)', () => {
  it('McpServer.connect rejecting mid-init → run() RESOLVES to status=error (not throws); server torn down', async () => {
    // Track every http server that starts listening + whether it was later closed — the leak detector.
    const listening = new Set<HttpServer>();
    const realListen = HttpServer.prototype.listen;
    const realClose = HttpServer.prototype.close;
    const listenSpy = vi.spyOn(HttpServer.prototype, 'listen').mockImplementation(function (
      this: HttpServer,
      ...args: unknown[]
    ) {
      listening.add(this);
      // @ts-expect-error — pass through to the real listen with the original args.
      return realListen.apply(this, args);
    });
    const closeSpy = vi.spyOn(HttpServer.prototype, 'close').mockImplementation(function (
      this: HttpServer,
      ...args: unknown[]
    ) {
      listening.delete(this);
      // @ts-expect-error — pass through to the real close with the original args.
      return realClose.apply(this, args);
    });

    // Force the bridge init to throw AFTER the McpServer + transport + httpServer are allocated:
    // mcp.connect() rejects. The adapter must close whatever was allocated + return an error RunResult.
    const connectSpy = vi
      .spyOn(McpServer.prototype, 'connect')
      .mockRejectedValue(new Error('forced connect failure (bridge init)'));

    const journal = new FakeJournal();
    const tools = [weatherTool()];
    const { ctx, events } = makeCtx({ journal, tools });
    const adapter = new CodexAdapter();

    // The whole point: this RESOLVES (does NOT throw) even though setup failed.
    const res = await adapter.run({ ...baseSpec, tools: [weatherTool().spec] }, ctx);

    expect(res.status).toBe('error');
    expect(typeof res.error).toBe('string');
    expect(res.errorClass).not.toBeNull(); // a neutral class is set
    expect(res.output).toBeNull();
    expect(res.conversation).toEqual([]); // an errored run has no trustworthy transcript
    // startThread is never reached (the failure was before the model call).
    expect(startThreadSpy).not.toHaveBeenCalled();
    // run_completed is still emitted with status='error' (uniform terminal frame).
    expect(events.some((e) => e.type === 'run_completed')).toBe(true);

    // NO LEAK: every http server that started listening was closed. (If the adapter had allocated the
    // bridge OUTSIDE the try — the bug this fixes — the cleanup finally would not run on the throw.)
    expect(listening.size).toBe(0);
    expect(connectSpy).toHaveBeenCalled();

    listenSpy.mockRestore();
    closeSpy.mockRestore();
    connectSpy.mockRestore();
  });
});

// ===============================================================================================
// MCP BRIDGE hardening: constant-time bearer (SHOULD-FIX) + body-size cap (SHOULD-FIX)
// ===============================================================================================
describe('run — the MCP bridge caps the request body size + rejects a wrong bearer', () => {
  it('an over-cap body is rejected 413; a wrong token is 401; a normal MCP request still works', async () => {
    let bridgeUrl: string | undefined;
    let bridgeToken: string | undefined;
    let normalToolResult: { isError?: boolean; text: string } | undefined;
    codexBehavior = async function* (call) {
      yield { type: 'turn.started' };
      // Capture the loopback url + token the adapter handed codex, then probe the bridge directly.
      const cfg = call.options.config as
        | { mcp_servers?: Record<string, { url?: string }> }
        | undefined;
      bridgeUrl = cfg?.mcp_servers?.rayspec?.url;
      bridgeToken = (call.options.env as Record<string, string>).RAYSPEC_MCP_TOKEN;
      // A normal MCP tool call still works over the bridge (the cap/guard don't break the happy path).
      normalToolResult = await callBridgeTool(call, 'get_weather', { city: 'Berlin' });
      yield {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'It is cloudy in Berlin.' },
      };
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 5,
          cached_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0,
        },
      };
    };
    const journal = new FakeJournal();
    const tools = [weatherTool()];
    const { ctx } = makeCtx({ journal, tools });
    const adapter = new CodexAdapter();
    await adapter.run({ ...baseSpec, tools: [weatherTool().spec] }, ctx);

    expect(bridgeUrl).toBeDefined();
    expect(bridgeToken).toBeDefined();
    // The normal call returned the dispatcher's opaque tool_data (the happy path is intact).
    expect(normalToolResult).toBeDefined();
    expect(JSON.parse((normalToolResult as { text: string }).text).kind).toBe('tool_data');

    // NOTE: the bridge closes after the run() above completes, so re-probe a FRESH bridge for the
    // 413/401 assertions by driving a second run whose behavior performs the raw HTTP probes.
    let over413: number | undefined;
    let wrong401: number | undefined;
    let okStatus: number | undefined;
    codexBehavior = async function* (call) {
      yield { type: 'turn.started' };
      const cfg = call.options.config as
        | { mcp_servers?: Record<string, { url?: string }> }
        | undefined;
      const url = cfg?.mcp_servers?.rayspec?.url as string;
      const token = (call.options.env as Record<string, string>).RAYSPEC_MCP_TOKEN;
      // 1) An over-cap body (> 4 MiB) → 413 (the handler stops buffering, never reaches the transport).
      const big = 'x'.repeat(4 * 1024 * 1024 + 1024);
      const overRes = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: big,
      });
      over413 = overRes.status;
      // 2) A WRONG bearer token → 401 (constant-time reject).
      const wrongRes = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer not-the-token', 'content-type': 'application/json' },
        body: '{}',
      });
      wrong401 = wrongRes.status;
      // 3) A small, correctly-authed JSON-RPC body is served (the transport replies, not a 4xx). An MCP
      // initialize gets a 200/2xx response from the transport (the happy path under the cap).
      const okRes = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'probe', version: '1.0.0' },
          },
        }),
      });
      okStatus = okRes.status;
      yield {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'done' },
      };
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      };
    };
    const journal2 = new FakeJournal();
    const { ctx: ctx2 } = makeCtx({ journal: journal2, tools: [weatherTool()] });
    await adapter.run({ ...baseSpec, tools: [weatherTool().spec] }, ctx2);

    expect(over413).toBe(413); // over-cap → payload too large (fail-the-fix: no cap ⇒ NOT 413)
    expect(wrong401).toBe(401); // wrong token → unauthorized
    expect(okStatus).toBeLessThan(400); // a normal authed request is served by the transport
  });
});

// ===============================================================================================
// REPLAY (journal short-circuit — no startThread)
// ===============================================================================================
describe('run — replay reconstructs from the journal WITHOUT spawning codex', () => {
  it('a cached llm step + rehydrate → the run is replayed; startThread is NOT called', async () => {
    const journal = new FakeJournal();
    // Seed a cached llm step the replay path looks up (the same key the live path uses).
    const adapter = new CodexAdapter();
    // First do a live run to populate the journal deterministically.
    codexBehavior = async function* () {
      yield { type: 'turn.started' };
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'cached answer' } };
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 3,
          cached_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0,
        },
      };
    };
    const live = makeCtx({ journal });
    await adapter.run({ ...baseSpec }, live.ctx);
    startThreadSpy.mockClear();

    // Now replay: rehydrate supplies the stored transcript; startThread must NOT be called.
    const rehydrated: ConvTurn[] = [
      { role: 'user', index: 0, parts: [{ kind: 'text', text: 'You are concise.' }] },
      { role: 'assistant', index: 1, parts: [{ kind: 'text', text: 'cached answer' }] },
    ];
    const replayCtx = makeCtx({ journal, replay: true, rehydrate: async () => rehydrated });
    const res = await adapter.run({ ...baseSpec }, replayCtx.ctx);
    expect(startThreadSpy).not.toHaveBeenCalled();
    expect(res.status).toBe('completed');
    expect(res.finalText).toBe('cached answer');
    // The trusted system turn is re-prepended on replay (untrusted-content boundary: first turn role='system').
    expect(res.conversation[0]?.role).toBe('system');
  });
});
