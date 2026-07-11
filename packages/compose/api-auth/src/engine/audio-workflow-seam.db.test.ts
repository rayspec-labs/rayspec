/**
 * the (durable workflow runtime) ↔ (Audio/Media capability) SEAM, composed
 * END-TO-END and DB-backed through the REAL createAuthApp chain. Both halves land byte-safe on their own;
 * this proves they COMPOSE: mounting the Audio/Media capability with the REAL bridge sink
 * (`@rayspec/audio-workflow-bridge`) wired to the REAL `WorkflowEventDispatcher`
 * (`@rayspec/workflow-durable`), driving upload/finalize through the REAL routes, enqueues EXACTLY ONE
 * durable workflow run per session — the dual-track single-run invariant surviving the full composition.
 *
 * Proves (fail-the-fix, ground truth, not pass-the-shape):
 *  1. DUAL-TRACK finalize (mic + system) → the sink emits TWICE, but the composition converges on EXACTLY
 *     ONE durable run (session-scoped `sessionScopedIdempotencyKey` → the tenant-namespaced
 *     `durableWorkflowRunId`), the 2nd enqueue deduped. The run carries the session payload intact.
 *  2. RE-FINALIZE (idempotent 200) re-emits → still EXACTLY ONE run (never a second).
 *  3. TENANT-SCOPED: the enqueued run's tenant is the finalize's server-derived tenant.
 *
 * The enqueuer is a FAITHFUL recorder: it computes the run id with the REAL `durableWorkflowRunId` and
 * dedups on it (reproducing the single-flight KEY the DBOS `workflowID` law enforces — that law is
 * separately proven on real DBOS in @rayspec/durable-dbos's workflow-executor.db.test.ts). What is NEW
 * here is that the full COMPOSITION (routes → real sink → real adapter → real dispatcher → key
 * derivation) yields one stable per-session run — not a per-track or per-emit one.
 *
 * Skips when DATABASE_URL is absent — but HARD-FAILS if the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * yet absent, so this composition suite can never silently self-skip to a false green.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FinalizedSessionEvent,
  finalizedEventId,
  type SessionFinalizedSink,
} from '@rayspec/audio-runtime';
import { buildAudioCapabilitySpec, mountAudioCapability } from '@rayspec/audio-runtime/rayspec';
import {
  AUDIO_FINALIZED_SESSION_EVENT_TYPE,
  WorkflowIngressSessionFinalizedSink,
} from '@rayspec/capability-bridges';
import type { WorkflowInputEvent, WorkflowSpec } from '@rayspec/foundation';
import {
  type BlobStoreFactory,
  makeFsBlobStoreFactory,
  type ResolvedHandler,
} from '@rayspec/platform';
import {
  durableWorkflowRunId,
  sessionScopedIdempotencyKey,
  type WorkflowEnqueuer,
  WorkflowEventDispatcher,
} from '@rayspec/workflow-durable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMediaTokenService, type MediaTokenService } from '../media/media-token.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: a DB-backed composition suite that self-skips without DATABASE_URL is a
// false-green hazard. When the DB is REQUIRED but absent, hard-fail at collection rather than skip.
if (requireDb && !hasDb) {
  throw new Error(
    'audio-workflow-seam.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the audio-workflow composition suite.',
  );
}

const MEDIA_SECRET = 'py-d2i-media-secret-at-least-32-bytes-x';

/** The Tier A workflow that triggers on a finalized session (the id is part of the durable run id). */
const AUDIO_FLOW_ID = 'audio_session_flow';
function audioSessionFlow(): WorkflowSpec {
  return {
    id: AUDIO_FLOW_ID,
    tier: 'A',
    status: 'foundation_only',
    trigger: { event: AUDIO_FINALIZED_SESSION_EVENT_TYPE },
    idempotency_key: 'unused',
    steps: [],
  };
}

/**
 * A faithful `WorkflowEnqueuer` recorder: it derives the run id with the REAL `durableWorkflowRunId` and
 * dedups on it (same id ⇒ deduped, keeping the FIRST event) — reproducing the single-flight the DBOS
 * `workflowID` law enforces. Records every raw enqueue call so the test can assert emit-vs-run counts.
 */
class RecordingEnqueuer implements WorkflowEnqueuer {
  readonly calls: Array<{ workflowRunId: string; tenantId: string; deduped: boolean }> = [];
  readonly #runs = new Map<
    string,
    { tenantId: string; idempotencyKey: string; event: WorkflowInputEvent }
  >();

  async enqueueWorkflowRun(input: {
    tenantId: string;
    workflow: WorkflowSpec;
    event: WorkflowInputEvent;
    idempotencyKey: string;
  }): Promise<{ workflowRunId: string; deduped: boolean }> {
    const workflowRunId = durableWorkflowRunId(
      input.tenantId,
      input.workflow.id,
      input.idempotencyKey,
    );
    const deduped = this.#runs.has(workflowRunId);
    if (!deduped) {
      this.#runs.set(workflowRunId, {
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        event: input.event,
      });
    }
    this.calls.push({ workflowRunId, tenantId: input.tenantId, deduped });
    return { workflowRunId, deduped };
  }

  distinctRunIds(): string[] {
    return [...this.#runs.keys()];
  }
  run(runId: string) {
    return this.#runs.get(runId);
  }
}

/**
 * A test-only `SessionFinalizedSink` whose real delegate is bound AFTER the deployment tenant (the test
 * org) is known — the harness mints the org id dynamically, whereas production binds the dispatcher's
 * tenant at boot. It forwards to the REAL bridge sink; the production emit path is otherwise unchanged.
 */
class DeferredSessionFinalizedSink implements SessionFinalizedSink {
  #delegate?: SessionFinalizedSink;
  bind(delegate: SessionFinalizedSink): void {
    this.#delegate = delegate;
  }
  async emit(event: FinalizedSessionEvent): Promise<void> {
    if (!this.#delegate) throw new Error('DeferredSessionFinalizedSink: not bound');
    await this.#delegate.emit(event);
  }
}

describe.skipIf(!hasDb)('Audio/Media → durable workflow seam, composed', () => {
  let h: Harness;
  let handlers: ReadonlyMap<string, ResolvedHandler>;
  let blobDir: string;
  let blobFactory: BlobStoreFactory;
  let media: MediaTokenService;
  const deferredSink = new DeferredSessionFinalizedSink();

  beforeAll(async () => {
    const mounted = mountAudioCapability({
      sessionFinalizedSink: deferredSink,
      capability: { allowedTracks: ['mic', 'system'] },
    });
    const spec = buildAudioCapabilitySpec(mounted, { name: 'audio-workflow-seam-test' });
    handlers = mounted.handlers as ReadonlyMap<string, ResolvedHandler>;
    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-audio-d2i-'));
    blobFactory = makeFsBlobStoreFactory(blobDir);
    media = createMediaTokenService(MEDIA_SECRET);
    h = await createHarness({
      engineSpec: spec,
      engineHandlers: handlers,
      blobFactory,
      mediaTokenService: media,
      schema: 'rayspec_test_audio_d2i',
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  /** Register → org → switch → JWT (member role: store:read/write). Returns the org id + token. */
  async function principal(
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgId = (
      await (
        await jsonRequest(h.app, 'POST', '/v1/orgs', {
          body: { name: orgName },
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).id as string;
    const token = (
      await (
        await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).accessToken as string;
    return { orgId, token };
  }

  /** Wire a FRESH enqueuer + a dispatcher bound to `orgId` + the real bridge sink; bind the deferred sink. */
  function wireWorkflow(orgId: string): RecordingEnqueuer {
    const enqueuer = new RecordingEnqueuer();
    const dispatcher = new WorkflowEventDispatcher({
      tenantId: orgId,
      enqueuer,
      triggers: [{ workflow: audioSessionFlow() }],
    });
    deferredSink.bind(
      new WorkflowIngressSessionFinalizedSink({ ingress: dispatcher, tenantId: orgId }),
    );
    return enqueuer;
  }

  const postChunk = (
    session: string,
    track: string,
    index: number,
    token: string,
    bytes: Uint8Array,
  ) =>
    h.app.request(`/sessions/${session}/${track}/chunks/${index}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/ogg' },
      body: bytes,
    });

  const finalize = (session: string, track: string, token: string, totalChunks: number) =>
    jsonRequest(h.app, 'POST', `/sessions/${session}/${track}/finalize`, {
      body: { total_chunks: totalChunks },
      headers: { authorization: `Bearer ${token}` },
    });

  it('DUAL-TRACK finalize → EXACTLY ONE durable run, tenant-scoped, session payload intact', async () => {
    const a = await principal('d2i-dual@example.com', 'D2iDual');
    const enqueuer = wireWorkflow(a.orgId);

    expect((await postChunk('s1', 'mic', 0, a.token, new Uint8Array([1]))).status).toBe(200);
    expect((await postChunk('s1', 'system', 0, a.token, new Uint8Array([2]))).status).toBe(200);
    expect((await finalize('s1', 'mic', a.token, 1)).status).toBe(200);
    expect((await finalize('s1', 'system', a.token, 1)).status).toBe(200);

    // Both track seals emitted → the sink forwarded BOTH to the dispatcher (it does not dedup itself).
    expect(enqueuer.calls).toHaveLength(2);
    // ... but the composition converges on ONE durable run (session-scoped single-flight).
    const runIds = enqueuer.distinctRunIds();
    expect(runIds).toHaveLength(1);
    // The 2nd enqueue was a dedupe (not a fresh run).
    expect(enqueuer.calls[1]?.deduped).toBe(true);

    // The run id is the REAL tenant-namespaced durable id for THIS session's session-scoped key.
    const expectedKey = sessionScopedIdempotencyKey('session_id')({
      id: finalizedEventId(a.orgId, 's1'),
      type: AUDIO_FINALIZED_SESSION_EVENT_TYPE,
      occurred_at: '',
      payload: { session_id: 's1' },
    });
    const expectedRunId = durableWorkflowRunId(a.orgId, AUDIO_FLOW_ID, expectedKey);
    expect(runIds[0]).toBe(expectedRunId);

    // Tenant-scoped + payload intact (the first-delivered event is kept on dedupe).
    const run = enqueuer.run(expectedRunId);
    expect(run?.tenantId).toBe(a.orgId);
    expect(run?.idempotencyKey).toBe('session_id:s1:finalized');
    expect(run?.event.type).toBe(AUDIO_FINALIZED_SESSION_EVENT_TYPE);
    expect(run?.event.id).toBe(finalizedEventId(a.orgId, 's1'));
    expect(run?.event.payload.session_id).toBe('s1');
    expect(run?.event.payload.tenant_id).toBe(a.orgId);
    expect(run?.event.payload.source_capability).toBe('audio_input');
    const tracks = run?.event.payload.tracks as Array<{ track: string }>;
    expect(tracks.map((t) => t.track)).toContain('mic');
  });

  it('RE-FINALIZE (idempotent 200) re-emits → still EXACTLY ONE durable run (never a second)', async () => {
    const a = await principal('d2i-refin@example.com', 'D2iRefin');
    const enqueuer = wireWorkflow(a.orgId);

    await postChunk('s2', 'mic', 0, a.token, new Uint8Array([9]));
    expect((await finalize('s2', 'mic', a.token, 1)).status).toBe(200);
    // Re-finalizing a completed track is idempotent (200) and re-emits the SAME session-scoped event.
    expect((await finalize('s2', 'mic', a.token, 1)).status).toBe(200);

    expect(enqueuer.calls).toHaveLength(2); // emitted on both finalize calls
    expect(enqueuer.distinctRunIds()).toHaveLength(1); // ... but ONE durable run
    expect(enqueuer.calls[1]?.deduped).toBe(true);
    expect(enqueuer.calls[0]?.tenantId).toBe(a.orgId);
  });
});
