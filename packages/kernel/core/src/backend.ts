/**
 * The neutral Backend interface — one method, three adapters.
 *
 * Each SDK (OpenAI Agents, Anthropic Claude Agent SDK, Pi) is wrapped by exactly one
 * adapter implementing this interface. The platform's run-core calls `run()` and never
 * sees an SDK type. Streaming is delivered via an optional async event sink so the
 * neutral event stream (NeutralEvent) is uniform across SDKs (fail-closed: an SDK that
 * cannot emit an event simply doesn't).
 */
import type {
  AgentSpec,
  AuthMode,
  BackendId,
  ConvTurn,
  NeutralEvent,
  RunResult,
  ToolSpec,
  Usage,
} from './neutral.js';

/** Sink the run-core passes in to receive normalized streaming events. */
export type EventSink = (event: NeutralEvent) => void | Promise<void>;

/**
 * A first-class neutral tool: a ToolSpec the model can call PLUS the in-OUR-process handler
 * and the (optional) JSON-Schema in/out contracts the central dispatchTool enforces.
 *
 * Locked design:
 *  - `inputSchema` / `outputSchema` are JSON-SCHEMA objects (NOT live Zod), so a NeutralTool
 *    crosses the neutral boundary losslessly (mirrors ToolSpec.parameters / AgentSpec.outputSchema).
 *  - `timeoutMs` bounds the handler (AbortSignal-driven in dispatchTool).
 *  - `idempotent` is the replay contract: a `false` (side-effecting: send_email, charge_card)
 *    tool MUST NOT be re-fired on replay AND MUST NOT return a cached output as if re-run — on
 *    replay it surfaces a `tool_error` (fail-closed). An idempotent tool's output is safely cached.
 *
 * NOTE: all adapters route EVERY tool path through `ctx.dispatchTool` — the
 * `gate:adapter-handlers` allowlist is EMPTY across openai + anthropic + pi (no adapter has an inline
 * handler). NeutralTool is the contract the adapters marshal into.
 */
export interface NeutralTool {
  /** The model-facing tool declaration (name/description/JSON-Schema parameters). */
  spec: ToolSpec;
  /** The handler that runs in OUR process when the model calls this tool. */
  handler: (args: unknown, signal: AbortSignal) => Promise<unknown> | unknown;
  /** Optional JSON-Schema (draft 2020-12) validating the INPUT args before the handler runs. */
  inputSchema?: Record<string, unknown>;
  /** Optional JSON-Schema validating the handler OUTPUT before it is opaque-wrapped + journaled. */
  outputSchema?: Record<string, unknown>;
  /** Hard timeout for the handler (ms); the dispatcher aborts via AbortSignal on expiry. */
  timeoutMs: number;
  /**
   * Whether re-running the handler with the same args is SAFE (deterministic lookup) vs a
   * side effect (money/email). Drives the fail-closed replay contract in dispatchTool.
   */
  idempotent: boolean;
}

/** The opaque, journaled wrapper a successful tool dispatch returns (never raw handler output). */
export interface ToolData {
  kind: 'tool_data';
  /** The tool that produced this. */
  name: string;
  /** Correlation id of the originating tool_call. */
  toolCallId: string;
  /** The (validated, on success) handler output — treated as DATA, never instructions (untrusted-content boundary). */
  data: unknown;
}

/** The fail-closed error a tool dispatch returns (validate-in/out failure, timeout, replay block). */
export interface ToolError {
  kind: 'tool_error';
  name: string;
  toolCallId: string;
  message: string;
}

/** The neutral result of a single tool dispatch: opaque data on success, or a fail-closed error. */
export type ToolDispatchResult = ToolData | ToolError;

/** Per-run context the platform supplies (tenant scoping + journaling hooks + tool dispatch). */
export interface RunContext {
  runId: string;
  tenantId: string;
  /** Optional streaming sink. */
  onEvent?: EventSink;
  /**
   * Journal sink — the adapter calls this once per LLM/tool/store step. The platform
   * persists it (Postgres/Drizzle) and may short-circuit to a cached step on replay.
   */
  journal: JournalSink;
  /** Whether this run is a replay (return cached steps, do NOT re-call the model). */
  replay: boolean;
  /**
   * The run's resolved authentication mode. The platform resolves it ONCE from
   * `backend.resolveAuth()` and threads it onto the context so EVERY journaled step (the
   * adapter's `llm` steps AND the central `dispatchTool`'s `tool` steps) attributes to the
   * run's REAL authMode by construction — never a literal scattered in the tool path. Optional
   * for backwards compatibility; absent ⇒ the adapter falls back to its own resolveAuth().
   */
  authMode?: AuthMode;
  /**
   * Replay reconstruction source. On a replay where the LLM step(s)
   * are fully journaled, the DURABLE, upgrade-survivable replay source is the neutral journal +
   * the ConversationStore — NOT the SDK's RunState (which `fromString`-throws on a $schemaVersion
   * bump). The platform supplies this hook so the adapter can rebuild the neutral transcript on
   * replay WITHOUT calling the model, while staying SDK-agnostic and never importing the db. The
   * security read-path (tenant-scoped + per-part re-validation) lives behind this hook (run-core
   * wires it to `rehydrateConversation`). Absent ⇒ the adapter falls back to a derived stub.
   */
  rehydrate?: () => Promise<ConvTurn[]>;
  /**
   * The neutral tools available to this run (carried on the context; the adapters marshal
   * SDK tool-calls into `dispatchTool`).
   */
  tools?: NeutralTool[];
  /**
   * Central tool dispatch (the ONLY sanctioned tool path — adapters never hold handlers).
   * Owns: validate-in -> idempotency -> timeout -> handler -> validate-out -> opaque-wrap ->
   * one journaled step. Returns opaque `tool_data` on success or a fail-closed `tool_error`
   * (incl. on replay of a non-idempotent tool).
   *
   * `toolCallId` is the SDK's REAL per-call correlation id (OpenAI: details.toolCall.callId). The
   * adapter MUST pass it: it is the journal step's uniqueness key (so two byte-identical calls in
   * one run record DISTINCT rows and both fire) AND the id on the returned ToolData / emitted
   * events (so the journal step and the transcript tool_call/tool_result parts join on one id). The
   * dispatcher generates a uuid fallback if it is omitted, so a missing id can never collide.
   */
  dispatchTool?: (
    name: string,
    rawArgs: unknown,
    toolCallId?: string,
  ) => Promise<ToolDispatchResult>;
}

/** What an adapter reports for a single step; the platform stamps the rest. */
export interface StepReport {
  type: 'llm' | 'tool' | 'store';
  idempotencyKey: string;
  inputHash: string;
  output: unknown;
  /**
   * Token usage for this step. The extended optional fields (cacheReadTokens,
   * cacheCreationTokens, reasoningTokens) are carried through verbatim when present.
   */
  usage: Usage;
  /**
   * The adapter's own cost estimate. The AUTHORITATIVE computed cost is now derived in
   * run-core's journal sink FROM the effective-dated pricing registry at `record()` time (the journal
   * is the single source of truth). This field is retained for adapters that pre-compute it, but
   * run-core RE-COMPUTES the computed cost from the registry + records the provenance — so a stale or
   * fabricated adapter number can never become the ledger's computed cost.
   */
  costUsd: number;
  /**
   * The PROVIDER-REPORTED cost for this step, when the SDK surfaces one:
   *  - Anthropic: SDKResultSuccess.total_cost_usd (sdk.d.ts:3875) — set on the FINAL llm step.
   *  - Pi: Usage.cost.total (pi-ai types.d.ts:202) — set per assistant message.
   *  - OpenAI: NO provider cost field — left undefined (the journal records provider_cost_usd=null;
   *    we never fabricate a provider cost).
   * run-core reconciles this against the registry-COMPUTED cost and flags `cost_drift` on divergence.
   */
  providerCostUsd?: number;
  /**
   * The model identifier this step ran on. run-core needs it to look up the effective
   * price for the step. The adapter knows it (spec.model); a tool step carries the run's model so a
   * tool step is attributed to the same pricing context (its computed token cost is 0 regardless).
   */
  model?: string;
  /**
   * Provenance: which SDK + adapter version produced this step. Recorded
   * verbatim into journal_steps.produced_by so a journal row is traceable to the exact code/SDK that
   * wrote it — the linchpin of the version-bump-re-record rule (a fixture's pinned version is asserted
   * to equal the installed pinned version).
   */
  producedBy?: string;
  latencyMs: number;
  status: 'ok' | 'error';
}

/**
 * The platform's journal hook. Returns a cached step's output on replay (so the adapter
 * can skip the real model call), or null to proceed live.
 */
export interface JournalSink {
  /**
   * Look up a cached step by its `idempotencyKey` column value; null = not cached, run live. This
   * is the LLM-step replay path (the adapter computes a deterministic per-response key).
   */
  lookup(idempotencyKey: string): Promise<{ output: unknown } | null>;
  /**
   * Look up a cached idempotent TOOL step by its args `inputHash`: a tool step's
   * `idempotencyKey` column now carries the REAL per-call callId (unique per call), so the
   * idempotent-replay CACHE — which is keyed by args, not by call — must match on `inputHash`
   * instead. Returns the cached opaque tool output, or null to re-run live. Optional: a sink that
   * does not support tool-cache replay simply omits it (the dispatcher then re-runs idempotent
   * tools live on replay, which is safe).
   */
  lookupToolCache?(inputHash: string): Promise<{ output: unknown } | null>;
  /** Record a completed step. Returns the assigned stepId. */
  record(step: StepReport & { authMode: AuthMode }): Promise<string>;
}

/** The neutral backend contract. */
export interface Backend {
  readonly id: BackendId;
  /**
   * Resolve and validate how this backend will authenticate, BEFORE running.
   * Throws on a disallowed combo (e.g. Anthropic subscription token + raw SDK).
   * Detects a stray ANTHROPIC_API_KEY for the Anthropic adapter.
   */
  resolveAuth(): Promise<AuthMode>;
  /** Run the spec end-to-end, journaling each step, returning the neutral RunResult. */
  run(spec: AgentSpec, ctx: RunContext): Promise<RunResult>;
}
