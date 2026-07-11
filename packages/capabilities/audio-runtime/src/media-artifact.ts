/**
 * The playable-media-artifact seam. Playback serves a SINGLE contiguous, seekable
 * media blob (the "remux/playable artifact"), NOT the raw upload chunks. Producing that artifact from
 * the raw chunks is a media-prep step: in the full stack it is STT preprocessing run as a
 * workflow node; in tests it is the deterministic fake media adapter. Either way it calls
 * `registerPlayableArtifact` to attach the artifact to the track. This capability owns the artifact's
 * blob key + the readiness marker; it does NOT own how the bytes were produced.
 *
 * READINESS INVARIANT: the marker (`media_artifact_key` non-null on the track row) is set AFTER the blob
 * is durably written, so a non-null key IMPLIES the blob exists — a play-token minted off it never points
 * at an absent blob (the readiness guarantee, achieved here without a separate transcript store).
 */
import { type AudioCapabilityResult, err, ok } from './errors.js';
import { mediaArtifactKey } from './keys.js';
import { AUDIO_TRACKS_STORE, type AudioBlobContext, type SessionTrackParams } from './ports.js';
import { validateSessionTrack } from './validate.js';

/** The playable artifact bytes + metadata a media-prep step registers for a track. */
export interface PlayableArtifactInput {
  readonly bytes: Uint8Array;
  /** The served content type (e.g. `audio/ogg`). Advisory. */
  readonly contentType?: string;
  /** The media duration in seconds (sizes the playback-token TTL). Non-finite/negative → 0. */
  readonly durationSeconds?: number;
}

/** The recorded artifact reference returned after registration. */
export interface PlayableArtifactRef {
  readonly session_id: string;
  readonly track: string;
  readonly media_artifact_key: string;
  readonly media_duration_seconds: number;
}

/**
 * Attach a playable media artifact to an existing track: write the contiguous blob, then set the
 * readiness marker (`media_artifact_key`/`media_content_type`/`media_duration_seconds`) on the track
 * row. Blob write is FIRST so the marker never implies an absent blob. The track must exist under this
 * tenant (a foreign/absent track is a 404 — no cross-tenant artifact attach).
 */
export async function registerPlayableArtifact(
  ctx: AudioBlobContext,
  params: SessionTrackParams,
  input: PlayableArtifactInput,
): Promise<AudioCapabilityResult<PlayableArtifactRef>> {
  const target = validateSessionTrack(ctx.config, params);
  if (!target.ok) return target;
  const { session_id: sessionId, track } = target.value;

  const rows = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
  const row = rows[0];
  if (!row) {
    return err(404, 'not_found', 'no such track (never started under this tenant).');
  }

  const key = mediaArtifactKey(sessionId, track);
  const contentType = input.contentType;
  const durationRaw = input.durationSeconds;
  const durationSeconds =
    typeof durationRaw === 'number' && Number.isFinite(durationRaw) && durationRaw > 0
      ? Math.ceil(durationRaw)
      : 0;

  // Write the playable blob FIRST (idempotent put-by-key), then set the readiness marker.
  await ctx.blob.put(key, input.bytes, contentType ? { contentType } : undefined);
  await ctx.db.update(
    AUDIO_TRACKS_STORE,
    { session_id: sessionId, track },
    {
      media_artifact_key: key,
      ...(contentType ? { media_content_type: contentType } : {}),
      media_duration_seconds: durationSeconds,
    },
  );

  return ok({
    session_id: sessionId,
    track,
    media_artifact_key: key,
    media_duration_seconds: durationSeconds,
  });
}
