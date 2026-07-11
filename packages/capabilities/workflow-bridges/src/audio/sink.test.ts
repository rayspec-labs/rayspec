import { type FinalizedSessionEvent, SessionEventRejectedError } from '@rayspec/audio-runtime';
import type {
  WorkflowDispatchResult,
  WorkflowEventIngress,
  WorkflowInputEvent,
} from '@rayspec/workflow-durable';
import { describe, expect, it } from 'vitest';
import { CrossTenantSessionEventError, WorkflowIngressSessionFinalizedSink } from './sink.js';

/** A recording `WorkflowEventIngress` — captures every emitted neutral event (no dedup here). */
class RecordingIngress implements WorkflowEventIngress {
  readonly emitted: WorkflowInputEvent[] = [];
  async emit(event: WorkflowInputEvent): Promise<WorkflowDispatchResult> {
    this.emitted.push(event);
    return { enqueued: [] };
  }
}

function finalizedEvent(overrides: Partial<FinalizedSessionEvent> = {}): FinalizedSessionEvent {
  return {
    event_id: 'tenant-a:sess-1',
    tenant_id: 'tenant-a',
    session_id: 'sess-1',
    tracks: [{ track: 'mic', committed_byte_len: 12 }],
    occurred_at: '2026-07-02T00:00:00.000Z',
    source_capability: 'audio_input',
    ...overrides,
  };
}

describe('WorkflowIngressSessionFinalizedSink', () => {
  it('adapts + forwards a matching-tenant finalized session to the ingress', async () => {
    const ingress = new RecordingIngress();
    const sink = new WorkflowIngressSessionFinalizedSink({ ingress, tenantId: 'tenant-a' });
    await sink.emit(finalizedEvent());
    expect(ingress.emitted).toHaveLength(1);
    expect(ingress.emitted[0]).toEqual({
      id: 'tenant-a:sess-1',
      type: 'audio_input.finalized_session',
      occurred_at: '2026-07-02T00:00:00.000Z',
      payload: {
        session_id: 'sess-1',
        tenant_id: 'tenant-a',
        tracks: [{ track: 'mic', committed_byte_len: 12 }],
        source_capability: 'audio_input',
      },
    });
  });

  it('FAIL-CLOSED: a cross-tenant event throws and is NEVER forwarded/enqueued', async () => {
    const ingress = new RecordingIngress();
    // The dispatcher is bound to tenant-a; an event carrying tenant-b must never enqueue.
    const sink = new WorkflowIngressSessionFinalizedSink({ ingress, tenantId: 'tenant-a' });
    await expect(
      sink.emit(finalizedEvent({ tenant_id: 'tenant-b', event_id: 'tenant-b:sess-1' })),
    ).rejects.toBeInstanceOf(CrossTenantSessionEventError);
    // The load-bearing invariant: the mismatched event did NOT reach the ingress.
    expect(ingress.emitted).toHaveLength(0);
  });

  it('the cross-tenant error carries the bound + event tenants for the operator', async () => {
    const ingress = new RecordingIngress();
    const sink = new WorkflowIngressSessionFinalizedSink({ ingress, tenantId: 'tenant-a' });
    await sink
      .emit(finalizedEvent({ tenant_id: 'tenant-b', event_id: 'tenant-b:sess-1' }))
      .then(() => {
        throw new Error('expected a CrossTenantSessionEventError');
      })
      .catch((e: unknown) => {
        expect(e).toBeInstanceOf(CrossTenantSessionEventError);
        const err = e as CrossTenantSessionEventError;
        expect(err.boundTenant).toBe('tenant-a');
        expect(err.eventTenant).toBe('tenant-b');
        expect(err.eventId).toBe('tenant-b:sess-1');
        // E2E-2 seam coupling: the rejection IS a SessionEventRejectedError with the stable reason,
        // so the audio route binding maps a caller-visible clean 403 (never an unhandled 500) —
        // while the sink itself keeps throwing (the fail-closed zero-enqueue law above is unchanged).
        expect(e).toBeInstanceOf(SessionEventRejectedError);
        expect(err.reason).toBe('cross_tenant');
      });
  });

  it('re-emits every seal path to the ingress (the dispatcher dedups, not the sink)', async () => {
    const ingress = new RecordingIngress();
    const sink = new WorkflowIngressSessionFinalizedSink({ ingress, tenantId: 'tenant-a' });
    // A dual-track finalize re-emits the SAME session-scoped event twice — the sink forwards BOTH
    // (single-flight is the dispatcher's per-session enqueue key, not the sink's job).
    await sink.emit(finalizedEvent());
    await sink.emit(finalizedEvent());
    expect(ingress.emitted).toHaveLength(2);
    expect(ingress.emitted[0]).toEqual(ingress.emitted[1]);
  });
});
