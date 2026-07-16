/**
 * Product-neutral conversational-ingress model. A CONVERSATION is
 * one client-keyed multi-turn exchange; SUBMITTING A TURN persists the user message in the
 * capability-owned turn ledger and emits the `turn_submitted` trigger event a declared
 * Product-YAML workflow can run on. ZERO product vocabulary here — a message is arbitrary product
 * DATA (never instructions; the trust boundary).
 *
 * ── THE PAYLOAD CONTRACT (deliberate, gate-pinned) ──────────────────────────────────────
 * Every `turn_submitted` payload key is SERVER-DERIVED from the STORED ledger row (the file_input
 * closed-payload posture — the turn body's client fields are validated INTO the row first, never
 * merged raw): the identity envelope (`conversation_id`, `message_id`, `turn_ref`, `tenant_id`,
 * `source_capability`) plus the turn facts (`turn_seq`, `role`) plus the bounded MESSAGE TEXT.
 * The message TEXT rides the payload BY DESIGN (a deliberate decision, the record_input
 * precedent): it is the turn's business field, and top-level payload keys are what a declared
 * async workflow's `input_context.payload_fields` / `{ event: <field> }` sources can reach. The
 * byte cap (config.ts) is what keeps that journal-friendly. `CONVERSATION_EVENT_PAYLOAD_KEYS` is
 * the ONE source the manifest descriptor, the event construction, and the seam adapter all
 * consume (gate-pinned).
 *
 * THE MESSAGE BOUNDARY: `message` is attacker-controlled RAW DATA (and raw PII). It is
 * stored/forwarded VERBATIM (chat text legitimately carries newlines, RTL/bidi text, emoji — only
 * U+0000 is rejected, a Postgres `text` storage law) and must NEVER be interpreted as
 * instructions; any consumer that frames it into a model input owns the escaping (the
 * `assembleGenericInput` law). Display-grade fields (the conversation `title`) are the opposite:
 * shape-bounded + control/bidi/zero-width-rejected at intake.
 */

/**
 * The EXACT keys of every `turn_submitted` payload — all server-derived from the stored ledger row
 * (see the module header): the identity envelope, the turn facts, and the bounded message text.
 */
export const CONVERSATION_EVENT_PAYLOAD_KEYS = [
  'conversation_id',
  'message_id',
  'turn_ref',
  'tenant_id',
  'source_capability',
  'turn_seq',
  'role',
  'message',
] as const;

/** The conversation head lifecycle state (every conversation is `open`; closing is a later fork). */
export type ConversationState = 'open';

/**
 * The turn ledger lifecycle state. A USER row is terminal at `submitted`; the ASSISTANT reply
 * row is terminal at `replied` — it is persisted ONLY after its model run completed, so no
 * in-flight state exists on the ledger (the reply-in-progress window is represented by the ABSENCE
 * of the reply row; reply.ts documents the convergence law).
 */
export type TurnState = 'submitted' | 'replied';

/** The speaking role of one ledger row. A user turn is `user`; the assistant reply row is `assistant`. */
export type TurnRole = 'user' | 'assistant';

/**
 * The `conversation_input.turn_submitted` event — the workflow trigger shape. The `event_id` is
 * the TURN-scoped idempotency key (= `${tenant_id}:${conversation_id}:${message_id}`, the
 * record/file `submittedEventId` mirror), so a re-POST of the same message converges on ONE
 * workflow (C10 single-flight downstream) while every NEW turn gets its OWN run. Every field is
 * read from the AUTHORITATIVE stored ledger row (never a raw request), so a deduped redelivery is
 * byte-consistent with the first delivery.
 */
export interface SubmittedTurnEvent {
  /** Idempotency key for sink-level dedup (= `${tenant_id}:${conversation_id}:${message_id}`). */
  readonly event_id: string;
  /** Server-derived tenant boundary (never client-supplied). */
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly message_id: string;
  /**
   * The per-TURN composed idempotency field (= `${conversation_id}:${message_id}`, tenant-free —
   * keys.ts documents the two-composition split). THE `idempotency_key_field` of the descriptor.
   */
  readonly turn_ref: string;
  /** The turn's position in the conversation (1-based, assigned by the ledger). */
  readonly turn_seq: number;
  /** Always `user` (only user turns trigger workflows; the reply row emits nothing). */
  readonly role: 'user';
  /** The bounded message TEXT — RAW DATA, never instructions (the module-header boundary). */
  readonly message: string;
  /** Server timestamp (ISO-8601). */
  readonly occurred_at: string;
  /** The emitting capability id — always `conversation_input`. */
  readonly source_capability: 'conversation_input';
}

/**
 * The create route's success result (the `conversation_input.create` contract).
 *
 * TITLE SEMANTICS (deliberate): the create body's optional `title` is a CREATION-TIME
 * ASSERTION — the exact file `{ sha256? }` role (absent = no assertion; equal = dedup; divergent
 * = loud 409) — NOT mutable display state. There is NO title-update path in v1: no route can
 * change a stored title (a rename surface is a later slice/consumer decision, not an accidental
 * omission).
 */
export interface ConversationCreateResult {
  readonly conversation_id: string;
  /**
   * The conversation state after this create — ECHOED from the stored/authoritative head row
   * (never fabricated; only `open` is ever written).
   */
  readonly state: ConversationState;
  /** True when this create was an idempotent re-create of an existing conversation (C10). */
  readonly deduped: boolean;
}

/** The turn-submit route's success result (the `conversation_input.submit_turn` contract). */
export interface TurnSubmitResult {
  readonly conversation_id: string;
  readonly message_id: string;
  /** The persisted turn's 1-based sequence within the conversation. */
  readonly turn_seq: number;
  /**
   * The idempotency key of the `turn_submitted` event this submit emitted downstream (turn-scoped
   * — a re-POST of the same message_id re-emits the SAME id and dedups to one workflow).
   */
  readonly event_id: string;
  /**
   * True when this submit was an IDENTICAL re-POST of an already-persisted message (the STORED
   * authoritative event was re-emitted for redelivery and dedups downstream — client retry =
   * redelivery, C10).
   */
  readonly deduped: boolean;
}

/** A typed error body a capability route returns (mapped to the proper HTTP status by the binding). */
export interface ConversationErrorBody {
  readonly error: string;
  readonly detail: string;
}

/**
 * The REPLY block of a turn-submit response: the assistant reply produced IN-REQUEST by
 * the responder run. `turn_seq` is the reply row's OWN ledger position — under a race with the
 * user's NEXT turn it may be greater than `<user turn_seq>+1` (the honest seq-ordering law,
 * reply.ts module header); the reply↔user-turn association is the derived reply message id
 * (`reply~<user message_id>`), never seq adjacency. `usage` is present only for a FRESH model run
 * (a ledger/attach-served reply reports none — honest, the run header stores no token counts).
 */
export interface TurnReplyBlock {
  /** The assistant reply TEXT (DATA — the model's output, stored verbatim in the ledger). */
  readonly message: string;
  /** The reply row's own 1-based ledger sequence. */
  readonly turn_seq: number;
  /** The reply run's id (deterministic from the user turn's `turn_ref` — C10 convergence). */
  readonly run_id: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}

/** The turn-submit success contract: the intake facts PLUS the reply block (a superset). */
export interface TurnSubmitWithReplyResult extends TurnSubmitResult {
  readonly reply: TurnReplyBlock;
}

/**
 * The reply-leg error body: the intake COMMITTED (the ordering law — a model/persist
 * fault never rolls it back), so the error carries the full intake facts plus the deterministic
 * `run_id`. The client retries with the SAME message_id and converges (dedup → attach → reply).
 */
export interface ConversationReplyErrorBody extends ConversationErrorBody {
  /** The committed intake facts — the turn IS persisted and its workflow event emitted. */
  readonly intake: TurnSubmitResult;
  /** The deterministic reply run id (present whenever the responder was reached). */
  readonly run_id?: string;
}
