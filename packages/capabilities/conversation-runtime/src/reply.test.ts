/**
 * The reply leg (reply.ts), fail-the-fix over the constraint-enforcing fake db:
 *  - C10 DEDUP: an existing reply row short-circuits BEFORE the responder (the fake counts
 *    invocations — zero model work on the dedup arm);
 *  - the reply ROW: own next seq, derived `reply~` message id + turn_ref, role/state/run_id set,
 *    NO event emitted (the ledger's assistant row triggers nothing);
 *  - the SEQ-race retry: a concurrent turn stealing the sequence makes the persist lose seq_ref —
 *    a FRESH-tx retry lands on the next free seq (bounded; exhaustion = typed 503 CARRYING runId);
 *  - the turn_ref CONVERGENCE: a concurrent duplicate's persisted reply wins — the loser returns
 *    the WINNER's stored text (one reply, both callers agree), never an error;
 *  - a responder ERROR maps to the typed 502 carrying runId; NOTHING is persisted for the reply;
 *  - the input CONTRACT: the responder receives the trust-boundary-assembled input containing the prior
 *    turns (the unit half of the turn-2-saw-turn-1 law; the e2e drives it through the real stack).
 */
import { describe, expect, it } from 'vitest';
import { resolveConversationConfig } from './config.js';
import { conversationRef, turnRef, turnSeqRef } from './keys.js';
import type { ConversationCoreContext } from './ports.js';
import { ensureTurnReply, REPLY_PERSIST_MAX_ATTEMPTS, replyMessageId } from './reply.js';
import type { ConversationTurnResponder, TurnReplyOutcome } from './responder.js';
import { CONVERSATION_TURNS_STORE } from './stores.js';
import {
  type FakeConversationDb,
  makeFakeConversationDb,
  SharedConversationTables,
} from './test-support/fake-db.js';
import type { TurnSubmitResult } from './types.js';

const TENANT = 'tenant-reply';
const CONV = 'conv-r';

function ctxFor(db: FakeConversationDb): ConversationCoreContext {
  return { tenantId: TENANT, db, config: resolveConversationConfig() };
}

async function seedUserTurn(
  db: FakeConversationDb,
  seq: number,
  messageId: string,
  text: string,
): Promise<void> {
  await db.insert(CONVERSATION_TURNS_STORE, {
    conversation_id: CONV,
    conversation_ref: conversationRef(TENANT, CONV),
    message_id: messageId,
    turn_ref: turnRef(TENANT, CONV, messageId),
    turn_seq: seq,
    seq_ref: turnSeqRef(TENANT, CONV, seq),
    role: 'user',
    message: text,
    run_id: null,
    state: 'submitted',
    submitted_at: new Date().toISOString(),
  });
}

function intakeFor(seq: number, messageId: string): TurnSubmitResult {
  return {
    conversation_id: CONV,
    message_id: messageId,
    turn_seq: seq,
    event_id: `${TENANT}:${CONV}:${messageId}`,
    deduped: false,
  };
}

/** A counting fake responder; derives its reply from the RECEIVED input (the history proof). */
class FakeResponder implements ConversationTurnResponder {
  readonly agentId = 'test_responder';
  readonly historyWindow = { turns: 20, chars: 64 * 1024 };
  calls: Array<{ input: string; turnRef: string }> = [];
  outcome: (args: { input: string; turnRef: string }) => TurnReplyOutcome = ({
    input,
    turnRef,
  }) => ({
    status: 'completed',
    runId: `run-${turnRef.split(':').pop()}`,
    text: `REPLY[${input.length}]`,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  /** Optional hook fired BEFORE returning (simulates concurrent activity during the model run). */
  beforeReturn?: () => Promise<void>;
  /** True iff `respond` was handed an `onEvent` sink (the streaming thread). */
  receivedOnEvent = false;
  /** Events this responder forwards through the received `onEvent` (simulates a live run). */
  emit: unknown[] = [];

  async respond(args: {
    input: string;
    turnRef: string;
    onEvent?: (event: unknown) => void | Promise<void>;
  }): Promise<TurnReplyOutcome> {
    this.calls.push({ input: args.input, turnRef: args.turnRef });
    if (args.onEvent) {
      this.receivedOnEvent = true;
      for (const e of this.emit) await args.onEvent(e);
    }
    await this.beforeReturn?.();
    return this.outcome(args);
  }
}

describe('ensureTurnReply — the onEvent thread (additive; default-absent = the non-streaming path, byte-identical)', () => {
  it('threads opts.onEvent through to the responder, which forwards its live events', async () => {
    const tables = new SharedConversationTables();
    const db = makeFakeConversationDb(tables, TENANT);
    await seedUserTurn(db, 1, 'm-1', 'hello');
    const responder = new FakeResponder();
    responder.emit = [
      { type: 'text_delta', text: 'hi' },
      { type: 'run_completed', status: 'ok' },
    ];
    const seen: unknown[] = [];
    const result = await ensureTurnReply(ctxFor(db), responder, intakeFor(1, 'm-1'), {
      onEvent: (e) => void seen.push(e),
    });
    expect(result.ok).toBe(true);
    expect(responder.receivedOnEvent).toBe(true);
    expect(seen).toEqual([
      { type: 'text_delta', text: 'hi' },
      { type: 'run_completed', status: 'ok' },
    ]);
  });

  it('opts ABSENT → the responder receives NO onEvent (the non-streaming reply path, unchanged)', async () => {
    const tables = new SharedConversationTables();
    const db = makeFakeConversationDb(tables, TENANT);
    await seedUserTurn(db, 1, 'm-1', 'hello');
    const responder = new FakeResponder();
    responder.emit = [{ type: 'text_delta', text: 'x' }];
    const result = await ensureTurnReply(ctxFor(db), responder, intakeFor(1, 'm-1'));
    expect(result.ok).toBe(true);
    expect(responder.receivedOnEvent).toBe(false);
  });
});

describe('ensureTurnReply — the fresh path', () => {
  it('persists the assistant reply row (own seq, derived refs, run_id, replied state) and returns it', async () => {
    const tables = new SharedConversationTables();
    const db = makeFakeConversationDb(tables, TENANT);
    await seedUserTurn(db, 1, 'm-1', 'hello');
    const responder = new FakeResponder();

    const result = await ensureTurnReply(ctxFor(db), responder, intakeFor(1, 'm-1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turn_seq).toBe(2);
    expect(result.value.run_id).toBe('run-m-1');
    expect(result.value.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });

    const rows = tables.turns.filter((r) => r.role === 'assistant');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message_id: replyMessageId('m-1'),
      turn_ref: turnRef(TENANT, CONV, replyMessageId('m-1')),
      turn_seq: 2,
      seq_ref: turnSeqRef(TENANT, CONV, 2),
      state: 'replied',
      run_id: 'run-m-1',
    });
    expect(responder.calls).toHaveLength(1);
  });

  it('the responder receives the assembled input CONTAINING the prior turns (turn-2-saw-turn-1)', async () => {
    const tables = new SharedConversationTables();
    const db = makeFakeConversationDb(tables, TENANT);
    await seedUserTurn(db, 1, 'm-1', 'my printer is on fire');
    // Turn 1's reply row (seq 2), then the second user turn (seq 3).
    const responder = new FakeResponder();
    await ensureTurnReply(ctxFor(db), responder, intakeFor(1, 'm-1'));
    await seedUserTurn(db, 3, 'm-2', 'it is getting worse');

    await ensureTurnReply(ctxFor(db), responder, intakeFor(3, 'm-2'));
    const input = responder.calls[1]?.input ?? '';
    // The prior user turn AND the prior assistant reply are both in the window — as jailed DATA.
    expect(input).toContain('my printer is on fire');
    expect(input).toContain('"role":"assistant"');
    expect(input).toContain('it is getting worse');
    // Ordering: turn 1 appears BEFORE turn 3 (oldest first).
    expect(input.indexOf('my printer is on fire')).toBeLessThan(
      input.indexOf('it is getting worse'),
    );
  });
});

describe('ensureTurnReply — C10 convergence', () => {
  it('DEDUP: an existing reply row returns VERBATIM with ZERO responder calls', async () => {
    const tables = new SharedConversationTables();
    const db = makeFakeConversationDb(tables, TENANT);
    await seedUserTurn(db, 1, 'm-1', 'hello');
    const first = new FakeResponder();
    await ensureTurnReply(ctxFor(db), first, intakeFor(1, 'm-1'));

    const second = new FakeResponder();
    const result = await ensureTurnReply(ctxFor(db), second, intakeFor(1, 'm-1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.message).toBe(
      first.calls.length === 1 ? `REPLY[${first.calls[0]?.input.length}]` : '',
    );
    expect(result.value.run_id).toBe('run-m-1');
    // THE PIN: zero model work on the dedup arm.
    expect(second.calls).toHaveLength(0);
    // A ledger-served reply reports no usage (honest — no fresh run happened).
    expect(result.value.usage).toBeUndefined();
  });

  it('a turn interleaved DURING the model run shifts the reply to the next free seq (no conflict — the tail read already sees it)', async () => {
    const tables = new SharedConversationTables();
    const db = makeFakeConversationDb(tables, TENANT);
    await seedUserTurn(db, 1, 'm-1', 'hello');
    const responder = new FakeResponder();
    // While the model "runs", the user's NEXT turn takes seq 2 — BEFORE the persist loop starts,
    // so attempt 1's tail read already sees it and lands on seq 3 first try (honestly: this arm
    // never raises a unique violation; the retry-executing arm below does).
    responder.beforeReturn = async () => {
      await seedUserTurn(db, 2, 'm-2', 'follow-up');
    };
    const result = await ensureTurnReply(ctxFor(db), responder, intakeFor(1, 'm-1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The reply landed AFTER the interleaved user turn — the honest seq-ordering law.
    expect(result.value.turn_seq).toBe(3);
    const reply = tables.turns.find((r) => r.role === 'assistant');
    expect(reply?.seq_ref).toBe(turnSeqRef(TENANT, CONV, 3));
  });

  it('SEQ race: a seq stolen BETWEEN the tail read and the insert 23505s attempt 1 — the FRESH-tx retry ACTUALLY executes and lands on the next free seq', async () => {
    const tables = new SharedConversationTables();
    const db = makeFakeConversationDb(tables, TENANT);
    await seedUserTurn(db, 1, 'm-1', 'hello');
    const responder = new FakeResponder();

    // Interpose INSIDE the persist transaction: after attempt 1's tail read chose its seq (the
    // insert values are computed), a concurrent user turn steals exactly that seq_ref — the
    // insert raises the sanitized 23505 and the loop MUST retry in a FRESH tx.
    const rawTransaction = db.transaction.bind(db);
    let txAttempts = 0;
    let steals = 0;
    (db as { transaction: FakeConversationDb['transaction'] }).transaction = async (fn) =>
      rawTransaction(async (tx) => {
        txAttempts += 1;
        const guarded: typeof tx = {
          ...tx,
          insert: async (store, values) => {
            if (store === CONVERSATION_TURNS_STORE && values.role === 'assistant' && steals === 0) {
              steals += 1;
              const thief = makeFakeConversationDb(tables, TENANT);
              await thief.insert(CONVERSATION_TURNS_STORE, {
                conversation_id: CONV,
                conversation_ref: conversationRef(TENANT, CONV),
                message_id: 'thief-1',
                turn_ref: turnRef(TENANT, CONV, 'thief-1'),
                turn_seq: values.turn_seq,
                seq_ref: values.seq_ref,
                role: 'user',
                message: 'stolen',
                run_id: null,
                state: 'submitted',
                submitted_at: new Date().toISOString(),
              });
            }
            return tx.insert(store, values);
          },
        };
        return fn(guarded);
      });

    const result = await ensureTurnReply(ctxFor(db), responder, intakeFor(1, 'm-1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ★ THE RETRY PIN: the theft fired exactly once, attempt 1's insert lost, and the SECOND
    // (fresh-tx) attempt is what persisted — the retry path provably executed at unit level.
    expect(steals).toBe(1);
    expect(txAttempts).toBe(2);
    expect(result.value.turn_seq).toBe(3);
    const replies = tables.turns.filter((r) => r.role === 'assistant');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.seq_ref).toBe(turnSeqRef(TENANT, CONV, 3));
    // ONE model call — the retry re-persists the SAME outcome, never re-invokes the responder.
    expect(responder.calls).toHaveLength(1);
  });

  it('turn_ref CONVERGENCE: a concurrent duplicate that persisted first WINS; the loser returns its text', async () => {
    const tables = new SharedConversationTables();
    const db = makeFakeConversationDb(tables, TENANT);
    await seedUserTurn(db, 1, 'm-1', 'hello');
    const responder = new FakeResponder();
    // While the loser's model "runs", the winner persists ITS reply row for the same turn.
    responder.beforeReturn = async () => {
      const winnerDb = makeFakeConversationDb(tables, TENANT);
      await winnerDb.insert(CONVERSATION_TURNS_STORE, {
        conversation_id: CONV,
        conversation_ref: conversationRef(TENANT, CONV),
        message_id: replyMessageId('m-1'),
        turn_ref: turnRef(TENANT, CONV, replyMessageId('m-1')),
        turn_seq: 2,
        seq_ref: turnSeqRef(TENANT, CONV, 2),
        role: 'assistant',
        message: 'THE WINNER TEXT',
        run_id: 'run-m-1',
        state: 'replied',
        submitted_at: new Date().toISOString(),
      });
    };
    const result = await ensureTurnReply(ctxFor(db), responder, intakeFor(1, 'm-1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both callers converge on ONE reply — the winner's stored row, verbatim.
    expect(result.value.message).toBe('THE WINNER TEXT');
    expect(tables.turns.filter((r) => r.role === 'assistant')).toHaveLength(1);
  });

  it(`exhaustion after ${REPLY_PERSIST_MAX_ATTEMPTS} lost seq races is the typed 503 CARRYING runId`, async () => {
    const tables = new SharedConversationTables();
    const db = makeFakeConversationDb(tables, TENANT);
    await seedUserTurn(db, 1, 'm-1', 'hello');
    const responder = new FakeResponder();
    // Steal EVERY next seq: before the model returns AND via a hostile ledger that keeps growing.
    let stolen = 1;
    responder.beforeReturn = async () => {
      stolen += 1;
      await seedUserTurn(db, stolen, `steal-${stolen}`, 'x');
    };
    // Keep stealing on every retry read by monkey-patching select's tail read is complex — instead
    // pre-steal a long run of seqs after the model returns once: wrap transaction to inject a
    // competitor between the tail read and the insert of EVERY attempt.
    const rawTransaction = db.transaction.bind(db);
    let steals = 0;
    (db as { transaction: FakeConversationDb['transaction'] }).transaction = async (fn) =>
      rawTransaction(async (tx) => {
        const guarded: typeof tx = {
          ...tx,
          insert: async (store, values) => {
            if (store === CONVERSATION_TURNS_STORE && values.role === 'assistant') {
              steals += 1;
              const winnerDb = makeFakeConversationDb(tables, TENANT);
              await winnerDb.insert(CONVERSATION_TURNS_STORE, {
                conversation_id: CONV,
                conversation_ref: conversationRef(TENANT, CONV),
                message_id: `steal-tx-${steals}`,
                turn_ref: turnRef(TENANT, CONV, `steal-tx-${steals}`),
                turn_seq: values.turn_seq,
                seq_ref: values.seq_ref,
                role: 'user',
                message: 'stolen',
                run_id: null,
                state: 'submitted',
                submitted_at: new Date().toISOString(),
              });
            }
            return tx.insert(store, values);
          },
        };
        return fn(guarded);
      });

    const result = await ensureTurnReply(ctxFor(db), responder, intakeFor(1, 'm-1'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.error).toBe('conversation_reply_persist_conflict');
    expect(result.runId).toBe('run-m-1');
    expect(steals).toBe(REPLY_PERSIST_MAX_ATTEMPTS);
    // Nothing assistant-shaped was stored (every attempt lost + rolled back).
    expect(tables.turns.filter((r) => r.role === 'assistant')).toHaveLength(0);
  });
});

describe('ensureTurnReply — the responder error arm', () => {
  it('maps a failed run to the typed 502 CARRYING runId; nothing persisted; intake untouched', async () => {
    const tables = new SharedConversationTables();
    const db = makeFakeConversationDb(tables, TENANT);
    await seedUserTurn(db, 1, 'm-1', 'hello');
    const responder = new FakeResponder();
    responder.outcome = () => ({
      status: 'error',
      runId: 'run-err',
      errorClass: 'upstream_5xx',
      message: 'model exploded',
    });
    const result = await ensureTurnReply(ctxFor(db), responder, intakeFor(1, 'm-1'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error).toBe('conversation_reply_failed');
    expect(result.runId).toBe('run-err');
    // The user turn stays (the intake is not this function's to unwind); no assistant row.
    expect(tables.turns).toHaveLength(1);
    expect(tables.turns[0]?.role).toBe('user');
  });
});
