/**
 * The neutral store schema this Tier B capability owns. Product-neutral names
 * + only standard column types (text/jsonb), so it rides the UNCHANGED migration/chokepoint path
 * exactly as an inline product store would. The tenancy/GDPR columns (id, tenant_id, created_at,
 * deleted_at, retention_days, region) are INJECTED by the generator, never declared here.
 *
 * ── KEYING (the audio pattern, mirrored on purpose) ───────────────────────────────────────────
 * The platform's generated single-column UNIQUE is GLOBAL, so `record_ref` embeds the
 * SERVER-DERIVED tenant id (`${tenantId}:${record_id}` — keys.ts). That prefix makes the store
 * PER-TENANT-KEYED BY CONSTRUCTION: two tenants' identical `record_id` values can never collide,
 * so this capability-owned store does NOT carry the declared-store deployment-global-key caveat
 * — we own this DDL and key it per-tenant cheaply, exactly like the audio
 * capability's `session_ref`/`track_ref`.
 */
import type { StoreSpec } from '@rayspec/spec';

/** The capability id (the Product-YAML `capabilities[].id` this runtime serves). */
export const RECORD_INPUT_CAPABILITY_ID = 'record_input';

/** The declared neutral store name this capability owns. */
export const RECORD_SUBMISSIONS_STORE = 'record_submissions';

/**
 * The capability's store names as a set — the single source for store-derivation callers (the
 * server boot + the CLI pass it to `deriveProductStores`, unioned with the audio names, to tell
 * capability-owned stores apart from a product's declared stores — the shared store-name-derivation pattern).
 */
export const RECORD_STORE_NAMES: ReadonlySet<string> = new Set([RECORD_SUBMISSIONS_STORE]);

/**
 * The capability's store definitions. A deployment mounting the capability merges these into the
 * composed `stores[]`; the deploy path materializes them via the SAME generator every store uses.
 */
export function recordCapabilityStores(): StoreSpec[] {
  return [
    {
      name: RECORD_SUBMISSIONS_STORE,
      columns: [
        // The client-supplied record id (DATA; the handler filters by ref, never by this alone).
        { name: 'record_id', type: 'text', nullable: false, unique: false },
        // Tenant-namespaced single-column UNIQUE (= `${tenantId}:${record_id}`) — the idempotency
        // authority the submit route's upsert + the different-payload 409 key off. The tenant is
        // server-derived (see the module header: per-tenant-keyed by construction).
        { name: 'record_ref', type: 'text', nullable: false, unique: true },
        // The submitted business fields (DATA, never instructions) — the AUTHORITATIVE payload a
        // re-submit re-emits from (payload-as-data with authoritative re-read).
        { name: 'payload', type: 'jsonb', nullable: false, unique: false },
        // sha256 of the canonical-JSON payload — the different-payload-same-key detector (409).
        { name: 'payload_hash', type: 'text', nullable: false, unique: false },
      ],
      foreignKeys: [],
    },
  ];
}
