/**
 * A deterministic, network-free fake Backend for the durable-dbos spine test — it drives the REAL
 * run-core pipeline (emits run_started → text_delta → run_completed via ctx.onEvent; journals one
 * `llm` step) so the journal + run_events tables are populated EXACTLY as a real off-request run
 * would populate them, WITHOUT any model call. No tools (the demo's async run is tool-light).
 */
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';

export class FakeSpineBackend implements Backend {
  readonly id = 'openai' as const;
  /** Counts how many times the LIVE path ran (so the started-once guard test can assert "ran once"). */
  liveRuns = 0;
  /**
   * PER-RUN real-execution ledger (runId → how many times `run()` was entered for THAT runId). The
   * durable exactly-once guarantee is keyed on the runId (the `run_started` reserve dedups per runId),
   * so a test that wants to prove the guard rather than count RAW global invocations asserts on this
   * ledger: `realRunsFor(runId)` is 0 when a recovery re-execution of that runId was correctly refused/
   * short-circuited (a genuine NO-OP), and 1 for a single real run. Distinguishing per-runId is what
   * makes the fake NON-BLIND to the reserve — a global counter cannot tell a legitimate distinct run
   * from a re-fire of the SAME firing key.
   */
  readonly runInvocations = new Map<string, number>();
  /**
   * When > 0, `run()` THROWS mid-run on the first N invocations (after `liveRuns` is incremented and
   * a run_started/text_delta event has been emitted), simulating a crash INSIDE runAgent/its tx. Used
   * by the crash-mid-tx recovery test (fix I) to prove the reserve marker survives runAgent's tx
   * rollback. Decrements per throw, so the (N+1)th invocation runs normally.
   */
  throwMidRunTimes = 0;

  /**
   * Taint quarantine: when true, `run()` FIRES the run's first tool through the central
   * `ctx.dispatchTool` chokepoint BEFORE proceeding (running its real handler — the side effect; for a
   * NON-idempotent tool also writing the run-taint marker). Combined with `throwMidRunTimes`, this
   * models the kill-class hazard: a non-idempotent tool fired, THEN the run crashed mid-run. A
   * whole-run re-execution would re-fire the side effect — which the quarantine must refuse.
   */
  fireToolBeforeProceeding = false;

  /**
   * SAFE half (concurrency cap + drain). Optional gate the run AWAITS before completing,
   * so a test can hold N runs open at once (to observe the worker-concurrency cap) or hold one open
   * across a shutdown (to observe graceful drain). Tracks the live + peak concurrency so a test can
   * assert the cap held. `releaseGate()` frees all currently-gated runs.
   */
  gate?: () => Promise<void>;
  liveConcurrency = 0;
  peakConcurrency = 0;
  #gateWaiters: Array<() => void> = [];

  /** Arm a manual gate: every run blocks until `releaseGate()` is called. */
  armGate(): void {
    this.gate = () =>
      new Promise<void>((resolve) => {
        this.#gateWaiters.push(resolve);
      });
  }

  /**
   * Worker-pool sizing. When true, a run holds its run-tx connection at a gate
   * that opens only when `releasePreTool()` is called, BEFORE it fires the non-idempotent tool — so a
   * test can pin all N runs holding their run-tx connection SIMULTANEOUSLY and then release them to all
   * fire the tool at once (each needing a 2nd autonomous taint connection). `onHoldingRunTx` fires when a
   * run reaches the gate (the entry barrier), so the test can wait until every run holds its run-tx conn.
   */
  gateBeforeTool = false;

  /**
   * When set, the completed run returns THIS object as its structured `output` (instead of null) — so a
   * job carrying `persistTo` has a validated output to write into a store. Default (unset) leaves
   * `output: null`, byte-behaviourally unchanged for every existing spine test.
   */
  structuredOutput?: Record<string, unknown>;

  onHoldingRunTx?: () => void;
  #preToolWaiters: Array<() => void> = [];
  releasePreTool(): void {
    const waiters = this.#preToolWaiters;
    this.#preToolWaiters = [];
    for (const w of waiters) w();
  }

  /** Release every currently-gated run (and any that arrive after — the gate becomes a no-op). */
  releaseGate(): void {
    this.gate = undefined;
    const waiters = this.#gateWaiters;
    this.#gateWaiters = [];
    for (const w of waiters) w();
  }

  /** How many times `run()` was entered for THIS runId (the per-firing-key real-run count). */
  realRunsFor(runId: string): number {
    return this.runInvocations.get(runId) ?? 0;
  }

  async resolveAuth() {
    return 'api-key' as const;
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.liveRuns += 1;
    this.runInvocations.set(ctx.runId, (this.runInvocations.get(ctx.runId) ?? 0) + 1);
    this.liveConcurrency += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.liveConcurrency);
    try {
      return await this.#runImpl(spec, ctx);
    } finally {
      this.liveConcurrency -= 1;
    }
  }

  async #runImpl(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const finalText = `echo: ${spec.input}`;

    // Fix E (pool-sizing): hold the run-tx connection at a gate BEFORE firing the tool, so a test can
    // pin all N runs holding their run-tx conn simultaneously, then release them to all fire the tool at
    // once (each needing a 2nd autonomous taint connection — the two-connection peak). Signal entry so
    // the test's barrier can wait until every run holds its run-tx conn.
    if (this.gateBeforeTool) {
      this.onHoldingRunTx?.();
      await new Promise<void>((resolve) => this.#preToolWaiters.push(resolve));
    }

    // Fire the first tool through dispatchTool (the side effect + — for a non-idempotent
    // tool — the run-taint marker) BEFORE the (optional) crash, modelling "fired a side effect, then
    // crashed". The dispatch chokepoint records the journal step + (for !idempotent) the taint marker.
    if (this.fireToolBeforeProceeding && ctx.dispatchTool && (ctx.tools?.length ?? 0) > 0) {
      await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);
      const toolName = ctx.tools?.[0]?.spec.name ?? '';
      await ctx.dispatchTool(toolName, { q: spec.input }, 'spine-taint-call-1');
    }

    if (this.throwMidRunTimes > 0) {
      this.throwMidRunTimes -= 1;
      // Emit a starting event (so the run genuinely began) then throw — the throw propagates out of
      // runAgent and aborts its surrounding tdb.transaction() (the run header / journal write rolls
      // back). The run_started marker reserve committed BEFORE this tx, so it must survive (fix I).
      await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);
      throw new Error('FakeSpineBackend: simulated crash mid-run (inside runAgent tx)');
    }

    await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);
    await ctx.onEvent?.({ type: 'text_delta', runId: ctx.runId, text: 'ec' } as never);
    await ctx.onEvent?.({ type: 'text_delta', runId: ctx.runId, text: 'ho' } as never);

    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      costUsd: 0.001,
      model: spec.model,
      producedBy: 'fake-spine-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });

    // SAFE-half seam: hold the run open here (in flight, holding work) until the gate releases — lets a
    // test pin N runs concurrently (the worker-concurrency cap) or one across a shutdown (graceful drain).
    if (this.gate) await this.gate();

    await ctx.onEvent?.({
      type: 'run_completed',
      runId: ctx.runId,
      status: 'ok',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    } as never);

    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText,
      output: this.structuredOutput ?? null,
      error: null,
      errorClass: null,
      conversation: [
        { role: 'user', index: 0, parts: [{ kind: 'text', text: spec.input }] },
        { role: 'assistant', index: 1, parts: [{ kind: 'text', text: finalText }] },
      ],
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      costUsd: 0.001,
      stepCount: 1,
    };
  }
}
