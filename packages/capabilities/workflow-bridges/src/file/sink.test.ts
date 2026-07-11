/**
 * The fail-closed tenant reconciliation — MIRRORED BOTH DIRECTIONS (an A-bound sink rejects a
 * B event; a B-bound sink rejects an A event), each with ZERO ingress emits; a matching tenant
 * forwards the adapted neutral event exactly once.
 */
import type { SubmittedFileEvent } from '@rayspec/file-runtime';
import { FileEventRejectedError } from '@rayspec/file-runtime';
import type { WorkflowInputEvent } from '@rayspec/foundation';
import type { WorkflowDispatchResult, WorkflowEventIngress } from '@rayspec/workflow-durable';
import { describe, expect, it } from 'vitest';
import { CrossTenantFileEventError, WorkflowIngressFileSubmittedSink } from './sink.js';

const TENANT_A = 'tenant-aaaa';
const TENANT_B = 'tenant-bbbb';

class RecordingIngress implements WorkflowEventIngress {
  readonly events: WorkflowInputEvent[] = [];
  async emit(event: WorkflowInputEvent): Promise<WorkflowDispatchResult> {
    this.events.push(event);
    return { enqueued: [] };
  }
}

function eventFor(tenant: string): SubmittedFileEvent {
  return {
    event_id: `${tenant}:f-1`,
    tenant_id: tenant,
    file_id: 'f-1',
    sha256: 'a'.repeat(64),
    size_bytes: 7,
    content_type: 'text/plain',
    original_filename: null,
    blob_key: 'files/f-1',
    occurred_at: '2026-07-04T00:00:00.000Z',
    source_capability: 'file_input',
  };
}

describe('WorkflowIngressFileSubmittedSink', () => {
  it('forwards a matching-tenant event to the ingress exactly once (adapted shape)', async () => {
    const ingress = new RecordingIngress();
    const sink = new WorkflowIngressFileSubmittedSink({ ingress, tenantId: TENANT_A });
    await sink.emit(eventFor(TENANT_A));
    expect(ingress.events).toHaveLength(1);
    expect(ingress.events[0]).toMatchObject({
      type: 'file_input.file_submitted',
      id: `${TENANT_A}:f-1`,
      payload: { file_id: 'f-1', tenant_id: TENANT_A, blob_key: 'files/f-1' },
    });
  });

  it('rejects cross-tenant FAIL-CLOSED in BOTH directions — typed error, ZERO enqueue', async () => {
    for (const [bound, foreign] of [
      [TENANT_A, TENANT_B],
      [TENANT_B, TENANT_A],
    ] as const) {
      const ingress = new RecordingIngress();
      const sink = new WorkflowIngressFileSubmittedSink({ ingress, tenantId: bound });
      const attempt = sink.emit(eventFor(foreign));
      await expect(attempt).rejects.toBeInstanceOf(CrossTenantFileEventError);
      // The base class is the capability-pattern rejection contract the route binding maps to 403.
      await expect(sink.emit(eventFor(foreign))).rejects.toBeInstanceOf(FileEventRejectedError);
      await expect(sink.emit(eventFor(foreign))).rejects.toMatchObject({ reason: 'cross_tenant' });
      expect(ingress.events).toHaveLength(0); // ZERO enqueue — the fail-closed law
    }
  });
});
