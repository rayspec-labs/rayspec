/**
 * `GET /v1/subscribe` — the tenant-scoped SSE subscription surface, DB-backed and driven through the
 * REAL createAuthApp + declared-route interpreter, asserted on WHAT A SUBSCRIBER RECEIVES.
 *
 * The resume protocol is where a feature like this fails, and it fails SILENTLY: every version of it
 * that was built delivered a stream that looked healthy and had holes in it. So the rules below are
 * each pinned by a test, and the resume proof is driven with genuinely CONCURRENT emits — a
 * sequential emit would pass on a design that drops frames the moment two writers overlap.
 *
 *  WAKE-DRIVEN suite (a real process LISTEN, poll interval parked at 30s so ONLY the notify can
 *  deliver — if the wake did not work, every one of these would time out):
 *   - COUNTERPROOF — an event emitted AFTER the subscriber connected arrives.
 *   - RESUME under concurrency — a subscriber that disconnects mid-flight and reconnects with its last
 *     id receives exactly the events it missed: none skipped, none duplicated, in seq order.
 *   - R3 — an OMITTED `topics` delivers every topic; a filter delivers only its topics and still
 *     advances past the ones it skipped; an EXPLICITLY EMPTY `?topics=` is a 400.
 *   - R4 — a cursor tagged with another tenant is refused, and cross-tenant delivery is impossible.
 *   - R5 — a FRESH subscriber on a stream with a non-zero retention floor gets NO truncation signal.
 *   - R6 — a cursor above the high-water mark is refused, not served as an empty stream.
 *   - TRUNCATION — a cursor retained away produces the control frame (which carries NO `id:`, so it
 *     can never come back as a cursor) and the subscriber recovers and receives what survived.
 *
 *  POLL-DRIVEN suite (NO wake wired at all — the posture where every notify is lost):
 *   - delivery still happens, on the subscriber's own read;
 *   - R2 — the floor is re-checked on EVERY read: retention that runs while a subscriber sits idle
 *     reaches it as a truncation frame, not as a hole.
 *
 *  LIFETIME suite (the cap set by the access-token TTL):
 *   - the cap CLOSES the stream, and the reconnect the client must make re-runs the whole auth chain.
 *
 *  ACCEPT CONTROL (no bus enabled): the route fail-closes 501 and reads nothing.
 *
 * Skips when DATABASE_URL is absent; HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * but absent — this suite proves a delivery contract and must never self-skip to a false green.
 */
import type { Db } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import type { ResolvedHandler } from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTenantEventBus } from '../engine/event-bus.js';
import { makeTenantEventWake, type TenantEventWakeHub } from '../engine/event-wake.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'subscribe.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip an event-delivery suite.',
  );
}

/** A throwaway backend whose one `{handler}` route emits whatever the request body lists. */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: subscribe-surface-backend
  description: A throwaway backend whose {handler} route emits onto the tenant event stream.
deployment:
  eventBus:
    enabled: true
handlers:
  - id: emit_handler
    module: handlers/emit.ts
    export: emit
    kind: route
api:
  - method: POST
    path: /emit
    action:
      kind: handler
      handler: emit_handler
`;

function buildSpec(): RaySpec {
  const parsed = parseSpec(SPEC_YAML);
  if (!parsed.ok) throw new Error(`spec invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

interface EmitInit {
  body?: unknown;
  emit?: (topic: string, payload?: unknown) => Promise<void>;
}

const emitHandler: ResolvedHandler = {
  kind: 'route',
  fn: async (init): Promise<unknown> => {
    const i = init as unknown as EmitInit;
    if (!i.emit) throw new Error('emit: init.emit is not available. Fail-closed.');
    const body = (i.body ?? {}) as { events?: Array<{ topic: string; payload?: unknown }> };
    for (const e of body.events ?? []) await i.emit(e.topic, e.payload);
    return { emitted: (body.events ?? []).length };
  },
};

const handlers = new Map<string, ResolvedHandler>([['emit_handler', emitHandler]]);

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface Frame {
  id?: string;
  event?: string;
  data: string;
}

/** A live SSE read: the frames seen, plus whether the SERVER closed the stream inside the budget. */
interface StreamRead {
  frames: Frame[];
  closed: boolean;
  elapsedMs: number;
}

/**
 * Read a LIVE SSE response until `stop` is satisfied, the server closes the stream, or the budget
 * runs out. Cancels the reader on the way out (which aborts the server-side loop) unless the server
 * already closed. Control frames (no `id:`) and data frames are both returned; SSE COMMENTS (the
 * heartbeat) are dropped, exactly as a client parser drops them.
 */
async function readStream(
  res: Response,
  stop: (frames: Frame[]) => boolean,
  budgetMs = 20_000,
): Promise<StreamRead> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('subscribe response carried no body stream');
  const decoder = new TextDecoder();
  const started = Date.now();
  const deadline = started + budgetMs;
  let buffer = '';
  let closed = false;
  const frames: Frame[] = [];
  while (!stop(frames) && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: false; value: undefined }>((r) =>
        setTimeout(() => r({ done: false, value: undefined }), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (chunk.done) {
      closed = true;
      break;
    }
    if (chunk.value === undefined) break; // the test's own budget expired, not a server close
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const frame = parseBlock(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (frame) frames.push(frame);
      idx = buffer.indexOf('\n\n');
    }
  }
  if (!closed) await reader.cancel().catch(() => {});
  return { frames, closed, elapsedMs: Date.now() - started };
}

function parseBlock(block: string): Frame | undefined {
  if (!block.trim()) return undefined;
  const frame: Frame = { data: '' };
  let sawField = false;
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue; // an SSE comment (the heartbeat) is not a frame
    if (line.startsWith('id:')) {
      frame.id = line.slice(3).trim();
      sawField = true;
    } else if (line.startsWith('event:')) {
      frame.event = line.slice(6).trim();
      sawField = true;
    } else if (line.startsWith('data:')) {
      frame.data = line.slice(5).trim();
      sawField = true;
    }
  }
  return sawField ? frame : undefined;
}

/** The DATA frames only (a control frame carries no `id:` — that is the discriminator). */
const dataFrames = (frames: Frame[]): Frame[] => frames.filter((f) => f.id !== undefined);
/** The seq half of each data frame's tenant-qualified cursor. */
const seqs = (frames: Frame[]): number[] =>
  dataFrames(frames).map((f) => Number((f.id as string).split(':')[1]));
/** Stop once `n` data frames have arrived. */
const untilData = (n: number) => (frames: Frame[]) => dataFrames(frames).length >= n;
/** Stop once a frame with this event name has arrived. */
const untilEvent = (name: string) => (frames: Frame[]) => frames.some((f) => f.event === name);

async function principal(h: Harness, email: string, orgName: string) {
  const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-long-enough-password' },
  });
  const t0 = (await reg.json()).accessToken as string;
  const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
    body: { name: orgName },
    headers: { authorization: `Bearer ${t0}` },
  });
  const orgId = (await orgRes.json()).id as string;
  const switchRes = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
    headers: { authorization: `Bearer ${t0}` },
  });
  const token = (await switchRes.json()).accessToken as string;
  return { orgId, token };
}

/** POST the emit route with N events on one topic (one request = one transaction = one flush). */
async function emit(
  h: Harness,
  token: string,
  events: Array<{ topic: string; payload?: unknown }>,
): Promise<Response> {
  return jsonRequest(h.app, 'POST', '/emit', {
    body: { events },
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Open a subscription. */
function subscribe(h: Harness, token: string, query = '', headers: Record<string, string> = {}) {
  return h.app.request(`/v1/subscribe${query}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', ...headers },
  });
}

/**
 * Age every event of a tenant past `hours` and run the REAL retention sweep — the same statement the
 * scheduled cleanup arm drives, so the floor is written the way production writes it (in the DELETE's
 * own transaction). Returns the sweep's own report.
 */
async function retainAway(h: Harness, tenantId: string, keepSeqAbove: number): Promise<void> {
  await h.db.$client.unsafe(
    `UPDATE tenant_events SET at = now() - interval '48 hours'
       WHERE tenant_id = $1 AND seq <= $2`,
    [tenantId, String(keepSeqAbove)],
  );
  const { sweepTenantEvents, eventRetentionCutoff } = await import('@rayspec/db');
  await sweepTenantEvents(h.db, { cutoff: eventRetentionCutoff(new Date(), 24) });
}

// ---------------------------------------------------------------------------------------------
// WAKE-DRIVEN — the poll is parked at 30s, so every delivery below is the notify's doing.
// ---------------------------------------------------------------------------------------------

describe.skipIf(!hasDb)('GET /v1/subscribe — wake-driven delivery + resume', () => {
  const SCHEMA = 'rayspec_test_apiauth_subscribe_wake';
  let h: Harness;
  let wakeDb: Db;
  let wake: TenantEventWakeHub;

  beforeAll(async () => {
    // The wake holds its OWN connection, exactly as production does (postgres-js gives a listener a
    // dedicated connection): the LISTEN never borrows from the request pool. The channel is
    // process-global, so this handle only ever issues LISTEN — it never reads a row.
    wakeDb = makeDbWithSchema(process.env.DATABASE_URL as string, SCHEMA, 2);
    wake = makeTenantEventWake(wakeDb);
    h = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: handlers,
      eventBus: makeTenantEventBus(),
      eventWake: wake,
      // Parked far beyond any test's patience: if the notify path were broken, nothing here would
      // arrive and every delivery assertion would fail rather than quietly succeed on a poll.
      eventPollIntervalMs: 30_000,
      schema: SCHEMA,
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await wake.close();
    await wakeDb.$client.end();
    await h.close();
  });

  it('COUNTERPROOF: a subscriber receives an event emitted AFTER it connected', async () => {
    const { orgId, token } = await principal(h, 'live@example.com', 'LiveOrg');

    const res = await subscribe(h, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reading = readStream(res, untilData(1));
    expect((await emit(h, token, [{ topic: 'workspace.updated', payload: { n: 1 } }])).status).toBe(
      200,
    );

    const { frames } = await reading;
    const data = dataFrames(frames);
    expect(data.length).toBe(1);
    expect(data[0]?.event).toBe('workspace.updated');
    expect(JSON.parse(data[0]?.data ?? 'null')).toEqual({ n: 1 });
    // R4 — the cursor is TENANT-QUALIFIED, never a bare seq.
    expect(data[0]?.id).toBe(`${orgId}:1`);
    // The backlog-drained control frame arrived, and it carries NO id (so it can never be replayed
    // back as a cursor). A fresh subscriber is NOT told it was truncated.
    const live = frames.find((f) => f.event === 'rayspec.live');
    expect(live).toBeDefined();
    expect(live?.id).toBeUndefined();
    expect(frames.some((f) => f.event === 'rayspec.truncated')).toBe(false);
  });

  it('RESUME: a subscriber that disconnects mid-flight and reconnects receives exactly the events it missed (CONCURRENT emits)', async () => {
    const { orgId, token } = await principal(h, 'resume@example.com', 'ResumeOrg');
    const REQUESTS = 8;
    const PER_REQUEST = 3;
    const TOTAL = REQUESTS * PER_REQUEST;

    // Connect and drain to live BEFORE anything is emitted, so the resume below is a genuine
    // reconnect and not a first read.
    const first = await subscribe(h, token);
    expect(first.status).toBe(200);

    // Genuinely CONCURRENT emitters: 8 requests, each its own transaction, each flushing 3 events.
    // The per-tenant counter lock is what makes allocation order equal commit order; a sequential
    // driver would never exercise it.
    const emitting = Promise.all(
      Array.from({ length: REQUESTS }, (_, r) =>
        emit(
          h,
          token,
          Array.from({ length: PER_REQUEST }, (_, i) => ({
            topic: 'lane',
            payload: { request: r, index: i },
          })),
        ),
      ),
    );

    // Read a PREFIX and walk away mid-flight — the disconnect the resume has to survive.
    const before = await readStream(first, untilData(4), 15_000);
    const responses = await emitting;
    expect(responses.every((r) => r.status === 200)).toBe(true);

    const seen = seqs(before.frames);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    const lastId = dataFrames(before.frames).at(-1)?.id as string;
    expect(lastId).toBe(`${orgId}:${seen.at(-1)}`);

    // Reconnect with the SSE reconnect header — the mechanism a browser uses without being told to.
    const second = await subscribe(h, token, '', { 'last-event-id': lastId });
    expect(second.status).toBe(200);
    const after = await readStream(second, untilData(TOTAL - seen.length), 15_000);
    const resumed = seqs(after.frames);

    // NONE SKIPPED, NONE DUPLICATED, IN ORDER — the whole point.
    expect([...seen, ...resumed]).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(new Set(resumed).size).toBe(resumed.length);
    expect(resumed.every((s, i) => i === 0 || s > (resumed[i - 1] as number))).toBe(true);
    // A resume is not a truncation.
    expect(after.frames.some((f) => f.event === 'rayspec.truncated')).toBe(false);
  });

  it('R3: OMITTED topics delivers EVERY topic; a filter delivers only its own and still advances past the rest', async () => {
    const { orgId, token } = await principal(h, 'topics@example.com', 'TopicsOrg');
    await emit(h, token, [
      { topic: 'alpha', payload: 1 },
      { topic: 'beta', payload: 2 },
      { topic: 'gamma', payload: 3 },
      { topic: 'alpha', payload: 4 },
    ]);

    // Omitted ⇒ every topic. (The measured loss path is a filter bound to NULL, which matches nothing
    // while the stream still reports itself healthy — so "omitted" must not become a bound filter.)
    const all = await subscribe(h, token, `?since=${orgId}:0`);
    const allRead = await readStream(all, untilData(4));
    expect(dataFrames(allRead.frames).map((f) => f.event)).toEqual([
      'alpha',
      'beta',
      'gamma',
      'alpha',
    ]);

    // Filtered ⇒ only those topics, and the cursor advances PAST the skipped rows: the last delivered
    // frame is seq 4, which is only reachable if the scan moved through 2 and 3.
    const filtered = await subscribe(h, token, `?topics=alpha&since=${orgId}:0`);
    const filteredRead = await readStream(filtered, untilEvent('rayspec.live'));
    expect(seqs(filteredRead.frames)).toEqual([1, 4]);
    expect(dataFrames(filteredRead.frames).every((f) => f.event === 'alpha')).toBe(true);
  });

  it('R3: an EXPLICITLY EMPTY topics filter is a 400, never a silent dead stream', async () => {
    const { token } = await principal(h, 'emptytopics@example.com', 'EmptyTopicsOrg');
    for (const query of ['?topics=', '?topics=,', '?topics=%20']) {
      const res = await subscribe(h, token, query);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('can only match nothing');
    }
  });

  it('R4: a cursor tagged with ANOTHER tenant is refused, and no cursor reaches another tenant’s events', async () => {
    const a = await principal(h, 'tenant-a@example.com', 'TenantA');
    const b = await principal(h, 'tenant-b@example.com', 'TenantB');
    await emit(h, a.token, [{ topic: 'a.secret', payload: { owner: 'A' } }]);

    // A's cursor, presented by B, is REFUSED — never reinterpreted against B's own stream.
    const foreign = await subscribe(h, b.token, `?since=${a.orgId}:0`);
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).error.message).toContain('different tenant');

    // And the same via the SSE reconnect header (the path a browser actually uses).
    const foreignHeader = await subscribe(h, b.token, '', { 'last-event-id': `${a.orgId}:0` });
    expect(foreignHeader.status).toBe(400);

    // B's OWN cursor at the very beginning reaches B's stream only: A's event is invisible, and B's
    // stream counts from 1 (the sequences are per-tenant, not global).
    await emit(h, b.token, [{ topic: 'b.own', payload: { owner: 'B' } }]);
    const own = await subscribe(h, b.token, `?since=${b.orgId}:0`);
    const read = await readStream(own, untilEvent('rayspec.live'));
    expect(dataFrames(read.frames).map((f) => f.event)).toEqual(['b.own']);
    expect(seqs(read.frames)).toEqual([1]);
    expect(read.frames.map((f) => f.data).join(' ')).not.toContain('"owner":"A"');
  });

  it('R5: a FRESH subscriber on a stream with a real retention floor gets NO truncation signal', async () => {
    const { orgId, token } = await principal(h, 'fresh@example.com', 'FreshOrg');
    await emit(h, token, [
      { topic: 'old', payload: 1 },
      { topic: 'old', payload: 2 },
      { topic: 'old', payload: 3 },
    ]);
    await retainAway(h, orgId, 3);

    // No cursor ⇒ start at the TAIL. Classifying cursor-0-against-floor-3 as a truncation would hand
    // every first-time subscriber a signal about history it never had.
    const res = await subscribe(h, token);
    const reading = readStream(res, untilData(1));
    await emit(h, token, [{ topic: 'new', payload: 'after' }]);
    const { frames } = await reading;
    expect(frames.some((f) => f.event === 'rayspec.truncated')).toBe(false);
    expect(dataFrames(frames).map((f) => f.event)).toEqual(['new']);
    expect(seqs(frames)).toEqual([4]);
  });

  it('a stored topic carrying a LINE BREAK cannot silence the stream (and cannot forge a frame)', async () => {
    const { orgId, token } = await principal(h, 'poison@example.com', 'PoisonOrg');
    await emit(h, token, [{ topic: 'before', payload: 1 }]);
    // `init.emit` refuses such a topic at the call, so this row is planted DIRECTLY — the shape a
    // legacy row or a hand-written insert could take. Unhandled, writing it as an SSE `event:` field
    // throws, this stream dies on the row, and EVERY reconnect resuming from seq 1 dies on it again:
    // one row would silence the tenant permanently. The injected `id:`/`data:` lines are the second
    // half — an author's topic must never be able to write SSE FIELDS.
    await h.db.$client.unsafe(
      `INSERT INTO tenant_events (tenant_id, seq, topic, payload) VALUES ($1, 2, $2, '{}'::jsonb)`,
      [orgId, 'evil\nid: forged\ndata: forged'],
    );
    await h.db.$client.unsafe('UPDATE tenant_event_streams SET last_seq = 2 WHERE tenant_id = $1', [
      orgId,
    ]);
    await emit(h, token, [{ topic: 'after', payload: 3 }]);

    const res = await subscribe(h, token, `?since=${orgId}:0`);
    const { frames } = await readStream(res, untilEvent('rayspec.live'));
    // The stream survived the row and reached the events BEHIND it.
    expect(seqs(frames)).toEqual([1, 2, 3]);
    expect(dataFrames(frames).map((f) => f.event)).toEqual([
      'before',
      'evil id: forged data: forged',
      'after',
    ]);
    // …and the injected lines are a field VALUE, not fields: nothing carries the forged cursor.
    expect(frames.some((f) => f.id === 'forged')).toBe(false);
    expect(dataFrames(frames).map((f) => f.data)).toEqual(['1', '{}', '3']);
  });

  it('R6: a cursor from the FUTURE is refused, not served as an empty ok stream', async () => {
    const { orgId, token } = await principal(h, 'future@example.com', 'FutureOrg');
    await emit(h, token, [{ topic: 'only', payload: 1 }]);

    const res = await subscribe(h, token, `?since=${orgId}:9999`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('ahead of this stream');

    // A malformed cursor is refused on the same terms (a BARE seq is not a cursor).
    const bare = await subscribe(h, token, '?since=1');
    expect(bare.status).toBe(400);
    expect((await bare.json()).error.message).toContain('<tenant_id>:<seq>');
  });

  it('TRUNCATION: a cursor retained away produces the control frame, and the subscriber recovers from it', async () => {
    const { orgId, token } = await principal(h, 'truncated@example.com', 'TruncatedOrg');
    await emit(h, token, [
      { topic: 'gone', payload: 1 },
      { topic: 'gone', payload: 2 },
      { topic: 'gone', payload: 3 },
    ]);
    await retainAway(h, orgId, 3);
    await emit(h, token, [{ topic: 'kept', payload: 4 }]);

    // The subscriber comes back with a cursor from BEFORE the sweep.
    const res = await subscribe(h, token, `?since=${orgId}:0`);
    expect(res.status).toBe(200);
    const { frames } = await readStream(res, untilEvent('rayspec.live'));

    const truncated = frames.find((f) => f.event === 'rayspec.truncated');
    expect(truncated).toBeDefined();
    // THE SIGNAL IS A FRAME WITHOUT AN `id:` — a response header cannot be set on an
    // already-flushed SSE response, and an id would let the notice come back as a cursor.
    expect(truncated?.id).toBeUndefined();
    expect(JSON.parse(truncated?.data ?? '{}')).toEqual({ truncatedThrough: 3, requestedFrom: 0 });
    // It arrives BEFORE anything it would otherwise be mistaken for real history.
    expect(frames.indexOf(truncated as Frame)).toBe(0);
    // …and the subscriber recovers: it receives everything that survived, from the floor onward.
    expect(seqs(frames)).toEqual([4]);
    expect(dataFrames(frames)[0]?.event).toBe('kept');
  });
});

// ---------------------------------------------------------------------------------------------
// POLL-DRIVEN — NO wake wired at all: the posture in which every notify is lost.
// ---------------------------------------------------------------------------------------------

describe.skipIf(!hasDb)('GET /v1/subscribe — the periodic read is the delivery guarantee', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: handlers,
      eventBus: makeTenantEventBus(),
      // No `eventWake`: nothing tells a subscriber anything. Delivery below is the poll's doing.
      // Wide enough that the R2 arm's emit-then-sweep reliably lands INSIDE one interval even on a
      // loaded machine — that arm needs retention to run while the subscriber is idle between reads.
      eventPollIntervalMs: 4_000,
      eventStreamMaxSeconds: 20,
      schema: 'rayspec_test_apiauth_subscribe_poll',
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('delivers with NO wake wired — a missed notify costs latency, never an event', async () => {
    const { token } = await principal(h, 'pollonly@example.com', 'PollOnlyOrg');
    const res = await subscribe(h, token);
    const reading = readStream(res, untilData(1));
    await emit(h, token, [{ topic: 'polled', payload: { ok: true } }]);
    const { frames } = await reading;
    expect(dataFrames(frames).map((f) => f.event)).toEqual(['polled']);
  });

  it('R2: the floor is re-checked on EVERY read — retention that runs mid-subscription arrives as a signal, not a hole', async () => {
    const { orgId, token } = await principal(h, 'longlived@example.com', 'LongLivedOrg');

    // Connect on an EMPTY stream: at connect the cursor is 0 and the floor is 0, so the opening
    // classification finds nothing wrong. Everything below happens while the subscriber sits idle.
    const res = await subscribe(h, token);
    expect(res.status).toBe(200);
    const reading = readStream(res, untilEvent('rayspec.truncated'), 15_000);

    // Emit AND retain away inside one poll interval, so the subscriber's own history is swept out
    // from under it between its reads. A floor checked only at connect would never see this.
    await emit(h, token, [
      { topic: 'swept', payload: 1 },
      { topic: 'swept', payload: 2 },
    ]);
    await retainAway(h, orgId, 2);
    await emit(h, token, [{ topic: 'survivor', payload: 3 }]);

    const { frames } = await reading;
    const truncated = frames.find((f) => f.event === 'rayspec.truncated');
    expect(truncated).toBeDefined();
    expect(truncated?.id).toBeUndefined();
    expect(JSON.parse(truncated?.data ?? '{}')).toEqual({ truncatedThrough: 2, requestedFrom: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// STREAM LIFETIME — the cap is the access-token TTL, and the reconnect re-runs the auth chain.
// ---------------------------------------------------------------------------------------------

describe.skipIf(!hasDb)('GET /v1/subscribe — the stream lifetime cap', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: handlers,
      eventBus: makeTenantEventBus(),
      eventPollIntervalMs: 500,
      // A deliberately ABSURD configured cap: the point of this harness is that it cannot take
      // effect, because the access-token TTL below is the ceiling.
      eventStreamMaxSeconds: 3_600,
      accessTokenTtlSeconds: 5,
      schema: 'rayspec_test_apiauth_subscribe_ttl',
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('the cap CLOSES the stream, and a configured cap cannot raise it past the access-token TTL', async () => {
    const { token } = await principal(h, 'capped@example.com', 'CappedOrg');

    const res = await subscribe(h, token);
    expect(res.status).toBe(200);
    // The stop condition is never satisfied — this read ends ONLY because the SERVER closed the
    // stream. It closes at the 5s token TTL, not at the 3600s the deployment asked for: the cap
    // bounds how long a stale authorization can outlive its credential, so a deployment must not be
    // able to configure its way out of it.
    const read = await readStream(res, () => false, 30_000);
    expect(read.closed).toBe(true);
    expect(read.elapsedMs).toBeGreaterThan(3_000);
    expect(read.elapsedMs).toBeLessThan(20_000);
  });

  it('the reconnect re-runs the WHOLE auth chain — a credential revoked while the stream was open does not reopen it', async () => {
    const { orgId, token } = await principal(h, 'revoked@example.com', 'RevokedOrg');
    const mint = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
      body: { name: 'subscriber', scopes: ['events:read'] },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mint.status).toBe(201);
    const key = await mint.json();

    // The stream opens on the key, and the permission check that let it in ran ONCE, at connect.
    const open = await subscribe(h, key.plaintext as string);
    expect(open.status).toBe(200);
    await open.body?.cancel().catch(() => {});

    // Revoke the credential mid-subscription. Nothing re-enters the auth chain inside a live stream
    // by design — the cap above is what bounds that window — but the RECONNECT the client must make
    // is a fresh request through authenticate → resolveTenant → requirePermission, and it is refused.
    const revoke = await jsonRequest(h.app, 'DELETE', `/v1/orgs/${orgId}/api-keys/${key.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.status).toBe(204);

    const reconnect = await subscribe(h, key.plaintext as string);
    expect(reconnect.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// ACCEPT CONTROL — no bus enabled.
// ---------------------------------------------------------------------------------------------

describe.skipIf(!hasDb)('GET /v1/subscribe — accept control (the bus is not enabled)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: handlers,
      // NO eventBus: the same single signal that decides whether an init carries `init.emit`.
      schema: 'rayspec_test_apiauth_subscribe_off',
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('fail-closes 501 naming the key to set — never a 404, and never an empty ok stream', async () => {
    const { token } = await principal(h, 'nobus@example.com', 'NoBusOrg');
    const res = await subscribe(h, token);
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_IMPLEMENTED');
    expect(body.error.message).toContain('deployment.eventBus.enabled');
  });

  it('an api-key WITHOUT events:read is 403; WITH it the route is reached', async () => {
    const { orgId, token } = await principal(h, 'keys@example.com', 'KeysOrg');
    const mintKey = async (scopes: string[]): Promise<string> => {
      const res = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
        body: { name: `k-${scopes.join('-')}`, scopes },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(201);
      return (await res.json()).plaintext as string;
    };

    const without = await subscribe(h, await mintKey(['store:read']));
    expect(without.status).toBe(403);
    expect((await without.json()).error.details.missing_permission).toBe('events:read');

    // The same key shape WITH the scope gets past authz and lands on the enablement gate (501 here,
    // because this harness wires no bus) — so the 403 above was the permission, not the route.
    const withScope = await subscribe(h, await mintKey(['events:read']));
    expect(withScope.status).toBe(501);
  });
});
