/**
 * Tenant-namespaced key derivation — the AUDIO KEYING PATTERN, mirrored deliberately: the
 * platform's generated single-column UNIQUE is GLOBAL, so the tenant id is EMBEDDED in the
 * unique ref (`record_ref`), which is what keeps two tenants' identical `record_id` from colliding.
 * That makes the capability-owned store PER-TENANT-KEYED BY CONSTRUCTION — we own this DDL (unlike
 * the grammar-declared stores, whose bare single-column key IS deployment-global — the
 * deployment-global-key caveat class; this store does NOT share that caveat). The tenant id is always
 * SERVER-DERIVED (never client-supplied).
 */

/** The tenant-namespaced unique key for one record within a tenant (= `${tenantId}:${recordId}`). */
export function recordRef(tenantId: string, recordId: string): string {
  return `${tenantId}:${recordId}`;
}

/**
 * The RECORD-scoped downstream idempotency key (a re-submit converges on this ONE key — the audio
 * `finalizedEventId` mirror). Deterministic + tenant-scoped: `${tenantId}:${recordId}`.
 */
export function submittedEventId(tenantId: string, recordId: string): string {
  return `${tenantId}:${recordId}`;
}
