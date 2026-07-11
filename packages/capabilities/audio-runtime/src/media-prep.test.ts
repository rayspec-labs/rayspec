/**
 * `prepareTrackMedia` — unit proofs with a fake blob/db + an INJECTED remux (the real ffmpeg remux is
 * proven in remux.test.ts + the live smoke). Fail-the-fix: the injected remux asserts it received the
 * chunks in EXACT index order; a remux failure asserts NO artifact was registered (play-token stays
 * not-ready) — the never-a-silent-success invariant.
 */
import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { chunkKey } from './keys.js';
import { prepareTrackMedia } from './media-prep.js';
import { AUDIO_TRACKS_STORE, type AudioBlobContext } from './ports.js';
import { RemuxError, type RemuxResult } from './remux.js';
import { FakeBlobStore, FakeHandlerDb } from './test-support/fakes.js';

const TENANT = 'tenant-a';
const SESSION = 's1';
const TRACK = 'mic';

async function seededCtx(
  chunkCount: number,
  opts: { seedChunks?: number } = {},
): Promise<{
  ctx: AudioBlobContext;
  db: FakeHandlerDb;
  blob: FakeBlobStore;
}> {
  const db = new FakeHandlerDb();
  await db.insert(AUDIO_TRACKS_STORE, {
    session_pk: '00000000-0000-4000-8000-000000000001',
    session_id: SESSION,
    track: TRACK,
    status: 'completed',
    storage_key_prefix: `${SESSION}/${TRACK}`,
    persisted_chunk_count: chunkCount,
    committed_byte_len: 6,
    track_ref: `${TENANT}:${SESSION}:${TRACK}`,
  });
  const blob = new FakeBlobStore();
  const toSeed = opts.seedChunks ?? chunkCount;
  for (let i = 0; i < toSeed; i += 1) {
    await blob.put(chunkKey(SESSION, TRACK, i), new Uint8Array([i, i + 1]));
  }
  const ctx: AudioBlobContext = { tenantId: TENANT, db, config: resolveConfig(), blob };
  return { ctx, db, blob };
}

const okRemux =
  (received: Uint8Array[][]) =>
  async (chunks: readonly Uint8Array[]): Promise<RemuxResult> => {
    received.push(chunks.map((c) => new Uint8Array(c)));
    return {
      bytes: new TextEncoder().encode('STITCHED-OPUS'),
      outPath: '/tmp/x',
      durationS: 12.5,
      cleanup: async () => {},
    };
  };

describe('prepareTrackMedia', () => {
  it('gathers chunks in EXACT index order, remuxes, and registers the playable artifact (200)', async () => {
    const { ctx, db, blob } = await seededCtx(3);
    const received: Uint8Array[][] = [];
    const result = await prepareTrackMedia(
      ctx,
      { session_id: SESSION, track: TRACK },
      { remux: okRemux(received) },
    );
    expect(result.ok).toBe(true);
    // fail-the-fix: the chunks reached the remux in index order 0,1,2.
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([
      new Uint8Array([0, 1]),
      new Uint8Array([1, 2]),
      new Uint8Array([2, 3]),
    ]);
    // the readiness marker is set + the media blob exists (a non-null key implies a real blob).
    const rows = await db.select(AUDIO_TRACKS_STORE, { session_id: SESSION, track: TRACK });
    const key = rows[0]?.media_artifact_key as string;
    expect(key).toBe(`${SESSION}/${TRACK}/media`);
    expect(rows[0]?.media_duration_seconds).toBe(13); // ceil(12.5)
    expect(blob.peek(key)).toEqual(new TextEncoder().encode('STITCHED-OPUS'));
  });

  it('is IDEMPOTENT — a second prep overwrites the same media key + marker, no error', async () => {
    const { ctx, db } = await seededCtx(2);
    const r1 = await prepareTrackMedia(
      ctx,
      { session_id: SESSION, track: TRACK },
      { remux: okRemux([]) },
    );
    const r2 = await prepareTrackMedia(
      ctx,
      { session_id: SESSION, track: TRACK },
      { remux: okRemux([]) },
    );
    expect(r1.ok && r2.ok).toBe(true);
    const rows = await db.select(AUDIO_TRACKS_STORE, { session_id: SESSION, track: TRACK });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.media_artifact_key).toBe(`${SESSION}/${TRACK}/media`);
  });

  it('NEVER registers on a remux failure — 500 media_prep_failed, marker stays null (play-token 409)', async () => {
    const { ctx, db, blob } = await seededCtx(2);
    const failing = async () => {
      throw new RemuxError('ffmpeg exited 1');
    };
    const result = await prepareTrackMedia(
      ctx,
      { session_id: SESSION, track: TRACK },
      { remux: failing },
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(500);
    expect(result.ok === false && result.error).toBe('media_prep_failed');
    const rows = await db.select(AUDIO_TRACKS_STORE, { session_id: SESSION, track: TRACK });
    expect(rows[0]?.media_artifact_key ?? null).toBeNull(); // never a silent success
    expect(blob.peek(`${SESSION}/${TRACK}/media`)).toBeUndefined();
  });

  it('404 for a track that never started under this tenant', async () => {
    const { ctx } = await seededCtx(2);
    const result = await prepareTrackMedia(
      ctx,
      { session_id: 'nope', track: TRACK },
      { remux: okRemux([]) },
    );
    expect(result.ok === false && result.status).toBe(404);
  });

  it('409 not-ready when the track has no committed chunks', async () => {
    const { ctx } = await seededCtx(0);
    const result = await prepareTrackMedia(
      ctx,
      { session_id: SESSION, track: TRACK },
      { remux: okRemux([]) },
    );
    expect(result.ok === false && result.status).toBe(409);
  });

  it('409 not-ready when a committed chunk is missing from the blob store', async () => {
    const { ctx } = await seededCtx(3, { seedChunks: 2 }); // count says 3, only 2 blobs exist
    const result = await prepareTrackMedia(
      ctx,
      { session_id: SESSION, track: TRACK },
      { remux: okRemux([]) },
    );
    expect(result.ok === false && result.status).toBe(409);
  });
});
