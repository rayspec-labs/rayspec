/**
 * the Tier B Audio/Media capability END-TO-END, DB-backed, through the REAL createAuthApp chain,
 * mounted for a neutral test product (`audio-capability-test`). This is the gate proof: a
 * product that names nothing product-specific can create/upload/finalize/play back an audio session behind
 * RaySpec's real auth/tenancy chain, tenant isolation + blob path safety hold on every route, and the
 * dual-track single-run invariant converges on ONE session_finalized event.
 *
 * Proves (fail-the-fix, ground truth, not pass-the-shape):
 *  1. Full flow: upload chunks → finalize (emits session_finalized) → media-prep → mint play-token →
 *     stream the exact bytes back.
 *  2. Upload watermark contract over HTTP: 200 advance / 200 no-op / 409 gap.
 *  3. DUAL-TRACK single-run: mic + system finalize → exactly ONE session-scoped event (deliveredCount 1).
 *  4. CONCURRENT first-chunk race → exactly one track row, none 500s (real UNIQUE + real savepoints).
 *  5. TENANT ISOLATION on every route: ingest, upload-status, finalize, play-token, and the playback
 *     media-JWT boundary (a tenant-A token against tenant-B's resource → 404 via the DB ownership re-check).
 *  6. Playback read contract: 200 / Range 206 / 304 / 416 + the resource-binding 403 + a forged-token 401.
 *  7. A rejected chunk commits no row: a gap or a refused track on a session or track that does not
 *     exist leaves `audio_sessions` and `audio_tracks` as they were.
 *  8. The session status under real transactions: two tracks finalized at the same time complete the
 *     session, a track that starts while the other is being finalized keeps it `recording`, and a
 *     finalize whose sink throws rolls the track seal and the session status back together.
 *
 * Skips when DATABASE_URL is absent — but HARD-FAILS if the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * yet absent, so this security-load-bearing suite can never silently self-skip to a false green.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AudioBlobContext,
  createFakeMediaAdapter,
  createInMemorySessionFinalizedSink,
  type FinalizedSessionEvent,
  finalizedEventId,
  type InMemorySessionFinalizedSink,
  mediaArtifactKey,
  resolveConfig,
} from '@rayspec/audio-runtime';
import { buildAudioCapabilitySpec, mountAudioCapability } from '@rayspec/audio-runtime/rayspec';
import { forTenant } from '@rayspec/db';
import {
  type BlobStoreFactory,
  makeFsBlobStoreFactory,
  makeHandlerDb,
  type ResolvedHandler,
} from '@rayspec/platform';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMediaTokenService, type MediaTokenService } from '../media/media-token.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: a DB-backed SECURITY suite that self-skips without DATABASE_URL is a
// false-green hazard. When the DB is REQUIRED but absent, hard-fail at collection rather than skip.
if (requireDb && !hasDb) {
  throw new Error(
    'audio-capability.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a security-load-bearing suite.',
  );
}

const MEDIA_SECRET = 'test-a-media-secret-at-least-32-bytes-x';
const capConfig = resolveConfig({ allowedTracks: ['mic', 'system'] });

describe.skipIf(!hasDb)('Tier B Audio/Media capability end-to-end', () => {
  let h: Harness;
  let handlers: ReadonlyMap<string, ResolvedHandler>;
  let blobDir: string;
  let blobFactory: BlobStoreFactory;
  let media: MediaTokenService;
  let sink: InMemorySessionFinalizedSink;
  /**
   * Runs inside a finalize's transaction, just before the event is delivered: after the track seal
   * and the session-status step, before the commit. A test sets it to hold a finalize open at that
   * point, or to make the sink throw. Cleared before every test.
   */
  let beforeEmit: ((event: FinalizedSessionEvent) => Promise<void>) | undefined;

  beforeAll(async () => {
    sink = createInMemorySessionFinalizedSink();
    const mounted = mountAudioCapability({
      sessionFinalizedSink: {
        emit: async (event) => {
          await beforeEmit?.(event);
          await sink.emit(event);
        },
      },
      capability: { allowedTracks: ['mic', 'system'] },
    });
    // The neutral test product spec (stores + routes come from the neutral capability).
    const spec = buildAudioCapabilitySpec(mounted, { name: 'audio-capability-test' });
    handlers = mounted.handlers as ReadonlyMap<string, ResolvedHandler>;
    blobDir = mkdtempSync(join(tmpdir(), 'rayspec-audio-cap-'));
    blobFactory = makeFsBlobStoreFactory(blobDir);
    media = createMediaTokenService(MEDIA_SECRET);
    h = await createHarness({
      engineSpec: spec,
      engineHandlers: handlers,
      blobFactory,
      mediaTokenService: media,
      schema: 'rayspec_test_audio_capability',
    });
  });
  beforeEach(async () => {
    await h.reset();
    sink.clear();
    beforeEmit = undefined;
  });
  afterAll(async () => {
    await h.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  /** Register → org → switch → JWT (member role: store:read/write). Returns the org id, user id, token. */
  async function principal(
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; userId: string; token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const userId = (decodeJwt(t0).sub as string) ?? '';
    const orgId = (
      await (
        await jsonRequest(h.app, 'POST', '/v1/orgs', {
          body: { name: orgName },
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).id as string;
    const token = (
      await (
        await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).accessToken as string;
    return { orgId, userId, token };
  }

  const chunkPath = (s: string, t: string, i: number): string => `/sessions/${s}/${t}/chunks/${i}`;

  async function postChunk(
    session: string,
    track: string,
    index: number,
    token: string,
    bytes: Uint8Array,
    contentType = 'audio/ogg',
  ): Promise<Response> {
    return h.app.request(chunkPath(session, track, index), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      body: bytes,
    });
  }

  const authGet = (path: string, token: string): Promise<Response> =>
    h.app.request(path, { headers: { authorization: `Bearer ${token}` } });

  async function finalize(
    session: string,
    track: string,
    token: string,
    totalChunks: number,
  ): Promise<Response> {
    return jsonRequest(h.app, 'POST', `/sessions/${session}/${track}/finalize`, {
      body: { total_chunks: totalChunks },
      headers: { authorization: `Bearer ${token}` },
    });
  }

  const mintPlayToken = (session: string, track: string, token: string): Promise<Response> =>
    h.app.request(`/sessions/${session}/${track}/play-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

  /** Run the fake media adapter over a track (the deterministic media-prep step) via a tenant tx. */
  async function prepareForPlayback(orgId: string, session: string, track: string): Promise<void> {
    const productTables = h.deps.engine?.productTables;
    if (!productTables) throw new Error('no product tables registered');
    const tdb = forTenant(h.deps.db, orgId);
    const blob = blobFactory(orgId);
    await tdb.transaction(async (txTdb) => {
      const db = makeHandlerDb(txTdb, productTables);
      const ctx: AudioBlobContext = { tenantId: orgId, db, blob, config: capConfig };
      const r = await createFakeMediaAdapter({ bytesPerSecond: 4 }).prepareTrackForPlayback(ctx, {
        session_id: session,
        track,
      });
      if (!r.ok) throw new Error(`media prep failed: ${r.detail}`);
    });
  }

  /** Count the track rows for one (tenant, session, track) — the ground-truth idempotency check. */
  async function countTracks(orgId: string, session: string, track: string): Promise<number> {
    const rows = (await h.db.$client.unsafe(
      'select count(*)::int as n from audio_tracks where tenant_id = $1 and session_id = $2 and track = $3',
      [orgId, session, track],
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // The full flow.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  it('neutral product: upload → finalize → media-prep → mint → stream the exact bytes back', async () => {
    const a = await principal('flow@example.com', 'Flow');
    const c0 = new Uint8Array([1, 2, 3, 4]);
    const c1 = new Uint8Array([5, 6, 7, 8, 9]);
    expect((await postChunk('s1', 'mic', 0, a.token, c0)).status).toBe(200);
    expect((await postChunk('s1', 'mic', 1, a.token, c1)).status).toBe(200);

    const fin = await finalize('s1', 'mic', a.token, 2);
    expect(fin.status).toBe(200);
    const finBody = await fin.json();
    expect(finBody.status).toBe('completed');
    expect(finBody.finalized_event_id).toBe(finalizedEventId(a.orgId, 's1'));
    // The capability EMITTED session_finalized (the Tier A workflow trigger — via the injected sink).
    expect(sink.deliveredFor(finalizedEventId(a.orgId, 's1'))?.source_capability).toBe(
      'audio_input',
    );

    await prepareForPlayback(a.orgId, 's1', 'mic');

    const mint = await mintPlayToken('s1', 'mic', a.token);
    expect(mint.status).toBe(200);
    const { url, ttl_seconds } = await mint.json();
    expect(typeof url).toBe('string');
    expect(ttl_seconds).toBe(900); // short recording → the TTL floor

    // The url is relative and carries the media token; GET it → 200 + the concatenated chunk bytes.
    const play = await h.app.request(url);
    expect(play.status).toBe(200);
    expect(play.headers.get('content-type')).toBe('audio/ogg');
    const back = new Uint8Array(await play.arrayBuffer());
    expect([...back]).toEqual([...c0, ...c1]);
  });

  it('a not-yet-prepared track → play-token 409 not_ready', async () => {
    const a = await principal('nr@example.com', 'NotReady');
    await postChunk('s1', 'mic', 0, a.token, new Uint8Array([1]));
    await finalize('s1', 'mic', a.token, 1);
    const mint = await mintPlayToken('s1', 'mic', a.token);
    expect(mint.status).toBe(409);
    expect((await mint.json()).error).toBe('not_ready');
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // The upload watermark contract + concurrency (real UNIQUE + real savepoints).
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  it('the 200-advance / 409-gap / 200-no-op contract over HTTP', async () => {
    const a = await principal('wm@example.com', 'Wm');
    expect(await (await postChunk('s2', 'mic', 0, a.token, new Uint8Array([1]))).json()).toEqual({
      next_expected_index: 1,
    });
    const gap = await postChunk('s2', 'mic', 2, a.token, new Uint8Array([9]));
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({
      error: 'gap',
      detail: expect.any(String),
      next_expected_index: 1,
    });
    expect(await (await postChunk('s2', 'mic', 1, a.token, new Uint8Array([2]))).json()).toEqual({
      next_expected_index: 2,
    });
    // duplicate (index 0 < watermark 2) → 200 no-op.
    expect(await (await postChunk('s2', 'mic', 0, a.token, new Uint8Array([1]))).json()).toEqual({
      next_expected_index: 2,
    });
    expect(await countTracks(a.orgId, 's2', 'mic')).toBe(1);
  });

  it('CONCURRENT first-chunk POSTs collide on the UNIQUE: one row, none 500s', async () => {
    const a = await principal('conc@example.com', 'Conc');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => postChunk('s3', 'mic', 0, a.token, new Uint8Array([0x42]))),
    );
    for (const r of results) {
      expect(r.status).toBe(200); // never 500 — the savepoint recovery handled the race
      expect(await r.json()).toEqual({ next_expected_index: 1 });
    }
    expect(await countTracks(a.orgId, 's3', 'mic')).toBe(1);
  });

  it('DUAL-TRACK finalize converges on EXACTLY ONE session-scoped event', async () => {
    const a = await principal('dual@example.com', 'Dual');
    await postChunk('s4', 'mic', 0, a.token, new Uint8Array([1]));
    await postChunk('s4', 'system', 0, a.token, new Uint8Array([2]));
    await finalize('s4', 'mic', a.token, 1);
    await finalize('s4', 'system', a.token, 1);
    expect(sink.emitCount()).toBe(2); // emitted on both track seals
    expect(sink.deliveredCount()).toBe(1); // ... but ONE workflow (session-scoped single-flight)
    expect(sink.delivered()[0]?.event_id).toBe(finalizedEventId(a.orgId, 's4'));
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // A rejected chunk commits nothing.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  /** Every session and track row of one tenant, as `session:status` / `session/track:status:chunks`. */
  async function rowsHeld(orgId: string): Promise<{ sessions: string[]; tracks: string[] }> {
    const sessions = (await h.db.$client.unsafe(
      'select session_id, status from audio_sessions where tenant_id = $1 order by session_id',
      [orgId],
    )) as unknown as Array<{ session_id: string; status: string }>;
    const tracks = (await h.db.$client.unsafe(
      'select session_id, track, status, persisted_chunk_count as n from audio_tracks ' +
        'where tenant_id = $1 order by session_id, track',
      [orgId],
    )) as unknown as Array<{ session_id: string; track: string; status: string; n: number }>;
    return {
      sessions: sessions.map((r) => `${r.session_id}:${r.status}`),
      tracks: tracks.map((r) => `${r.session_id}/${r.track}:${r.status}:${r.n}`),
    };
  }

  it('a gap on a session that does not exist → 409 at index 0 and no row is committed', async () => {
    const a = await principal('gapnew@example.com', 'GapNew');
    const gap = await postChunk('ghost', 'mic', 3, a.token, new Uint8Array([9]));
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({
      error: 'gap',
      detail: expect.any(String),
      next_expected_index: 0,
    });
    expect(await rowsHeld(a.orgId)).toEqual({ sessions: [], tracks: [] });
    // The track still reads as never started, and its first chunk is accepted afterwards.
    const status = await authGet('/sessions/ghost/mic/upload-status', a.token);
    expect((await status.json()).status).toBe('absent');
    expect((await postChunk('ghost', 'mic', 0, a.token, new Uint8Array([1]))).status).toBe(200);
    expect(await rowsHeld(a.orgId)).toEqual({
      sessions: ['ghost:recording'],
      tracks: ['ghost/mic:recording:1'],
    });
  });

  it('a gap on a new track of a completed session leaves the session completed and adds no track', async () => {
    const a = await principal('gaptrack@example.com', 'GapTrack');
    await postChunk('s12', 'mic', 0, a.token, new Uint8Array([1]));
    expect((await finalize('s12', 'mic', a.token, 1)).status).toBe(200);
    const gap = await postChunk('s12', 'system', 2, a.token, new Uint8Array([9]));
    expect(gap.status).toBe(409);
    expect((await gap.json()).next_expected_index).toBe(0);
    expect(await rowsHeld(a.orgId)).toEqual({
      sessions: ['s12:completed'],
      tracks: ['s12/mic:completed:1'],
    });
  });

  it('a chunk for a track the product does not allow, or a malformed index → 400 and no row', async () => {
    const a = await principal('badreq@example.com', 'BadReq');
    expect((await postChunk('s13', 'other', 0, a.token, new Uint8Array([1]))).status).toBe(400);
    expect((await postChunk('s13', 'mic', -1, a.token, new Uint8Array([1]))).status).toBe(400);
    expect(await rowsHeld(a.orgId)).toEqual({ sessions: [], tracks: [] });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // The session status under real transactions (row locks + read committed).
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  /** A gate a finalize waits at inside its transaction until the test opens it. */
  function gate(): { reached: Promise<void>; wait: () => Promise<void>; open: () => void } {
    let markReached: () => void = () => {};
    let open: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      reached,
      wait: async () => {
        markReached();
        await opened;
      },
      open,
    };
  }

  /** Resolve true if `p` settles within `ms`, false if it is still pending (it keeps running). */
  async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const settled = await Promise.race([p.then(() => true as const), timedOut]);
    clearTimeout(timer);
    return settled;
  }

  it('two tracks finalized at the same time complete the session', async () => {
    const a = await principal('dualconc@example.com', 'DualConc');
    await postChunk('s14', 'mic', 0, a.token, new Uint8Array([1]));
    await postChunk('s14', 'system', 0, a.token, new Uint8Array([2]));

    // Hold the `mic` finalize open after it has sealed `mic` and read the tracks, before it commits.
    const g = gate();
    let held = false;
    beforeEmit = async () => {
      if (held) return;
      held = true;
      await g.wait();
    };
    const mic = finalize('s14', 'mic', a.token, 1);
    await g.reached;
    // The `system` finalize seals its own track and must then WAIT for the `mic` finalize: reading
    // the tracks now would still show `mic` as recording, and neither would complete the session.
    const system = finalize('s14', 'system', a.token, 1);
    const systemRanAhead = await settlesWithin(system, 500);
    g.open();
    expect((await mic).status).toBe(200);
    expect((await system).status).toBe(200);
    expect(systemRanAhead).toBe(false);
    expect(await rowsHeld(a.orgId)).toEqual({
      sessions: ['s14:completed'],
      tracks: ['s14/mic:completed:1', 's14/system:completed:1'],
    });
  });

  it('a track that starts while the other track is being finalized keeps the session recording', async () => {
    const a = await principal('late@example.com', 'Late');
    await postChunk('s15', 'mic', 0, a.token, new Uint8Array([1]));

    // Hold the `mic` finalize open after it has set the session `completed`, before it commits.
    const g = gate();
    beforeEmit = () => g.wait();
    const mic = finalize('s15', 'mic', a.token, 1);
    await g.reached;
    // The first chunk of `system` must WAIT for that finalize: it still reads the session as
    // `recording`, and would otherwise commit a recording track under a session about to be completed.
    const system = postChunk('s15', 'system', 0, a.token, new Uint8Array([2]));
    const systemRanAhead = await settlesWithin(system, 500);
    g.open();
    expect((await mic).status).toBe(200);
    expect((await system).status).toBe(200);
    expect(systemRanAhead).toBe(false);
    expect(await rowsHeld(a.orgId)).toEqual({
      sessions: ['s15:recording'],
      tracks: ['s15/mic:completed:1', 's15/system:recording:1'],
    });
    // Its own finalize completes the session again.
    beforeEmit = undefined;
    expect((await finalize('s15', 'system', a.token, 1)).status).toBe(200);
    expect((await rowsHeld(a.orgId)).sessions).toEqual(['s15:completed']);
  });

  it('unsynchronised finalizes and first chunks never leave a session status that disagrees with its tracks', async () => {
    const a = await principal('storm@example.com', 'Storm');
    const dual = Array.from({ length: 6 }, (_, i) => `dual-${i}`);
    const late = Array.from({ length: 6 }, (_, i) => `late-${i}`);
    for (const s of dual) {
      await postChunk(s, 'mic', 0, a.token, new Uint8Array([1]));
      await postChunk(s, 'system', 0, a.token, new Uint8Array([2]));
    }
    for (const s of late) await postChunk(s, 'mic', 0, a.token, new Uint8Array([1]));

    const responses = await Promise.all([
      ...dual.flatMap((s) => [finalize(s, 'mic', a.token, 1), finalize(s, 'system', a.token, 1)]),
      ...late.flatMap((s) => [
        finalize(s, 'mic', a.token, 1),
        postChunk(s, 'system', 0, a.token, new Uint8Array([2])),
      ]),
    ]);
    for (const r of responses) expect(r.status).toBe(200);

    const held = await rowsHeld(a.orgId);
    expect(held.sessions).toEqual([
      ...dual.map((s) => `${s}:completed`),
      ...late.map((s) => `${s}:recording`),
    ]);
    expect(held.tracks).toEqual([
      ...dual.flatMap((s) => [`${s}/mic:completed:1`, `${s}/system:completed:1`]),
      ...late.flatMap((s) => [`${s}/mic:completed:1`, `${s}/system:recording:1`]),
    ]);
  });

  it('a finalize whose sink throws rolls the track seal and the session status back together', async () => {
    const a = await principal('sinkfail@example.com', 'SinkFail');
    await postChunk('s16', 'mic', 0, a.token, new Uint8Array([1]));
    beforeEmit = async () => {
      throw new Error('event sink unavailable');
    };
    expect((await finalize('s16', 'mic', a.token, 1)).status).toBe(500);
    expect(await rowsHeld(a.orgId)).toEqual({
      sessions: ['s16:recording'],
      tracks: ['s16/mic:recording:1'],
    });
    // The retry, with the sink back, seals the track and completes the session.
    beforeEmit = undefined;
    expect((await finalize('s16', 'mic', a.token, 1)).status).toBe(200);
    expect(await rowsHeld(a.orgId)).toEqual({
      sessions: ['s16:completed'],
      tracks: ['s16/mic:completed:1'],
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // Tenant isolation on EVERY route.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  it('ingest + upload-status are tenant-scoped (A is invisible to B)', async () => {
    const a = await principal('tenA@example.com', 'TenA');
    const b = await principal('tenB@example.com', 'TenB');
    await postChunk('shared', 'mic', 0, a.token, new Uint8Array([1]));
    await postChunk('shared', 'mic', 1, a.token, new Uint8Array([2]));

    // B has no track under this session id: an index at or below A's watermark is a gap at B's own
    // index 0 (NOT an ack or a no-op against A's watermark 2), and it commits no row for B.
    for (const index of [2, 1]) {
      const bGap = await postChunk('shared', 'mic', index, b.token, new Uint8Array([9]));
      expect(bGap.status).toBe(409);
      expect(await bGap.json()).toEqual({
        error: 'gap',
        detail: expect.any(String),
        next_expected_index: 0,
      });
    }
    expect(await rowsHeld(b.orgId)).toEqual({ sessions: [], tracks: [] });
    expect(await rowsHeld(a.orgId)).toEqual({
      sessions: ['shared:recording'],
      tracks: ['shared/mic:recording:2'],
    });

    // B posts the SAME session/index 0 → a fresh index-0 ack (NOT a 409/no-op against A's watermark).
    const bRes = await postChunk('shared', 'mic', 0, b.token, new Uint8Array([9]));
    expect(bRes.status).toBe(200);
    expect(await bRes.json()).toEqual({ next_expected_index: 1 });

    // B's upload-status for the shared session sees only B's own watermark (1), never A's (2).
    const bStatus = await authGet('/sessions/shared/mic/upload-status', b.token);
    expect((await bStatus.json()).next_expected_index).toBe(1);

    // Ground truth: disjoint rows + B's blob bytes are B's, not A's.
    expect(await countTracks(a.orgId, 'shared', 'mic')).toBe(1); // one (session,track) row per tenant
    const bBlob = blobFactory(b.orgId);
    const bGot = await bBlob.get('shared/mic/chunk_0');
    if ('notFound' in bGot) throw new Error('B blob missing');
    expect([...new Uint8Array(await new Response(bGot.body).arrayBuffer())]).toEqual([9]);
  });

  it("finalize is tenant-scoped (B cannot finalize A's track → 404)", async () => {
    const a = await principal('finA@example.com', 'FinA');
    const b = await principal('finB@example.com', 'FinB');
    await postChunk('s5', 'mic', 0, a.token, new Uint8Array([1]));
    // B has never started this track under its own tenant → 404.
    const bFin = await finalize('s5', 'mic', b.token, 1);
    expect(bFin.status).toBe(404);
  });

  it("play-token is tenant-scoped (B cannot mint for A's recording → 404)", async () => {
    const a = await principal('mintA@example.com', 'MintA');
    const b = await principal('mintB@example.com', 'MintB');
    await postChunk('s6', 'mic', 0, a.token, new Uint8Array([1]));
    await finalize('s6', 'mic', a.token, 1);
    await prepareForPlayback(a.orgId, 's6', 'mic');
    // B mints for the same session/track → no such media under B's tenant → 404.
    expect((await mintPlayToken('s6', 'mic', b.token)).status).toBe(404);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // Playback read contract + the media-JWT tenant boundary.
  // ──────────────────────────────────────────────────────────────────────────────────────────────

  const PLAYBACK = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const playbackUrl = (s: string, t: string, tok: string): string =>
    `/sessions/${s}/${t}/playback?token=${encodeURIComponent(tok)}`;

  /** Seed a ready-to-play track whose playable artifact is EXACTLY `PLAYBACK` (via direct register). */
  async function seedPlayable(orgId: string, token: string, session: string): Promise<void> {
    await postChunk(session, 'mic', 0, token, new Uint8Array([1]));
    await finalize(session, 'mic', token, 1);
    // Register the playable artifact directly (deterministic bytes) via a tenant tx.
    const productTables = h.deps.engine?.productTables;
    if (!productTables) throw new Error('no product tables');
    const tdb = forTenant(h.deps.db, orgId);
    const blob = blobFactory(orgId);
    const { registerPlayableArtifact } = await import('@rayspec/audio-runtime');
    await tdb.transaction(async (txTdb) => {
      const ctx: AudioBlobContext = {
        tenantId: orgId,
        db: makeHandlerDb(txTdb, productTables),
        blob,
        config: capConfig,
      };
      const r = await registerPlayableArtifact(
        ctx,
        { session_id: session, track: 'mic' },
        {
          bytes: PLAYBACK,
          contentType: 'audio/ogg',
          durationSeconds: 3,
        },
      );
      if (!r.ok) throw new Error('register failed');
    });
  }

  it('valid media token → 200 + exact bytes; Range → 206; If-None-Match → 304; bad range → 416', async () => {
    const a = await principal('play@example.com', 'Play');
    await seedPlayable(a.orgId, a.token, 's7');
    const tok = await media.mint({
      tenantId: a.orgId,
      resource: mediaArtifactKey('s7', 'mic'),
      sub: a.userId,
      ttlSeconds: 300,
    });

    const full = await h.app.request(playbackUrl('s7', 'mic', tok));
    expect(full.status).toBe(200);
    const etag = full.headers.get('etag') as string;
    expect([...new Uint8Array(await full.arrayBuffer())]).toEqual([...PLAYBACK]);

    const range = await h.app.request(playbackUrl('s7', 'mic', tok), {
      headers: { range: 'bytes=2-5' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
    expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([2, 3, 4, 5]);

    const notMod = await h.app.request(playbackUrl('s7', 'mic', tok), {
      headers: { 'if-none-match': etag },
    });
    expect(notMod.status).toBe(304);

    const bad = await h.app.request(playbackUrl('s7', 'mic', tok), {
      headers: { range: 'bytes=99-200' },
    });
    expect(bad.status).toBe(416);
  });

  it('a token bound to a DIFFERENT resource → 403 (no cross-resource replay)', async () => {
    const a = await principal('bind@example.com', 'Bind');
    await seedPlayable(a.orgId, a.token, 's8');
    // A valid token for s8/mic, replayed against a DIFFERENT route resource (s9/mic).
    const tok = await media.mint({
      tenantId: a.orgId,
      resource: mediaArtifactKey('s8', 'mic'),
      sub: a.userId,
      ttlSeconds: 300,
    });
    expect((await h.app.request(playbackUrl('s9', 'mic', tok))).status).toBe(403);
  });

  it("a tenant-A media token against tenant-B's resource → 404 (DB ownership re-validation)", async () => {
    const a = await principal('xtA@example.com', 'XtA');
    const b = await principal('xtB@example.com', 'XtB');
    await seedPlayable(b.orgId, b.token, 's10'); // B owns s10/mic
    // A forges a token claiming its OWN tenant for B's resource key — A's tenant scope has no track row.
    const aTok = await media.mint({
      tenantId: a.orgId,
      resource: mediaArtifactKey('s10', 'mic'),
      sub: a.userId,
      ttlSeconds: 300,
    });
    expect((await h.app.request(playbackUrl('s10', 'mic', aTok))).status).toBe(404);
    // Ground truth the other way: B's own token serves the bytes (the 404 is the boundary, not absence).
    const bTok = await media.mint({
      tenantId: b.orgId,
      resource: mediaArtifactKey('s10', 'mic'),
      sub: b.userId,
      ttlSeconds: 300,
    });
    const ok = await h.app.request(playbackUrl('s10', 'mic', bTok));
    expect(ok.status).toBe(200);
    expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([...PLAYBACK]);
  });

  it('a FORGED media token (different secret) → 401 (the platform media verifier)', async () => {
    const a = await principal('forge@example.com', 'Forge');
    await seedPlayable(a.orgId, a.token, 's11');
    const forged = await createMediaTokenService('a-DIFFERENT-media-secret-32-bytes-xx').mint({
      tenantId: a.orgId,
      resource: mediaArtifactKey('s11', 'mic'),
      sub: a.userId,
      ttlSeconds: 300,
    });
    expect((await h.app.request(playbackUrl('s11', 'mic', forged))).status).toBe(401);
  });
});
