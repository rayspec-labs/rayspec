/**
 * Point-of-use id-validation belts (the `validateMessageId` unit surface). Two STRUCTURAL belts
 * ride on top of the configured id pattern and hold EVEN for a hand-built / pathological config the
 * construction probes never rejected:
 *  - the ':' belt — ':' is the delimiter of every derived ref/idempotency key (keys.ts);
 *  - the reply-namespace belt (BELT-1) — a message id must NOT start with `REPLY_MESSAGE_ID_PREFIX`
 *    ('reply~'), the reserved namespace of the DERIVED assistant reply id (reply.ts). The construction
 *    probe belt (config.ts `REPLY_NAMESPACE_PROBES`) is convenience only: an anchored override like
 *    `/^reply~[0-9]$/` passes EVERY probe yet admits 'reply~5', so the point-of-use belt is the
 *    guarantee.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedConversationConfig } from './config.js';
import { resolveConversationConfig } from './config.js';
import { turnRef } from './keys.js';
import { REPLY_MESSAGE_ID_PREFIX, replyMessageId } from './reply.js';
import { validateMessageId } from './validate.js';

const TENANT = 'tenant-a';
const CONV = 'c-1';

/** A hand-built (resolver-bypassing) config — the resolver would reject a '~'-admitting pattern. */
function handBuilt(messageIdPattern: RegExp): ResolvedConversationConfig {
  return {
    conversationIdPattern: /^[a-z0-9-]{1,64}$/,
    messageIdPattern,
    maxMessageBytes: 1024,
    maxTurnBodyBytes: 5120,
    maxHistoryTurns: 4,
    maxHistoryChars: 4096,
  };
}

describe('validateMessageId — the reply-namespace point-of-use belt (BELT-1)', () => {
  it('BELT-1: the anchored `/^reply~[0-9]$/` override PASSES every construction probe (the probe belt is provably incomplete) — the point-of-use belt is the guarantee', () => {
    // The construction belt ACCEPTS this pattern: it never matches any REPLY_NAMESPACE_PROBES
    // canary ('~','reply~x','a~b','~a','a~'), so resolveConversationConfig does NOT throw — this is
    // the exact hole BELT-1 reported.
    const resolved = resolveConversationConfig({ messageIdPattern: /^reply~[0-9]$/ });
    expect(resolved.messageIdPattern.test('reply~5')).toBe(true);

    // THE WART this belt closes: the turn ledger derives a user turn's unique key as
    // turnRef(tenant, conv, message_id). For the client-chosen id 'reply~5' that is BYTE-IDENTICAL
    // to the reply row's turn_ref for the legit user message '5' — an accepted 'reply~5' user turn
    // PRE-OCCUPIES message '5''s reply slot, and '5''s reply leg then fails-closed forever.
    expect(turnRef(TENANT, CONV, 'reply~5')).toBe(turnRef(TENANT, CONV, replyMessageId('5')));

    // PRE-FIX: the pattern admits it, so validateMessageId ACCEPTS 'reply~5' (this assertion is RED).
    // POST-FIX: the point-of-use belt REJECTS it 422 regardless of the configured pattern.
    const res = validateMessageId(resolved, 'reply~5');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(422);
    expect(res.error).toBe('message_id_invalid');
  });

  it('BELT-1: the belt holds for a hand-built (resolver-bypassing) config admitting BOTH a bare id and its reply-namespaced form', () => {
    // A broad '~'-admitting pattern the resolver would have rejected at construction.
    const config = handBuilt(/^[a-z0-9~-]{1,64}$/);

    // The legit alphabet stays accepted (the belt matches the reserved prefix, not the '~' char).
    for (const ok of ['5', 'm-1', 'a~b']) {
      const r = validateMessageId(config, ok);
      expect(r.ok, `id '${ok}' should stay accepted`).toBe(true);
    }

    // The wart again: the accepted-under-this-pattern 'reply~5' collides with message '5''s reply.
    expect(turnRef(TENANT, CONV, 'reply~5')).toBe(turnRef(TENANT, CONV, replyMessageId('5')));

    // RED pre-fix (pattern admits it → accepted), GREEN post-fix (belt rejects it 422).
    const res = validateMessageId(config, 'reply~5');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(422);
    expect(res.error).toBe('message_id_invalid');
  });

  it("REJECTS any id starting with the reserved prefix — regardless of tail (imports REPLY_MESSAGE_ID_PREFIX, so it can't drift from reply.ts)", () => {
    const config = handBuilt(/^[a-z0-9~-]{1,64}$/);
    for (const id of [
      REPLY_MESSAGE_ID_PREFIX,
      `${REPLY_MESSAGE_ID_PREFIX}m-1`,
      `${REPLY_MESSAGE_ID_PREFIX}5`,
    ]) {
      const res = validateMessageId(config, id);
      expect(res.ok, `id '${id}' must be rejected`).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('message_id_invalid');
    }
  });

  it("default-pattern regression: ids that CONTAIN 'reply' WITHOUT the '~' separator stay accepted", () => {
    const config = resolveConversationConfig();
    for (const id of ['reply-5', 'replying', 'reply', 'reply.5', 'reply_5', 'm-1', '5']) {
      const res = validateMessageId(config, id);
      expect(res.ok, `id '${id}' should stay accepted`).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.value).toBe(id);
    }
    // Under the DEFAULT pattern 'reply~5' is already rejected by the id SHAPE ('~' is out of
    // alphabet) — still the typed 422 (the belt is redundant here, load-bearing only under an
    // override that admits '~').
    const denied = validateMessageId(config, 'reply~5');
    expect(denied.ok).toBe(false);
  });

  it("the existing ':' belt still fires at point-of-use (regression guard — untouched by BELT-1)", () => {
    // A hand-built pattern admitting ':' (the resolver would reject it) — the ':' belt rejects it.
    const config = handBuilt(/^[a-z0-9:~-]{1,64}$/);
    const res = validateMessageId(config, 'a:b');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(422);
    expect(res.error).toBe('message_id_invalid');
    expect(res.detail).toContain("':'");
  });
});
