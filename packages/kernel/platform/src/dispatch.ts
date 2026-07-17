/**
 * Central tool dispatch — the ONLY sanctioned tool path.
 *
 * `dispatchTool(name, rawArgs, toolCallId)` owns the full untrusted-content-safe pipeline for every neutral
 * tool call:
 *
 *    validate-in (inputSchema)
 *      -> idempotency lookup (hash-of-args CACHE key, idempotent tools only)
 *      -> timeout (timeoutMs, AbortSignal)
 *      -> run handler
 *      -> validate-out (outputSchema)
 *      -> opaque-wrap the result as { kind:'tool_data', ... }   (NEVER raw handler output)
 *      -> record ONE journaled step (keyed by the REAL per-call toolCallId).
 *
 * Why central: if an adapter could call a handler
 * directly, the untrusted-content re-validation + opaque-wrapping would be bypassed. dispatchTool is the
 * single chokepoint; adapters hold NO handlers (the CI grep gate enforces that).
 *
 * TWO ID SCHEMES, ONE RESOLUTION:
 *  - the SDK's REAL per-call tool-call id (`toolCallId`, threaded in from the adapter —
 *    OpenAI: details.toolCall.callId) is the per-call CORRELATION + UNIQUENESS id. It is what
 *    the journal step's `idempotencyKey` column carries (the column under the UNIQUE
 *    (tenantId,runId,idempotencyKey) index, schema.ts) AND what the returned ToolData /
 *    emitted events carry — so the journal step and the transcript tool_call/tool_result parts
 *    JOIN on the same id. Two byte-identical calls in one run get DISTINCT real callIds, so they
 *    produce DISTINCT journal rows and BOTH fire (no unique_violation crash after a side effect).
 *  - the args-hash key (`toolCacheKey`) is used ONLY as the idempotent-REPLAY cache lookup key
 *    (a deterministic lookup keyed by args is the right key to short-circuit a re-derivation),
 *    NEVER as the journal uniqueness key.
 * A uuid fallback is generated if a backend ever fails to supply a real callId.
 *
 * Fail-closed replay contract: a tool flagged `idempotent: false`
 * (send_email, charge_card) must NEVER be re-fired on replay AND must NEVER return a cached
 * output as if it had been re-run. On ANY replay of a non-idempotent tool, dispatchTool
 * surfaces a `tool_error` — it does not touch the handler and does not fabricate a success.
 * An idempotent tool's cached output IS safely returned on replay (it is, by definition, a
 * deterministic re-derivable lookup) — and is RE-VALIDATED against outputSchema before return
 * (a cached payload is attacker-controllable jsonb; fail-closed on mismatch).
 *
 * Validation uses ajv with the draft-2020-12 dialect so a tool's JSON-Schema in/out contract is
 * enforced losslessly at the neutral boundary (the schemas are JSON-Schema objects, not live Zod,
 * exactly so they cross the neutral boundary without churn).
 */
import { randomUUID } from 'node:crypto';
import type {
  JournalSink,
  NeutralEventInput,
  NeutralTool,
  ToolData,
  ToolDispatchResult,
  ToolError,
} from '@rayspec/core';
import { hashJson } from '@rayspec/core';
// The NAMED class export `Ajv2020` is usable as a TYPE (its instance type); the default/namespace
// import is what carries the runtime constructor across the CJS/ESM interop quirk.
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js';
// ajv ships as CJS with no `exports` map; under NodeNext + verbatimModuleSyntax the default import
// types as the module NAMESPACE (no construct signatures) even though at runtime it IS the class
// (ajv also sets module.exports.default = module.exports). We import the value as a namespace and
// resolve the constructor at runtime (`.default ?? ns`), and take the INSTANCE TYPE from ajv's own
// `Ajv` class type — so the typing is precise and the runtime is correct on both interop shapes.
import * as Ajv2020Module from 'ajv/dist/2020.js';
import type { AnyValidateFunction } from 'ajv/dist/types/index.js';

/** The Ajv instance type (the class instance), independent of the CJS/ESM default-shape quirk. */
type AjvInstance = Ajv2020Class;

// Resolve the actual constructor at runtime across both interop shapes.
const Ajv2020Ctor = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as new (
  opts?: Record<string, unknown>,
) => AjvInstance;

/**
 * A seq-less event sink: dispatchTool emits NeutralEventInput (no `seq`) and the SINGLE per-run
 * seq authority in run-core (the wrapped onEvent it passes here) stamps the monotonic `seq`. This
 * is the unified-seq contract: dispatchTool no longer hard-codes `seq:0` — every event it emits flows
 * through the same run-core wrapper that stamps the adapter's events, so the whole stream is one
 * monotonic, contiguous sequence.
 */
export type SeqlessEventSink = (event: NeutralEventInput) => void | Promise<void>;

/**
 * Default bound on CONCURRENT in-flight tool HANDLER executions per run. An agent loop can
 * fire several tool calls in one turn (esp. Anthropic/Pi parallel tool use); holding the SDK call in
 * a request already caps run concurrency, but the handlers themselves must not stampede shared
 * resources unbounded. The cap is platform-owned + AbortSignal-respecting (the handler's own timeout
 * still applies once it starts). 8 is a conservative default; run-core may override per deployment.
 */
export const DEFAULT_TOOL_CONCURRENCY = 8;

/** Dependencies the dispatcher needs from the platform (run-core supplies these). */
export interface DispatchDeps {
  runId: string;
  tenantId: string;
  /** The journal sink (lookup + record) — one journaled step per tool call. */
  journal: JournalSink;
  /** The tools available to this run, keyed for dispatch by name. */
  tools: NeutralTool[];
  /** Whether this run is a replay (drives the fail-closed non-idempotent contract). */
  replay: boolean;
  /** The auth mode to attribute the tool step to (tools run in our process => api-key by default). */
  authMode: Parameters<JournalSink['record']>[0]['authMode'];
  /**
   * Optional SEQ-LESS event sink (emits tool_called / tool_result / tool_error WITHOUT a seq). The
   * single per-run seq authority (run-core's wrapped onEvent) stamps the monotonic seq: never a
   * hard-coded seq here.
   */
  onEvent?: SeqlessEventSink;
  /**
   * Bound on CONCURRENT in-flight tool handler executions for this run (default
   * DEFAULT_TOOL_CONCURRENCY). Acquired right before running the handler and released after, so a
   * burst of parallel tool calls executes at most `maxConcurrency` handlers at once. validate-in,
   * the replay short-circuit, and journaling are NOT gated (they do not run product handler code).
   */
  maxConcurrency?: number;
  /**
   * Provenance tag recorded on the dispatched `tool` journal step. A
   * tool step is PLATFORM-produced (the dispatcher ran the handler in our process), so it is tagged
   * with the platform dispatcher provenance, not an SDK version. Defaults to PLATFORM_DISPATCH_PRODUCED_BY.
   */
  producedBy?: string;
  /**
   * NON-IDEMPOTENT-TAINT marker writer. Called by the chokepoint IMMEDIATELY
   * BEFORE it runs a NON-idempotent (`idempotent:false`) tool's handler — it persists the tenant-scoped
   * `idempotency_keys(scope='run_taint', key=runId)` marker (the durable evidence "this run did
   * something irreversible") so every AUTOMATED re-run path (the in-request transient-release, the
   * worker's at-least-once retry) can REFUSE to silently re-run a tainted run. run-core supplies it
   * (closing over the run's TenantDb — so dispatch.ts itself holds NO db handle, keeping the chokepoint
   * gate green). FAIL-CLOSED on BOTH failure modes: if it REJECTS, the handler is NOT run; and if it is
   * UNDEFINED while a NON-idempotent tool is about to fire, dispatch REFUSES to run that handler at all
   * (defense-in-depth — a side effect must never fire un-quarantinable). Optional only because a run with
   * NO non-idempotent tool (idempotent-only / tool-free) never needs it: such a run proceeds normally
   * without a writer; only a non-idempotent tool fire requires it (and structurally enforces it above).
   */
  markRunTainted?: () => Promise<void>;
}

/** Provenance tag for a tool step (platform-produced — the dispatcher ran the handler in-process). */
export const PLATFORM_DISPATCH_PRODUCED_BY = 'platform-dispatch';

/**
 * A tiny FIFO async semaphore — the platform-owned concurrency cap. `acquire()` resolves when a slot
 * is free; the returned `release` frees it (and hands the slot to the next waiter). Bounded by
 * `permits`; never drops a waiter (FIFO order preserves fairness). Used ONLY around the handler call.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // A slot was handed to us by a release(); we already hold the permit.
    return () => this.release();
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the permit straight to the next FIFO waiter (do NOT increment available).
      next();
    } else {
      this.available++;
    }
  }
  /** Test/inspection aid: current free permits. */
  get freePermits(): number {
    return this.available;
  }
}

// One ajv instance per dispatcher (compiled validators are cached by schema identity).
function makeAjv(): AjvInstance {
  // allErrors for a useful message; strict:false so a tool's schema using vendor keywords or
  // draft-mixing does not hard-fail compilation (validation correctness is unaffected).
  return new Ajv2020Ctor({ allErrors: true, strict: false });
}

/** Compile (and cache) a JSON-Schema into an ajv validate function. */
function compile(ajv: AjvInstance, schema: Record<string, unknown>): AnyValidateFunction {
  return ajv.compile(schema);
}

/**
 * A deterministic per-tool CACHE key from the tool name + a stable hash of its args. This is used
 * ONLY as the idempotent-replay cache lookup key (a deterministic re-derivation keyed by args) —
 * NOT as the journal uniqueness key (that is the real per-call toolCallId; see the file header).
 */
export function toolCacheKey(name: string, args: unknown): string {
  return `tool:${name}:${hashJson(args)}`;
}

/**
 * @deprecated Use `toolCacheKey`. Kept as an alias for the args-hash key; it is the idempotent-
 * replay CACHE key only, never the journal uniqueness key (which is the real per-call toolCallId).
 */
export const toolIdempotencyKey = toolCacheKey;

function toolError(name: string, toolCallId: string, message: string): ToolError {
  return { kind: 'tool_error', name, toolCallId, message };
}

function toolData(name: string, toolCallId: string, data: unknown): ToolData {
  return { kind: 'tool_data', name, toolCallId, data };
}

/**
 * Build the central dispatchTool for a single run. The returned function is what run-core
 * assigns onto `ctx.dispatchTool`; the OpenAI adapter calls it with the SDK's REAL
 * per-call tool-call id.
 *
 * @param name        the tool name
 * @param rawArgs     the raw (unvalidated) tool args
 * @param toolCallId  the SDK's REAL per-call correlation id (OpenAI: details.toolCall.callId). It
 *                    is the journal step uniqueness key + the id carried on the result/events. A
 *                    uuid is generated if a backend cannot supply one (never collide two calls).
 */
export function makeDispatchTool(
  deps: DispatchDeps,
): (name: string, rawArgs: unknown, toolCallId?: string) => Promise<ToolDispatchResult> {
  const ajv = makeAjv();
  const byName = new Map(deps.tools.map((t) => [t.spec.name, t]));
  // Platform-owned concurrency cap: at most `maxConcurrency` tool HANDLERS run at once for
  // this run. Acquired only around the handler call (validate/replay/journal are not gated).
  const sem = new Semaphore(deps.maxConcurrency ?? DEFAULT_TOOL_CONCURRENCY);

  return async function dispatchTool(
    name: string,
    rawArgs: unknown,
    toolCallId?: string,
  ): Promise<ToolDispatchResult> {
    // The REAL per-call correlation id is the journal step uniqueness key (the column under the
    // UNIQUE (tenantId,runId,idempotencyKey) index) AND the id on the result/events. Two byte-
    // identical calls in one run get DISTINCT callIds -> DISTINCT rows -> both fire. Fall back
    // to a uuid so a missing callId can never collide two calls onto one journal row.
    const callId = toolCallId && toolCallId.length > 0 ? toolCallId : randomUUID();
    // The args `inputHash` is the idempotent-REPLAY cache lookup key ONLY (never the journal
    // uniqueness key). A tool step is stored with its callId in the idempotency_key column, so the
    // args-keyed replay cache matches on inputHash via journal.lookupToolCache.
    const inputHash = hashJson(rawArgs);

    const tool = byName.get(name);
    if (!tool) {
      // An unknown tool is a fail-closed error (never silently no-op). Not journaled: no tool ran.
      const err = toolError(name, callId, `unknown tool '${name}'`);
      await deps.onEvent?.({
        type: 'tool_error',
        runId: deps.runId,
        toolCallId: callId,
        name,
        message: err.message,
      });
      return err;
    }

    await deps.onEvent?.({
      type: 'tool_called',
      runId: deps.runId,
      toolCallId: callId,
      name,
      args: rawArgs,
    });

    // ---- FAIL-CLOSED REPLAY CONTRACT ------------------------------------------------------
    // On replay, a non-idempotent (side-effecting) tool must NEVER be re-fired and must NEVER
    // return a cached output as if re-run. Surface a tool_error instead — for BOTH the cached and
    // the uncached case (a side effect cannot be safely reproduced during replay either way).
    if (deps.replay && !tool.idempotent) {
      const err = toolError(
        name,
        callId,
        'non-idempotent tool cannot be replayed (fail-closed): side effect must not re-fire ' +
          'and a cached output must not be returned as if re-run',
      );
      await deps.onEvent?.({
        type: 'tool_error',
        runId: deps.runId,
        toolCallId: callId,
        name,
        message: err.message,
      });
      return err;
    }

    // On replay of an IDEMPOTENT tool, return the cached output (a deterministic re-derivable
    // lookup is safe to short-circuit — replay != re-run). The cache is keyed by the args inputHash
    // (the tool row's idempotency_key column holds the per-call callId, not the args hash).
    if (deps.replay && tool.idempotent) {
      const cached = (await deps.journal.lookupToolCache?.(inputHash)) ?? null;
      if (cached) {
        const wrapped = unwrapCached(cached.output, name, callId);
        // Re-validate the cached payload against outputSchema before returning. A cached jsonb
        // payload is attacker-controllable on read; fail-closed to tool_error on a schema mismatch
        // rather than handing back an unvalidated cached output as if freshly produced.
        if (tool.outputSchema) {
          const validateOut = compile(ajv, tool.outputSchema);
          if (!validateOut(wrapped.data)) {
            const err = toolError(
              name,
              callId,
              `cached output failed re-validation on replay: ${ajv.errorsText(validateOut.errors)}`,
            );
            await emitResult(deps, err);
            return err;
          }
        }
        await emitResult(deps, wrapped);
        return wrapped;
      }
      // No cache on replay for an idempotent tool: fall through to a live (safe) re-run.
    }

    // ---- VALIDATE-IN (inputSchema) -------------------------------------------------------
    if (tool.inputSchema) {
      const validateIn = compile(ajv, tool.inputSchema);
      if (!validateIn(rawArgs)) {
        const err = toolError(
          name,
          callId,
          `input validation failed: ${ajv.errorsText(validateIn.errors)}`,
        );
        await recordToolStep(deps, callId, rawArgs, err, 'error', 0);
        await emitResult(deps, err);
        return err;
      }
    }

    // ---- CONCURRENCY CAP + TIMEOUT + RUN HANDLER -----------------------------------------
    // Acquire a concurrency slot BEFORE the timeout starts (so a tool's timeout budget covers only
    // its own execution, not time spent waiting for a slot). The slot is released in `finally`.
    const releaseSlot = await sem.acquire();
    // ---- NON-IDEMPOTENT-TAINT MARKER -----------------------------------------------------
    // BEFORE a NON-idempotent (side-effecting) tool's handler runs, persist the run-taint marker so a
    // later AUTOMATED re-run (the in-request transient-release / the worker's whole-run retry) can
    // REFUSE to silently re-fire the side effect (the quarantine). FAIL-CLOSED on two distinct ways
    // the marker could be missing — a side effect must NEVER fire without a committed taint marker:
    //  (1) STRUCTURAL fail-closed (defense-in-depth): if a NON-idempotent tool is about to fire but NO
    //      `markRunTainted` writer was configured, the run cannot be quarantined on a future re-run —
    //      so we REFUSE to fire it at all (today run-core always wires the writer; a FUTURE caller that
    //      constructs dispatch without one must not be able to fire an un-quarantinable side effect).
    //  (2) WRITE fail-closed: if the marker write itself rejects, we do NOT run the handler.
    // The slot is already held; release it before returning the error (mirror the catch/finally below).
    // (Idempotent tools are safely re-runnable on replay/retry, so they are NEVER marked — and a run
    // with no non-idempotent tool needs no writer at all.)
    if (!tool.idempotent) {
      if (!deps.markRunTainted) {
        releaseSlot();
        const err = toolError(
          name,
          callId,
          'non-idempotent-taint writer not configured — refusing to fire an un-quarantinable side ' +
            'effect (fail-closed: a NON-idempotent tool requires a markRunTainted writer so a later ' +
            'automated re-run can refuse to re-fire it).',
        );
        await recordToolStep(deps, callId, rawArgs, err, 'error', 0);
        await emitResult(deps, err);
        return err;
      }
      try {
        await deps.markRunTainted();
      } catch (e) {
        releaseSlot();
        const err = toolError(
          name,
          callId,
          `failed to record non-idempotent-taint marker before the side effect (fail-closed, ` +
            `the tool was NOT run): ${String(e)}`,
        );
        await recordToolStep(deps, callId, rawArgs, err, 'error', 0);
        await emitResult(deps, err);
        return err;
      }
    }
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`tool '${name}' timed out after ${tool.timeoutMs}ms`));
      }, tool.timeoutMs);
    });

    let handlerOutput: unknown;
    try {
      handlerOutput = await Promise.race([
        Promise.resolve(tool.handler(rawArgs, controller.signal)),
        timeoutPromise,
      ]);
    } catch (e) {
      const err = toolError(name, callId, `handler error: ${String(e)}`);
      await recordToolStep(deps, callId, rawArgs, err, 'error', Date.now() - startedAt);
      await emitResult(deps, err);
      return err;
    } finally {
      if (timer) clearTimeout(timer);
      releaseSlot();
    }

    // ---- VALIDATE-OUT (outputSchema) -----------------------------------------------------
    if (tool.outputSchema) {
      const validateOut = compile(ajv, tool.outputSchema);
      if (!validateOut(handlerOutput)) {
        const err = toolError(
          name,
          callId,
          `output validation failed: ${ajv.errorsText(validateOut.errors)}`,
        );
        await recordToolStep(deps, callId, rawArgs, err, 'error', Date.now() - startedAt);
        await emitResult(deps, err);
        return err;
      }
    }

    // ---- OPAQUE-WRAP + RECORD ONE JOURNALED STEP -----------------------------------------
    // The journaled step's idempotencyKey is the REAL per-call callId (unique per call) so two
    // identical-args calls in one run record TWO distinct rows (no unique_violation crash).
    const wrapped = toolData(name, callId, handlerOutput);
    await recordToolStep(deps, callId, rawArgs, wrapped, 'ok', Date.now() - startedAt);
    await emitResult(deps, wrapped);
    return wrapped;
  };
}

/** Reconstruct an opaque tool_data wrapper from a cached journal output (replay path). */
function unwrapCached(cachedOutput: unknown, name: string, toolCallId: string): ToolData {
  // The journaled output IS the opaque wrapper we recorded; defensively re-wrap so the shape is
  // guaranteed even if the stored payload drifted.
  const co = cachedOutput as Partial<ToolData> | null;
  if (co && co.kind === 'tool_data') {
    return toolData(name, toolCallId, co.data);
  }
  return toolData(name, toolCallId, cachedOutput);
}

/** Emit the appropriate terminal event for a dispatch result (seq-less; run-core stamps seq). */
async function emitResult(deps: DispatchDeps, result: ToolDispatchResult): Promise<void> {
  if (result.kind === 'tool_data') {
    await deps.onEvent?.({
      type: 'tool_result',
      runId: deps.runId,
      toolCallId: result.toolCallId,
      name: result.name,
      result: result.data,
    });
  } else {
    await deps.onEvent?.({
      type: 'tool_error',
      runId: deps.runId,
      toolCallId: result.toolCallId,
      name: result.name,
      message: result.message,
    });
  }
}

/**
 * Record EXACTLY ONE journal step for a tool dispatch (success or fail-closed error).
 *
 * @param callId  the REAL per-call toolCallId — this is the journal step's `idempotencyKey` (the
 *                UNIQUE-index column) so identical-args calls in one run get DISTINCT rows.
 */
async function recordToolStep(
  deps: DispatchDeps,
  callId: string,
  rawArgs: unknown,
  output: ToolDispatchResult,
  status: 'ok' | 'error',
  latencyMs: number,
): Promise<void> {
  await deps.journal.record({
    type: 'tool',
    idempotencyKey: callId,
    // The args-hash stays in inputHash (audit + the basis of the replay cache key); the journal
    // UNIQUENESS key is the per-call callId above.
    inputHash: hashJson(rawArgs),
    output,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    // A tool step has no token usage, so its registry-computed cost is 0; no provider cost (the SDK
    // does not bill a tool call). produced_by tags it as platform-dispatched.
    costUsd: 0,
    producedBy: deps.producedBy ?? PLATFORM_DISPATCH_PRODUCED_BY,
    latencyMs,
    status,
    authMode: deps.authMode,
  });
}
