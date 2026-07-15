/**
 * Config resolution invariants — the record/file construction belt: every derived ref/idempotency key
 * joins on ':' (`conversation_ref`/`turn_ref`/`seq_ref`/`event_id`), so an id that can carry ':'
 * corrupts refs/keys. The DEFAULT patterns exclude the delimiter by construction; an OVERRIDE that
 * admits it is rejected fail-closed at construction (deploy-time loud), and validate.ts carries a
 * point-of-use belt for a hand-built config. The numeric bounds are ALSO construction-validated (a
 * NaN cap would break the byte bound OPEN — the one override this capability can never accept
 * silently).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONVERSATION_ID_RE,
  DEFAULT_MAX_HISTORY_CHARS,
  DEFAULT_MAX_HISTORY_TURNS,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MESSAGE_ID_RE,
  MAX_MESSAGE_BYTES_CEILING,
  resolveConversationConfig,
  TURN_BODY_ENVELOPE_HEADROOM_BYTES,
} from './config.js';

describe('resolveConversationConfig — the ref-delimiter law', () => {
  it("the DEFAULT id patterns exclude ':' (the ref/idempotency-key delimiter)", () => {
    for (const probe of [':', 'a:b', ':a', 'a:']) {
      expect(DEFAULT_CONVERSATION_ID_RE.test(probe), `conversation probe '${probe}'`).toBe(false);
      expect(DEFAULT_MESSAGE_ID_RE.test(probe), `message probe '${probe}'`).toBe(false);
    }
  });

  it("REJECTS at construction an id-pattern override that admits ':' — BOTH id kinds, fail-closed", () => {
    for (const pattern of [/^[a-z:]{1,64}$/, /^.{1,64}$/, /^[\x20-\x7e]{1,64}$/]) {
      expect(
        () => resolveConversationConfig({ conversationIdPattern: pattern }),
        `conversationIdPattern ${String(pattern)}`,
      ).toThrow(/':'/);
      expect(
        () => resolveConversationConfig({ messageIdPattern: pattern }),
        `messageIdPattern ${String(pattern)}`,
      ).toThrow(/':'/);
    }
  });

  it('a sticky/global override cannot skew the probe (flag-stripped copy)', () => {
    expect(() => resolveConversationConfig({ conversationIdPattern: /^[a-z:]{1,8}$/g })).toThrow(
      /':'/,
    );
  });

  it("the DEFAULT message-id pattern excludes '~' (the derived reply-id namespace separator)", () => {
    for (const probe of ['~', 'reply~x', 'a~b', '~a', 'a~']) {
      expect(DEFAULT_MESSAGE_ID_RE.test(probe), `message probe '${probe}'`).toBe(false);
    }
  });

  it("REJECTS at construction a messageIdPattern override that admits '~' — the reply~ namespace would become client-forgeable", () => {
    for (const pattern of [/^[a-z~-]{1,64}$/, /^[\w~.]{1,64}$/, /^[a-z0-9~_.-]{1,128}$/]) {
      expect(
        () => resolveConversationConfig({ messageIdPattern: pattern }),
        `messageIdPattern ${String(pattern)}`,
      ).toThrow(/'~'/);
    }
    // A sticky/global override cannot skew this probe either (the same flag-stripped copy).
    expect(() => resolveConversationConfig({ messageIdPattern: /^[a-z~]{1,8}$/g })).toThrow(/'~'/);
  });

  it("a conversationIdPattern override admitting '~' stays ACCEPTED (the reply namespace rides message ids only — documented)", () => {
    const resolved = resolveConversationConfig({ conversationIdPattern: /^[a-z0-9~-]{1,32}$/ });
    expect(resolved.conversationIdPattern.test('conv~1')).toBe(true);
  });

  it('a narrowing messageIdPattern override WITHOUT the tilde still resolves (previously-valid ids stay accepted)', () => {
    const resolved = resolveConversationConfig({ messageIdPattern: /^[a-z0-9_.-]{1,64}$/ });
    expect(resolved.messageIdPattern.test('m-1_a.b')).toBe(true);
    expect(resolved.messageIdPattern.test('reply~m-1')).toBe(false);
    // The DEFAULT pattern likewise accepts the whole previously-valid alphabet.
    expect(DEFAULT_MESSAGE_ID_RE.test('Msg_01.a-b')).toBe(true);
  });

  it('accepts a narrowing override that cannot admit the delimiter', () => {
    const resolved = resolveConversationConfig({ conversationIdPattern: /^[a-z0-9-]{1,32}$/ });
    expect(resolved.conversationIdPattern.test('abc-1')).toBe(true);
    expect(resolved.conversationIdPattern.test('a:b')).toBe(false);
  });

  it('the defaults resolve as documented (byte cap + history window)', () => {
    const resolved = resolveConversationConfig();
    expect(resolved.maxMessageBytes).toBe(DEFAULT_MAX_MESSAGE_BYTES);
    expect(DEFAULT_MAX_MESSAGE_BYTES).toBe(32 * 1024);
    expect(resolved.maxHistoryTurns).toBe(DEFAULT_MAX_HISTORY_TURNS);
    expect(DEFAULT_MAX_HISTORY_TURNS).toBe(20);
    expect(resolved.maxHistoryChars).toBe(DEFAULT_MAX_HISTORY_CHARS);
    expect(DEFAULT_MAX_HISTORY_CHARS).toBe(64 * 1024);
  });

  it('maxMessageBytes has a HARD CEILING — an override above the journal-friendliness class (the record 64 KiB whole-payload donor) is a construction error, never a silent widening', () => {
    // The ceiling IS the record whole-payload class bound (DEFAULT_MAX_RECORD_BYTES = 64 KiB).
    expect(MAX_MESSAGE_BYTES_CEILING).toBe(64 * 1024);
    // At the ceiling: accepted (a deployment may consciously widen up to the class bound) …
    expect(
      resolveConversationConfig({ maxMessageBytes: MAX_MESSAGE_BYTES_CEILING }).maxMessageBytes,
    ).toBe(64 * 1024);
    // … one byte above: fail-closed at construction.
    expect(() =>
      resolveConversationConfig({ maxMessageBytes: MAX_MESSAGE_BYTES_CEILING + 1 }),
    ).toThrow(/ceiling/);
  });

  it('the whole-turn-body bound is DERIVED (maxMessageBytes + the fixed envelope headroom) — it tracks an override and exceeds the text cap BY CONSTRUCTION', () => {
    const resolved = resolveConversationConfig();
    expect(resolved.maxTurnBodyBytes).toBe(
      DEFAULT_MAX_MESSAGE_BYTES + TURN_BODY_ENVELOPE_HEADROOM_BYTES,
    );
    // Tracks a narrowed/widened message cap (no independent override knob to mis-set).
    expect(resolveConversationConfig({ maxMessageBytes: 1024 }).maxTurnBodyBytes).toBe(
      1024 + TURN_BODY_ENVELOPE_HEADROOM_BYTES,
    );
    expect(
      resolveConversationConfig({ maxMessageBytes: MAX_MESSAGE_BYTES_CEILING }).maxTurnBodyBytes,
    ).toBe(MAX_MESSAGE_BYTES_CEILING + TURN_BODY_ENVELOPE_HEADROOM_BYTES);
    // The belt cannot be mis-set: the whole-body bound strictly exceeds the text cap.
    expect(resolved.maxTurnBodyBytes).toBeGreaterThan(resolved.maxMessageBytes);
  });

  it('REJECTS at construction a bound override that would break a cap open (NaN/0/negative/fraction) — all three bounds', () => {
    for (const bad of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => resolveConversationConfig({ maxMessageBytes: bad }), String(bad)).toThrow();
      expect(() => resolveConversationConfig({ maxHistoryTurns: bad }), String(bad)).toThrow();
      expect(() => resolveConversationConfig({ maxHistoryChars: bad }), String(bad)).toThrow();
    }
    expect(resolveConversationConfig({ maxMessageBytes: 1024 }).maxMessageBytes).toBe(1024);
    expect(resolveConversationConfig({ maxHistoryTurns: 4 }).maxHistoryTurns).toBe(4);
  });
});
