/**
 * Shared request-shape validation (the record/file `validate.ts` role): the id gates both cores
 * run first, plus the display-field shape bound. Pattern check + the point-of-use STRUCTURAL
 * belts (the record capability's delimiter belt): both hold EVEN for a hand-built config whose pattern would admit
 * the reserved char (resolveConversationConfig rejects such an override at construction, but the
 * probe belt is convenience — the point-of-use belt is the guarantee).
 *  - ':' — the delimiter of every derived ref/idempotency key (`conversation_ref`/`turn_ref`/
 *    `seq_ref`/`event_id` — keys.ts); applies to BOTH id kinds.
 *  - the reply namespace — a MESSAGE id must not start with `REPLY_MESSAGE_ID_PREFIX`
 *    ('reply~'), the reserved namespace of the DERIVED assistant reply id (reply.ts); an accepted
 *    'reply~<m>' user id would derive the SAME `turn_ref` as message <m>'s reply and pre-occupy it.
 *    Message ids ONLY — conversation ids never carry the reply namespace (config.ts).
 * No path belt: this capability derives no blob/path keys.
 */
import type { ResolvedConversationConfig } from './config.js';
import { MAX_CONVERSATION_TITLE_CHARS } from './config.js';
import { type ConversationCapabilityResult, err } from './errors.js';
import type { ConversationParams } from './ports.js';
import { REPLY_MESSAGE_ID_PREFIX } from './reply.js';

/** Validate the client-supplied conversation id; returns the id or the typed 422. */
export function validateConversationId(
  config: ResolvedConversationConfig,
  params: ConversationParams,
): ConversationCapabilityResult<string> {
  const conversationId = params.conversation_id ?? '';
  if (!config.conversationIdPattern.test(conversationId)) {
    return err(
      422,
      'conversation_id_invalid',
      'conversation_id must match the configured safe-id shape (default: 1..128 ASCII ' +
        'letters/digits/._-).',
    );
  }
  if (conversationId.includes(':')) {
    return err(
      422,
      'conversation_id_invalid',
      "conversation_id must not contain ':' — it is the reserved delimiter of the conversation " +
        'ref and the event idempotency key.',
    );
  }
  return { ok: true, value: conversationId };
}

/** Validate a client-supplied message id (a turn-body field, so `unknown` in); id or typed 422. */
export function validateMessageId(
  config: ResolvedConversationConfig,
  raw: unknown,
): ConversationCapabilityResult<string> {
  if (typeof raw !== 'string' || !config.messageIdPattern.test(raw)) {
    return err(
      422,
      'message_id_invalid',
      'message_id must be a string matching the configured safe-id shape (default: 1..128 ASCII ' +
        'letters/digits/._-).',
    );
  }
  if (raw.includes(':')) {
    return err(
      422,
      'message_id_invalid',
      "message_id must not contain ':' — it is the reserved delimiter of the turn ref and the " +
        'event idempotency key.',
    );
  }
  // The reply-namespace point-of-use belt: a client id in the reserved `reply~` namespace
  // would derive the SAME turn_ref as its own reply row (turnRef(t,c,'reply~m') ===
  // turnRef(t,c,replyMessageId('m'))) and pre-occupy it — permanently 500ing that message's reply
  // leg. Enforced HERE, so it holds even for a hand-built (or anchored, e.g. /^reply~[0-9]$/)
  // pattern the construction probe belt never rejected. Sourced from reply.ts's exported prefix so
  // it can never drift from the derivation.
  if (raw.startsWith(REPLY_MESSAGE_ID_PREFIX)) {
    return err(
      422,
      'message_id_invalid',
      `message_id must not start with '${REPLY_MESSAGE_ID_PREFIX}' — it is the reserved namespace ` +
        'of the derived assistant reply id (reply.ts); a client id in it would pre-occupy the ' +
        "reply row's turn_ref.",
    );
  }
  return { ok: true, value: raw };
}

/**
 * True if `value` carries a control or invisible char — rejected in a DISPLAY field (the title;
 * the file `x-file-name` mirror): C0 controls + DEL, C1 controls (0x80–0x9F), bidi controls
 * (U+202A–U+202E embeddings/overrides, U+2066–U+2069 isolates — the RLO spoof class), the
 * STANDALONE bidi marks (U+200E LRM, U+200F RLM, U+061C ALM — invisible direction
 * flips with no terminator, the same display-spoof class as the embeddings), and zero-width chars
 * (U+200B–U+200D, U+FEFF). Legitimate unicode (umlauts, CJK, emoji, Arabic LETTERS) stays
 * accepted — this is a shape bound, not an ASCII allowlist. NOT applied to the message TEXT
 * (stored verbatim as DATA — types.ts documents the boundary; only U+0000 is rejected there, a
 * Postgres `text` storage law).
 */
export function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true; // C0 + DEL
    if (code >= 0x80 && code <= 0x9f) return true; // C1
    if (code >= 0x202a && code <= 0x202e) return true; // bidi embeddings/overrides
    if (code >= 0x2066 && code <= 0x2069) return true; // bidi isolates
    if (code >= 0x200b && code <= 0x200f) return true; // zero-width + standalone LRM/RLM marks
    if (code === 0x061c || code === 0xfeff) return true; // ALM + BOM/zero-width no-break
  }
  return false;
}

/**
 * Validate the optional conversation title (a create-body field): a non-empty printable string of
 * at most `MAX_CONVERSATION_TITLE_CHARS` chars, control/bidi/zero-width-rejected. Returns
 * the title or the typed 422.
 */
export function validateTitle(raw: unknown): ConversationCapabilityResult<string> {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_CONVERSATION_TITLE_CHARS ||
    hasControlChars(raw)
  ) {
    return err(
      422,
      'conversation_title_invalid',
      `the optional title must be a printable string of 1..${MAX_CONVERSATION_TITLE_CHARS} ` +
        'characters (it is stored as display data alongside the conversation, never used as a key).',
    );
  }
  return { ok: true, value: raw };
}
