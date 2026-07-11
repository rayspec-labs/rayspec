/**
 * Tenant-namespaced key derivation — the AUDIO/RECORD/FILE KEYING PATTERN, mirrored deliberately:
 * the platform's generated single-column UNIQUE is GLOBAL, so the tenant id is EMBEDDED in every
 * unique ref, which is what keeps two tenants' identical client-chosen ids from colliding. That
 * makes both capability-owned stores PER-TENANT-KEYED BY CONSTRUCTION (we own this DDL — not the
 * S2 declared-store global-key caveat class). The tenant id is always SERVER-DERIVED (never
 * client-supplied); the client-chosen ids exclude ':' (config/validate), so every composed ref is
 * unambiguous.
 *
 * ── THE TWO turn_ref COMPOSITIONS (deliberate — read this before touching either) ─────────────
 * The turn LEDGER's unique `turn_ref` COLUMN is tenant-prefixed (`${tenantId}:${conversationId}:
 * ${messageId}`) because the generated unique index is GLOBAL (the file_ref law). The EVENT
 * PAYLOAD's `turn_ref` FIELD is tenant-FREE (`${conversationId}:${messageId}`) because the
 * payload already carries `tenant_id` as its own key and the dispatcher's derived idempotency key
 * (`turn_ref:<value>`) feeds the TENANT-NAMESPACED `durableWorkflowRunId` — a tenant prefix there
 * would be redundant double-namespacing (the exact split file_input uses: store `file_ref` is
 * tenant-prefixed, payload key field `file_id` is bare). Both are SERVER-derived.
 */

/** The tenant-namespaced unique key of one conversation head row (= `${tenantId}:${conversationId}`). */
export function conversationRef(tenantId: string, conversationId: string): string {
  return `${tenantId}:${conversationId}`;
}

/**
 * The tenant-namespaced unique key of one turn BY MESSAGE ID — the ledger's C10 dedup authority
 * (a re-POST of one message_id converges here): `${tenantId}:${conversationId}:${messageId}`.
 */
export function turnRef(tenantId: string, conversationId: string, messageId: string): string {
  return `${tenantId}:${conversationId}:${messageId}`;
}

/**
 * The tenant-namespaced unique key of one turn BY SEQUENCE — the anti-race authority (two turns
 * racing one conversation collide HERE, loud-not-silent): `${tenantId}:${conversationId}:${seq}`.
 */
export function turnSeqRef(tenantId: string, conversationId: string, turnSeq: number): string {
  return `${tenantId}:${conversationId}:${turnSeq}`;
}

/**
 * The tenant-FREE per-TURN payload field the descriptor's `idempotency_key_field` names (=
 * `${conversationId}:${messageId}` — the composed-single-field idiom). PER-TURN on purpose, never
 * `conversation_id`: keying the durable run on the conversation would dedupe EVERY later turn into
 * the first run — silent turn loss (pinned by test in the bridge + the manifest).
 */
export function eventTurnRef(conversationId: string, messageId: string): string {
  return `${conversationId}:${messageId}`;
}

/**
 * The TURN-scoped downstream idempotency key (the sink-level `event_id`; a re-POST of one
 * message_id converges on this ONE key — the record/file `submittedEventId` mirror).
 * Deterministic + tenant-scoped: `${tenantId}:${conversationId}:${messageId}`.
 */
export function submittedTurnEventId(
  tenantId: string,
  conversationId: string,
  messageId: string,
): string {
  return `${tenantId}:${conversationId}:${messageId}`;
}
