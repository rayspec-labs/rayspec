/**
 * The fail-closed tenant reconciliation — MIRRORED BOTH DIRECTIONS (an A-bound sink rejects a
 * B event; a B-bound sink rejects an A event), each with ZERO ingress emits; a matching tenant
 * forwards the adapted neutral event exactly once.
 */
import type { SubmittedTurnEvent } from '@rayspec/conversation-runtime';
import { ConversationEventRejectedError } from '@rayspec/conversation-runtime';
import type { WorkflowInputEvent } from '@rayspec/foundation';
import type { WorkflowDispatchResult, WorkflowEventIngress } from '@rayspec/workflow-durable';
import { describe, expect, it } from 'vitest';
import { CrossTenantTurnEventError, WorkflowIngressTurnSubmittedSink } from './sink.js';

const TENANT_A = 'tenant-aaaa';
const TENANT_B = 'tenant-bbbb';

class RecordingIngress implements WorkflowEventIngress {
  readonly events: WorkflowInputEvent[] = [];
  async emit(event: WorkflowInputEvent): Promise<WorkflowDispatchResult> {
    this.events.push(event);
    return { enqueued: [] };
  }
}

function eventFor(tenant: string): SubmittedTurnEvent {
  return {
    event_id: `${tenant}:c-1:m-1`,
    tenant_id: tenant,
    conversation_id: 'c-1',
    message_id: 'm-1',
    turn_ref: 'c-1:m-1',
    turn_seq: 1,
    role: 'user',
    message: 'hello',
    occurred_at: '2026-07-05T00:00:00.000Z',
    source_capability: 'conversation_input',
  };
}

describe('WorkflowIngressTurnSubmittedSink', () => {
  it('forwards a matching-tenant event to the ingress exactly once (adapted shape)', async () => {
    const ingress = new RecordingIngress();
    const sink = new WorkflowIngressTurnSubmittedSink({ ingress, tenantId: TENANT_A });
    await sink.emit(eventFor(TENANT_A));
    expect(ingress.events).toHaveLength(1);
    expect(ingress.events[0]).toMatchObject({
      type: 'conversation_input.turn_submitted',
      id: `${TENANT_A}:c-1:m-1`,
      payload: {
        conversation_id: 'c-1',
        turn_ref: 'c-1:m-1',
        tenant_id: TENANT_A,
        message: 'hello',
      },
    });
  });

  it('rejects cross-tenant FAIL-CLOSED in BOTH directions — typed error, ZERO enqueue', async () => {
    for (const [bound, foreign] of [
      [TENANT_A, TENANT_B],
      [TENANT_B, TENANT_A],
    ] as const) {
      const ingress = new RecordingIngress();
      const sink = new WorkflowIngressTurnSubmittedSink({ ingress, tenantId: bound });
      const attempt = sink.emit(eventFor(foreign));
      await expect(attempt).rejects.toBeInstanceOf(CrossTenantTurnEventError);
      // The base class is the capability-pattern rejection contract the route binding maps to 403.
      await expect(sink.emit(eventFor(foreign))).rejects.toBeInstanceOf(
        ConversationEventRejectedError,
      );
      await expect(sink.emit(eventFor(foreign))).rejects.toMatchObject({ reason: 'cross_tenant' });
      expect(ingress.events).toHaveLength(0); // ZERO enqueue — the fail-closed law
    }
  });
});
