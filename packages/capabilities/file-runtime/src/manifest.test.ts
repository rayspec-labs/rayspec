/**
 * The manifest invariants: the committed `manifest.json` EQUALS the TS source of truth; the event
 * uses the DEFAULT `${capability}.${event}` join (the default-join rule — no alias); the descriptor is
 * coherent (key field within the payload keys; payload keys == the ONE payload-key source); the
 * ingest contract pins the runtime constants; the ROUTE TUPLES are whole (method/kind/auth for
 * BOTH routes — the S2 gate asserts manifest == mounted surface from these). The repo-level
 * capability check (S2) re-asserts these from the committed JSON — this test keeps JSON and TS
 * from drifting.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProductTriggerEvent, PRODUCT_TRIGGER_EVENT_ALIASES } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_FILE_CONTENT_TYPES, DEFAULT_MAX_FILE_BYTES } from './config.js';
import { FILE_CAPABILITY_MANIFEST } from './manifest.js';
import { FILE_STORE_NAMES } from './stores.js';
import { FILE_EVENT_PAYLOAD_KEYS } from './types.js';

const manifestJsonPath = join(dirname(fileURLToPath(import.meta.url)), '../manifest.json');

describe('FILE_CAPABILITY_MANIFEST', () => {
  it('the committed manifest.json equals the TS source of truth', () => {
    const committed = JSON.parse(readFileSync(manifestJsonPath, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(FILE_CAPABILITY_MANIFEST)));
  });

  it('pins the manifest self-consistency literals: status runtime, Tier B, runtime-available, canonical event id in contracts', () => {
    // Read the COMMITTED manifest.json (the source the S2 capability check consumes) so a downgrade
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
    const cap = committed.capabilities.find((c) => c.id === 'file_input');
    expect(cap?.tier).toBe('B');
    expect(cap?.runtime_status).toBe('available');
    // The canonical DEFAULT-join event id must be present in the capability's contract list (what a
    // Product-YAML doc declares + the spec lint resolves triggers against).
    expect(cap?.contracts).toContain('file_input.file_submitted');
  });

  it('the file_submitted event uses the DEFAULT join and adds NO alias-table entry (the default-join rule)', () => {
    const cap = FILE_CAPABILITY_MANIFEST.capabilities[0];
    const event = cap?.events[0];
    expect(cap?.id).toBe('file_input');
    expect(event?.id).toBe('file_submitted');
    // The canonical id IS the default join …
    expect(event?.contract).toBe('file_input.file_submitted');
    expect(normalizeProductTriggerEvent('file_input', 'file_submitted')).toBe(event?.contract);
    // … and the alias table stays audio-only (a file alias would violate the S1 convention).
    expect(PRODUCT_TRIGGER_EVENT_ALIASES.some((a) => a.capability === 'file_input')).toBe(false);
  });

  it('the descriptor is coherent: idempotency key field within payload keys; ONE payload-key source; bytes NEVER among the keys', () => {
    const event = FILE_CAPABILITY_MANIFEST.capabilities[0]?.events[0];
    expect(event?.idempotency_key_field).toBe('file_id');
    expect(event?.payload_keys).toContain(event?.idempotency_key_field);
    expect(event?.payload_keys).toEqual([...FILE_EVENT_PAYLOAD_KEYS]);
    expect(event?.idempotency).toBe('file_scoped');
    // Metadata-only: no key that could carry the raw bytes.
    for (const bytesish of ['bytes', 'body', 'content', 'data']) {
      expect(event?.payload_keys).not.toContain(bytesish);
    }
  });

  it('the ingest contract pins the runtime constants (byte cap; allowlist; bytes-never-in-payload)', () => {
    expect(FILE_CAPABILITY_MANIFEST.ingest_contract).toEqual({
      bytes_in_event_payload: false,
      max_file_bytes: DEFAULT_MAX_FILE_BYTES,
      allowed_content_types: [...DEFAULT_ALLOWED_FILE_CONTENT_TYPES],
    });
  });

  it('the declared stores equal the store schema source (single source of names)', () => {
    expect([...FILE_CAPABILITY_MANIFEST.stores].sort()).toEqual([...FILE_STORE_NAMES].sort());
  });

  it('declares BOTH routes as WHOLE tuples: the PUT stream-ingest upload + the POST handler submit', () => {
    expect(FILE_CAPABILITY_MANIFEST.routes).toEqual([
      {
        id: 'file_upload',
        method: 'PUT',
        path: '/{file_id}',
        contract: 'file_input.upload',
        auth: 'bearer',
        kind: 'stream_ingest',
      },
      {
        id: 'file_submit',
        method: 'POST',
        path: '/{file_id}/submit',
        contract: 'file_input.submit',
        auth: 'bearer',
        kind: 'handler',
      },
    ]);
  });

  it('carries no product-specific vocabulary (the denylist)', () => {
    const serialized = JSON.stringify(FILE_CAPABILITY_MANIFEST).toLowerCase();
    for (const word of [
      'memovo',
      'meeting',
      'recording',
      'transcription',
      'deepgram',
      'invoice',
      'expense',
    ]) {
      expect(serialized.includes(word), `product word '${word}'`).toBe(false);
    }
  });
});
