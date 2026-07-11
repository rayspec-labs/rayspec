/**
 * The neutral store schema this Tier B capability owns. Product-neutral names + only
 * standard column types (text/uuid/integer) — so these ride the UNCHANGED migration/chokepoint path
 * exactly as an inline product store would (no new ColumnType, no new migration mechanism). The
 * tenancy/GDPR columns (id, tenant_id, created_at, deleted_at, retention_days, region) are INJECTED by
 * the generator, never declared here. The tenant-namespaced `session_ref`/`track_ref` carry the UNIQUE
 * (the platform's generated single-column unique is GLOBAL, so the tenant prefix is what isolates it).
 */
import type { StoreSpec } from '@rayspec/spec';

/** The declared store names + their set (single source, re-exported from ports for import convenience). */
export { AUDIO_SESSIONS_STORE, AUDIO_STORE_NAMES, AUDIO_TRACKS_STORE } from './ports.js';

/**
 * The capability's store definitions. A product mounting the capability merges these into its spec's
 * `stores[]`; the deploy path materializes them via the SAME generator every store uses.
 */
export function audioCapabilityStores(): StoreSpec[] {
  return [
    {
      name: 'audio_sessions',
      columns: [
        // The client-supplied session id (DATA; the handler filters by this).
        { name: 'session_id', type: 'text', nullable: false, unique: false },
        // Tenant-namespaced single-column UNIQUE (= `${tenantId}:${session_id}`). The tenant is server-derived.
        { name: 'session_ref', type: 'text', nullable: false, unique: true },
        // recording | finalizing | completed | failed.
        { name: 'status', type: 'text', nullable: false, unique: false },
        // The upload protocol version the client declared (readable DATA; behavior never branches on it).
        { name: 'protocol_version', type: 'integer', nullable: false, unique: false },
      ],
      foreignKeys: [],
    },
    {
      name: 'audio_tracks',
      columns: [
        // The uuid FK to the parent session row (cascade — see foreignKeys). The structural parent link.
        { name: 'session_pk', type: 'uuid', nullable: false, unique: false },
        // The client-supplied session id (text) the handler filters by (the uuid FK is structural).
        { name: 'session_id', type: 'text', nullable: false, unique: false },
        // The track lane id (config-validated; stored as DATA — no fixed two-lane assumption).
        { name: 'track', type: 'text', nullable: false, unique: false },
        // recording | completed | failed (absent = no row).
        { name: 'status', type: 'text', nullable: false, unique: false },
        // The blob-key prefix for this track's raw chunks (`${session_id}/${track}`).
        { name: 'storage_key_prefix', type: 'text', nullable: false, unique: false },
        // THE WATERMARK: count of durably-persisted chunks == next_expected_index (the resume authority).
        { name: 'persisted_chunk_count', type: 'integer', nullable: false, unique: false },
        // The durably-committed payload byte length (surfaced by upload-status).
        { name: 'committed_byte_len', type: 'integer', nullable: false, unique: false },
        // Tenant-namespaced single-column UNIQUE (= `${tenantId}:${session_id}:${track}`) — the
        // idempotency authority the 200-ack/409-gap contract keys off.
        { name: 'track_ref', type: 'text', nullable: false, unique: true },
        // The playable media artifact's blob key (nullable until a media-prep step registers it). Its
        // presence is the playback-readiness marker (a non-null key implies the blob exists — set atomically).
        { name: 'media_artifact_key', type: 'text', nullable: true, unique: false },
        // The playable artifact's content type (served on playback; nullable until registered).
        { name: 'media_content_type', type: 'text', nullable: true, unique: false },
        // The playable artifact's duration in whole seconds (sizes the playback-token TTL; nullable pre-prep).
        { name: 'media_duration_seconds', type: 'integer', nullable: true, unique: false },
      ],
      // session_pk -> audio_sessions.id (the parent's injected uuid PK), ON DELETE CASCADE (GDPR/parent cleanup).
      foreignKeys: [{ column: 'session_pk', references: 'audio_sessions', onDelete: 'cascade' }],
    },
  ];
}
