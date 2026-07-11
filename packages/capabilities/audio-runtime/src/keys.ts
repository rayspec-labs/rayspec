/**
 * Tenant-namespaced key derivation. The platform's generated single-column UNIQUE is GLOBAL, so the
 * tenant id MUST be embedded in the unique refs (`session_ref`/`track_ref`) — that prefix is what keeps
 * two tenants' identical `session_id` from colliding. The tenant id is always SERVER-DERIVED (never
 * client-supplied). Blob keys are relative (the injected BlobStore handle is already tenant-jailed).
 */

/** The tenant-namespaced unique key for one session within a tenant (= `${tenantId}:${sessionId}`). */
export function sessionRef(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`;
}

/** The tenant-namespaced unique key for one (session, track) within a tenant. */
export function trackRef(tenantId: string, sessionId: string, track: string): string {
  return `${tenantId}:${sessionId}:${track}`;
}

/** The SESSION-scoped downstream idempotency key (dual-track finalize converges on this ONE key). */
export function finalizedEventId(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`;
}

/** The blob-key prefix for a track's raw chunks (`${sessionId}/${track}`). */
export function storageKeyPrefix(sessionId: string, track: string): string {
  return `${sessionId}/${track}`;
}

/** The opaque BlobStore key for one raw chunk (put-by-index → idempotent overwrite on retry). */
export function chunkKey(sessionId: string, track: string, chunkIndex: number): string {
  return `${storageKeyPrefix(sessionId, track)}/chunk_${chunkIndex}`;
}

/**
 * The blob key for a track's PLAYABLE media artifact — the single contiguous, seekable blob the
 * playback stream serves (NOT the raw chunks). Written by the media-prep step (STT preprocessing in the
 * full stack; the fake media adapter in tests). Single-sourced here so the register/mint/stream sites
 * cannot drift on the key.
 */
export function mediaArtifactKey(sessionId: string, track: string): string {
  return `${storageKeyPrefix(sessionId, track)}/media`;
}
