/**
 * The manifest invariants: the committed `manifest.json` EQUALS the TS source of truth; the event
 * uses the DEFAULT `${capability}.${event}` join (the default-join rule — no alias); the descriptor is coherent
 * (key field within the payload keys; payload keys == the ONE envelope source); the payload
 * contract pins the runtime constants. The repo-level capability check re-asserts these from the
 * committed JSON — this test keeps JSON and TS from drifting.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProductTriggerEvent, PRODUCT_TRIGGER_EVENT_ALIASES } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { MAX_CANONICAL_JSON_DEPTH } from './canonical-json.js';
import { DEFAULT_MAX_RECORD_BYTES } from './config.js';
import { RECORD_CAPABILITY_MANIFEST } from './manifest.js';
import { RECORD_STORE_NAMES } from './stores.js';
import { RECORD_EVENT_ENVELOPE_KEYS } from './types.js';

const manifestJsonPath = join(dirname(fileURLToPath(import.meta.url)), '../manifest.json');

describe('RECORD_CAPABILITY_MANIFEST', () => {
  it('the committed manifest.json equals the TS source of truth', () => {
    const committed = JSON.parse(readFileSync(manifestJsonPath, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(RECORD_CAPABILITY_MANIFEST)));
  });

  it('pins the manifest self-consistency literals: status runtime, Tier B, runtime-available, canonical event id in contracts', () => {
    // Read the COMMITTED manifest.json (the source the capability check consumes) so a downgrade of
    // the on-disk value fails HERE directly — not only via the "equals TS source" drift test above.
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
    const cap = committed.capabilities.find((c) => c.id === 'record_input');
    expect(cap?.tier).toBe('B');
    expect(cap?.runtime_status).toBe('available');
    // The canonical DEFAULT-join event id must be present in the capability's contract list (what a
    // Product-YAML doc declares + the spec lint resolves triggers against).
    expect(cap?.contracts).toContain('record_input.record_submitted');
  });

  it('the record_submitted event uses the DEFAULT join and adds NO alias-table entry (the default-join rule)', () => {
    const cap = RECORD_CAPABILITY_MANIFEST.capabilities[0];
    const event = cap?.events[0];
    expect(cap?.id).toBe('record_input');
    expect(event?.id).toBe('record_submitted');
    // The canonical id IS the default join …
    expect(event?.contract).toBe('record_input.record_submitted');
    expect(normalizeProductTriggerEvent('record_input', 'record_submitted')).toBe(event?.contract);
    // … and the alias table stays audio-only (a record alias would violate the default-join convention).
    expect(PRODUCT_TRIGGER_EVENT_ALIASES.some((a) => a.capability === 'record_input')).toBe(false);
  });

  it('the descriptor is coherent: idempotency key field within payload keys; ONE envelope source', () => {
    const event = RECORD_CAPABILITY_MANIFEST.capabilities[0]?.events[0];
    expect(event?.idempotency_key_field).toBe('record_id');
    expect(event?.payload_keys).toContain(event?.idempotency_key_field);
    expect(event?.payload_keys).toEqual([...RECORD_EVENT_ENVELOPE_KEYS]);
    expect(event?.idempotency).toBe('record_scoped');
  });

  it('the payload contract pins the runtime constants (reserved keys == envelope; byte cap; depth cap)', () => {
    expect(RECORD_CAPABILITY_MANIFEST.payload_contract).toEqual({
      merged_into_event_payload: true,
      reserved_keys: [...RECORD_EVENT_ENVELOPE_KEYS],
      max_record_bytes: DEFAULT_MAX_RECORD_BYTES,
      max_record_depth: MAX_CANONICAL_JSON_DEPTH,
    });
  });

  it('the declared stores equal the store schema source (single source of names)', () => {
    expect([...RECORD_CAPABILITY_MANIFEST.stores].sort()).toEqual([...RECORD_STORE_NAMES].sort());
  });

  it('carries no product-specific vocabulary (the denylist)', () => {
    const serialized = JSON.stringify(RECORD_CAPABILITY_MANIFEST).toLowerCase();
    for (const word of ['meeting', 'recording', 'transcription', 'deepgram']) {
      expect(serialized.includes(word), `product word '${word}'`).toBe(false);
    }
  });
});
