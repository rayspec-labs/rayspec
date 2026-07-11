/**
 * Product-neutral file-ingest model. A FILE is one authenticated raw
 * upload a client keys by its own `file_id`; SUBMITTING it seals the bytes and emits the
 * `file_submitted` trigger event a declared Product-YAML workflow can run on. ZERO product
 * vocabulary here — a file's content is arbitrary product DATA (never instructions; the trust boundary).
 *
 * ── THE PAYLOAD CONTRACT (deliberate, gate-pinned) ──────────────────────────────────────
 * UNLIKE the record capability (whose client business fields merge top-level alongside a small
 * envelope), the `file_submitted` payload is ENTIRELY server-derived metadata: every key is built
 * from the STORED pointer row, never from a request body — so there is NO top-level merge and NO
 * client spoof channel (the submit body is a closed shape; unknown keys are rejected 422). The
 * bytes themselves are NEVER in the event payload (journal-friendliness law) — they stay behind
 * the tenant-jailed blob key. `FILE_EVENT_PAYLOAD_KEYS` is the ONE source the manifest descriptor,
 * the event construction, and the seam adapter all consume (gate-pinned).
 */

/**
 * The EXACT keys of every `file_submitted` payload — all server-derived (see the module header):
 * the identity envelope (`file_id`, `tenant_id`, `source_capability` — the record-envelope mirror)
 * plus the stored byte metadata (hash, size, declared type, client filename as DATA, blob key).
 */
export const FILE_EVENT_PAYLOAD_KEYS = [
  'file_id',
  'tenant_id',
  'source_capability',
  'sha256',
  'size_bytes',
  'content_type',
  'original_filename',
  'blob_key',
] as const;

/** The upload lifecycle states of a pointer row (`uploaded` = bytes staged; `submitted` = sealed). */
export type FileState = 'uploaded' | 'submitted';

/**
 * The `file_input.file_submitted` event — the workflow trigger shape. The `event_id` is the
 * FILE-scoped idempotency key (= `${tenant_id}:${file_id}`, the record `submittedEventId` mirror),
 * so a re-submit of the same file converges on ONE workflow (C10 single-flight downstream). Every
 * field is read from the AUTHORITATIVE stored pointer row (never a raw request), so a deduped
 * redelivery is byte-consistent with the first delivery. Bytes are NOT here — `blob_key` is the
 * tenant-relative key a tenant-bound reader resolves (the S3 parse node's input).
 */
export interface SubmittedFileEvent {
  /** Idempotency key for workflow consumption (= `${tenant_id}:${file_id}`). */
  readonly event_id: string;
  /** Server-derived tenant boundary (never client-supplied). */
  readonly tenant_id: string;
  readonly file_id: string;
  /** sha256 hex over the RAW stored bytes (the divergence detector). */
  readonly sha256: string;
  /** The stored byte length. */
  readonly size_bytes: number;
  /** The client-declared media type (advisory DATA — allowlist-checked at upload, never trusted). */
  readonly content_type: string;
  /** The client filename (escaped DATA — NEVER part of any key/path; null when none was sent). */
  readonly original_filename: string | null;
  /** The tenant-relative blob key of the stored bytes (server-derived from file_id only). */
  readonly blob_key: string;
  /** Server timestamp (ISO-8601). */
  readonly occurred_at: string;
  /** The emitting capability id — always `file_input`. */
  readonly source_capability: 'file_input';
}

/** The upload route's success result (the `file_input.upload` contract). */
export interface FileUploadResult {
  readonly file_id: string;
  /** The row state after this upload (`submitted` for a no-op re-upload of a sealed file). */
  readonly state: FileState;
  /** sha256 hex over the stored bytes. */
  readonly sha256: string;
  readonly size_bytes: number;
  /** True when this upload REPLACED previously-staged divergent bytes (last-write-wins pre-seal). */
  readonly replaced: boolean;
  /** True when this upload was an idempotent no-op (identical bytes already stored). */
  readonly deduped: boolean;
}

/** The submit route's success result (the `file_input.submit` contract). */
export interface FileSubmitResult {
  readonly file_id: string;
  /**
   * The idempotency key of the `file_submitted` event this submit emitted downstream (file-scoped
   * — a re-submit re-emits the SAME id and dedups to one workflow).
   */
  readonly event_id: string;
  /**
   * True when this submit was a re-submit of an already-sealed file (the STORED authoritative
   * event was re-emitted for redelivery and dedups downstream — client retry = redelivery, C10).
   */
  readonly deduped: boolean;
}

/** A typed error body a capability route returns (mapped to the proper HTTP status by the binding). */
export interface FileErrorBody {
  readonly error: string;
  readonly detail: string;
}
