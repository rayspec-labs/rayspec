import type { WorkflowInputEvent } from '@rayspec/foundation';
import type {
  WorkflowDispatchResult,
  WorkflowEmitOptions,
  WorkflowEventIngress,
} from '@rayspec/workflow-durable';
import { describe, expect, it } from 'vitest';
import { AUDIO_FINALIZED_SESSION_EVENT_TYPE } from './adapter.js';
import { audioReprocessIdempotencyKey, reprocessFinalizedSession } from './reprocess.js';

/** A fake ingress that records every emit (event + options) and returns one enqueued run. */
class FakeIngress implements WorkflowEventIngress {
  readonly emits: Array<{ event: WorkflowInputEvent; options?: WorkflowEmitOptions }> = [];
  async emit(
    event: WorkflowInputEvent,
    options?: WorkflowEmitOptions,
  ): Promise<WorkflowDispatchResult> {
    this.emits.push({ event, options });
    return {
      enqueued: [
        {
          workflowId: 'process_recording',
          workflowRunId: `run-${this.emits.length}`,
          deduped: false,
        },
      ],
    };
  }
}

describe('reprocessFinalizedSession (the audio reprocess event seam)', () => {
  it('emits a finalized-session event with a DISTINCT reprocess forceKey (never the legacy finalize key)', async () => {
    const ingress = new FakeIngress();
    const result = await reprocessFinalizedSession({
      ingress,
      tenantId: 'tenant-a',
      sessionId: 'sess-1',
      nonce: 'nonce-1',
    });
    expect(ingress.emits).toHaveLength(1);
    const { event, options } = ingress.emits[0]!;
    // The forced key is the DISTINCT reprocess key — NOT the byte-stable `session_id:sess-1:finalized`.
    expect(options?.forceKey).toBe('session_id:sess-1:reprocess:nonce-1');
    expect(options?.forceKey).not.toBe('session_id:sess-1:finalized');
    // The event is the SAME neutral finalized-session shape a live finalize emits — only session_id is
    // load-bearing (the workflow re-reads authoritative track state from the store).
    expect(event.type).toBe(AUDIO_FINALIZED_SESSION_EVENT_TYPE);
    expect(event.payload.session_id).toBe('sess-1');
    expect(event.payload.tenant_id).toBe('tenant-a');
    expect(event.payload.source_capability).toBe('audio_input');
    expect(result.enqueued[0]?.workflowRunId).toBe('run-1');
  });

  it('two reprocesses with DISTINCT nonces produce DISTINCT keys (never collapsed onto one run)', async () => {
    const ingress = new FakeIngress();
    await reprocessFinalizedSession({ ingress, tenantId: 't', sessionId: 's', nonce: 'a' });
    await reprocessFinalizedSession({ ingress, tenantId: 't', sessionId: 's', nonce: 'b' });
    expect(ingress.emits[0]?.options?.forceKey).toBe('session_id:s:reprocess:a');
    expect(ingress.emits[1]?.options?.forceKey).toBe('session_id:s:reprocess:b');
    expect(ingress.emits[0]?.options?.forceKey).not.toBe(ingress.emits[1]?.options?.forceKey);
  });

  it('forwards the advisory reason', async () => {
    const ingress = new FakeIngress();
    await reprocessFinalizedSession({
      ingress,
      tenantId: 't',
      sessionId: 's',
      nonce: 'n',
      reason: 're-run after fix',
    });
    expect(ingress.emits[0]?.options?.reason).toBe('re-run after fix');
  });

  it('audioReprocessIdempotencyKey is distinct from the legacy finalize format', () => {
    expect(audioReprocessIdempotencyKey('s1', 'n1')).toBe('session_id:s1:reprocess:n1');
  });
});
