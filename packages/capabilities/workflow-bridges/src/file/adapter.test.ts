/**
 * The canonical seam mapping — fail-the-fix couplings:
 *  - the payload keys equal the MANIFEST descriptor's payload_keys (the contract) AND are
 *    exactly what the adapter emits — nothing more (no client channel), nothing less;
 *  - every field is the SERVER-DERIVED value from the capability event (stored-row provenance);
 *  - the raw bytes are NEVER in the payload (blob_key is a pointer, not content);
 *  - the event type is the DEFAULT join with NO alias-table entry.
 */
import type { SubmittedFileEvent } from '@rayspec/file-runtime';
import { FILE_CAPABILITY_MANIFEST } from '@rayspec/file-runtime';
import { describe, expect, it } from 'vitest';
import {
  FILE_SUBMITTED_EVENT_TYPE,
  FILE_SUBMITTED_PAYLOAD_KEYS,
  submittedFileEventToWorkflowInput,
} from './adapter.js';

const TENANT = 'tenant-aaaa';

function event(overrides?: Partial<SubmittedFileEvent>): SubmittedFileEvent {
  return {
    event_id: `${TENANT}:f-1`,
    tenant_id: TENANT,
    file_id: 'f-1',
    sha256: 'a'.repeat(64),
    size_bytes: 42,
    content_type: 'text/plain',
    original_filename: 'q3-notes.txt',
    blob_key: 'files/f-1',
    occurred_at: '2026-07-04T00:00:00.000Z',
    source_capability: 'file_input',
    ...overrides,
  };
}

describe('submittedFileEventToWorkflowInput', () => {
  it('maps onto the neutral event: default-join type, file-scoped id, the EXACT server-derived payload', () => {
    const input = submittedFileEventToWorkflowInput(event());
    expect(input).toEqual({
      id: `${TENANT}:f-1`,
      type: 'file_input.file_submitted',
      occurred_at: '2026-07-04T00:00:00.000Z',
      payload: {
        file_id: 'f-1',
        tenant_id: TENANT,
        source_capability: 'file_input',
        sha256: 'a'.repeat(64),
        size_bytes: 42,
        content_type: 'text/plain',
        original_filename: 'q3-notes.txt',
        blob_key: 'files/f-1',
      },
    });
  });

  it('a null original_filename stays a present-but-null payload key (stable key set)', () => {
    const input = submittedFileEventToWorkflowInput(event({ original_filename: null }));
    expect(Object.keys(input.payload)).toContain('original_filename');
    expect(input.payload.original_filename).toBeNull();
  });

  it('the payload keys ARE the manifest descriptor payload_keys (the coupling) incl. the key field — and NOTHING more', () => {
    const descriptor = FILE_CAPABILITY_MANIFEST.capabilities[0]?.events[0];
    expect(descriptor?.contract).toBe(FILE_SUBMITTED_EVENT_TYPE);
    expect([...(descriptor?.payload_keys ?? [])]).toEqual([...FILE_SUBMITTED_PAYLOAD_KEYS]);
    // The WHOLE invariant (assert EVERY key, not "≥1 key"): the emitted payload's
    // key set EQUALS the descriptor's — no extra channel can ride along, none can go missing.
    const input = submittedFileEventToWorkflowInput(event());
    expect(Object.keys(input.payload).sort()).toEqual([...FILE_SUBMITTED_PAYLOAD_KEYS].sort());
    // … and the descriptor's idempotency key field is among them (single-flight never falls back).
    expect(FILE_SUBMITTED_PAYLOAD_KEYS).toContain(descriptor?.idempotency_key_field ?? '');
  });
});
