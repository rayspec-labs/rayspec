import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { createInMemorySessionFinalizedSink } from './events.js';
import { finalizedEventId } from './keys.js';
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
