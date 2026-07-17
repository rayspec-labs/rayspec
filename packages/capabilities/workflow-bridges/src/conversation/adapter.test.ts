/**
 * The canonical seam mapping — fail-the-fix couplings:
 *  - the payload keys equal the MANIFEST descriptor's payload_keys (the contract) AND are
 *    exactly what the adapter emits — nothing more (no client channel), nothing less;
 *  - every field is the SERVER-DERIVED value from the capability event (stored-row provenance);
 *  - THE single-flight TURN-LOSS PIN: the idempotency field is PER-TURN — two turns of ONE conversation
 *    derive DISTINCT single-flight keys (a conversation-keyed field would collapse every later
 *    turn into the first durable run: silent turn loss);
 *  - the event type is the DEFAULT join with NO alias-table entry.
 */
import type { SubmittedTurnEvent } from '@rayspec/conversation-runtime';
import { CONVERSATION_CAPABILITY_MANIFEST } from '@rayspec/conversation-runtime';
import { payloadFieldIdempotencyKey } from '@rayspec/workflow-durable';
import { describe, expect, it } from 'vitest';
import {
  submittedTurnEventToWorkflowInput,
  TURN_SUBMITTED_EVENT_TYPE,
  TURN_SUBMITTED_PAYLOAD_KEYS,
} from './adapter.js';

const TENANT = 'tenant-aaaa';

function event(overrides?: Partial<SubmittedTurnEvent>): SubmittedTurnEvent {
  return {
    event_id: `${TENANT}:c-1:m-1`,
    tenant_id: TENANT,
    conversation_id: 'c-1',
    message_id: 'm-1',
    turn_ref: 'c-1:m-1',
    turn_seq: 1,
    role: 'user',
    message: 'what is the refund policy?\nsecond line',
    occurred_at: '2026-07-05T00:00:00.000Z',
    source_capability: 'conversation_input',
    ...overrides,
  };
}

describe('submittedTurnEventToWorkflowInput', () => {
  it('maps onto the neutral event: default-join type, turn-scoped id, the EXACT server-derived payload (message text VERBATIM)', () => {
    const input = submittedTurnEventToWorkflowInput(event());
    expect(input).toEqual({
      id: `${TENANT}:c-1:m-1`,
      type: 'conversation_input.turn_submitted',
      occurred_at: '2026-07-05T00:00:00.000Z',
      payload: {
        conversation_id: 'c-1',
        message_id: 'm-1',
        turn_ref: 'c-1:m-1',
        tenant_id: TENANT,
        source_capability: 'conversation_input',
        turn_seq: 1,
        role: 'user',
        message: 'what is the refund policy?\nsecond line',
      },
    });
  });

  it('the payload keys ARE the manifest descriptor payload_keys (the coupling) incl. the key field — and NOTHING more', () => {
    const descriptor = CONVERSATION_CAPABILITY_MANIFEST.capabilities[0]?.events[0];
    expect(descriptor?.contract).toBe(TURN_SUBMITTED_EVENT_TYPE);
    expect([...(descriptor?.payload_keys ?? [])]).toEqual([...TURN_SUBMITTED_PAYLOAD_KEYS]);
    // The WHOLE invariant (assert EVERY key, not "≥1 key"): the emitted payload's
    // key set EQUALS the descriptor's — no extra channel can ride along, none can go missing.
    const input = submittedTurnEventToWorkflowInput(event());
    expect(Object.keys(input.payload).sort()).toEqual([...TURN_SUBMITTED_PAYLOAD_KEYS].sort());
    // … and the descriptor's idempotency key field is among them (single-flight never falls back).
    expect(TURN_SUBMITTED_PAYLOAD_KEYS).toContain(descriptor?.idempotency_key_field ?? '');
    // The scope key (persisted artifacts scope on `conversation`) is a payload key.
    expect(TURN_SUBMITTED_PAYLOAD_KEYS).toContain('conversation_id');
  });

  it('THE single-flight TURN-LOSS PIN: two turns of ONE conversation derive DISTINCT dispatcher idempotency keys through the REAL derivation (conversation-keying would collapse them into one run)', () => {
    const descriptor = CONVERSATION_CAPABILITY_MANIFEST.capabilities[0]?.events[0];
    const keyFn = payloadFieldIdempotencyKey(descriptor?.idempotency_key_field ?? '');
    const turn1 = submittedTurnEventToWorkflowInput(
      event({ event_id: `${TENANT}:c-1:m-1`, message_id: 'm-1', turn_ref: 'c-1:m-1', turn_seq: 1 }),
    );
    const turn2 = submittedTurnEventToWorkflowInput(
      event({ event_id: `${TENANT}:c-1:m-2`, message_id: 'm-2', turn_ref: 'c-1:m-2', turn_seq: 2 }),
    );
    // Same conversation, different turns → DIFFERENT single-flight keys (each turn = its own run).
    expect(turn1.payload.conversation_id).toBe(turn2.payload.conversation_id);
    expect(keyFn(turn1)).not.toBe(keyFn(turn2));
    // A re-POST of the SAME turn → the SAME key (retry = redelivery, one run).
    expect(keyFn(turn1)).toBe(keyFn(submittedTurnEventToWorkflowInput(event())));
    // And the derived key is a non-fallback per-turn value (never `event:` per-delivery).
    expect(keyFn(turn1)).toBe('turn_ref:c-1:m-1');
  });
});
