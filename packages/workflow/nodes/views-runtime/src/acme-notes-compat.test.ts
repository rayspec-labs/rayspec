/**
 * Compatibility tests: the neutral acme-notes read expectations — session-list /
 * transcript-get / notes-get — are DECLARABLE as Product-YAML views and REPRODUCED by the
 * interpreter over fixture data. The declarations go through the REAL `parseProductSpec` chain
 * (YAML → guardrails → strict shape → lint incl. source/contract separation + conformance) and the
 * REAL `mountProductViews` compile; the read surface is the REAL-CONSTRAINT-enforcing fake
 * (tenant-partitioned, fail-closed store/column resolution — a fake must reproduce the real
 * constraint). Product shapes live ONLY in the fixture YAML + seeds — never in the runtime.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isHttpResponse, type RouteHandlerInit } from '@rayspec/handler-sdk';
import { parseProductSpec, type StoreSpec } from '@rayspec/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { type MountedProductViews, mountProductViews } from './index.js';
import { FakeReadSurface } from './test-support/fake-read-surface.js';

const TENANT_A = '00000000-0000-0000-0000-0000000000aa';
const TENANT_B = '00000000-0000-0000-0000-0000000000bb';

// The product-shaped stores (TEST fixture data — the runtime knows none of these names).
const STORES: StoreSpec[] = [
  {
    name: 'note_sessions',
    columns: [
      { name: 'session_id', type: 'text', nullable: false, unique: false },
      { name: 'session_ref', type: 'text', nullable: false, unique: false },
      { name: 'status', type: 'text', nullable: false, unique: false },
      { name: 'protocol_version', type: 'integer', nullable: false, unique: false },
    ],
    foreignKeys: [],
  },
  {
    name: 'note_tracks',
    columns: [
      { name: 'session_id', type: 'text', nullable: false, unique: false },
      { name: 'track', type: 'text', nullable: false, unique: false },
      { name: 'status', type: 'text', nullable: false, unique: false },
      { name: 'persisted_chunk_count', type: 'integer', nullable: false, unique: false },
      { name: 'committed_byte_len', type: 'integer', nullable: false, unique: false },
      { name: 'track_ref', type: 'text', nullable: false, unique: false },
    ],
    foreignKeys: [],
  },
  {
    name: 'track_transcripts',
    columns: [
      { name: 'session_id', type: 'text', nullable: false, unique: false },
      { name: 'track', type: 'text', nullable: false, unique: false },
      { name: 'track_ref', type: 'text', nullable: false, unique: false },
      { name: 'status', type: 'text', nullable: false, unique: false },
      { name: 'model', type: 'text', nullable: true, unique: false },
      { name: 'detected_language', type: 'text', nullable: true, unique: false },
      { name: 'full_text', type: 'text', nullable: true, unique: false },
      { name: 'word_count', type: 'integer', nullable: true, unique: false },
      { name: 'payload', type: 'jsonb', nullable: true, unique: false },
    ],
    foreignKeys: [],
  },
  {
    name: 'note_artifacts',
    columns: [
      { name: 'session_id', type: 'text', nullable: false, unique: false },
      { name: 'artifact_kind', type: 'text', nullable: false, unique: false },
      { name: 'payload', type: 'jsonb', nullable: false, unique: false },
      { name: 'dismissed', type: 'boolean', nullable: false, unique: false },
      { name: 'human_edited', type: 'boolean', nullable: false, unique: false },
      { name: 'artifact_ref', type: 'text', nullable: false, unique: false },
    ],
    foreignKeys: [],
  },
];

function loadFixtureSpec() {
  const yaml = readFileSync(
    fileURLToPath(new URL('./__fixtures__/acme-notes-views.product.yaml', import.meta.url)),
    'utf8',
  );
  const res = parseProductSpec(yaml);
  if (!res.ok) {
    throw new Error(`fixture must parse:\n${JSON.stringify(res.errors, null, 2)}`);
  }
  return res.value;
}

/** Call a mounted view handler directly (unit level — the seam test drives the real HTTP chain). */
async function call(
  mounted: MountedProductViews,
  surface: FakeReadSurface,
  viewId: string,
  tenantId: string,
  params: Record<string, string>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const handlerId = mounted.handlerIds.get(viewId);
  if (!handlerId) throw new Error(`view '${viewId}' not mounted`);
  const handler = mounted.handlers.get(handlerId);
  if (!handler) throw new Error(`handler '${handlerId}' not found`);
  const init = {
    tenantId,
    db: surface.forTenant(tenantId),
    params,
    ...(headers ? { headers } : {}),
  } as unknown as RouteHandlerInit;
  const result = await handler.fn(init);
  if (isHttpResponse(result)) {
    return {
      status: result.status ?? 200,
      body: result.body,
      headers: { ...(result.headers ?? {}) },
    };
  }
  return { status: 200, body: result, headers: {} };
}

describe('the golden contracts are CLOSED, so the shape⊆contract pass has TEETH end-to-end', () => {
  const bindings = new Map([['note_artifacts', { store: 'note_artifacts' }]]);

  function mountMutated(mutate: (views: ReturnType<typeof loadFixtureSpec>['views']) => void) {
    const spec = loadFixtureSpec();
    const views = structuredClone(spec.views) as typeof spec.views;
    mutate(views);
    return () =>
      mountProductViews({
        views,
        contracts: spec.contracts,
        artifacts: spec.artifacts,
        capabilities: spec.capabilities,
        stores: STORES,
        artifactBindings: bindings,
      });
  }

  /** Reach into a shape's fields (the fixture is parsed data — plain objects). */
  function fieldsOf(shape: unknown): Record<string, unknown> {
    return (shape as { fields: Record<string, unknown> }).fields;
  }

  it('a BOGUS field projected into the session page-item shape FAILS the mount (sessions.items is closed)', () => {
    // Red-first: with the fixture's `sessions.items: {type: object}` OPEN node this mounted
    // fine — the conformance pass was a NO-OP on the richest golden shape.
    const mount = mountMutated((views) => {
      const list = views.find((v) => v.id === 'session_list');
      if (!list?.read) throw new Error('fixture must declare session_list.read');
      const pageItems = fieldsOf(list.read.shape).sessions as { shape: unknown };
      fieldsOf(pageItems.shape).bogus_field = { kind: 'const', value: 1 };
    });
    expect(mount).toThrow(/bogus_field/);
  });

  it('a BOGUS field projected into the nested TRACK shape fails too (tracks.items is closed)', () => {
    const mount = mountMutated((views) => {
      const list = views.find((v) => v.id === 'session_list');
      if (!list?.read) throw new Error('fixture must declare session_list.read');
      const pageItems = fieldsOf(list.read.shape).sessions as { shape: unknown };
      const tracks = fieldsOf(pageItems.shape).tracks as { shape: unknown };
      fieldsOf(tracks.shape).bogus_track_field = { kind: 'const', value: 1 };
    });
    expect(mount).toThrow(/bogus_track_field/);
  });

  it('a MIS-TYPED session leaf fails conformance (admitted types are enforced on the closed node)', () => {
    const mount = mountMutated((views) => {
      const list = views.find((v) => v.id === 'session_list');
      if (!list?.read) throw new Error('fixture must declare session_list.read');
      const pageItems = fieldsOf(list.read.shape).sessions as { shape: unknown };
      // protocol_version is contract-declared integer; a string const is a pure CONFORMANCE
      // violation (no column involved — the column-type checks cannot catch it).
      fieldsOf(pageItems.shape).protocol_version = { kind: 'const', value: 'not-an-int' };
    });
    expect(mount).toThrow(/protocol_version/);
  });

  it('dropping a REQUIRED session field fails conformance (required coverage on the closed node)', () => {
    const mount = mountMutated((views) => {
      const list = views.find((v) => v.id === 'session_list');
      if (!list?.read) throw new Error('fixture must declare session_list.read');
      const pageItems = fieldsOf(list.read.shape).sessions as { shape: unknown };
      delete fieldsOf(pageItems.shape).note_counts;
    });
    expect(mount).toThrow(/note_counts/);
  });
});

describe('the neutral read surface, declared + interpreted', () => {
  const spec = loadFixtureSpec();
  let surface: FakeReadSurface;
  let mounted: MountedProductViews;

  beforeEach(() => {
    surface = new FakeReadSurface(STORES);
    mounted = mountProductViews({
      views: spec.views,
      contracts: spec.contracts,
      artifacts: spec.artifacts,
      capabilities: spec.capabilities,
      stores: STORES,
      artifactBindings: new Map([['note_artifacts', { store: 'note_artifacts' }]]),
    });
  });

  /** The session-list seeds. */
  function seedSessionList(tenant: string): void {
    const seeds = [
      { id: 's-a', created_at: '2026-07-01T10:00:00.000Z' },
      { id: 's-b', created_at: '2026-07-01T11:00:00.000Z' },
      { id: 's-c', created_at: '2026-07-01T12:00:00.000Z' },
    ];
    for (const s of seeds) {
      surface.seed(tenant, 'note_sessions', {
        session_id: s.id,
        session_ref: `${tenant}:${s.id}`,
        status: 'active',
        protocol_version: 2,
        created_at: s.created_at,
      });
      surface.seed(tenant, 'note_tracks', {
        session_id: s.id,
        track: 'mic',
        status: 'recording',
        persisted_chunk_count: 3,
        committed_byte_len: 24,
        track_ref: `${tenant}:${s.id}:mic`,
        created_at: s.created_at,
      });
    }
    surface.seed(tenant, 'track_transcripts', {
      session_id: 's-c',
      track: 'mic',
      track_ref: `${tenant}:s-c:mic`,
      status: 'completed',
      word_count: 5,
      detected_language: 'en',
      payload: { segments: [{ text: 'Hi.', start: 0 }] },
    });
    surface.seed(tenant, 'note_artifacts', {
      session_id: 's-c',
      artifact_kind: 'item',
      payload: { text: 'x', evidence_span_ids: ['mic:s0'] },
      dismissed: false,
      human_edited: false,
      artifact_ref: `${tenant}:s-c:item:0`,
    });
  }

  it('session-list: the full nested golden shape, newest-first, with the exact note tally', async () => {
    seedSessionList(TENANT_A);
    const res = await call(mounted, surface, 'session_list', TENANT_A, {});
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.total).toBe(3);
    expect(body.next_offset).toBeNull();
    const sessions = body.sessions as Array<Record<string, unknown>>;
    expect(sessions.map((s) => s.id)).toEqual(['s-c', 's-b', 's-a']); // newest-first

    // The FIRST session, field-for-field (the golden assertions, deep).
    const first = sessions[0] as Record<string, unknown>;
    expect(first.status).toBe('active');
    expect(first.protocol_version).toBe(2);
    expect(first.started_at).toBe('2026-07-01T12:00:00.000Z');
    expect(first.ended_at).toBeNull();
    expect(first.artifacts).toEqual([]); // ALWAYS [] (no file-artifacts)
    expect(first.note_counts).toEqual({
      item: 1,
      pointer: 0,
      query: 0,
      label: 0,
      digest: 0,
      total: 1,
    });
    const tracks = first.tracks as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(1);
    const track = tracks[0] as Record<string, unknown>;
    expect(track).toEqual({
      id: track.id, // the injected row id (a real value — asserted non-empty below)
      track: 'mic',
      status: 'recording',
      sample_rate: null,
      channels: null,
      sample_format: null,
      sample_width_bytes: null,
      bytes_written: 24,
      chunks_written: 3,
      malformed_chunks: null,
      frames_written: null,
      duration_wall_seconds: null,
      disconnect_reason: null,
      started_at: '2026-07-01T12:00:00.000Z',
      ended_at: null,
      transcript_status: 'completed',
      transcript_word_count: 5,
      transcript_language: 'en',
    });
    expect(typeof track.id).toBe('string');
    expect((track.id as string).length).toBeGreaterThan(0);

    // A session WITHOUT a transcript reports 'absent' + null word count/language.
    const last = sessions[2] as Record<string, unknown>;
    const lastTrack = (last.tracks as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(lastTrack.transcript_status).toBe('absent');
    expect(lastTrack.transcript_word_count).toBeNull();
    expect(lastTrack.transcript_language).toBeNull();
  });

  it('session-list: pagination pages newest-first and exposes next_offset', async () => {
    seedSessionList(TENANT_A);
    const page1 = await call(mounted, surface, 'session_list', TENANT_A, { limit: '2' });
    const p1 = page1.body as Record<string, unknown>;
    expect((p1.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['s-c', 's-b']);
    expect(p1.next_offset).toBe(2);
    const page2 = await call(mounted, surface, 'session_list', TENANT_A, {
      limit: '2',
      offset: '2',
    });
    const p2 = page2.body as Record<string, unknown>;
    expect((p2.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['s-a']);
    expect(p2.next_offset).toBeNull();
  });

  it('session-list: the CLAMP law (limit=0 → default, huge → max, negative offset → 0)', async () => {
    seedSessionList(TENANT_A);
    const clampLow = await call(mounted, surface, 'session_list', TENANT_A, { limit: '0' });
    expect(((clampLow.body as Record<string, unknown>).sessions as unknown[]).length).toBe(3);
    const clampHigh = await call(mounted, surface, 'session_list', TENANT_A, { limit: '99999' });
    expect(((clampHigh.body as Record<string, unknown>).sessions as unknown[]).length).toBe(3);
    const clampNeg = await call(mounted, surface, 'session_list', TENANT_A, { offset: '-5' });
    expect(
      ((clampNeg.body as Record<string, unknown>).sessions as Array<{ id: string }>)[0]?.id,
    ).toBe('s-c');
  });

  /** The transcript seed. */
  function seedTranscript(tenant: string): void {
    surface.seed(tenant, 'track_transcripts', {
      session_id: 'sess-short',
      track: 'mic',
      track_ref: `${tenant}:sess-short:mic`,
      status: 'completed',
      model: 'nova-2',
      detected_language: 'en',
      full_text: 'We decided to ship the baseline.',
      word_count: 7,
      payload: {
        duration: 1000,
        confidence: 0.97,
        words: [{ word: 'We', start: 0, end: 0.2, confidence: 0.98 }],
        segments: [{ text: 'We decided to ship the baseline.', start: 0, end: 1000 }],
      },
    });
  }

  it('transcript-get: the full golden shape (punctuated_word == word, speaker null, billed_duration_seconds)', async () => {
    seedTranscript(TENANT_A);
    const res = await call(mounted, surface, 'session_track_transcript', TENANT_A, {
      session_id: 'sess-short',
      track: 'mic',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      session_id: 'sess-short',
      track: 'mic',
      status: 'completed',
      model: 'nova-2',
      detected_language: 'en',
      full_text: 'We decided to ship the baseline.',
      confidence: 0.97,
      word_count: 7,
      billed_duration_seconds: 1000,
      words: [
        { word: 'We', punctuated_word: 'We', start: 0, end: 0.2, confidence: 0.98, speaker: null },
      ],
      segments: [{ start: 0, end: 1000, text: 'We decided to ship the baseline.' }],
    });
  });

  it('transcript-get: the ABSENT 200 shape (never a 404 — the client polls)', async () => {
    seedTranscript(TENANT_A);
    const res = await call(mounted, surface, 'session_track_transcript', TENANT_A, {
      session_id: 'sess-short',
      track: 'system',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      session_id: 'sess-short',
      track: 'system',
      status: 'absent',
      model: null,
      detected_language: null,
      full_text: null,
      confidence: null,
      word_count: 0,
      billed_duration_seconds: null,
      words: [],
      segments: [],
    });
  });

  it('transcript-get: ETag on the 200 + If-None-Match → bodyless 304 (declared conditional read)', async () => {
    seedTranscript(TENANT_A);
    const params = { session_id: 'sess-short', track: 'mic' };
    const first = await call(mounted, surface, 'session_track_transcript', TENANT_A, params);
    const etag = first.headers.ETag;
    expect(typeof etag).toBe('string');
    expect(etag?.startsWith('"')).toBe(true);
    const second = await call(mounted, surface, 'session_track_transcript', TENANT_A, params, {
      'if-none-match': etag as string,
    });
    expect(second.status).toBe(304);
    expect(second.body).toBeUndefined();
    expect(second.headers.ETag).toBe(etag);
    // A NON-matching validator serves the full 200 again.
    const third = await call(mounted, surface, 'session_track_transcript', TENANT_A, params, {
      'if-none-match': '"deadbeef"',
    });
    expect(third.status).toBe(200);
  });

  it('transcript-get: malformed params → the 400 contract', async () => {
    const badTrack = await call(mounted, surface, 'session_track_transcript', TENANT_A, {
      session_id: 'sess-short',
      track: 'other',
    });
    expect(badTrack.status).toBe(400);
    expect((badTrack.body as Record<string, unknown>).error).toBe('bad_request');
    const badSession = await call(mounted, surface, 'session_track_transcript', TENANT_A, {
      session_id: 'has space',
      track: 'mic',
    });
    expect(badSession.status).toBe(400);
    expect((badSession.body as Record<string, unknown>).error).toBe('bad_request');
  });

  /** The notes seeds (digest + item + a DISMISSED pointer). */
  function seedNotes(tenant: string): void {
    surface.seed(tenant, 'note_artifacts', {
      session_id: 'sess-short',
      artifact_kind: 'digest',
      payload: {
        headline: 'Frozen.',
        detail: 'The session freezes current behavior.',
        output_language: 'en',
      },
      dismissed: false,
      human_edited: false,
      artifact_ref: `${tenant}:sess-short:digest:0`,
    });
    surface.seed(tenant, 'note_artifacts', {
      session_id: 'sess-short',
      artifact_kind: 'item',
      payload: { text: 'Freeze baseline.', evidence: ['mic:s0'] },
      dismissed: false,
      human_edited: false,
      artifact_ref: `${tenant}:sess-short:item:0`,
    });
    surface.seed(tenant, 'note_artifacts', {
      session_id: 'sess-short',
      artifact_kind: 'pointer',
      payload: { text: 'Hidden dismissed item.', evidence: ['mic:s0'] },
      dismissed: true,
      human_edited: false,
      artifact_ref: `${tenant}:sess-short:pointer:0`,
    });
  }

  it('notes-get: grouped kinds, the DISMISSED row excluded, exact counts', async () => {
    seedNotes(TENANT_A);
    const res = await call(mounted, surface, 'session_notes', TENANT_A, {
      session_id: 'sess-short',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      session_id: 'sess-short',
      digest: {
        headline: 'Frozen.',
        detail: 'The session freezes current behavior.',
        output_language: 'en',
      },
      items: [{ text: 'Freeze baseline.', evidence: ['mic:s0'] }],
      pointers: [], // the dismissed row NEVER surfaces
      queries: [],
      labels: [],
      counts: { item: 1, pointer: 0, query: 0, label: 0, digest: 1, total: 2 },
    });
  });

  it('notes-get: the ABSENT (never-processed) 200 shape with zeroed counts', async () => {
    const res = await call(mounted, surface, 'session_notes', TENANT_A, {
      session_id: 'sess-never-processed',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      session_id: 'sess-never-processed',
      digest: null,
      items: [],
      pointers: [],
      queries: [],
      labels: [],
      counts: { item: 0, pointer: 0, query: 0, label: 0, digest: 0, total: 0 },
    });
  });

  it('CROSS-TENANT: tenant B NEVER sees tenant A rows through ANY of the three views (the whole invariant)', async () => {
    seedSessionList(TENANT_A);
    seedTranscript(TENANT_A);
    seedNotes(TENANT_A);
    // B has its own single session, so "B sees only B" is provable (not just "B sees nothing").
    surface.seed(TENANT_B, 'note_sessions', {
      session_id: 'b-only',
      session_ref: `${TENANT_B}:b-only`,
      status: 'active',
      protocol_version: 2,
      created_at: '2026-07-01T09:00:00.000Z',
    });

    // 1. session-list: B's list contains ONLY b-only — zero of A's three sessions.
    const bList = await call(mounted, surface, 'session_list', TENANT_B, {});
    const bSessions = (bList.body as Record<string, unknown>).sessions as Array<{ id: string }>;
    expect(bSessions.map((s) => s.id)).toEqual(['b-only']);
    expect((bList.body as Record<string, unknown>).total).toBe(1);

    // 2. transcript-get: A's transcript is INVISIBLE to B (the absent shape, not A's data).
    const bTranscript = await call(mounted, surface, 'session_track_transcript', TENANT_B, {
      session_id: 'sess-short',
      track: 'mic',
    });
    expect(bTranscript.status).toBe(200);
    expect((bTranscript.body as Record<string, unknown>).status).toBe('absent');
    expect((bTranscript.body as Record<string, unknown>).full_text).toBeNull();

    // 3. notes-get: A's artifacts are INVISIBLE to B (zeroed counts, empty groups).
    const bNotes = await call(mounted, surface, 'session_notes', TENANT_B, {
      session_id: 'sess-short',
    });
    expect((bNotes.body as Record<string, unknown>).digest).toBeNull();
    expect(((bNotes.body as Record<string, unknown>).counts as Record<string, number>).total).toBe(
      0,
    );

    // ... and A still sees exactly A's data (the partition cuts both ways).
    const aList = await call(mounted, surface, 'session_list', TENANT_A, {});
    const aSessions = (aList.body as Record<string, unknown>).sessions as Array<{ id: string }>;
    expect(aSessions.map((s) => s.id)).toEqual(['s-c', 's-b', 's-a']);
    expect(aSessions.some((s) => s.id === 'b-only')).toBe(false);
  });
});
