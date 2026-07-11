import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { createInMemorySessionFinalizedSink } from './events.js';
import { mediaArtifactKey } from './keys.js';
import { registerPlayableArtifact } from './media-artifact.js';
import { mintPlaybackToken, streamMedia } from './playback.js';
import type { AudioBlobContext } from './ports.js';
import { FakeBlobStore, FakeHandlerDb } from './test-support/fakes.js';
import { finalizeTrack, ingestChunk } from './upload.js';

const TENANT = 'tenant-A';
const fakeMint = async (args: { resource: string; ttlSeconds: number }): Promise<string> =>
  `tok:${args.resource}:${args.ttlSeconds}`;

function ctx(): AudioBlobContext {
  return {
    tenantId: TENANT,
    db: new FakeHandlerDb(),
    blob: new FakeBlobStore(),
    config: resolveConfig({ allowedTracks: ['mic', 'system'] }),
  };
}

/** Ingest one chunk + finalize a track so it exists + is sealed. */
async function seed(c: AudioBlobContext, session: string, track: string, bytes: Uint8Array) {
  await ingestChunk(c, { session_id: session, track, chunk_index: '0' }, bytes);
  const sink = createInMemorySessionFinalizedSink();
  await finalizeTrack(c, { session_id: session, track }, 1, sink);
}

describe('mintPlaybackToken — readiness + TTL', () => {
  it('a track with no playable artifact → 409 not_ready', async () => {
    const c = ctx();
    await seed(c, 's1', 'mic', new Uint8Array([1, 2, 3]));
    const r = await mintPlaybackToken(c, { session_id: 's1', track: 'mic' }, fakeMint);
    expect(!r.ok && r.status).toBe(409);
    expect(!r.ok && r.error).toBe('not_ready');
  });

  it('a foreign/absent track → 404 (no cross-tenant token)', async () => {
    const c = ctx();
    const r = await mintPlaybackToken(c, { session_id: 'nope', track: 'mic' }, fakeMint);
    expect(!r.ok && r.status).toBe(404);
  });

  it('mints once ready; TTL = max(900, ceil(duration)+60) clamped to 24h; resource is the artifact key', async () => {
    const c = ctx();
    await seed(c, 's1', 'mic', new Uint8Array([1, 2, 3, 4]));
    await registerPlayableArtifact(
      c,
      { session_id: 's1', track: 'mic' },
      { bytes: new Uint8Array([9, 9, 9]), contentType: 'audio/ogg', durationSeconds: 10 },
    );
    const short = await mintPlaybackToken(c, { session_id: 's1', track: 'mic' }, fakeMint);
    expect(short.ok).toBe(true);
    if (short.ok) {
      expect(short.value.ttl_seconds).toBe(900); // floor dominates for a short recording
      expect(short.value.resource).toBe(mediaArtifactKey('s1', 'mic'));
      expect(short.value.token).toBe(`tok:${mediaArtifactKey('s1', 'mic')}:900`);
    }
  });

  it('TTL scales with a long duration and clamps at 24h', async () => {
    const c = ctx();
    await seed(c, 's1', 'system', new Uint8Array([1]));
    await registerPlayableArtifact(
      c,
      { session_id: 's1', track: 'system' },
      { bytes: new Uint8Array([1]), durationSeconds: 1000 },
    );
    const mid = await mintPlaybackToken(c, { session_id: 's1', track: 'system' }, fakeMint);
    expect(mid.ok && mid.value.ttl_seconds).toBe(1060); // max(900, 1000+60)

    await registerPlayableArtifact(
      c,
      { session_id: 's1', track: 'system' },
      { bytes: new Uint8Array([1]), durationSeconds: 100000 },
    );
    const big = await mintPlaybackToken(c, { session_id: 's1', track: 'system' }, fakeMint);
    expect(big.ok && big.value.ttl_seconds).toBe(24 * 60 * 60); // clamped to the ceiling
  });
});

const req = (headers?: Record<string, string>): Request =>
  new Request('http://local/playback', { headers });

describe('streamMedia — Range/206/304/416/403/404 + token binding', () => {
  const PLAYABLE = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  async function ready(): Promise<AudioBlobContext> {
    const c = ctx();
    await seed(c, 's1', 'mic', new Uint8Array([1]));
    await registerPlayableArtifact(
      c,
      { session_id: 's1', track: 'mic' },
      { bytes: PLAYABLE, contentType: 'audio/ogg', durationSeconds: 3 },
    );
    return c;
  }
  const key = mediaArtifactKey('s1', 'mic');

  it('a token bound to a DIFFERENT resource → 403 (no replay)', async () => {
    const c = await ready();
    const res = await streamMedia(c, { session_id: 's1', track: 'mic' }, req(), 'wrong/resource');
    expect(res.status).toBe(403);
  });

  it('full GET → 200 with the exact bytes + content-type + etag', async () => {
    const c = await ready();
    const res = await streamMedia(c, { session_id: 's1', track: 'mic' }, req(), key);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/ogg');
    expect(res.headers.get('content-length')).toBe(String(PLAYABLE.length));
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PLAYABLE]);
  });

  it('Range bytes=2-5 → 206 with Content-Range + the exact slice', async () => {
    const c = await ready();
    const res = await streamMedia(
      c,
      { session_id: 's1', track: 'mic' },
      req({ range: 'bytes=2-5' }),
      key,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([2, 3, 4, 5]);
  });

  it('an unsatisfiable range → 416 with Content-Range bytes */len', async () => {
    const c = await ready();
    const res = await streamMedia(
      c,
      { session_id: 's1', track: 'mic' },
      req({ range: 'bytes=99-200' }),
      key,
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('If-None-Match match → 304', async () => {
    const c = await ready();
    const first = await streamMedia(c, { session_id: 's1', track: 'mic' }, req(), key);
    const etag = first.headers.get('etag') as string;
    const res = await streamMedia(
      c,
      { session_id: 's1', track: 'mic' },
      req({ 'if-none-match': etag }),
      key,
    );
    expect(res.status).toBe(304);
  });

  it('If-Range mismatch → serves the full 200 (not 206)', async () => {
    const c = await ready();
    const res = await streamMedia(
      c,
      { session_id: 's1', track: 'mic' },
      req({ range: 'bytes=1-2', 'if-range': '"stale00000"' }),
      key,
    );
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PLAYABLE]);
  });

  it('a track that exists but has NO playable blob → 404', async () => {
    const c = ctx();
    await seed(c, 's1', 'mic', new Uint8Array([1])); // ingested + finalized, but not prepared
    const res = await streamMedia(c, { session_id: 's1', track: 'mic' }, req(), key);
    expect(res.status).toBe(404);
  });
});
