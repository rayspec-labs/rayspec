import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { createInMemorySessionFinalizedSink } from './events.js';
import { createFakeMediaAdapter, syntheticAudioChunk } from './fake-media-adapter.js';
import { mediaArtifactKey } from './keys.js';
import { mintPlaybackToken, streamMedia } from './playback.js';
import type { AudioBlobContext } from './ports.js';
import { FakeBlobStore, FakeHandlerDb } from './test-support/fakes.js';
import { finalizeTrack, ingestChunk } from './upload.js';

const TENANT = 'tenant-A';
function ctx(): AudioBlobContext {
  return {
    tenantId: TENANT,
    db: new FakeHandlerDb(),
    blob: new FakeBlobStore(),
    config: resolveConfig({ allowedTracks: ['mic', 'system'] }),
  };
}

describe('syntheticAudioChunk — deterministic', () => {
  it('is stable for an (index, size) and differs across indices', () => {
    expect([...syntheticAudioChunk(0, 4)]).toEqual([...syntheticAudioChunk(0, 4)]);
    expect([...syntheticAudioChunk(0, 4)]).not.toEqual([...syntheticAudioChunk(1, 4)]);
    expect(syntheticAudioChunk(2, 8).length).toBe(8);
  });
});

describe('FakeMediaAdapter.prepareTrackForPlayback', () => {
  it('concatenates uploaded chunks into the playable artifact + registers a duration', async () => {
    const c = ctx();
    const chunks = [syntheticAudioChunk(0, 6), syntheticAudioChunk(1, 6)];
    await ingestChunk(
      c,
      { session_id: 's1', track: 'mic', chunk_index: '0' },
      chunks[0] as Uint8Array,
    );
    await ingestChunk(
      c,
      { session_id: 's1', track: 'mic', chunk_index: '1' },
      chunks[1] as Uint8Array,
    );
    const sink = createInMemorySessionFinalizedSink();
    await finalizeTrack(c, { session_id: 's1', track: 'mic' }, 2, sink);

    const adapter = createFakeMediaAdapter({ bytesPerSecond: 4 });
    const prep = await adapter.prepareTrackForPlayback(c, { session_id: 's1', track: 'mic' });
    expect(prep.ok).toBe(true);
    if (prep.ok) {
      expect(prep.value.media_artifact_key).toBe(mediaArtifactKey('s1', 'mic'));
      // 12 bytes / 4 bytes-per-sec = 3s duration.
      expect(prep.value.media_duration_seconds).toBe(3);
    }

    // The playable artifact is now streamable and equals the concatenated chunk bytes.
    const key = mediaArtifactKey('s1', 'mic');
    const res = await streamMedia(
      c,
      { session_id: 's1', track: 'mic' },
      new Request('http://local/playback'),
      key,
    );
    expect(res.status).toBe(200);
    const expected = new Uint8Array([...(chunks[0] as Uint8Array), ...(chunks[1] as Uint8Array)]);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...expected]);

    // ... and a token can now be minted (readiness satisfied).
    const mint = await mintPlaybackToken(
      c,
      { session_id: 's1', track: 'mic' },
      async (a) => `tok:${a.resource}`,
    );
    expect(mint.ok).toBe(true);
  });

  it('a never-started track → 404', async () => {
    const c = ctx();
    const adapter = createFakeMediaAdapter();
    const prep = await adapter.prepareTrackForPlayback(c, { session_id: 'nope', track: 'mic' });
    expect(!prep.ok && prep.status).toBe(404);
  });
});
