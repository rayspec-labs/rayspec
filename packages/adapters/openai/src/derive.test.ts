/**
 * Deterministic deriveConversation + per-step-usage tests, run against a REAL captured SDK shape.
 *
 * The fixture `__fixtures__/openai-tool-run.json` was captured from a LIVE @openai/agents 0.11.8
 * run (a multi-turn tool call) via scripts/capture-fixture.mts — so these assertions encode the
 * TRUE SDK history/usage contract, not an imagined one (a blind test is not proof). An SDK
 * bump that moves the wire shape breaks here loudly + the fixture must be re-recorded (the
 * version-bump-re-record rule enforces this).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec } from '@rayspec/core';
import { validateConversation } from '@rayspec/core';
import { describe, expect, it } from 'vitest';
import { deriveConversation } from './index.js';

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
  rawResponses: Array<{
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  }>;
  stateUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
};

const spec: AgentSpec = {
  name: 'weather-agent',
  instructions: fixture.instructions,
  model: 'gpt-4.1-mini',
  input: fixture.input,
  tools: [],
  maxTurns: 8,
};

describe('deriveConversation against a REAL captured SDK history', () => {
  const conv = deriveConversation(spec, fixture.history, fixture.finalOutput, null);

  it('composes the system turn from the TRUSTED AgentSpec.instructions (never SDK content)', () => {
    const sys = conv[0];
    expect(sys?.role).toBe('system');
    expect(sys?.parts).toEqual([{ kind: 'text', text: fixture.instructions }]);
  });

  it('maps the user message to a user text turn', () => {
    const user = conv.find((t) => t.role === 'user');
    expect(user?.parts).toEqual([{ kind: 'text', text: fixture.input }]);
  });

  it('maps function_call -> tool_call part with the REAL SDK callId + parsed args', () => {
    const callTurn = conv.find((t) => t.parts.some((p) => p.kind === 'tool_call'));
    const callPart = callTurn?.parts.find((p) => p.kind === 'tool_call');
    expect(callPart).toBeDefined();
    if (callPart?.kind === 'tool_call') {
      expect(callPart.toolCallId).toBe('call_OAEM0aPEoTnxkd11KGkfc3BH');
      expect(callPart.name).toBe('get_weather');
      expect(callPart.args).toEqual({ city: 'Berlin' });
    }
  });

  it('maps function_call_result -> tool_result part CORRELATED by the SAME callId', () => {
    const resTurn = conv.find((t) => t.parts.some((p) => p.kind === 'tool_result'));
    const resPart = resTurn?.parts.find((p) => p.kind === 'tool_result');
    expect(resPart).toBeDefined();
    if (resPart?.kind === 'tool_result') {
      expect(resPart.toolCallId).toBe('call_OAEM0aPEoTnxkd11KGkfc3BH');
      expect(resPart.name).toBe('get_weather');
    }
    // The call and its result PAIR UP on the same toolCallId (the exact correlation a flat
    // item dropped). Assert the ids match across the two parts.
    const callPart = conv.flatMap((t) => t.parts).find((p) => p.kind === 'tool_call');
    const resultPart = conv.flatMap((t) => t.parts).find((p) => p.kind === 'tool_result');
    if (callPart?.kind === 'tool_call' && resultPart?.kind === 'tool_result') {
      expect(resultPart.toolCallId).toBe(callPart.toolCallId);
    }
  });

  it('maps the assistant output_text message to an assistant text turn (the final answer)', () => {
    const assistantText = conv
      .filter((t) => t.role === 'assistant')
      .flatMap((t) => t.parts)
      .find((p) => p.kind === 'text');
    expect(assistantText).toBeDefined();
    if (assistantText?.kind === 'text') {
      expect(assistantText.text).toBe(fixture.finalOutput);
    }
  });

  it('produces NO synthetic 3-item stub — the transcript reflects the REAL turns', () => {
    const kinds = conv.flatMap((t) => t.parts.map((p) => p.kind));
    // system text + user text + tool_call + tool_result + assistant text = 5 parts (the real run),
    // NOT the old fixed 3 (system/user/assistant).
    expect(kinds).toEqual(['text', 'text', 'tool_call', 'tool_result', 'text']);
  });

  it('survives the untrusted-content read-path validator unchanged (every part is neutral-valid)', () => {
    // validateConversation drops anything not matching the neutral ConvPart shape; a clean derive
    // must round-trip with ZERO drops.
    const revalidated = validateConversation(conv);
    expect(revalidated).toEqual(conv);
  });
});

describe('normalizeToolOutput (single {type:"text"} object the SDK emits for a string return)', () => {
  it('unwraps a single {type:"text", text} OBJECT and JSON.parses it (no double-nesting)', () => {
    // The SDK emits a string tool return as a SINGLE { type:'text', text } OBJECT (not array-
    // wrapped). The dispatcher's opaque tool_data wrapper is stringified into that text; the derive
    // must UNWRAP + JSON.parse it so the tool_result part carries the tool_data OBJECT, not a
    // double-nested { type:'text', text:'{...}' } blob.
    const toolData = { kind: 'tool_data', name: 'lookup', toolCallId: 'call_x', data: { ok: 1 } };
    const history = [
      { type: 'function_call', callId: 'call_x', name: 'lookup', arguments: '{"id":7}' },
      {
        type: 'function_call_result',
        callId: 'call_x',
        name: 'lookup',
        output: { type: 'text', text: JSON.stringify(toolData) },
      },
    ];
    const conv = deriveConversation(spec, history, fixture.finalOutput, null);
    const resultPart = conv.flatMap((t) => t.parts).find((p) => p.kind === 'tool_result');
    expect(resultPart).toBeDefined();
    if (resultPart?.kind === 'tool_result') {
      // Unwrapped to the tool_data OBJECT — NOT the { type:'text', text:'...' } wrapper verbatim.
      expect(resultPart.result).toEqual(toolData);
    }
  });

  it('falls back to the raw text when the single text object is not JSON', () => {
    const history = [
      { type: 'function_call', callId: 'c1', name: 'f', arguments: '{}' },
      {
        type: 'function_call_result',
        callId: 'c1',
        name: 'f',
        output: { type: 'text', text: 'plain' },
      },
    ];
    const conv = deriveConversation(spec, history, fixture.finalOutput, null);
    const resultPart = conv.flatMap((t) => t.parts).find((p) => p.kind === 'tool_result');
    if (resultPart?.kind === 'tool_result') expect(resultPart.result).toBe('plain');
  });
});

describe('structured-output projection', () => {
  it('appends an explicit `output` part when the spec requested an outputSchema', () => {
    const structuredSpec: AgentSpec = {
      ...spec,
      outputSchema: { name: 'weather', schema: { type: 'object' } },
    };
    const value = { city: 'Berlin', tempC: 18 };
    const conv = deriveConversation(structuredSpec, fixture.history, fixture.finalOutput, value);
    const outputPart = conv.flatMap((t) => t.parts).find((p) => p.kind === 'output');
    expect(outputPart).toBeDefined();
    if (outputPart?.kind === 'output') expect(outputPart.value).toEqual(value);
  });
});

describe('per-response usage (the per-step LLM journal source)', () => {
  it('the captured run has MULTIPLE rawResponses (multi-turn) summing to the aggregate', () => {
    // The real multi-turn tool run made TWO model calls — the kill-stepCount=1 evidence.
    expect(fixture.rawResponses.length).toBeGreaterThan(1);
    const sum = fixture.rawResponses.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.usage.inputTokens,
        outputTokens: acc.outputTokens + r.usage.outputTokens,
        totalTokens: acc.totalTokens + r.usage.totalTokens,
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    );
    expect(sum.inputTokens).toBe(fixture.stateUsage.inputTokens);
    expect(sum.outputTokens).toBe(fixture.stateUsage.outputTokens);
    expect(sum.totalTokens).toBe(fixture.stateUsage.totalTokens);
  });
});
