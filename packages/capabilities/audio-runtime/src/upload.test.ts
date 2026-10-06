import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { createInMemorySessionFinalizedSink } from './events.js';
import { finalizedEventId, trackRef } from './keys.js';
import type { AudioBlobContext } from './ports.js';
import { FakeBlobStore, FakeHandlerDb } from './test-support/fakes.js';
import { finalizeTrack, ingestChunk, readUploadStatus } from './upload.js';

const TENANT = 'tenant-A';

function ctx(): AudioBlobContext {
  return {
    tenantId: TENANT,
    db: new FakeHandlerDb(),
    blob: new FakeBlobStore(),
    config: resolveConfig({ allowedTracks: ['mic', 'system'] }),
  };
}

async function ingest(
  c: AudioBlobContext,
  session: string,
  track: string,
  index: number,
  bytes: Uint8Array,
) {
  return ingestChunk(c, { session_id: session, track, chunk_index: String(index) }, bytes);
}

async function sessionStatus(c: AudioBlobContext, session: string): Promise<unknown> {
  const rows = await c.db.select('audio_sessions', { session_id: session });
  return rows[0]?.status;
}

/** Every session row and every track row the capability holds, as `id:status` / `session/track:status`. */
async function rowsHeld(c: AudioBlobContext): Promise<{ sessions: string[]; tracks: string[] }> {
  const sessions = await c.db.select('audio_sessions');
  const tracks = await c.db.select('audio_tracks');
  return {
    sessions: sessions.map((s) => `${s.session_id}:${s.status}`),
    tracks: tracks.map((t) => `${t.session_id}/${t.track}:${t.status}:${t.persisted_chunk_count}`),
  };
}

/** A blob store whose every put fails (a storage outage on the chunk write). */
class FailingPutBlobStore extends FakeBlobStore {
  override async put(): Promise<void> {
    throw new Error('blob store unavailable');
  }
}

describe('ingestChunk — the idempotent watermark contract', () => {
  it('advances the watermark on an in-order chunk (200 ack next+1)', async () => {
    const c = ctx();
    const r0 = await ingest(c, 's1', 'mic', 0, new Uint8Array([1, 2]));
    expect(r0).toEqual({ ok: true, value: { next_expected_index: 1 } });
    const r1 = await ingest(c, 's1', 'mic', 1, new Uint8Array([3, 4, 5]));
    expect(r1).toEqual({ ok: true, value: { next_expected_index: 2 } });
    // committed byte length accrues.
    const status = await readUploadStatus(c, { session_id: 's1', track: 'mic' });
    expect(status.ok && status.value.committed_byte_len).toBe(5);
    expect(status.ok && status.value.next_expected_index).toBe(2);
  });

  it('a gap index → 409 gap with the resume watermark', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    const r = await ingest(c, 's1', 'mic', 2, new Uint8Array([9]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toBe('gap');
      expect(r.next_expected_index).toBe(1);
    }
  });

  it('a duplicate (index < watermark) → 200 no-op, no double count', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    await ingest(c, 's1', 'mic', 1, new Uint8Array([2]));
    const dup = await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    expect(dup).toEqual({ ok: true, value: { next_expected_index: 2 } });
    const status = await readUploadStatus(c, { session_id: 's1', track: 'mic' });
    expect(status.ok && status.value.next_expected_index).toBe(2);
  });

  it('validates session_id and track (400)', async () => {
    const c = ctx();
    const badSession = await ingest(c, 'bad id!', 'mic', 0, new Uint8Array([1]));
    expect(!badSession.ok && badSession.status).toBe(400);
    const badTrack = await ingest(c, 's1', 'nope', 0, new Uint8Array([1]));
    expect(!badTrack.ok && badTrack.status).toBe(400);
    const badIndex = await ingestChunk(
      c,
      { session_id: 's1', track: 'mic', chunk_index: '-1' },
      new Uint8Array([1]),
    );
    expect(!badIndex.ok && badIndex.status).toBe(400);
  });
});

describe('ingestChunk — the per-track cumulative byte cap (cost-DoS bound)', () => {
  /** A ctx with a tiny per-track cap so the cumulative bound is exercised without huge fixtures. */
  function cappedCtx(maxTrackBytes: number): AudioBlobContext {
    return {
      tenantId: TENANT,
      db: new FakeHandlerDb(),
      blob: new FakeBlobStore(),
      config: resolveConfig({ allowedTracks: ['mic', 'system'], maxTrackBytes }),
    };
  }

  it('rejects the chunk that would push a track past its cumulative cap (413) and does NOT advance', async () => {
    const c = cappedCtx(5);
    // 3 bytes committed (under 5).
    const r0 = await ingest(c, 's1', 'mic', 0, new Uint8Array([1, 2, 3]));
    expect(r0).toEqual({ ok: true, value: { next_expected_index: 1 } });
    // The next 3-byte chunk would make committed = 6 > 5 → 413, rejected pre-store.
    const over = await ingest(c, 's1', 'mic', 1, new Uint8Array([4, 5, 6]));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.status).toBe(413);
    // The watermark stayed at 1 and the committed total did not grow (the chunk was not stored).
    const status = await readUploadStatus(c, { session_id: 's1', track: 'mic' });
    expect(status.ok && status.value.next_expected_index).toBe(1);
    expect(status.ok && status.value.committed_byte_len).toBe(3);
  });

  it('accepts a chunk that lands EXACTLY on the cap (boundary)', async () => {
    const c = cappedCtx(5);
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1, 2, 3]));
    const onCap = await ingest(c, 's1', 'mic', 1, new Uint8Array([4, 5]));
    expect(onCap).toEqual({ ok: true, value: { next_expected_index: 2 } });
    const status = await readUploadStatus(c, { session_id: 's1', track: 'mic' });
    expect(status.ok && status.value.committed_byte_len).toBe(5);
  });
});

describe('ingestChunk — a rejected chunk creates nothing', () => {
  /** A ctx with one sealed `mic` track, so the session `s1` is `completed`. */
  async function completedSessionCtx(maxTrackBytes?: number): Promise<AudioBlobContext> {
    const c: AudioBlobContext = {
      ...ctx(),
      config: resolveConfig({
        allowedTracks: ['mic', 'system'],
        ...(maxTrackBytes !== undefined ? { maxTrackBytes } : {}),
      }),
    };
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    await finalizeTrack(
      c,
      { session_id: 's1', track: 'mic' },
      1,
      createInMemorySessionFinalizedSink(),
    );
    return c;
  }

  it('a gap on a session that does not exist → 409 at index 0, no session row, no track row, no blob', async () => {
    const c = ctx();
    const r = await ingest(c, 'new', 'mic', 3, new Uint8Array([9]));
    expect(r).toMatchObject({ ok: false, status: 409, error: 'gap', next_expected_index: 0 });
    expect(await rowsHeld(c)).toEqual({ sessions: [], tracks: [] });
    expect((c.blob as FakeBlobStore).peek('new/mic/chunk_3')).toBeUndefined();
    // The upload-status of the rejected track still reads as never started.
    const status = await readUploadStatus(c, { session_id: 'new', track: 'mic' });
    expect(status.ok && status.value.status).toBe('absent');
  });

  it('a gap on a new track of a recording session → 409 at index 0, no track row', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    const r = await ingest(c, 's1', 'system', 2, new Uint8Array([9]));
    expect(r).toMatchObject({ ok: false, status: 409, error: 'gap', next_expected_index: 0 });
    expect(await rowsHeld(c)).toEqual({
      sessions: ['s1:recording'],
      tracks: ['s1/mic:recording:1'],
    });
  });

  it('a gap on a new track of a completed session leaves it completed, no track row', async () => {
    const c = await completedSessionCtx();
    const r = await ingest(c, 's1', 'system', 3, new Uint8Array([9]));
    expect(r).toMatchObject({ ok: false, status: 409, error: 'gap', next_expected_index: 0 });
    expect(await rowsHeld(c)).toEqual({
      sessions: ['s1:completed'],
      tracks: ['s1/mic:completed:1'],
    });
  });

  it('a first chunk over the per-track cap on a session that does not exist → 413, nothing created', async () => {
    const c: AudioBlobContext = {
      ...ctx(),
      config: resolveConfig({ allowedTracks: ['mic', 'system'], maxTrackBytes: 2 }),
    };
    const r = await ingest(c, 'new', 'mic', 0, new Uint8Array([1, 2, 3]));
    expect(r).toMatchObject({
      ok: false,
      status: 413,
      error: 'track_too_large',
      next_expected_index: 0,
    });
    expect(await rowsHeld(c)).toEqual({ sessions: [], tracks: [] });
    expect((c.blob as FakeBlobStore).peek('new/mic/chunk_0')).toBeUndefined();
  });

  it('a first chunk over the per-track cap on a new track of a completed session leaves it completed', async () => {
    const c = await completedSessionCtx(2);
    const r = await ingest(c, 's1', 'system', 0, new Uint8Array([1, 2, 3]));
    expect(r).toMatchObject({ ok: false, status: 413, error: 'track_too_large' });
    expect(await rowsHeld(c)).toEqual({
      sessions: ['s1:completed'],
      tracks: ['s1/mic:completed:1'],
    });
  });

  it('a malformed session id, track or chunk index → 400, nothing created', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    const before = await rowsHeld(c);
    const rejected = [
      await ingest(c, 'bad id!', 'mic', 0, new Uint8Array([1])),
      await ingest(c, '..', 'mic', 0, new Uint8Array([1])),
      await ingest(c, 's2', 'nope', 0, new Uint8Array([1])),
      await ingest(c, 's1', 'nope', 0, new Uint8Array([1])),
      await ingestChunk(c, { session_id: 's2', track: 'mic' }, new Uint8Array([1])),
      await ingestChunk(
        c,
        { session_id: 's2', track: 'mic', chunk_index: '-1' },
        new Uint8Array([1]),
      ),
      await ingestChunk(
        c,
        { session_id: 's1', track: 'system', chunk_index: '1.5' },
        new Uint8Array([1]),
      ),
    ];
    for (const r of rejected) expect(r).toMatchObject({ ok: false, status: 400 });
    expect(await rowsHeld(c)).toEqual(before);
  });

  it('a blob write that fails on a first chunk leaves no session row and no track row', async () => {
    const c: AudioBlobContext = { ...ctx(), blob: new FailingPutBlobStore() };
    await expect(ingest(c, 'new', 'mic', 0, new Uint8Array([1]))).rejects.toThrow(
      'blob store unavailable',
    );
    expect(await rowsHeld(c)).toEqual({ sessions: [], tracks: [] });
  });

  it('a blob write that fails on the first chunk of a new track leaves a completed session completed', async () => {
    const c = await completedSessionCtx();
    const failing: AudioBlobContext = { ...c, blob: new FailingPutBlobStore() };
    await expect(ingest(failing, 's1', 'system', 0, new Uint8Array([2]))).rejects.toThrow(
      'blob store unavailable',
    );
    expect(await rowsHeld(c)).toEqual({
      sessions: ['s1:completed'],
      tracks: ['s1/mic:completed:1'],
    });
  });

  it('an accepted first chunk still creates the session row and the track row', async () => {
    const c = ctx();
    const r = await ingest(c, 'new', 'mic', 0, new Uint8Array([1, 2]));
    expect(r).toEqual({ ok: true, value: { next_expected_index: 1 } });
    expect(await rowsHeld(c)).toEqual({
      sessions: ['new:recording'],
      tracks: ['new/mic:recording:1'],
    });
    expect((c.blob as FakeBlobStore).peek('new/mic/chunk_0')).toEqual(new Uint8Array([1, 2]));
  });

  it('a first chunk that loses the session-row race re-reads the winner and is stored', async () => {
    let armed = true;
    const db = new FakeHandlerDb({
      hooks: {
        // A concurrent first chunk of another track commits the session row in the window between
        // this request's session read and its own session insert.
        beforeInsert: async (store) => {
          if (armed && store === 'audio_sessions') {
            armed = false;
            await db.insert('audio_sessions', {
              session_id: 's1',
              session_ref: `${TENANT}:s1`,
              status: 'recording',
              protocol_version: 1,
            });
          }
        },
      },
    });
    const c: AudioBlobContext = { ...ctx(), db };
    const r = await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    expect(r).toEqual({ ok: true, value: { next_expected_index: 1 } });
    expect(await rowsHeld(c)).toEqual({
      sessions: ['s1:recording'],
      tracks: ['s1/mic:recording:1'],
    });
  });

  it('a first chunk that loses the track-row race is a no-op at the winner’s watermark and does not reopen the session', async () => {
    let armed = false;
    const db = new FakeHandlerDb({
      hooks: {
        // The winner of a concurrent first chunk for the same (session, track) has stored chunk 0 and
        // been finalized by the time this request's own track insert lands.
        beforeInsert: async (store, values) => {
          if (armed && store === 'audio_tracks') {
            armed = false;
            await db.insert('audio_tracks', {
              ...values,
              status: 'completed',
              persisted_chunk_count: 1,
              committed_byte_len: 1,
            });
          }
        },
      },
    });
    const c: AudioBlobContext = { ...ctx(), db };
    // `system` is sealed, so the session is completed before the `mic` first chunk arrives.
    await ingest(c, 's1', 'system', 0, new Uint8Array([7]));
    await finalizeTrack(
      c,
      { session_id: 's1', track: 'system' },
      1,
      createInMemorySessionFinalizedSink(),
    );
    armed = true;
    const r = await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    expect(r).toEqual({ ok: true, value: { next_expected_index: 1 } });
    // Every track is sealed, so the losing request must not have put the session back to recording.
    expect(await rowsHeld(c)).toEqual({
      sessions: ['s1:completed'],
      tracks: ['s1/system:completed:1', 's1/mic:completed:1'],
    });
  });

  it('a first chunk that waited on the session lock for the winner takes the winner’s track row and inserts none', async () => {
    let armed = false;
    let winnerLanded = false;
    let ownTrackInserts = 0;
    const db = new FakeHandlerDb({
      hooks: {
        // The winner of a concurrent first chunk for the same (session, track) held the session lock
        // first: by the time this request's own lock statement returns, the winner has stored chunk 0
        // and been finalized.
        beforeUpdate: async (store, _filter, patch) => {
          if (armed && store === 'audio_sessions' && !('status' in patch)) {
            armed = false;
            const [session] = await db.select('audio_sessions', { session_id: 's1' });
            await db.insert('audio_tracks', {
              session_pk: session?.id,
              session_id: 's1',
              track: 'mic',
              track_ref: trackRef(TENANT, 's1', 'mic'),
              status: 'completed',
              persisted_chunk_count: 1,
              committed_byte_len: 1,
            });
            winnerLanded = true;
          }
        },
        beforeInsert: (store) => {
          if (winnerLanded && store === 'audio_tracks') ownTrackInserts++;
        },
      },
    });
    const c: AudioBlobContext = { ...ctx(), db };
    // `system` is sealed, so the session is completed before the `mic` first chunk arrives.
    await ingest(c, 's1', 'system', 0, new Uint8Array([7]));
    await finalizeTrack(
      c,
      { session_id: 's1', track: 'system' },
      1,
      createInMemorySessionFinalizedSink(),
    );
    armed = true;
    const r = await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    expect(r).toEqual({ ok: true, value: { next_expected_index: 1 } });
    // The track read under the lock found the winner's row: no insert of its own, no collision.
    expect(winnerLanded).toBe(true);
    expect(ownTrackInserts).toBe(0);
    // Every track is sealed, so the waiting request must not have put the session back to recording.
    expect(await rowsHeld(c)).toEqual({
      sessions: ['s1:completed'],
      tracks: ['s1/system:completed:1', 's1/mic:completed:1'],
    });
  });
});

describe('readUploadStatus', () => {
  it('an absent track → 200 fresh-start shape (status absent, index 0), not a 404', async () => {
    const c = ctx();
    const r = await readUploadStatus(c, { session_id: 'never', track: 'mic' });
    expect(r).toEqual({
      ok: true,
      value: {
        session_id: 'never',
        track: 'mic',
        next_expected_index: 0,
        committed_byte_len: 0,
        status: 'absent',
      },
    });
  });
});

describe('finalizeTrack — count gate + idempotency + single-flight event', () => {
  it('a count mismatch → 409 chunk_count_mismatch with the watermark', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    const sink = createInMemorySessionFinalizedSink();
    const r = await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 5, sink);
    expect(!r.ok && r.status).toBe(409);
    expect(!r.ok && r.error).toBe('chunk_count_mismatch');
    expect(!r.ok && r.next_expected_index).toBe(1);
    expect(sink.emitCount()).toBe(0); // no event on a mismatch
  });

  it('finalizing a never-started track → 404', async () => {
    const c = ctx();
    const sink = createInMemorySessionFinalizedSink();
    const r = await finalizeTrack(c, { session_id: 'nope', track: 'mic' }, 0, sink);
    expect(!r.ok && r.status).toBe(404);
  });

  it('a matching finalize seals the track and emits session_finalized', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1, 2]));
    const sink = createInMemorySessionFinalizedSink();
    const r = await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('completed');
      expect(r.value.total_chunks).toBe(1);
      expect(r.value.finalized_event_id).toBe(finalizedEventId(TENANT, 's1'));
    }
    const ev = sink.deliveredFor(finalizedEventId(TENANT, 's1'));
    expect(ev?.source_capability).toBe('audio_input');
    expect(ev?.session_id).toBe('s1');
    expect(ev?.tenant_id).toBe(TENANT);
    // a completed track appears in the finalized-track summaries.
    expect(ev?.tracks.map((t) => t.track)).toContain('mic');
  });

  it('re-finalizing a completed track is idempotent (200) and re-emits the deduped event', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    const sink = createInMemorySessionFinalizedSink();
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    const again = await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    expect(again.ok).toBe(true);
    expect(sink.emitCount()).toBe(2); // emitted on both seal paths
    expect(sink.deliveredCount()).toBe(1); // ... but deduped to one workflow (session-scoped)
  });

  it('DUAL-TRACK finalize converges on EXACTLY ONE session-scoped event (the single-run invariant)', async () => {
    // RED-FIRST: if finalize keyed the event per-track (`${tenant}:${session}:${track}`), the sink would
    // deliver TWO distinct events and deliveredCount would be 2. Asserting 1 proves the session-scoped key.
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    await ingest(c, 's1', 'system', 0, new Uint8Array([2]));
    const sink = createInMemorySessionFinalizedSink();
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    await finalizeTrack(c, { session_id: 's1', track: 'system' }, 1, sink);
    expect(sink.emitCount()).toBe(2);
    expect(sink.deliveredCount()).toBe(1);
    expect(sink.delivered()[0]?.event_id).toBe(finalizedEventId(TENANT, 's1'));
  });

  it('sealing the only track marks the session completed', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    expect(await sessionStatus(c, 's1')).toBe('recording');
    await finalizeTrack(
      c,
      { session_id: 's1', track: 'mic' },
      1,
      createInMemorySessionFinalizedSink(),
    );
    expect(await sessionStatus(c, 's1')).toBe('completed');
  });

  it('a dual-track session stays recording until its LAST track is sealed', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    await ingest(c, 's1', 'system', 0, new Uint8Array([2]));
    const sink = createInMemorySessionFinalizedSink();
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    expect(await sessionStatus(c, 's1')).toBe('recording');
    await finalizeTrack(c, { session_id: 's1', track: 'system' }, 1, sink);
    expect(await sessionStatus(c, 's1')).toBe('completed');
  });

  it('re-finalizing settles a session an earlier release left at recording', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    const sink = createInMemorySessionFinalizedSink();
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    // A session an earlier release finalized: the track sealed, the session row never moved.
    await c.db.update('audio_sessions', { session_id: 's1' }, { status: 'recording' });
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    expect(await sessionStatus(c, 's1')).toBe('completed');
  });

  it('a track that starts on a completed session reopens it until that track is sealed', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    const sink = createInMemorySessionFinalizedSink();
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    expect(await sessionStatus(c, 's1')).toBe('completed');
    await ingest(c, 's1', 'system', 0, new Uint8Array([2]));
    expect(await sessionStatus(c, 's1')).toBe('recording');
    await finalizeTrack(c, { session_id: 's1', track: 'system' }, 1, sink);
    expect(await sessionStatus(c, 's1')).toBe('completed');
  });

  it('a re-finalize with the wrong total leaves the session status untouched', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    const sink = createInMemorySessionFinalizedSink();
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    // The state an earlier release left behind: the track sealed, the session still `recording`.
    await c.db.update('audio_sessions', { session_id: 's1' }, { status: 'recording' });
    const wrong = await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 7, sink);
    expect(!wrong.ok && wrong.error).toBe('chunk_count_mismatch');
    expect(await sessionStatus(c, 's1')).toBe('recording');
  });

  it('re-finalizing a sealed track while a sibling is still open keeps the session recording', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    await ingest(c, 's1', 'system', 0, new Uint8Array([2]));
    const sink = createInMemorySessionFinalizedSink();
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    expect(await sessionStatus(c, 's1')).toBe('recording');
  });

  it('a late chunk on a sealed track does not reopen a completed session', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    const sink = createInMemorySessionFinalizedSink();
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    await ingest(c, 's1', 'mic', 4, new Uint8Array([9]));
    expect(await sessionStatus(c, 's1')).toBe('completed');
  });

  it('a sealed track no-ops a late chunk retry (200, no advance)', async () => {
    const c = ctx();
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    const sink = createInMemorySessionFinalizedSink();
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 1, sink);
    const late = await ingest(c, 's1', 'mic', 5, new Uint8Array([9]));
    expect(late).toEqual({ ok: true, value: { next_expected_index: 1 } });
  });

  it('CI-2: a finalize sealing BETWEEN the advance re-read and write cannot be raced past the seal', async () => {
    // The narrow race: chunk N reads status='recording', then a concurrent finalize(total=N) commits
    // 'completed', then the chunk's advance would still push persisted_chunk_count to N+1 — leaving a
    // completed track with a watermark PAST its sealed total. The atomic status='recording' guard on the
    // advance UPDATE must refuse it (post-seal no-op at the sealed watermark).
    //
    // RED-FIRST: with the pre-fix advance (WHERE {session_id, track}, no seal guard) this asserts a
    // next_expected_index of 2 and a watermark of 2 (past the sealed total 1) — the bug. The fix makes
    // the advance a no-op at the sealed watermark 1.
    // Armed only for chunk 1's advance (NOT chunk 0's) so the seal races the exact advance under test.
    let armed = false;
    const db = new FakeHandlerDb({
      hooks: {
        // Fire ONCE, on the advance UPDATE (its patch carries persisted_chunk_count), simulating a
        // concurrent finalize that seals the track in the window before the guarded write lands.
        beforeUpdate: async (store, _filter, patch) => {
          if (armed && store === 'audio_tracks' && 'persisted_chunk_count' in patch) {
            armed = false;
            await db.update(
              'audio_tracks',
              { session_id: 's1', track: 'mic' },
              { status: 'completed' },
            );
          }
        },
      },
    });
    const c: AudioBlobContext = {
      tenantId: TENANT,
      db,
      blob: new FakeBlobStore(),
      config: resolveConfig({ allowedTracks: ['mic', 'system'] }),
    };
    // watermark → 1 (chunk 0 persisted), so the sealed total is 1.
    await ingest(c, 's1', 'mic', 0, new Uint8Array([1]));
    armed = true;
    // chunk index 1 == next_expected; the seal races in mid-advance.
    const result = await ingest(c, 's1', 'mic', 1, new Uint8Array([2, 3]));
    // Post-seal no-op: the watermark is reported at the SEALED total, never advanced past it.
    expect(result).toEqual({ ok: true, value: { next_expected_index: 1 } });
    const st = await readUploadStatus(c, { session_id: 's1', track: 'mic' });
    expect(st.ok && st.value.status).toBe('completed');
    expect(st.ok && st.value.next_expected_index).toBe(1);
    expect(st.ok && st.value.committed_byte_len).toBe(1); // the racing chunk's bytes are NOT committed
  });
});
