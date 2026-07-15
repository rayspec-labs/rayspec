/**
 * Typed capability outcomes (the record/file-runtime pattern): the core returns DISCRIMINATED
 * results (never throws for a client-caused condition); the RaySpec binding maps each to the
 * proper HTTP status. A genuine fault (a DB failure the core cannot classify) still throws — the
 * binding lets it surface as a 500.
 *
 * The stable error codes (the capability's client taxonomy):
 *  - `conversation_id_invalid`        422 — the conversation id fails the safe-id shape (or carries ':').
 *  - `invalid_conversation_body`      422 — the create body is not the closed `{ title? }` shape.
 *  - `conversation_title_invalid`     422 — the optional title fails the DATA-shape bound.
 *  - `conversation_conflict`          409 — a re-create's title assertion diverges from the stored
 *                                           conversation (stored authoritative, zero change).
 *  - `message_id_invalid`             422 — the message id fails the safe-id shape (or carries ':').
 *  - `invalid_turn_body`              422 — the turn body is not the closed `{ message_id, text }`
 *                                           shape (incl. empty text and a NUL char — Postgres text
 *                                           columns cannot store U+0000).
 *  - `turn_body_too_large`            413 — the WHOLE turn body exceeds the whole-body byte bound
 *                                           (checked BEFORE field validation — the record
 *                                           whole-payload discipline).
 *  - `message_too_large`              413 — the message text exceeds the UTF-8 byte cap.
 *  - `conversation_not_created`       409 — a turn for a conversation this tenant never created
 *                                           (also the non-disclosing shape a foreign tenant's
 *                                           conversation id yields — tenant-scoped reads).
 *  - `conversation_turn_conflict`     409 — a LOST unique race on the turn ledger (two turns raced
 *                                           one conversation): retry with the SAME message_id — the
 *                                           retry converges on the dedup path (C10).
 *  - `conversation_message_conflict`  409 — a re-POST of one message_id with DIFFERENT text (the
 *                                           stored turn is authoritative; submit new text under a
 *                                           new message_id) — permanent, never a silent dedup.
 *
 * The reply-leg codes (the intake is COMMITTED on both — the body carries the intake facts):
 *  - `conversation_reply_failed`           502 — the reply model run failed (transient upstream
 *                                                classes included); retry with the SAME message_id
 *                                                to converge on one reply (C10).
 *  - `conversation_reply_persist_conflict` 503 — the reply lost every bounded sequence-race retry
 *                                                against concurrent turns; the run output is
 *                                                durable under the carried run id — a same-
 *                                                message_id retry converges without a second
 *                                                model call.
 */

/** A client-caused capability error with the HTTP status the binding should use. */
export interface ConversationCapabilityError {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
  readonly detail: string;
}

/** A successful capability outcome carrying its value. */
export interface ConversationCapabilityOk<T> {
  readonly ok: true;
  readonly value: T;
}

export type ConversationCapabilityResult<T> =
  | ConversationCapabilityOk<T>
  | ConversationCapabilityError;

export function ok<T>(value: T): ConversationCapabilityOk<T> {
  return { ok: true, value };
}

export function err(status: number, error: string, detail: string): ConversationCapabilityError {
  return { ok: false, status, error, detail };
}
