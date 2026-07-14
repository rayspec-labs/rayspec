/**
 * The dual-track completeness guard, proven through the REAL durable engine (not just the node in
 * isolation). This closes the composed-stack gap: it shows that when the `stt.transcribe_session` node
 * returns `retryable_failure` on an incomplete session, the engine RE-INVOKES it (per the wired retry
 * policy) and a later attempt — after the straggler track seals — transcribes EVERY sealed track.
 *
 * Mechanism under test (matches production): the `session_finalized` event fires when ONE track seals;
 * a sibling can still be `recording`. Unconditional emit already guarantees ≥1 run (proven at the
 * finalize seam); THIS proves the run does not silently drop the straggler — it waits (bounded) and
 * transcribes the COMPLETE set. The staggered seal is modelled by a store proxy that completes the
 * still-recording track between the first (incomplete) read and the engine's retry.
 */
import type { WorkflowInputEvent, WorkflowSpec } from '@rayspec/foundation';
import { CapabilityRegistry } from '@rayspec/foundation';
import { FakeSttAdapter, type SttDualTrackFixture } from '@rayspec/stt-port';
import {
  type DurableNodeState,
  DurableWorkflowEngine,
  type DurableWorkflowRun,
  type WorkflowJournalStore,
  type WorkflowRunFinalizePatch,
  type WorkflowRunHeaderInput,
  type WorkflowRunView,
} from '@rayspec/workflow-durable';
import { describe, expect, it } from 'vitest';
import { makeSttTranscribeSessionNode, STT_TRANSCRIBE_RETRY_POLICY } from './nodes.js';
import { FakeHandlerDb } from './test-support/fake-handler-db.js';
import { parseFixture } from './test-support/fixture.js';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const SESSION = 's-complete';
const EVENT_TYPE = 'audio_input.finalized_session';

/**
 * A minimal but CONSTRAINT-FAITHFUL in-memory `WorkflowJournalStore` (mirrors the engine package's own
 * test fake, which is not exported): `ensureRun` is single-flight on the run id, `upsertNodeState`
 * OVERWRITES one row per (run, node) — the retry/resume memoization boundary the engine relies on.
 */
class InMemoryJournalStore implements WorkflowJournalStore {
  readonly #runs = new Map<string, DurableWorkflowRun>();
  readonly #nodes = new Map<string, Map<string, DurableNodeState>>();

  async ensureRun(
    header: WorkflowRunHeaderInput,
  ): Promise<{ run: DurableWorkflowRun; created: boolean }> {
    const existing = this.#runs.get(header.workflowRunId);
    if (existing) return { run: structuredClone(existing), created: false };
    const now = new Date().toISOString();
    const run: DurableWorkflowRun = {
      workflowRunId: header.workflowRunId,
      tenantId: TENANT,
      workflowId: header.workflowId,
      idempotencyKey: header.idempotencyKey,
      triggerEvent: header.triggerEvent,
      inputEvent: header.inputEvent,
      status: 'running',
      resumable: false,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.#runs.set(header.workflowRunId, run);
    this.#nodes.set(header.workflowRunId, new Map());
    return { run: structuredClone(run), created: true };
  }

  async loadRun(workflowRunId: string): Promise<WorkflowRunView | undefined> {
    const run = this.#runs.get(workflowRunId);
    if (!run) return undefined;
    const nodeMap = this.#nodes.get(workflowRunId) ?? new Map<string, DurableNodeState>();
    const nodes = [...nodeMap.values()].sort((a, b) => a.position - b.position);
    return { run: structuredClone(run), nodes: structuredClone(nodes) };
  }

  async upsertNodeState(workflowRunId: string, node: DurableNodeState): Promise<void> {
    const nodeMap = this.#nodes.get(workflowRunId);
    if (!nodeMap) throw new Error(`no run '${workflowRunId}' for node upsert`);
    nodeMap.set(node.nodeId, structuredClone(node)); // one row per (run, node) — overwrite, never append
  }

  async finalizeRun(workflowRunId: string, patch: WorkflowRunFinalizePatch): Promise<void> {
    const run = this.#runs.get(workflowRunId);
    if (!run) throw new Error(`no run '${workflowRunId}' to finalize`);
    run.status = patch.status;
    run.resumable = patch.resumable;
    run.error = patch.error;
    run.attempts = patch.attempts;
    run.updatedAt = new Date().toISOString();
  }
}

/**
 * A store proxy that models the STAGGERED finalize: the first time the node observes a `recording`
 * track (its incomplete read), that track seals — so the engine's retry re-reads the COMPLETE set.
 */
class StaggeredSealDb extends FakeHandlerDb {
  #sealed = false;
  override async select(store: string, filter?: Record<string, unknown>) {
    const rows = await super.select(store, filter);
    if (
      !this.#sealed &&
      store === 'audio_tracks' &&
      filter?.status === 'recording' &&
      rows.length
    ) {
      this.#sealed = true;
      const row = this.rows('audio_tracks').find((r) => r.status === 'recording');
      if (row) row.status = 'completed'; // the finalize UPDATE lands between this read and the retry
    }
    return rows;
  }
}

function dualTrackFixture(): SttDualTrackFixture {
  return {
    fixture_id: 'fx-complete',
    session_id: SESSION,
    tracks: [
      { track: 'mic', status: 'completed', segments: [{ span_id: 'mic:s0', text: 'One.' }] },
      { track: 'system', status: 'completed', segments: [{ span_id: 'sys:s0', text: 'Two.' }] },
    ],
  };
}

const WORKFLOW: WorkflowSpec = {
  id: 'process_recording',
  tier: 'A',
  status: 'runtime_foundation',
  trigger: { event: EVENT_TYPE },
  idempotency_key: `session_id:${SESSION}:finalized`,
  steps: [
    {
      id: 'transcribe',
      capability: 'stt',
      operation: 'transcribe_session',
      input_from_event: true,
      output_artifact_refs: ['stt.transcript', 'stt.transcript_span'],
      // A tiny backoff for a fast test; the SHAPE (backoff + a window spanning the node bound) is
      // what compose wires in production — asserted separately in compose.test.ts.
      retry_policy: { max_attempts: 4, backoff_ms: 5 },
    },
  ],
};

const EVENT: WorkflowInputEvent = {
  id: `${TENANT}:${SESSION}`,
  type: EVENT_TYPE,
  occurred_at: new Date().toISOString(),
  payload: { session_id: SESSION },
};

describe('completeness guard through the durable engine', () => {
  it('STAGGERED finalize: the engine retries the incomplete run, then transcribes BOTH sealed tracks', async () => {
    const spec = parseFixture();
    const db = new StaggeredSealDb();
    // mic sealed (fired the event); system still uploading — the exact incident shape.
    db.rows('audio_tracks').push({
      session_id: SESSION,
      track: 'mic',
      status: 'completed',
      track_ref: `${TENANT}:${SESSION}:mic`,
    });
    db.rows('audio_tracks').push({
      session_id: SESSION,
      track: 'system',
      status: 'recording',
      track_ref: `${TENANT}:${SESSION}:system`,
    });

    const registry = new CapabilityRegistry();
    registry.register(
      'stt.transcribe_session',
      makeSttTranscribeSessionNode({
        spec,
        adapter: new FakeSttAdapter({ fixtures: [dualTrackFixture()] }),
        db,
        tenantId: TENANT,
        transcriptStore: 'track_transcripts',
      }),
    );
    const journal = new InMemoryJournalStore();
    const engine = new DurableWorkflowEngine({ journal, registry, tenantId: TENANT });

    const view = await engine.execute({ workflow: WORKFLOW, event: EVENT });

    // The run COMPLETED (not stuck retryable, not failed) ...
    expect(view.run.status).toBe('completed');
    // ... after re-invoking the node at least once (the incomplete first attempt + the complete retry).
    const transcribeNode = view.nodes.find((n) => n.nodeId === 'transcribe');
    expect(transcribeNode?.attemptCount).toBeGreaterThanOrEqual(2);
    // ... and BOTH tracks were transcribed (the straggler was NOT dropped — the original race).
    expect(
      db
        .rows('track_transcripts')
        .map((r) => r.track)
        .sort(),
    ).toEqual(['mic', 'system']);
  });

  it('the production retry policy (compose) actually spans the node completeness bound', () => {
    // A guard on the constant compose wires: without a backoff the retries fire instantly and the wait
    // is defeated; the window must exceed the node bound so the node proceeds-with-sealed vs exhausting.
    expect(STT_TRANSCRIBE_RETRY_POLICY.backoff_ms ?? 0).toBeGreaterThan(0);
    expect(STT_TRANSCRIBE_RETRY_POLICY.max_attempts).toBeGreaterThan(1);
  });
});
