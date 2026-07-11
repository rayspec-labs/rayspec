/**
 * A deterministic, network-free fake Backend for the workflow-durable e2e — it drives the REAL
 * run-core pipeline (emits run_started/text_delta/run_completed via ctx.onEvent; journals one `llm`
 * step) so an AGENT node's runAgent sub-run populates runs/journal_steps/run_events EXACTLY as a real
 * off-request run would, WITHOUT any model call. It returns a STRUCTURED `output` (a support-triage
 * classification) so the agent node produces a meaningful artifact the downstream nodes consume.
 */
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';

export class FakeClassifierBackend implements Backend {
  readonly id = 'openai' as const;
  /** Counts LIVE runs so a test can assert an agent node ran exactly once (dedup/resume). */
  liveRuns = 0;

  async resolveAuth() {
    return 'api-key' as const;
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.liveRuns += 1;
    const output = { category: 'billing', priority: 'high', summary: 'refund request' };
    const finalText = JSON.stringify(output);

    await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);
    await ctx.onEvent?.({ type: 'text_delta', runId: ctx.runId, text: finalText } as never);
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      costUsd: 0.001,
      model: spec.model,
      producedBy: 'fake-classifier-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    await ctx.onEvent?.({
      type: 'run_completed',
      runId: ctx.runId,
      status: 'ok',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    } as never);

    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText,
      output,
      error: null,
      errorClass: null,
      conversation: [
        { role: 'user', index: 0, parts: [{ kind: 'text', text: spec.input }] },
        { role: 'assistant', index: 1, parts: [{ kind: 'text', text: finalText }] },
      ],
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      costUsd: 0.001,
      stepCount: 1,
    };
  }
}
