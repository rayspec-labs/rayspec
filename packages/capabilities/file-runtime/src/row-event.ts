/**
 * The ONE `SubmittedFileEvent` construction — always from a STORED pointer row (never a request):
 * the seal path, the re-submit redelivery, AND both divergent-409 heals build the event HERE, so
 * a deduped redelivery is byte-consistent with the first delivery and no call site can drift onto
 * request-derived values. `occurred_at` is per-delivery (like the record/audio redelivery); the
 * identity + metadata are what the downstream dedup keys on.
 */
import type { StoreRow } from '@rayspec/handler-sdk';
import { submittedFileEventId } from './keys.js';
import type { SubmittedFileEvent } from './types.js';

export function submittedFileEventFromRow(tenantId: string, row: StoreRow): SubmittedFileEvent {
  const fileId = String(row.file_id);
  const sizeRaw = Number(row.size_bytes);
  return {
    event_id: submittedFileEventId(tenantId, fileId),
    tenant_id: tenantId,
    file_id: fileId,
    sha256: String(row.sha256),
    size_bytes: Number.isFinite(sizeRaw) && sizeRaw >= 0 ? sizeRaw : 0,
    content_type: String(row.content_type),
    original_filename:
      row.original_filename === null || row.original_filename === undefined
        ? null
        : String(row.original_filename),
    blob_key: String(row.blob_key),
    occurred_at: new Date().toISOString(),
    source_capability: 'file_input',
  };
}
