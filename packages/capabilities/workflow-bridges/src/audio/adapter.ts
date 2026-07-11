/**
 * The Tier A ↔ Tier B seam ADAPTER: map the Audio/Media capability's own
 * `FinalizedSessionEvent` onto the neutral `WorkflowInputEvent` the Tier A workflow event dispatcher
 * ingests. This is the ONE canonical mapping between the two halves — homed in a dedicated composition
 * package so NEITHER the neutral workflow engine (`@rayspec/workflow-durable`) NOR the Audio/Media
 * capability (`@rayspec/audio-runtime`) gains a dependency on the other (the neutral seam stays neutral).
 *
 * The field mapping (canonical — the docs reference this adapter as the source of
 * truth):
 *   - `type`        ← the constant trigger event id `audio_input.finalized_session`;
 *   - `id`          ← the finalized-session `event_id` (= `${tenant_id}:${session_id}`, session-scoped);
 *   - `occurred_at` ← the session finalize timestamp;
 *   - `payload`     ← `{ session_id, tenant_id, tracks, source_capability }` — DATA only, never
 *                     instructions.
 *
 * `payload.session_id` is what `sessionScopedIdempotencyKey('session_id')` keys the durable run on, so
 * the mapping MUST carry it — and because `id` is ALSO session-scoped, the dispatcher's missing-field
 * fallback (`event:${id}`) stays per-session-stable too. So a dual-track finalize (both tracks re-emit
 * the same session-scoped event) and a re-finalize converge on ONE durable run (C10 single-flight).
 */
import type { FinalizedSessionEvent } from '@rayspec/audio-runtime';
import type { WorkflowInputEvent } from '@rayspec/foundation';

/** The neutral workflow trigger event id an Audio/Media session-finalize maps onto. */
export const AUDIO_FINALIZED_SESSION_EVENT_TYPE = 'audio_input.finalized_session';

/**
 * The CANONICAL payload contract of the `audio_input.finalized_session` trigger event — exactly the
 * keys `finalizedSessionEventToWorkflowInput` emits (coupled fail-the-fix by adapter.test.ts). This
 * is the compose-time truth for what a triggered workflow node can read from the trigger payload:
 * a declared persist scope whose `<scope>_id` is not among these keys can NEVER be satisfied at run
 * time, so `composeProductDeploy` rejects it at deploy (CC-1) instead of letting every persist fail.
 */
export const AUDIO_FINALIZED_SESSION_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  'session_id',
  'tenant_id',
  'tracks',
  'source_capability',
]);

/**
 * Map the Audio/Media capability's `FinalizedSessionEvent` onto the neutral `WorkflowInputEvent`. Pure +
 * deterministic (no I/O) — the ONE canonical seam mapping. The payload carries the session identity as
 * DATA (never instructions); a consuming Tier A workflow re-reads the authoritative track state.
 */
export function finalizedSessionEventToWorkflowInput(
  event: FinalizedSessionEvent,
): WorkflowInputEvent {
  return {
    id: event.event_id,
    type: AUDIO_FINALIZED_SESSION_EVENT_TYPE,
    occurred_at: event.occurred_at,
    payload: {
      session_id: event.session_id,
      tenant_id: event.tenant_id,
      tracks: event.tracks,
      source_capability: event.source_capability,
    },
  };
}
