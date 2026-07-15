/**
 * The file_input ↔ durable-workflow seam ADAPTER (the record-workflow-bridge `adapter.ts`
 * pattern): map the capability's own `SubmittedFileEvent` onto the neutral `WorkflowInputEvent`
 * the Tier A workflow event dispatcher ingests. The ONE canonical mapping between the two halves —
 * homed in a dedicated composition package so NEITHER the neutral workflow engine NOR the file
 * capability gains a dependency on the other.
 *
 * The field mapping (canonical):
 *   - `type`        ← the constant trigger event id `file_input.file_submitted`
 *                     (the DEFAULT `${capability}.${event}` join — NO alias-table entry);
 *   - `id`          ← the submitted-file `event_id` (= `${tenant_id}:${file_id}`, file-scoped);
 *   - `occurred_at` ← the submit timestamp;
 *   - `payload`     ← the SERVER-DERIVED METADATA ENVELOPE, built EXPLICITLY field-by-field from
 *                     the capability event (which itself reads only the STORED pointer row). UNLIKE
 *                     the record adapter there is NO client-field spread at all — the payload is
 *                     exactly `FILE_EVENT_PAYLOAD_KEYS`, nothing more (no spoof channel to
 *                     defend; the submit route already rejects any body key, 422). The raw bytes
 *                     are NEVER here — `blob_key` is the tenant-relative pointer a tenant-bound
 *                     reader resolves (the parse node). DATA only, never instructions (the trust boundary).
 *
 * `payload.file_id` is what the descriptor-derived `payloadFieldIdempotencyKey('file_id')` keys
 * the durable run on (`file_id:<id>` — the generic format; the `:finalized` suffix stays
 * audio-only, byte-frozen live run identity). Because `id` is ALSO file-scoped, the dispatcher's
 * missing-field fallback (`event:${id}`) stays per-file-stable too. So a client re-submit
 * (retry = redelivery) converges on ONE durable run (C10 single-flight).
 */
import type { SubmittedFileEvent } from '@rayspec/file-runtime';
import { FILE_EVENT_PAYLOAD_KEYS } from '@rayspec/file-runtime';
import type { WorkflowInputEvent } from '@rayspec/foundation';

/** The neutral workflow trigger event id a file submit maps onto (the default join). */
export const FILE_SUBMITTED_EVENT_TYPE = 'file_input.file_submitted';

/**
 * The EXACT payload keys of the `file_submitted` trigger payload — re-exported from the ONE
 * capability source (`@rayspec/file-runtime` types.ts) and coupled fail-the-fix to the emitted
 * payload by adapter.test.ts. This is the compose-time truth: a declared persist scope whose
 * `<scope>_id` is not among THESE keys can never be satisfied at run time, so
 * `composeProductDeploy` rejects it at deploy.
 */
export const FILE_SUBMITTED_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  ...FILE_EVENT_PAYLOAD_KEYS,
]);

/**
 * Map the capability's `SubmittedFileEvent` onto the neutral `WorkflowInputEvent`. Pure +
 * deterministic (no I/O) — the ONE canonical seam mapping. The payload is built EXPLICITLY,
 * field by field (never a spread of anything request-shaped): its key set EQUALS
 * `FILE_SUBMITTED_PAYLOAD_KEYS` exactly — adapter.test.ts pins the whole invariant.
 */
export function submittedFileEventToWorkflowInput(event: SubmittedFileEvent): WorkflowInputEvent {
  return {
    id: event.event_id,
    type: FILE_SUBMITTED_EVENT_TYPE,
    occurred_at: event.occurred_at,
    payload: {
      file_id: event.file_id,
      tenant_id: event.tenant_id,
      source_capability: event.source_capability,
      sha256: event.sha256,
      size_bytes: event.size_bytes,
      content_type: event.content_type,
      original_filename: event.original_filename,
      blob_key: event.blob_key,
    },
  };
}
