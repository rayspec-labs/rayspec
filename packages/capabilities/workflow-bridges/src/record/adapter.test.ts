/**
 * The canonical seam mapping — fail-the-fix couplings:
 *  - the envelope keys equal the MANIFEST descriptor's payload_keys (the contract) AND are
 *    exactly what the adapter stamps over the payload;
 *  - business fields merge TOP-LEVEL (the store_write `{event:}` reachability law);
 *  - the ENVELOPE WINS a key collision (defense-in-depth under the route's reserved-key rejection);
 *  - the event type is the DEFAULT join with NO alias-table entry.
 */

import type { SubmittedRecordEvent } from '@rayspec/record-runtime';
import { RECORD_CAPABILITY_MANIFEST } from '@rayspec/record-runtime';
import { describe, expect, it } from 'vitest';
import {
  RECORD_SUBMITTED_ENVELOPE_KEYS,
  RECORD_SUBMITTED_EVENT_TYPE,
  submittedRecordEventToWorkflowInput,
} from './adapter.js';

const TENANT = 'tenant-aaaa';

function event(record: Record<string, unknown>): SubmittedRecordEvent {
  return {
    event_id: `${TENANT}:rec-1`,
    tenant_id: TENANT,
    record_id: 'rec-1',
    record,
    occurred_at: '2026-07-04T00:00:00.000Z',
    source_capability: 'record_input',
  };
}

describe('submittedRecordEventToWorkflowInput', () => {
  it('maps onto the neutral event: default-join type, record-scoped id, MERGED top-level payload', () => {
    const input = submittedRecordEventToWorkflowInput(
      event({ title: 'Fix the door', amount_cents: 1200 }),
    );
    expect(input).toEqual({
      id: `${TENANT}:rec-1`,
      type: 'record_input.record_submitted',
      occurred_at: '2026-07-04T00:00:00.000Z',
      payload: {
        // business fields TOP-LEVEL (reachable by store_write {event: title} etc.) …
        title: 'Fix the door',
        amount_cents: 1200,
        // … alongside the FIXED envelope.
        record_id: 'rec-1',
        tenant_id: TENANT,
        source_capability: 'record_input',
      },
    });
  });

  it('the ENVELOPE WINS a key collision (defense-in-depth under the 422 reserved-key rejection)', () => {
    const input = submittedRecordEventToWorkflowInput(
      event({ record_id: 'SPOOF', tenant_id: 'SPOOF', source_capability: 'SPOOF', ok: 1 }),
    );
    expect(input.payload).toMatchObject({
      record_id: 'rec-1',
      tenant_id: TENANT,
      source_capability: 'record_input',
      ok: 1,
    });
  });

  it('the envelope keys ARE the manifest descriptor payload_keys (the coupling) incl. the key field', () => {
    const descriptor = RECORD_CAPABILITY_MANIFEST.capabilities[0]?.events[0];
    expect(descriptor?.contract).toBe(RECORD_SUBMITTED_EVENT_TYPE);
    expect([...(descriptor?.payload_keys ?? [])]).toEqual([...RECORD_SUBMITTED_ENVELOPE_KEYS]);
    // Every envelope key is ALWAYS present on the emitted payload (the whole-invariant check) …
    const input = submittedRecordEventToWorkflowInput(event({}));
    for (const key of RECORD_SUBMITTED_ENVELOPE_KEYS) {
      expect(Object.keys(input.payload)).toContain(key);
    }
    // … and the descriptor's idempotency key field is among them (C10 never falls back).
    expect(RECORD_SUBMITTED_ENVELOPE_KEYS).toContain(descriptor?.idempotency_key_field ?? '');
  });
});
