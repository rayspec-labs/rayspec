/**
 * Tenant-namespaced key derivation — the AUDIO/RECORD KEYING PATTERN, mirrored deliberately: the
 * platform's generated single-column UNIQUE is GLOBAL, so the tenant id is EMBEDDED in the unique
 * ref (`file_ref`), which is what keeps two tenants' identical `file_id` from colliding. That
 * makes the capability-owned store PER-TENANT-KEYED BY CONSTRUCTION (we own this DDL — not the
 * declared-store global-key caveat class). The tenant id is always SERVER-DERIVED (never
 * client-supplied).
 *
 * ── THE BLOB KEY (the server-derived key rule) ──────────────────────────────────────────────────────────
 * The blob key is derived SERVER-SIDE from the validated `file_id` ONLY. The client filename
 * NEVER appears in any blob key, path, or id — it is an escaped DATA column on the pointer row
 * and a DATA field on the event, nothing more. Blob keys are tenant-RELATIVE: the injected
 * `BlobStore` handle is already tenant-bound + path-jailed (`${tenantId}/${callerKey}` built
 * INSIDE the handle), exactly like the audio chunk keys.
 */

/** The tenant-namespaced unique key for one file within a tenant (= `${tenantId}:${fileId}`). */
export function fileRef(tenantId: string, fileId: string): string {
  return `${tenantId}:${fileId}`;
}

/**
 * The FILE-scoped downstream idempotency key (a re-submit converges on this ONE key — the record
 * `submittedEventId` mirror). Deterministic + tenant-scoped: `${tenantId}:${fileId}`.
 */
export function submittedFileEventId(tenantId: string, fileId: string): string {
  return `${tenantId}:${fileId}`;
}

/**
 * The opaque, tenant-relative BlobStore key for one file's raw bytes — CONTENT-ADDRESSED under
 * the file id: `files/${fileId}/${sha256}`. Both components are SERVER-DERIVED (the validated
 * file id + the hash computed over the drained bytes — the filename is never a key component).
 *
 * WHY the sha suffix (deliberate, a design decision): the pointer row and the blob live in
 * different stores with no shared transaction, so a plain `files/${fileId}` key would let two
 * CONCURRENT divergent uploads interleave put/upsert into a row whose `sha256` does not match the
 * blob's actual bytes — permanently, even past seal. With the content suffix, a key IMMUTABLY
 * names its bytes (re-putting a key writes identical content), so the row's `blob_key` always
 * resolves to bytes matching its `sha256` under ANY interleaving. The cost: bytes replaced
 * pre-seal orphan under their old key — covered by the plan's stated abandoned-blobs cut (no GC
 * in v1).
 */
export function fileBlobKey(fileId: string, sha256: string): string {
  return `files/${fileId}/${sha256}`;
}
