/**
 * The record_input ↔ durable-workflow seam ADAPTER (the audio-workflow-bridge `adapter.ts`
 * pattern): map the capability's own `SubmittedRecordEvent` onto the neutral `WorkflowInputEvent`
 * the Tier A workflow event dispatcher ingests. The ONE canonical mapping between the two halves —
 * homed in a dedicated composition package so NEITHER the neutral workflow engine NOR the record
 * capability gains a dependency on the other.
 *
 * The field mapping (canonical):
 *   - `type`        ← the constant trigger event id `record_input.record_submitted`
 *                     (the DEFAULT `${capability}.${event}` join — NO alias-table entry);
 *   - `id`          ← the submitted-record `event_id` (= `${tenant_id}:${record_id}`, record-scoped);
 *   - `occurred_at` ← the submit timestamp;
 *   - `payload`     ← THE MERGED PAYLOAD CONTRACT: the submitted business fields spread TOP-LEVEL,
 *                     then the FIXED ENVELOPE (`record_id`, `tenant_id`, `source_capability`)
 *                     spread LAST so the server-derived envelope ALWAYS WINS a key collision
 *                     (defense-in-depth — the capability already rejects reserved keys at submit,
 *                     422 `reserved_record_key`). Merging top-level is what lets a `store_write`
 *                     step's `{ event: <business_field> }` sources reach the submitted fields
 *                     (store-nodes resolves TOP-LEVEL scalar payload keys only). DATA only, never
 *                     instructions (the trust boundary).
 *
 * `payload.record_id` is what the descriptor-derived `payloadFieldIdempotencyKey('record_id')`
 * keys the durable run on (`record_id:<id>` — the generic format; the `:finalized` suffix stays
 * audio-only, byte-stable live run identity). Because `id` is ALSO record-scoped, the dispatcher's
 * missing-field fallback (`event:${id}`) stays per-record-stable too. So a client re-submit
 * (retry = redelivery) converges on ONE durable run (C10 single-flight).
 */

import type { WorkflowInputEvent } from '@rayspec/foundation';
import type { SubmittedRecordEvent } from '@rayspec/record-runtime';
import { RECORD_EVENT_ENVELOPE_KEYS } from '@rayspec/record-runtime';

/** The neutral workflow trigger event id a record submit maps onto (the default join). */
export const RECORD_SUBMITTED_EVENT_TYPE = 'record_input.record_submitted';

/**
 * The FIXED ENVELOPE keys of the `record_submitted` trigger payload — re-exported from the ONE
 * capability source (`@rayspec/record-runtime` types.ts) and coupled fail-the-fix to the emitted
 * payload by adapter.test.ts. This is the compose-time truth: a declared persist scope whose
 * `<scope>_id` is not among THESE keys can never be satisfied at run time (the merged business
 * fields are per-product data, NOT a stable contract), so `composeProductDeploy` rejects it at
 * deploy.
 */
export const RECORD_SUBMITTED_ENVELOPE_KEYS: readonly string[] = Object.freeze([
  ...RECORD_EVENT_ENVELOPE_KEYS,
]);

/**
 * Map the capability's `SubmittedRecordEvent` onto the neutral `WorkflowInputEvent`. Pure +
 * deterministic (no I/O) — the ONE canonical seam mapping. Business fields first, envelope LAST
 * (envelope wins — see the module header).
 */
export function submittedRecordEventToWorkflowInput(
  event: SubmittedRecordEvent,
): WorkflowInputEvent {
  return {
    id: event.event_id,
    type: RECORD_SUBMITTED_EVENT_TYPE,
    occurred_at: event.occurred_at,
    payload: {
      ...event.record,
      record_id: event.record_id,
      tenant_id: event.tenant_id,
      source_capability: event.source_capability,
    },
  };
}
