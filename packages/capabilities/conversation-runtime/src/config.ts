/**
 * Capability configuration (the record/file `config.ts` mirror, extended for the conversational
 * bounds): the accepted conversation/message-id shapes, the per-turn message byte bound, and the
 * history read-window bounds, with product-neutral defaults a deployment may narrow. Every
 * override is CONSTRUCTION-VALIDATED fail-closed (deploy-time loud) — a malformed bound must never
 * silently disable a cap.
 */

/** The default conversation-id shape (safe ASCII, up to 128 chars — the record/file safe-id mirror). */
export const DEFAULT_CONVERSATION_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** The default message-id shape (per-turn client key; the same safe-id family). */
export const DEFAULT_MESSAGE_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The default per-turn message byte bound: 32 KiB of UTF-8 (413 above it). Rationale (documented,
 * gate-pinned): the message TEXT is a payload business field of the `turn_submitted` trigger
 * event (the record_input top-level-merge precedent — that is what lets a declared async workflow
 * consume it via the existing `input_context.payload_fields` path), so it is copied verbatim into
 * the durable journal's `input_event` row on every run and must stay journal-friendly. The record
 * capability caps its WHOLE canonical payload at 64 KiB; a 32 KiB message plus the fixed identity
 * envelope stays comfortably inside that same journal-friendliness class while covering any real
 * chat turn (~8k English tokens — far beyond an interactive message). Document/file-grade input
 * belongs to `file_input`, not a chat turn. A deployment may narrow OR widen via
 * `maxMessageBytes`, consciously trading journal weight — but never past
 * `MAX_MESSAGE_BYTES_CEILING` (the construction-belted class bound below).
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024;

/**
 * The HARD CEILING on `maxMessageBytes` overrides: the rationale above makes
 * journal-friendliness a CLASS bound, not a default — the record capability caps its WHOLE
 * canonical payload at 64 KiB for exactly that reason, so 64 KiB is the established ceiling
 * for the one field that rides our payload. HONEST NUANCE: this ceiling caps the
 * `message` FIELD at the class bound — the event ENVELOPE (ids, turn_seq, timestamps) rides on
 * top, so a deliberate at-ceiling override writes journal payloads slightly ABOVE the cited 64 KiB
 * class. That is a soft-guideline trade, not a fault (no hard downstream cap exists; Postgres
 * TOASTs far beyond it); the default (32 KiB) leaves the whole payload comfortably inside the
 * class. A deployment may narrow or widen WITHIN the ceiling; an override above it is a CONFIG
 * ERROR at construction (fail-closed, deploy-time loud) — never a silently journal-hostile event
 * stream.
 */
export const MAX_MESSAGE_BYTES_CEILING = 64 * 1024;

/**
 * The fixed envelope headroom of the WHOLE-turn-body bound (the record whole-payload
 * discipline): the closed turn body carries, besides the text, only the `message_id` (≤128 chars
 * by the safe-id shape) and the two key names — 4 KiB is generous for that envelope. The resolved
 * `maxTurnBodyBytes` is DERIVED (`maxMessageBytes + this`), never independently overridable, so it
 * tracks a narrowed/widened message cap and is `> maxMessageBytes` BY CONSTRUCTION (a belt that
 * cannot be mis-set).
 */
export const TURN_BODY_ENVELOPE_HEADROOM_BYTES = 4 * 1024;

/**
 * The default history read-window in TURNS (the bounded-history law): a reply run's
 * transient model input is assembled from at most this many most-recent ledger turns — history is
 * NEVER unbounded and NEVER re-derived from stuffed runs. 20 turns (10 user/assistant exchanges)
 * covers a real support/screening conversation while capping marginal per-turn token growth.
 * Declared HERE so the manifest contract, the gate, and the assembly all pin ONE
 * constant.
 */
export const DEFAULT_MAX_HISTORY_TURNS = 20;

/**
 * The default history read-window in CHARACTERS (the second axis of the history bound): even inside the
 * turn window, the serialized DATA contribution of the assembled model input — the history block
 * AND the optional store-context block together, ONE shared budget (the split policy
 * is pinned on `assembleTurnInput`) — is capped at 64Ki chars, so a window of cap-sized messages
 * cannot multiply into an unbounded model input. (~16k tokens — a deliberate ceiling, stated not
 * hidden; the plan's cost-posture pin.)
 */
export const DEFAULT_MAX_HISTORY_CHARS = 64 * 1024;

/**
 * The conversation-title DATA-shape bound (chars). The title is a display column, never a
 * key/path/id component (the file `original_filename` mirror) — bounded + control-char
 * rejected, not configurable (there is no legitimate need for a longer display title).
 */
export const MAX_CONVERSATION_TITLE_CHARS = 255;

/**
 * The record/file construction belt: probe strings an id-pattern override must NOT accept.
 * ':' is the STRUCTURAL delimiter of every ref this capability derives (`conversation_ref` =
 * `${tenantId}:${conversationId}`, `turn_ref`/`seq_ref` = `${tenantId}:${conversationId}:<tail>`,
 * and the event id — keys.ts): a pattern admitting it would let two distinct (tenant, conversation,
 * message) tuples collide on one ref/idempotency key. Probe-based (a regex's accepted language
 * can't be cheaply inspected in general); validate.ts carries a point-of-use belt that holds even
 * for a hand-built config these probes never saw. No path probes: unlike file_input this
 * capability derives no blob/path keys.
 */
const DELIMITER_PROBES = [':', 'a:b', ':a', 'a:'] as const;

/**
 * Probe strings a MESSAGE-id-pattern override must ADDITIONALLY not accept.
 * '~' is the reserved NAMESPACE separator of the derived assistant reply message id
 * (`reply~<message_id>` — reply.ts): the reply leg's dedup/convergence authority relies on a
 * derived reply id NEVER colliding with a client-chosen message id, which holds because a client id
 * in the reply namespace is REJECTED at intake. That rejection is GUARANTEED by validate.ts's
 * point-of-use belt (any id starting with `REPLY_MESSAGE_ID_PREFIX` is a typed 422), NOT by this
 * probe belt: probing is CONSTRUCTION-TIME CONVENIENCE only — it is provably incomplete (an
 * anchored override like `/^reply~[0-9]$/` accepts NONE of these canaries yet admits 'reply~5'), the
 * same limit the delimiter probes carry (a regex's accepted language can't be cheaply inspected
 * in general). The probes still earn their keep by failing an OBVIOUS '~'-admitting override loud at
 * deploy time. Applies to `messageIdPattern` ONLY — conversation ids never carry the reply namespace
 * (the prefix is prepended to MESSAGE ids), so a '~' in a conversation id is inert and stays a
 * deployment's choice.
 */
const REPLY_NAMESPACE_PROBES = ['~', 'reply~x', 'a~b', '~a', 'a~'] as const;

export interface ConversationCapabilityConfig {
  /** Override the accepted conversation-id shape (default `DEFAULT_CONVERSATION_ID_RE`). */
  readonly conversationIdPattern?: RegExp;
  /** Override the accepted message-id shape (default `DEFAULT_MESSAGE_ID_RE`). */
  readonly messageIdPattern?: RegExp;
  /** Override the per-turn message UTF-8 byte cap (default `DEFAULT_MAX_MESSAGE_BYTES`). */
  readonly maxMessageBytes?: number;
  /** Override the history window in turns (default `DEFAULT_MAX_HISTORY_TURNS`). */
  readonly maxHistoryTurns?: number;
  /** Override the history window in chars (default `DEFAULT_MAX_HISTORY_CHARS`). */
  readonly maxHistoryChars?: number;
}

export interface ResolvedConversationConfig {
  readonly conversationIdPattern: RegExp;
  readonly messageIdPattern: RegExp;
  readonly maxMessageBytes: number;
  /**
   * The WHOLE-turn-body byte bound (413 above it, BEFORE field validation) — always
   * `maxMessageBytes + TURN_BODY_ENVELOPE_HEADROOM_BYTES` (derived; see the headroom constant).
   */
  readonly maxTurnBodyBytes: number;
  readonly maxHistoryTurns: number;
  readonly maxHistoryChars: number;
}

/** Probe one id-pattern override against the delimiter probes — fail-closed at construction. */
function assertPatternExcludesDelimiter(pattern: RegExp, what: string): void {
  // Probe with a flag-stripped copy so a sticky/global override's `lastIndex` state can't skew
  // the check (the record/file posture). Fail CLOSED at construction (deploy-time loud) —
  // never a silently corrupt ref/idempotency key.
  const probeSafe = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  for (const probe of DELIMITER_PROBES) {
    if (probeSafe.test(probe)) {
      throw new Error(
        `conversation capability config: ${what} ${String(pattern)} accepts ':' (probe ` +
          `'${probe}') — ':' is the reserved delimiter of conversation_ref/turn_ref/seq_ref and ` +
          'the event idempotency key, so an override must exclude it (fail-closed at construction).',
      );
    }
  }
}

/**
 * Probe a MESSAGE-id-pattern override against the reply-namespace probes — fail-closed at
 * construction (see `REPLY_NAMESPACE_PROBES`). Same flag-stripped probing posture as the
 * delimiter belt.
 */
function assertPatternExcludesReplyNamespace(pattern: RegExp): void {
  const probeSafe = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  for (const probe of REPLY_NAMESPACE_PROBES) {
    if (probeSafe.test(probe)) {
      throw new Error(
        `conversation capability config: messageIdPattern ${String(pattern)} accepts '~' (probe ` +
          `'${probe}') — '~' is the reserved namespace separator of the derived assistant reply ` +
          'message id (reply~<message_id>), so an override admitting it would let a client ' +
          'pre-occupy/collide with reply rows (fail-closed at construction).',
      );
    }
  }
}

/** Require a positive safe integer for a bound override — a malformed cap must break LOUD. */
function assertPositiveInt(value: number, what: string, consequence: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `conversation capability config: ${what} must be a positive integer (got ${String(value)}) ` +
        `— ${consequence} (fail-closed at construction).`,
    );
  }
}

export function resolveConversationConfig(
  config?: ConversationCapabilityConfig,
): ResolvedConversationConfig {
  const conversationIdPattern = config?.conversationIdPattern ?? DEFAULT_CONVERSATION_ID_RE;
  if (config?.conversationIdPattern !== undefined) {
    assertPatternExcludesDelimiter(conversationIdPattern, 'conversationIdPattern');
  }
  const messageIdPattern = config?.messageIdPattern ?? DEFAULT_MESSAGE_ID_RE;
  if (config?.messageIdPattern !== undefined) {
    assertPatternExcludesDelimiter(messageIdPattern, 'messageIdPattern');
    assertPatternExcludesReplyNamespace(messageIdPattern);
  }

  const maxMessageBytes = config?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  assertPositiveInt(
    maxMessageBytes,
    'maxMessageBytes',
    'a malformed cap would disable the message byte bound (`bytes > NaN` is never true)',
  );
  if (maxMessageBytes > MAX_MESSAGE_BYTES_CEILING) {
    throw new Error(
      `conversation capability config: maxMessageBytes (${maxMessageBytes}) exceeds the ` +
        `${MAX_MESSAGE_BYTES_CEILING}-byte ceiling — the message text rides the turn_submitted ` +
        'payload into the durable journal on every run (the record 64 KiB whole-payload ' +
        'journal-friendliness class), so a wider cap is a config error, not an override ' +
        '(fail-closed at construction).',
    );
  }

  const maxHistoryTurns = config?.maxHistoryTurns ?? DEFAULT_MAX_HISTORY_TURNS;
  assertPositiveInt(
    maxHistoryTurns,
    'maxHistoryTurns',
    'a malformed window would unbound the history read',
  );

  const maxHistoryChars = config?.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS;
  assertPositiveInt(
    maxHistoryChars,
    'maxHistoryChars',
    'a malformed window would unbound the history assembly',
  );

  return {
    conversationIdPattern,
    messageIdPattern,
    maxMessageBytes,
    maxTurnBodyBytes: maxMessageBytes + TURN_BODY_ENVELOPE_HEADROOM_BYTES,
    maxHistoryTurns,
    maxHistoryChars,
  };
}
