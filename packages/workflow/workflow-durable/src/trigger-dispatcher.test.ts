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

/**
 * A capturing enqueuer: like `FakeEnqueuer` but records EVERY idempotency key it was enqueued under,
 * so a test can assert the exact key an emit derived (the default per-trigger key vs a forced key).
 */
class CapturingEnqueuer implements WorkflowEnqueuer {
  readonly runs = new Map<string, string>();
  readonly keys: string[] = [];
  enqueues = 0;
  async enqueueWorkflowRun(input: {
    tenantId: string;
    workflow: WorkflowSpec;
    event: WorkflowInputEvent;
    idempotencyKey: string;
  }): Promise<{ workflowRunId: string; deduped: boolean }> {
    this.keys.push(input.idempotencyKey);
    const key = `${input.tenantId}:${input.workflow.id}:${input.idempotencyKey}`;
    const existing = this.runs.get(key);
    if (existing) return { workflowRunId: existing, deduped: true };
    this.enqueues += 1;
    const runId = `run-${this.runs.size}`;
    this.runs.set(key, runId);
    return { workflowRunId: runId, deduped: false };
  }
}

describe('WorkflowEventDispatcher.emit forceKey (the reprocess re-enqueue seam)', () => {
  function dispatcherWith(enqueuer: WorkflowEnqueuer): WorkflowEventDispatcher {
    return new WorkflowEventDispatcher({
      tenantId: TENANT,
      enqueuer,
      triggers: [{ workflow: workflow('process_recording', 'audio_input.finalized_session') }],
    });
  }

  it('a forceKey OVERRIDES the per-trigger keyFn (bypasses sessionScopedIdempotencyKey)', async () => {
    const enqueuer = new CapturingEnqueuer();
    const dispatcher = dispatcherWith(enqueuer);
    await dispatcher.emit(finalizedSessionEvent('sess-1'), {
      forceKey: 'session_id:sess-1:reprocess:nonce-1',
    });
    // The enqueue used the FORCED key, NOT the legacy default `session_id:sess-1:finalized`.
    expect(enqueuer.keys).toEqual(['session_id:sess-1:reprocess:nonce-1']);
  });

  it('a reprocess (distinct forceKey) is NOT deduped to the session-finalized run — a FRESH run', async () => {
    const enqueuer = new CapturingEnqueuer();
    const dispatcher = dispatcherWith(enqueuer);
    // The ORIGINAL session-finalized run (default per-session key).
    const original = await dispatcher.emit(finalizedSessionEvent('sess-1'));
    // A reprocess of the SAME session with a DISTINCT key → a SEPARATE, fresh run (not deduped).
    const reprocess = await dispatcher.emit(finalizedSessionEvent('sess-1'), {
      forceKey: 'session_id:sess-1:reprocess:nonce-1',
    });
    expect(reprocess.enqueued[0]?.deduped).toBe(false);
    expect(reprocess.enqueued[0]?.workflowRunId).not.toBe(original.enqueued[0]?.workflowRunId);
    expect(enqueuer.enqueues).toBe(2); // TWO distinct runs: the original + the reprocess
    // Two more reprocesses with distinct nonces → two more fresh runs (never collapsed onto one key).
    await dispatcher.emit(finalizedSessionEvent('sess-1'), {
      forceKey: 'session_id:sess-1:reprocess:nonce-2',
    });
    expect(enqueuer.enqueues).toBe(3);
  });

  it('DEFAULT emit (no options) stays byte-identical — the legacy per-session key', async () => {
    const enqueuer = new CapturingEnqueuer();
    const dispatcher = dispatcherWith(enqueuer);
    await dispatcher.emit(finalizedSessionEvent('sess-1'));
    expect(enqueuer.keys).toEqual(['session_id:sess-1:finalized']);
  });

  it('an empty/whitespace forceKey FALLS BACK to the per-trigger keyFn (never a silent shared key)', async () => {
    const enqueuer = new CapturingEnqueuer();
    const dispatcher = dispatcherWith(enqueuer);
    await dispatcher.emit(finalizedSessionEvent('sess-1'), { forceKey: '' });
    expect(enqueuer.keys).toEqual(['session_id:sess-1:finalized']);
  });
});
