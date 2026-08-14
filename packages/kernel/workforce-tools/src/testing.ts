/**
 * The SCRIPTED backend — a neutral `Backend` whose "model" is a fixture: each run replays a
 * scripted sequence of tool calls through `ctx.dispatchTool` (the REAL chokepoint, so the real
 * toolset handlers, the real collector, the real validation all run) and returns a minimal valid
 * neutral result. No provider is ever called; no credential exists.
 *
 * The script is a PURE FUNCTION of the run's spec/context, never of invocation count — the same
 * discipline the engine's deterministic turn handlers keep, so a whole-turn re-execution replays
 * the identical calls. Imports ONLY neutral core types: this module lives inside the gated toolset
 * package and must stay as executor-free as everything beside it.
 */
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';

export interface ScriptedToolCall {
  readonly name: string;
  readonly args: unknown;
}

export type TurnScript = readonly ScriptedToolCall[];

/**
 * Build a scripted Backend for `id`. `script` maps (spec, ctx) → the turn's tool calls; it runs
 * once per `run()` and its calls dispatch IN ORDER (sequential by construction — "first" is
 * emission order).
 */
export function makeScriptedBackend(
  id: BackendId,
  script: (spec: AgentSpec, ctx: RunContext) => TurnScript | Promise<TurnScript>,
): Backend {
  return {
    id,
    resolveAuth() {
      return Promise.resolve('api-key');
    },
    async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
      const calls = await script(spec, ctx);
      let step = 0;
      for (const call of calls) {
        step += 1;
        if (!ctx.dispatchTool) {
          throw new Error('scripted backend requires ctx.dispatchTool — none was wired.');
        }
        await ctx.dispatchTool(call.name, call.args, `scripted-${step}`);
      }
      return {
        runId: ctx.runId,
        backend: id,
        authMode: ctx.authMode ?? 'api-key',
        status: 'completed',
        finalText: '',
        output: null,
        error: null,
        errorClass: null,
        conversation: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costUsd: 0,
        stepCount: step,
      };
    },
  };
}
