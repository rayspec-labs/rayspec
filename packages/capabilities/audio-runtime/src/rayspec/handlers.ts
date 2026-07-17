/**
 * The RaySpec platform binding — the thin adapter that turns the product-neutral
 * capability core into `RouteHandler`/`StreamRouteHandler` functions running behind RaySpec's real
 * auth/tenancy chain. It imports `@rayspec/handler-sdk` TYPE-ONLY (erased at runtime) exactly like a
 * pack handler, threading `init.db`/`init.blob`/`init.mintPlayToken`/`init.params`/`init.body` straight
 * into the core ports (no re-implementation of tenancy, blobs, or media tokens). The binding owns ONLY
 * transport concerns (raw bytes in/out, status-code mapping, the playback URL); the contract lives in
 * the core.
 */
import {
  type HttpResponse,
  httpResponse,
  type RouteHandler,
  type RouteHandlerInit,
  readBoundedBody,
  type StreamRouteHandler,
  type StreamRouteHandlerInit,
} from '@rayspec/handler-sdk';
import type { ResolvedAudioConfig } from '../config.js';
import type { AudioCapabilityError, AudioCapabilityResult } from '../errors.js';
import { AudioCapabilityWiringError, err } from '../errors.js';
import { SessionEventRejectedError, type SessionFinalizedSink } from '../events.js';
import { mintPlaybackToken, streamMedia } from '../playback.js';
import type { AudioBlobContext, AudioCoreContext } from '../ports.js';
import type { AudioErrorBody, PlaybackTokenResult } from '../types.js';
import { finalizeTrack, ingestChunk, readUploadStatus } from '../upload.js';

/** The wiring a set of capability handlers needs (built by `mountAudioCapability`). */
export interface AudioHandlersConfig {
  readonly resolved: ResolvedAudioConfig;
  /** The sink `finalize` emits `session_finalized` through (the Tier A event seam). */
  readonly sessionFinalizedSink: SessionFinalizedSink;
  /** Build the relative playback URL the play-token response returns (route-path aware). */
  readonly buildPlaybackUrl: (sessionId: string, track: string, token: string) => string;
}

/** Build the base (db-only) context from a `{handler}` route init. */
function coreContext(init: RouteHandlerInit, config: ResolvedAudioConfig): AudioCoreContext {
  return { tenantId: init.tenantId, db: init.db, config };
}

/** Build the blob context from a `stream` route init (its `blob` is always present). */
function blobContext(init: StreamRouteHandlerInit, config: ResolvedAudioConfig): AudioBlobContext {
  return { tenantId: init.tenantId, db: init.db, blob: init.blob, config };
}

/** Render a typed capability error into its JSON body (shared by both transport arms). */
function errorBody(result: AudioCapabilityError): AudioErrorBody {
  return {
    error: result.error,
    detail: result.detail,
    ...(result.next_expected_index !== undefined
      ? { next_expected_index: result.next_expected_index }
      : {}),
  };
}

/** Map a capability result to a raw JSON `Response` (the stream-route transport). */
function toRawResponse(result: AudioCapabilityResult<unknown>): Response {
  const body = result.ok ? result.value : errorBody(result);
  const status = result.ok ? 200 : result.status;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Map a capability result to a `{handler}` route return (plain body = 200; error = httpResponse). */
function toHandlerReturn<T>(result: AudioCapabilityResult<T>): T | HttpResponse<AudioErrorBody> {
  if (result.ok) return result.value;
  return httpResponse({ status: result.status, body: errorBody(result) });
}

/** The `audio_input.chunk` stream-ingest handler (raw binary in / JSON ack out). */
export function makeChunkIngestHandler(config: AudioHandlersConfig): StreamRouteHandler {
  return async (init: StreamRouteHandlerInit): Promise<Response> => {
    const ctx = blobContext(init, config.resolved);
    // BOUNDED body read: drain the raw request under the per-chunk cap instead of the naive
    // unbounded `request.arrayBuffer()` — an over-cap chunk is a 413 BEFORE the bytes are buffered
    // into memory or stored (the shared file-runtime byte-bound pattern, generalized).
    const drained = await readBoundedBody(
      {
        contentLength: init.request.headers.get('content-length'),
        body: init.request.body,
      },
      { maxBytes: config.resolved.maxChunkBytes },
    );
    if (!drained.ok) {
      return toRawResponse(
        err(
          413,
          'chunk_too_large',
          `the chunk body exceeds the ${config.resolved.maxChunkBytes}-byte per-chunk cap.`,
        ),
      );
    }
    const contentType = init.request.headers.get('content-type') ?? undefined;
    const result = await ingestChunk(ctx, init.params, drained.bytes, contentType);
    return toRawResponse(result);
  };
}

/** The `audio_input.upload_status` handler route (resume watermark). */
export function makeUploadStatusHandler(config: AudioHandlersConfig): RouteHandler {
  return async (init: RouteHandlerInit) => {
    const ctx = coreContext(init, config.resolved);
    return toHandlerReturn(await readUploadStatus(ctx, init.params));
  };
}

/** The `audio_input.finalize_track` handler route (seal + emit `session_finalized`). */
export function makeFinalizeHandler(config: AudioHandlersConfig): RouteHandler {
  return async (init: RouteHandlerInit) => {
    const ctx = coreContext(init, config.resolved);
    const body = (init.body ?? {}) as Record<string, unknown>;
    try {
      const result = await finalizeTrack(
        ctx,
        init.params,
        body.total_chunks,
        config.sessionFinalizedSink,
      );
      return toHandlerReturn(result);
    } catch (e) {
      // E2E-2: a sink's DELIBERATE fail-closed rejection (e.g. the workflow bridge's cross-tenant
      // assertion) is a clean 403 with the capability's stable {error, detail} taxonomy — not an
      // unhandled 500. The sink keeps THROWING (its fail-closed law is unchanged; nothing was
      // enqueued); this binding owns the status mapping (transport concern). The detail carries the
      // stable machine reason, never tenant ids. Any OTHER throw is a genuine fault → rethrow (500).
      if (e instanceof SessionEventRejectedError) {
        return httpResponse({
          status: 403,
          body: {
            error: 'session_event_rejected',
            detail: `the session_finalized event was rejected fail-closed (${e.reason}) — no workflow was started.`,
          },
        });
      }
      throw e;
    }
  };
}

/** The `media_playback.token` handler route (mint a media token for a playable, owned track). */
export function makePlayTokenMintHandler(config: AudioHandlersConfig): RouteHandler {
  return async (init: RouteHandlerInit) => {
    if (!init.mintPlayToken) {
      // Fail-closed loudly (like the pack): a mint route deployed without a media signing key would
      // otherwise be an unauthenticated token path.
      throw new AudioCapabilityWiringError(
        'media_playback.token: init.mintPlayToken is unavailable — the deployment wired no media ' +
          'signing key (RAYSPEC_MEDIA_SIGNING_KEY). Fail-closed.',
      );
    }
    const ctx = coreContext(init, config.resolved);
    const result = await mintPlaybackToken(ctx, init.params, init.mintPlayToken);
    if (!result.ok) return httpResponse({ status: result.status, body: errorBody(result) });
    const sessionId = init.params.session_id ?? '';
    const track = init.params.track ?? '';
    const url = config.buildPlaybackUrl(sessionId, track, result.value.token);
    const response: PlaybackTokenResult = {
      url,
      expires_at: result.value.expires_at,
      ttl_seconds: result.value.ttl_seconds,
    };
    return response;
  };
}

/** The `media_playback.stream` playback handler (Range/206/304/416, media-token second auth path). */
export function makeMediaStreamHandler(config: AudioHandlersConfig): StreamRouteHandler {
  return async (init: StreamRouteHandlerInit): Promise<Response> => {
    const ctx = blobContext(init, config.resolved);
    return streamMedia(ctx, init.params, init.request, init.mediaResource);
  };
}
