import type { WorkflowInputEvent, WorkflowSpec } from '@rayspec/foundation';
import { describe, expect, it } from 'vitest';
import {
  payloadFieldIdempotencyKey,
  sessionScopedIdempotencyKey,
  type WorkflowEnqueuer,
  WorkflowEventDispatcher,
} from './trigger-dispatcher.js';

const TENANT = '00000000-0000-0000-0000-0000000000e5';

function workflow(id: string, event: string): WorkflowSpec {
  return {
    id,
    tier: 'A',
    status: 'foundation_only',
    trigger: { event },
    idempotency_key: 'static',
    steps: [{ id: 's', capability: 'test', operation: 'op' }],
  };
}

function finalizedSessionEvent(sessionId: string): WorkflowInputEvent {
  return {
    id: `evt-${sessionId}`,
    type: 'audio_input.finalized_session',
    occurred_at: '2026-07-02T00:00:00.000Z',
    payload: { session_id: sessionId },
  };
}

/**
 * A fake enqueuer that reproduces the REAL single-flight: one run per (tenant, workflow, idempotency
 * key). A second enqueue for the same key returns the prior run id with deduped:true — the
 * single-flight behaviour the DBOS executor gets from the deterministic workflowID.
 */
class FakeEnqueuer implements WorkflowEnqueuer {
  readonly runs = new Map<string, string>();
  enqueues = 0;
  async enqueueWorkflowRun(input: {
    tenantId: string;
    workflow: WorkflowSpec;
    event: WorkflowInputEvent;
    idempotencyKey: string;
  }): Promise<{ workflowRunId: string; deduped: boolean }> {
    const key = `${input.tenantId}:${input.workflow.id}:${input.idempotencyKey}`;
    const existing = this.runs.get(key);
    if (existing) return { workflowRunId: existing, deduped: true };
    this.enqueues += 1;
    const runId = `run-${this.runs.size}`;
    this.runs.set(key, runId);
    return { workflowRunId: runId, deduped: false };
  }
}

describe('WorkflowEventDispatcher (the event-ingress seam)', () => {
  it('emits a finalized-session event → enqueues the matching workflow, keyed per session', async () => {
    const enqueuer = new FakeEnqueuer();
    const dispatcher = new WorkflowEventDispatcher({
      tenantId: TENANT,
      enqueuer,
      triggers: [{ workflow: workflow('process_recording', 'audio_input.finalized_session') }],
    });
    const result = await dispatcher.emit(finalizedSessionEvent('sess-1'));
    expect(result.enqueued).toHaveLength(1);
    expect(result.enqueued[0]?.workflowId).toBe('process_recording');
    expect(result.enqueued[0]?.deduped).toBe(false);
    expect(enqueuer.enqueues).toBe(1);
  });

  it('RE-DELIVERY of the same session event DEDUPS to one run (single-flight)', async () => {
    const enqueuer = new FakeEnqueuer();
    const dispatcher = new WorkflowEventDispatcher({
      tenantId: TENANT,
      enqueuer,
      triggers: [{ workflow: workflow('process_recording', 'audio_input.finalized_session') }],
    });
    const first = await dispatcher.emit(finalizedSessionEvent('sess-1'));
    const second = await dispatcher.emit(finalizedSessionEvent('sess-1'));
    expect(second.enqueued[0]?.workflowRunId).toBe(first.enqueued[0]?.workflowRunId);
    expect(second.enqueued[0]?.deduped).toBe(true);
    expect(enqueuer.enqueues).toBe(1); // only ONE run enqueued across the redelivery
  });

  it('DISTINCT sessions are DISTINCT runs (the key is per-session)', async () => {
    const enqueuer = new FakeEnqueuer();
    const dispatcher = new WorkflowEventDispatcher({
      tenantId: TENANT,
      enqueuer,
      triggers: [{ workflow: workflow('process_recording', 'audio_input.finalized_session') }],
    });
    await dispatcher.emit(finalizedSessionEvent('sess-1'));
    await dispatcher.emit(finalizedSessionEvent('sess-2'));
    expect(enqueuer.enqueues).toBe(2);
  });

  it('an event with NO matching trigger enqueues nothing', async () => {
    const enqueuer = new FakeEnqueuer();
    const dispatcher = new WorkflowEventDispatcher({
      tenantId: TENANT,
      enqueuer,
      triggers: [{ workflow: workflow('process_recording', 'audio_input.finalized_session') }],
    });
    const result = await dispatcher.emit({
      id: 'x',
      type: 'some.other.event',
      occurred_at: 'now',
      payload: {},
    });
    expect(result.enqueued).toHaveLength(0);
    expect(enqueuer.enqueues).toBe(0);
  });

  it('sessionScopedIdempotencyKey keys on the field, falling back to the event id when absent', () => {
    const keyFn = sessionScopedIdempotencyKey('session_id');
    expect(keyFn(finalizedSessionEvent('abc'))).toBe('session_id:abc:finalized');
    expect(keyFn({ id: 'evt-9', type: 't', occurred_at: 'now', payload: {} })).toBe('event:evt-9');
  });

  it('payloadFieldIdempotencyKey (S3, additive) derives the clean generic format with the same fallback', () => {
    const keyFn = payloadFieldIdempotencyKey('record_id');
    expect(
      keyFn({ id: 'e1', type: 't', occurred_at: 'now', payload: { record_id: 'rec-1' } }),
    ).toBe('record_id:rec-1'); // NO legacy ':finalized' suffix — that format is audio-only
    expect(keyFn({ id: 'evt-9', type: 't', occurred_at: 'now', payload: {} })).toBe('event:evt-9');
    // A non-string / empty value also falls back (never a silent shared key).
    expect(keyFn({ id: 'evt-8', type: 't', occurred_at: 'now', payload: { record_id: 7 } })).toBe(
      'event:evt-8',
    );
  });
});
