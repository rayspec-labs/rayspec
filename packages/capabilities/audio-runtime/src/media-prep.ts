/**
 * `prepareTrackMedia` — the Tier-B media-prep step that turns a
 * finalized track's raw Ogg-Opus chunks into ONE playable, seekable artifact and registers it via
 * `registerPlayableArtifact`, so `play-token` serves 200 with real audio after a real recording (until
 * then it honestly serves the declared `not_ready_409`).
 *
 * FAIL-CLOSED, NEVER A SILENT SUCCESS: a remux failure returns a typed `err` (500 `media_prep_failed`)
 * and NEVER registers the artifact — so the readiness marker never implies an absent/partial blob, and
 * play-token stays 409. Tenant-scoped (the injected `ctx.db`/`ctx.blob` are tenant-bound by
 * construction). IDEMPOTENT: `registerPlayableArtifact` is a put-by-key + marker-set, so a re-run
 * overwrites the same media blob + marker.
 *
 * The CALLER decides fail-soft: the composed product wraps this in `makeFailSoftMediaPrep`
 * (product-yaml compose.ts), which INSPECTS the typed result and LOGS loudly on `!ok` — an ffmpeg
 * failure (RemuxError → err(500 media_prep_failed)) is a RETURN, not a throw, so that hook (not the STT
 * node's try/catch) is what makes it operator-visible. It then swallows it so the failure does NOT
 * poison the STT/extraction path — the transcript + intelligence still complete, only playback stays
 * not-ready. The STT node's own try/catch is defense-in-depth for a genuine throw this returns.
 */
import { type AudioCapabilityResult, err } from './errors.js';
import { chunkKey } from './keys.js';
import { type PlayableArtifactRef, registerPlayableArtifact } from './media-artifact.js';
import { AUDIO_TRACKS_STORE, type AudioBlobContext, type SessionTrackParams } from './ports.js';
import { RemuxError, type RemuxResult, remuxChunks } from './remux.js';
import { validateSessionTrack } from './validate.js';

/** Read a Web `ReadableStream<Uint8Array>` fully into one `Uint8Array`. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Options for a media-prep run (the injectable remux is the unit-test seam; defaults to real ffmpeg). */
export interface PrepareTrackMediaOptions {
  /** The served content type for the playable artifact (default `audio/ogg`). */
  readonly contentType?: string;
  /** The remux implementation (default `remuxChunks` — real ffmpeg). Injected in unit tests. */
  readonly remux?: (chunks: readonly Uint8Array[]) => Promise<RemuxResult>;
}

/**
 * Prepare + register the playable media artifact for one finalized track: read its committed chunks
 * (0..persisted_chunk_count-1) from the tenant-bound blob store in index order, remux them into one
 * continuous Opus file, and register it. Returns the artifact ref on success, or a typed capability
 * error (404 no-track / 409 not-ready-no-chunks-or-missing-chunk / 500 media_prep_failed).
 */
export async function prepareTrackMedia(
  ctx: AudioBlobContext,
  params: SessionTrackParams,
  options: PrepareTrackMediaOptions = {},
): Promise<AudioCapabilityResult<PlayableArtifactRef>> {
  const target = validateSessionTrack(ctx.config, params);
  if (!target.ok) return target;
  const { session_id: sessionId, track } = target.value;

  const rows = await ctx.db.select(AUDIO_TRACKS_STORE, { session_id: sessionId, track });
  const row = rows[0];
  if (!row) {
    return err(404, 'not_found', 'no such track (never started under this tenant).');
  }
  const chunkCount = Number(row.persisted_chunk_count) || 0;
  if (chunkCount <= 0) {
    return err(409, 'not_ready', 'the track has no committed chunks to prepare.');
  }

  const chunks: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i += 1) {
    const read = await ctx.blob.get(chunkKey(sessionId, track, i));
    if ('notFound' in read) {
      return err(
        409,
        'not_ready',
        `chunk ${i} is missing from the blob store — cannot prepare media.`,
      );
    }
    chunks.push(await readAll(read.body));
  }

  const remux = options.remux ?? remuxChunks;
  let stitched: RemuxResult;
  try {
    stitched = await remux(chunks);
  } catch (e) {
    // Fail-closed: never register a partial/absent artifact — play-token stays not_ready.
    if (e instanceof RemuxError) {
      return err(500, 'media_prep_failed', `media prep failed (remux): ${e.message}`);
    }
    throw e;
  }

  try {
    return await registerPlayableArtifact(
      ctx,
      { session_id: sessionId, track },
      {
        bytes: stitched.bytes,
        contentType: options.contentType ?? 'audio/ogg',
        durationSeconds: stitched.durationS,
      },
    );
  } finally {
    await stitched.cleanup();
  }
}
