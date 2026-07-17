/**
 * The TURN-RESPONDER PORT — the injected, tenant-bound seam through which a submitted
 * turn produces the REAL agent reply. PRODUCT- AND PLATFORM-NEUTRAL by design: this package never
 * imports the platform's `runAgent`/`Backend`/model machinery (Tier-B purity — model/backend names
 * are CONFIG-side, the extractor.json precedent); it exchanges only plain values. The LIVE
 * implementation (deterministic reply run-id derivation, run-header ATTACH, the in-request
 * `runAgent` call) lives in `@rayspec/product-yaml` (`makeLiveTurnResponder`), wired by the
 * deployment boot from the per-product `<agent_id>.responder.json`; tests inject a deterministic
 * fake.
 *
 * TENANT LAW: the binding builds a responder per request via `factory(init.tenantId)` — the
 * SERVER-DERIVED tenant, never a client value (the blobFactory/mintPlayToken closure trust shape).
 */

/** Token usage of one reply run (absent when the reply came from the ledger/attach — honest). */
export interface TurnReplyUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/**
 * The outcome of one responder invocation. `runId` is ALWAYS present — it is derived
 * DETERMINISTICALLY from the turn's ledger `turn_ref` (single-flight: a converging retry lands on the SAME
 * run), so even an error outcome names the run a client/operator can inspect.
 */
export type TurnReplyOutcome =
  | {
      readonly status: 'completed';
      readonly runId: string;
      readonly text: string;
      readonly usage?: TurnReplyUsage;
    }
  | {
      readonly status: 'error';
      readonly runId: string;
      /** The neutral error class when known (rate_limited | upstream_5xx | timeout | ...). */
      readonly errorClass?: string;
      readonly message: string;
    };

/**
 * The OPTIONAL bounded store-context read a responder declares (config-side, the
 * `STORE_READ` cap discipline): up to `limit` rows of ONE declared store, equality-filtered by
 * values of the CURRENT turn (the closed key set below), serialized as framed DATA into the model
 * input. Never retrieval/search — a bounded equality read (KB/retrieval is deliberately out of scope).
 */
export interface ConversationStoreContextRead {
  /** The DECLARED store to read (compose verifies it exists on the deployment). */
  readonly store: string;
  /**
   * Column → turn-payload key equality filter (e.g. `{ conversation: 'conversation_id' }`).
   * ABSENT/empty = the bounded whole-store read (a seeded catalog). Only the closed
   * `CONTEXT_FILTER_PAYLOAD_KEYS` are addressable — all server-derived values.
   */
  readonly filter?: Readonly<Record<string, ContextFilterPayloadKey>>;
  /** The row cap (the STORE_READ discipline; validated boot-side, belt-clamped at read time). */
  readonly limit: number;
}

/** The closed set of turn-payload keys a store-context filter may reference (server-derived). */
export const CONTEXT_FILTER_PAYLOAD_KEYS = ['conversation_id', 'message_id'] as const;
export type ContextFilterPayloadKey = (typeof CONTEXT_FILTER_PAYLOAD_KEYS)[number];

/** The bounded history window a responder declares (defaults = the config constants). */
export interface ResponderHistoryWindow {
  readonly turns: number;
  readonly chars: number;
}

/**
 * A tenant-bound turn responder. `respond` receives the ALREADY-ASSEMBLED trust-boundary-framed input (the
 * capability owns assembly — assemble.ts) plus the turn's tenant-prefixed ledger `turn_ref` (the
 * deterministic run-id source) and returns the reply outcome. It must be SAFE TO CALL AGAIN for
 * the same `turnRef` (the live impl ATTACHES to a completed run instead of re-invoking the model —
 * the crash-window convergence path; single-flight).
 *
 * `onEvent` (the streaming seam, unused in the non-streaming path): an optional live event sink the implementation forwards
 * into the run (the live impl threads it as `runAgent`'s `opts.onEvent`). Typed neutrally here
 * (this package imports no platform event types); the SSE leg passes it — no restructuring.
 */
export interface ConversationTurnResponder {
  /** The responder's agent id (config-derived; the reply run's `agentName`). */
  readonly agentId: string;
  /** The bounded history window (config-side; clamped to the capability config's bounds). */
  readonly historyWindow: ResponderHistoryWindow;
  /** The optional bounded store-context read (see the type doc). */
  readonly storeContext?: ConversationStoreContextRead;
  respond(args: {
    readonly input: string;
    readonly turnRef: string;
    readonly onEvent?: (event: unknown) => void | Promise<void>;
  }): Promise<TurnReplyOutcome>;
}

/** Build a tenant-bound responder for one request (tenantId is SERVER-DERIVED — `init.tenantId`). */
export type ConversationTurnResponderFactory = (tenantId: string) => ConversationTurnResponder;
