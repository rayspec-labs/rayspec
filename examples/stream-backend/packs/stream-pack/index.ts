/**
 * The SYNTHETIC stream/blob EXTENSION PACK — the platform's own forcing-function for the
 * `extensions[]` pack mechanism. It carries the ENTIRE stream surface (the blob-pointer store,
 * the ingest/playback/mint handlers, the stream + mint routes) as a `defineExtension` manifest, loaded
 * via `extensions: [{ id, module: ./packs/stream-pack, version }]` from this deployment's `rayspec.yaml`.
 *
 * The stream surface rides the PACK mechanism end-to-end. `loadExtensions` resolves THIS manifest
 * (path-jailed directory, version-pin fail-closed), jails each handler against THIS pack root, and
 * merges these fragments into the deployment spec so the UNCHANGED `deploy()` materializes the store
 * (through the UNCHANGED migration gate + chokepoint probe), the api interpreter serves the routes,
 * and the path-jailed loader loads the handlers. A real product pack is the intended consumer of this
 * exact mechanism, authored in its own repo — this is the platform's synthetic twin.
 *
 * The pack ENTRY (this file) authors against `@rayspec/platform` (where `defineExtension` + the fragment
 * types live). The pack HANDLER modules under `handlers/` import ONLY `@rayspec/handler-sdk` (the
 * type-only capability contract; the now-manifest-derived `gate:handler-imports` +
 * `gate:extension-capability` scan THIS pack's `handlers/` root). NOTE: this dir is in no tsconfig (an
 * `examples/` fixture, excluded from turbo/CI build) — the manifest is loaded at TEST/deploy time (the
 * loader's importer transforms the .ts); it is the synthetic forcing-function, not a workspace package.
 */
import { defineExtension } from '@rayspec/platform';

export default defineExtension({
  // The pack's OWN declared version — `loadExtensions` FAIL-CLOSED-checks it equals the deployment's
  // exact `ref.version` pin (a SKEW aborts the deploy, never a silent skip).
  version: '1.0.0',
  fragments: {
    // ── stores ──────────────────────────────────────────────────────────────────────────────────
    // The blob POINTER-row store (records WHERE a blob lives — an opaque BlobStore key + metadata, NOT
    // the bytes). A NORMAL generated table (text/integer; no new ColumnType) — it rides the UNCHANGED
    // migration gate + chokepoint probe exactly as an inline deployment store would (NO new migration
    // path). The tenancy/GDPR columns are INJECTED by the generator.
    stores: [
      {
        name: 'blob_chunks',
        columns: [
          { name: 'upload_id', type: 'text' },
          { name: 'chunk_index', type: 'integer' },
          // The derived, tenant-namespaced idempotency authority: a single-column UNIQUE that encodes
          // "one row per (tenant, upload_id, chunk_index)" (the ingest 200-ack/409-gap contract; the
          // handler computes `${tenantId}:${upload_id}:${chunk_index}`). See the handler header.
          { name: 'chunk_ref', type: 'text', unique: true },
          { name: 'storage_key', type: 'text' },
          { name: 'byte_len', type: 'integer' },
          { name: 'content_type', type: 'text', nullable: true },
        ],
      },
    ],
    // ── handlers ────────────────────────────────────────────────────────────────────────────────
    // The escape-hatch TS modules the stream/mint routes reference. `module` is relative to THIS PACK
    // ROOT (loadExtensions jails each against the pack root — a pack handler can never climb out). All
    // `route`-kind (a stream/mint handler dispatches through the api chokepoint).
    handlers: [
      {
        id: 'chunk_ingest_handler',
        module: 'handlers/chunk-ingest.ts',
        export: 'chunkIngest',
        kind: 'route',
      },
      {
        id: 'chunk_playback_handler',
        module: 'handlers/chunk-playback.ts',
        export: 'chunkPlayback',
        kind: 'route',
      },
      {
        id: 'play_token_mint_handler',
        module: 'handlers/play-token-mint.ts',
        export: 'playTokenMint',
        kind: 'route',
      },
    ],
    // ── api ─────────────────────────────────────────────────────────────────────────────────────
    // The two stream routes (ingest raw-binary write + playback Range/206 read) + the mint route. They
    // ride the existing api interpreter once merged into the deployment spec.
    api: [
      {
        method: 'POST',
        path: '/uploads/{upload_id}/chunks/{chunk_index}',
        action: { kind: 'stream', handler: 'chunk_ingest_handler', mode: 'ingest' },
      },
      {
        method: 'POST',
        path: '/uploads/{upload_id}/chunks/{chunk_index}/play-token',
        action: { kind: 'handler', handler: 'play_token_mint_handler' },
      },
      {
        method: 'GET',
        path: '/uploads/{upload_id}/chunks/{chunk_index}/playback',
        action: { kind: 'stream', handler: 'chunk_playback_handler', mode: 'playback' },
      },
    ],
  },
});
