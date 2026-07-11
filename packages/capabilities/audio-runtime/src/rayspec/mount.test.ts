import { isHttpResponse, type RouteHandlerInit } from '@rayspec/handler-sdk';
import { describe, expect, it } from 'vitest';
import { createInMemorySessionFinalizedSink, SessionEventRejectedError } from '../events.js';
import { AUDIO_TRACKS_STORE } from '../stores.js';
import { FakeHandlerDb } from '../test-support/fakes.js';
import {
  buildAudioCapabilitySpec,
  DEFAULT_AUDIO_HANDLER_IDS,
  mountAudioCapability,
} from './mount.js';

function mount(basePath?: string) {
  return mountAudioCapability({
    sessionFinalizedSink: createInMemorySessionFinalizedSink(),
    ...(basePath ? { basePath } : {}),
  });
}

describe('mountAudioCapability', () => {
  it('produces the neutral stores', () => {
    const m = mount();
    expect(m.stores.map((s) => s.name)).toEqual(['audio_sessions', 'audio_tracks']);
  });

  it('produces the 5 routes at the default base with the right actions', () => {
    const m = mount();
    const byPath = new Map(m.api.map((r) => [`${r.method} ${r.path}`, r.action]));
    expect(byPath.get('POST /sessions/{session_id}/{track}/chunks/{chunk_index}')).toEqual({
      kind: 'stream',
      handler: DEFAULT_AUDIO_HANDLER_IDS.chunkIngest,
      mode: 'ingest',
    });
    expect(byPath.get('GET /sessions/{session_id}/{track}/upload-status')).toEqual({
      kind: 'handler',
      handler: DEFAULT_AUDIO_HANDLER_IDS.uploadStatus,
    });
    expect(byPath.get('POST /sessions/{session_id}/{track}/finalize')).toEqual({
      kind: 'handler',
      handler: DEFAULT_AUDIO_HANDLER_IDS.finalizeTrack,
    });
    expect(byPath.get('POST /sessions/{session_id}/{track}/play-token')).toEqual({
      kind: 'handler',
      handler: DEFAULT_AUDIO_HANDLER_IDS.playToken,
    });
    expect(byPath.get('GET /sessions/{session_id}/{track}/playback')).toEqual({
      kind: 'stream',
      handler: DEFAULT_AUDIO_HANDLER_IDS.playback,
      mode: 'playback',
    });
  });

  it('registers all 5 handlers as route-kind entries', () => {
    const m = mount();
    expect([...m.handlers.keys()].sort()).toEqual(Object.values(DEFAULT_AUDIO_HANDLER_IDS).sort());
    for (const h of m.handlers.values()) {
      expect(h.kind).toBe('route');
      expect(typeof h.fn).toBe('function');
    }
  });

  it('honors a custom base path', () => {
    const m = mount('/audio');
    expect(m.basePath).toBe('/audio');
    expect(m.api.every((r) => r.path.startsWith('/audio/'))).toBe(true);
  });

  it('buildAudioCapabilitySpec assembles a valid v0.1 spec that mounts the capability', () => {
    const m = mount();
    const spec = buildAudioCapabilitySpec(m, { name: 'test-audio-product' });
    expect(spec.version).toBe('0.1');
    expect(spec.stores.map((s) => s.name)).toEqual(['audio_sessions', 'audio_tracks']);
    expect(spec.api).toHaveLength(5);
  });
});

describe('finalize handler — deliberate sink rejection mapping (E2E-2)', () => {
  /** An init whose db holds ONE sealed track (the idempotent-terminal path re-emits the event). */
  async function sealedInit(): Promise<RouteHandlerInit> {
    const db = new FakeHandlerDb();
    await db.insert(AUDIO_TRACKS_STORE, {
      session_id: 's1',
      track: 'mic',
      track_ref: 'tenant-A:s1:mic',
      status: 'completed',
      persisted_chunk_count: 1,
      committed_byte_len: 1,
    });
    return {
      tenantId: 'tenant-A',
      db,
      params: { session_id: 's1', track: 'mic' },
      body: { total_chunks: 1 },
    } as unknown as RouteHandlerInit;
  }

  it("maps a sink's SessionEventRejectedError to a CLEAN deliberate 403 (never an unhandled 500)", async () => {
    const mounted = mountAudioCapability({
      sessionFinalizedSink: {
        emit: async () => {
          throw new SessionEventRejectedError('cross_tenant', 'tenant mismatch (fail-closed).');
        },
      },
    });
    const handler = mounted.handlers.get(DEFAULT_AUDIO_HANDLER_IDS.finalizeTrack);
    if (!handler) throw new Error('finalize handler missing');
    const result = await handler.fn(await sealedInit());
    // The branded envelope: a deliberate 403 with the capability's stable {error, detail} taxonomy.
    expect(isHttpResponse(result)).toBe(true);
    if (!isHttpResponse(result)) throw new Error('unreachable');
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: 'session_event_rejected',
      detail:
        'the session_finalized event was rejected fail-closed (cross_tenant) — no workflow was started.',
    });
  });

  it('a GENERIC sink throw still propagates (a genuine fault stays a 500)', async () => {
    const mounted = mountAudioCapability({
      sessionFinalizedSink: {
        emit: async () => {
          throw new Error('database connection lost');
        },
      },
    });
    const handler = mounted.handlers.get(DEFAULT_AUDIO_HANDLER_IDS.finalizeTrack);
    if (!handler) throw new Error('finalize handler missing');
    await expect(handler.fn(await sealedInit())).rejects.toThrow('database connection lost');
  });
});
