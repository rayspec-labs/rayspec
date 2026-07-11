import { describe, expect, it } from 'vitest';
import { hashJson, stableStringify } from './hash.js';
import {
  AgentSpec,
  assertRunResultKeyPresence,
  assertSpecValid,
  ConvPart,
  ConvTurn,
  makeEventIngest,
  NeutralEvent,
  OutputSchemaSpec,
  RunResult,
  Usage,
  validateConversation,
  validateSpec,
} from './neutral.js';
import { costUsd, priceFor } from './pricing.js';

describe('AgentSpec', () => {
  it('applies defaults (tools, maxTurns)', () => {
    const spec = AgentSpec.parse({
      name: 'extract',
      instructions: 'Extract fields.',
      model: 'gpt-4.1-mini',
      input: 'hello',
    });
    expect(spec.tools).toEqual([]);
    expect(spec.maxTurns).toBe(8);
  });
});

describe('OutputSchemaSpec (fail-closed wrapper)', () => {
  it('accepts the exact {name, schema} wrapper', () => {
    expect(OutputSchemaSpec.safeParse({ name: 'Out', schema: { type: 'object' } }).success).toBe(
      true,
    );
  });

  it('REJECTS a stray/typo sibling key (.strict() — not silently dropped)', () => {
    // Without .strict() this parses ok and silently drops `schemaa`; with it, fail-closed.
    expect(
      OutputSchemaSpec.safeParse({ name: 'Out', schema: { type: 'object' }, schemaa: 'oops' })
        .success,
    ).toBe(false);
  });
});

describe('RunResult', () => {
  it('validates a minimal completed result with ConvTurn[] + always-present output/error', () => {
    const r = RunResult.parse({
      runId: 'r1',
      backend: 'openai',
      authMode: 'api-key',
      status: 'completed',
      finalText: 'done',
      output: null,
      error: null,
      // errorClass is always-present (null on success).
      errorClass: null,
      conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'done' }] }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      costUsd: 0.0001,
      stepCount: 1,
    });
    expect(r.backend).toBe('openai');
    expect(r.output).toBeNull();
    expect(r.error).toBeNull();
    expect(r.errorClass).toBeNull();
  });

  it('accepts a neutral errorClass on an error result, and REJECTS an unknown class value', () => {
    const ok = RunResult.safeParse({
      runId: 'r1',
      backend: 'openai',
      authMode: 'api-key',
      status: 'error',
      finalText: '',
      output: null,
      error: '429 rate limited',
      errorClass: 'rate_limited',
      conversation: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      stepCount: 1,
    });
    expect(ok.success).toBe(true);
    // A value outside the neutral enum is rejected (fail-closed — no backend-specific class leaks in).
    const bad = RunResult.safeParse({
      runId: 'r1',
      backend: 'openai',
      authMode: 'api-key',
      status: 'error',
      finalText: '',
      output: null,
      error: 'x',
      errorClass: 'not_a_neutral_class',
      conversation: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      stepCount: 1,
    });
    expect(bad.success).toBe(false);
  });

  it('REJECTS a result that omits the always-present `errorClass` key (key-presence)', () => {
    const parsed = RunResult.safeParse({
      runId: 'r1',
      backend: 'openai',
      authMode: 'api-key',
      status: 'completed',
      finalText: 'done',
      output: null,
      error: null,
      // errorClass omitted
      conversation: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      stepCount: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a result that omits the always-present `error` key (key-presence)', () => {
    const parsed = RunResult.safeParse({
      runId: 'r1',
      backend: 'openai',
      authMode: 'api-key',
      status: 'completed',
      finalText: 'done',
      output: null,
      // error omitted
      conversation: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      stepCount: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('assertRunResultKeyPresence throws when `output` key is omitted', () => {
    const noOutput = {
      runId: 'r1',
      backend: 'openai',
      authMode: 'api-key',
      status: 'completed',
      finalText: 'done',
      error: null,
      conversation: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      stepCount: 0,
    } as unknown as RunResult;
    expect(() => assertRunResultKeyPresence(noOutput)).toThrow(/output/);
  });

  it('assertRunResultKeyPresence throws when `errorClass` key is omitted', () => {
    const noClass = {
      runId: 'r1',
      backend: 'openai',
      authMode: 'api-key',
      status: 'completed',
      finalText: 'done',
      output: null,
      error: null,
      // errorClass omitted
      conversation: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      stepCount: 0,
    } as unknown as RunResult;
    expect(() => assertRunResultKeyPresence(noClass)).toThrow(/errorClass/);
  });
});

describe('Usage (extended)', () => {
  it('accepts the optional cache + reasoning token fields', () => {
    const u = Usage.parse({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 80,
      cacheCreationTokens: 20,
      reasoningTokens: 10,
    });
    expect(u.cacheReadTokens).toBe(80);
    expect(u.cacheCreationTokens).toBe(20);
    expect(u.reasoningTokens).toBe(10);
  });

  it('still accepts the plain 3-field shape (additive/optional)', () => {
    const u = Usage.parse({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    expect(u.cacheReadTokens).toBeUndefined();
  });

  it('rejects a negative cache token count', () => {
    expect(
      Usage.safeParse({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: -1 })
        .success,
    ).toBe(false);
  });
});

describe('ConvPart / ConvTurn', () => {
  it('pairs a tool_call and tool_result by toolCallId', () => {
    const call = ConvPart.parse({
      kind: 'tool_call',
      toolCallId: 'tc-1',
      name: 'lookup',
      args: { id: 7 },
    });
    const result = ConvPart.parse({
      kind: 'tool_result',
      toolCallId: 'tc-1',
      name: 'lookup',
      result: { ok: true },
    });
    expect(call.kind).toBe('tool_call');
    expect(result.kind).toBe('tool_result');
    if (call.kind === 'tool_call' && result.kind === 'tool_result') {
      expect(call.toolCallId).toBe(result.toolCallId);
    }
  });

  it('rejects a tool_call with no toolCallId', () => {
    expect(ConvPart.safeParse({ kind: 'tool_call', name: 'x', args: {} }).success).toBe(false);
  });

  it('validates a multi-part assistant turn', () => {
    const turn = ConvTurn.parse({
      role: 'assistant',
      index: 1,
      parts: [
        { kind: 'reasoning', text: 'thinking' },
        { kind: 'tool_call', toolCallId: 'tc-9', name: 'f', args: {} },
      ],
    });
    expect(turn.parts).toHaveLength(2);
  });
});

describe('validateConversation (security read-path validator)', () => {
  it('rejects a malformed jsonb payload — DROPS poisoned turns/parts, never trusts them', () => {
    // An ATTACKER-CONTROLLED payload: a non-array, a turn with a bad role, a turn whose only
    // part is malformed, and one genuinely-valid turn. Only the valid turn survives.
    const poisoned = [
      { role: 'evil', index: 0, parts: [{ kind: 'text', text: 'x' }] }, // bad role -> dropped
      { role: 'assistant', index: 1, parts: [{ kind: 'tool_call', name: 'no-id' }] }, // bad part, 0 survive -> dropped
      { role: 'user', index: 2, parts: [{ kind: 'text', text: 'hi' }] }, // valid -> kept
      'not-an-object', // dropped
      { role: 'assistant', index: -3, parts: [{ kind: 'text', text: 'neg index' }] }, // bad index -> dropped
    ];
    const turns = validateConversation(poisoned);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe('user');
    expect(turns[0]?.parts[0]).toEqual({ kind: 'text', text: 'hi' });
  });

  it('returns [] for a non-array payload (never throws on attacker input)', () => {
    expect(validateConversation('💀')).toEqual([]);
    expect(validateConversation(null)).toEqual([]);
    expect(validateConversation({ role: 'user' })).toEqual([]);
  });

  it('drops only the poisoned part within an otherwise-valid turn', () => {
    const mixed = [
      {
        role: 'assistant',
        index: 0,
        parts: [
          { kind: 'text', text: 'kept' },
          { kind: 'tool_result', name: 'no-id' }, // missing toolCallId -> dropped
        ],
      },
    ];
    const turns = validateConversation(mixed);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.parts).toEqual([{ kind: 'text', text: 'kept' }]);
  });
});

describe('validateSpec (fail-closed capability descriptor)', () => {
  const specWithOutput = AgentSpec.parse({
    name: 'extract',
    instructions: 'Extract.',
    model: 'm',
    input: 'x',
    outputSchema: { name: 'Out', schema: { type: 'object' } },
  });

  it('accepts a native-structured-output spec for openai + anthropic, REJECTS pi when native is demanded', () => {
    expect(validateSpec(specWithOutput, 'openai', { requireNativeStructuredOutput: true }).ok).toBe(
      true,
    );
    expect(
      validateSpec(specWithOutput, 'anthropic', { requireNativeStructuredOutput: true }).ok,
    ).toBe(true);
    const pi = validateSpec(specWithOutput, 'pi', { requireNativeStructuredOutput: true });
    expect(pi.ok).toBe(false);
    if (!pi.ok) expect(pi.violations[0]?.capability).toBe('nativeStructuredOutput');
  });

  it('accepts an outputSchema spec on pi when native is NOT demanded (Pi emulates — the lone exception)', () => {
    expect(validateSpec(specWithOutput, 'pi').ok).toBe(true);
  });

  it('assertSpecValid throws (fail-closed) for pi + native demand', () => {
    expect(() =>
      assertSpecValid(specWithOutput, 'pi', { requireNativeStructuredOutput: true }),
    ).toThrow(/fail-closed/);
  });
});

describe('NeutralEvent v2 + makeEventIngest (platform-assigned seq)', () => {
  it('stamps a monotonic per-run seq at ingest (Pi has no SDK correlation id)', () => {
    const ingest = makeEventIngest();
    const e0 = ingest({ type: 'run_started', runId: 'r1' });
    const e1 = ingest({ type: 'text_delta', runId: 'r1', text: 'hi' });
    const e2 = ingest({
      type: 'run_completed',
      runId: 'r1',
      status: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    // Every event carries runId + seq and validates against the v2 schema.
    expect(NeutralEvent.parse(e0).type).toBe('run_started');
    expect(NeutralEvent.parse(e2)).toMatchObject({ type: 'run_completed', status: 'ok' });
  });

  it('validates a tool_error event', () => {
    const ev = NeutralEvent.parse({
      type: 'tool_error',
      runId: 'r1',
      seq: 5,
      toolCallId: 'tc-1',
      name: 'charge_card',
      message: 'non-idempotent tool cannot be replayed',
    });
    expect(ev.type).toBe('tool_error');
  });
});

describe('hash', () => {
  it('is stable regardless of key order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
  });
});

describe('pricing', () => {
  it('matches dated model suffixes by prefix', () => {
    expect(priceFor('gpt-4.1-mini-2025-04-14')).toEqual(priceFor('gpt-4.1-mini'));
  });
  it('produces non-zero cost', () => {
    expect(costUsd('gpt-4.1-mini', 1000, 1000)).toBeGreaterThan(0);
  });
});
