/**
 * DB-backed acceptance for CURSOR COMPLETENESS on the declared store `list` op: an `X-Next-Cursor`
 * is minted on EVERY non-empty keyset-ordered page, not only on a page that hit the cap.
 *
 * The cap-only mint made "park a cursor, poll for new rows later" inexpressible: a non-full page —
 * the normal steady state of an append-only feed — yielded no cursor, so a client had nothing to
 * resume from when new rows arrived. Now every non-empty keyset page hands back the cursor of its
 * LAST row; passing it as `after` later returns exactly the rows beyond it.
 *
 * The two structural exceptions are part of the contract and pinned here:
 *  - an EMPTY page mints NO cursor: a cursor binds to a row boundary the server actually observed,
 *    and an empty page observed none — the client's previously-held cursor remains its frontier;
 *  - a ranked `?__search=` page mints NO cursor: it is ordered by `ts_rank`, not a stored order
 *    column, and keyset `after` is rejected there (a single relevance-ordered page).
 * `X-Result-Truncated` semantics are UNCHANGED: set only when the page hit the cap.
 *
 * Drives the REAL declared store-routes through the REAL `createAuthApp` middleware chain over an
 * isolated Postgres schema, from a SELF-CONTAINED throwaway backend-profile spec (mirroring
 * store-in-filter.db.test.ts).
 *
 * Fail-the-fix: WITHOUT the completeness change a non-full page carries NO `X-Next-Cursor` — the
 * park-a-cursor walk goes RED on its very first page.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * yet absent (un-skippable ran-guard at the bottom).
 */
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'store-cursor-completeness.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
      'but absent — refusing to silently skip the cursor-completeness acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_store_cursor';

// A self-contained throwaway backend-profile spec. Neutral names only:
//  - `entries` (seq integer + title text) — the keyset-ordered park-a-cursor store.
//  - `posts` (fullTextSearch)             — the ranked `?__search=` exception store.
const CURSOR_YAML = `
version: '1.0'
metadata:
  name: cursor-completeness-backend
  description: A backend proving the every-page X-Next-Cursor mint on the list op.
stores:
  - name: entries
    columns:
      - { name: seq, type: integer }
      - { name: title, type: text }
  - name: posts
    fullTextSearch: true
    columns:
      - { name: title, type: text }
api:
  - { method: POST, path: '/entries', action: { kind: store, store: entries, op: create } }
  - { method: GET, path: '/entries', action: { kind: store, store: entries, op: list } }
  - { method: POST, path: '/posts', action: { kind: store, store: posts, op: create } }
  - { method: GET, path: '/posts', action: { kind: store, store: posts, op: list } }
`;

let testsRan = 0;

interface EntryRow {
  id: string;
  seq: number;
  title: string;
}

describeDb('store list cursor completeness (X-Next-Cursor on every non-empty page)', () => {
  let h: Harness;

  /** Register → org → switch → an org-scoped owner token (owner holds store:read + store:write). */
  async function principal(email: string, orgName: string): Promise<{ token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
      body: { name: orgName },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    const sw = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    return { token: (await sw.json()).accessToken as string };
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const createEntry = (token: string, seq: number) =>
    jsonRequest(h.app, 'POST', '/entries', {
      body: { seq, title: `entry ${seq}` },
      headers: auth(token),
    });

  const listEntries = (token: string, query = '') =>
    jsonRequest(h.app, 'GET', `/entries${query ? `?${query}` : ''}`, { headers: auth(token) });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(CURSOR_YAML);
    if (!parsed.ok) throw new Error(`cursor fixture invalid: ${JSON.stringify(parsed.errors)}`);
    const spec: RaySpec = parsed.value;
    h = await createHarness({ engineSpec: spec, schema: SCHEMA });
  });
  beforeEach(async () => {
    if (!hasDb) return;
    await h.reset();
  });
  afterAll(async () => {
    if (!hasDb) return;
    await h.close();
  });

  it('a NON-full page carries an X-Next-Cursor (and, unchanged, NO X-Result-Truncated)', async () => {
    testsRan += 1;
    const { token } = await principal('cursor-nonfull@example.com', 'CursorNonFullOrg');
    for (const seq of [1, 2, 3]) expect((await createEntry(token, seq)).status).toBe(201);

    // Fail-the-fix: pre-change the mint was gated on rows.length === limit, so this header was null.
    const res = await listEntries(token, 'order=seq.asc&limit=10');
    expect(res.status).toBe(200);
    expect(((await res.json()) as EntryRow[]).map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(res.headers.get('X-Next-Cursor')).not.toBeNull();
    // Truncation semantics are UNCHANGED: the page did not hit the cap, so no signal.
    expect(res.headers.get('X-Result-Truncated')).toBeNull();
  });

  it('park a cursor: a later `after` with it returns EXACTLY the rows that arrived since', async () => {
    testsRan += 1;
    const { token } = await principal('cursor-park@example.com', 'CursorParkOrg');
    for (const seq of [1, 2]) await createEntry(token, seq);

    // Drain the feed (a non-full page) and PARK its cursor as the frontier.
    const drained = await listEntries(token, 'order=seq.asc&limit=10');
    const parked = drained.headers.get('X-Next-Cursor');
    expect(parked).not.toBeNull();

    // New rows arrive.
    for (const seq of [3, 4]) await createEntry(token, seq);

    // Resume from the parked cursor: exactly the new rows, in order — no re-read of 1/2.
    const resumed = await listEntries(
      token,
      `order=seq.asc&limit=10&after=${encodeURIComponent(parked as string)}`,
    );
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as EntryRow[]).map((r) => r.seq)).toEqual([3, 4]);
    // The resumed (non-full) page hands back the NEW frontier in turn.
    const frontier = resumed.headers.get('X-Next-Cursor');
    expect(frontier).not.toBeNull();

    // Following the new frontier with nothing beyond it: an EMPTY page, and NO cursor on it — the
    // parked frontier stays the client's resume point.
    const empty = await listEntries(
      token,
      `order=seq.asc&limit=10&after=${encodeURIComponent(frontier as string)}`,
    );
    expect(empty.status).toBe(200);
    expect((await empty.json()) as EntryRow[]).toEqual([]);
    expect(empty.headers.get('X-Next-Cursor')).toBeNull();
  });

  it('an EMPTY page mints NO cursor (an empty first page, and an empty filtered page)', async () => {
    testsRan += 1;
    const { token } = await principal('cursor-empty@example.com', 'CursorEmptyOrg');

    // An empty FIRST page: no row boundary was observed, so there is nothing a cursor could bind to.
    const first = await listEntries(token, 'order=seq.asc');
    expect(first.status).toBe(200);
    expect((await first.json()) as EntryRow[]).toEqual([]);
    expect(first.headers.get('X-Next-Cursor')).toBeNull();
    expect(first.headers.get('X-Result-Truncated')).toBeNull();

    // An empty FILTERED page behaves the same.
    await createEntry(token, 1);
    const filtered = await listEntries(token, 'seq=999');
    expect((await filtered.json()) as EntryRow[]).toEqual([]);
    expect(filtered.headers.get('X-Next-Cursor')).toBeNull();
  });

  it('a ranked ?__search= page mints NO cursor (relevance-ordered, structurally cursor-less)', async () => {
    testsRan += 1;
    const { token } = await principal('cursor-ranked@example.com', 'CursorRankedOrg');
    for (const title of ['alpha report', 'alpha summary', 'unrelated']) {
      expect(
        (await jsonRequest(h.app, 'POST', '/posts', { body: { title }, headers: auth(token) }))
          .status,
      ).toBe(201);
    }

    const res = await jsonRequest(h.app, 'GET', '/posts?__search=alpha', {
      headers: auth(token),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }[]).length).toBe(2);
    // A non-empty ranked page — and still NO cursor: ts_rank is not a stored order column, and the
    // keyset `after` is rejected on this path anyway.
    expect(res.headers.get('X-Next-Cursor')).toBeNull();
  });

  it("a FULL page keeps today's pair (X-Result-Truncated + cursor), and the walk ends on the empty page", async () => {
    testsRan += 1;
    const { token } = await principal('cursor-full@example.com', 'CursorFullOrg');
    for (const seq of [1, 2, 3]) await createEntry(token, seq);

    // Page 1 (limit=2) hits the cap: BOTH headers, exactly as before.
    const p1 = await listEntries(token, 'order=seq.asc&limit=2');
    expect(p1.headers.get('X-Result-Truncated')).toBe('true');
    const c1 = p1.headers.get('X-Next-Cursor');
    expect(c1).not.toBeNull();
    expect(((await p1.json()) as EntryRow[]).map((r) => r.seq)).toEqual([1, 2]);

    // Page 2 is non-full: NO truncation signal, but (new) a cursor.
    const p2 = await listEntries(
      token,
      `order=seq.asc&limit=2&after=${encodeURIComponent(c1 as string)}`,
    );
    expect(p2.headers.get('X-Result-Truncated')).toBeNull();
    const c2 = p2.headers.get('X-Next-Cursor');
    expect(c2).not.toBeNull();
    expect(((await p2.json()) as EntryRow[]).map((r) => r.seq)).toEqual([3]);

    // Page 3 is empty: no rows, no cursor — the walk's natural end.
    const p3 = await listEntries(
      token,
      `order=seq.asc&limit=2&after=${encodeURIComponent(c2 as string)}`,
    );
    expect((await p3.json()) as EntryRow[]).toEqual([]);
    expect(p3.headers.get('X-Next-Cursor')).toBeNull();
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('store list cursor-completeness acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the cursor-completeness arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(5);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
