/**
 * The conversation_input ↔ durable-workflow seam ADAPTER (the record/file-workflow-bridge
 * `adapter.ts` pattern): map the capability's own `SubmittedTurnEvent` onto the neutral
 * `WorkflowInputEvent` the Tier A workflow event dispatcher ingests. The ONE canonical mapping
 * between the two halves — homed in a dedicated composition package so NEITHER the neutral
 * workflow engine NOR the conversation capability gains a dependency on the other.
 *
 * The field mapping (canonical):
 *   - `type`        ← the constant trigger event id `conversation_input.turn_submitted`
 *                     (the DEFAULT `${capability}.${event}` join — NO alias-table entry);
 *   - `id`          ← the submitted-turn `event_id` (= `${tenant_id}:${conversation_id}:
 *                     ${message_id}`, TURN-scoped);
 *   - `occurred_at` ← the submit timestamp;
 *   - `payload`     ← the SERVER-DERIVED envelope, built EXPLICITLY field-by-field from the
 *                     capability event (which itself reads only the STORED ledger row). Like the
 *                     file adapter there is NO client-field spread at all — the payload is exactly
 *                     `CONVERSATION_EVENT_PAYLOAD_KEYS`, nothing more (the turn route already
 *                     rejects any unknown body key, 422). The bounded message TEXT rides the
 *                     payload as DATA, never instructions (the trust boundary — the types.ts boundary).
 *
 * `payload.turn_ref` is what the descriptor-derived `payloadFieldIdempotencyKey('turn_ref')` keys
 * the durable run on (`turn_ref:<conversation_id>:<message_id>` — the generic format; the
 * `:finalized` suffix stays audio-only). PER-TURN on purpose: keying on `conversation_id` would
 * dedupe EVERY later turn of a conversation into its FIRST durable run — silent turn loss (pinned
 * fail-the-fix by adapter.test.ts). Because `id` is ALSO turn-scoped, the dispatcher's
 * missing-field fallback (`event:${id}`) stays per-turn-stable too. So a client re-POST (retry =
 * redelivery) converges on ONE durable run per turn (C10 single-flight).
 */
import type { SubmittedTurnEvent } from '@rayspec/conversation-runtime';
import { CONVERSATION_EVENT_PAYLOAD_KEYS } from '@rayspec/conversation-runtime';
import type { WorkflowInputEvent } from '@rayspec/foundation';

/** The neutral workflow trigger event id a turn submit maps onto (the default join). */
export const TURN_SUBMITTED_EVENT_TYPE = 'conversation_input.turn_submitted';

/**
 * The EXACT payload keys of the `turn_submitted` trigger payload — re-exported from the ONE
 * capability source (`@rayspec/conversation-runtime` types.ts) and coupled fail-the-fix to the
 * emitted payload by adapter.test.ts. This is the compose-time truth: a declared persist
 * scope whose `<scope>_id` is not among THESE keys can never be satisfied at run time, so
 * `composeProductDeploy` rejects it at deploy (`conversation_id` is here — the single-scope law's
 * `conversation` scope persists).
 */
export const TURN_SUBMITTED_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  ...CONVERSATION_EVENT_PAYLOAD_KEYS,
]);

/**
 * Map the capability's `SubmittedTurnEvent` onto the neutral `WorkflowInputEvent`. Pure +
 * deterministic (no I/O) — the ONE canonical seam mapping. The payload is built EXPLICITLY, field
 * by field (never a spread of anything request-shaped): its key set EQUALS
 * `TURN_SUBMITTED_PAYLOAD_KEYS` exactly — adapter.test.ts pins the whole invariant.
 */
export function submittedTurnEventToWorkflowInput(event: SubmittedTurnEvent): WorkflowInputEvent {
  return {
    id: event.event_id,
    type: TURN_SUBMITTED_EVENT_TYPE,
    occurred_at: event.occurred_at,
    payload: {
      conversation_id: event.conversation_id,
      message_id: event.message_id,
      turn_ref: event.turn_ref,
      tenant_id: event.tenant_id,
      source_capability: event.source_capability,
      turn_seq: event.turn_seq,
      role: event.role,
      message: event.message,
    },
  };
}
