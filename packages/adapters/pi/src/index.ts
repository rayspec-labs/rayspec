/**
 * Pi adapter — runs the SAME neutral AgentSpec as the OpenAI reference, onto the same
 * neutral surface (central dispatchTool, real ConvTurn/ConvPart, real per-step journal).
 *
 * Maps the neutral Backend onto @earendil-works/pi-coding-agent 0.79.9 (verified doc-first
 * against the installed dist/*.d.ts + docs/sdk.md).
 *
 * --- DOC-FIRST verified API surface used here (file:symbol) -------------------------------------
 *   - createAgentSession({ model, customTools, noTools, sessionManager, authStorage, modelRegistry })
 *       : Promise<{ session }>                                          (core/sdk.d.ts)
 *   - getModel('openai', '<id>')                                        (@earendil-works/pi-ai)
 *   - AuthStorage.inMemory(); authStorage.setRuntimeApiKey('openai', key) (core/auth-storage.d.ts:59,64)
 *       inMemory() uses an InMemoryAuthStorageBackend (no auth.json reads/writes). create() defaults
 *       to a FileAuthStorageBackend that reads+writes ~/.pi/agent/auth.json via a reload lock — which
 *       is why this adapter uses inMemory() for a truly isolated, side-effect-free run.
 *       setRuntimeApiKey is a runtime override (priority 1 in getApiKey), so the OpenAI key resolves
 *       with NO disk credential — verified live.
 *   - ModelRegistry.inMemory(authStorage); SessionManager.inMemory()
 *   - defineTool({ name, label, description, parameters:<TypeBox>, execute }) (core/extensions/types.d.ts:335)
 *       execute(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>
 *         AgentToolResult = { content:(TextContent|ImageContent)[]; details:T; terminate? }
 *                                                                       (pi-agent-core types.d.ts:305)
 *       -> THE host-tool execution path: the closure routes to ctx.dispatchTool. NO handlers held.
 *   - session.subscribe(listener: (AgentSessionEvent)=>void): ()=>void  (core/agent-session.d.ts:242)
 *       AgentSessionEvent includes message_update/text_delta, tool_execution_start/end (with the REAL
 *       toolCallId/toolName/args/result), agent_end                     (pi-agent-core types.d.ts:359)
 *   - session.prompt(text): Promise<void>                              (core/agent-session.d.ts:328)
 *   - session.messages: AgentMessage[]                                 (core/agent-session.d.ts:291)
 *       Message = UserMessage | AssistantMessage | ToolResultMessage    (pi-ai types.d.ts:234)
 *         AssistantMessage.content: (TextContent|ThinkingContent|ToolCall)[] ; .usage:Usage (pi-ai:211)
 *         ToolResultMessage: { role:'toolResult', toolCallId, toolName, content[], isError } (pi-ai:225)
 *         ToolCall: { type:'toolCall', id, name, arguments }            (pi-ai:182)
 *         Usage: { input, output, cacheRead, cacheWrite, totalTokens, cost:{total,...} } (pi-ai:189)
 *   - session.abort(): Promise<void>; session.dispose()                (core/agent-session.d.ts:404,258)
 *
 * COMPLIANCE: Pi runs on the OpenAI API key ONLY (founder decision). Never
 * against an Anthropic subscription — the exact pattern Anthropic banned. We only inject the OpenAI key.
 *
 * STRUCTURED OUTPUT: Pi has NO native structured output (the lone documented capability exception);
 * it is EMULATED via instructions + parse. This is now capability-gated: a spec demanding NATIVE
 * structured output is rejected up front for pi by run-core's validateSpec(requireNativeStructuredOutput).
 *
 * No SDK type escapes this file.
 */
import { getModel } from '@earendil-works/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSpec,
  AuthMode,
  Backend,
  ConvPart,
  ConvTurn,
  ErrorClass,
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
import type { TSchema } from 'typebox';
import { Type } from 'typebox';

/**
 * The pinned @earendil-works/pi-coding-agent + pi-ai version this adapter was written + recorded
 * against (doc-first, zero caret/tilde — matches packages/adapters/pi/package.json). The
 * version-bump-re-record RULE asserts this equals the INSTALLED pinned version, so
 * bumping the SDK without re-recording the fixtures fails CI. Bump BOTH together.
 */
export const PI_SDK_VERSION = '0.79.9';

/** Provenance tag recorded on every journal step: SDK + adapter version. */
export const PI_PRODUCED_BY = `@earendil-works/pi-coding-agent@${PI_SDK_VERSION}+adapter-pi`;

// ---------------------------------------------------------------------------------------
// PURE neutral -> Pi-wire projection builders (the SINGLE source of truth — run() USES these).
//
// Pi has no native structured-output and no per-tool allowlist type, so the adapter's two outbound
// projections are (1) the active-set tool-name allowlist and (2) the emulated structured-output
// instruction. Both are exported as PURE functions so the Tier-1 wire-golden asserts the EXACT shape
// the adapter actually sends: a field-flip here breaks BOTH the golden AND run().
// ---------------------------------------------------------------------------------------

/**
 * The active-set tool-name allowlist sent to Pi: exactly the neutral tool names (so NONE of Pi's
 * built-in coding tools are offered). With no neutral tools this is empty (run() falls back to
 * `noTools:'all'`). Pure: a function of spec.tools only.
 */
export function piToolAllowlist(spec: AgentSpec): string[] {
  return spec.tools.map((t) => t.name);
}

/**
 * The EMULATED structured-output instruction appended to the prompt (Pi has no native outputType —
 * the lone documented capability exception). A JSON-only directive carrying the verbatim JSON Schema.
 * Empty string when the spec demands no structured output. Pure: a function of spec.outputSchema only.
 */
export function piJsonInstruction(spec: AgentSpec): string {
  if (!spec.outputSchema) return '';
  return `\n\nRespond with ONLY a single JSON object matching this JSON Schema (no prose, no markdown fences):\n${JSON.stringify(spec.outputSchema.schema)}`;
}

/**
 * Recursively STRIP the JSON-Schema keywords that pi-agent-core's validator (TypeBox 1.1.38
 * Compile/Check) ENFORCES but dispatchTool's AUTHORITATIVE ajv (`new Ajv2020({allErrors:true,
 * strict:false})` with NO ajv-formats registered) IGNORES — so the model-facing schema can never be
 * STRICTER than dispatchTool (the untrusted-content subset invariant; see the schema-aware walk
 * below).
 *
 * DOC-FIRST divergence probe (typebox@1.1.38 Compile.Check vs the EXACT dispatch.ts ajv config, over
 * the realistic tool-parameter vocabulary): the ONLY divergence is the `format` KEYWORD. TypeBox
 * auto-registers + ENFORCES `date-time`/`date`/`email`/`uri`/`uuid`/`ipv4`/… so it REJECTS e.g.
 * `"2020-01-01 00:00:00"` for `{type:string, format:'date-time'}` — while ajv-without-formats treats
 * `format` as annotation-only (`unknown format … ignored`) and ACCEPTS any string. EVERY structural
 * keyword agrees (type/required/enum/const/minimum/maximum/minLength/maxLength/pattern/minItems/
 * maxItems/additionalProperties; and `integer` accepts |v|>2^53 in BOTH). So we strip ONLY the
 * `format` KEYWORD.
 *
 * SCHEMA-AWARE WALK. A blunt "delete any key === 'format'" over-stripped a
 * PROPERTY literally NAMED `format` (a key inside a `properties` map, e.g. `{properties:{format:{type:
 * 'string',enum:[…]}}}`): it deleted the property DEFINITION while leaving `additionalProperties:false`,
 * so a VALID arg `{format:'json'}` became an undeclared key → Pi-Check FALSE while dispatchTool's ajv
 * (which keeps the declared property) = TRUE — the exact untrusted-content subset over-rejection this fix cures,
 * relocated onto the keyword NAME. We therefore walk the node as a JSON SCHEMA and strip `format` ONLY
 * at a SCHEMA-KEYWORD position (a sibling of type/enum/…), NEVER a property NAME, and never recurse into
 * DATA positions:
 *   - schema-MAP keywords (properties · patternProperties · $defs · definitions · dependentSchemas):
 *       VALUE is a NAME→schema map. Recurse each VALUE as a schema; the KEYS are opaque names — NEVER
 *       stripped, never matched against STRIP_KEYWORDS. (This is the bug fix: a property named `format`
 *       lives here and is preserved verbatim.)
 *   - schema keywords (items[object] · additionalProperties[object] · additionalItems · contains · if ·
 *       then · else · not · propertyNames · unevaluatedItems · unevaluatedProperties): VALUE is a
 *       schema → recurse it. (A boolean additionalProperties/additionalItems is a plain value — kept.)
 *   - schema-ARRAY keywords (allOf · anyOf · oneOf · prefixItems; and items when it is an ARRAY):
 *       VALUE is an array of schemas → recurse each element as a schema.
 *   - DATA keywords (enum · const · default · examples): VALUE is DATA, NOT a schema → kept verbatim,
 *       NOT recursed (a const/enum value could itself be an object carrying a "format" field — it must
 *       not be touched).
 *   - any other keyword (type/required/description/minimum/pattern/…): a scalar/array value → kept.
 *
 * If unsure whether a keyword nests a schema, the SAFE default is to KEEP its value as-is (do not
 * recurse, do not strip) — we only strip the `format` KEYWORD at an unambiguous schema-keyword position.
 *
 * Pure: deep-clones (never mutates the input). If the SDK/TypeBox vocabulary ever diverges on another
 * keyword, add it to STRIP_KEYWORDS (re-run the probe) — the set is the single documented seam.
 */
const STRIP_KEYWORDS = new Set<string>(['format']);

// JSON-Schema (draft-2020-12) keyword classification for the schema-aware walk. A keyword whose VALUE
// is itself a schema (or a collection of schemas) must be recursed; a DATA keyword must not.
/** keyword -> map of NAME→schema; recurse each VALUE, KEYS are opaque property names. */
const SCHEMA_MAP_KEYWORDS = new Set<string>([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
/** keyword -> a single sub-schema; recurse the value (when it is an object — a boolean is kept). */
const SCHEMA_KEYWORDS = new Set<string>([
  'additionalProperties',
  'additionalItems',
  'contains',
  'if',
  'then',
  'else',
  'not',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
/** keyword -> an array of sub-schemas; recurse each element. */
const SCHEMA_ARRAY_KEYWORDS = new Set<string>(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
/** keyword -> DATA value (NOT a schema); kept verbatim, never recursed, never strip a nested key. */
const DATA_KEYWORDS = new Set<string>(['enum', 'const', 'default', 'examples']);

function isObjectNode(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Recurse a value that is a map of NAME→schema (keys are opaque, never stripped). */
function stripSchemaMap(value: unknown): unknown {
  if (!isObjectNode(value)) return value; // not a map (defensive) — keep as-is
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(value)) {
    out[name] = stripSchemaNode(sub); // recurse the VALUE; `name` is an opaque property name
  }
  return out;
}

/** Recurse a value that is an array of schemas. */
function stripSchemaArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value; // not an array (defensive) — keep as-is
  return value.map((sub) => stripSchemaNode(sub));
}

/**
 * Walk a JSON-Schema NODE: strip the `format` keyword at a schema-keyword position and recurse only
 * into sub-SCHEMA positions (never property names, never DATA values). Pure: returns a new node.
 */
function stripSchemaNode(node: unknown): unknown {
  if (!isObjectNode(node)) return node; // a non-object schema position (e.g. a boolean schema) — kept
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIP_KEYWORDS.has(key)) continue; // drop the `format` KEYWORD (ajv ignores; TypeBox enforces)
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      out[key] = stripSchemaMap(value);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key)) {
      out[key] = stripSchemaArray(value);
    } else if (key === 'items') {
      // `items` is a schema OR (legacy draft) an array of schemas — handle both.
      out[key] = Array.isArray(value) ? stripSchemaArray(value) : stripSchemaNode(value);
    } else if (SCHEMA_KEYWORDS.has(key)) {
      // A single sub-schema when it is an object (e.g. additionalProperties:{...}); a boolean is a
      // plain value and is kept verbatim.
      out[key] = isObjectNode(value) ? stripSchemaNode(value) : value;
    } else if (DATA_KEYWORDS.has(key)) {
      // enum/const/default/examples carry DATA values, NOT schemas — keep verbatim, never recurse
      // (a value could legitimately be an object containing a "format" field).
      out[key] = value;
    } else {
      // Any other keyword (type/required/description/minimum/maximum/pattern/$ref/title/…): a scalar
      // or scalar-array annotation — keep verbatim (the SAFE default: do not recurse, do not strip).
      out[key] = value;
    }
  }
  return out;
}

/**
 * Strip the unenforced-by-ajv `format` keyword from a neutral tool-parameter JSON-Schema, schema-aware
 * (see stripSchemaNode). The entry point treats `toolSpec.parameters` as the ROOT schema node.
 */
function stripUnenforcedKeywords(node: unknown): unknown {
  return stripSchemaNode(node);
}

/**
 * Project a neutral tool's JSON-Schema `parameters` into the TypeBox TSchema passed to defineTool().
 * The OLD projection was `Type.Object({}, { additionalProperties: true })` — an EMPTY,
 * fully-permissive schema, so the model saw NOTHING and pi-agent-core's `validateToolArguments` (which
 * Compiles+Checks `tool.parameters` BEFORE our execute closure runs — verified doc-first in
 * pi-ai/dist/utils/validation.js) could never reject a malformed arg. A weak model could then emit a
 * malformed nested arg (e.g. an action_items entry missing `description`) and churn to MaxTurns,
 * because the late ctx.dispatchTool rejection never reached the model as a repairable tool_result.
 *
 * `Type.Unsafe(parameters)` passes the FAITHFUL neutral JSON-Schema through verbatim (it only stamps a
 * `~unsafe` marker — it does NOT add the `TypeBox.Kind` symbol, so pi's `hasTypeBoxMetadata` stays
 * false and its plain-JSON-Schema coercion+`Compile` path runs against the REAL keys, nested `items`,
 * and `required`). NO recursive TypeBox rebuild — the neutral schema is the single source of truth.
 *
 * Untrusted-content / over-rejection guard: the schema must be a SUBSET of the
 * neutral contract dispatchTool validates against (the sole AUTHORITATIVE validator), NEVER stricter.
 * TypeBox ENFORCES `format` (date-time/email/uri/…) while dispatchTool's ajv (no ajv-formats) IGNORES
 * it — so a verbatim pass-through would OVER-reject e.g. a space-separated date that dispatchTool
 * accepts, relocating the very MaxTurns churn this fixes. We therefore STRIP the `format` KEYWORD
 * (the lone probed divergence — see stripUnenforcedKeywords) at schema-keyword positions only (a
 * property literally NAMED `format` is preserved) BEFORE Type.Unsafe, keeping every
 * structural keyword (so additionalProperties:false / required / nested items still reject what ajv
 * rejects). Exported as a PURE function so the Tier-1 golden asserts the EXACT TSchema run() sends
 * (single source of truth — mirrors piToolAllowlist/piJsonInstruction): a field-flip here breaks BOTH
 * the golden AND run().
 */
export function piToolParameters(toolSpec: ToolSpec): TSchema {
  // Strip the unenforced-by-ajv keywords (format) at every level so the model-facing schema is never
  // stricter than dispatchTool (the untrusted-content subset invariant), then pass the result through verbatim.
  // The neutral parameters is a plain JSON-Schema Record; Type.Unsafe's static signature wants a
  // TSchema, so cast the input (runtime: Type.Unsafe shallow-copies + stamps `~unsafe`, accepting any
  // object). The returned TUnsafe extends TSchema, satisfying defineTool's TParams constraint.
  const stripped = stripUnenforcedKeywords(toolSpec.parameters);
  return Type.Unsafe(stripped as unknown as TSchema);
}

export interface PiAdapterOptions {
  apiKey: string;
}

export class PiAdapter implements Backend {
  readonly id = 'pi' as const;
  private readonly apiKey: string;

  constructor(opts: PiAdapterOptions) {
    this.apiKey = opts.apiKey;
  }

  // Pi runs on the OpenAI API key here. Guard: this adapter must NEVER be pointed at an Anthropic
  // subscription (ToS violation). We only ever inject the OpenAI key.
  async resolveAuth(): Promise<AuthMode> {
    if (!this.apiKey) throw new Error('PiAdapter: missing OPENAI_API_KEY');
    return 'api-key';
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const resolved = await this.resolveAuth();
    const authMode: AuthMode = ctx.authMode ?? resolved;

    // run-core is the SINGLE per-run seq authority. Emit SEQ-LESS through ctx.onEvent
    // (its wrapper stamps the one monotonic seq across adapter + dispatchTool events). No adapter-local
    // makeEventIngest (deleted). Pi events carry no SDK correlation id — the platform seq gives them
    // the same total order (the asymmetry lives here, not in a weakened neutral type).
    const emit = (e: NeutralEventInput) => ctx.onEvent?.(e as NeutralEvent);
    await emit({ type: 'run_started', runId: ctx.runId });

    const llmIdemKey = (turn: number) => `llm:${this.runHash(spec)}:${turn}`;

    // ---- REPLAY = neutral-journal step short-circuit ------------------------------
    if (ctx.replay) {
      const replayed = await this.replayFromJournal(spec, authMode, ctx);
      if (replayed) return replayed;
    }

    // ---- isolated, in-memory auth + model registry (no ~/.pi reads/writes) ----------------------
    // AuthStorage.inMemory() uses an InMemoryAuthStorageBackend — NO auth.json file I/O.
    // (AuthStorage.create() would back onto ~/.pi/agent/auth.json via a reload lock, contradicting the
    // "isolated, in-memory" intent.) The OpenAI key is a runtime override (priority 1 in getApiKey),
    // so it resolves with no on-disk credential.
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey('openai', this.apiKey);
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    // An unknown/unsupported model is a RUN error, not a crash: getModel may throw OR return a
    // falsy value. Either way, return the IDENTICAL-shape error RunResult + journal an error
    // step — matching the OpenAI/Anthropic error-path shape (the parity gate asserts this).
    let model: ReturnType<typeof getModel> | null = null;
    try {
      model = getModel('openai', spec.model as never);
    } catch {
      model = null;
    }
    if (!model) {
      const message = `PiAdapter: unknown OpenAI model '${spec.model}'`;
      // This is an ADAPTER-INTERNAL validation error — the model is rejected before any
      // HTTP call, so there is no upstream status to classify; it is honestly `internal` (NOT an
      // upstream 4xx — we never fabricate an upstream class for a local rejection).
      const errorClass: ErrorClass = 'internal';
      await ctx.journal.record({
        type: 'llm',
        idempotencyKey: llmIdemKey(0),
        inputHash: hashJson({ input: spec.input }),
        output: { error: message, errorClass },
        usage: emptyUsage(),
        costUsd: 0,
        model: spec.model,
        producedBy: PI_PRODUCED_BY,
        latencyMs: 0,
        status: 'error',
        authMode,
      });
      await emit({ type: 'run_completed', runId: ctx.runId, status: 'error', usage: emptyUsage() });
      return errorResult(ctx.runId, this.id, authMode, message, errorClass);
    }

    // ---- structured-output via instructions (EMULATED; Pi has no native outputType) ------------
    // SINGLE source of truth: the run() projection USES the exported piJsonInstruction builder (the
    // Tier-1 golden asserts the SAME function), so a field-flip cannot pass the golden while breaking
    // the real adapter.
    const jsonInstruction = piJsonInstruction(spec);

    // ---- host-tool bridge: route Pi's tool execution to ctx.dispatchTool (NO handlers) ---------
    const toolEvents = { count: 0 };
    const customTools = spec.tools.map((t) =>
      // defineTool() parameters use TypeBox (docs/sdk.md). We pass the FAITHFUL neutral JSON-Schema
      // (via the exported piToolParameters single-source builder) so pi-agent-core's
      // validate-and-repair (validateToolArguments -> Compile/Check, which runs BEFORE this execute
      // closure) can catch a malformed (incl. nested) arg at the model boundary instead of letting a
      // weak model churn to MaxTurns. The AUTHORITATIVE JSON-Schema validate-in still happens inside
      // ctx.dispatchTool — the model-facing schema is a SUBSET of that contract, never stricter. The
      // execute closure is the bridge: marshal args -> ctx.dispatchTool -> return the opaque
      // tool_data/tool_error into Pi's tool-RESULT channel (AgentToolResult.content). The adapter
      // holds NO handler; the gate (gate:adapter-handlers) verifies every tool path routes through
      // dispatchTool.
      defineTool({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: piToolParameters(t),
        execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
          void signal;
          if (!ctx.dispatchTool) {
            const message = `tool '${t.name}' has no dispatcher (no sanctioned tool path)`;
            await emit({
              type: 'tool_error',
              runId: ctx.runId,
              toolCallId: toolCallId || `tool:${t.name}`,
              name: t.name,
              message,
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ kind: 'tool_error', name: t.name, message }),
                },
              ],
              details: {},
              isError: true,
            };
          }
          toolEvents.count++;
          const result: ToolDispatchResult = await ctx.dispatchTool(t.name, params, toolCallId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            details: {},
            isError: result.kind === 'tool_error',
          };
        },
      }),
    );

    // Tool activation (verified against pi-coding-agent dist/core/sdk.js:131-135): with `noTools:'all'`
    // the active-tool set is EMPTY, so customTools are registered but NEVER offered to the model. To
    // expose ONLY our neutral tools (and none of Pi's built-in coding tools), pass an explicit `tools`
    // ALLOWLIST of exactly our tool names; that becomes the active set. With no neutral tools, fall
    // back to `noTools:'all'` for a pure-LLM run.
    const session = (
      await createAgentSession({
        model,
        ...(customTools.length > 0
          ? // SINGLE source of truth: the run() active-set allowlist USES the exported piToolAllowlist
            // builder (the Tier-1 golden asserts the SAME function), so changing the allowlist
            // projection cannot pass the golden while breaking the real adapter.
            { customTools, tools: piToolAllowlist(spec) }
          : { noTools: 'all' }),
        sessionManager: SessionManager.inMemory(),
        authStorage,
        modelRegistry,
      })
    ).session;

    // ---- normalize Pi events -> neutral events (AWAITED — the back-pressure fix) ----------------
    // Pi's SDK fires events synchronously into the subscriber. We must NOT drop or reorder them.
    // An earlier version used `void this.forwardEvent(...)` (fire-and-forget); this AWAITS each emit by serializing
    // forwarding onto a tail promise so emits run in order and back-pressure is observed. The BOUNDED
    // back-pressure queue + overflow policy now lives at the PLATFORM layer (in
    // event-pipeline.ts: maxQueue + FIFO waiter, persist-before-flush) — this awaited forwardTail
    // feeds it in order, so the platform bound applies to Pi's stream too. (DRIFT-4)
    //
    // pi-agent-core's StreamFn contract (pi-agent-core types.d.ts:7-10) says a
    // request/model/runtime failure MUST NOT throw — it is encoded in the stream + a terminal
    // AssistantMessage with stopReason "error"/"aborted" + errorMessage; and pi RETRIES retryable
    // upstream errors internally (agent-session.d.ts:488) surfacing a terminal failure via an
    // `auto_retry_end { success:false, finalError }` event. So a real rate-limit/5xx that retries-then-
    // fails RESOLVES prompt() WITHOUT throwing. We CAPTURE that event-path signal here so the post-drain
    // inspection (below) can promote a swallowed upstream failure to status='error'.
    let retryFinalError: string | undefined;
    const captureRetryFailure = (event: unknown): void => {
      const e = event as { type?: string; success?: boolean; finalError?: string };
      if (e.type === 'auto_retry_end' && e.success === false) {
        // finalError is optional on the event; fall back to a stable message if absent.
        retryFinalError = e.finalError ?? 'auto-retry exhausted (upstream failure)';
      }
    };
    let forwardTail: Promise<void> = Promise.resolve();
    const unsubscribe = session.subscribe((event: unknown) => {
      captureRetryFailure(event);
      forwardTail = forwardTail.then(() => this.forwardEvent(event, ctx, emit));
    });

    // Pi has no system-prompt option, so fold the neutral instructions into the prompt.
    const promptText = `${spec.instructions}\n\n${spec.input}${jsonInstruction}`;
    const startedAt = Date.now();
    let status: 'completed' | 'error' = 'completed';
    let errorMessage: string | undefined;
    // The neutral class of a model-call failure (Pi wraps OpenAI under the hood, so an
    // HTTP error surfaces the same status-bearing shape classifyUpstreamError understands). Set in the
    // prompt() catch; threaded onto the error RunResult + journal step. Default `internal`.
    let errorClass: ErrorClass = 'internal';
    // A Retry-After (seconds) the classifier captured (rate-limit/5xx), recorded into the
    // failing journal step's output so the sync endpoint can surface the header. Undefined otherwise.
    let errorRetryAfter: number | undefined;
    let messages: PiMessage[] = [];
    let latencyMs = 0;
    // Own the session in a try/finally so a THROWING onEvent (during prompt OR the tail
    // drain) NEVER leaks the Pi session — the teardown (unsubscribe/abort/dispose) always runs,
    // mirroring the Anthropic adapter's finally-abort.
    try {
      try {
        await session.prompt(promptText);
      } catch (err) {
        status = 'error';
        const classified = classifyUpstreamError(err);
        errorMessage = classified.message;
        errorClass = classified.errorClass;
        errorRetryAfter = classified.retryAfter;
      }
      // Drain the forwarding tail so every event is emitted before we tear down (no dropped events).
      // If a relayed onEvent throws here, the finally below STILL tears the session down.
      await forwardTail;
      latencyMs = Date.now() - startedAt;
      // Harvest the REAL message history (text + correlated tool_call/tool_result) before teardown.
      messages = (session.messages ?? []) as unknown as PiMessage[];

      // If prompt() RESOLVED but the run actually FAILED upstream (the
      // retries-then-fails-without-throwing path), promote it to status='error'. Inspect the terminal
      // session state for an upstream-error indicator: (1) an `auto_retry_end success:false` event
      // captured during the run, OR (2) a terminal AssistantMessage whose stopReason is "error"/
      // "aborted" carrying an errorMessage (the StreamFn-encoded failure, pi-agent-core types.d.ts:7-10).
      // We do this ONLY when status is still 'completed' (the prompt() catch already owns the throw
      // path) so we never double-handle. classifyUpstreamError runs on the REAL upstream message (a
      // rate-limit/5xx string classifies correctly via the message heuristics).
      if (status === 'completed') {
        const upstreamError = retryFinalError ?? terminalAssistantError(messages);
        if (upstreamError !== undefined) {
          status = 'error';
          const classified = classifyUpstreamError(new Error(upstreamError));
          errorMessage = classified.message;
          errorClass = classified.errorClass;
          errorRetryAfter = classified.retryAfter;
        }
      }
    } finally {
      // Own + tear down the session no matter what (never leak it) — even on a throwing emit.
      unsubscribe();
      try {
        await session.abort();
      } catch {
        /* best effort */
      }
      session.dispose();
    }

    if (status === 'error') {
      await ctx.journal.record({
        type: 'llm',
        idempotencyKey: llmIdemKey(0),
        inputHash: hashJson({ input: spec.input }),
        output: {
          error: errorMessage,
          errorClass,
          ...(errorRetryAfter !== undefined ? { retryAfter: errorRetryAfter } : {}),
        },
        usage: emptyUsage(),
        costUsd: 0,
        model: spec.model,
        producedBy: PI_PRODUCED_BY,
        latencyMs,
        status: 'error',
        authMode,
      });
      await emit({ type: 'run_completed', runId: ctx.runId, status: 'error', usage: emptyUsage() });
      return errorResult(ctx.runId, this.id, authMode, errorMessage ?? 'pi run failed', errorClass);
    }

    // ---- REAL conversation + per-step journal from the message history --------------------------
    const conversation = deriveConversation(spec, messages);

    // One `llm` step per assistant message (real per-step ledger; kill stepCount=1). Each carries its
    // OWN per-message usage. The FINAL assistant message's step carries the finalText/output marker.
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    const finalText = lastAssistant ? extractText(lastAssistant) : '';
    const output = spec.outputSchema ? (tryParseJson(finalText) ?? null) : null;

    let aggIn = 0;
    let aggOut = 0;
    let aggCost = 0;
    const llmSteps = assistantMsgs.length > 0 ? assistantMsgs : [undefined];
    const perStepLatency = latencyMs / llmSteps.length;
    for (let i = 0; i < llmSteps.length; i++) {
      const m = llmSteps[i];
      const stepUsage = neutralUsageFromPi(m?.usage);
      const isFinal = i === llmSteps.length - 1;
      // Pi reports a per-message PROVIDER cost (Usage.cost.total, pi-ai types.d.ts:202). Surface it as
      // the provider cost for reconciliation; fall back to a registry estimate for the costUsd estimate
      // (run-core RE-COMPUTES the authoritative computed cost from the registry regardless).
      const providerCost = m?.usage?.cost?.total;
      const stepCost =
        providerCost ?? costUsd(spec.model, stepUsage.inputTokens, stepUsage.outputTokens);
      aggIn += stepUsage.inputTokens;
      aggOut += stepUsage.outputTokens;
      aggCost += stepCost;
      const step: StepReport = {
        type: 'llm',
        idempotencyKey: llmIdemKey(i),
        inputHash: hashJson({ input: spec.input, turn: i }),
        output: isFinal ? { finalText, output, turnCount: llmSteps.length } : { turnIndex: i },
        usage: stepUsage,
        costUsd: stepCost,
        ...(providerCost !== undefined ? { providerCostUsd: providerCost } : {}),
        model: spec.model,
        producedBy: PI_PRODUCED_BY,
        latencyMs: perStepLatency,
        status: 'ok',
      };
      await ctx.journal.record({ ...step, authMode });
    }

    const usage: Usage = { inputTokens: aggIn, outputTokens: aggOut, totalTokens: aggIn + aggOut };
    await emit({ type: 'run_completed', runId: ctx.runId, status: 'ok', usage });

    return {
      runId: ctx.runId,
      backend: this.id,
      authMode,
      status: 'completed',
      finalText,
      // Key-presence: output ALWAYS set — Pi EMULATES structured output (parse the JSON), else null.
      output,
      // Key-presence: error ALWAYS present (null on success).
      error: null,
      // errorClass is always-present — null on the success path.
      errorClass: null,
      conversation,
      usage,
      costUsd: aggCost,
      // Real per-step total: one llm step per assistant message + the dispatched tool steps.
      stepCount: llmSteps.length + toolEvents.count,
    };
  }

  /**
   * Forward a Pi SDK event to the neutral event stream (SEQ-LESS — run-core stamps the seq).
   *
   * ONLY `text_delta` is relayed here. The tool-event LIFECYCLE (tool_called /
   * tool_result / tool_error) is owned EXCLUSIVELY by ctx.dispatchTool — it emits exactly one
   * tool_called + one tool_result/tool_error per dispatched call. Pi ALSO fires
   * tool_execution_start/end for the same call, so relaying them here produced DUPLICATE and
   * sometimes CONTRADICTING events (a dispatchTool tool_error followed by Pi's tool_result for the
   * same id). We drop Pi's tool events entirely; the dispatcher is the single tool-event authority.
   */
  private async forwardEvent(
    event: unknown,
    ctx: RunContext,
    emit: (e: NeutralEventInput) => unknown,
  ): Promise<void> {
    const e = event as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
    if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') {
      await emit({
        type: 'text_delta',
        runId: ctx.runId,
        text: e.assistantMessageEvent.delta ?? '',
      });
    }
    // tool_execution_start/end are DELIBERATELY ignored — ctx.dispatchTool owns the tool lifecycle.
  }

  /** Deterministic per-run hash used as the llm idempotency-key prefix. */
  private runHash(spec: AgentSpec): string {
    return hashJson({ name: spec.name, input: spec.input, model: spec.model });
  }

  /**
   * Replay reconstruction: rebuild the neutral RunResult from the neutral journal +
   * the rehydrated ConversationStore WITHOUT creating a live session. Returns null if the run is not
   * journaled (the first llm step is not cached) — no live re-run masquerading as replay.
   */
  private async replayFromJournal(
    spec: AgentSpec,
    authMode: AuthMode,
    ctx: RunContext,
  ): Promise<RunResult | null> {
    const first = await ctx.journal.lookup(`llm:${this.runHash(spec)}:0`);
    if (!first) return null;

    let lastOutput = first.output as PiLlmStepOutput | null;
    let llmStepCount = 1;
    // The FINAL step records turnCount; trust it when present. Otherwise probe forward, BOUNDED by
    // maxTurns (a run can never have more llm steps than turns) so a degenerate journal can't loop.
    const maxProbe = lastOutput?.turnCount ?? Math.max(1, spec.maxTurns);
    for (let i = 1; i < maxProbe; i++) {
      const next = await ctx.journal.lookup(`llm:${this.runHash(spec)}:${i}`);
      if (!next) break;
      lastOutput = next.output as PiLlmStepOutput | null;
      llmStepCount++;
    }

    const finalText = lastOutput?.finalText ?? '';
    const output = spec.outputSchema ? (lastOutput?.output ?? null) : null;

    const rehydrated = ctx.rehydrate
      ? prependTrustedSystem(spec, stripLeadingSystem(await ctx.rehydrate()))
      : deriveConversationStub(spec, finalText);
    const toolStepCount = countToolParts(rehydrated);

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
      conversation: rehydrated,
      // Usage/cost DROPPED on replay (no new spend) — metered on the live run.
      usage: emptyUsage(),
      costUsd: 0,
      stepCount: llmStepCount + toolStepCount,
    };
  }
}

// ---------------------------------------------------------------------------------------
// SDK-type-free structural views + helpers
// ---------------------------------------------------------------------------------------

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

/** A Pi ToolCall content block: { type:'toolCall', id, name, arguments }. */
interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  // toolCall block
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface PiMessage {
  role: string;
  content?: PiContentBlock[] | string;
  usage?: PiUsage;
  // ToolResultMessage fields
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  // AssistantMessage terminal-state fields (pi-ai types.d.ts:221-222) — a failed turn is
  // encoded as stopReason "error"/"aborted" + errorMessage (the StreamFn no-throw failure contract).
  stopReason?: string;
  errorMessage?: string;
}

/** The neutral projection persisted as the FINAL llm step output (the replay source). */
interface PiLlmStepOutput {
  finalText?: string;
  output?: unknown;
  turnCount?: number;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/** Map Pi's per-message Usage to the neutral Usage, carrying cache tokens (pi-ai types.d.ts:189). */
function neutralUsageFromPi(u: PiUsage | undefined): Usage {
  const inputTokens = u?.input ?? 0;
  const outputTokens = u?.output ?? 0;
  const usage: Usage = {
    inputTokens,
    outputTokens,
    totalTokens: u?.totalTokens ?? inputTokens + outputTokens,
  };
  if (typeof u?.cacheRead === 'number' && u.cacheRead > 0) usage.cacheReadTokens = u.cacheRead;
  if (typeof u?.cacheWrite === 'number' && u.cacheWrite > 0)
    usage.cacheCreationTokens = u.cacheWrite;
  return usage;
}

/**
 * Detect a terminal UPSTREAM failure encoded in the message history when
 * prompt() RESOLVED without throwing. pi-agent-core's StreamFn contract (pi-agent-core types.d.ts:7-10)
 * encodes a request/model/runtime failure as the FINAL AssistantMessage with stopReason "error"/
 * "aborted" + an errorMessage (NOT a throw). Returns that errorMessage (the real upstream cause) when
 * the LAST assistant message is such a failure, else undefined (the run genuinely succeeded). We only
 * inspect the LAST assistant turn: an earlier "error" turn that was retried + succeeded must NOT count.
 */
function terminalAssistantError(messages: PiMessage[]): string | undefined {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return undefined;
  if (lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted') {
    return (
      lastAssistant.errorMessage ?? `pi run failed (stopReason=${String(lastAssistant.stopReason)})`
    );
  }
  return undefined;
}

function extractText(msg: PiMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('');
  }
  return '';
}

function tryParseJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function countToolParts(conversation: ConvTurn[]): number {
  let n = 0;
  for (const turn of conversation) {
    for (const part of turn.parts) if (part.kind === 'tool_call') n++;
  }
  return n;
}

// ---------------------------------------------------------------------------------------
// REAL conversation re-derivation from Pi's message history
// ---------------------------------------------------------------------------------------

/**
 * Re-derive the neutral transcript from Pi's REAL message history (session.messages).
 * The system turn is the TRUSTED spec.instructions (the untrusted-content boundary) — never from message content.
 *
 *  - assistant text block      -> assistant turn, text part
 *  - assistant thinking block  -> assistant turn, reasoning part
 *  - assistant toolCall block  -> assistant turn, tool_call part (toolCallId = block.id)
 *  - toolResult message        -> tool turn, tool_result part (toolCallId = msg.toolCallId)
 *  - user message              -> user turn, text part
 * tool_call/tool_result correlate by Pi's real id (ToolCall.id / ToolResultMessage.toolCallId).
 */
export function deriveConversation(spec: AgentSpec, messages: PiMessage[]): ConvTurn[] {
  const turns: ConvTurn[] = [];
  let index = 0;
  const push = (role: ConvTurn['role'], parts: ConvPart[]): void => {
    if (parts.length === 0) return;
    turns.push({ role, index: index++, parts });
  };

  // Untrusted-content boundary: trusted system instructions, never from message content. The trusted user input is the
  // spec.input we sent (Pi folds instructions+input into one prompt, so the stored 'user' message
  // would echo both — we use the trusted spec.input instead).
  push('system', [{ kind: 'text', text: spec.instructions }]);
  push('user', [{ kind: 'text', text: spec.input }]);

  let sawAssistantText = false;
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          push('assistant', [{ kind: 'text', text: block.text }]);
          sawAssistantText = true;
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          push('assistant', [{ kind: 'reasoning', text: block.thinking }]);
        } else if (block.type === 'toolCall' && block.id && block.name) {
          push('assistant', [
            {
              kind: 'tool_call',
              toolCallId: String(block.id),
              name: String(block.name),
              args: block.arguments ?? null,
            },
          ]);
        }
      }
    } else if (msg.role === 'toolResult' && msg.toolCallId) {
      push('tool', [
        {
          kind: 'tool_result',
          toolCallId: String(msg.toolCallId),
          name: msg.toolName ?? toolNameForCall(turns, String(msg.toolCallId)),
          result: normalizeToolResultContent(msg.content),
        },
      ]);
    }
    // role 'user' messages from history are the echoed prompt — not re-injected (we used spec.input).
  }

  if (!sawAssistantText) {
    // Defensive: ensure the transcript ends on the model's final answer if no text block surfaced.
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const finalText = lastAssistant ? extractText(lastAssistant) : '';
    if (finalText) push('assistant', [{ kind: 'text', text: finalText }]);
  }
  return turns;
}

/** Find the tool name for a tool id from an already-pushed tool_call part (correlation). */
function toolNameForCall(turns: ConvTurn[], toolCallId: string): string {
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind === 'tool_call' && part.toolCallId === toolCallId) return part.name;
    }
  }
  return 'tool';
}

/** Normalize a toolResult message's content (string | array of text blocks) into neutral DATA. */
function normalizeToolResultContent(content: unknown): unknown {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  if (Array.isArray(content)) {
    const text = content
      .map((c) =>
        c && typeof c === 'object' && 'text' in (c as Record<string, unknown>)
          ? String((c as { text: unknown }).text)
          : '',
      )
      .join('');
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return content;
  }
  return content ?? null;
}

/** Prepend the TRUSTED system turn (spec.instructions) and re-index (the untrusted-content boundary: never from store). */
function prependTrustedSystem(spec: AgentSpec, rest: ConvTurn[]): ConvTurn[] {
  const trustedSystem: ConvTurn = {
    role: 'system',
    index: 0,
    parts: [{ kind: 'text', text: spec.instructions }],
  };
  const reindexed = rest.map((t, i) => ({ ...t, index: i + 1 }));
  return [trustedSystem, ...reindexed];
}

/** Strip a leading coerced-system turn so the trusted system turn can be re-prepended (replay). */
function stripLeadingSystem(rehydrated: ConvTurn[]): ConvTurn[] {
  const rest = [...rehydrated];
  const head = rest[0];
  if (head?.role === 'system') {
    rest.shift();
  } else if (head?.role === 'user' && head.parts.length === 1 && head.parts[0]?.kind === 'text') {
    rest.shift();
  }
  return rest;
}

/** Last-resort fallback (system / user / assistant text only). */
function deriveConversationStub(spec: AgentSpec, finalText: string): ConvTurn[] {
  const turns: ConvTurn[] = [
    { role: 'system', index: 0, parts: [{ kind: 'text', text: spec.instructions }] },
    { role: 'user', index: 1, parts: [{ kind: 'text', text: spec.input }] },
  ];
  if (finalText) {
    turns.push({ role: 'assistant', index: 2, parts: [{ kind: 'text', text: finalText }] });
  }
  return turns;
}

function errorResult(
  runId: string,
  backend: 'pi',
  authMode: AuthMode,
  error: string,
  errorClass: ErrorClass,
): RunResult {
  return {
    runId,
    backend,
    authMode,
    status: 'error',
    finalText: '',
    // Key-presence: output + error ALWAYS present.
    output: null,
    error,
    // The neutral error class on the error path (always-present).
    errorClass,
    conversation: [],
    usage: emptyUsage(),
    costUsd: 0,
    stepCount: 1,
  };
}
