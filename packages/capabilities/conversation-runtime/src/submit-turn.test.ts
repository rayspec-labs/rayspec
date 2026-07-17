/**
 * The turn-submit core — the idempotent turn state machine (the security-load-bearing surface):
 * deterministic turn-scoped event id; idempotent re-POST that RE-EMITS (redelivery); the event
 * built from the STORED row only; divergent-text-same-message_id → loud 409 with the
 * stored-event heal; the LOST unique race → typed 409 `conversation_turn_conflict` with ZERO emit
 * and NO in-tx recovery (both race arms staged as deterministic TOCTOU interposers — the
 * interposer precedent); bounds fail-closed; the message TEXT stored VERBATIM as DATA (trust boundary).
 */
import { describe, expect, it } from 'vitest';
import { type ResolvedConversationConfig, resolveConversationConfig } from './config.js';
import {
  ConversationEventRejectedError,
  createInMemoryTurnSubmittedSink,
  type TurnSubmittedSink,
} from './events.js';
import type { ConversationCoreContext, HandlerDb } from './ports.js';
import { submitTurn } from './submit-turn.js';
import { makeFakeConversationDb, SharedConversationTables } from './test-support/fake-db.js';

const TENANT_A = 'tenant-aaaa';
const TENANT_B = 'tenant-bbbb';

function ctx(
  tables: SharedConversationTables,
  tenantId = TENANT_A,
  config?: ResolvedConversationConfig,
): ConversationCoreContext {
  return {
    tenantId,
    db: makeFakeConversationDb(tables, tenantId),
    config: config ?? resolveConversationConfig(),
  };
}

function seedConversation(
  tables: SharedConversationTables,
  opts?: { conversationId?: string; tenantId?: string },
): void {
  const conversationId = opts?.conversationId ?? 'c-1';
  const tenantId = opts?.tenantId ?? TENANT_A;
  tables.conversations.push({
    conversation_id: conversationId,
    conversation_ref: `${tenantId}:${conversationId}`,
    owner: null,
    title: null,
    state: 'open',
    opened_at: '2026-07-05T00:00:00.000Z',
    tenant_id: tenantId,
  });
}

function turnBody(messageId: string, text: string): unknown {
  return { message_id: messageId, text };
}

/** A sink whose `emit` ALWAYS throws — models downstream faults per path. */
class ThrowingSink implements TurnSubmittedSink {
  emitCount = 0;
  constructor(private readonly toThrow: Error) {}
  async emit(): Promise<void> {
    this.emitCount += 1;
    throw this.toThrow;
  }
}

/**
 * Wrap a `HandlerDb` so `hook` runs ONCE, immediately BEFORE the first `insert` — the
 * deterministic TOCTOU seam (the fakes are single-threaded, so the race interleaving is staged by
 * running the racing operation between submit's decision reads and its insert — the interposer
 * precedent).
 */
function withBeforeFirstInsert(inner: HandlerDb, hook: () => Promise<void>): HandlerDb {
  let fired = false;
  const wrapped: HandlerDb = {
    ...inner,
    async insert(store, values) {
      if (!fired) {
        fired = true;
        await hook();
      }
      return inner.insert(store, values);
    },
    async transaction(fn) {
      // Delegate the REAL savepoint semantics to the inner fake, but thread the WRAPPER into the
      // nested scope — so the interposer still fires for an insert issued inside the savepoint
      // (submit-turn's conflict-safe insert shape).
      return inner.transaction(async () => fn(wrapped));
    },
  };
  return wrapped;
}

const sink = () => createInMemoryTurnSubmittedSink();

describe('submitTurn — persist + emit (the durability recipe)', () => {
  it('the FIRST turn persists seq 1 and emits the TURN-scoped event built from the STORED row', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const s = sink();

    const res = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'hello'),
      s,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value).toEqual({
      conversation_id: 'c-1',
      message_id: 'm-1',
      turn_seq: 1,
      event_id: `${TENANT_A}:c-1:m-1`,
      deduped: false,
    });
    // The ledger row: BOTH unique authorities + the reply seam columns.
    expect(tables.turns).toHaveLength(1);
    expect(tables.turns[0]).toMatchObject({
      conversation_id: 'c-1',
      conversation_ref: `${TENANT_A}:c-1`,
      message_id: 'm-1',
      turn_ref: `${TENANT_A}:c-1:m-1`,
      turn_seq: 1,
      seq_ref: `${TENANT_A}:c-1:1`,
      role: 'user',
      message: 'hello',
      run_id: null,
      state: 'submitted',
      tenant_id: TENANT_A,
    });
    expect(typeof tables.turns[0]?.submitted_at).toBe('string');
    // The event: server-derived from the stored row; the payload turn_ref is tenant-FREE.
    expect(s.emitCount()).toBe(1);
    expect(s.deliveredFor(`${TENANT_A}:c-1:m-1`)).toMatchObject({
      event_id: `${TENANT_A}:c-1:m-1`,
      tenant_id: TENANT_A,
      conversation_id: 'c-1',
      message_id: 'm-1',
      turn_ref: 'c-1:m-1',
      turn_seq: 1,
      role: 'user',
      message: 'hello',
      source_capability: 'conversation_input',
    });
    expect(typeof s.deliveredFor(`${TENANT_A}:c-1:m-1`)?.occurred_at).toBe('string');
  });

  it('a SECOND turn gets the next seq and a DISTINCT idempotency identity (per-TURN, never per-conversation — the single-flight turn-loss pin)', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const s = sink();

    const first = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'one'),
      s,
    );
    const second = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      turnBody('m-2', 'two'),
      s,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.value.turn_seq).toBe(2);
    // DISTINCT event ids + payload turn_refs for one conversation — a conversation-scoped key
    // would collapse these into ONE durable run (silent turn loss).
    expect(second.value.event_id).not.toBe(first.value.event_id);
    const delivered = s.delivered();
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered.map((e) => e.turn_ref)).size).toBe(2);
    expect(new Set(delivered.map((e) => e.conversation_id))).toEqual(new Set(['c-1']));
  });

  it('an IDENTICAL re-POST RE-EMITS the deduped event (redelivery) — one delivered event, one row (single-flight)', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const s = sink();

    const first = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'hello'),
      s,
    );
    const second = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'hello'),
      s,
    );
    expect(first.ok && !first.value.deduped).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.value).toEqual({
      conversation_id: 'c-1',
      message_id: 'm-1',
      turn_seq: 1,
      event_id: `${TENANT_A}:c-1:m-1`,
      deduped: true,
    });
    expect(s.emitCount()).toBe(2); // the re-POST RE-EMITTED …
    expect(s.deliveredCount()).toBe(1); // … and the sink deduped to ONE delivery (single-flight)
    expect(tables.turns).toHaveLength(1);
  });

  it('a turn for a conversation that was never created is a 409 conversation_not_created with zero emit', async () => {
    const tables = new SharedConversationTables();
    const s = sink();
    const res = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-none' },
      turnBody('m-1', 'x'),
      s,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('conversation_not_created');
    expect(s.emitCount()).toBe(0);
    expect(tables.turns).toHaveLength(0);
  });

  it("a FOREIGN tenant's conversation id yields the SAME non-disclosing 409 (tenant-scoped reads), zero emit, foreign rows untouched", async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables, { tenantId: TENANT_A });
    const s = sink();
    const res = await submitTurn(
      ctx(tables, TENANT_B),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'x'),
      s,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('conversation_not_created');
    expect(s.emitCount()).toBe(0);
    expect(tables.turns).toHaveLength(0);
    expect(tables.conversations[0]).toMatchObject({ tenant_id: TENANT_A });
  });
});

describe('submitTurn — the closed body shape (no spoof channel; the structural depth-DoS discipline)', () => {
  it('rejects a non-object body (422 invalid_turn_body)', async () => {
    for (const body of [undefined, null, 42, 'text', ['a']]) {
      const tables = new SharedConversationTables();
      seedConversation(tables);
      const res = await submitTurn(ctx(tables), { conversation_id: 'c-1' }, body, sink());
      expect(res.ok, JSON.stringify(body ?? 'undefined')).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_turn_body');
    }
  });

  it('rejects ANY unknown key — incl. every payload-envelope spoof (the payload is server-derived)', async () => {
    for (const extra of [
      { tenant_id: 'spoof' },
      { turn_ref: 'spoof' },
      { turn_seq: 99 },
      { role: 'assistant' },
      { source_capability: 'spoof' },
      { conversation_id: 'other' },
      { anything: 1 },
    ]) {
      const tables = new SharedConversationTables();
      seedConversation(tables);
      const res = await submitTurn(
        ctx(tables),
        { conversation_id: 'c-1' },
        { message_id: 'm-1', text: 'x', ...extra },
        sink(),
      );
      expect(res.ok, JSON.stringify(extra)).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_turn_body');
    }
  });

  it('rejects a missing/invalid message_id (422 message_id_invalid)', async () => {
    for (const body of [
      { text: 'x' },
      { message_id: 42, text: 'x' },
      { message_id: '', text: 'x' },
      { message_id: 'has space', text: 'x' },
      { message_id: 'x'.repeat(129), text: 'x' },
    ]) {
      const tables = new SharedConversationTables();
      seedConversation(tables);
      const res = await submitTurn(ctx(tables), { conversation_id: 'c-1' }, body, sink());
      expect(res.ok, JSON.stringify(body)).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('message_id_invalid');
    }
  });

  it("the message-id ':' belt holds even for a hand-built (resolver-bypassing) config", async () => {
    const config: ResolvedConversationConfig = {
      conversationIdPattern: /^[a-z0-9-]{1,64}$/,
      messageIdPattern: /^[a-z:-]{1,64}$/,
      maxMessageBytes: 1024,
      maxTurnBodyBytes: 5120,
      maxHistoryTurns: 4,
      maxHistoryChars: 4096,
    };
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const res = await submitTurn(
      ctx(tables, TENANT_A, config),
      { conversation_id: 'c-1' },
      turnBody('a:b', 'x'),
      sink(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(422);
    expect(res.error).toBe('message_id_invalid');
  });

  it('rejects a missing/non-string/empty text (422 invalid_turn_body)', async () => {
    for (const body of [
      { message_id: 'm-1' },
      { message_id: 'm-1', text: 42 },
      { message_id: 'm-1', text: null },
      { message_id: 'm-1', text: '' },
      { message_id: 'm-1', text: { nested: 'object' } },
    ]) {
      const tables = new SharedConversationTables();
      seedConversation(tables);
      const res = await submitTurn(ctx(tables), { conversation_id: 'c-1' }, body, sink());
      expect(res.ok, JSON.stringify(body)).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_turn_body');
    }
  });

  it("rejects U+0000 in the text (a Postgres 'text' column cannot store NUL) — the ONE char bound on the otherwise-verbatim DATA", async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const res = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'a\u0000b'),
      sink(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(422);
    expect(res.error).toBe('invalid_turn_body');
  });

  it('enforces the UTF-8 BYTE cap (413 message_too_large) — at the boundary and for multi-byte text', async () => {
    const cap = resolveConversationConfig().maxMessageBytes;
    // Exactly at the cap: accepted.
    {
      const tables = new SharedConversationTables();
      seedConversation(tables);
      const res = await submitTurn(
        ctx(tables),
        { conversation_id: 'c-1' },
        turnBody('m-1', 'x'.repeat(cap)),
        sink(),
      );
      expect(res.ok).toBe(true);
    }
    // One byte over: 413.
    {
      const tables = new SharedConversationTables();
      seedConversation(tables);
      const res = await submitTurn(
        ctx(tables),
        { conversation_id: 'c-1' },
        turnBody('m-1', 'x'.repeat(cap + 1)),
        sink(),
      );
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(413);
      expect(res.error).toBe('message_too_large');
    }
    // Multi-byte: the bound is BYTES, not chars ('ä' is 2 UTF-8 bytes — half the cap in chars
    // already exceeds it by one byte).
    {
      const tables = new SharedConversationTables();
      seedConversation(tables);
      const res = await submitTurn(
        ctx(tables),
        { conversation_id: 'c-1' },
        turnBody('m-1', 'ä'.repeat(cap / 2 + 1)),
        sink(),
      );
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(413);
    }
  });

  it('WHOLE-BODY-BOUND: the WHOLE turn body is byte-bounded (the record whole-payload discipline) — an oversize junk sibling with a SMALL text is the typed 413 BEFORE field validation, with ZERO side effects', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const s = sink();
    const res = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      // The text itself is tiny — only the WHOLE-body bound can catch the junk sibling as a
      // too-large condition (the per-field checks would call it a 422 unknown key AFTER chewing
      // through it).
      { message_id: 'm-1', text: 'hi', junk: 'x'.repeat(48 * 1024) },
      s,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(413);
    expect(res.error).toBe('turn_body_too_large');
    expect(tables.turns).toHaveLength(0); // zero row
    expect(s.emitCount()).toBe(0); // zero emit
  });

  it('WHOLE-BODY-BOUND: the whole-body bound is EXACT against the real config — one measured byte over is the 413; below it the CLOSED SHAPE still owns rejection (422 unknown key)', async () => {
    const cfg = resolveConversationConfig();
    const s = sink();
    // The shallow measure: own key names + own string values, raw UTF-8 bytes.
    const envelope = Buffer.byteLength('message_id' + 'm-1' + 'text' + 'hi' + 'junk', 'utf8');
    // Sub-bound junk: the 413 must NOT fire — the unknown-key 422 does (the bound never masks
    // the closed shape below it).
    {
      const tables = new SharedConversationTables();
      seedConversation(tables);
      const res = await submitTurn(
        ctx(tables),
        { conversation_id: 'c-1' },
        { message_id: 'm-1', text: 'hi', junk: 'x'.repeat(cfg.maxTurnBodyBytes - envelope) },
        s,
      );
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_turn_body');
    }
    // ONE measured byte over: the typed 413.
    {
      const tables = new SharedConversationTables();
      seedConversation(tables);
      const res = await submitTurn(
        ctx(tables),
        { conversation_id: 'c-1' },
        { message_id: 'm-1', text: 'hi', junk: 'x'.repeat(cfg.maxTurnBodyBytes - envelope + 1) },
        s,
      );
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(413);
      expect(res.error).toBe('turn_body_too_large');
      expect(tables.turns).toHaveLength(0);
    }
    expect(s.emitCount()).toBe(0);
  });

  it('stores the message TEXT VERBATIM as DATA (newlines/bidi/emoji pass through unmodified — the trust boundary; consumers own the framing)', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const s = sink();
    const text = 'line one\nline two\ttabbed \u202Ebidi\u202C zero\u200Bwidth 🎯 émoji';
    const res = await submitTurn(ctx(tables), { conversation_id: 'c-1' }, turnBody('m-1', text), s);
    expect(res.ok).toBe(true);
    expect(tables.turns[0]?.message).toBe(text);
    expect(s.deliveredFor(`${TENANT_A}:c-1:m-1`)?.message).toBe(text);
  });

  it('a HOSTILE deeply-nested body is a typed 422, never a stack overflow (the record depth-bound discipline realized structurally — nothing recurses over the body)', async () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const tables = new SharedConversationTables();
    seedConversation(tables);
    for (const body of [
      deep, // a deep array root — not a plain object
      { message_id: 'm-1', text: 't', extra: deep }, // deep value under an unknown key
      { message_id: 'm-1', text: deep }, // deep value where a string is required
    ]) {
      const res = await submitTurn(ctx(tables), { conversation_id: 'c-1' }, body, sink());
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
    }
  });
});

describe('submitTurn — the divergence contract (409 conversation_message_conflict)', () => {
  it('a re-POST of one message_id with DIFFERENT text is a loud 409: zero row change, and the stored-event heal re-emits the STORED text (never the request’s)', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const s = sink();
    await submitTurn(ctx(tables), { conversation_id: 'c-1' }, turnBody('m-1', 'original'), s);
    s.clear(); // isolate the heal emission

    const res = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'REVISED'),
      s,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('conversation_message_conflict');
    expect(tables.turns).toHaveLength(1);
    expect(tables.turns[0]?.message).toBe('original');
    // The heal delivered the STORED authoritative event exactly once.
    expect(s.emitCount()).toBe(1);
    expect(s.deliveredFor(`${TENANT_A}:c-1:m-1`)).toMatchObject({ message: 'original' });
  });

  it('the divergent-409 heal is BEST-EFFORT (generic sink fault swallowed; the 409 stands)', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    await submitTurn(ctx(tables), { conversation_id: 'c-1' }, turnBody('m-1', 'original'), sink());
    const throwing = new ThrowingSink(new Error('DBOS enqueue unavailable (transient)'));
    const res = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'REVISED'),
      throwing,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('conversation_message_conflict');
    expect(throwing.emitCount).toBe(1); // the heal WAS attempted (then swallowed best-effort)
  });

  it('the heal PRESERVES fail-closed: the ConversationEventRejectedError family propagates (→ 403)', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    await submitTurn(ctx(tables), { conversation_id: 'c-1' }, turnBody('m-1', 'original'), sink());
    const rejecting = new ThrowingSink(
      new ConversationEventRejectedError('cross_tenant', 'foreign'),
    );
    await expect(
      submitTurn(ctx(tables), { conversation_id: 'c-1' }, turnBody('m-1', 'REVISED'), rejecting),
    ).rejects.toBeInstanceOf(ConversationEventRejectedError);
  });
});

describe('submitTurn — the single-flight turn-seq races (deterministic TOCTOU interposers)', () => {
  it('ARM A — two DIFFERENT turns race one conversation: the loser gets the TYPED 409 conversation_turn_conflict with ZERO emit (never a silent overwrite), and its retry takes the next seq', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const s = sink();

    // THE RACE: our submit (m-1) read the tail (empty → seq 1); the racer (m-2) fully lands its
    // OWN seq-1 turn (persist + emit) before our insert fires.
    const db = withBeforeFirstInsert(makeFakeConversationDb(tables, TENANT_A), async () => {
      const racer = await submitTurn(
        ctx(tables),
        { conversation_id: 'c-1' },
        turnBody('m-2', 'racer text'),
        s,
      );
      expect(racer.ok).toBe(true); // the racer legitimately wins seq 1
    });
    const res = await submitTurn(
      { tenantId: TENANT_A, db, config: resolveConversationConfig() },
      { conversation_id: 'c-1' },
      turnBody('m-1', 'loser text'),
      s,
    );

    // LOUD, not silent: the loser's turn was NOT persisted, NOT emitted, and NOTHING overwrote
    // the winner (the naive upsert shape would have silently replaced the racer's row — turn loss).
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('conversation_turn_conflict');
    expect(tables.turns).toHaveLength(1);
    expect(tables.turns[0]).toMatchObject({
      message_id: 'm-2',
      message: 'racer text',
      turn_seq: 1,
    });
    expect(s.emitCount()).toBe(1); // ONLY the racer emitted
    expect(s.deliveredFor(`${TENANT_A}:c-1:m-1`)).toBeUndefined();

    // THE CONVERGENCE LAW: the loser retries with the SAME message_id → the next free seq.
    const retry = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'loser text'),
      s,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('unreachable');
    expect(retry.value.turn_seq).toBe(2);
    expect(retry.value.deduped).toBe(false);
    // BOTH turns exist — no turn was lost; each got its OWN durable-run identity.
    expect(tables.turns).toHaveLength(2);
    expect(s.deliveredCount()).toBe(2);
  });

  it('ARM B — the SAME message double-fires: the loser gets the typed 409 (zero second delivery), and its retry converges on the dedup path — ONE durable run (single-flight)', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const s = sink();

    // THE RACE: both fires carry the SAME message_id + text. Our fire read "no stored turn"
    // (dedup miss); the racer fully lands the turn before our insert fires → our insert collides
    // on turn_ref (and seq_ref).
    const db = withBeforeFirstInsert(makeFakeConversationDb(tables, TENANT_A), async () => {
      const racer = await submitTurn(
        ctx(tables),
        { conversation_id: 'c-1' },
        turnBody('m-1', 'same text'),
        s,
      );
      expect(racer.ok).toBe(true);
    });
    const res = await submitTurn(
      { tenantId: TENANT_A, db, config: resolveConversationConfig() },
      { conversation_id: 'c-1' },
      turnBody('m-1', 'same text'),
      s,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('conversation_turn_conflict');
    expect(tables.turns).toHaveLength(1);

    // THE CONVERGENCE LAW: the retry with the same message_id lands on the dedup path.
    const retry = await submitTurn(
      ctx(tables),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'same text'),
      s,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('unreachable');
    expect(retry.value).toMatchObject({ turn_seq: 1, deduped: true });
    expect(s.deliveredCount()).toBe(1); // ONE delivered event — ONE durable run for the turn
    expect(tables.turns).toHaveLength(1);
  });

  it('THE POISON LAW: the lost race leaves the ROUTE TX CLEAN — the typed 409 survives the engine transaction instead of becoming the outer-tx 500', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const s = sink();

    // ONE fake instance = ONE request's route tx (the fake's tx-poison model). Keep the BASE
    // reference: the wrapper below is the interposer view; the tx state lives on the base.
    const base = makeFakeConversationDb(tables, TENANT_A);
    const db = withBeforeFirstInsert(base, async () => {
      const racer = await submitTurn(
        ctx(tables),
        { conversation_id: 'c-1' },
        turnBody('m-1', 'same text'),
        s,
      );
      expect(racer.ok).toBe(true);
    });
    const res = await submitTurn(
      { tenantId: TENANT_A, db, config: resolveConversationConfig() },
      { conversation_id: 'c-1' },
      turnBody('m-1', 'same text'),
      s,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('conversation_turn_conflict');

    // ★ THE PIN: the unique violation must have been SAVEPOINT-scoped. An UNSCOPED in-tx 23505
    // poisons the route tx — postgres.js rejects the OUTER transaction promise with the
    // remembered raw error, so the handler's clean 409 is DISCARDED and the route 500s (the
    // composed-stack evidence; e2e arm (h) is the real-stack half of this proof).
    expect(base.poisoned).toBe(false);
    // The route tx stays usable after the 409 — a poisoned tx would 25P02 here.
    await expect(base.select('conversation_turns')).resolves.toHaveLength(1);
    // And the savepoint rollback undid ONLY this request's write: the winner's row is intact.
    expect(tables.turns).toHaveLength(1);
    expect(tables.turns[0]).toMatchObject({ message_id: 'm-1', message: 'same text' });
    expect(s.deliveredCount()).toBe(1); // ONE delivered event — the winner's
  });

  it('a NON-unique DB fault is NOT mapped to the 409 — it rethrows (genuine 500, never a masked fault)', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const inner = makeFakeConversationDb(tables, TENANT_A);
    const db: HandlerDb = {
      ...inner,
      async insert() {
        throw new Error('connection reset');
      },
      async transaction(fn) {
        // Thread THIS wrapper into the nested scope (the savepoint-shaped insert must still hit
        // the throwing insert above).
        return inner.transaction(async () => fn(db));
      },
    };
    await expect(
      submitTurn(
        { tenantId: TENANT_A, db, config: resolveConversationConfig() },
        { conversation_id: 'c-1' },
        turnBody('m-1', 'x'),
        sink(),
      ),
    ).rejects.toThrow('connection reset');
  });
});

describe('submitTurn — emit faults on the PRIMARY paths surface (the liveness decision, wire-faithful)', () => {
  it('a transient sink fault on the FIRST turn PROPAGATES (the row stays persisted under the unit-fake posture; the retry re-emits — the dual posture)', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const throwing = new ThrowingSink(new Error('DBOS enqueue unavailable (transient)'));
    await expect(
      submitTurn(ctx(tables), { conversation_id: 'c-1' }, turnBody('m-1', 'x'), throwing),
    ).rejects.toThrow('DBOS enqueue unavailable');
    // Under THIS unit-fake posture the db auto-commits, so the turn persisted and the retry lands
    // on the dedup path, which re-emits. Under the REAL platform the route runs inside the
    // engine's tenant transaction, so the surfaced fault rolls the insert back and the retry
    // re-persists. No silent zero-run either way.
    expect(tables.turns).toHaveLength(1);
  });

  it('DECISION (documented): the IDENTICAL re-POST re-emit is DELIBERATELY NOT best-effort — a transient fault SURFACES so the client keeps retrying until the turn is enqueued', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    await submitTurn(ctx(tables), { conversation_id: 'c-1' }, turnBody('m-1', 'x'), sink());
    const throwing = new ThrowingSink(new Error('DBOS enqueue unavailable (transient)'));
    await expect(
      submitTurn(ctx(tables), { conversation_id: 'c-1' }, turnBody('m-1', 'x'), throwing),
    ).rejects.toThrow('DBOS enqueue unavailable');
  });

  it('a ConversationEventRejectedError on the first turn propagates (the binding maps it to the clean 403)', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables);
    const rejecting = new ThrowingSink(
      new ConversationEventRejectedError('cross_tenant', 'foreign'),
    );
    await expect(
      submitTurn(ctx(tables), { conversation_id: 'c-1' }, turnBody('m-1', 'x'), rejecting),
    ).rejects.toBeInstanceOf(ConversationEventRejectedError);
  });
});

describe('submitTurn — tenant isolation by construction', () => {
  it('two tenants submit the SAME (conversation_id, message_id) over ONE shared global-unique table — both persist seq 1, distinct refs/event ids', async () => {
    const tables = new SharedConversationTables();
    seedConversation(tables, { tenantId: TENANT_A });
    seedConversation(tables, { tenantId: TENANT_B });
    const s = sink();

    const a = await submitTurn(
      ctx(tables, TENANT_A),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'from A'),
      s,
    );
    const b = await submitTurn(
      ctx(tables, TENANT_B),
      { conversation_id: 'c-1' },
      turnBody('m-1', 'from B'),
      s,
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.value.turn_seq).toBe(1);
    expect(b.value.turn_seq).toBe(1); // no cross-tenant seq collision (the tenant-prefixed seq_ref)
    expect(a.value.event_id).not.toBe(b.value.event_id);
    expect(tables.turns).toHaveLength(2);
    expect(s.deliveredCount()).toBe(2);
  });
});
