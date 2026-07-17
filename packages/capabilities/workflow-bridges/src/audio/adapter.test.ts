import { AUDIO_CAPABILITY_MANIFEST, type FinalizedSessionEvent } from '@rayspec/audio-runtime';
import { sessionScopedIdempotencyKey } from '@rayspec/workflow-durable';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_FINALIZED_SESSION_EVENT_TYPE,
  AUDIO_FINALIZED_SESSION_PAYLOAD_KEYS,
  finalizedSessionEventToWorkflowInput,
} from './adapter.js';

function finalizedEvent(overrides: Partial<FinalizedSessionEvent> = {}): FinalizedSessionEvent {
  return {
    event_id: 'tenant-a:sess-1',
    tenant_id: 'tenant-a',
    session_id: 'sess-1',
    tracks: [
      { track: 'mic', committed_byte_len: 12 },
      { track: 'system', committed_byte_len: 34 },
    ],
    occurred_at: '2026-07-02T00:00:00.000Z',
    source_capability: 'audio_input',
    ...overrides,
  };
}

describe('finalizedSessionEventToWorkflowInput', () => {
  it('maps the finalized-session event onto the neutral WorkflowInputEvent shape', () => {
    const wf = finalizedSessionEventToWorkflowInput(finalizedEvent());
    expect(wf).toEqual({
      id: 'tenant-a:sess-1',
      type: AUDIO_FINALIZED_SESSION_EVENT_TYPE,
      occurred_at: '2026-07-02T00:00:00.000Z',
      payload: {
        session_id: 'sess-1',
        tenant_id: 'tenant-a',
        tracks: [
          { track: 'mic', committed_byte_len: 12 },
          { track: 'system', committed_byte_len: 34 },
        ],
        source_capability: 'audio_input',
      },
    });
  });

  it('emits the constant trigger event id the dispatcher matches on', () => {
    expect(finalizedSessionEventToWorkflowInput(finalizedEvent()).type).toBe(
      'audio_input.finalized_session',
    );
  });

  it('AUDIO_FINALIZED_SESSION_PAYLOAD_KEYS is EXACTLY the emitted payload key set (the coupling)', () => {
    // The compose-time scope validation trusts this constant as the trigger payload CONTRACT — if
    // the mapping ever gains/loses a payload key without updating the constant, this test fails.
    const wf = finalizedSessionEventToWorkflowInput(finalizedEvent());
    expect(Object.keys(wf.payload).sort()).toEqual(
      [...AUDIO_FINALIZED_SESSION_PAYLOAD_KEYS].sort(),
    );
  });

  it('carries session_id in the payload so the default session-scoped key is per-session-stable', () => {
    const wf = finalizedSessionEventToWorkflowInput(finalizedEvent());
    // The dispatcher's DEFAULT keyer reads payload.session_id — the mapping MUST feed it.
    expect(sessionScopedIdempotencyKey('session_id')(wf)).toBe('session_id:sess-1:finalized');
  });

  it('keeps the key session-stable across a dual-track re-emit (same session → same key)', () => {
    // Both tracks re-emit the SAME session-scoped event; the derived key must be identical.
    const mic = finalizedSessionEventToWorkflowInput(
      finalizedEvent({ tracks: [{ track: 'mic', committed_byte_len: 1 }] }),
    );
    const system = finalizedSessionEventToWorkflowInput(
      finalizedEvent({
        tracks: [
          { track: 'mic', committed_byte_len: 1 },
          { track: 'system', committed_byte_len: 2 },
        ],
      }),
    );
    const key = sessionScopedIdempotencyKey('session_id');
    expect(key(mic)).toBe(key(system));
  });

  it('the manifest event DESCRIPTOR is the adapter contract (the registry coupling)', () => {
    // The deploy composition consumes the MANIFEST descriptor (payload_keys for the scope
    // check; idempotency_key_field for the single-flight key) — this couples it fail-the-fix to the
    // adapter, the code that ACTUALLY emits the payload. A descriptor/adapter drift fails here.
    const audio = AUDIO_CAPABILITY_MANIFEST.capabilities.find((c) => c.id === 'audio_input');
    const descriptor = audio?.events.find((e) => e.contract === AUDIO_FINALIZED_SESSION_EVENT_TYPE);
    expect(descriptor?.payload_keys).toEqual(AUDIO_FINALIZED_SESSION_PAYLOAD_KEYS);
    const wf = finalizedSessionEventToWorkflowInput(finalizedEvent());
    expect(Object.keys(wf.payload).sort()).toEqual([...(descriptor?.payload_keys ?? [])].sort());
    // The descriptor-declared key field derives the EXACT byte-stable live key format.
    expect(descriptor?.idempotency_key_field).toBe('session_id');
    expect(sessionScopedIdempotencyKey(descriptor?.idempotency_key_field ?? '')(wf)).toBe(
      'session_id:sess-1:finalized',
    );
  });

  it('the id fallback (event:<id>) is ALSO session-stable because id is session-scoped', () => {
    // If payload.session_id were ever absent, the fallback keys on the event id — which is
    // `${tenant}:${session}`, still per-session-stable (never a cross-session merge, never a per-emit key).
    const wf = finalizedSessionEventToWorkflowInput(finalizedEvent());
    expect(sessionScopedIdempotencyKey('missing_field')(wf)).toBe('event:tenant-a:sess-1');
  });
});
