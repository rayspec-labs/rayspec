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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { connect, type Socket } from 'node:net';
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
  signal?: AbortSignal;
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
    ...(opts.signal ? { signal: opts.signal } : {}),
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

  it('resolveCodexHome PRECEDENCE: CODEX_HOME > codexHome > $HOME/.codex — and this suite resolves a credential-free home', () => {
    const oauth = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'tok' } };
    const ambient = withCodexHome(oauth);
    const option = mkdtempSync(join(tmpdir(), 'codex-home-opt-'));
    const fallback = mkdtempSync(join(tmpdir(), 'codex-home-fallback-'));
    mkdirSync(join(fallback, '.codex'), { recursive: true });
    writeFileSync(join(fallback, '.codex', 'auth.json'), JSON.stringify(oauth));

    // 1. The ambient variable BEATS the constructor option — the reason vitest.setup.ts deletes it.
    process.env.CODEX_HOME = ambient;
    expect(new CodexAdapter({ codexHome: option }).authSelfCheck().oauthSessionPresent).toBe(true);

    // 2. With it gone, the constructor option decides.
    delete process.env.CODEX_HOME;
    expect(new CodexAdapter({ codexHome: option }).authSelfCheck().oauthSessionPresent).toBe(false);
    expect(new CodexAdapter({ codexHome: ambient }).authSelfCheck().oauthSessionPresent).toBe(true);

    // 3. With no option either, resolution falls through to `$HOME/.codex`. That is the read most of
    //    this file performs — `new CodexAdapter()` with no options, whose `run()` calls
    //    `authSelfCheck()` on its first line — and on a developer machine `$HOME/.codex/auth.json` is
    //    the real ChatGPT-OAuth session. Deleting CODEX_HOME alone only redirects the read here.
    process.env.HOME = fallback;
    expect(new CodexAdapter().authSelfCheck().oauthSessionPresent).toBe(true);

    // 4. Under this suite's own env, that fallback is the empty temp dir vitest.setup.ts made: no
    //    `.codex` inside it at all. This is the assertion behind the claim in vitest.config.ts that
    //    the suite reads no credential file — it fails if either half of the setup file is removed.
    process.env = { ...savedEnv };
    expect(process.env.CODEX_HOME).toBeUndefined();
    // `HOME` is the temp dir the setup file made, not the developer's. That assertion is the
    // machine-independent one: the emptiness check below reddens only on a machine that actually
    // HAS a `~/.codex`, which is exactly the machine the whole guard exists for.
    expect(process.env.HOME?.startsWith(join(tmpdir(), 'codex-suite-home-'))).toBe(true);
    expect(existsSync(join(process.env.HOME ?? '', '.codex'))).toBe(false);
    expect(new CodexAdapter().authSelfCheck().oauthSessionPresent).toBe(false);

    for (const dir of [ambient, option, fallback]) rmSync(dir, { recursive: true, force: true });
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
describe('run — sandbox confinement + native structured output + RunResult shape', () => {
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

describe('Codex adapter: the run’s cancellation signal reaches the streamed turn', () => {
  const okEvents = async function* () {
    yield { type: 'turn.started' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } };
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

  it('links ctx.signal to the AbortController it passes as turnOptions.signal', async () => {
    const journal = new FakeJournal();
    const controller = new AbortController();
    let abortedWhileRunning: boolean | undefined;
    codexBehavior = (call: CodexCall) => {
      const handed = (call.turnOptions as { signal?: AbortSignal }).signal;
      // MID-CALL: the adapter aborts its own controller in the teardown either way, so asserting
      // after the run would pass with no link at all.
      controller.abort();
      abortedWhileRunning = handed?.aborted;
      return okEvents();
    };

    const { ctx } = makeCtx({ journal, signal: controller.signal });
    const adapter = new CodexAdapter();
    await adapter.run({ ...baseSpec }, ctx);

    expect(abortedWhileRunning).toBe(true);
  });

  it('an already-aborted signal is honoured (the run was cancelled before the turn started)', async () => {
    const journal = new FakeJournal();
    const controller = new AbortController();
    controller.abort();
    let abortedAtCallTime: boolean | undefined;
    codexBehavior = (call: CodexCall) => {
      abortedAtCallTime = (call.turnOptions as { signal?: AbortSignal }).signal?.aborted;
      return okEvents();
    };

    const { ctx } = makeCtx({ journal, signal: controller.signal });
    const adapter = new CodexAdapter();
    await adapter.run({ ...baseSpec }, ctx);

    expect(abortedAtCallTime).toBe(true);
  });
});

// ===============================================================================================
// BRIDGE TEARDOWN — it must TERMINATE, not merely stop accepting
// ===============================================================================================

/** How long run() is given to settle before the test calls it wedged. Well under the 30s file timeout. */
const SETTLE_BUDGET_MS = 3_000;

/**
 * Open a raw TCP connection to the run's MCP bridge and leave a request deliberately unfinished on it.
 *
 * This stands in for ANY peer that still holds a connection with an incomplete request when the turn
 * ends. Who that peer is in production is not established here: the likeliest candidate is the codex
 * child itself, which the teardown only SIGNALS (nothing escalates to a forced kill) and which need
 * not have exited yet. Be exact about what is modelled: the bad bearer token means the bridge answers
 * 401 and the request never reaches `transport.handleRequest`, so this is a REJECTED client, not an
 * authenticated MCP session. That is narrower than the peer set the fix has to survive — but it is
 * the same server state, and the state is what `server.close()` waits on.
 *
 * The 401 read back is the synchronisation point: the bridge only answers a request it has accepted,
 * so receiving it proves the server counts this connection. The announced-but-unsent body keeps the
 * request in flight, which is precisely what `server.close()`'s completion callback waits for. Both
 * are returned so the caller can assert the arrangement actually happened.
 */
async function holdBridgeConnection(call: CodexCall): Promise<{ socket: Socket; status: string }> {
  const cfg = call.options.config as
    | { mcp_servers?: Record<string, { url?: string }> }
    | undefined;
  const url = cfg?.mcp_servers?.rayspec?.url;
  if (!url) throw new Error('no MCP server url in codex config');
  const { hostname, port } = new URL(url);
  const socket = connect(Number(port), hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(
    'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer not-the-token\r\nContent-Length: 32\r\n\r\n',
  );
  const status = await new Promise<string>((resolve, reject) => {
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8').split('\r\n')[0] ?? ''));
    socket.once('error', reject);
  });
  return { socket, status };
}

describe('Codex adapter: the MCP bridge teardown TERMINATES', () => {
  it('run() SETTLES when a connection to the bridge outlives the turn', async () => {
    const journal = new FakeJournal();
    let holder: Socket | undefined;
    let heldStatus: string | undefined;
    let openWhenTurnEnded: boolean | undefined;
    codexBehavior = async function* (call: CodexCall) {
      const held = await holdBridgeConnection(call);
      holder = held.socket;
      heldStatus = held.status;
      yield { type: 'turn.started' };
      yield { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } };
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      };
      // Runs when the adapter's `for await` asks for the next value, i.e. as the turn ends and just
      // before the teardown — so this records whether the connection was still open at the moment
      // `bridge.close()` was about to run. Without it the test could not tell a held connection from
      // one the peer had already dropped.
      openWhenTurnEnded = held.socket.destroyed === false;
    };

    const { ctx } = makeCtx({ journal, tools: [weatherTool()] });
    const adapter = new CodexAdapter();
    // The property under test is that run() SETTLES. Asserting that the port refuses connections
    // afterwards would prove nothing: `close()` stops ACCEPTING immediately, so that holds in the
    // wedged state too — while run() never resolves and the bridge plus its async work stay alive
    // behind a caller the platform has already stopped waiting on.
    const run = adapter.run({ ...baseSpec, tools: [weatherTool().spec] }, ctx);
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        run.then(() => 'settled' as const),
        new Promise<'still pending'>((resolve) => {
          timer = setTimeout(() => resolve('still pending'), SETTLE_BUDGET_MS);
        }),
      ]);
      expect(outcome).toBe('settled');
      // The ARRANGEMENT must have happened. `holdBridgeConnection` runs inside the generator the
      // adapter consumes, so every way it can fail (the config key drifting, connect erroring, the
      // bridge no longer answering) throws INTO run(), which catches it, tears the bridge down with
      // no connection held and settles — leaving `outcome` trivially 'settled'. These four make that
      // vacuous pass impossible: a connection was opened, the server accepted and answered it, it was
      // still open when the turn ended, and the run itself completed rather than erroring.
      expect(holder).toBeDefined();
      expect(heldStatus).toBe('HTTP/1.1 401 Unauthorized');
      expect(openWhenTurnEnded).toBe(true);
      expect((await run).status).toBe('completed');
    } finally {
      if (timer) clearTimeout(timer);
      // Release the holder either way so a failing run cannot leave the suite hanging on it.
      holder?.destroy();
      await run;
    }
  });
});

// ===============================================================================================
// NO SIGNAL ⇒ UNCHANGED (#144)
// ===============================================================================================
// Scope, stated plainly: both tests below run a TOOLLESS spec, and the bridge only exists when
// `spec.tools.length > 0` — so they pin the SDK bags, the neutral result and the journal step on the
// unsignalled path, and they do NOT reach the changed teardown line at all. The unchanged-teardown
// evidence on the unsignalled path comes from the pre-existing tooled tests in this file (the MCP
// handler / dispatch test, the 413 body-cap test and the bridge-init-failure test), each of which
// runs a real bridge teardown without a signal.
describe('Codex adapter: with no cancellation signal the run is exactly what it always was', () => {
  const okEvents = async function* () {
    yield { type: 'turn.started' };
    yield { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } };
    yield {
      type: 'turn.completed',
      usage: {
        input_tokens: 7,
        cached_input_tokens: 0,
        output_tokens: 3,
        reasoning_output_tokens: 0,
      },
    };
  };

  it('UNSET: the bags handed to the SDK are EXACTLY the ones they always were', async () => {
    const journal = new FakeJournal();
    let abortedAtCallTime: boolean | undefined;
    codexBehavior = (call: CodexCall) => {
      abortedAtCallTime = (call.turnOptions as { signal?: AbortSignal }).signal?.aborted;
      return okEvents();
    };
    const { ctx } = makeCtx({ journal });
    expect(ctx.signal).toBeUndefined();

    await new CodexAdapter().run({ ...baseSpec }, ctx);

    const call = codexCalls[0];
    // CodexOptions: a toolless run carries the curated env and NOTHING else — no `config` (there is no
    // bridge to point codex at) and no `codexPathOverride`.
    expect(Object.keys(call?.options ?? {}).sort()).toEqual(['env']);
    // ThreadOptions: the sandbox confinement, unchanged, key set and values.
    expect(call?.threadOptions).toEqual({
      model: 'gpt-5.5',
      sandboxMode: 'read-only',
      networkAccessEnabled: false,
      webSearchEnabled: false,
      approvalPolicy: 'never',
      workingDirectory: expect.any(String),
      skipGitRepoCheck: true,
    });
    // TurnOptions: `signal` is the adapter's OWN controller and is handed over UNCONDITIONALLY — it
    // has been on this bag since before cancellation existed, so unlike the openai adapter's
    // conditional bag no key appears or disappears with ctx.signal. What must hold on the unset path
    // is that the handed signal is live for the whole turn: nothing links an outside abort into it.
    expect(Object.keys(call?.turnOptions ?? {}).sort()).toEqual(['signal']);
    expect(call?.turnOptions.signal).toBeInstanceOf(AbortSignal);
    expect(abortedAtCallTime).toBe(false);
    expect((call?.turnOptions.signal as AbortSignal).aborted).toBe(true); // only the teardown aborts it
  });

  it('UNSET: the RunResult and the neutral event sequence are EXACTLY what they always were', async () => {
    const journal = new FakeJournal();
    codexBehavior = () => okEvents();
    const { ctx, events } = makeCtx({ journal });

    const res = await new CodexAdapter().run({ ...baseSpec }, ctx);

    // The whole neutral result, pinned by value. RunResult carries no wall-clock field, so comparing
    // it exactly is stable (the llm StepReport's `latencyMs` is why the journal record below is NOT
    // deep-equalled — that assertion would flake by construction).
    expect(res).toEqual({
      runId: 'run-codex-test',
      backend: 'codex',
      authMode: 'codex-subscription-oauth',
      status: 'completed',
      finalText: 'ok',
      output: null,
      error: null,
      errorClass: null,
      conversation: [
        { role: 'system', index: 0, parts: [{ kind: 'text', text: 'You are concise.' }] },
        { role: 'user', index: 1, parts: [{ kind: 'text', text: 'Say ok.' }] },
        { role: 'assistant', index: 2, parts: [{ kind: 'text', text: 'ok' }] },
      ],
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      // costUsd(spec.model, 7, 3) against the shared pricing registry.
      costUsd: 0.00003875,
      stepCount: 1,
    });

    // Exactly one llm journal step, with the shape it always had (every field except the wall clock).
    expect(journal.records).toHaveLength(1);
    const step = journal.records[0];
    expect(Object.keys(step ?? {}).sort()).toEqual(
      [
        'authMode',
        'costUsd',
        'idempotencyKey',
        'inputHash',
        'latencyMs',
        'model',
        'output',
        'producedBy',
        'status',
        'type',
        'usage',
      ].sort(),
    );
    expect(step?.type).toBe('llm');
    expect(step?.status).toBe('ok');
    expect(step?.model).toBe('gpt-5.5');
    expect(step?.output).toEqual({ finalText: 'ok', output: null, reasoningCount: 0 });
    expect(step?.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    expect(typeof step?.latencyMs).toBe('number');

    // The neutral event stream, pinned exactly (seq is run-core's single authority, stamped by makeCtx).
    expect(events).toEqual([
      { type: 'run_started', runId: 'run-codex-test', seq: 0 },
      { type: 'text_delta', runId: 'run-codex-test', text: 'ok', seq: 1 },
      {
        type: 'run_completed',
        runId: 'run-codex-test',
        status: 'ok',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        seq: 2,
      },
    ]);
  });
});
