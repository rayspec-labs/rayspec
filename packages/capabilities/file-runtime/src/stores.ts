/**
 * The neutral store schema this Tier B capability owns (the record `stores.ts` pattern).
 * Product-neutral names + only standard column types (text/integer), so it rides the UNCHANGED
 * migration/chokepoint path exactly as an inline product store would. The tenancy/GDPR columns
 * (id, tenant_id, created_at, deleted_at, retention_days, region) are INJECTED by the generator,
 * never declared here.
 *
 * ── KEYING (the audio/record pattern, mirrored on purpose) ────────────────────────────────────
 * The platform's generated single-column UNIQUE is GLOBAL, so `file_ref` embeds the SERVER-DERIVED
 * tenant id (`${tenantId}:${file_id}` — keys.ts). That prefix makes the store PER-TENANT-KEYED BY
 * CONSTRUCTION: two tenants' identical `file_id` values can never collide, so this
 * capability-owned store does NOT carry the declared-store deployment-global-key caveat
 * — we own this DDL and key it per-tenant cheaply, exactly like the
 * record capability's `record_ref`.
 */
import type { StoreSpec } from '@rayspec/spec';

/** The capability id (the Product-YAML `capabilities[].id` this runtime serves). */
export const FILE_INPUT_CAPABILITY_ID = 'file_input';

/** The declared neutral store name this capability owns (the upload pointer rows). */
export const FILE_UPLOADS_STORE = 'file_uploads';

/**
 * The capability's store names as a set — the single source for store-derivation callers (the
 * server boot + the CLI pass it to `deriveProductStores`, unioned with the audio/record names, to
 * tell capability-owned stores apart from a product's declared stores — the shared store-name-derivation pattern).
 */
export const FILE_STORE_NAMES: ReadonlySet<string> = new Set([FILE_UPLOADS_STORE]);

/**
 * The capability's store definitions. A deployment mounting the capability merges these into the
 * composed `stores[]`; the deploy path materializes them via the SAME generator every store uses.
 */
export function fileCapabilityStores(): StoreSpec[] {
  return [
    {
      name: FILE_UPLOADS_STORE,
      columns: [
        // The client-supplied file id (DATA; the handlers filter by ref, never by this alone).
        { name: 'file_id', type: 'text', nullable: false, unique: false },
        // Tenant-namespaced single-column UNIQUE (= `${tenantId}:${file_id}`) — the idempotency
        // authority the upload/submit state machine keys off. The tenant is server-derived (see
        // the module header: per-tenant-keyed by construction).
        { name: 'file_ref', type: 'text', nullable: false, unique: true },
        // The lifecycle state: 'uploaded' (bytes staged) | 'submitted' (sealed + event emitted).
        { name: 'state', type: 'text', nullable: false, unique: false },
        // sha256 hex over the RAW stored bytes — the divergence detector (409 after seal).
        { name: 'sha256', type: 'text', nullable: false, unique: false },
        // The stored byte length (the cap already bounded it at drain time).
        { name: 'size_bytes', type: 'integer', nullable: false, unique: false },
        // The client-DECLARED media type (advisory DATA — allowlist-checked, never trusted).
        { name: 'content_type', type: 'text', nullable: false, unique: false },
        // The client filename — escaped DATA ONLY: NEVER part of any key, path, or id.
        { name: 'original_filename', type: 'text', nullable: true, unique: false },
        // The tenant-relative blob key of the stored bytes (server-derived from file_id only).
        { name: 'blob_key', type: 'text', nullable: false, unique: false },
        // Lifecycle timestamps (ISO-8601 text — the capability sets them; created_at is injected).
        { name: 'uploaded_at', type: 'text', nullable: false, unique: false },
        { name: 'submitted_at', type: 'text', nullable: true, unique: false },
      ],
      foreignKeys: [],
    },
  ];
}
