/**
 * Escape-hatch PLAY-TOKEN MINT handler for the synthetic stream backend.
 *
 * The PACK-SIDE mint route — a NORMAL `{handler}` route (authed RS256 Bearer, the standard
 * `requireAuth → resolveTenant → requirePermission(store:write)` chain), NOT a stream route. It mints a
 * short-lived `?token=` media-JWT authorizing the CALLER to stream a chunk they OWN. The platform
 * injects `init.mintPlayToken` (bound to the run's SERVER-DERIVED tenant + the authed user — the
 * handler cannot forge a tenant or mint for another user); this handler only chooses the OPAQUE
 * resource (the chunk's storage key) + the TTL, AFTER confirming ownership in the DB.
 *
 * Imports `@rayspec/handler-sdk` TYPE-ONLY; the gates confirm it imports nothing else + self-constructs
 * no raw capability (it reaches the DB only through the injected, tenant-bound `init.db`).
 *
 * OWNERSHIP CHECK (the mint-side mirror of the playback re-validation): the handler reads the pointer
 * row for `(upload_id, chunk_index)` through the tenant-bound `init.db`. A chunk NOT owned by the
 * caller's tenant is invisible → no row → 404 (the caller cannot mint a token for another tenant's
 * blob). The minted token's `resource` is the storage key `${upload_id}/${chunk_index}` — the SAME key
 * the playback handler binds + re-validates.
 */
import type { RouteHandler, RouteHandlerInit } from '@rayspec/handler-sdk';

const POINTER_STORE = 'blob_chunks';

/** Default media-token TTL (seconds). A real pack scales it to the recording duration. */
const DEFAULT_TTL_SECONDS = 300;

export const playTokenMint: RouteHandler = async (init: RouteHandlerInit): Promise<unknown> => {
  const uploadId = init.params.upload_id;
  const indexRaw = init.params.chunk_index;
  if (!uploadId || !indexRaw) {
    return { error: 'bad_request', detail: 'upload_id and chunk_index are required.' };
  }
  const chunkIndex = Number(indexRaw);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return { error: 'bad_request', detail: 'chunk_index must be a non-negative integer.' };
  }

  // The mint capability is injected ONLY when a media key is wired. A mint route deployed without it
  // fail-closes loudly here (never a silent un-authenticated token path).
  if (!init.mintPlayToken) {
    throw new Error(
      'play-token mint: init.mintPlayToken is not available — the deployment wired no media signing ' +
        'key (RAYSPEC_MEDIA_SIGNING_KEY). Fail-closed.',
    );
  }

  // OWNERSHIP: the chunk must be owned by the caller's tenant (init.db is tenant-scoped by construction).
  const rows = await init.db.select(POINTER_STORE, {
    upload_id: uploadId,
    chunk_index: chunkIndex,
  });
  if (rows.length === 0) {
    // Not owned by this tenant (or never ingested) — refuse to mint (no cross-tenant token).
    return { error: 'not_found', detail: 'no such resource.' };
  }

  // Mint: the engine binds tenant + user; we supply the opaque resource (the storage key) + the TTL.
  const resource = `${uploadId}/${chunkIndex}`;
  const token = await init.mintPlayToken({ resource, ttlSeconds: DEFAULT_TTL_SECONDS });
  // The client appends `?token=<token>` to the playback URL.
  return { token, ttl_seconds: DEFAULT_TTL_SECONDS, resource };
};
