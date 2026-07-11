/**
 * The deterministic FAKE media adapter — the CI path to a playable artifact WITHOUT real
 * audio, ffmpeg, or a provider. It stands in for the real media-prep step (STT preprocessing / remux in
 * the full stack): it reads a track's durably-uploaded raw chunks in index order, concatenates them into
 * one contiguous "playable" blob, derives a deterministic duration from the byte length, and registers it
 * as the track's playable artifact. Everything is deterministic + tiny (no large binaries committed).
 *
 * This is a TEST/DEV utility that lives in the neutral core so the capability's playback path is provable
 * end-to-end in CI. It is NOT a production media pipeline.
 */
import { type AudioCapabilityResult, err } from './errors.js';
import { chunkKey } from './keys.js';
import { type PlayableArtifactRef, registerPlayableArtifact } from './media-artifact.js';
import { AUDIO_TRACKS_STORE, type AudioBlobContext, type SessionTrackParams } from './ports.js';

export interface FakeMediaAdapterConfig {
  /** Bytes-per-second used to derive a deterministic duration from the artifact length (default 1000). */
  readonly bytesPerSecond?: number;
  /** The content type registered for the playable artifact (default `audio/ogg`). */
  readonly contentType?: string;
}

/** Generate a deterministic synthetic chunk's bytes (for a test to upload). Pure — no randomness. */
export function syntheticAudioChunk(index: number, size = 8): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    // A stable, index-seeded byte pattern (distinct per (index, position); never all-zero).
    out[i] = (index * 31 + i * 7 + 1) & 0xff;
  }
  return out;
}

/** Read one blob fully into a Uint8Array; undefined if absent. */
async function readBlob(ctx: AudioBlobContext, key: string): Promise<Uint8Array | undefined> {
  const got = await ctx.blob.get(key);
  if ('notFound' in got) return undefined;
  const buf = await new Response(got.body).arrayBuffer();
  return new Uint8Array(buf);
}

export class FakeMediaAdapter {
  private readonly bytesPerSecond: number;
  private readonly contentType: string;

  constructor(config: FakeMediaAdapterConfig = {}) {
    this.bytesPerSecond = config.bytesPerSecond ?? 1000;
    this.contentType = config.contentType ?? 'audio/ogg';
  }

  /**
   * Concatenate a track's durably-uploaded chunks (0..count-1) into one contiguous playable blob and
   * register it as the track's playable artifact. Returns the registration result (404 if the track was
   * never started under this tenant). Deterministic: the playable bytes ARE the uploaded bytes in order,
   * and the duration is `max(1, round(totalBytes / bytesPerSecond))` (or 0 for an empty track).
   */
  async prepareTrackForPlayback(
    ctx: AudioBlobContext,
    params: SessionTrackParams,
  ): Promise<AudioCapabilityResult<PlayableArtifactRef>> {
    const sessionId = params.session_id;
    const track = params.track;
    if (!sessionId || !track) {
      return err(400, 'bad_request', 'session_id and track are required.');
    }
    const rows = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
    const row = rows[0];
    if (!row) {
      return err(404, 'not_found', 'no such track (never started under this tenant).');
    }
    const count = Number(row.persisted_chunk_count) || 0;

    const parts: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const bytes = await readBlob(ctx, chunkKey(sessionId, track, i));
      if (bytes) {
        parts.push(bytes);
        total += bytes.length;
      }
    }
    const playable = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      playable.set(part, offset);
      offset += part.length;
    }

    const durationSeconds = total > 0 ? Math.max(1, Math.round(total / this.bytesPerSecond)) : 0;
    return registerPlayableArtifact(ctx, params, {
      bytes: playable,
      contentType: this.contentType,
      durationSeconds,
    });
  }
}

/** Build the deterministic fake media adapter (the CI default). */
export function createFakeMediaAdapter(config?: FakeMediaAdapterConfig): FakeMediaAdapter {
  return new FakeMediaAdapter(config);
}
