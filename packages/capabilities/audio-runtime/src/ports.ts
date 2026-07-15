/**
 * The injected, tenant-bound ports the capability core operates over. These are the EXACT platform
 * capability shapes (`HandlerDb` + `BlobStore` from @rayspec/handler-sdk — type-only, erased at
 * runtime), so the RaySpec binding threads `init.db`/`init.blob` straight through with no adapter, and
 * the core stays decoupled from the platform impl (isolate-friendly: name-keyed db calls + opaque blob
 * keys). The core NEVER constructs a capability — it is given tenant-bound handles.
 */
import type { BlobStore, HandlerDb } from '@rayspec/handler-sdk';
import type { ResolvedAudioConfig } from './config.js';

export type { BlobStore, HandlerDb } from '@rayspec/handler-sdk';

/** The declared neutral store names this capability owns. */
export const AUDIO_SESSIONS_STORE = 'audio_sessions';
export const AUDIO_TRACKS_STORE = 'audio_tracks';

/**
 * The capability's two store names as a set — the SINGLE source for store-derivation callers (the
 * server boot + the CLI's product-profile store derivation) that pass it to `deriveProductStores` to tell the
 * capability's own stores apart from a product's inline stores. Shared so the two call sites cannot
 * drift.
 */
export const AUDIO_STORE_NAMES: ReadonlySet<string> = new Set([
  AUDIO_SESSIONS_STORE,
  AUDIO_TRACKS_STORE,
]);

/** The mint-a-media-token capability (matches `RouteHandlerInit.mintPlayToken`). */
export type MintPlayToken = (args: { resource: string; ttlSeconds: number }) => Promise<string>;

/**
 * The base tenant-bound context a DB-only capability operation runs against (upload-status, finalize,
 * play-token mint). `tenantId` is SERVER-DERIVED (never client-supplied); `db` is bound to that tenant
 * BY CONSTRUCTION (the binding built it from the run's tenant). A `{handler}` route init carries NO
 * blob (only stream routes do), so the db-only ops must not require one. Operation-specific dependencies
 * (the event sink, the token minter) are passed explicitly to the operations that need them.
 */
export interface AudioCoreContext {
  readonly tenantId: string;
  readonly db: HandlerDb;
  readonly config: ResolvedAudioConfig;
}

/**
 * The context for a byte-moving operation (chunk ingest, media stream, playable-artifact registration).
 * Adds the tenant-bound `BlobStore`, which a `stream` route init always carries (and the test-driven
 * media-prep path builds explicitly). The blob keys are tenant-jailed by construction.
 */
export interface AudioBlobContext extends AudioCoreContext {
  readonly blob: BlobStore;
}

/** The route path params a session/track operation reads (all DATA — server-parsed strings). */
export interface SessionTrackParams {
  readonly session_id?: string;
  readonly track?: string;
}
