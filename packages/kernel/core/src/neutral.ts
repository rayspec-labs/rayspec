/**
 * RaySpec neutral types — the single neutral surface every backend adapter maps to.
 *
 * This is the core bet: one neutral interface that the OpenAI Agents SDK,
 * the Anthropic Claude Agent SDK, and Pi all map onto WITHOUT a lossy/mangled mapping.
 * No SDK type may appear here. Adapters are anti-corruption layers that translate
 * SDK-native shapes <-> these neutral shapes in-process.
 *
 * Everything is Zod-first so the same definitions validate at runtime and (later)
 * export to JSON Schema for the HTTP edge.
 *
 * The neutral surface is additive-only: generalized past the initial happy single-turn path
 * WITHOUT collapsing toward the weakest backend (the no-lowest-common-denominator kill-criterion).
 * All asymmetry (Anthropic cache tokens, Pi's lack of native structured output, Pi's lack
 * of event correlation ids) is expressed in the extended Usage + the capability descriptor +
 * platform-assigned event seq — never by weakening a neutral type.
 */
import { z } from 'zod';
import { ERROR_CLASSES } from './error-class.js';

/** Which backend ran a step / a run. */
// 'codex' is the 4th backend (additive) — the OpenAI/ChatGPT Codex SDK on the ChatGPT OAuth
// subscription. Appended, never reordered; the existing members stay byte-identical.
export const BackendId = z.enum(['openai', 'anthropic', 'pi', 'codex']);
export type BackendId = z.infer<typeof BackendId>;

/**
 * How a run authenticated, per backend. Recorded on every run + journal step for
 * audit/compliance. Never one global flag.
 */
export const AuthMode = z.enum([
  'api-key',
  'subscription-oauth-official-harness',
  // (additive): the OpenAI/ChatGPT Codex backend authenticated via the OFFICIAL `codex` CLI
  // ChatGPT OAuth session (~/.codex/auth.json — auth_mode:'chatgpt' + tokens, no api key). A run on
  // this mode draws the subscription (no per-token API billing) — isSubscriptionBilling treats it as
  // billed=$0, exactly like the Anthropic official-harness path. Distinct member so the journal/audit
  // attributes a Codex run to the SANCTIONED OpenAI subscription path, never conflated with api-key.
  'codex-subscription-oauth',
  // No usable credential was resolved (e.g. neither a token nor a live OAuth session).
  // Recorded truthfully on failed/unauthenticated runs instead of overclaiming a
  // subscription path the run never actually used.
  'unauthenticated',
  // present for completeness / config-validation; never produced by a real run:
  'subscription-oauth-thirdparty-DISALLOWED',
]);
export type AuthMode = z.infer<typeof AuthMode>;

/**
 * A neutral tool the agent may call. The handler runs in OUR process (the adapter
 * bridges the SDK's tool-call into this). `parameters` is a JSON-Schema object so it
 * is SDK-agnostic; adapters convert to each SDK's native tool shape.
 */
export const ToolSpec = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** JSON-Schema (draft 2020-12) object describing the tool arguments. */
  parameters: z.record(z.string(), z.unknown()),
});
export type ToolSpec = z.infer<typeof ToolSpec>;

/**
 * Structured-output request. When set, the run must return JSON matching this schema.
 * Kept as JSON-Schema (not a live Zod object) so it crosses the neutral boundary cleanly
 * (invariant: ToolSpec/AgentSpec stay JSON-Schema; nothing moves on SDK churn).
 *
 * `.strict()` (fail-closed): the WRAPPER object carries exactly `name` + `schema` — a typo'd or
 * stray sibling key (e.g. `schemaa`/`bogus`) is REJECTED, not silently dropped. The inner
 * `schema` stays an open `z.record` (it IS a free-form JSON-Schema, validated separately by ajv).
 * This keeps runtime == the exported JSON-Schema (`additionalProperties:false` on the wrapper) ==
 * this docstring, and makes a config-layer `agents[].outputSchema` typo a fail-closed error.
 */
export const OutputSchemaSpec = z
  .object({
    name: z.string().min(1),
    schema: z.record(z.string(), z.unknown()),
  })
  .strict();
export type OutputSchemaSpec = z.infer<typeof OutputSchemaSpec>;

/**
 * The neutral, backend-agnostic description of an agent run request.
 * The SAME AgentSpec must run on >=2 backends and produce an identical
 * RunResult shape (the neutral-surface acceptance).
 */
export const AgentSpec = z.object({
  /** Stable identifier for this agent definition (for journaling/replay). */
  name: z.string().min(1),
  /** System / developer instructions. */
  instructions: z.string(),
  /** Model identifier (backend-specific string, e.g. an OpenAI model id). */
  model: z.string().min(1),
  /** The user input / task for this run. */
  input: z.string(),
  /** Optional neutral tools. */
  tools: z.array(ToolSpec).default([]),
  /** Optional structured-output contract. */
  outputSchema: OutputSchemaSpec.optional(),
  /** Hard cap on agent loop turns (safety). */
  maxTurns: z.number().int().positive().default(8),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

// ---------------------------------------------------------------------------------------
// Conversation: ConvTurn / ConvPart (replaces the flat ConvItem)
// ---------------------------------------------------------------------------------------

/**
 * The kind of a single conversation PART. A re-derivable transcript is an ordered list of
 * turns, each an ordered list of typed parts. tool_call / tool_result carry a `toolCallId`
 * so a call and its result PAIR UP across an agent loop (the exact correlation a flat
 * {role,content} item dropped, corrupting replay/audit/the untrusted-content boundary).
 * This enum is MIRRORED by NeutralEvent (below) so events and
 * transcript parts speak the same vocabulary.
 */
export const ConvPartKind = z.enum([
  'text',
  'reasoning',
  'tool_call',
  'tool_result',
  'output',
  'error',
]);
export type ConvPartKind = z.infer<typeof ConvPartKind>;

/**
 * A single typed conversation part — a discriminated union on `kind`. This is the unit the
 * untrusted-content read validator checks: a persisted transcript is ATTACKER-CONTROLLED data, so each
 * part is validated on the way out of the store (a part that does not match its variant is
 * DROPPED, never trusted). tool parts carry `toolCallId` for call/result correlation.
 */
export const ConvPart = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('reasoning'), text: z.string() }),
  z.object({
    kind: z.literal('tool_call'),
    /** Correlation id pairing this call with its result. */
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    args: z.unknown(),
  }),
  z.object({
    kind: z.literal('tool_result'),
    /** Correlation id pairing this result with its call. */
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    result: z.unknown(),
  }),
  /** A structured-output payload emitted by the run. */
  z.object({ kind: z.literal('output'), value: z.unknown() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export type ConvPart = z.infer<typeof ConvPart>;

/** The role that produced a turn. */
export const ConvRole = z.enum(['system', 'user', 'assistant', 'tool']);
export type ConvRole = z.infer<typeof ConvRole>;

/**
 * A conversation TURN: a role + an ordered list of typed parts + a 0-based turn index. This
 * is the re-derivable transcript unit (replaces the flat ConvItem). `RunResult.conversation`
 * is `ConvTurn[]`.
 */
export const ConvTurn = z.object({
  role: ConvRole,
  /** 0-based ordinal of this turn within the run (monotonic). */
  index: z.number().int().nonnegative(),
  /** Ordered parts of this turn (at least one). */
  parts: z.array(ConvPart),
});
export type ConvTurn = z.infer<typeof ConvTurn>;

/**
 * Read-path validator for a persisted transcript (the untrusted-content boundary). A `jsonb` transcript payload read
 * back from the store is ATTACKER-CONTROLLED data: it MUST be validated before use, never
 * trusted. This parses an unknown value into a typed `ConvTurn[]`, DROPPING any turn or part
 * that does not match the neutral shape (a malformed payload yields a clean, possibly empty
 * array — never a throw, never a trusted-but-malformed turn). Use this on every read of a
 * stored conversation (the rehydrate path) and wherever a `jsonb` transcript payload re-enters
 * the platform.
 *
 * Per-part validation (rather than a whole-array parse) means ONE poisoned part in an
 * otherwise-valid turn drops just that part, not the whole transcript — the fail-closed,
 * least-surprising behavior for an audit/replay read.
 */
export function validateConversation(raw: unknown): ConvTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ConvTurn[] = [];
  for (const rawTurn of raw) {
    if (rawTurn === null || typeof rawTurn !== 'object') continue;
    const t = rawTurn as Record<string, unknown>;
    const role = ConvRole.safeParse(t.role);
    const index = z.number().int().nonnegative().safeParse(t.index);
    if (!role.success || !index.success) continue;
    const rawParts = Array.isArray(t.parts) ? t.parts : [];
    const parts: ConvPart[] = [];
    for (const rawPart of rawParts) {
      const parsed = ConvPart.safeParse(rawPart);
      if (parsed.success) parts.push(parsed.data);
    }
    // A turn with NO surviving parts is itself dropped (an empty turn carries no data).
    if (parts.length === 0) continue;
    turns.push({ role: role.data, index: index.data, parts });
  }
  return turns;
}

// ---------------------------------------------------------------------------------------
// Usage (extended) + cost
// ---------------------------------------------------------------------------------------

/**
 * Token usage for a step or a run. Neutral across SDKs.
 *
 * The earlier 3-field Usage DROPPED Anthropic's cache tokens and OpenAI's reasoning
 * tokens. The optional fields below carry that asymmetry WITHOUT weakening the type
 * (no lowest-common-denominator collapse):
 *  - cacheReadTokens / cacheCreationTokens map to Anthropic usage
 *    `cache_read_input_tokens` / `cache_creation_input_tokens`
 *    (verified in @anthropic-ai/claude-agent-sdk@0.3.185 sdk.d.ts:2913-2914).
 *  - reasoningTokens maps to OpenAI Responses usage `output_tokens_details.reasoning_tokens`,
 *    surfaced via @openai/agents-core@0.11.8 Usage.outputTokensDetails (usage.d.ts:
 *    `outputTokensDetails: Array<Record<string, number>>`).
 * The neutral type is merely MADE ABLE to carry them; whether a given adapter populates them is
 * per-backend. Optional (absent == not reported by this backend) so the
 * happy single-turn shape is unchanged.
 */
export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** Anthropic `cache_read_input_tokens` (sdk.d.ts:2914). Absent on backends without caching. */
  cacheReadTokens: z.number().int().nonnegative().optional(),
  /** Anthropic `cache_creation_input_tokens` (sdk.d.ts:2913). */
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  /** OpenAI `output_tokens_details.reasoning_tokens` (agents-core Usage.outputTokensDetails). */
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

// ---------------------------------------------------------------------------------------
// NeutralEvent v2 (additive, fail-closed vocabulary)
// ---------------------------------------------------------------------------------------

/**
 * A neutral streaming event. Adapters normalize each SDK's native event stream
 * into this small vocabulary (capability-negotiation is fail-closed: an SDK that
 * cannot emit a given event simply never produces it).
 *
 * Invariants:
 *  - EVERY event carries `runId` + a monotonic `seq` ASSIGNED AT PLATFORM INGEST. Pi events
 *    carry no correlation id, so seq is platform-assigned (see `makeEventIngest` below), never
 *    SDK-provided — this gives Pi the same ordering guarantee as the others without any
 *    lowest-common-denominator collapse.
 *  - `run_completed` carries the terminal `status` AND the aggregate `usage`.
 *  - a `tool_error` event is added (dispatchTool fail-closed surface; mirrors ConvPart 'error').
 *  - tool/part-referencing events mirror the ConvPartKind vocabulary + carry `toolCallId`.
 */
export const NeutralEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_started'),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('text_delta'),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('reasoning_delta'),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_called'),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    toolCallId: z.string(),
    name: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    toolCallId: z.string(),
    name: z.string(),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_error'),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    toolCallId: z.string(),
    name: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('turn_completed'),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('run_completed'),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    status: z.enum(['ok', 'error']),
    /** Aggregate usage across the whole run (terminal frame). */
    usage: Usage,
  }),
]);
export type NeutralEvent = z.infer<typeof NeutralEvent>;

/**
 * An event as an adapter produces it: WITHOUT the platform-assigned `seq`. The platform's
 * ingest helper stamps a monotonic `seq` per run. (runId is set by the adapter from ctx.)
 */
export type NeutralEventInput =
  | Omit<Extract<NeutralEvent, { type: 'run_started' }>, 'seq'>
  | Omit<Extract<NeutralEvent, { type: 'text_delta' }>, 'seq'>
  | Omit<Extract<NeutralEvent, { type: 'reasoning_delta' }>, 'seq'>
  | Omit<Extract<NeutralEvent, { type: 'tool_called' }>, 'seq'>
  | Omit<Extract<NeutralEvent, { type: 'tool_result' }>, 'seq'>
  | Omit<Extract<NeutralEvent, { type: 'tool_error' }>, 'seq'>
  | Omit<Extract<NeutralEvent, { type: 'turn_completed' }>, 'seq'>
  | Omit<Extract<NeutralEvent, { type: 'run_completed' }>, 'seq'>;

/**
 * Build a monotonic-seq ingest helper for ONE run. Returns a function that takes a
 * seq-less event and returns the full NeutralEvent with a per-run monotonic `seq`
 * (0,1,2,...) stamped AT INGEST. This is the platform's single seq authority — Pi (no SDK
 * correlation id) and the SDKs that do correlate all get the same total order from here, so
 * the neutral event stream is uniformly ordered regardless of backend.
 */
export function makeEventIngest(): (event: NeutralEventInput) => NeutralEvent {
  let seq = 0;
  return (event: NeutralEventInput): NeutralEvent => {
    const stamped = { ...event, seq: seq++ } as NeutralEvent;
    return stamped;
  };
}

// ---------------------------------------------------------------------------------------
// RunResult (key-presence: output + error ALWAYS present)
// ---------------------------------------------------------------------------------------

/**
 * The neutral result of a run. THIS is the shape that must be IDENTICAL across
 * backends for the neutral surface to hold. `backend` and `authMode` differ by definition;
 * everything structural (status, output, transcript, usage, cost, journal) is uniform.
 *
 * ALWAYS-PRESENT key-presence: `output` and `error` are NOT `.optional()`, so "identical shape"
 * is LITERALLY true across multi-turn/tool/error/no-output. `null` is the "no value" sentinel:
 * `output: null` when there is no structured output; `error: null` on success. `conversation`
 * is `ConvTurn[]`.
 */
export const RunResult = z.object({
  runId: z.string(),
  backend: BackendId,
  authMode: AuthMode,
  status: z.enum(['completed', 'error']),
  /** Final assistant text (always present). */
  finalText: z.string(),
  /**
   * Parsed structured output. ALWAYS PRESENT: the value when an
   * outputSchema was requested, else `null`. Never omitted.
   */
  output: z.unknown(),
  /**
   * Error message. ALWAYS PRESENT: a string on error, `null` on success.
   * Never omitted.
   */
  error: z.string().nullable(),
  /**
   * Neutral upstream-error CLASS (OBS-01). ALWAYS PRESENT (mirroring `error`): one of the
   * neutral ErrorClass values on an error run, `null` on success. NOT `.optional()` — a present key
   * with a `null` sentinel, so the "identical shape" invariant + the cross-backend parity key-set
   * assertion both hold. NEUTRAL platform vocabulary: every adapter maps its own SDK error shape
   * into it (`classifyUpstreamError`); no backend-specific error shape leaks into the neutral result.
   */
  errorClass: z.enum(ERROR_CLASSES).nullable(),
  /** Re-derived neutral transcript (turns of typed parts). */
  conversation: z.array(ConvTurn),
  /** Aggregate usage across all steps. */
  usage: Usage,
  /** Aggregate cost in USD (micro-dollar precision kept as a float). */
  costUsd: z.number().nonnegative(),
  /** Number of journaled steps. */
  stepCount: z.number().int().nonnegative(),
});
export type RunResult = z.infer<typeof RunResult>;

/**
 * VERIFIED (Zod 4.4.3): a field declared `z.unknown()` is REQUIRED-with-presence in
 * the inferred type — the inferred key is `output: unknown` (not `output?: unknown`), and
 * `RunResult.parse({...})` REJECTS an object that OMITS the `output` key (proven by the
 * neutral.test.ts "REJECTS a result that omits the always-present `error` key" case, which uses the
 * same z.unknown()-style presence). So the schema ITSELF already enforces presence; no widened
 * companion type is needed.
 *
 * The runtime `assertRunResultKeyPresence` below is the belt-and-suspenders OWN-KEY presence check
 * (presence, not truthiness — `null`/`undefined` values are fine; an OMITTED key is the violation).
 * run-core calls it before returning so a programmatic return site that forgets a key fails loudly,
 * not just a schema-parsed input. It returns the value unchanged (typed RunResult) on success.
 */
export function assertRunResultKeyPresence(r: RunResult): RunResult {
  if (!Object.hasOwn(r, 'output')) {
    throw new Error('RunResult key-presence (D1): `output` key is missing — set it to null.');
  }
  if (!Object.hasOwn(r, 'error')) {
    throw new Error('RunResult key-presence (D1): `error` key is missing — set it to null.');
  }
  // OBS-01: errorClass is always-present too — a backend that forgets it (on the success OR
  // error path) fails LOUDLY here, never silently weakening the identical-shape claim.
  if (!Object.hasOwn(r, 'errorClass')) {
    throw new Error(
      'RunResult key-presence (D1): `errorClass` key is missing — set it (null on success).',
    );
  }
  return r;
}

// ---------------------------------------------------------------------------------------
// Per-step journal
// ---------------------------------------------------------------------------------------

/** The kind of step recorded in the per-step run journal. */
export const StepType = z.enum(['llm', 'tool', 'store']);
export type StepType = z.infer<typeof StepType>;

/**
 * One per-step run-journal record. Transactional,
 * append-only, tenant-scoped. The single source of truth for replay, cost, audit.
 */
export const JournalStep = z.object({
  stepId: z.string(),
  runId: z.string(),
  tenantId: z.string(),
  backend: BackendId,
  type: StepType,
  /** Idempotency key — identical (runId, idempotencyKey) replays the cached step. */
  idempotencyKey: z.string(),
  /** Hash of the step input (for replay cache lookup + audit). */
  inputHash: z.string(),
  output: z.unknown(),
  usage: Usage,
  /** The COMPUTED cost (USD) from the effective-dated pricing registry. */
  costUsd: z.number().nonnegative(),
  /**
   * The PROVIDER-REPORTED cost (USD), or null when the backend reports none (OpenAI):
   * reconciled against costUsd; never fabricated.
   */
  providerCostUsd: z.number().nonnegative().nullable().optional(),
  /**
   * The BILLED cost (USD): 0 for a subscription run (auth_mode =
   * 'subscription-oauth-official-harness'; draws subscription limits, no per-token API billing), else
   * the computed cost. The attributed (computed/provider) cost is still recorded as a value metric.
   */
  billedCostUsd: z.number().nonnegative().optional(),
  /** True iff |computed - provider| exceeds the documented drift threshold. */
  costDrift: z.boolean().optional(),
  /** Provenance: the pricing entry/version that computed this step (`<model>@<effectiveFrom>`/FALLBACK). */
  pricingVersion: z.string().optional(),
  /** Provenance: the SDK + adapter version that produced this step. */
  producedBy: z.string().nullable().optional(),
  latencyMs: z.number().nonnegative(),
  status: z.enum(['ok', 'error']),
  authMode: AuthMode,
  createdAt: z.string(),
});
export type JournalStep = z.infer<typeof JournalStep>;

// ---------------------------------------------------------------------------------------
// Capability descriptor + validateSpec (fail-closed)
// ---------------------------------------------------------------------------------------

/**
 * What a backend can natively do. The descriptor is EXACTLY how per-backend asymmetry is
 * expressed without an LCD collapse: instead of weakening the neutral type to Pi's
 * weakest feature, we record per-backend capabilities and reject (fail-closed) a spec that
 * needs a capability the chosen backend lacks.
 *
 * `nativeStructuredOutput` is the canonical case: OpenAI + Anthropic have native structured
 * output; Pi does NOT (it emulates via instructions — the lone documented exception). A spec
 * whose outputSchema demands NATIVE structured output is therefore accepted for openai/anthropic
 * but rejected for pi up front.
 */
export const CapabilityDescriptor = z.object({
  /** Backend can produce schema-validated structured output natively (no prompt emulation). */
  nativeStructuredOutput: z.boolean(),
  /**
   * Backend emulates structured output via instructions + parse (NOT native). The lone
   * documented exception lives here (Pi): a spec that does NOT demand native may still run on
   * an emulating backend.
   */
  emulatedStructuredOutput: z.boolean(),
  /** Backend can execute neutral tools (dispatched through the platform dispatchTool). */
  tools: z.boolean(),
  /** Backend can emit a streaming event vocabulary (text deltas etc.). */
  streaming: z.boolean(),
  /** Backend can surface reasoning/thinking content as reasoning parts. */
  reasoning: z.boolean(),
  /** Backend authenticates via an OAuth subscription official-harness path (not just API key). */
  subscriptionAuth: z.boolean(),
});
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptor>;

/**
 * Per-backend capability registry. The single source of truth for what each backend can do.
 * Verified against the installed, pinned SDKs (doc-first):
 *  - openai (@openai/agents 0.11.8): native structured output (`outputType` JsonSchemaDefinition),
 *    tools, streaming, reasoning (o-series), API key only (no subscription path).
 *  - anthropic (@anthropic-ai/claude-agent-sdk 0.3.185): native structured output
 *    (`outputFormat`), tools (in-proc MCP), streaming, reasoning, subscription official-harness.
 *  - pi (@earendil-works/pi-coding-agent 0.79.9): NO native structured output (emulated via
 *    instructions + parse — the lone documented exception), tools, streaming, reasoning,
 *    API key only.
 */
export const CAPABILITIES: Record<BackendId, CapabilityDescriptor> = {
  openai: {
    nativeStructuredOutput: true,
    emulatedStructuredOutput: false,
    tools: true,
    streaming: true,
    reasoning: true,
    subscriptionAuth: false,
  },
  anthropic: {
    nativeStructuredOutput: true,
    emulatedStructuredOutput: false,
    tools: true,
    streaming: true,
    reasoning: true,
    subscriptionAuth: true,
  },
  pi: {
    // Pi has NO native structured output (the lone documented exception); it EMULATES.
    nativeStructuredOutput: false,
    emulatedStructuredOutput: true,
    tools: true,
    streaming: true,
    reasoning: true,
    subscriptionAuth: false,
  },
  // codex (@openai/codex-sdk 0.142.2): native structured output (--output-schema →
  // finalResponse JSON), tools (in-proc streamable-HTTP MCP bridge → ctx.dispatchTool), streaming
  // (runStreamed yields events — though text arrives as whole agent_message items, not token-level
  // deltas; the documented per-backend text_delta CONTENT difference, AC-07), reasoning (codex
  // surfaces reasoning summaries), subscriptionAuth TRUE — codex IS the OpenAI subscription backend
  // (ChatGPT OAuth). Verified doc-first + a live subscription probe.
  codex: {
    nativeStructuredOutput: true,
    emulatedStructuredOutput: false,
    tools: true,
    streaming: true,
    reasoning: true,
    subscriptionAuth: true,
  },
};

/** Look up a backend's capability descriptor. */
export function capabilitiesFor(backend: BackendId): CapabilityDescriptor {
  return CAPABILITIES[backend];
}

/** A single fail-closed validation problem (which capability the spec needs but the backend lacks). */
export interface CapabilityViolation {
  capability: keyof CapabilityDescriptor;
  message: string;
}

/** The result of validateSpec: ok=true means safe to run; otherwise a list of violations. */
export type ValidateSpecResult = { ok: true } | { ok: false; violations: CapabilityViolation[] };

/**
 * Validate a spec against a backend's capabilities — FAIL-CLOSED.
 *
 * Rejects a spec that needs a capability the backend lacks. The canonical case: a spec with an
 * `outputSchema` requires structured output; on a backend with NEITHER native NOR emulated
 * structured output it is rejected. By default `requireNativeStructuredOutput` is false, so an
 * outputSchema is accepted on Pi (emulated). Set it true to DEMAND native — then Pi is rejected
 * up front while OpenAI + Anthropic (both native) accept. This is exactly how the per-backend asymmetry is
 * expressed WITHOUT collapsing the neutral type toward Pi's weakness.
 */
export function validateSpec(
  spec: AgentSpec,
  backend: BackendId,
  opts: { requireNativeStructuredOutput?: boolean } = {},
): ValidateSpecResult {
  const cap = capabilitiesFor(backend);
  const violations: CapabilityViolation[] = [];

  if (spec.outputSchema) {
    const wantsNative = opts.requireNativeStructuredOutput === true;
    if (wantsNative) {
      if (!cap.nativeStructuredOutput) {
        violations.push({
          capability: 'nativeStructuredOutput',
          message: `backend '${backend}' has no NATIVE structured output but the spec demands it`,
        });
      }
    } else if (!cap.nativeStructuredOutput && !cap.emulatedStructuredOutput) {
      violations.push({
        capability: 'nativeStructuredOutput',
        message: `backend '${backend}' cannot produce structured output (native or emulated)`,
      });
    }
  }

  if (spec.tools.length > 0 && !cap.tools) {
    violations.push({
      capability: 'tools',
      message: `backend '${backend}' cannot execute tools but the spec declares ${spec.tools.length}`,
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Throwing variant of validateSpec (fail-closed): rejects before a run is ever started. */
export function assertSpecValid(
  spec: AgentSpec,
  backend: BackendId,
  opts: { requireNativeStructuredOutput?: boolean } = {},
): void {
  const res = validateSpec(spec, backend, opts);
  if (!res.ok) {
    const detail = res.violations.map((v) => `${v.capability}: ${v.message}`).join('; ');
    throw new Error(
      `validateSpec: spec rejected for backend '${backend}' (fail-closed) — ${detail}`,
    );
  }
}
