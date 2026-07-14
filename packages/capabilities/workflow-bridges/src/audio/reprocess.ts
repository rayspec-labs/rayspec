/**
 * The OPERATIONAL reprocess seam for the Audio/Media half: re-drive a session's declared
 * finalized-session workflow as a FRESH durable run.
 *
 * WHY A DISTINCT KEY: a live finalize keys its durable run on `sessionScopedIdempotencyKey`
 * (`session_id:<id>:finalized`, byte-frozen — live run identity derives from it), so re-emitting the
 * SAME finalized event DEDUPS to the original run. An operational reprocess (re-extract after a fix /
 * recover a stuck session) must instead drive a SEPARATE, fresh run over the session's CURRENT store
 * state — so it supplies a DISTINCT idempotency key via the dispatcher's `forceKey` seam, WITHOUT
 * touching the frozen `sessionScopedIdempotencyKey` format.
 *
 * This is DB-FREE (pure of the store): it constructs the neutral trigger event + the distinct key and
 * emits through the tenant-bound ingress. The caller (composition root) owns the tenant-scoped session
 * existence check — a session's authoritative track state is re-read INSIDE the workflow (the STT node
 * re-reads the sealed tracks from the store; the event is the trigger, not the inventory), so only
 * `session_id` is load-bearing in the reprocess payload.
 */
import type { WorkflowInputEvent } from '@rayspec/foundation';
import type { WorkflowDispatchEnqueued, WorkflowEventIngress } from '@rayspec/workflow-durable';
import { AUDIO_FINALIZED_SESSION_EVENT_TYPE } from './adapter.js';

/**
 * The reprocess idempotency key — DISTINCT from the byte-frozen live finalize key
 * (`session_id:<id>:finalized`) by construction, so a reprocess never dedups onto the original run.
 * The `nonce` makes each reprocess its own fresh run (distinct nonces → distinct runs).
 */
export function audioReprocessIdempotencyKey(sessionId: string, nonce: string): string {
  return `session_id:${sessionId}:reprocess:${nonce}`;
}

/**
 * Re-drive the finalized-session workflow for `sessionId` through the tenant-bound `ingress` as a FRESH
 * durable run (a distinct `forceKey`). Constructs the SAME neutral `WorkflowInputEvent` shape a live
 * finalize emits; the workflow re-reads the authoritative sealed tracks from the store, so the payload
 * carries an empty `tracks` summary (the store is authoritative). Returns the ingress's enqueue result.
 */
export async function reprocessFinalizedSession(input: {
  readonly ingress: WorkflowEventIngress;
  readonly tenantId: string;
  readonly sessionId: string;
  /** A per-reprocess nonce making the run fresh (distinct nonces → distinct runs). */
  readonly nonce: string;
  /** Advisory operator context (optional). */
  readonly reason?: string;
}): Promise<{ enqueued: WorkflowDispatchEnqueued[] }> {
  const { ingress, tenantId, sessionId, nonce, reason } = input;
  const event: WorkflowInputEvent = {
    // A per-reprocess event id (nonce'd) — never the live finalize id (`${tenant}:${session}`), so the
    // dispatcher's id fallback also stays per-reprocess-stable.
    id: `${tenantId}:${sessionId}:reprocess:${nonce}`,
    type: AUDIO_FINALIZED_SESSION_EVENT_TYPE,
    occurred_at: new Date().toISOString(),
    payload: {
      session_id: sessionId,
      tenant_id: tenantId,
      // The event is the TRIGGER, not the track inventory — the workflow re-reads the authoritative
      // sealed tracks from the store. A reprocess carries an empty summary (the store is authoritative).
      tracks: [],
      source_capability: 'audio_input',
    },
  };
  return ingress.emit(event, {
    forceKey: audioReprocessIdempotencyKey(sessionId, nonce),
    ...(reason !== undefined ? { reason } : {}),
  });
}
