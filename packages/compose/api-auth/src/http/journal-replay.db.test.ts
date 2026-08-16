/**
 * The platform's journal REPLAY helper, driven against the real durable journal.
 *
 * `replayJournalEventsAsSse` is the one mechanism that turns persisted `run_events` rows into an SSE
 * response, and `resolveLastEventId` is the resume cursor it is given. Both are platform machinery
 * rather than route machinery: any surface that has to hand a client a resumable feed of journal
 * entries reads the same rows, in the same order, from the same cursor — so it reads them through
 * this module instead of growing a second copy of the query with its own subtly different bounds.
 *
 * What is measured here is exactly what a caller depends on:
 *   (A) THE CURSOR. `Last-Event-ID` (the reconnect header the SSE spec defines) takes precedence over
 *       the `?lastEventId=` query, an absent cursor means "from the beginning", and a cursor that is
 *       not a number is NOT trusted as one — it also means "from the beginning" rather than `NaN`,
 *       which would silently compare as false and serve nothing.
 *   (B) THE BOUND AND THE ORDER. Only entries STRICTLY after the cursor are served, ascending by seq,
 *       with `id:` = seq — the value the client sends back as `Last-Event-ID`, so a resume from the
 *       last id it saw is exact rather than approximately right.
 *   (C) FAIL-CLOSED SERIALIZATION. The stored `data` is re-validated ON READ by the caller's own
 *       `serialize`, and an entry it rejects is DROPPED. A dropped entry must never be replaced by a
 *       fabricated one, and it must not end the replay — the entries after it still arrive.
 *   (D) TENANT SCOPE. The replay reads through a TenantDb, so a second tenant asking for the same
 *       stream id gets NOTHING — not an error mentioning the other tenant's stream, and not its rows.
 *
 * DB-backed: `run_events` carries a tenant FK onto `orgs`, so the tenants here are real provisioned
 * orgs and the rows are written through the tenant chokepoint, not into a stand-in table.
 */
import { forTenant, schema, type TenantDb } from '@rayspec/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';
import { replayJournalEventsAsSse, resolveLastEventId } from './journal-replay.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this suite carries the tenant-scope arm, so it must never self-skip to a
// false green on a run that REQUIRES the database.
if (requireDb && !hasDb) {
  throw new Error(
    'journal-replay.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip a suite whose tenant-scope arm is load-bearing.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

let h: Harness;

/** Provision one org and return its id (the tenant the journal rows are written under). */
async function provisionTenant(email: string, orgName: string): Promise<string> {
  const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-long-enough-password' },
  });
  const t0 = (await reg.json()).accessToken as string;
  const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
    body: { name: orgName },
    headers: { authorization: `Bearer ${t0}` },
  });
  return (await orgRes.json()).id as string;
}

/** One parsed SSE frame — the three fields the replay emits. */
interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

/** Parse an SSE body into its frames (blank-line separated, one `field: value` per line). */
function parseFrames(body: string): Frame[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const frame: Frame = {};
      for (const line of block.split('\n')) {
        const at = line.indexOf(': ');
        if (at === -1) continue;
        const field = line.slice(0, at);
        const value = line.slice(at + 2);
        if (field === 'id') frame.id = value;
        else if (field === 'event') frame.event = value;
        else if (field === 'data') frame.data = value;
      }
      return frame;
    });
}

/** Drive the replay through a real Hono context and return the frames it wrote. */
async function replay(
  tdb: TenantDb,
  streamId: string,
  afterSeq: number,
  serialize: (data: unknown) => string | undefined = (data) => JSON.stringify(data),
): Promise<Frame[]> {
  const app = new Hono();
  app.get('/replay', (c) => replayJournalEventsAsSse(c, tdb, streamId, afterSeq, serialize));
  const res = await app.request('/replay');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  return parseFrames(await res.text());
}

/** Drive `resolveLastEventId` through a real Hono context carrying `headers` + `query`. */
async function cursorFor(headers: Record<string, string>, query: string): Promise<number> {
  const app = new Hono();
  app.get('/cursor', (c) => c.text(String(resolveLastEventId(c))));
  return Number(await (await app.request(`/cursor${query}`, { headers })).text());
}

/** Write one journal entry for `streamId` under `tdb`'s tenant. */
async function writeEntry(
  tdb: TenantDb,
  streamId: string,
  seq: number,
  type: string,
  data: unknown,
): Promise<void> {
  await tdb.insert(schema.runEvents, { runId: streamId, seq: String(seq), type, data });
}

beforeAll(async () => {
  if (!hasDb) return;
  h = await createHarness({ schema: 'rayspec_test_apiauth_journalreplay' });
});
beforeEach(async () => {
  if (!hasDb) return;
  await h.reset();
});
afterAll(async () => {
  if (!hasDb) return;
  await h.close();
});

describeDb('the journal replay cursor', () => {
  it('(A) prefers the Last-Event-ID header over the query, and distrusts a non-numeric cursor', async () => {
    expect(await cursorFor({ 'last-event-id': '7' }, '?lastEventId=2')).toBe(7);
    expect(await cursorFor({}, '?lastEventId=2')).toBe(2);
    expect(await cursorFor({}, '')).toBe(-1);
    // Not a number ⇒ replay from the beginning. A `NaN` cursor would compare false against every
    // stored seq and serve an EMPTY stream, which reads exactly like "there is nothing to resume".
    expect(await cursorFor({ 'last-event-id': 'not-a-number' }, '')).toBe(-1);
  });
});

describeDb('the journal replay', () => {
  it('(B) serves only the entries after the cursor, ascending, with id = seq', async () => {
    const tenant = await provisionTenant('replay-bound@example.test', 'Replay Bound');
    const tdb = forTenant(h.db, tenant);
    // Written out of order on purpose: the ORDER is the query's, not the insert's.
    await writeEntry(tdb, 'stream-1', 2, 'text_delta', { n: 2 });
    await writeEntry(tdb, 'stream-1', 0, 'run_started', { n: 0 });
    await writeEntry(tdb, 'stream-1', 1, 'text_delta', { n: 1 });

    const all = await replay(tdb, 'stream-1', -1);
    expect(all.map((f) => f.id)).toEqual(['0', '1', '2']);
    expect(all.map((f) => f.event)).toEqual(['run_started', 'text_delta', 'text_delta']);
    expect(all.map((f) => f.data)).toEqual(['{"n":0}', '{"n":1}', '{"n":2}']);

    // Resume from the last id the client saw: STRICTLY after it (the entry itself is not re-sent).
    const resumed = await replay(tdb, 'stream-1', 1);
    expect(resumed.map((f) => f.id)).toEqual(['2']);

    // A cursor at the end of the stream is an empty replay, not the whole stream again.
    expect(await replay(tdb, 'stream-1', 2)).toEqual([]);
  });

  it('(B) serves only the named stream — another stream of the same tenant is not mixed in', async () => {
    const tenant = await provisionTenant('replay-stream@example.test', 'Replay Stream');
    const tdb = forTenant(h.db, tenant);
    await writeEntry(tdb, 'stream-a', 0, 'text_delta', { s: 'a' });
    await writeEntry(tdb, 'stream-b', 0, 'text_delta', { s: 'b' });

    expect((await replay(tdb, 'stream-a', -1)).map((f) => f.data)).toEqual(['{"s":"a"}']);
  });

  it('(C) DROPS an entry the caller’s serialize rejects, and keeps serving the ones after it', async () => {
    const tenant = await provisionTenant('replay-drop@example.test', 'Replay Drop');
    const tdb = forTenant(h.db, tenant);
    await writeEntry(tdb, 'stream-1', 0, 'text_delta', { ok: true });
    await writeEntry(tdb, 'stream-1', 1, 'text_delta', { poisoned: true });
    await writeEntry(tdb, 'stream-1', 2, 'text_delta', { ok: true });

    // The caller's read-path validator: it refuses the middle entry.
    const serialize = (data: unknown): string | undefined =>
      (data as { poisoned?: unknown }).poisoned === undefined ? JSON.stringify(data) : undefined;

    const frames = await replay(tdb, 'stream-1', -1, serialize);
    // The rejected entry is ABSENT — not replaced by an empty/placeholder frame — and the entry
    // after it still arrives, so one bad row cannot truncate the rest of the replay.
    expect(frames.map((f) => f.id)).toEqual(['0', '2']);
    expect(frames.every((f) => f.data !== undefined && !f.data.includes('poisoned'))).toBe(true);
  });

  it('(D) is tenant-scoped: another tenant asking for the same stream id gets nothing', async () => {
    const tenantA = await provisionTenant('replay-a@example.test', 'Replay A');
    const tenantB = await provisionTenant('replay-b@example.test', 'Replay B');
    const tdbA = forTenant(h.db, tenantA);
    const tdbB = forTenant(h.db, tenantB);
    await writeEntry(tdbA, 'shared-id', 0, 'text_delta', { secret: 'FROM_A' });

    // Accept control: A's own replay of that stream is NOT empty, so B's emptiness below is the
    // tenant predicate at work rather than a replay that serves nobody.
    expect((await replay(tdbA, 'shared-id', -1)).map((f) => f.data)).toEqual([
      '{"secret":"FROM_A"}',
    ]);
    expect(await replay(tdbB, 'shared-id', -1)).toEqual([]);
  });
});
