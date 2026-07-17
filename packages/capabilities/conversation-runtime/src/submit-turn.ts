/**
 * The `conversation_input.submit_turn` core operation — persist ONE user turn in the ledger + emit
 * `turn_submitted` (the record/file durability recipe over an INSERT-ONLY ledger):
 *
 *  1. DETERMINISTIC TENANT-SCOPED EVENT ID — `submittedTurnEventId(tenantId, conversationId,
 *     messageId)` (the record/file mirror): TURN-scoped, so every new turn gets its OWN durable
 *     run while a re-POST of one message converges on one (single-flight; keying on the conversation would
 *     silently dedupe every later turn into the first run — the pinned turn-loss hazard).
 *  2. IDEMPOTENT RE-POST THAT RE-EMITS — an identical re-POST of a persisted message returns
 *     `deduped: true` AND re-emits the STORED authoritative event (client retry = redelivery; a
 *     crash between persist and emit is recovered by the retry). The sink/dispatcher dedups
 *     downstream — ONE durable run per turn.
 *  3. THE EVENT IS BUILT FROM THE STORED ROW ONLY (row-event.ts) — never from a request. The
 *     ledger is INSERT-only, so the insert's RETURNING row IS the authoritative stored row (no
 *     concurrent-mutation path exists on a persisted user turn; the explicit re-read the
 *     record/file capabilities need for their replace/seal arms has nothing to catch here — deliberate).
 *  4. DIFFERENT-TEXT-SAME-MESSAGE_ID IS LOUD, NEVER A SILENT DEDUP — a re-POST whose text differs
 *     from the stored turn is a 409 `conversation_message_conflict` with ZERO row change and ZERO
 *     emit OF THE REQUEST'S TEXT. The STORED authoritative event IS re-emitted on this path (the
 *     stored-event heal, best-effort: a transient sink fault is swallowed, the deterministic 409 stands;
 *     the fail-closed `ConversationEventRejectedError` family propagates to the binding's 403).
 *
 * ── THE TURN-SEQ RACE (the single-flight law — the security-load-bearing core) ─────────
 * turn_seq is assigned read-max+1 and persisted by an INSERT against the ledger's TWO unique
 * authorities (`seq_ref` ordering / `turn_ref` dedup — stores.ts), and that ONE statement runs
 * inside a NESTED `ctx.db.transaction(...)` — a SAVEPOINT on the engine's route transaction (the
 * savepoint-scoping fix). WHY THE SAVEPOINT IS LOAD-BEARING: a route handler runs inside the engine's tenant
 * transaction, and an UNSCOPED unique violation raised there POISONS that tx — the driver
 * (postgres.js) remembers the raw 23505 and rejects the OUTER transaction promise with it even
 * though this code caught the sanitized copy and returned the 409, so the typed 409 was produced
 * but DISCARDED and the route 500'd (probe- and e2e-proven). The savepoint's rollback un-poisons
 * the outer tx, so the typed 409 SURVIVES the real stack. A concurrent turn that wins either
 * unique therefore makes THIS request's insert raise the facade-sanitized unique violation, mapped
 * to the TYPED 409 `conversation_turn_conflict` with ZERO emit and ZERO further DB statements on
 * that path — the savepoint SCOPES the error, it never RECOVERS in-tx (no re-read/retry — the single-flight
 * law; an upsert here would silently OVERWRITE the winner: silent turn loss). The client retries
 * with the SAME message_id: a lost same-message race then lands on the dedup path (one run, idempotency);
 * a lost different-message race re-reads max and takes the next seq. Under the unit fakes the same
 * typed 409 returns and the fake's tx-poison model pins that the violation stayed savepoint-scoped.
 *
 * EMIT-FAULT POSTURE (wire-faithful): the FIRST-persist emit and the IDENTICAL-re-POST re-emit
 * are DELIBERATELY NOT best-effort — they are the crash-recovery mechanism, so a transient sink
 * fault SURFACES (500) to keep the client retrying until the turn is enqueued; swallowing it would
 * re-open the silent zero-run. ONLY the divergent-409 heal is best-effort (the 409 is a PERMANENT
 * client condition — correct regardless of downstream health).
 *
 * TRUST BOUNDARY: the body is UNTRUSTED CALLER DATA — a CLOSED scalar shape (`{ message_id, text }`) the
 * core never recurses over (the record depth-DoS discipline realized STRUCTURALLY: there is
 * no canonicalization/serialization walk anywhere in this path, so a hostile deeply-nested body is
 * a typed 422 from the shallow shape checks, never a stack overflow). The WHOLE body is
 * byte-bounded BEFORE field validation (the record whole-payload discipline — see the inline
 * bounds note for the shallow-measure law). The text is stored VERBATIM
 * as DATA (types.ts documents the boundary; only U+0000 is rejected — Postgres `text` cannot store
 * it, and letting it through would turn the insert into a raw 500). A turn for a conversation this
 * tenant never created — including ANOTHER tenant's conversation id (tenant-scoped reads make it
 * invisible) — is the same non-disclosing 409 `conversation_not_created`.
 */
import { type ConversationCapabilityResult, err, ok } from './errors.js';
import { ConversationEventRejectedError, type TurnSubmittedSink } from './events.js';
import { conversationRef, turnRef, turnSeqRef } from './keys.js';
import type { ConversationCoreContext, ConversationParams } from './ports.js';
import { submittedTurnEventFromRow } from './row-event.js';
import { CONVERSATION_TURNS_STORE, CONVERSATIONS_STORE } from './stores.js';
import type { TurnSubmitResult } from './types.js';
import { validateConversationId, validateMessageId } from './validate.js';

/** The closed turn-body shape: the ONLY accepted keys (both REQUIRED). */
const ALLOWED_TURN_KEYS = new Set(['message_id', 'text']);

/** Is the body a plain JSON object (not null / array / scalar)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True if a thrown DB error is the (facade-sanitized) Postgres UNIQUE violation — SQLSTATE 23505
 * carried as a `code` property, checked down a bounded `.cause` chain (the store facade preserves
 * the SQLSTATE non-enumerably and hides the constraint name; the driver/drizzle raw shapes carry
 * it on the error or its cause). DETECTION ONLY — the caller maps it to the typed 409 and issues
 * NO further statements (the no-in-tx-recovery law).
 */
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    if (typeof cur === 'object' && (cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Submit ONE user turn: validate the closed body shape → require the conversation (tenant-scoped)
 * → dedup/409 on the stored message → INSERT the next-seq ledger row (loud on a lost race) → EMIT
 * the turn-scoped `turn_submitted` event from the authoritative stored row. See the module header
 * for the recipe. A sink's deliberate fail-closed rejection (`ConversationEventRejectedError`)
 * propagates — the route binding owns the 403 mapping.
 */
export async function submitTurn(
  ctx: ConversationCoreContext,
  params: ConversationParams,
  body: unknown,
  sink: TurnSubmittedSink,
): Promise<ConversationCapabilityResult<TurnSubmitResult>> {
  const idResult = validateConversationId(ctx.config, params);
  if (!idResult.ok) return idResult;
  const conversationId = idResult.value;

  // The CLOSED body shape (trust boundary: shallow checks only — the module header's structural DoS note).
  if (!isPlainObject(body)) {
    return err(
      422,
      'invalid_turn_body',
      'the turn body must be a JSON object of the closed shape { message_id, text }.',
    );
  }
  // THE WHOLE-BODY BOUND (the record whole-payload discipline): bound the WHOLE body
  // BEFORE any field validation, typed 413. The measure is SHALLOW BY DESIGN (the module header's
  // structural no-walk discipline): own key names + own STRING values, raw UTF-8 bytes. That is a
  // complete measure of the ACCEPTED language — the closed scalar shape rejects every non-string
  // value below (422), so no body that survives validation can carry unmeasured bytes. Raw-byte
  // semantics on purpose (the text cap is a raw-byte bound; a serialized measure would 6x-expand
  // JSON-escaped chars and reject legal cap-sized messages).
  let bodyBytes = 0;
  for (const [key, value] of Object.entries(body)) {
    bodyBytes += Buffer.byteLength(key, 'utf8');
    if (typeof value === 'string') bodyBytes += Buffer.byteLength(value, 'utf8');
  }
  if (bodyBytes > ctx.config.maxTurnBodyBytes) {
    return err(
      413,
      'turn_body_too_large',
      `the turn body exceeds the ${ctx.config.maxTurnBodyBytes}-byte whole-body bound (the ` +
        'message byte cap plus a fixed envelope — this capability ingests chat turns; ' +
        'document-grade input belongs to a file capability).',
    );
  }

  const unknown = Object.keys(body).filter((k) => !ALLOWED_TURN_KEYS.has(k));
  if (unknown.length > 0) {
    return err(
      422,
      'invalid_turn_body',
      `the turn body accepts exactly { message_id, text } — unknown key(s) ${unknown
        .map((k) => `'${k}'`)
        .join(', ')} (the turn_submitted payload is server-derived from the stored turn).`,
    );
  }
  const msgResult = validateMessageId(ctx.config, body.message_id);
  if (!msgResult.ok) return msgResult;
  const messageId = msgResult.value;

  const text = body.text;
  if (typeof text !== 'string' || text.length === 0) {
    return err(
      422,
      'invalid_turn_body',
      "the turn body's 'text' must be a non-empty string (the user message — DATA).",
    );
  }
  if (text.includes('\u0000')) {
    return err(
      422,
      'invalid_turn_body',
      "the message text must not contain U+0000 — a Postgres 'text' column cannot store NUL " +
        '(every other character is stored verbatim as data).',
    );
  }
  if (Buffer.byteLength(text, 'utf8') > ctx.config.maxMessageBytes) {
    return err(
      413,
      'message_too_large',
      `the message text exceeds the ${ctx.config.maxMessageBytes}-byte UTF-8 bound for one turn ` +
        '(this capability ingests chat turns; document-grade input belongs to a file capability).',
    );
  }

  // The conversation MUST exist under THIS tenant (tenant-scoped reads; the non-disclosing shape:
  // a foreign tenant's conversation id is indistinguishable from a genuinely-absent one).
  const convRef = conversationRef(ctx.tenantId, conversationId);
  const heads = await ctx.db.select(
    CONVERSATIONS_STORE,
    { conversation_ref: convRef },
    { limit: 1 },
  );
  if (heads[0] === undefined) {
    return err(
      409,
      'conversation_not_created',
      `conversation '${conversationId}' does not exist — create it first, then submit turns.`,
    );
  }

  // The DEDUP authority (requirement 2/4): an identical re-POST is a redelivery; a divergent one
  // is a loud 409 with the stored-event heal.
  const tRef = turnRef(ctx.tenantId, conversationId, messageId);
  const existing = await ctx.db.select(CONVERSATION_TURNS_STORE, { turn_ref: tRef }, { limit: 1 });
  const found = existing[0];
  if (found !== undefined) {
    if (String(found.message) !== text) {
      // THE STORED-EVENT HEAL — BEST-EFFORT BY DESIGN (the record heal posture): the
      // stored turn may be persisted-but-never-enqueued, so re-emit its STORED event before the
      // permanent 409. The catch below swallows EVERY throw except the fail-closed rejection
      // family — deliberately: the 409 is a PERMANENT client condition (divergent text under a
      // stored message_id), correct regardless of downstream health, so a transient sink/DBOS
      // fault must not turn the deterministic 409 into a flapping 500 (the client would retry a
      // request that can never succeed). What is swallowed is ONLY this redelivery attempt — the
      // stored turn stays persisted and any identical re-POST re-emits it on the PRIMARY path,
      // which is NOT best-effort (it rethrows; the module-header EMIT-FAULT POSTURE).
      // ConversationEventRejectedError still propagates: fail-closed beats best-effort (→ 403).
      try {
        await sink.emit(submittedTurnEventFromRow(ctx.tenantId, found));
      } catch (e) {
        if (e instanceof ConversationEventRejectedError) throw e; // fail-closed cross-tenant → 403
        // Swallowed on purpose — see the heal note above (this arm is the ONLY best-effort emit).
      }
      return err(
        409,
        'conversation_message_conflict',
        `message '${messageId}' was already submitted with DIFFERENT text — the stored turn is ` +
          'authoritative and was NOT changed (no workflow was started for this request). Submit ' +
          'new text under a new message_id.',
      );
    }
    // IDENTICAL re-POST: re-emit the STORED event (redelivery; NOT best-effort — module header).
    const event = submittedTurnEventFromRow(ctx.tenantId, found);
    await sink.emit(event);
    return ok({
      conversation_id: conversationId,
      message_id: messageId,
      turn_seq: Number(found.turn_seq),
      event_id: event.event_id,
      deduped: true,
    });
  }

  // NEW TURN: assign the next sequence from the ledger's current tail (server-side ORDER BY —
  // bounded, never a whole-conversation load), then INSERT against BOTH unique authorities.
  const tail = await ctx.db.select(
    CONVERSATION_TURNS_STORE,
    { conversation_ref: convRef },
    { orderBy: [{ column: 'turn_seq', dir: 'desc' }], limit: 1 },
  );
  const tailSeq = Number(tail[0]?.turn_seq);
  const nextSeq = (Number.isFinite(tailSeq) ? tailSeq : 0) + 1;

  // THE SAVEPOINT-SCOPED INSERT (the module header's single-flight law, the concurrent-turn conflict fix): `db.transaction`
  // NESTED inside the engine's route transaction is a SAVEPOINT, so a lost-race unique violation
  // aborts ONLY this scope — the route tx stays clean and the typed 409 below actually reaches
  // the client (an unscoped 23505 poisons the route tx: the driver rejects the outer transaction
  // promise with the remembered raw error and the clean 409 is discarded into a 500).
  let inserted: Awaited<ReturnType<typeof ctx.db.insert>>;
  try {
    inserted = await ctx.db.transaction((tx) =>
      tx.insert(CONVERSATION_TURNS_STORE, {
        conversation_id: conversationId,
        conversation_ref: convRef,
        message_id: messageId,
        turn_ref: tRef,
        turn_seq: nextSeq,
        seq_ref: turnSeqRef(ctx.tenantId, conversationId, nextSeq),
        role: 'user',
        message: text,
        run_id: null,
        state: 'submitted',
        submitted_at: new Date().toISOString(),
      }),
    );
  } catch (e) {
    if (isUniqueViolation(e)) {
      // THE LOST RACE (the module header's single-flight law): a concurrent turn won `seq_ref` (a different
      // message took this seq) or `turn_ref` (the same message double-fired and its winner
      // persisted after our dedup read). LOUD typed 409 — ZERO emit (nothing was persisted for
      // THIS request; the winner emits its own stored event on its own path), ZERO further DB
      // statements (the savepoint SCOPED the error; no in-tx recovery). The client retries
      // with the SAME message_id and converges: dedup path (same message) or the next free seq
      // (different message).
      return err(
        409,
        'conversation_turn_conflict',
        `conversation '${conversationId}' accepted a concurrent turn while this one was being ` +
          'sequenced — nothing was stored for this request and no workflow was started. Retry ' +
          'with the SAME message_id to converge.',
      );
    }
    throw e;
  }

  // Emit from the STORED row (requirement 3: the insert's RETURNING row IS the authoritative
  // stored row — the ledger is insert-only). NOT best-effort (the module-header decision): a
  // transient fault SURFACES so the client keeps retrying until the turn is enqueued. A
  // ConversationEventRejectedError propagates (fail-closed law — nothing enqueued; the binding
  // maps it to a clean 403).
  const event = submittedTurnEventFromRow(ctx.tenantId, inserted);
  await sink.emit(event);

  return ok({
    conversation_id: conversationId,
    message_id: messageId,
    turn_seq: nextSeq,
    event_id: event.event_id,
    deduped: false,
  });
}
