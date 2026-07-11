/**
 * the DECLARATIVE VIEWS ↔ platform SEAM, composed END-TO-END and DB-backed through the REAL
 * createAuthApp chain (the pattern). The views runtime mounts on its own; this proves the
 * COMPOSITION: Product-YAML view declarations (parsed by the REAL `parseProductSpec` from the
 * views-runtime golden fixture) → `mountProductViews` → the declared-routes engine → REAL routes on
 * the standard `requireAuth → resolveTenant → requirePermission` chain → `invokeRouteHandler` inside
 * `TenantDb.transaction()` → REAL product tables in an isolated per-suite schema.
 *
 * Proves (fail-the-fix, ground truth, not pass-the-shape):
 *  1. The neutral read goldens (session-list nested shape + pagination clamps; transcript incl.
 *     absent-200; notes incl. dismissed-exclusion + exact counts) reproduce over REAL Postgres rows
 *     through REAL HTTP requests.
 *  2. CROSS-TENANT (CI-blocking): tenant B NEVER reads tenant A's rows through ANY declared view —
 *     the WHOLE invariant (B's list carries ONLY B's row; A's transcript/notes are the absent/zeroed
 *     shapes for B; A still sees exactly A's data) — enforced by the STRUCTURAL TenantDb predicate
 *     underneath the interpreter, not by the view declarations.
 *  3. DENY-BY-DEFAULT: an unauthenticated request to a declared view is 401 — the views mount put
 *     the route behind the same platform chain every route uses.
 *  4. The CONDITIONAL READ works END-TO-END: the ETag from a real 200 turns a real If-None-Match
 *     request into a real bodyless 304 (the handler-sdk headers seam + the engine's null-body-status
 *     emission, composed).
 *  5. The 400 param contract through the real route.
 *
 * Skips when DATABASE_URL is absent — but HARD-FAILS if the DB is required (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) yet absent, so this SECURITY-load-bearing suite can never silently
 * self-skip to a false green (the gen-handler-loop.db.test.ts ran-guard pattern).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forTenant } from '@rayspec/db';
import { makeHandlerDb, type ResolvedHandler, type RouteHandlerInit } from '@rayspec/platform';
import type { RaySpec, StoreSpec } from '@rayspec/spec';
import { parseProductSpec } from '@rayspec/spec';
import { mountProductViews } from '@rayspec/views-runtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: a DB-backed CROSS-TENANT suite that self-skips without DATABASE_URL
// is a false-green hazard. When the DB is REQUIRED but absent, hard-fail at collection, never skip.
if (requireDb && !hasDb) {
  throw new Error(
    'views-seam.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the views cross-tenant composition suite.',
  );
}

/** The product-shaped stores (throwaway fixture — the platform ships product-empty). */
const STORES: StoreSpec[] = [
  {
    name: 'note_sessions',
    columns: [
      { name: 'session_id', type: 'text', nullable: false, unique: false },
      { name: 'session_ref', type: 'text', nullable: false, unique: true },
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
      { name: 'track_ref', type: 'text', nullable: false, unique: true },
    ],
    foreignKeys: [],
  },
  {
    name: 'track_transcripts',
    columns: [
      { name: 'session_id', type: 'text', nullable: false, unique: false },
      { name: 'track', type: 'text', nullable: false, unique: false },
      { name: 'track_ref', type: 'text', nullable: false, unique: true },
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
      { name: 'artifact_ref', type: 'text', nullable: false, unique: true },
    ],
    foreignKeys: [],
  },
];

/** The ONE golden view-declaration fixture (shared with the views-runtime unit suite — no drift). */
function loadViewsSpec() {
  const yaml = readFileSync(
    fileURLToPath(
      new URL(
        '../../../../workflow/nodes/views-runtime/src/__fixtures__/acme-notes-views.product.yaml',
        import.meta.url,
      ),
    ),
    'utf8',
  );
  const res = parseProductSpec(yaml);
  if (!res.ok) throw new Error(`views fixture must parse:\n${JSON.stringify(res.errors, null, 2)}`);
  return res.value;
}

describe.skipIf(!hasDb)('declared views through the REAL platform chain, DB-backed', () => {
  let h: Harness;

  beforeAll(async () => {
    const product = loadViewsSpec();
    const mounted = mountProductViews({
      views: product.views,
      contracts: product.contracts,
      artifacts: product.artifacts,
      capabilities: product.capabilities,
      stores: STORES,
      artifactBindings: new Map([['note_artifacts', { store: 'note_artifacts' }]]),
    });
    // probe: a `{handler}` route that ECHOES its `init.headers` back — the ground-truth view
    // of exactly which request headers cross the platform seam into a product handler.
    const handlers = new Map<string, ResolvedHandler>(
      mounted.handlers as ReadonlyMap<string, ResolvedHandler>,
    );
    handlers.set('probe_headers', {
      kind: 'route',
      fn: async (init: RouteHandlerInit) => ({ headers: init.headers ?? null }),
    } as ResolvedHandler);
    const engineSpec: RaySpec = {
      version: '1.0',
      metadata: { name: 'views-seam-test' },
      stores: STORES,
      api: [
        ...mounted.api,
        {
          method: 'GET',
          path: '/probe-headers',
          action: { kind: 'handler', handler: 'probe_headers' },
        },
      ],
      agents: [],
      tooling: [],
      triggers: [],
      handlers: [],
      extensions: [],
    };
    h = await createHarness({
      engineSpec,
      engineHandlers: handlers,
      schema: 'rayspec_test_views_d3',
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  /** Register → org → switch (member: store:read/write). Returns the org id + bearer token. */
  async function principal(
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
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
    return { orgId, token };
  }

  /** Seed through the REAL tenant-bound HandlerDb facade (server-stamped tenant — the product path). */
  function seederFor(orgId: string) {
    const engine = h.deps.engine;
    if (!engine) throw new Error('engine not wired');
    return makeHandlerDb(forTenant(h.db, orgId), engine.productTables);
  }

  async function seedGoldenData(orgId: string): Promise<void> {
    const db = seederFor(orgId);
    // Three sessions, oldest→newest (the view orders newest-first by the injected created_at; the
    // insert order gives created_at monotonicity via now() — assert relative order only).
    for (const sid of ['s-a', 's-b', 's-c']) {
      await db.insert('note_sessions', {
        session_id: sid,
        session_ref: `${orgId}:${sid}`,
        status: 'active',
        protocol_version: 2,
      });
      await db.insert('note_tracks', {
        session_id: sid,
        track: 'mic',
        status: 'recording',
        persisted_chunk_count: 3,
        committed_byte_len: 24,
        track_ref: `${orgId}:${sid}:mic`,
      });
      // now() has microsecond resolution; a tiny spacer keeps created_at strictly monotonic even on
      // a fast machine (the ordering golden depends on distinct timestamps).
      await new Promise((r) => setTimeout(r, 5));
    }
    await db.insert('track_transcripts', {
      session_id: 's-c',
      track: 'mic',
      track_ref: `${orgId}:s-c:mic`,
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
    await db.insert('note_artifacts', {
      session_id: 's-c',
      artifact_kind: 'digest',
      payload: {
        headline: 'Frozen.',
        detail: 'The session freezes current behavior.',
        output_language: 'en',
      },
      dismissed: false,
      human_edited: false,
      artifact_ref: `${orgId}:s-c:digest:0`,
    });
    await db.insert('note_artifacts', {
      session_id: 's-c',
      artifact_kind: 'item',
      payload: { text: 'Freeze baseline.', evidence: ['mic:s0'] },
      dismissed: false,
      human_edited: false,
      artifact_ref: `${orgId}:s-c:item:0`,
    });
    await db.insert('note_artifacts', {
      session_id: 's-c',
      artifact_kind: 'pointer',
      payload: { text: 'Hidden dismissed item.', evidence: ['mic:s0'] },
      dismissed: true,
      human_edited: false,
      artifact_ref: `${orgId}:s-c:pointer:0`,
    });
  }

  const get = (path: string, token?: string, headers?: Record<string, string>) =>
    h.app.request(path, {
      method: 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers ?? {}),
      },
    });

  it('session-list golden through the REAL route: nested shape, newest-first, clamps', async () => {
    const a = await principal('views-list@example.com', 'ViewsList');
    await seedGoldenData(a.orgId);

    const res = await get('/sessions', a.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.total).toBe(3);
    expect(body.next_offset).toBeNull();
    const sessions = body.sessions as Array<Record<string, unknown>>;
    expect(sessions.map((s) => s.id)).toEqual(['s-c', 's-b', 's-a']);

    const first = sessions[0] as Record<string, unknown>;
    expect(first.status).toBe('active');
    expect(first.protocol_version).toBe(2);
    expect(typeof first.started_at).toBe('string'); // the REAL injected created_at, ISO-serialized
    expect(first.ended_at).toBeNull();
    expect(first.artifacts).toEqual([]);
    expect(first.note_counts).toEqual({
      item: 1,
      pointer: 1, // session-list tallies dismissed rows too (the all-rows tally)
      query: 0,
      label: 0,
      digest: 1,
      total: 3,
    });
    const track = (first.tracks as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(track.track).toBe('mic');
    expect(track.bytes_written).toBe(24);
    expect(track.chunks_written).toBe(3);
    expect(track.sample_rate).toBeNull();
    expect(track.transcript_status).toBe('completed');
    expect(track.transcript_word_count).toBe(7);
    expect(track.transcript_language).toBe('en');
    const lastTrack = (
      (sessions[2] as Record<string, unknown>).tracks as Array<Record<string, unknown>>
    )[0] as Record<string, unknown>;
    expect(lastTrack.transcript_status).toBe('absent');

    // The frozen clamp law over the real route.
    const page1 = (await (await get('/sessions?limit=2', a.token)).json()) as Record<
      string,
      unknown
    >;
    expect((page1.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['s-c', 's-b']);
    expect(page1.next_offset).toBe(2);
    const clampLow = (await (await get('/sessions?limit=0', a.token)).json()) as Record<
      string,
      unknown
    >;
    expect((clampLow.sessions as unknown[]).length).toBe(3);
    const clampNeg = (await (await get('/sessions?offset=-5', a.token)).json()) as Record<
      string,
      unknown
    >;
    expect((clampNeg.sessions as Array<{ id: string }>)[0]?.id).toBe('s-c');
  });

  it('transcript golden + REAL 304 conditional read + the 400 contract', async () => {
    const a = await principal('views-tx@example.com', 'ViewsTx');
    await seedGoldenData(a.orgId);

    const res = await get('/sessions/s-c/mic/transcript', a.token);
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(await res.json()).toEqual({
      session_id: 's-c',
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

    // The REAL 304: If-None-Match with the served ETag → bodyless 304 carrying the same ETag.
    const cached = await get('/sessions/s-c/mic/transcript', a.token, {
      'if-none-match': etag as string,
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('etag')).toBe(etag);
    expect(await cached.text()).toBe('');

    // The ABSENT-transcript 200 (never a 404) through the real route.
    const absent = await get('/sessions/s-c/system/transcript', a.token);
    expect(absent.status).toBe(200);
    const absentBody = (await absent.json()) as Record<string, unknown>;
    expect(absentBody.status).toBe('absent');
    expect(absentBody.word_count).toBe(0);
    expect(absentBody.words).toEqual([]);

    // The 400 contract (an out-of-enum track).
    const bad = await get('/sessions/s-c/other/transcript', a.token);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Record<string, unknown>).error).toBe('bad_request');
  });

  it('notes golden: dismissed excluded, exact counts, absent zeroed', async () => {
    const a = await principal('views-notes@example.com', 'ViewsNotes');
    await seedGoldenData(a.orgId);

    const res = await get('/sessions/s-c/notes', a.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      session_id: 's-c',
      digest: {
        headline: 'Frozen.',
        detail: 'The session freezes current behavior.',
        output_language: 'en',
      },
      items: [{ text: 'Freeze baseline.', evidence: ['mic:s0'] }],
      pointers: [], // the DISMISSED row never surfaces
      queries: [],
      labels: [],
      counts: { item: 1, pointer: 0, query: 0, label: 0, digest: 1, total: 2 },
    });

    const absent = await get('/sessions/never-processed/notes', a.token);
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({
      session_id: 'never-processed',
      digest: null,
      items: [],
      pointers: [],
      queries: [],
      labels: [],
      counts: { item: 0, pointer: 0, query: 0, label: 0, digest: 0, total: 0 },
    });
  });

  it('CROSS-TENANT (CI-blocking): tenant B NEVER reads tenant A rows through ANY declared view', async () => {
    const a = await principal('views-xt-a@example.com', 'ViewsXtA');
    const b = await principal('views-xt-b@example.com', 'ViewsXtB');
    await seedGoldenData(a.orgId);
    // B's OWN row — so "B sees only B" is provable (not just "B sees nothing").
    const bdb = seederFor(b.orgId);
    await bdb.insert('note_sessions', {
      session_id: 'b-only',
      session_ref: `${b.orgId}:b-only`,
      status: 'active',
      protocol_version: 2,
    });

    // 1. session-list: B's list is EXACTLY [b-only] — zero of A's three sessions.
    const bList = (await (await get('/sessions', b.token)).json()) as Record<string, unknown>;
    expect((bList.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['b-only']);
    expect(bList.total).toBe(1);

    // 2. transcript: A's transcript row is INVISIBLE to B (absent shape, not A's data).
    const bTx = (await (await get('/sessions/s-c/mic/transcript', b.token)).json()) as Record<
      string,
      unknown
    >;
    expect(bTx.status).toBe('absent');
    expect(bTx.full_text).toBeNull();

    // 3. notes: A's artifacts are INVISIBLE to B (zeroed).
    const bNotes = (await (await get('/sessions/s-c/notes', b.token)).json()) as Record<
      string,
      unknown
    >;
    expect(bNotes.digest).toBeNull();
    expect((bNotes.counts as Record<string, number>).total).toBe(0);

    // 4. ... and A still sees exactly A's data (the predicate cuts both ways).
    const aList = (await (await get('/sessions', a.token)).json()) as Record<string, unknown>;
    expect((aList.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual([
      's-c',
      's-b',
      's-a',
    ]);
    expect((aList.sessions as Array<{ id: string }>).some((s) => s.id === 'b-only')).toBe(false);
  });

  it('(fail-the-fix): ONLY allowlisted request headers reach a product handler — credentials NEVER', async () => {
    // Genuine fail-the-fix: reverting the collectHeaders ALLOWLIST (or re-adding `authorization` to
    // the forwarded set) turns the credential/x-custom absences below RED. The original strip-only
    // implementation leaked `proxy-authorization` and every unknown header — this test proved it red
    // before the allowlist landed.
    const a = await principal('views-headers@example.com', 'ViewsHeaders');
    const res = await h.app.request('/probe-headers', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${a.token}`,
        cookie: 'session=supersecret',
        'proxy-authorization': 'Basic dXNlcjpwYXNz',
        'if-none-match': '"tag-123"',
        accept: 'application/json',
        'x-custom-header': 'must-not-pass',
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { headers: Record<string, string> | null };
    const headers = body.headers ?? {};
    // The allowlisted conditional-read / content-negotiation headers PASS THROUGH:
    expect(headers['if-none-match']).toBe('"tag-123"');
    expect(headers.accept).toBe('application/json');
    // Credentials are ABSENT — every one of them, not just the two literal strip targets:
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers['proxy-authorization']).toBeUndefined();
    // Anything OUTSIDE the allowlist never reaches a product handler:
    expect(headers['x-custom-header']).toBeUndefined();
  });

  it('DENY-BY-DEFAULT: unauthenticated requests to EVERY declared view are 401', async () => {
    for (const path of ['/sessions', '/sessions/s-c/mic/transcript', '/sessions/s-c/notes']) {
      const res = await get(path);
      expect(res.status, `expected 401 for unauthenticated ${path}`).toBe(401);
    }
  });
});
