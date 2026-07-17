/**
 * Pi adapter CONTRACT test — no network.
 *
 * The Pi SDK (createAgentSession / getModel / defineTool) is mocked so the adapter's REAL control
 * flow runs against a fake in-memory session and a fake JournalSink. Asserts:
 *   - the replay contract run-core relies on (lookup BEFORE any live session; cache HIT short-circuits;
 *     cache MISS journals a REAL per-step ledger with authMode 'api-key');
 *   - the REAL conversation re-derivation from session.messages (text + correlated tool_call/
 *     tool_result by Pi's real toolCallId);
 *   - tools route through ctx.dispatchTool (the host-tool execute bridge; adapter holds no handler).
 *
 * The Pi SDK never touches the network here.
 */
import type {
  AuthMode,
  ConvTurn,
  JournalSink,
  NeutralTool,
  RunContext,
  StepReport,
} from '@rayspec/core';
import { makeDispatchTool } from '@rayspec/platform';
import { Compile } from 'typebox/compile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mock the Pi SDK surface the adapter imports (no real session, no network) --------
const createAgentSession = vi.fn();
const setRuntimeApiKey = vi.fn();

vi.mock('@earendil-works/pi-ai', () => ({
  getModel: vi.fn(() => ({ id: 'gpt-4.1-mini' })),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  // The adapter uses AuthStorage.inMemory() (no ~/.pi file I/O), not .create().
  AuthStorage: { inMemory: () => ({ setRuntimeApiKey }) },
  ModelRegistry: { inMemory: () => ({}) },
  SessionManager: { inMemory: () => ({}) },
  // defineTool is identity-ish: it returns the tool definition (with the execute closure intact) so
  // the adapter's REAL host-tool bridge can be invoked by our fake session below.
  defineTool: (def: unknown) => def,
  createAgentSession: (...args: unknown[]) => createAgentSession(...args),
}));

// Import AFTER the mocks are registered.
const { PiAdapter, piToolParameters } = await import('./index.js');

interface Recorded extends StepReport {
  authMode: string;
}

/** A fake JournalSink keyed by the EXACT idempotencyKey (mirrors the real per-step lookup). */
function makeFakeJournal(seed?: { key: string; output: unknown }) {
  const recorded: Recorded[] = [];
  const lookupCalls: string[] = [];
  let lookupAt = -1;
  if (seed) {
    recorded.push({
      type: 'llm',
      idempotencyKey: seed.key,
      inputHash: 'seed',
      output: seed.output,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      status: 'ok',
      authMode: 'api-key',
    });
  }
  const journal: JournalSink = {
    async lookup(key: string) {
      lookupCalls.push(key);
      lookupAt = createAgentSession.mock.calls.length;
      const hit = recorded.find((r) => r.idempotencyKey === key && r.status === 'ok');
      return hit ? { output: hit.output } : null;
    },
    async lookupToolCache() {
      return null;
    },
    async record(step) {
      recorded.push(step as Recorded);
      return `step-${recorded.length}`;
    },
  };
  return {
    journal,
    recorded,
    lookupCalls,
    sessionsBeforeLookup: () => lookupAt,
  };
}

function makeCtx(
  journal: JournalSink,
  opts: {
    replay?: boolean;
    tools?: NeutralTool[];
    rehydrate?: () => Promise<ConvTurn[]>;
  } = {},
): RunContext {
  const runId = 'run-1';
  const authMode: AuthMode = 'api-key';
  const tools = opts.tools ?? [];
  const dispatchTool =
    tools.length > 0
      ? makeDispatchTool({
          runId,
          tenantId: 'tenant-1',
          journal,
          tools,
          replay: Boolean(opts.replay),
          authMode,
        })
      : undefined;
  return {
    runId,
    tenantId: 'tenant-1',
    journal,
    replay: Boolean(opts.replay),
    authMode,
    tools,
    dispatchTool,
    rehydrate: opts.rehydrate,
  };
}

const spec = {
  name: 'extract',
  instructions: 'extract fields',
  model: 'gpt-4.1-mini',
  input: 'a transcript',
  tools: [],
  outputSchema: { name: 'r', schema: { type: 'object', properties: {} } },
  maxTurns: 8,
};

/** A fake Pi session returning a deterministic assistant message + usage. */
function fakeSession(messages: unknown[], onSubscribe?: (listener: (e: unknown) => void) => void) {
  return {
    subscribe: (listener: (e: unknown) => void) => {
      onSubscribe?.(listener);
      return () => {};
    },
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    messages,
  };
}

const defaultMessages = [
  {
    role: 'assistant',
    content: [{ type: 'text', text: '{"launch_date":"July 15th"}' }],
    usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.0003 } },
  },
];

beforeEach(() => {
  createAgentSession.mockReset();
  setRuntimeApiKey.mockReset();
  createAgentSession.mockResolvedValue({ session: fakeSession(defaultMessages) });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Pi adapter replay contract', () => {
  it('on replay calls journal.lookup BEFORE any live session is created', async () => {
    const fake = makeFakeJournal(); // cache MISS
    const adapter = new PiAdapter({ apiKey: 'sk-test' });
    await adapter.run(spec as never, makeCtx(fake.journal, { replay: true }));

    expect(fake.lookupCalls.length).toBeGreaterThanOrEqual(1);
    // lookup() ran with ZERO sessions created so far (lookup precedes the live call).
    expect(fake.sessionsBeforeLookup()).toBe(0);
  });

  it('cache HIT returns cached output and does NOT create a session (no model re-call)', async () => {
    // The FINAL llm step (turn 0) must be seeded under the REAL key the adapter probes (a hash of
    // name+input+model). Discover that key via a probe MISS run, then re-seed under it.
    const adapter = new PiAdapter({ apiKey: 'sk-test' });
    const probe = makeFakeJournal();
    await adapter.run(spec as never, makeCtx(probe.journal, { replay: true }));
    const realKey0 = probe.lookupCalls[0];
    expect(realKey0).toMatch(/^llm:.*:0$/);

    const seeded = makeFakeJournal({
      key: realKey0 as string,
      output: { finalText: 'cached!', output: { launch_date: 'cached' }, turnCount: 1 },
    });
    createAgentSession.mockClear();
    const res = await adapter.run(spec as never, makeCtx(seeded.journal, { replay: true }));

    expect(createAgentSession).not.toHaveBeenCalled(); // model NOT re-called
    expect(res.finalText).toBe('cached!');
    expect(res.status).toBe('completed');
    // A replay hit records no new step.
    expect(seeded.recorded.filter((r) => r.idempotencyKey !== realKey0)).toHaveLength(0);
  });

  it('cache MISS journals a REAL per-step ledger (one llm step per assistant message) authMode api-key', async () => {
    const fake = makeFakeJournal(); // MISS
    const adapter = new PiAdapter({ apiKey: 'sk-test' });
    const res = await adapter.run(spec as never, makeCtx(fake.journal, { replay: true }));

    expect(createAgentSession).toHaveBeenCalledTimes(1); // fell through to live
    const llm = fake.recorded.filter((r) => r.type === 'llm');
    expect(llm).toHaveLength(1); // one assistant message -> one llm step
    expect(llm[0]?.status).toBe('ok');
    expect(llm[0]?.authMode).toBe('api-key');
    // REAL per-step usage from the message (not a hard-coded zero).
    expect(llm[0]?.usage.inputTokens).toBe(100);
    expect(llm[0]?.usage.outputTokens).toBe(20);
    expect(res.authMode).toBe('api-key');
    expect(res.usage.inputTokens).toBe(100);
  });

  it('a non-replay live run journals the per-step ledger and never looks up', async () => {
    const fake = makeFakeJournal();
    const adapter = new PiAdapter({ apiKey: 'sk-test' });
    await adapter.run(spec as never, makeCtx(fake.journal, { replay: false }));

    expect(fake.lookupCalls).toHaveLength(0); // no replay => no lookup
    expect(fake.recorded.filter((r) => r.type === 'llm')).toHaveLength(1);
    expect(fake.recorded[0]?.authMode).toBe('api-key');
  });
});

describe('Pi adapter real conversation re-derivation', () => {
  it('derives correlated tool_call/tool_result parts by Pi real toolCallId + system from trusted instructions', async () => {
    // A multi-turn message history: assistant tool_call -> toolResult -> assistant final text.
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'pi_call_1', name: 'get_weather', arguments: { city: 'Berlin' } },
        ],
        usage: { input: 50, output: 10, totalTokens: 60, cost: { total: 0.0001 } },
      },
      {
        role: 'toolResult',
        toolCallId: 'pi_call_1',
        toolName: 'get_weather',
        content: [{ type: 'text', text: '{"tempC":18}' }],
        isError: false,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'It is 18C in Berlin.' }],
        usage: { input: 70, output: 12, totalTokens: 82, cost: { total: 0.0002 } },
      },
    ];
    createAgentSession.mockResolvedValue({ session: fakeSession(messages) });

    const fake = makeFakeJournal();
    const adapter = new PiAdapter({ apiKey: 'sk-test' });
    const res = await adapter.run(
      { ...spec, outputSchema: undefined } as never,
      makeCtx(fake.journal),
    );

    // System turn = TRUSTED instructions (the untrusted-content boundary), not stream content.
    expect(res.conversation[0]?.role).toBe('system');
    expect(res.conversation[0]?.parts).toEqual([{ kind: 'text', text: 'extract fields' }]);

    const parts = res.conversation.flatMap((t) => t.parts);
    const callPart = parts.find((p) => p.kind === 'tool_call');
    const resultPart = parts.find((p) => p.kind === 'tool_result');
    expect(callPart?.kind).toBe('tool_call');
    expect(resultPart?.kind).toBe('tool_result');
    if (callPart?.kind === 'tool_call' && resultPart?.kind === 'tool_result') {
      // Correlated by Pi's REAL toolCallId.
      expect(callPart.toolCallId).toBe('pi_call_1');
      expect(resultPart.toolCallId).toBe('pi_call_1');
      expect(callPart.name).toBe('get_weather');
    }
    // Two assistant messages -> two real llm steps (per-step ledger; stepCount > 1).
    expect(fake.recorded.filter((r) => r.type === 'llm')).toHaveLength(2);
    expect(res.stepCount).toBeGreaterThan(1);
  });
});

describe('a terminal upstream failure that prompt() did NOT throw → status=error', () => {
  // EMPIRICAL DETERMINATION (doc-first, pi-agent-core@0.79.9): pi's StreamFn contract
  // (pi-agent-core types.d.ts:7-10) is "Must not throw or return a rejected promise for request/model/
  // runtime failures … Failures must be encoded in the returned stream … and a final AssistantMessage
  // with stopReason 'error' or 'aborted' and errorMessage." Pi RETRIES retryable upstream errors
  // internally (agent-session.d.ts:488) and surfaces a terminal failure via `auto_retry_end
  // {success:false, finalError}` + the terminal AssistantMessage — so a real rate-limit/5xx that
  // retries-then-fails RESOLVES prompt() WITHOUT throwing. Both fail-the-fix tests below feed a fake
  // AgentSession whose prompt() RESOLVES but whose terminal state represents an upstream failure: the
  // PRE-fix adapter (which only inspects the prompt() catch) reports status='completed' (the swallow);
  // the fix promotes it to status='error' with the right neutral class.

  it('MESSAGE-PATH: a terminal AssistantMessage stopReason=error + rate-limit errorMessage → status=error, rate_limited', async () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        usage: { input: 10, output: 0, totalTokens: 10, cost: { total: 0 } },
        // The StreamFn no-throw failure encoding (pi-ai types.d.ts:221-222).
        stopReason: 'error',
        errorMessage: 'HTTP 429: rate limit exceeded after 3 retries',
      },
    ];
    createAgentSession.mockResolvedValue({ session: fakeSession(messages) });

    const fake = makeFakeJournal();
    const adapter = new PiAdapter({ apiKey: 'sk-test' });
    const res = await adapter.run(
      { ...spec, outputSchema: undefined } as never,
      makeCtx(fake.journal),
    );

    // FAIL-THE-FIX: the pre-fix adapter returned 'completed' (swallowed the failure).
    expect(res.status).toBe('error');
    expect(res.errorClass).toBe('rate_limited');
    expect(res.error).toContain('rate limit');
    // The failing llm step is journaled as an error carrying the neutral class.
    const errStep = fake.recorded.find((r) => r.status === 'error');
    expect(errStep).toBeDefined();
    expect((errStep?.output as { errorClass?: string })?.errorClass).toBe('rate_limited');
  });

  it('EVENT-PATH: an auto_retry_end {success:false, finalError} (5xx) fired during the run → status=error, upstream_5xx', async () => {
    // prompt() resolves cleanly; the FAILURE is surfaced ONLY via the auto_retry_end event the SDK
    // forwards to the subscriber (the retries-exhausted path). The terminal message has NO error
    // stopReason — so this exercises the EVENT-path signal independently of the message-path one.
    let listener: ((e: unknown) => void) | undefined;
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0 } },
        // stopReason intentionally NOT 'error' here — only the event carries the failure.
        stopReason: 'stop',
      },
    ];
    createAgentSession.mockImplementation(async () => {
      const session = fakeSession(messages, (l) => {
        listener = l;
      });
      session.prompt = vi.fn().mockImplementation(async () => {
        // The SDK retried a retryable upstream error and finally gave up — forwarded as an event,
        // NOT a throw (StreamFn no-throw contract).
        listener?.({
          type: 'auto_retry_end',
          success: false,
          attempt: 3,
          finalError: 'upstream service unavailable (503) after 3 attempts',
        });
      });
      return { session };
    });

    const fake = makeFakeJournal();
    const adapter = new PiAdapter({ apiKey: 'sk-test' });
    const res = await adapter.run(
      { ...spec, outputSchema: undefined } as never,
      makeCtx(fake.journal),
    );

    // FAIL-THE-FIX: pre-fix this was 'completed' (the event-path failure was ignored).
    expect(res.status).toBe('error');
    expect(res.errorClass).toBe('upstream_5xx');
    expect(res.error).toContain('service unavailable');
  });

  it('NO-FALSE-POSITIVE: a clean completed run (stopReason=stop, no retry-failure event) stays completed', async () => {
    // Guards the fix against over-promotion: a successful run is unchanged (errorClass:null).
    createAgentSession.mockResolvedValue({ session: fakeSession(defaultMessages) });
    const fake = makeFakeJournal();
    const adapter = new PiAdapter({ apiKey: 'sk-test' });
    const res = await adapter.run(spec as never, makeCtx(fake.journal));
    expect(res.status).toBe('completed');
    expect(res.errorClass).toBeNull();
  });
});

describe('Pi adapter tool dispatch through ctx.dispatchTool (untrusted-content chokepoint)', () => {
  it('routes the host-tool execution through the dispatcher (handler invoked once, opaque-wrapped, one tool step)', async () => {
    const calls: unknown[] = [];
    const tool: NeutralTool = {
      spec: {
        name: 'get_weather',
        description: 'weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
      handler: (args: unknown) => {
        calls.push(args);
        return { tempC: 18 };
      },
      timeoutMs: 1000,
      idempotent: true,
    };

    // The fake session, on subscribe, drives the registered customTool's execute closure (simulating
    // Pi's loop calling the tool), then surfaces a final assistant message.
    let registeredTools: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> =
      [];
    createAgentSession.mockImplementation(async (opts: unknown) => {
      registeredTools = ((opts as { customTools?: unknown[] }).customTools ?? []) as never;
      const messages = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.00001 } },
        },
      ];
      const session = fakeSession(messages);
      // Override prompt() to invoke the host-tool execute (the dispatcher path).
      session.prompt = vi.fn().mockImplementation(async () => {
        for (const t of registeredTools) {
          await t.execute('pi_call_X', { city: 'Berlin' });
        }
      });
      return { session };
    });

    const fake = makeFakeJournal();
    const adapter = new PiAdapter({ apiKey: 'sk-test' });
    const res = await adapter.run(
      { ...spec, outputSchema: undefined, tools: [tool.spec] } as never,
      makeCtx(fake.journal, { tools: [tool] }),
    );

    expect(res.status).toBe('completed');
    // The handler ran EXACTLY once, ONLY through the dispatcher.
    expect(calls).toEqual([{ city: 'Berlin' }]);
    // EXACTLY ONE `tool` journal step, recorded by dispatchTool (not the adapter), opaque-wrapped.
    const toolSteps = fake.recorded.filter((r) => r.type === 'tool');
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0]?.status).toBe('ok');
    expect((toolSteps[0]?.output as { kind?: string })?.kind).toBe('tool_data');
    // The tool step's uniqueness key is Pi's REAL toolCallId.
    expect(toolSteps[0]?.idempotencyKey).toBe('pi_call_X');
  });

  it('does NOT double-emit tool events — Pi tool_execution_start/end are dropped; dispatchTool is the single authority', async () => {
    const tool: NeutralTool = {
      spec: {
        name: 'get_weather',
        description: 'weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
      handler: () => ({ tempC: 18 }),
      timeoutMs: 1000,
      idempotent: true,
    };

    // The fake session both (a) drives the dispatchTool path via the customTool execute AND (b) fires
    // Pi's OWN tool_execution_start/end + a text_delta into the subscriber — exactly the real
    // double-source. After that the adapter relays ONLY text_delta; the tool lifecycle comes solely
    // from dispatchTool (one tool_called + one tool_result).
    let listener: ((e: unknown) => void) | undefined;
    let registeredTools: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> =
      [];
    createAgentSession.mockImplementation(async (opts: unknown) => {
      registeredTools = ((opts as { customTools?: unknown[] }).customTools ?? []) as never;
      const messages = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.00001 } },
        },
      ];
      const session = fakeSession(messages, (l) => {
        listener = l;
      });
      session.prompt = vi.fn().mockImplementation(async () => {
        // Pi fires its own tool lifecycle events (the duplicate source) ...
        listener?.({
          type: 'tool_execution_start',
          toolCallId: 'pi_call_X',
          toolName: 'get_weather',
          args: { city: 'Berlin' },
        });
        // ... while the dispatcher path also runs (the single sanctioned tool lifecycle) ...
        for (const t of registeredTools) await t.execute('pi_call_X', { city: 'Berlin' });
        listener?.({
          type: 'tool_execution_end',
          toolCallId: 'pi_call_X',
          toolName: 'get_weather',
          result: { tempC: 18 },
          isError: false,
        });
        // ... and a real text_delta, which MUST still be relayed.
        listener?.({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'done' },
        });
      });
      return { session };
    });

    const events: Array<{ type: string }> = [];
    const fake = makeFakeJournal();
    const ctx = makeCtx(fake.journal, { tools: [tool] });
    // The dispatcher must emit onto the SAME sink the adapter uses, so re-wire both to the collector.
    const onEvent = (e: unknown) => events.push(e as { type: string });
    const dispatchTool = makeDispatchTool({
      runId: 'run-1',
      tenantId: 'tenant-1',
      journal: fake.journal,
      tools: [tool],
      replay: false,
      authMode: 'api-key',
      onEvent,
    });
    const ctx2: RunContext = { ...ctx, onEvent: onEvent as RunContext['onEvent'], dispatchTool };

    const adapter = new PiAdapter({ apiKey: 'sk-test' });
    await adapter.run({ ...spec, outputSchema: undefined, tools: [tool.spec] } as never, ctx2);

    // EXACTLY ONE tool_called and ONE tool_result (from dispatchTool) — no duplicate from Pi's events.
    expect(events.filter((e) => e.type === 'tool_called')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
    // No contradicting/extra tool_error.
    expect(events.filter((e) => e.type === 'tool_error')).toHaveLength(0);
    // The text_delta IS still relayed by forwardEvent (the adapter keeps text_delta).
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
  });
});

/**
 * piToolParameters validate-and-repair.
 *
 * pi-agent-core validates the model's tool args against `tool.parameters` (validateToolArguments ->
 * Compile/Check, verified doc-first in pi-ai/dist/utils/validation.js) BEFORE our execute closure runs.
 * The OLD projection was Type.Object({}, { additionalProperties: true }) (an EMPTY accept-all schema)
 * so nothing was ever rejected → a weak model could churn to MaxTurns on a malformed arg. We compile
 * the SAME TSchema run() now passes to defineTool (piToolParameters → Type.Unsafe(neutral JSON-Schema))
 * via typebox/compile's Compile (exactly what validateToolArguments does) and assert it REJECTS a
 * malformed (incl. NESTED) arg and ACCEPTS a valid one. Over-rejection guard: it is a SUBSET of the
 * neutral contract — it only rejects what dispatchTool's ajv would also reject.
 */
describe('piToolParameters validate-and-repair (mirrors pi-agent-core validateToolArguments)', () => {
  const params = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      action_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            owner: { type: 'string' },
            due_raw: { type: 'string' },
          },
          required: ['description'],
        },
      },
      priority: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['title', 'action_items'],
    additionalProperties: false,
  };

  function compiled() {
    // typebox/compile Compile of the Type.Unsafe-wrapped neutral JSON-Schema — pi has no TypeBox.Kind
    // metadata on it, so this is the EXACT JSON-Schema-object path validateToolArguments takes.
    return Compile(piToolParameters({ name: 't', description: 'd', parameters: params }));
  }

  it('it is NOT the old empty accept-all Type.Object — the neutral JSON-Schema is carried verbatim (EXCEPT unenforced `format` is stripped — FIX 1)', () => {
    const ts = piToolParameters({ name: 't', description: 'd', parameters: params });
    // `params` carries no `format`, so the projection is byte-verbatim here (the structural keywords —
    // type/properties/required/items/enum/additionalProperties — are all retained).
    expect(JSON.parse(JSON.stringify(ts))).toEqual(params);
  });

  // The untrusted-content subset invariant: the model-facing schema must NEVER be
  // STRICTER than dispatchTool's AUTHORITATIVE ajv. dispatchTool uses `new Ajv2020({allErrors:true,
  // strict:false})` with NO ajv-formats registered, so it IGNORES JSON-Schema `format` (annotation-
  // only) and ACCEPTS any string for a `format`-bearing field. TypeBox 1.1.38 (what pi-agent-core's
  // validateToolArguments compiles) ENFORCES `format` (date-time/email/uri/uuid/…), so passing the
  // neutral schema VERBATIM would OVER-reject e.g. a space-separated date that dispatchTool accepts —
  // relocating the very MaxTurns churn this fixes. The fix RECURSIVELY STRIPS `format` so Compile/Check
  // accepts whatever dispatchTool's ajv accepts. Doc-first probe (typebox@1.1.38 Compile.Check vs the
  // exact dispatch.ts ajv config): `format` is the ONLY divergence in the tool-parameter vocabulary.
  describe('FIX 1 — `format` stripped so Pi-Check is a SUBSET of dispatchTool ajv (never stricter)', () => {
    const formatParams = {
      type: 'object',
      properties: {
        scheduled_at: { type: 'string', format: 'date-time' },
        contact: { type: 'string', format: 'email' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { when: { type: 'string', format: 'date-time' } },
            required: ['when'],
          },
        },
      },
      required: ['scheduled_at'],
    };

    function compiledFmt() {
      return Compile(piToolParameters({ name: 't', description: 'd', parameters: formatParams }));
    }

    it('ACCEPTS a non-RFC3339 `format:date-time` value (matching what dispatchTool ajv accepts)', () => {
      // RED on the frozen base (verbatim Type.Unsafe → TypeBox enforces date-time → REJECTS);
      // GREEN after the strip. dispatchTool's ajv (no ajv-formats) ACCEPTS this string.
      expect(compiledFmt().Check({ scheduled_at: '2020-01-01 00:00:00' })).toBe(true);
    });

    it('ACCEPTS an arbitrary string for `format:date-time`/`format:email` (format is unenforced by dispatchTool)', () => {
      expect(compiledFmt().Check({ scheduled_at: 'whenever', contact: 'not-an-email' })).toBe(true);
    });

    it('ACCEPTS a NESTED `format` value the verbatim schema would reject (recursive strip)', () => {
      expect(
        compiledFmt().Check({
          scheduled_at: 'noon',
          items: [{ when: '2020-01-01 00:00:00' }],
        }),
      ).toBe(true);
    });

    it('STILL rejects a structural violation (missing nested required `when`) — only `format` is stripped, not structural keywords', () => {
      // The strip removes ONLY `format` — required/type/items are retained, so this stays REJECTED
      // (matching dispatchTool's ajv, which also rejects the missing required field).
      expect(compiledFmt().Check({ scheduled_at: 'noon', items: [{}] })).toBe(false);
      expect(compiledFmt().Check({})).toBe(false); // missing top-level required `scheduled_at`
    });

    it('the projected schema strips the `format` KEYWORD at every schema position (here: no property is NAMED `format`)', () => {
      // `formatParams` has NO property literally NAMED `format` — every `format` in it is the JSON-Schema
      // KEYWORD (a sibling of `type`). So for THIS schema the projection is `format`-substring-free.
      // (We do NOT assert that the SUBSTRING vanishes in general — a property NAMED `format` MUST
      // survive; see the "property literally named format" describe block below.)
      const ts = piToolParameters({ name: 't', description: 'd', parameters: formatParams });
      const projected = JSON.parse(JSON.stringify(ts)) as {
        properties: Record<string, { format?: unknown }>;
        required?: unknown;
      };
      // The `format` KEYWORD is gone from each property's schema (the annotation sibling of `type`).
      expect(projected.properties.scheduled_at.format).toBeUndefined();
      expect(projected.properties.contact.format).toBeUndefined();
      // ...and from the nested array-item property.
      const items = projected.properties.items as {
        items: { properties: { when: { format?: unknown } } };
      };
      expect(items.items.properties.when.format).toBeUndefined();
      // Structural keywords are retained (subset, not collapse).
      expect(JSON.stringify(ts)).toContain('"required"');
      expect(JSON.stringify(ts)).toContain('"items"');
    });
  });

  // The BLUNT key-strip (delete ANY key === 'format') ALSO deleted
  // a PROPERTY literally NAMED `format` (a key inside a `properties` map). With additionalProperties:false
  // that turned a VALID arg `{format:'json'}` into an undeclared key → Pi-Check FALSE while dispatchTool's
  // ajv (which keeps the declared property) = TRUE — the exact untrusted-content subset OVER-rejection the fix cures,
  // relocated onto the keyword NAME. The schema-aware walk strips `format` ONLY at a schema-keyword
  // position, NEVER a property name. `format` is a very plausible author field name.
  describe('FIX ROUND 2 — a PROPERTY literally named `format` SURVIVES (no over-rejection)', () => {
    const propNamedFormat = {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: { type: 'string', enum: ['json', 'xml'] },
        q: { type: 'string' },
      },
      required: ['q'],
    };

    it('keeps the `format` PROPERTY definition intact (its schema + enum survive)', () => {
      const ts = piToolParameters({ name: 't', description: 'd', parameters: propNamedFormat });
      const projected = JSON.parse(JSON.stringify(ts)) as {
        properties: Record<string, unknown>;
      };
      // The PROPERTY named `format` is still declared, with its full sub-schema (the bug deleted it).
      expect(projected.properties.format).toEqual({ type: 'string', enum: ['json', 'xml'] });
      expect(projected.properties.q).toEqual({ type: 'string' });
    });

    it('ACCEPTS a valid `{q, format:"json"}` (matching dispatchTool ajv) — NO over-rejection', () => {
      // RED on the frozen base: the bug stripped the `format` property while keeping
      // additionalProperties:false, so `{format:'json'}` was an undeclared key → Check FALSE. After the
      // schema-aware walk the property survives → Check TRUE, matching dispatchTool's ajv accept.
      const c = Compile(
        piToolParameters({ name: 't', description: 'd', parameters: propNamedFormat }),
      );
      expect(c.Check({ q: 'hi', format: 'json' })).toBe(true);
      expect(c.Check({ q: 'hi' })).toBe(true); // format optional
    });

    it('STILL enforces the surviving `format` property schema (bad enum rejected; additionalProperties:false rejects a stray key)', () => {
      const c = Compile(
        piToolParameters({ name: 't', description: 'd', parameters: propNamedFormat }),
      );
      expect(c.Check({ q: 'hi', format: 'csv' })).toBe(false); // not in enum
      expect(c.Check({ q: 'hi', stray: 1 })).toBe(false); // additionalProperties:false
      expect(c.Check({ format: 'json' })).toBe(false); // missing required `q`
    });

    it('the `format` KEYWORD form is STILL stripped (a string field with format:date-time accepts any string)', () => {
      // A separate schema where `format` is the KEYWORD (sibling of `type`) — still stripped so Pi-Check
      // accepts whatever ajv (no ajv-formats) accepts. The keyword case is unaffected by the fix.
      const keywordForm = {
        type: 'object',
        properties: { scheduled_at: { type: 'string', format: 'date-time' } },
        required: ['scheduled_at'],
      };
      const c = Compile(piToolParameters({ name: 't', description: 'd', parameters: keywordForm }));
      expect(c.Check({ scheduled_at: '2020-01-01 00:00:00' })).toBe(true); // non-RFC3339 accepted
      const ts = piToolParameters({ name: 't', description: 'd', parameters: keywordForm });
      const projected = JSON.parse(JSON.stringify(ts)) as {
        properties: { scheduled_at: { format?: unknown } };
      };
      expect(projected.properties.scheduled_at.format).toBeUndefined(); // keyword stripped
    });

    it('a `format` keyword and a `format` property TOGETHER: keyword stripped, property kept', () => {
      // A schema mixing both forms: a property NAMED `format` (kept) whose own value carries a `format`
      // KEYWORD annotation (stripped) — the keyword on the property's schema goes, the property stays.
      const mixed = {
        type: 'object',
        additionalProperties: false,
        properties: {
          format: { type: 'string', format: 'date-time' }, // property NAMED format, value has format kw
        },
        required: ['format'],
      };
      const ts = piToolParameters({ name: 't', description: 'd', parameters: mixed });
      const projected = JSON.parse(JSON.stringify(ts)) as {
        properties: { format: { type?: string; format?: unknown } };
      };
      // The PROPERTY `format` survives; the `format` KEYWORD on its value is stripped.
      expect(projected.properties.format).toEqual({ type: 'string' });
      const c = Compile(ts);
      // A non-RFC3339 value for the surviving property is now accepted (keyword stripped) — matches ajv.
      expect(c.Check({ format: '2020-01-01 00:00:00' })).toBe(true);
    });

    // Forcing-function: assert the WHOLE subset invariant — Pi-accept ⊇ ajv-accept —
    // using the REAL authoritative validator as a DIFFERENTIAL ORACLE, not a hand-picked shape. The
    // authoritative validator is dispatchTool's ajv (`new Ajv2020({allErrors:true,strict:false})`, NO
    // ajv-formats). Rather than re-import ajv (not resolvable from this package without a lockfile
    // change), we drive the GENUINE makeDispatchTool (already imported) with `inputSchema = the neutral
    // parameters` and read accept(=tool_data) vs reject(=tool_error). For every value the AUTHORITATIVE
    // dispatchTool ACCEPTS, the model-facing Pi `Compile(piToolParameters(parameters)).Check` MUST also
    // accept (Pi never rejects what dispatchTool accepts). This would catch the property-named-`format`
    // over-rejection GENERICALLY (it was an ajv-accept / Pi-reject pair).
    it('DIFFERENTIAL ORACLE: Pi-accept ⊇ dispatchTool-accept over a probe matrix (the WHOLE subset invariant)', async () => {
      const fmtProp = {
        type: 'object',
        additionalProperties: false,
        properties: { format: { type: 'string', enum: ['json', 'xml'] }, q: { type: 'string' } },
        required: ['q'],
      };
      const fmtKw = {
        type: 'object',
        properties: { scheduled_at: { type: 'string', format: 'date-time' } },
        required: ['scheduled_at'],
      };
      const nested = {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          meta: {
            type: 'object',
            properties: {
              // a property NAMED `format` AND a `format` KEYWORD on a sibling, nested one level down.
              format: { type: 'string' },
              when: { type: 'string', format: 'date-time' },
            },
            required: ['format'],
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { description: { type: 'string' } },
              required: ['description'],
            },
          },
        },
        required: ['count', 'meta'],
      };

      const matrix: Array<{ schema: Record<string, unknown>; values: unknown[] }> = [
        {
          schema: fmtProp,
          values: [
            { q: 'hi', format: 'json' }, // ajv-accept -> Pi MUST accept (the regression case)
            { q: 'hi' },
            { q: 'hi', format: 'bad' }, // ajv-reject (bad enum)
            { q: 'hi', stray: 1 }, // ajv-reject (additionalProperties:false)
          ],
        },
        {
          schema: fmtKw,
          values: [
            { scheduled_at: '2020-01-01 00:00:00' }, // ajv-accept (no ajv-formats) -> Pi MUST accept
            { scheduled_at: 'whenever' },
            {}, // ajv-reject (missing required)
          ],
        },
        {
          schema: nested,
          values: [
            {
              count: 9007199254740991, // a large integer (Number.MAX_SAFE_INTEGER) — both accept
              meta: { format: 'csv', when: '2020-01-01 00:00:00' },
              items: [{ description: 'd' }],
            },
            { count: 1, meta: { when: 'noon' } }, // ajv-reject (missing nested required `format`)
            { count: 1, meta: { format: 'x' }, items: [{}] }, // ajv-reject (nested item missing req)
          ],
        },
      ];

      // A no-op journal: we only read the dispatch RESULT kind (accept/reject), never its side effects.
      const oracleJournal: JournalSink = {
        async lookup() {
          return null;
        },
        async lookupToolCache() {
          return null;
        },
        async record() {
          return 'oracle-step';
        },
      };

      let id = 0;
      for (const { schema, values } of matrix) {
        const pi = Compile(piToolParameters({ name: 't', description: 'd', parameters: schema }));
        // The authoritative validator: the REAL dispatchTool with inputSchema = the neutral schema.
        const oracle = makeDispatchTool({
          runId: 'oracle',
          tenantId: 'tenant-1',
          journal: oracleJournal,
          tools: [
            {
              spec: { name: 'probe', description: 'd', parameters: schema },
              handler: () => ({ ok: true }),
              inputSchema: schema,
              timeoutMs: 1000,
              idempotent: true,
            },
          ],
          replay: false,
          authMode: 'api-key',
        });
        for (const v of values) {
          // eslint-disable-next-line no-await-in-loop -- a tiny deterministic probe matrix
          const res = await oracle('probe', v, `oracle-call-${id++}`);
          const ajvAccepts = res.kind === 'tool_data';
          const piAccepts = pi.Check(v);
          // SUBSET invariant: every value dispatchTool ACCEPTS, Pi must also accept (never stricter).
          if (ajvAccepts) {
            expect(piAccepts, `Pi over-rejects an ajv-accepted value: ${JSON.stringify(v)}`).toBe(
              true,
            );
          }
        }
      }
    });
  });

  it('ACCEPTS a valid (deeply-nested) tool arg', () => {
    expect(
      compiled().Check({
        title: 'Weekly sync',
        action_items: [{ description: 'ship the release notes', owner: 'phil', due_raw: 'Friday' }],
        priority: 'high',
      }),
    ).toBe(true);
  });

  it('REJECTS a malformed nested arg (action_items entry missing required `description`)', () => {
    expect(compiled().Check({ title: 'Weekly sync', action_items: [{ owner: 'phil' }] })).toBe(
      false,
    );
  });

  it('REJECTS a wrong-typed field (action_items is a string) and a missing top-level required', () => {
    const c = compiled();
    expect(c.Check({ title: 'x', action_items: 'not-an-array' })).toBe(false);
    expect(c.Check({ action_items: [{ description: 'd' }] })).toBe(false); // missing `title`
  });

  it('REJECTS a bad enum value (priority not in low|medium|high)', () => {
    expect(
      compiled().Check({ title: 'x', action_items: [{ description: 'd' }], priority: 'urgent' }),
    ).toBe(false);
  });

  it('over-rejection guard: an extra undeclared key is rejected ONLY because the NEUTRAL schema declares additionalProperties:false (subset of dispatchTool, never stricter)', () => {
    // additionalProperties:false here mirrors the neutral contract → dispatchTool's ajv rejects it too.
    expect(compiled().Check({ title: 'x', action_items: [{ description: 'd' }], stray: 1 })).toBe(
      false,
    );
    // And when the neutral schema OMITS additionalProperties (open), the extra key is ACCEPTED (we never
    // inject a stricter constraint than the neutral schema declared).
    const open = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    const cOpen = Compile(piToolParameters({ name: 't', description: 'd', parameters: open }));
    expect(cOpen.Check({ title: 'x', extra: 'ok' })).toBe(true);
  });
});
