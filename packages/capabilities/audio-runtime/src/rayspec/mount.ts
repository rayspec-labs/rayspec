/**
 * The capability mount helper — turn the capability into the declarative fragments a
 * RaySpec deployment mounts: the neutral `stores[]`, the `api[]` route set (behind the SAME auth/tenancy
 * chain every route uses), and the resolved handler map (id → route-kind handler) the engine dispatches.
 * ADDITIVE composition only — this touches no kill-set file; a product supplies a mount base path + the
 * event sink and gets a fully-wired audio capability.
 */
import type { RouteHandler } from '@rayspec/handler-sdk';
import type { ApiRouteSpec, RaySpec, StoreSpec } from '@rayspec/spec';
import { type AudioCapabilityConfig, resolveConfig } from '../config.js';
import type { SessionFinalizedSink } from '../events.js';
import { audioCapabilityStores } from '../stores.js';
import {
  type AudioHandlersConfig,
  makeChunkIngestHandler,
  makeFinalizeHandler,
  makeMediaStreamHandler,
  makePlayTokenMintHandler,
  makeUploadStatusHandler,
} from './handlers.js';

/** The stable handler ids the capability registers (neutral; override only if a product must). */
export interface AudioHandlerIds {
  readonly chunkIngest: string;
  readonly uploadStatus: string;
  readonly finalizeTrack: string;
  readonly playToken: string;
  readonly playback: string;
}

export const DEFAULT_AUDIO_HANDLER_IDS: AudioHandlerIds = {
  chunkIngest: 'audio_input_chunk_ingest',
  uploadStatus: 'audio_input_upload_status',
  finalizeTrack: 'audio_input_finalize_track',
  playToken: 'media_playback_token',
  playback: 'media_playback_stream',
};

/** The default route mount base path (sub-paths hang under it). */
export const DEFAULT_AUDIO_BASE_PATH = '/sessions';

export interface AudioCapabilityMountConfig {
  /** The route mount base path (default `/sessions`). No trailing slash. */
  readonly basePath?: string;
  /** Core capability config (allowed tracks, session-id shape, TTL policy). */
  readonly capability?: AudioCapabilityConfig;
  /** The sink `finalize` emits `session_finalized` through — the Tier A event seam. */
  readonly sessionFinalizedSink: SessionFinalizedSink;
  /** Override the registered handler ids (rarely needed). */
  readonly handlerIds?: Partial<AudioHandlerIds>;
}

/** A resolved handler entry — always `route`-kind (a stream handler is a route-kind handler). */
export interface AudioResolvedHandler {
  readonly kind: 'route';
  readonly fn: RouteHandler;
}

export interface MountedAudioCapability {
  /** The capability's neutral stores (merge into the product spec's `stores[]`). */
  readonly stores: StoreSpec[];
  /** The capability's routes (merge into the product spec's `api[]`). */
  readonly api: ApiRouteSpec[];
  /** id → resolved route-kind handler (pass as `engineHandlers` / the declared-routes `handlers` map). */
  readonly handlers: ReadonlyMap<string, AudioResolvedHandler>;
  /** The resolved handler ids (defaults ⊕ overrides). */
  readonly handlerIds: AudioHandlerIds;
  /** The mount base path used. */
  readonly basePath: string;
}

/**
 * Mount the Audio/Media capability. Returns the declarative fragments + the resolved handler map. A
 * stream handler's fn is stored as a `route`-kind entry (the platform's loader/interpreter treats a
 * stream handler as a route-kind handler that receives a raw `Request` — the raw-vs-JSON init shape is a
 * runtime concern, not a handler kind), so the map is exactly the `ReadonlyMap<string, ResolvedHandler>`
 * the declared-routes engine consumes.
 */
export function mountAudioCapability(config: AudioCapabilityMountConfig): MountedAudioCapability {
  const basePath = (config.basePath ?? DEFAULT_AUDIO_BASE_PATH).replace(/\/$/, '');
  const ids: AudioHandlerIds = { ...DEFAULT_AUDIO_HANDLER_IDS, ...config.handlerIds };
  const resolved = resolveConfig(config.capability);

  const handlersConfig: AudioHandlersConfig = {
    resolved,
    sessionFinalizedSink: config.sessionFinalizedSink,
    buildPlaybackUrl: (sessionId, track, token) =>
      `${basePath}/${sessionId}/${track}/playback?token=${encodeURIComponent(token)}`,
  };

  // A stream handler is a route-kind handler at runtime; cast its typed fn into the route slot (the SAME
  // cast the platform's stream interpreter applies — `handler.fn as unknown as StreamRouteHandler`).
  const streamAsRoute = (fn: unknown): AudioResolvedHandler => ({
    kind: 'route',
    fn: fn as RouteHandler,
  });
  const asRoute = (fn: RouteHandler): AudioResolvedHandler => ({ kind: 'route', fn });

  const handlers = new Map<string, AudioResolvedHandler>([
    [ids.chunkIngest, streamAsRoute(makeChunkIngestHandler(handlersConfig))],
    [ids.uploadStatus, asRoute(makeUploadStatusHandler(handlersConfig))],
    [ids.finalizeTrack, asRoute(makeFinalizeHandler(handlersConfig))],
    [ids.playToken, asRoute(makePlayTokenMintHandler(handlersConfig))],
    [ids.playback, streamAsRoute(makeMediaStreamHandler(handlersConfig))],
  ]);

  const api: ApiRouteSpec[] = [
    {
      method: 'POST',
      path: `${basePath}/{session_id}/{track}/chunks/{chunk_index}`,
      action: { kind: 'stream', handler: ids.chunkIngest, mode: 'ingest' },
    },
    {
      method: 'GET',
      path: `${basePath}/{session_id}/{track}/upload-status`,
      action: { kind: 'handler', handler: ids.uploadStatus },
    },
    {
      method: 'POST',
      path: `${basePath}/{session_id}/{track}/finalize`,
      action: { kind: 'handler', handler: ids.finalizeTrack },
    },
    {
      method: 'POST',
      path: `${basePath}/{session_id}/{track}/play-token`,
      action: { kind: 'handler', handler: ids.playToken },
    },
    {
      method: 'GET',
      path: `${basePath}/{session_id}/{track}/playback`,
      action: { kind: 'stream', handler: ids.playback, mode: 'playback' },
    },
  ];

  return { stores: audioCapabilityStores(), api, handlers, handlerIds: ids, basePath };
}

/**
 * The lowered engine target's version literal — FROZEN at the pre-merge engine-internal representation.
 * The unified AUTHORING language bumped to `version:'1.0'`, but a CODE-BUILT engine target still lowers
 * to today's `RaySpec`, byte-for-byte (it is consumed by the deploy/mount path directly, never
 * re-parsed through the grammar whose `version` is now `z.literal('1.0')`). Typed `string` so the cast
 * below reconciles it with the bumped literal type without perturbing any engine-spec byte.
 */
const FROZEN_ENGINE_SPEC_VERSION: string = '0.1';

/**
 * Assemble a full `RaySpec` that mounts the capability for a product. Convenience for a deployment
 * or an integration harness: it merges the capability stores + api into a base spec. `handlers[]` stays
 * empty because the resolved handler map (returned by `mountAudioCapability`) is injected directly into
 * the declared-routes engine — a code-built spec resolves handlers from that map, not from `spec.handlers`.
 * The `version` is the FROZEN engine-internal literal (see `FROZEN_ENGINE_SPEC_VERSION`).
 */
export function buildAudioCapabilitySpec(
  mounted: MountedAudioCapability,
  metadata: { name: string; description?: string },
  extra?: { stores?: StoreSpec[]; api?: ApiRouteSpec[] },
): RaySpec {
  return {
    version: FROZEN_ENGINE_SPEC_VERSION as RaySpec['version'],
    metadata,
    stores: [...mounted.stores, ...(extra?.stores ?? [])],
    api: [...mounted.api, ...(extra?.api ?? [])],
    agents: [],
    tooling: [],
    triggers: [],
    handlers: [],
    extensions: [],
  };
}
