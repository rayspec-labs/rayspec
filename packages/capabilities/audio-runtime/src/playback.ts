/**
 * The playback/read contract core: mint a short-lived media token for a playable track,
 * and stream the playable media artifact with HTTP Range/206/416 + conditional-GET/304. Product-neutral:
 * the TTL policy (`max(900, ceil(duration)+60)` clamped 24h), the `409 not_ready` readiness boundary, the
 * resource-bound token, and the DB ownership re-validation are all enforced here; nothing names a product.
 */
import { type AudioCapabilityResult, err, ok } from './errors.js';
import { mediaArtifactKey } from './keys.js';
import {
  AUDIO_TRACKS_STORE,
  type AudioBlobContext,
  type AudioCoreContext,
  type MintPlayToken,
  type SessionTrackParams,
} from './ports.js';
import { validateSessionTrack } from './validate.js';

/** The core mint result the binding wraps into the public `PlaybackTokenResult` (adds the route URL). */
export interface MintTokenCore {
  readonly token: string;
  readonly ttl_seconds: number;
  readonly expires_at: string;
  /** The opaque resource the token is bound to (the playable artifact blob key). */
  readonly resource: string;
}

/**
 * Mint a media token for a playable track the caller OWNS. Fail-closed readiness: a track with no
 * registered playable artifact (`media_artifact_key` null) is `409 not_ready` (never mint against an
 * absent blob). TTL = `max(floor, ceil(duration)+slack)` clamped to the ceiling (config policy). The
 * caller's `mint` capability binds tenant + user; this supplies only the opaque resource + the TTL.
 */
export async function mintPlaybackToken(
  ctx: AudioCoreContext,
  params: SessionTrackParams,
  mint: MintPlayToken,
): Promise<AudioCapabilityResult<MintTokenCore>> {
  const target = validateSessionTrack(ctx.config, params);
  if (!target.ok) return target;
  const { session_id: sessionId, track } = target.value;

  // OWNERSHIP: the track must be owned by the caller's tenant (init.db is tenant-scoped). Absent/foreign
  // → 404 (no cross-tenant token).
  const rows = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
  const row = rows[0];
  if (!row) {
    return err(404, 'not_found', 'no such media.');
  }

  // READINESS: a playable artifact must be registered (its marker implies the blob exists). Until then,
  // 409 not_ready (a token minted now would point at an absent blob).
  const artifactKey = row.media_artifact_key;
  if (typeof artifactKey !== 'string' || artifactKey.length === 0) {
    return err(409, 'not_ready', 'the media is not ready for playback yet.');
  }

  const durationRaw = row.media_duration_seconds;
  const durationS =
    typeof durationRaw === 'number' && Number.isFinite(durationRaw) && durationRaw > 0
      ? durationRaw
      : 0;
  const { floorSeconds, slackSeconds, ceilingSeconds } = ctx.config.ttlPolicy;
  const ttlSeconds = Math.min(
    Math.max(floorSeconds, Math.ceil(durationS) + slackSeconds),
    ceilingSeconds,
  );

  // The resource is DERIVED (single-sourced), never read from the row, so a token always binds to the
  // key the stream handler re-derives.
  const resource = mediaArtifactKey(sessionId, track);
  const token = await mint({ resource, ttlSeconds });
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  return ok({ token, ttl_seconds: ttlSeconds, expires_at: expiresAt, resource });
}

/** A small JSON error `Response` (returned verbatim by the platform — no JSON envelope). */
function jsonError(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ error: code, detail }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A strong ETag derived from the blob's opaque `etagSource` (hashed via FNV-1a — never the raw source). */
function strongEtag(etagSource: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < etagSource.length; i++) {
    h ^= etagSource.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `"${h.toString(16).padStart(8, '0')}"`;
}

/** Parse a single `bytes=start-end` Range header. Returns [start,end], 'unsatisfiable', or null. */
function parseRange(
  header: string | null,
  len: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // a malformed/unsupported Range is IGNORED (RFC 7233 → serve the full 200).
  const startRaw = m[1] ?? '';
  const endRaw = m[2] ?? '';
  if (startRaw === '' && endRaw === '') return 'unsatisfiable'; // `bytes=-` is malformed.
  let start: number;
  let end: number;
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, len - suffix);
    end = len - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? len - 1 : Number(endRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return 'unsatisfiable';
  }
  if (start < 0 || start >= len || end < start) return 'unsatisfiable';
  if (end > len - 1) end = len - 1;
  return { start, end };
}

/**
 * Serve the playable media artifact for a track with Range/206/416 + conditional-GET/304, gated by the
 * media token's OPAQUE `resource` claim + a DB ownership re-validation. The claim is NEVER trusted
 * alone: (1) the token's resource MUST equal the artifact key this route addresses (no cross-resource
 * replay → 403), and (2) the track row MUST be visible under the token's tenant (a foreign recording is
 * invisible → 404, before a byte is served). A track with no playable artifact blob → 404.
 */
export async function streamMedia(
  ctx: AudioBlobContext,
  params: SessionTrackParams,
  request: Request,
  mediaResource: string | undefined,
): Promise<Response> {
  const target = validateSessionTrack(ctx.config, params);
  if (!target.ok) return jsonError(target.status, target.error, target.detail);
  const { session_id: sessionId, track } = target.value;
  const key = mediaArtifactKey(sessionId, track);

  // (1) BIND the token to the requested resource (no replay across resources). A missing claim is a
  // fail-closed 403 (never serve without the binding).
  if (mediaResource !== key) {
    return jsonError(403, 'forbidden', 'the media token does not authorize this resource.');
  }

  // (2) RE-VALIDATE OWNERSHIP in the DB (tenant-scoped by construction). Absent/foreign → 404.
  const rows = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
  const row = rows[0];
  if (!row) {
    return jsonError(404, 'not_found', 'no such media.');
  }

  const stat = await ctx.blob.stat(key);
  if ('notFound' in stat) {
    return jsonError(404, 'not_found', 'no such media.');
  }
  const len = stat.len;
  const etag = strongEtag(stat.etagSource);
  const contentType = stat.contentType ?? ctx.config.defaultMediaContentType;

  // Conditional-GET: If-None-Match → 304.
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch?.split(',').some((t) => t.trim() === etag)) {
    return new Response(null, { status: 304, headers: { etag, 'accept-ranges': 'bytes' } });
  }

  // If-Range mismatch → serve the FULL 200 (ignore the Range; the cached representation is stale).
  const ifRange = request.headers.get('if-range');
  const ifRangeMismatch = ifRange !== null && ifRange.trim() !== etag;
  const rangeHeader = ifRangeMismatch ? null : request.headers.get('range');
  const range = parseRange(rangeHeader, len);

  if (range === 'unsatisfiable') {
    return new Response(JSON.stringify({ error: 'range_not_satisfiable' }), {
      status: 416,
      headers: {
        'content-type': 'application/json',
        'content-range': `bytes */${len}`,
        'accept-ranges': 'bytes',
      },
    });
  }

  if (range) {
    const length = range.end - range.start + 1;
    const stream = await ctx.blob.createReadStream(key, { offset: range.start, length });
    if ('notFound' in stream) return jsonError(404, 'not_found', 'no such media.');
    return new Response(stream, {
      status: 206,
      headers: {
        'content-type': contentType,
        'content-length': String(length),
        'content-range': `bytes ${range.start}-${range.end}/${len}`,
        'accept-ranges': 'bytes',
        etag,
      },
    });
  }

  const stream = await ctx.blob.createReadStream(key);
  if ('notFound' in stream) return jsonError(404, 'not_found', 'no such media.');
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(len),
      'accept-ranges': 'bytes',
      etag,
    },
  });
}
