/**
 * Binding-level tests for the audio `rayspec/handlers` adapter — specifically the chunk-ingest
 * handler's BOUNDED body read. The naive pattern buffered the whole request via an unbounded
 * `request.arrayBuffer()`; the hardened binding drains the raw body under the configured per-chunk cap
 * and returns a 413 the instant it is exceeded (before the bytes are stored).
 */
import type { StreamRouteHandlerInit } from '@rayspec/handler-sdk';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import { createInMemorySessionFinalizedSink } from '../events.js';
import { FakeBlobStore, FakeHandlerDb } from '../test-support/fakes.js';
import { makeChunkIngestHandler } from './handlers.js';

const TENANT = 'tenant-A';

function handlerConfig(maxChunkBytes: number) {
  return {
    resolved: resolveConfig({ allowedTracks: ['mic', 'system'], maxChunkBytes }),
    sessionFinalizedSink: createInMemorySessionFinalizedSink(),
    buildPlaybackUrl: (sessionId: string, track: string, token: string) =>
      `/v1/sessions/${sessionId}/tracks/${track}/media?token=${token}`,
  };
}

/** Build a fake stream init carrying a raw POST body of `bytes` bytes for (s1, mic, index). */
function chunkInit(
  bytes: Uint8Array,
  index = 0,
  db: FakeHandlerDb = new FakeHandlerDb(),
): StreamRouteHandlerInit {
  return {
    tenantId: TENANT,
    db,
    blob: new FakeBlobStore(),
    params: { session_id: 's1', track: 'mic', chunk_index: String(index) },
    request: new Request('http://audio.local/ingest', {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': 'audio/opus' },
    }),
  };
}

describe('makeChunkIngestHandler — per-chunk byte cap', () => {
  it('rejects an over-cap chunk body with 413 before storing it', async () => {
    const handler = makeChunkIngestHandler(handlerConfig(4));
    const res = await handler(chunkInit(new Uint8Array([1, 2, 3, 4, 5]))); // 5 > 4
    expect(res.status).toBe(413);
  });

  it('an over-cap first chunk creates no session row and no track row', async () => {
    const handler = makeChunkIngestHandler(handlerConfig(4));
    const db = new FakeHandlerDb();
    const res = await handler(chunkInit(new Uint8Array([1, 2, 3, 4, 5]), 0, db));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe('chunk_too_large');
    expect(await db.select('audio_sessions')).toEqual([]);
    expect(await db.select('audio_tracks')).toEqual([]);
  });

  it('a gap on a session that does not exist answers 409 at index 0 and creates nothing', async () => {
    const handler = makeChunkIngestHandler(handlerConfig(4));
    const db = new FakeHandlerDb();
    const res = await handler(chunkInit(new Uint8Array([1]), 3, db));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'gap',
      detail: expect.any(String),
      next_expected_index: 0,
    });
    expect(await db.select('audio_sessions')).toEqual([]);
    expect(await db.select('audio_tracks')).toEqual([]);
  });

  it('accepts an in-cap chunk (200 ack)', async () => {
    const handler = makeChunkIngestHandler(handlerConfig(4));
    const res = await handler(chunkInit(new Uint8Array([1, 2, 3, 4]))); // exactly the cap
    expect(res.status).toBe(200);
    const body = (await res.json()) as { next_expected_index: number };
    expect(body.next_expected_index).toBe(1);
  });
});
