/**
 * The `conversation_input.create` core operation — the IDEMPOTENT client-keyed conversation create
 * (the record `submit.ts` durability recipe over the head row, WITHOUT an event: creating a
 * conversation starts no workflow — only turns trigger):
 *
 *  1. CLOSED BODY SHAPE — absent or `{ title? }`, nothing else (422 on any unknown key; there is
 *     no other client channel into the head row: `owner` is the NULL v1 seam, `state`/timestamps
 *     are server-derived).
 *  2. IDEMPOTENT RE-CREATE — a create for an EXISTING conversation is the same ack
 *     (`deduped: true`, zero row change; the ack ECHOES the stored row's state — never a
 *     fabricated literal). The optional `title` acts as an ASSERTION on re-create
 *     (the file submit `{ sha256? }` optional-assertion mirror): absent = no assertion (a bare
 *     retry is always safe); present-and-equal = dedup; present-and-DIVERGENT = a LOUD 409
 *     `conversation_conflict` (the stored conversation is authoritative and unchanged — never a
 *     silent title swallow; the record different-payload-same-key law).
 *     TITLE SEMANTICS (deliberate): the title is an OPTIONAL CREATION-TIME ASSERTION — the
 *     exact file `{ sha256? }` role — NOT mutable display state. There is NO title-update path in
 *     v1 (no route can change a stored title; a rename surface is a later slice/consumer
 *     decision, not an accidental omission).
 *  3. FIRST PERSIST = ATOMIC upsert on the tenant-prefixed unique `conversation_ref` (db.upsert
 *     ONLY — never insert-and-recover; the C10 25P02 law). Two concurrent identical first-creates
 *     converge on one row/one ack.
 *  4. AUTHORITATIVE RE-READ (the record re-read posture): a concurrent DIVERGENT racer that overwrote
 *     the head between our upsert and the re-read surfaces as a title mismatch → the loud 409
 *     (this request's title did not win). The guard MIRRORS the found-path (C10-1): only a
 *     request that ASSERTED a title can lose — a BARE create asserted nothing, so a titled
 *     racer's head simply stands and the bare create converges to the dedup outcome (never a
 *     spurious 409). KNOWN RACE-WINDOW CAVEAT (record-capability-shared): the
 *     first-create upsert's DO-UPDATE arm can overwrite a racing first-create's `title`/`opened_at`
 *     — reachable ONLY inside the first-creation race window (a later create never reaches the
 *     upsert; it lands on the found-row paths above), and always LOUD for the overwritten request
 *     via the re-read 409. `state`/`owner` are identical across all v1 creators, so nothing else
 *     can diverge.
 *
 * TRUST BOUNDARY: the body is UNTRUSTED CALLER DATA — the title is a DISPLAY field (shape bound,
 * validate.ts); no model call, no instruction interpretation, no tenant signal (the tenant is
 * server-derived). A create for an id another tenant holds is INVISIBLE here (tenant-scoped reads
 * + tenant-prefixed refs): this tenant simply creates its own conversation.
 */
import { type ConversationCapabilityResult, err, ok } from './errors.js';
import { conversationRef } from './keys.js';
import type { ConversationCoreContext, ConversationParams } from './ports.js';
import { CONVERSATIONS_STORE } from './stores.js';
import type { ConversationCreateResult, ConversationState } from './types.js';
import { validateConversationId, validateTitle } from './validate.js';

/** The closed create-body shape: the ONLY accepted key. */
const ALLOWED_CREATE_KEYS = new Set(['title']);

/** Is the body a plain JSON object (not null / array / scalar)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Create ONE conversation: validate the closed body shape → read the head row (tenant-scoped) →
 * dedup/409 on an existing row, or persist idempotently (upsert on the tenant-prefixed ref) with
 * the authoritative re-read. See the module header for the recipe. Emits NOTHING (only turns
 * trigger workflows).
 */
export async function createConversation(
  ctx: ConversationCoreContext,
  params: ConversationParams,
  body: unknown,
): Promise<ConversationCapabilityResult<ConversationCreateResult>> {
  const idResult = validateConversationId(ctx.config, params);
  if (!idResult.ok) return idResult;
  const conversationId = idResult.value;

  // The CLOSED body shape (requirement 1): absent or `{ title? }`, nothing else.
  let title: string | undefined;
  if (body !== undefined) {
    if (!isPlainObject(body)) {
      return err(
        422,
        'invalid_conversation_body',
        'the create body must be absent or a JSON object of the closed shape { title? }.',
      );
    }
    const unknown = Object.keys(body).filter((k) => !ALLOWED_CREATE_KEYS.has(k));
    if (unknown.length > 0) {
      return err(
        422,
        'invalid_conversation_body',
        `the create body accepts only the optional display key 'title' — unknown key(s) ${unknown
          .map((k) => `'${k}'`)
          .join(', ')} (the head row is server-derived; there is nothing else to set).`,
      );
    }
    if (Object.hasOwn(body, 'title')) {
      const titleResult = validateTitle(body.title);
      if (!titleResult.ok) return titleResult;
      title = titleResult.value;
    }
  }

  const ref = conversationRef(ctx.tenantId, conversationId);
  const existing = await ctx.db.select(
    CONVERSATIONS_STORE,
    { conversation_ref: ref },
    { limit: 1 },
  );
  const found = existing[0];
  if (found !== undefined) {
    // Re-create (requirement 2): title absent = no assertion; equal = dedup; divergent = LOUD 409.
    const storedTitle =
      found.title === null || found.title === undefined ? null : String(found.title);
    if (title !== undefined && title !== storedTitle) {
      return err(
        409,
        'conversation_conflict',
        `conversation '${conversationId}' already exists with a DIFFERENT title — the stored ` +
          'conversation is authoritative and was NOT changed. Re-create without a title (or with ' +
          'the stored one) to converge, or create a new conversation_id.',
      );
    }
    return ok({
      conversation_id: conversationId,
      // ECHO the stored head's state — an ack never fabricates. Only 'open' is ever written,
      // so the cast is a seam, not a hole; a later state-bearing slice inherits the echo for free.
      state: String(found.state) as ConversationState,
      deduped: true,
    });
  }

  // FIRST PERSIST (requirement 3): ATOMIC upsert on the tenant-prefixed unique ref — concurrent
  // identical first-creates converge; the C10 25P02 law forbids insert-and-recover.
  const written = {
    conversation_id: conversationId,
    conversation_ref: ref,
    owner: null,
    title: title ?? null,
    state: 'open',
    opened_at: new Date().toISOString(),
  };
  await ctx.db.upsert(CONVERSATIONS_STORE, ['conversation_ref'], written);

  // AUTHORITATIVE RE-READ (requirement 4): a concurrent DIVERGENT first-create that overwrote
  // between our upsert and this read surfaces as a title mismatch → the loud 409 (this request's
  // title did not win; the stored head is authoritative).
  const stored = await ctx.db.select(CONVERSATIONS_STORE, { conversation_ref: ref }, { limit: 1 });
  const row = stored[0];
  if (row === undefined) {
    throw new Error('conversation-runtime create: head row vanished mid-create (fail-closed).');
  }
  const storedTitle = row.title === null || row.title === undefined ? null : String(row.title);
  // C10-1: MIRROR the found-path guard — absent = NO assertion, so the conflict fires only when
  // THIS request asserted a title the authoritative head diverges from. (The old
  // `storedTitle !== (title ?? null)` shape 409'd a BARE create that lost the first-create race
  // to a TITLED racer — contradicting the module contract's "a bare retry is always safe".)
  if (title !== undefined && storedTitle !== title) {
    return err(
      409,
      'conversation_conflict',
      `conversation '${conversationId}' was created concurrently with a different title — the ` +
        'stored conversation is authoritative and does not match this request.',
    );
  }
  if (title === undefined && storedTitle !== null) {
    // A BARE create whose re-read shows a TITLED head: a racer won the first-create race and its
    // head is authoritative — converge to the dedup outcome (this request asserted nothing).
    return ok({
      conversation_id: conversationId,
      state: String(row.state) as ConversationState,
      deduped: true,
    });
  }

  return ok({
    conversation_id: conversationId,
    // Echo the re-read row's state (every v1 creator writes 'open', so this is our own
    // write's value; the echo keeps the no-fabrication law uniform across all three acks).
    state: String(row.state) as ConversationState,
    deduped: false,
  });
}
