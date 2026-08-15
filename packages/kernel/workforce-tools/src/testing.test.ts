/**
 * The scripted backend's own contract: calls dispatch through the provided chokepoint in order,
 * the transcript records what a real adapter would (including the bridged prefixed form when a
 * fixture asks for it), and the per-spec cost knob prices a turn as a pure function of the
 * rendered spec — defaulting to zero so every fixture that predates it is byte-unchanged.
 */
import type { AgentSpec, RunContext } from '@rayspec/core';
import { describe, expect, it } from 'vitest';
import { makeScriptedBackend } from './testing.js';

const SPEC: AgentSpec = {
  name: 'a',
  instructions: 'x',
  model: 'model-x',
  input: "You are 'dev' (D), role 'worker'.",
  tools: [],
};

function ctxRecording(dispatched: string[]): RunContext {
  return {
    runId: 'run-1',
    dispatchTool: async (name: string) => {
      dispatched.push(name);
      return { kind: 'tool_data' };
    },
  } as unknown as RunContext;
}

describe('makeScriptedBackend', () => {
  it('reports the per-spec costUsd and defaults to 0', async () => {
    const dispatched: string[] = [];
    const priced = makeScriptedBackend('openai', () => [{ name: 'get_task', args: {} }], {
      costUsdFor: (spec) => (spec.input.includes("'dev'") ? 0.03 : 0),
    });
    const result = await priced.run(SPEC, ctxRecording(dispatched));
    expect(result.costUsd).toBe(0.03);
    expect(dispatched).toEqual(['get_task']);

    const free = makeScriptedBackend('openai', () => [{ name: 'get_task', args: {} }]);
    expect((await free.run(SPEC, ctxRecording([]))).costUsd).toBe(0);
  });

  it('records the transcript name a fixture asks for while dispatching the neutral name', async () => {
    const dispatched: string[] = [];
    const backend = makeScriptedBackend('anthropic', () => [
      { name: 'submit_result', recordedName: 'mcp__rayspec__submit_result', args: {} },
    ]);
    const result = await backend.run(SPEC, ctxRecording(dispatched));
    expect(dispatched).toEqual(['submit_result']); // the chokepoint saw the neutral name
    const calls = result.conversation[0]?.parts ?? [];
    expect(calls[0]).toMatchObject({ kind: 'tool_call', name: 'mcp__rayspec__submit_result' });
  });
});
