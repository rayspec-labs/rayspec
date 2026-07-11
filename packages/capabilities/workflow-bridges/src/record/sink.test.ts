/**
 * The fail-closed tenant reconciliation — MIRRORED BOTH DIRECTIONS (an A-bound sink rejects a
 * B event; a B-bound sink rejects an A event), each with ZERO ingress emits; a matching tenant
 * forwards the adapted neutral event exactly once.
 */

import type { WorkflowInputEvent } from '@rayspec/foundation';
import type { SubmittedRecordEvent } from '@rayspec/record-runtime';
import { RecordEventRejectedError } from '@rayspec/record-runtime';
import type { WorkflowDispatchResult, WorkflowEventIngress } from '@rayspec/workflow-durable';
import { describe, expect, it } from 'vitest';
import { CrossTenantRecordEventError, WorkflowIngressRecordSubmittedSink } from './sink.js';

const TENANT_A = 'tenant-aaaa';
const TENANT_B = 'tenant-bbbb';

class RecordingIngress implements WorkflowEventIngress {
  readonly events: WorkflowInputEvent[] = [];
  async emit(event: WorkflowInputEvent): Promise<WorkflowDispatchResult> {
    this.events.push(event);
    return { enqueued: [] };
  }
}

function eventFor(tenant: string): SubmittedRecordEvent {
  return {
    event_id: `${tenant}:rec-1`,
    tenant_id: tenant,
    record_id: 'rec-1',
    record: { title: 'x' },
    occurred_at: '2026-07-04T00:00:00.000Z',
    source_capability: 'record_input',
  };
}

describe('WorkflowIngressRecordSubmittedSink', () => {
  it('forwards a matching-tenant event to the ingress exactly once (adapted shape)', async () => {
    const ingress = new RecordingIngress();
    const sink = new WorkflowIngressRecordSubmittedSink({ ingress, tenantId: TENANT_A });
    await sink.emit(eventFor(TENANT_A));
    expect(ingress.events).toHaveLength(1);
    expect(ingress.events[0]).toMatchObject({
      type: 'record_input.record_submitted',
      id: `${TENANT_A}:rec-1`,
      payload: { record_id: 'rec-1', tenant_id: TENANT_A, title: 'x' },
    });
  });

  it('rejects cross-tenant FAIL-CLOSED in BOTH directions — typed error, ZERO enqueue', async () => {
    for (const [bound, foreign] of [
      [TENANT_A, TENANT_B],
      [TENANT_B, TENANT_A],
    ] as const) {
      const ingress = new RecordingIngress();
      const sink = new WorkflowIngressRecordSubmittedSink({ ingress, tenantId: bound });
      const attempt = sink.emit(eventFor(foreign));
      await expect(attempt).rejects.toBeInstanceOf(CrossTenantRecordEventError);
      // The base class is the audio-pattern rejection contract the route binding maps to 403.
      await expect(sink.emit(eventFor(foreign))).rejects.toBeInstanceOf(RecordEventRejectedError);
      await expect(sink.emit(eventFor(foreign))).rejects.toMatchObject({ reason: 'cross_tenant' });
      expect(ingress.events).toHaveLength(0); // ZERO enqueue — the fail-closed law
    }
  });
});
