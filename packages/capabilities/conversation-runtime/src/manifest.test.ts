/**
 * The manifest invariants: the committed `manifest.json` EQUALS the TS source of truth; the event
 * uses the DEFAULT `${capability}.${event}` join (the default-join rule — no alias); the descriptor is
 * coherent (key field within the payload keys; payload keys == the ONE payload-key source); the
 * turn contract pins the runtime constants; the ROUTE TUPLES are whole (method/kind/auth for BOTH
 * routes — the gate asserts manifest == mounted surface from these). The repo-level capability
 * check re-asserts these from the committed JSON — this test keeps JSON and TS from drifting.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProductTriggerEvent, PRODUCT_TRIGGER_EVENT_ALIASES } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_HISTORY_CHARS,
  DEFAULT_MAX_HISTORY_TURNS,
  DEFAULT_MAX_MESSAGE_BYTES,
} from './config.js';
import { CONVERSATION_CAPABILITY_MANIFEST } from './manifest.js';
import { CONVERSATION_STORE_NAMES } from './stores.js';
import { CONVERSATION_EVENT_PAYLOAD_KEYS } from './types.js';

const manifestJsonPath = join(dirname(fileURLToPath(import.meta.url)), '../manifest.json');

describe('CONVERSATION_CAPABILITY_MANIFEST', () => {
  it('the committed manifest.json equals the TS source of truth', () => {
    const committed = JSON.parse(readFileSync(manifestJsonPath, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(CONVERSATION_CAPABILITY_MANIFEST)));
  });

  it('pins the manifest self-consistency literals: status runtime, Tier B, runtime-available, canonical event id in contracts', () => {
    // Read the COMMITTED manifest.json (the source the capability check consumes) so a downgrade
    // of the on-disk value fails HERE directly — not only via the "equals TS source" drift test above.
    const committed = JSON.parse(readFileSync(manifestJsonPath, 'utf8')) as {
      status: string;
      capabilities: Array<{
        id: string;
        tier: string;
        runtime_status: string;
        contracts: string[];
      }>;
    };
    expect(committed.status).toBe('runtime');
    const cap = committed.capabilities.find((c) => c.id === 'conversation_input');
    expect(cap?.tier).toBe('B');
    expect(cap?.runtime_status).toBe('available');
    // The canonical DEFAULT-join event id must be present in the capability's contract list (what a
    // Product-YAML doc declares + the spec lint resolves triggers against).
    expect(cap?.contracts).toContain('conversation_input.turn_submitted');
  });

  it('the turn_submitted event uses the DEFAULT join and adds NO alias-table entry (the default-join rule)', () => {
    const cap = CONVERSATION_CAPABILITY_MANIFEST.capabilities[0];
    const event = cap?.events[0];
    expect(cap?.id).toBe('conversation_input');
    expect(event?.id).toBe('turn_submitted');
    // The canonical id IS the default join …
    expect(event?.contract).toBe('conversation_input.turn_submitted');
    expect(normalizeProductTriggerEvent('conversation_input', 'turn_submitted')).toBe(
      event?.contract,
    );
    // … and the alias table stays audio-only (a conversation alias would violate the default-join convention).
    expect(PRODUCT_TRIGGER_EVENT_ALIASES.some((a) => a.capability === 'conversation_input')).toBe(
      false,
    );
  });

  it('the descriptor is coherent: PER-TURN idempotency key field within payload keys; ONE payload-key source', () => {
    const event = CONVERSATION_CAPABILITY_MANIFEST.capabilities[0]?.events[0];
    expect(event?.idempotency_key_field).toBe('turn_ref');
    expect(event?.payload_keys).toContain(event?.idempotency_key_field);
    expect(event?.payload_keys).toEqual([...CONVERSATION_EVENT_PAYLOAD_KEYS]);
    expect(event?.idempotency).toBe('turn_scoped');
  });

  it('THE TURN-LOSS PIN (C10): the idempotency key field is NEVER conversation_id — a conversation-scoped key would dedupe every later turn into the FIRST durable run (silent turn loss)', () => {
    const event = CONVERSATION_CAPABILITY_MANIFEST.capabilities[0]?.events[0];
    expect(event?.idempotency_key_field).not.toBe('conversation_id');
    // The chosen field composes the conversation AND the per-turn message identity.
    expect(event?.idempotency_key_field).toBe('turn_ref');
  });

  it('the message TEXT is IN the payload keys (the PM-locked payload decision, gate-pinned) alongside the scope key', () => {
    const event = CONVERSATION_CAPABILITY_MANIFEST.capabilities[0]?.events[0];
    // The bounded message rides the payload (the record_input business-field precedent) …
    expect(event?.payload_keys).toContain('message');
    expect(CONVERSATION_CAPABILITY_MANIFEST.turn_contract.message_in_event_payload).toBe(true);
    // … and the single-scope law's key is present (persisted artifacts scope on `conversation`).
    expect(event?.payload_keys).toContain('conversation_id');
  });

  it('the turn contract pins the runtime constants (byte cap; history window bounds)', () => {
    expect(CONVERSATION_CAPABILITY_MANIFEST.turn_contract).toEqual({
      message_in_event_payload: true,
      max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
      max_history_turns: DEFAULT_MAX_HISTORY_TURNS,
      max_history_chars: DEFAULT_MAX_HISTORY_CHARS,
    });
  });

  it('the declared stores equal the store schema source (single source of names)', () => {
    expect([...CONVERSATION_CAPABILITY_MANIFEST.stores].sort()).toEqual(
      [...CONVERSATION_STORE_NAMES].sort(),
    );
  });

  it('declares BOTH routes as WHOLE tuples: the PUT handler create + the POST handler turn submit', () => {
    expect(CONVERSATION_CAPABILITY_MANIFEST.routes).toEqual([
      {
        id: 'conversation_create',
        method: 'PUT',
        path: '/{conversation_id}',
        contract: 'conversation_input.create',
        auth: 'bearer',
        kind: 'handler',
      },
      {
        id: 'conversation_turn_submit',
        method: 'POST',
        path: '/{conversation_id}/turns',
        contract: 'conversation_input.submit_turn',
        auth: 'bearer',
        kind: 'handler',
      },
    ]);
  });

  it('carries no product-specific vocabulary (the denylist)', () => {
    const serialized = JSON.stringify(CONVERSATION_CAPABILITY_MANIFEST).toLowerCase();
    for (const word of [
      'meeting',
      'recording',
      'transcription',
      'deepgram',
      'invoice',
      'expense',
      'support',
      'ticket',
      'recruiting',
    ]) {
      expect(serialized.includes(word), `product word '${word}'`).toBe(false);
    }
  });
});
