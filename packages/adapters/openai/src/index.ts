/**
 * OpenAI Agents SDK adapter — the REAL REFERENCE adapter.
 *
 * Maps the neutral Backend interface onto @openai/agents 0.11.8 (pinned, zero caret; verified
 * against the INSTALLED .d.ts under node_modules, doc-first).
 *
 * Verified API surface used here (file:symbol it was read from):
 *   - `run(agent, input, { stream:false, maxTurns })` -> RunResult            (run.d.ts / index)
 *   - RunResult.finalOutput        result.d.ts: `get finalOutput()`            (string | parsed)
 *   - RunResult.history            result.d.ts: `get history(): AgentInputItem[]`
 *                                  (= "replay-ready next-turn input built from input + newItems")
 *   - RunResult.rawResponses       result.d.ts: `get rawResponses(): ModelResponse[]`
 *                                  (= state._modelResponses; ONE entry per real model call —
 *                                   the per-step LLM journal source)
 *   - ModelResponse.usage          model.d.ts:417 `usage: Usage` (PER-RESPONSE usage)
 *   - ModelResponse.responseId / .requestId  model.d.ts:426/430 (per-call ids)
 *   - RunResult.state.usage        runState.d.ts:2697 `get usage(): Usage` (aggregate)
 *   - Usage fields                 usage.d.ts: inputTokens/outputTokens/totalTokens/requests,
 *                                  outputTokensDetails: Array<Record<string,number>>
 *                                  (reasoning tokens live under outputTokensDetails[].reasoning_tokens)
 *   - History item shapes          types/protocol.d.ts:
 *                                    MessageItem (role: system|user|assistant, content)        :292
 *                                    FunctionCallItem  { callId, name, arguments }             :375
 *                                    FunctionCallResultItem { callId, name, output }            :490
 *                                    ReasoningItem { content[], rawContent? }                   :944
 *   - `tool({ name, description, parameters:<JsonObjectSchema>, execute })`    (tool.d.ts:748)
 *       execute: ToolExecuteFunction = (input, context?, details?) => Promise<unknown>|unknown
 *         (tool.d.ts:571) — the RETURN VALUE becomes the tool RESULT fed back to the model.
 *       details: ToolCallDetails { toolCall?: FunctionCallItem; signal?: AbortSignal }  (tool.d.ts:28)
 *         — `details.toolCall.callId` is the SDK's REAL tool-call id (the correlation id).
 *   - `setDefaultOpenAIKey(key)` from @openai/agents-openai (re-exported by @openai/agents).
 *   - outputType accepts a JsonSchemaDefinition: { type:'json_schema', name, strict, schema }.
 *   - RunState serialization: result.state.toString() / RunState.fromString; CURRENT_SCHEMA_VERSION
 *     = "1.13" (runState.d.ts:45); fromString THROWS on a $schemaVersion mismatch. We do NOT use
 *     it as the replay source (see "RunState is a disposable reconnect blob" below) — DEFERRED.
 *
 * No SDK type escapes this file — everything returned is a neutral RunResult; the adapter is the
 * anti-corruption layer.
 *
 * Deliverables realized here:
 *   1. Real per-step journal: one `llm` step per `rawResponses` (real model call) with its OWN
 *      usage; `tool` steps flow through ctx.dispatchTool (which journals them). stepCount = real.
 *   2. Real conversation: result.history -> ConvTurn/ConvPart (text/reasoning/tool_call/tool_result/
 *      output), tool parts correlated by the SDK's real callId. No synthetic stub. The system turn
 *      is the TRUSTED AgentSpec.instructions, never re-injected from stored/SDK content (the
 *      untrusted-content boundary).
 *   3. dispatchTool wiring: the tool() execute closure ONLY marshals args -> ctx.dispatchTool ->
 *      returns the opaque {kind:'tool_data'|'tool_error'} stringified INTO THE TOOL-RESULT channel.
 *      The adapter holds NO handlers (CI gate `gate:adapter-handlers` enforces this).
 *   4. Real authMode by construction: ctx.authMode (resolved once by run-core) attributes every
 *      journaled step; falls back to this.resolveAuth() if absent.
 *   5. Replay = neutral-journal STEP short-circuit + ctx.rehydrate (store), no model call.
 *   6. Error-path RunResult: identical shape (key-presence: output/error always present), error set.
 *   7. RunState persistence DEFERRED (no current consumer; documented seam).
 */

import type {
  AgentSpec,
  AuthMode,
  Backend,
  ConvPart,
  ConvTurn,
  NeutralEvent,
  NeutralEventInput,
  RunContext,
  RunResult,
  StepReport,
  ToolDispatchResult,
  ToolSpec,
  Usage,
} from '@rayspec/core';
import { classifyUpstreamError, costUsd, hashJson } from '@rayspec/core';
import { Agent, run, setDefaultOpenAIKey, tool } from '@openai/agents';

/** Pin the non-streaming run() overload so the result type is RunResult, not StreamedRunResult. */
// biome-ignore lint/suspicious/noExplicitAny: matches the SDK's run() signature (Agent<any, any>).
function runNonStream(agent: Agent<any, any>, input: string, maxTurns: number) {
  return run(agent, input, { stream: false, maxTurns });
}

/**
 * The pinned @openai/agents version this adapter was written + recorded against (doc-first, zero
 * caret/tilde — matches packages/adapters/openai/package.json). The version-bump-re-record RULE
 * asserts this equals the INSTALLED pinned version, so bumping the SDK without
 * re-recording the fixtures fails CI. Bump BOTH together (this constant + a fresh fixture capture).
 */
export const OPENAI_SDK_VERSION = '0.11.8';

/** Provenance tag recorded on every journal step: SDK + adapter version. */
export const OPENAI_PRODUCED_BY = `@openai/agents@${OPENAI_SDK_VERSION}+adapter-openai`;

export interface OpenAIAdapterOptions {
  apiKey: string;
}

/** The SDK JsonSchemaDefinition shape the adapter sends for a structured-output spec. */
export interface SdkJsonSchemaOutputType {
  type: 'json_schema';
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

/**
 * Project a neutral OutputSchemaSpec to the SDK's `outputType` JsonSchemaDefinition (the wire
 * shape @openai/agents 0.11.8 accepts: { type:'json_schema', name, strict, schema }). Exported so
 * the wire-mapping test asserts the REAL projection — flipping `strict`
 * here MUST break that test. `strict: true` requests SDK-enforced strict structured output.
 */
export function toOutputType(outputSchema: {
  name: string;
  schema: Record<string, unknown>;
}): SdkJsonSchemaOutputType {
  return {
    type: 'json_schema',
    name: outputSchema.name,
    strict: true,
    schema: outputSchema.schema,
  };
}

export class OpenAIAdapter implements Backend {
  readonly id = 'openai' as const;
  private readonly apiKey: string;

  constructor(opts: OpenAIAdapterOptions) {
    this.apiKey = opts.apiKey;
  }

  // The OpenAI Agents SDK has no subscription/OAuth path — API key is the only mode.
  async resolveAuth(): Promise<AuthMode> {
    if (!this.apiKey) throw new Error('OpenAIAdapter: missing OPENAI_API_KEY');
    setDefaultOpenAIKey(this.apiKey);
    return 'api-key';
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    // resolveAuth() is idempotent (applies setDefaultOpenAIKey); the run's authMode is the one
    // run-core resolved ONCE and threaded on ctx — every journaled step attributes
    // to it. Fall back to this.resolveAuth() if run-core did not thread it.
    const resolved = await this.resolveAuth();
    const authMode: AuthMode = ctx.authMode ?? resolved;

    // run-core is the SINGLE per-run seq authority. This adapter emits SEQ-LESS events; the
    // wrapped ctx.onEvent (set by run-core) stamps the one monotonic seq across the adapter's events
    // AND dispatchTool's tool events. We pass the seq-less input through ctx.onEvent (its wrapper
    // overwrites seq), so there is no second seq counter here.
    const emit = (e: NeutralEventInput) => ctx.onEvent?.(e as NeutralEvent);
    await emit({ type: 'run_started', runId: ctx.runId });

    // ---- map neutral tools -> SDK function tools (NO handlers; dispatch-only) --
    const tools = spec.tools.map((t) => this.toSdkTool(t, ctx, emit));

    // ---- map neutral outputSchema -> SDK JsonSchemaDefinition ------------------
    // Projection extracted to `toOutputType` so the wire-mapping test asserts the REAL projection
    // (no literal-vs-literal); flipping strict here breaks that test.
    const outputType = spec.outputSchema ? (toOutputType(spec.outputSchema) as never) : undefined;

    const agent = new Agent({
      name: spec.name,
      instructions: spec.instructions,
      model: spec.model,
      tools,
      ...(outputType ? { outputType } : {}),
    });

    // ---- REPLAY = neutral-journal STEP short-circuit -------------
    // The DURABLE, upgrade-survivable replay source is the neutral journal + ConversationStore,
    // NOT the SDK RunState (which fromString-throws on a $schemaVersion bump). On replay we look
    // up the CACHED OK llm step(s) by the SAME per-response idempotency keys we'd assign live; if
    // the FIRST step (sequence 0) is cached we reconstruct the whole run from the journal + the
    // rehydrated conversation WITHOUT calling run(). Honest granularity caveat: the OpenAI run()
    // loop executes the entire agent loop inside ONE SDK call and cannot be paused mid-loop, so
    // the live short-circuit is at WHOLE-run() granularity (we do not partially re-enter the SDK
    // loop) — but the JOURNAL itself is per-step (one llm step per model call + the dispatched
    // tool steps), and a fully-journaled run is replayed with NO model call. A partial-cache miss
    // does NOT fall through to a live re-run here; it returns the journaled steps it has.
    if (ctx.replay) {
      const replayed = await this.replayFromJournal(spec, authMode, ctx);
      if (replayed) return replayed;
    }

    // ---- live run -------------------------------------------------------------
    // Non-streaming overload of run(): { stream: false } -> RunResult (not StreamedRunResult).
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof runNonStream>>;
    try {
      result = await runNonStream(agent, spec.input, spec.maxTurns);
    } catch (err) {
      // ---- ERROR-PATH RunResult — identical shape, error set ----
      // Classify the upstream cause into the neutral ErrorClass (preserving the real
      // cause message) — a 429 vs a 5xx vs a model refusal becomes distinguishable, without leaking a
      // backend-specific error shape into the neutral RunResult. The classified { error, errorClass }
      // is written into the failing journal step's output jsonb AND onto the RunResult; a captured
      // Retry-After (seconds) is recorded in the step output too so the sync endpoint can surface the
      // header (RunResult shape stays exactly errorClass-additive, so parity is unaffected).
      const { errorClass, message: errorMessage, retryAfter } = classifyUpstreamError(err);
      const latencyMs = Date.now() - startedAt;
      await ctx.journal.record({
        type: 'llm',
        idempotencyKey: this.llmStepKey(spec, 0),
        inputHash: hashJson({ input: spec.input }),
        output: {
          error: errorMessage,
          errorClass,
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        },
        usage: emptyUsage(),
        costUsd: 0,
        // OpenAI surfaces NO provider cost — leave providerCostUsd unset (journal records null).
        model: spec.model,
        producedBy: OPENAI_PRODUCED_BY,
        latencyMs,
        status: 'error',
        authMode,
      });
      await emit({ type: 'run_completed', runId: ctx.runId, status: 'error', usage: emptyUsage() });
      return {
        runId: ctx.runId,
        backend: this.id,
        authMode,
        status: 'error',
        finalText: '',
        // Key-presence: output + error ALWAYS present.
        output: null,
        error: errorMessage,
        // The neutral error class on the error path (null on success — see below).
        errorClass,
        conversation: [],
        usage: emptyUsage(),
        costUsd: 0,
        // One journaled step actually exists (the error llm step) — report it truthfully.
        stepCount: 1,
      };
    }
    const latencyMs = Date.now() - startedAt;

    // ---- REAL per-step LLM journal (kill stepCount=1) -------------
    // One `llm` step per REAL model call (result.rawResponses === state._modelResponses); each
    // carries its OWN usage (ModelResponse.usage). This is the truthful per-step ledger — the
    // count + per-step usage are DERIVED from the real RunState, never hard-coded. Tool steps are
    // journaled separately by ctx.dispatchTool (one each), so RunResult.stepCount = the real total.
    const responses = result.rawResponses ?? [];
    let llmStepCount = 0;
    // Spread the wall-clock latency evenly across the model calls (the SDK does not expose
    // per-response latency on this surface; documented honestly — we attribute the ONE wall-clock
    // span we can measure, not a fabricated per-call number).
    const perStepLatency = responses.length > 0 ? latencyMs / responses.length : latencyMs;
    if (responses.length > 0) {
      for (let i = 0; i < responses.length; i++) {
        const r = responses[i];
        const stepUsage = neutralUsage(r?.usage);
        await ctx.journal.record({
          type: 'llm',
          idempotencyKey: this.llmStepKey(spec, i),
          inputHash: hashJson({ input: spec.input, responseIndex: i }),
          // Persist a NEUTRAL, SDK-free projection of the response (final-output marker on the last
          // one) — never the raw SDK item. The opaque payload is the cache source on replay.
          output: {
            responseIndex: i,
            responseId: r?.responseId ?? null,
            isFinal: i === responses.length - 1,
            finalOutput: i === responses.length - 1 ? result.finalOutput : undefined,
          },
          usage: stepUsage,
          // costUsd is RE-COMPUTED authoritatively in run-core from the registry; we pass our estimate
          // for back-compat but run-core's value wins (the journal is the source of truth).
          costUsd: costUsd(spec.model, stepUsage.inputTokens, stepUsage.outputTokens),
          model: spec.model,
          producedBy: OPENAI_PRODUCED_BY,
          latencyMs: perStepLatency,
          status: 'ok',
          authMode,
        });
        llmStepCount++;
      }
    } else {
      // Defensive: a run with no rawResponses (should not happen on success) still journals ONE
      // llm step so the ledger is never empty for a completed run.
      const stepUsage = neutralUsage(result.state.usage as SdkUsageLike);
      const step: StepReport = {
        type: 'llm',
        idempotencyKey: this.llmStepKey(spec, 0),
        inputHash: hashJson({ input: spec.input }),
        output: { finalOutput: result.finalOutput, responseIndex: 0, isFinal: true },
        usage: stepUsage,
        costUsd: costUsd(spec.model, stepUsage.inputTokens, stepUsage.outputTokens),
        model: spec.model,
        producedBy: OPENAI_PRODUCED_BY,
        latencyMs,
        status: 'ok',
      };
      await ctx.journal.record({ ...step, authMode });
      llmStepCount++;
    }

    // ---- aggregate usage + cost (from the real RunState aggregate) ------------
    const usage = neutralUsage(result.state.usage as SdkUsageLike);
    const cost = costUsd(spec.model, usage.inputTokens, usage.outputTokens);

    const finalText =
      typeof result.finalOutput === 'string'
        ? result.finalOutput
        : JSON.stringify(result.finalOutput ?? '');
    // Key-presence: `output` is ALWAYS set — the structured value when requested, else null.
    // Coalesce undefined -> null so the documented `null` sentinel holds (matches the replay path).
    const output = spec.outputSchema ? ((result.finalOutput as unknown) ?? null) : null;

    // ---- REAL conversation re-derivation (delete the synthetic stub) --
    const conversation = deriveConversation(spec, result.history, finalText, output);

    // ---- count tool steps the dispatcher journaled (correlate via the transcript) --
    // dispatchTool records exactly one `tool` step per tool_result/tool_error part. The transcript
    // has one tool_result part per dispatched tool, so the real total step count is the LLM steps
    // plus the tool parts. (We count tool_call parts: each maps to one dispatched tool step.)
    const toolStepCount = countToolSteps(conversation);

    await emit({ type: 'run_completed', runId: ctx.runId, status: 'ok', usage });

    return {
      runId: ctx.runId,
      backend: this.id,
      authMode,
      status: 'completed',
      finalText,
      output,
      // Key-presence: error is ALWAYS present (null on success).
      error: null,
      // errorClass is always-present too — null on the success path.
      errorClass: null,
      conversation,
      usage,
      costUsd: cost,
      stepCount: llmStepCount + toolStepCount,
    };
  }

  /**
   * Build the SDK function tool. The execute closure does ONLY: marshal the SDK args ->
   * ctx.dispatchTool(name, args) -> return the opaque {kind:'tool_data'|'tool_error'} STRINGIFIED
   * into the tool-RESULT channel (so it goes back to the model as a tool result, never a
   * system/user turn). The adapter holds NO handler and NEVER journals here — dispatchTool owns
   * validate-in/idempotency/timeout/validate-out/opaque-wrap/one-journaled-step (the
   * untrusted-content boundary chokepoint; the gate forbids any handler in adapter src).
   */
  private toSdkTool(t: ToolSpec, ctx: RunContext, emit: (e: NeutralEventInput) => unknown) {
    return tool({
      name: t.name,
      description: t.description,
      parameters: t.parameters as never,
      // details.toolCall.callId is the SDK's REAL tool-call id; details.signal is the SDK abort.
      execute: async (args: unknown, _context?: unknown, details?: ToolCallDetailsLike) => {
        // The SDK's REAL per-call tool-call id — threaded into dispatchTool as the per-call journal
        // uniqueness + correlation id. Two identical-args calls in one run carry DISTINCT
        // callIds, so they journal DISTINCT rows and both fire (no unique_violation crash).
        const callId = details?.toolCall?.callId;
        if (!ctx.dispatchTool) {
          // No dispatcher means no tools were wired (run-core builds it only when tools exist).
          // Fail closed: surface a tool_error to the model rather than running anything inline.
          const message = `tool '${t.name}' has no dispatcher (no sanctioned tool path)`;
          await emit({
            type: 'tool_error',
            runId: ctx.runId,
            toolCallId: callId ?? `tool:${t.name}`,
            name: t.name,
            message,
          });
          return JSON.stringify({ kind: 'tool_error', name: t.name, message });
        }
        // The dispatcher emits tool_called/tool_result/tool_error + journals the step itself; the
        // adapter just marshals (with the REAL callId) and returns the opaque result into the
        // tool-result channel.
        const result: ToolDispatchResult = await ctx.dispatchTool(t.name, args, callId);
        return JSON.stringify(result);
      },
    });
  }

  /**
   * Replay reconstruction: rebuild the neutral RunResult from the neutral journal +
   * the rehydrated ConversationStore WITHOUT calling the model. Returns null if the run is not
   * fully journaled (the first llm step is not cached), so a true cache-miss does not masquerade
   * as a successful replay. NOTE: we do NOT fall through to a live re-run on a partial miss — that
   * was an earlier bug; we return what the journal has.
   */
  private async replayFromJournal(
    spec: AgentSpec,
    authMode: AuthMode,
    ctx: RunContext,
  ): Promise<RunResult | null> {
    const first = await ctx.journal.lookup(this.llmStepKey(spec, 0));
    if (!first) return null; // not journaled -> not a replayable run (no live re-run here)

    // Walk the per-response llm step keys until a gap; the LAST cached step carries the final
    // output marker. This reconstructs the run from the journal alone (no SDK call).
    let lastOutput = first.output as LlmStepOutput | null;
    let stepCount = 1;
    for (let i = 1; ; i++) {
      const next = await ctx.journal.lookup(this.llmStepKey(spec, i));
      if (!next) break;
      lastOutput = next.output as LlmStepOutput | null;
      stepCount++;
    }

    const finalRaw = lastOutput?.finalOutput;
    const finalText = typeof finalRaw === 'string' ? finalRaw : JSON.stringify(finalRaw ?? '');
    // Key-presence: coalesce undefined -> null so the documented `null` sentinel holds (matches the live path).
    const output = spec.outputSchema ? (finalRaw ?? null) : null;

    // The transcript comes from the untrusted-content read-path (tenant-scoped + per-part re-validation), not
    // the SDK RunState. Tool steps were journaled live; rehydrated tool parts reflect them.
    //
    // Replay transcript parity: the stored 'system' row was coerced to 'user' on read
    // (rehydrate.ts coerceRole — defense-in-depth so a poisoned stored system row can't re-enter as
    // an instruction). On REPLAY we re-prepend the TRUSTED system turn from spec.instructions
    // (never the stored/coerced row) and strip the leading coerced-system turn, so the replay
    // transcript's first turn is role='system' from the trusted instructions — IDENTICAL to live.
    const rehydrated = ctx.rehydrate
      ? await ctx.rehydrate()
      : deriveConversation(spec, [], finalText, output);
    const conversation = ctx.rehydrate ? reattachTrustedSystemTurn(spec, rehydrated) : rehydrated;
    const toolStepCount = countToolSteps(conversation);

    // Emit the terminal event SEQ-LESS through the wrapped sink (run-core stamps the seq); no
    // adapter-local seq counter.
    await ctx.onEvent?.({
      type: 'run_completed',
      runId: ctx.runId,
      status: 'ok',
      usage: emptyUsage(),
    } as NeutralEvent);

    return {
      runId: ctx.runId,
      backend: this.id,
      authMode,
      status: 'completed',
      finalText,
      output,
      error: null,
      // errorClass is always-present — null on the (replay) success path.
      errorClass: null,
      conversation,
      // Usage is DROPPED on replay (no new spend) — it is NOT reconstructed here. The journal
      // lookup returns only { output }; per-step usage lives in the journal rows but is not
      // re-aggregated on replay. Reported as zero (the durable spend was metered on the live run).
      usage: emptyUsage(),
      costUsd: 0,
      stepCount: stepCount + toolStepCount,
    };
  }

  /** Deterministic per-response llm idempotency key (one per real model call). */
  private llmStepKey(spec: AgentSpec, responseIndex: number): string {
    return `llm:${hashJson({ name: spec.name, input: spec.input, model: spec.model })}:${responseIndex}`;
  }
}

/** Minimal structural view of the SDK Usage we read (NO SDK type imported into the surface). */
interface SdkUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  outputTokensDetails?: Array<Record<string, number>>;
  inputTokensDetails?: Array<Record<string, number>>;
}

/** Minimal structural view of ToolCallDetails we read (callId + signal), SDK-type-free. */
interface ToolCallDetailsLike {
  toolCall?: { callId?: string };
  signal?: AbortSignal;
}

/** The neutral projection we persist as an llm step output (the replay cache source). */
interface LlmStepOutput {
  responseIndex?: number;
  responseId?: string | null;
  isFinal?: boolean;
  finalOutput?: unknown;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/**
 * Map an SDK Usage (or per-response usage) to the neutral Usage, carrying reasoning tokens when
 * present. OpenAI surfaces reasoning tokens under `outputTokensDetails[].reasoning_tokens`
 * (usage.d.ts: outputTokensDetails: Array<Record<string,number>>). Sum across detail entries.
 */
function neutralUsage(u: SdkUsageLike | undefined | null): Usage {
  const inputTokens = u?.inputTokens ?? 0;
  const outputTokens = u?.outputTokens ?? 0;
  const totalTokens = u?.totalTokens ?? inputTokens + outputTokens;
  const reasoningTokens = sumDetail(u?.outputTokensDetails, 'reasoning_tokens');
  const usage: Usage = { inputTokens, outputTokens, totalTokens };
  if (reasoningTokens > 0) usage.reasoningTokens = reasoningTokens;
  return usage;
}

/** Sum a named field across an array of token-detail records (e.g. reasoning_tokens). */
function sumDetail(details: Array<Record<string, number>> | undefined, field: string): number {
  if (!Array.isArray(details)) return 0;
  let sum = 0;
  for (const d of details) {
    const v = d?.[field];
    if (typeof v === 'number') sum += v;
  }
  return sum;
}

/** Count the tool steps the dispatcher journaled, via the transcript's tool_call parts. */
function countToolSteps(conversation: ConvTurn[]): number {
  let n = 0;
  for (const turn of conversation) {
    for (const part of turn.parts) {
      if (part.kind === 'tool_call') n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------
// REAL conversation re-derivation: result.history (AgentInputItem[]) -> ConvTurn[].
// ---------------------------------------------------------------------------------------

/**
 * Re-derive the neutral transcript from the SDK's REAL final history (never store SDK items).
 *
 * `result.history` is the AgentInputItem[] "replay-ready next-turn input built from input +
 * newItems" (result.d.ts). We project each protocol item to a typed ConvTurn/ConvPart:
 *   - message (system|user|assistant) -> a turn with text part(s)
 *   - reasoning                        -> assistant turn with a `reasoning` part
 *   - function_call                    -> assistant turn with a `tool_call` part (toolCallId=callId)
 *   - function_call_result             -> tool turn with a `tool_result` part (toolCallId=callId)
 * tool_call/tool_result share the SDK's REAL `callId`, so a call pairs with its result (the exact
 * correlation a flat item dropped). Structured output is appended as an `output` part.
 *
 * Untrusted-content boundary: the SYSTEM turn is composed ONLY from the TRUSTED AgentSpec.instructions — a 'system'
 * message in the SDK history is NOT re-injected as a system instruction (a stored/echoed system
 * row would be untrusted content); we drop SDK system rows and prepend the trusted instructions.
 * Each non-system item becomes its own turn (one item == one turn) so call/result ordering is
 * preserved exactly as the agent loop produced it.
 */
export function deriveConversation(
  spec: AgentSpec,
  history: unknown[],
  finalText: string,
  output: unknown,
): ConvTurn[] {
  const turns: ConvTurn[] = [];
  let index = 0;
  const push = (role: ConvTurn['role'], parts: ConvPart[]): void => {
    if (parts.length === 0) return;
    turns.push({ role, index: index++, parts });
  };

  // Untrusted-content boundary: the trusted system instructions, NEVER from SDK/stored content.
  push('system', [{ kind: 'text', text: spec.instructions }]);

  let sawAssistantText = false;
  for (const raw of Array.isArray(history) ? history : []) {
    const item = raw as HistoryItem;
    const type = item?.type;

    // A message item: discriminate by role + content shape. (system rows from the SDK are DROPPED
    // — the trusted system turn is the only system content; see the boundary note above.)
    if (type === 'message' || (type === undefined && typeof item?.role === 'string')) {
      if (item.role === 'user') {
        const text = extractMessageText(item.content);
        if (text) push('user', [{ kind: 'text', text }]);
      } else if (item.role === 'assistant') {
        const text = extractMessageText(item.content);
        if (text) {
          push('assistant', [{ kind: 'text', text }]);
          sawAssistantText = true;
        }
      }
      // role === 'system' -> dropped.
      continue;
    }

    if (type === 'reasoning') {
      const text = extractReasoningText(item);
      if (text) push('assistant', [{ kind: 'reasoning', text }]);
      continue;
    }

    if (type === 'function_call') {
      const callId = String(item.callId ?? '');
      const name = String(item.name ?? '');
      if (callId && name) {
        push('assistant', [
          { kind: 'tool_call', toolCallId: callId, name, args: parseArgs(item.arguments) },
        ]);
      }
      continue;
    }

    if (type === 'function_call_result') {
      const callId = String(item.callId ?? '');
      const name = String(item.name ?? '');
      if (callId && name) {
        push('tool', [
          {
            kind: 'tool_result',
            toolCallId: callId,
            name,
            result: normalizeToolOutput(item.output),
          },
        ]);
      }
    }
    // Unknown / hosted / computer items: skipped (the neutral transcript carries only the parts it
    // can type; fail-closed — never trust an unrecognized shape).
  }

  // If the SDK history did not surface an assistant text turn but we have a finalText, append it so
  // the transcript always ends on the model's final answer (the user-visible output).
  if (!sawAssistantText && finalText) {
    push('assistant', [{ kind: 'text', text: finalText }]);
  }

  // Structured output, when requested, is an explicit `output` part on its own turn.
  if (spec.outputSchema && output !== null && output !== undefined) {
    push('assistant', [{ kind: 'output', value: output }]);
  }

  return turns;
}

/**
 * Replay transcript parity: rebuild the replay conversation so its FIRST turn is the TRUSTED
 * system turn (role='system', spec.instructions) — IDENTICAL to the live path's leading turn.
 *
 * On the live run, deriveConversation prepends a 'system' turn from spec.instructions; it is
 * persisted with role='system'. On read, rehydrate.ts coerceRole downgrades a stored 'system' to
 * 'user' (defense-in-depth: a poisoned stored system row must not re-enter as an instruction). So
 * the rehydrated transcript's leading turn is a role='user' turn carrying the instructions text —
 * a DIVERGENCE from live (role='system'). Here we strip that leading coerced-system turn (a 'user'
 * turn whose single text part equals spec.instructions) and re-prepend the trusted system turn,
 * re-indexing. coerceRole's downgrade is KEPT for any OTHER stored system row (it stays a 'user'
 * data turn) — only the platform's own trusted system turn is restored.
 */
function reattachTrustedSystemTurn(spec: AgentSpec, rehydrated: ConvTurn[]): ConvTurn[] {
  const rest = [...rehydrated];
  const head = rest[0];
  const isCoercedTrustedSystem =
    head?.role === 'user' &&
    head.parts.length === 1 &&
    head.parts[0]?.kind === 'text' &&
    head.parts[0].text === spec.instructions;
  if (isCoercedTrustedSystem) rest.shift();
  const trustedSystem: ConvTurn = {
    role: 'system',
    index: 0,
    parts: [{ kind: 'text', text: spec.instructions }],
  };
  // Re-index the remaining turns to 1..N so the system turn is index 0 (matches live ordering).
  const reindexed = rest.map((t, i) => ({ ...t, index: i + 1 }));
  return [trustedSystem, ...reindexed];
}

/** Structural view of a protocol history item (SDK-type-free; matches types/protocol.d.ts). */
interface HistoryItem {
  type?: string;
  role?: string;
  content?: unknown;
  callId?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
  rawContent?: unknown;
}

/**
 * Extract plain text from a message item's `content`. content may be a bare string (system/user
 * string form) OR an array of typed content parts (input_text / output_text / refusal). We
 * concatenate the text-bearing parts; non-text parts (images/audio/files) are ignored for the
 * neutral text projection.
 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const pieces: string[] = [];
  for (const part of content) {
    const p = part as { type?: string; text?: string; refusal?: string };
    if ((p?.type === 'input_text' || p?.type === 'output_text') && typeof p.text === 'string') {
      pieces.push(p.text);
    } else if (p?.type === 'refusal' && typeof p.refusal === 'string') {
      pieces.push(p.refusal);
    }
  }
  return pieces.join('');
}

/** Extract reasoning text from a ReasoningItem ({ content:[{text}], rawContent?:[{text}] }). */
function extractReasoningText(item: HistoryItem): string {
  const pieces: string[] = [];
  for (const arr of [item.content, item.rawContent]) {
    if (!Array.isArray(arr)) continue;
    for (const part of arr) {
      const p = part as { text?: string };
      if (typeof p?.text === 'string') pieces.push(p.text);
    }
    if (pieces.length > 0) break; // prefer content; fall back to rawContent
  }
  return pieces.join('');
}

/** Parse a function_call `arguments` string into a value (best-effort; raw string on parse fail). */
function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? null;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Normalize a function_call_result `output`. The SDK output is either a string OR an array of
 * typed content parts; we extract the text where possible, else keep the value verbatim as DATA
 * (Untrusted-content boundary: a tool result is data, never instructions — the consumer treats it opaquely).
 */
function normalizeToolOutput(output: unknown): unknown {
  if (typeof output === 'string') {
    // The dispatcher's opaque wrapper is stringified into the tool-result channel; surface it
    // back as the parsed object when it round-trips cleanly, else the raw string.
    try {
      return JSON.parse(output);
    } catch {
      return output;
    }
  }
  if (Array.isArray(output)) {
    const text = extractMessageText(output);
    return text || output;
  }
  // The SDK also emits a SINGLE { type:'text', text:'...' } OBJECT (not array-wrapped) for a
  // string tool return. Without this, it falls through verbatim and DOUBLE-NESTS the dispatcher's
  // opaque wrapper inside { type:'text', text:'{...}' }. Unwrap the text and JSON.parse it when it
  // round-trips (so the opaque tool_data wrapper surfaces as the object), else keep the raw text.
  if (
    output !== null &&
    typeof output === 'object' &&
    (output as { type?: unknown }).type === 'text' &&
    typeof (output as { text?: unknown }).text === 'string'
  ) {
    const text = (output as { text: string }).text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return output ?? null;
}
