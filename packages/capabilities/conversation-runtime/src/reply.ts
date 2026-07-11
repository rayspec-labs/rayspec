/**
 * THE REPLY LEG — turn the committed intake into a persisted assistant reply through the
 * injected `ConversationTurnResponder`. Runs on the `routeTx: 'handler-managed'` posture: the
 * binding calls this AFTER the intake transaction committed, with NO transaction held — every
 * write below opens its OWN short `db.transaction(...)` (the intake-ordering law: the model runs
 * between two short txs, never inside one).
 *
 * ── THE REPLY ROW (reuses the S1 ledger columns — no schema change) ─────────────────────────────
 * message_id  = `reply~<user message_id>` — the '~' is OUTSIDE the client message-id alphabet
 *               (`[A-Za-z0-9_.-]`, config.ts), so a derived reply id can NEVER collide with a real
 *               client message id (a client submitting the literal text "reply~m-1" as its own
 *               message_id is rejected by the id shape at intake).
 * turn_ref    = the reply's DEDUP/single-flight authority (the ledger's global unique) — exactly
 *               one reply row can ever exist per user turn.
 * turn_seq    = the reply row's OWN next sequence (the S1 read-max+1 law).
 * run_id      = the deterministic reply run id (from the responder — C10 convergence).
 * state       = 'replied' (terminal; persisted only after a COMPLETED run).
 * The reply row EMITS NO EVENT (only user turns trigger workflows — row-event.ts fail-closes on a
 * non-user row; the sink is never called here).
 *
 * ── CONVERGENCE (C10 — the no-second-model-call law) ────────────────────────────────────────────
 * 1. Reply row exists → return it VERBATIM (zero responder/model calls — the dedup arm).
 * 2. No reply row → assemble the bounded window and call `respond` (the LIVE responder first
 *    ATTACHES to a completed run under the deterministic run id — a crash between model-success
 *    and reply-persist converges WITHOUT re-invoking the model).
 * 3. Persist the reply. A lost `turn_ref` race (a concurrent duplicate POST persisted first) is
 *    CONVERGENCE, not an error: re-read and return the winner's stored row — both callers see ONE
 *    reply. A lost `seq_ref` race (the user's NEXT turn took the seq) retries in a FRESH tx
 *    (bounded, `REPLY_PERSIST_MAX_ATTEMPTS`) — each attempt is its own transaction; there is NO
 *    in-tx 23505 recovery (the in-tx-poison law does not arise: nothing else shares the tx).
 *
 * ── THE HONEST SEQ-ORDERING LAW (PM-mandated, stated here AND in the package README) ───────────
 * The reply takes the next FREE sequence AT PERSIST TIME. If the user's next turn won the race,
 * the reply lands AFTER it in seq order (e.g. user#1 → user#2 → reply-to-#1 at seq 3): the ledger
 * honestly records arrival order; the reply↔turn association is the derived `reply~` message id,
 * NEVER seq adjacency. Neither client sees an error when the USER turn wins the seq — the reply
 * retries here. The converse race exists too (TF-F4, stated honestly): when the REPLY persist
 * wins a sequence a concurrent user turn had read, THAT turn's intake loses its `seq_ref` insert
 * and surfaces the S1 loud 409 `conversation_turn_conflict` — so the 409 is NOT user-vs-user
 * only; the client's same-message_id retry still converges (C10). On reply-retry exhaustion the
 * typed 503 carries the run id — the model output is durable under it and the client's
 * idempotent re-POST converges via arm 2 (no second model call).
 *
 * ── HONEST RESIDUALS (documented, not hidden) ───────────────────────────────────────────────────
 * At-least-once model cost on the NARROW window: two CONCURRENT duplicate POSTs where the
 * loser's dedup read + run-header attach both precede the winner's run completion may each run the
 * model once — the ledger still converges on ONE reply row (the `turn_ref` unique) and both
 * callers return the winner's text. (The former residual (b) — a terminally-FAILED first attempt
 * pinning the deterministic run id's header at 'failed' and journal-mixing a retry's events under
 * it — is FIXED by the TF-F1 attempt-scoped run-id walk in the live responder: a retry after a
 * terminal failure runs under a FRESH deterministic attempt id with its own clean header/journal;
 * the reply row records the attempt that succeeded, and attach still only ever reuses a COMPLETED
 * header.)
 */

import { assembleTurnInput, readHistoryWindow, readStoreContext } from './assemble.js';
import type { ConversationCapabilityError, ConversationCapabilityOk } from './errors.js';
import { ok } from './errors.js';
import { conversationRef, turnRef, turnSeqRef } from './keys.js';
import type { ConversationCoreContext } from './ports.js';
import type { ConversationTurnResponder } from './responder.js';
import { CONVERSATION_TURNS_STORE } from './stores.js';
import type { TurnReplyBlock, TurnSubmitResult } from './types.js';

/** The reply message-id prefix — '~' sits OUTSIDE the client id alphabet (module header). */
export const REPLY_MESSAGE_ID_PREFIX = 'reply~';

/** The derived reply message id for one user turn (the reply↔turn association). */
export function replyMessageId(userMessageId: string): string {
  return `${REPLY_MESSAGE_ID_PREFIX}${userMessageId}`;
}

/** Bounded fresh-tx retries on a lost reply-SEQ race (PM-locked cap: 3). */
export const REPLY_PERSIST_MAX_ATTEMPTS = 3;

/**
 * A reply-leg error: the closed capability error shape PLUS the deterministic reply `runId`
 * (STRUCTURAL, not detail-embedded — sharpening 6: the exhaustion error must CARRY the run id).
 * Present whenever the responder was reached (both reply-leg codes).
 */
export interface ReplyLegError extends ConversationCapabilityError {
  readonly runId: string;
}

export type ReplyLegResult = ConversationCapabilityOk<TurnReplyBlock> | ReplyLegError;

function replyErr(status: number, error: string, detail: string, runId: string): ReplyLegError {
  return { ok: false, status, error, detail, runId };
}

/**
 * (Duplicated VERBATIM from submit-turn.ts — that S1 core file stays byte-unchanged in S3, so the
 * 23505 detector is repeated here rather than extracted through it.) True if a thrown DB error is
 * the facade-sanitized Postgres UNIQUE violation; detection only, down a bounded cause chain.
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
 * Interpret a STORED ledger row as the reply block (the dedup/convergence read). Runtime-guarded
 * fail-closed (the S2 echo-point discipline applied to the S3 read): a row under a reply turn_ref
 * that is not an assistant/replied row with a run id is a construction bug — loud, never echoed.
 */
function replyBlockFromRow(
  row: Record<string, unknown>,
  usage?: TurnReplyBlock['usage'],
): TurnReplyBlock {
  if (row.role !== 'assistant' || row.state !== 'replied' || typeof row.run_id !== 'string') {
    throw new Error(
      'conversation-runtime: a reply-ref ledger row must be an assistant/replied row with a ' +
        `run_id (got role '${String(row.role)}', state '${String(row.state)}') — fail-closed.`,
    );
  }
  const seq = Number(row.turn_seq);
  return {
    message: String(row.message),
    turn_seq: Number.isFinite(seq) ? seq : 0,
    run_id: row.run_id,
    ...(usage ? { usage } : {}),
  };
}

/**
 * Produce (or converge on) the assistant reply for one COMMITTED intake. See the module header for
 * the full law. `intake` is the S1 submit result (the user turn's facts); the caller holds NO
 * transaction. Error results NEVER unwind the intake — the binding maps them to the reply-leg
 * error body carrying the intake facts.
 */
export async function ensureTurnReply(
  ctx: ConversationCoreContext,
  responder: ConversationTurnResponder,
  intake: TurnSubmitResult,
  // The streaming seam — an OPTIONAL live event sink threaded VERBATIM into the responder
  // (→ `runAgent`'s `opts.onEvent`), so the turn route's SSE leg forwards the reply run's events as
  // they are produced. ABSENT (every JSON turn) ⇒ the responder is called with no `onEvent` and
  // this path is byte-identical to the non-streaming path. The sink NEVER affects durability: it is fired on the SAME
  // COMPLETE-INDEPENDENTLY model leg (the reply persists regardless of any live consumer).
  opts?: { readonly onEvent?: (event: unknown) => void | Promise<void> },
): Promise<ReplyLegResult> {
  const conversationId = intake.conversation_id;
  const replyRef = turnRef(ctx.tenantId, conversationId, replyMessageId(intake.message_id));

  // 1. The dedup/convergence read: exactly one reply row can exist per user turn (turn_ref).
  const existing = await ctx.db.select(
    CONVERSATION_TURNS_STORE,
    { turn_ref: replyRef },
    { limit: 1 },
  );
  if (existing[0] !== undefined) return ok(replyBlockFromRow(existing[0]));

  // 2. Assemble the bounded trust-boundary-framed input (window: responder config CLAMPED to the capability
  //    config's resolved bounds — the responder narrows, the capability config is the belt).
  const turns = Math.min(responder.historyWindow.turns, ctx.config.maxHistoryTurns);
  const chars = Math.min(responder.historyWindow.chars, ctx.config.maxHistoryChars);
  const history = await readHistoryWindow(
    ctx.db,
    ctx.tenantId,
    conversationId,
    intake.turn_seq,
    turns,
  );
  const context = responder.storeContext
    ? {
        declared: responder.storeContext,
        rows: await readStoreContext(ctx.db, responder.storeContext, {
          conversation_id: conversationId,
          message_id: intake.message_id,
        }),
      }
    : undefined;
  const assembled = assembleTurnInput({ history, chars, ...(context ? { context } : {}) });

  // 3. The model leg — NO transaction held (the intake-ordering law). The live responder attaches
  //    to a completed deterministic run before ever re-invoking the model (C10).
  const userTurnRef = turnRef(ctx.tenantId, conversationId, intake.message_id);
  const outcome = await responder.respond({
    input: assembled.input,
    turnRef: userTurnRef,
    // S4: forward the live sink when the SSE leg supplied one (spread so ABSENT when it did not —
    // the S3 call shape byte-for-byte).
    ...(opts?.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  if (outcome.status !== 'completed') {
    return replyErr(
      502,
      'conversation_reply_failed',
      `the reply run '${outcome.runId}' failed (${outcome.errorClass ?? 'error'}: ` +
        `${outcome.message}) — the submitted turn IS persisted and its workflow event emitted; ` +
        'retry with the SAME message_id to converge on one reply.',
      outcome.runId,
    );
  }

  // 4. Persist the reply in its OWN short tx; bounded fresh-tx retries on a lost seq race.
  const convRef = conversationRef(ctx.tenantId, conversationId);
  for (let attempt = 0; attempt < REPLY_PERSIST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const inserted = await ctx.db.transaction(async (tx) => {
        const tail = await tx.select(
          CONVERSATION_TURNS_STORE,
          { conversation_ref: convRef },
          { orderBy: [{ column: 'turn_seq', dir: 'desc' }], limit: 1 },
        );
        const tailSeq = Number(tail[0]?.turn_seq);
        const nextSeq = (Number.isFinite(tailSeq) ? tailSeq : 0) + 1;
        return tx.insert(CONVERSATION_TURNS_STORE, {
          conversation_id: conversationId,
          conversation_ref: convRef,
          message_id: replyMessageId(intake.message_id),
          turn_ref: replyRef,
          turn_seq: nextSeq,
          seq_ref: turnSeqRef(ctx.tenantId, conversationId, nextSeq),
          role: 'assistant',
          message: outcome.text,
          run_id: outcome.runId,
          state: 'replied',
          submitted_at: new Date().toISOString(),
        });
      });
      return ok(replyBlockFromRow(inserted, outcome.usage));
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // A lost race on ONE of the two uniques. turn_ref lost = a concurrent duplicate persisted
      // the reply first → CONVERGENCE (return the winner verbatim). Otherwise it was seq_ref (the
      // user's next turn took the seq) → fresh-tx retry with the next free seq.
      const winner = await ctx.db.select(
        CONVERSATION_TURNS_STORE,
        { turn_ref: replyRef },
        { limit: 1 },
      );
      if (winner[0] !== undefined) return ok(replyBlockFromRow(winner[0]));
    }
  }
  return replyErr(
    503,
    'conversation_reply_persist_conflict',
    `the reply for run '${outcome.runId}' lost ${REPLY_PERSIST_MAX_ATTEMPTS} consecutive ` +
      'sequence races against concurrent turns — nothing was stored for the reply; the model ' +
      'output is durable under that run id. Retry with the SAME message_id to converge without ' +
      'a second model call.',
    outcome.runId,
  );
}
