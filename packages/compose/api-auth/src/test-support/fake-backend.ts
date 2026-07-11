/**
 * A deterministic, network-free FakeBackend for the runs-route suite.
 *
 * It mirrors what a real adapter does through the platform run-core: it emits a NeutralEvent stream
 * via ctx.onEvent (run_started → text_delta → a tool call via ctx.dispatchTool → run_completed),
 * journals one llm step, and returns the neutral RunResult — WITHOUT any live model call. Because it
 * goes through ctx.onEvent (the run-core single-seq + persist-before-flush pipeline) and
 * ctx.dispatchTool (the central tool chokepoint), the run_events table is populated with the exact
 * frames a real run would produce, so the HTTP/SSE surface can be tested against ground truth.
 */
import type { AgentSpec, Backend, ErrorClass, RunContext, RunResult } from '@rayspec/core';

/** Hard cap on how long a gated run may block — so a test can NEVER leak a run hanging forever on a
 * pooled DB connection (which would exhaust the postgres-js pool and time out every later test). The
 * gate ALWAYS auto-releases after this, even if a test forgets / an assertion fails before release. */
const GATE_HARD_CAP_MS = 5_000;

export class FakeRunBackend implements Backend {
  readonly id = 'openai' as const;
  /** Counts how many times the LIVE path ran (so a test can assert "not re-executed" on replay). */
  liveRuns = 0;
  /**
   * Optional gate: when set, the live run AWAITS it before completing. Lets a test hold BOTH concurrent
   * same-key runs open simultaneously so the reserve-before-execute race (B1) is exercised
   * deterministically — both reservations happen before either run can complete.
   *
   * LEAK-PROOF: prefer `arm()` (below) over setting this directly — `arm()` adds a hard auto-release
   * cap + tracks the pending releaser so afterEach can free a run an assertion-failure left blocked.
   * (The C4 test sets a REJECTING gate directly to exercise the throw path; that never blocks.)
   */
  gate?: () => Promise<void>;
  /** The releaser for a currently-blocked gated run (so afterEach can release a leaked run). */
  pendingRelease?: () => void;
  /** Resolves once a gated run has ARRIVED at the gate — a deterministic barrier (no fixed sleeps). */
  gateArrived?: Promise<void>;
  /** Every currently-in-flight run()'s completion promise — afterEach awaits these so a released run's
   * trailing DB writes finish BEFORE the next test's TRUNCATE (no cross-test write race). */
  private readonly inFlight = new Set<Promise<void>>();

  /**
   * Release any leaked gated run, then AWAIT all in-flight runs to quiescence (bounded). Call in
   * afterEach so a test that failed mid-run cannot leave trailing run-core writes that race the next
   * test's TRUNCATE (the cross-test leak the deadlock came from). Never throws.
   */
  async settle(): Promise<void> {
    if (this.pendingRelease) {
      const r = this.pendingRelease;
      this.pendingRelease = undefined;
      r();
    }
    this.gate = undefined;
    this.preGate = undefined;
    // Await all in-flight runs (their own hard-cap guarantees they cannot hang forever).
    await Promise.allSettled([...this.inFlight]);
  }
  /**
   * Optional error mode (B2): when set, the run RETURNS a RunResult with status:'error' carrying this
   * detail (a completed-but-errored run — distinct from a THROWN run). The run-core genericizes the
   * error on reconstruction, so a test can assert the detail does NOT leak through GET /runs/{id}.
   */
  errorDetail?: string;

  /**
   * the neutral error class a completed-but-errored run reports. Mirrors a real adapter,
   * which classifies the upstream cause and writes { error, errorClass } into the failing journal
   * step's output (so GET /v1/runs/{id} derives it) AND onto the RunResult. Defaults to `internal`;
   * a test sets it (e.g. 'rate_limited' / 'upstream_5xx' / 'timeout') to exercise the HTTP status map.
   */
  errorClass: ErrorClass = 'internal';

  /**
   * a Retry-After (seconds) recorded into the failing journal step output (mirrors a
   * real adapter that captured one from a 429). The sync JSON endpoint reads it back to emit the
   * Retry-After header on a rate_limited run. Undefined ⇒ no header.
   */
  retryAfterSeconds?: number;

  /**
   * when set with errorDetail, record a TRAILING tool-error step (status
   * 'error', NO errorClass in its output — exactly a real tool failure) AFTER the failing llm step.
   * Reproduces the masking bug: the LAST error step is the tool step, which lacks an errorClass, so a
   * naive "last error step" derivation would fall back to internal + drop the Retry-After. The fix
   * prefers the llm step (the one carrying an errorClass), so GET surfaces the real class.
   */
  trailingToolError = false;

  /**
   * Arm a leak-proof blocking gate and return `{ release, arrived }`:
   *  - `arrived` resolves when a run REACHES the gate (the deterministic barrier — the test waits on
   *    this instead of sleeping a fixed time, so it provably knows the winner is gated);
   *  - `release()` lets the gated run continue (idempotent);
   *  - a hard internal cap auto-releases after GATE_HARD_CAP_MS so a run can NEVER hang forever and
   *    leak its pooled DB connection (the cascade-timeout failure mode). `pendingRelease` is tracked
   *    so an afterEach can free a run that an assertion failure left blocked.
   */
  arm(): { release: () => void; arrived: Promise<void> } {
    let signalArrived!: () => void;
    this.gateArrived = new Promise<void>((r) => {
      signalArrived = r;
    });
    let released = false;
    let resolveBlock!: () => void;
    const blockP = new Promise<void>((r) => {
      resolveBlock = r;
    });
    const release = () => {
      if (released) return;
      released = true;
      this.pendingRelease = undefined;
      resolveBlock();
    };
    this.pendingRelease = release;
    this.gate = () => {
      signalArrived();
      // Hard cap: auto-release so a blocked run can never outlive the test / exhaust the pool.
      const cap = setTimeout(release, GATE_HARD_CAP_MS);
      if (typeof cap.unref === 'function') cap.unref();
      return blockP.finally(() => clearTimeout(cap));
    };
    return { release, arrived: this.gateArrived };
  }

  /**
   * Arm the leak-proof PRE-gate (HTTP-2 throw-path): identical leak-proof semantics to arm() but the
   * block is hit at the TOP of run() (before any durable work). Returns `{ release, arrived }`.
   */
  armPre(): { release: () => void; arrived: Promise<void> } {
    let signalArrived!: () => void;
    this.gateArrived = new Promise<void>((r) => {
      signalArrived = r;
    });
    let released = false;
    let resolveBlock!: () => void;
    const blockP = new Promise<void>((r) => {
      resolveBlock = r;
    });
    const release = () => {
      if (released) return;
      released = true;
      this.pendingRelease = undefined;
      resolveBlock();
    };
    this.pendingRelease = release;
    this.preGate = () => {
      signalArrived();
      const cap = setTimeout(release, GATE_HARD_CAP_MS);
      if (typeof cap.unref === 'function') cap.unref();
      return blockP.finally(() => clearTimeout(cap));
    };
    return { release, arrived: this.gateArrived };
  }

  async resolveAuth() {
    return 'api-key' as const;
  }

  /** Track each run() in-flight so afterEach (settle) can await trailing writes to quiescence. */
  run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const p = this.runImpl(spec, ctx);
    const tracked: Promise<void> = p.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
    return p;
  }

  /**
   * HTTP-2 throw-path test seam: an OPTIONAL gate hit at the VERY TOP of run — BEFORE
   * any event emit / journal write / DB work. A test arms this + a tiny `runTimeoutMs` so the route's
   * withTimeout reliably fires the RunTimeoutError (→ 504 GATEWAY_TIMEOUT) WHILE the run has done ZERO
   * durable work; on release the run then completes a normal run in the foreground that settle() awaits.
   * This makes the throw-path 504 test DETERMINISTIC: no half-written background run races the teardown.
   */
  preGate?: () => Promise<void>;

  /**
   * (non-idempotent-taint quarantine) test seam: when true, the `errorDetail` path FIRES the
   * run's first registered tool through `ctx.dispatchTool` (running its real handler — the side effect,
   * and — for a NON-idempotent tool — writing the run-taint marker) BEFORE returning the transient
   * error. Models the real hazard: a non-idempotent tool fired, then the run failed transiently.
   * The quarantine must make a same-Idempotency-Key retry of THIS run a no-op (no second side effect).
   */
  fireToolBeforeError = false;

  private async runImpl(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    // Block BEFORE any work (incl. liveRuns / events / journal) so a held-request timeout leaves the
    // run with nothing durable in flight (HTTP-2 throw-path determinism).
    if (this.preGate) await this.preGate();
    this.liveRuns += 1;
    const finalText = `echo: ${spec.input}`;

    await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);

    // fire the run's first tool through the central dispatchTool chokepoint BEFORE the
    // error (the side effect happens; a non-idempotent tool also writes the run-taint marker). This is
    // the only place a real side effect + taint marker are produced on the error path.
    if (this.fireToolBeforeError && ctx.dispatchTool && (ctx.tools?.length ?? 0) > 0) {
      const toolName = ctx.tools?.[0]?.spec.name ?? '';
      await ctx.dispatchTool(toolName, { q: spec.input }, 'taint-call-1');
    }

    // B2: a completed-but-errored run — a CLEAN single-step error (NO tool call) so its reconstructed
    // usage/cost/stepCount are deterministic. RETURNS status:'error' with a real `error` detail;
    // run-core persists the header (status='error') and GET /runs/{id} GENERICIZES the error string so
    // the adapter-supplied detail does NOT leak. (Distinct from a THROWN run, which releases the
    // reservation — this completed-but-errored run is kept + replayable.)
    if (this.errorDetail) {
      await ctx.journal.record({
        type: 'llm',
        idempotencyKey: `llm:${spec.name}:0`,
        inputHash: `hash:${spec.input}`,
        // write { error, errorClass, retryAfter? } into the failing step's output jsonb
        // (mirrors a real adapter) so GET /v1/runs/{id} can DERIVE the classified error, and the sync
        // endpoint can read back the Retry-After for a rate_limited run.
        output: {
          finalText,
          error: this.errorDetail,
          errorClass: this.errorClass,
          ...(this.retryAfterSeconds !== undefined ? { retryAfter: this.retryAfterSeconds } : {}),
        },
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        costUsd: 0.001,
        // run-core RE-COMPUTES the authoritative cost from the registry using this model;
        // the adapter's costUsd above is back-compat only. provider cost is left unreported (OpenAI).
        model: spec.model,
        producedBy: 'fake-backend',
        latencyMs: 1,
        status: 'error',
        authMode: 'api-key',
      });
      // optionally record a TRAILING tool-error step (NO errorClass) AFTER the llm-error
      // step — the masking case the GET derivation must be robust to (it must still surface the llm
      // step's class, not fall back to internal).
      if (this.trailingToolError) {
        await ctx.journal.record({
          type: 'tool',
          idempotencyKey: `tool:${spec.name}:fail`,
          inputHash: `hash:tool:${spec.input}`,
          // A real tool-error step output carries the opaque tool_error — NO errorClass field.
          output: { kind: 'tool_error', name: 'lookup', message: 'tool blew up' },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          costUsd: 0,
          model: spec.model,
          producedBy: 'fake-backend',
          latencyMs: 1,
          status: 'error',
          authMode: 'api-key',
        });
      }
      if (this.gate) await this.gate();
      await ctx.onEvent?.({
        type: 'run_completed',
        runId: ctx.runId,
        status: 'error',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      } as never);
      return {
        runId: ctx.runId,
        backend: this.id,
        authMode: 'api-key',
        status: 'error',
        finalText,
        output: null,
        error: this.errorDetail,
        // the neutral error class on the error path (always-present).
        errorClass: this.errorClass,
        conversation: [{ role: 'user', index: 0, parts: [{ kind: 'text', text: spec.input }] }],
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        costUsd: 0.001,
        stepCount: 1,
      };
    }

    await ctx.onEvent?.({ type: 'text_delta', runId: ctx.runId, text: 'ec' } as never);
    await ctx.onEvent?.({ type: 'text_delta', runId: ctx.runId, text: 'ho' } as never);

    // Drive a real tool call through the central dispatchTool chokepoint (if a tool is registered).
    // This produces tool_called + tool_result events (the opaque tool_data) + a journaled tool step.
    let toolValue: unknown = null;
    if (ctx.dispatchTool && (ctx.tools?.length ?? 0) > 0) {
      const toolName = ctx.tools?.[0]?.spec.name ?? '';
      const res = await ctx.dispatchTool(toolName, { q: spec.input }, 'call-1');
      toolValue = res.kind === 'tool_data' ? res.data : null;
    }

    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      costUsd: 0.001,
      // run-core RE-COMPUTES the authoritative cost from the registry using this model.
      model: spec.model,
      producedBy: 'fake-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });

    // Hold the run open until the test releases it (lets two concurrent same-key runs overlap).
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
      output: toolValue !== null ? { tool: toolValue } : null,
      error: null,
      // errorClass is always-present — null on the success path.
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
