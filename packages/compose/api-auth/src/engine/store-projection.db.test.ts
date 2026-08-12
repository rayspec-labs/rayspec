/**
 * DB-backed acceptance for the RESPONSE PROJECTION (`project`) on declared store routes: `casing`
 * (snake default | camel), `omitInjected` (drop the injected columns; `id` spared unless the
 * `fields` allowlist drops it), `rename` (column → wire field name), `fields` (an allowlist of
 * post-casing/rename wire names, applied last — when present it alone decides membership).
 *
 * Drives the REAL declared store-routes through the REAL `createAuthApp` chain over an isolated
 * Postgres schema, from a SELF-CONTAINED throwaway backend-profile spec (product-free platform),
 * mirroring store-comparison-filter.db.test.ts.
 *
 * What is pinned, fail-the-fix:
 *  - a projected route returns EXACTLY the camel/renamed/filtered shape on every serialize site
 *    (create 201, get, update, list, idempotency replay);
 *  - READ-SIDE ONLY: the write path is byte-identical — a projected route still accepts the
 *    author-named snake/camel body keys, stores the same values, and rejects the ambiguous
 *    both-casings body, and the request QUERY surface stays author-named (the documented split);
 *  - keyset pagination is projection-immune: the cursor mints from the RAW row, so paging works
 *    when the response renames `id` away AND when `fields` drops it entirely;
 *  - a store-level `project` applies to the store's routes and a route-level `project: {}`
 *    overrides it wholesale;
 *  - ACCEPT-CONTROL: a route WITHOUT `project` serializes the exact historical snake shape on all
 *    five sites (the byte-identity guarantee).
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
    'store-projection.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the response-projection acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_store_projection';

/** The exact snake wire keys of an un-projected `companions` row (business + all 8 injected). */
const RAW_COMPANION_KEYS = [
  'created_at',
  'created_by',
  'deleted_at',
  'id',
  'idempotency_key',
  'name',
  'note_id',
  'price',
  'region',
  'retention_days',
  'role',
  'score',
  'tenant_id',
] as const;

// A self-contained throwaway backend-profile spec. `companions` carries a multiword snake column
// (note_id — casing observable), a double + a numeric (the fractional wire forms must ride the
// projection unchanged), and BOTH a fully-projected route family and a raw accept-control family
// on the SAME store. `sidekicks` carries a STORE-level projection with a route-level `{}` override.
const PROJECTION_YAML = `
version: '1.0'
metadata:
  name: projection-backend
  description: A backend proving the response projection on declared store routes.
stores:
  - name: companions
    columns:
      - { name: name, type: text }
      - { name: role, type: text }
      - { name: note_id, type: uuid, nullable: true }
      - { name: score, type: double }
      - { name: price, type: numeric, precision: 10, scale: 2 }
  - name: sidekicks
    columns:
      - { name: label, type: text }
    project: { casing: camel }
api:
  - method: POST
    path: /companions
    action: { kind: store, store: companions, op: create }
    project: { casing: camel, omitInjected: true, rename: { id: companionId }, fields: [companionId, name, role, createdAt] }
  - method: GET
    path: /companions
    action: { kind: store, store: companions, op: list }
    project: { casing: camel, omitInjected: true, rename: { id: companionId }, fields: [companionId, name, role, createdAt] }
  - method: GET
    path: /companions/{id}
    action: { kind: store, store: companions, op: get }
    project: { casing: camel, omitInjected: true, rename: { id: companionId }, fields: [companionId, name, role, createdAt] }
  - method: PATCH
    path: /companions/{id}
    action: { kind: store, store: companions, op: update }
    project: { casing: camel, omitInjected: true, rename: { id: companionId }, fields: [companionId, name, role, createdAt] }
  - method: GET
    path: /companions-camel
    action: { kind: store, store: companions, op: list }
    project: { casing: camel }
  - method: GET
    path: /companions-min
    action: { kind: store, store: companions, op: list }
    project: { fields: [name] }
  - method: POST
    path: /companions-raw
    action: { kind: store, store: companions, op: create }
  - method: GET
    path: /companions-raw
    action: { kind: store, store: companions, op: list }
  - method: GET
    path: /companions-raw/{id}
    action: { kind: store, store: companions, op: get }
  - method: PATCH
    path: /companions-raw/{id}
    action: { kind: store, store: companions, op: update }
  - method: GET
    path: /sidekicks
    action: { kind: store, store: sidekicks, op: list }
  - method: POST
    path: /sidekicks
    action: { kind: store, store: sidekicks, op: create }
  - method: GET
    path: /sidekicks-plain
    action: { kind: store, store: sidekicks, op: list }
    project: {}
`;

let testsRan = 0;

describeDb('store response projection (project: casing/omitInjected/rename/fields)', () => {
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

  const post = (token: string, path: string, body: Record<string, unknown>, headers = {}) =>
    jsonRequest(h.app, 'POST', path, { body, headers: { ...auth(token), ...headers } });
  const get = (token: string, path: string) =>
    jsonRequest(h.app, 'GET', path, { headers: auth(token) });
  const patch = (token: string, path: string, body: Record<string, unknown>) =>
    jsonRequest(h.app, 'PATCH', path, { body, headers: auth(token) });

  const COMPANION = { name: 'ada', role: 'engineer', score: 1.5, price: '12.34' };

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(PROJECTION_YAML);
    if (!parsed.ok) throw new Error(`projection fixture invalid: ${JSON.stringify(parsed.errors)}`);
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

  it('a projected route returns EXACTLY the camel/renamed/filtered shape on create, get, update, and list', async () => {
    testsRan += 1;
    const { token } = await principal('proj-shape@example.com', 'ProjShapeOrg');

    // CREATE through the projected route: the 201 body is the projected shape.
    const created = await post(token, '/companions', COMPANION);
    expect(created.status).toBe(201);
    const row = (await created.json()) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['companionId', 'createdAt', 'name', 'role']);
    expect(row.name).toBe('ada');
    expect(row.role).toBe('engineer');
    expect(typeof row.companionId).toBe('string');
    expect(new Date(row.createdAt as string).toISOString()).toBe(row.createdAt);
    const id = row.companionId as string;

    // GET by id (the path param is the row uuid — path/query naming stays author-side).
    const got = (await (await get(token, `/companions/${id}`)).json()) as Record<string, unknown>;
    expect(Object.keys(got).sort()).toEqual(['companionId', 'createdAt', 'name', 'role']);
    expect(got.companionId).toBe(id);

    // UPDATE: the body stays AUTHOR-named (write side untouched); the response is projected.
    const updated = await patch(token, `/companions/${id}`, { role: 'captain' });
    expect(updated.status).toBe(200);
    const upd = (await updated.json()) as Record<string, unknown>;
    expect(Object.keys(upd).sort()).toEqual(['companionId', 'createdAt', 'name', 'role']);
    expect(upd.role).toBe('captain');

    // LIST: every row projected.
    const listed = (await (await get(token, '/companions')).json()) as Record<string, unknown>[];
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
      'companionId',
      'createdAt',
      'name',
      'role',
    ]);
  });

  it('an idempotency replay is projected too (the fifth serialize site)', async () => {
    testsRan += 1;
    const { token } = await principal('proj-replay@example.com', 'ProjReplayOrg');
    const key = { 'idempotency-key': 'proj-key-1' };

    const first = await post(token, '/companions', COMPANION, key);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as Record<string, unknown>;

    const replay = await post(token, '/companions', COMPANION, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replay')).toBe('true');
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(Object.keys(replayBody).sort()).toEqual(['companionId', 'createdAt', 'name', 'role']);
    expect(replayBody).toEqual(firstBody);
  });

  it('casing: camel alone re-keys the FULL row — all 8 injected props camel, double a number, numeric a string', async () => {
    testsRan += 1;
    const { token } = await principal('proj-camel@example.com', 'ProjCamelOrg');
    const noteId = '00000000-0000-4000-8000-000000000042';
    await post(token, '/companions-raw', { ...COMPANION, note_id: noteId });

    const rows = (await (await get(token, '/companions-camel')).json()) as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      'createdAt',
      'createdBy',
      'deletedAt',
      'id',
      'idempotencyKey',
      'name',
      'noteId',
      'price',
      'region',
      'retentionDays',
      'role',
      'score',
      'tenantId',
    ]);
    expect(row.noteId).toBe(noteId);
    expect(row.score).toBe(1.5); // double: a JSON number, unchanged by the projection
    expect(row.price).toBe('12.34'); // numeric: the exact decimal STRING, unchanged
    expect(row.deletedAt).toBeNull();
    expect(typeof row.createdBy).toBe('string');
  });

  it('READ-SIDE ONLY: the write path on a projected route is byte-identical (snake OR camel body, ambiguity still 400, stored values unchanged)', async () => {
    testsRan += 1;
    const { token } = await principal('proj-write@example.com', 'ProjWriteOrg');
    const noteId = '00000000-0000-4000-8000-000000000007';

    // snake-keyed body on the PROJECTED route.
    const snake = await post(token, '/companions', { ...COMPANION, note_id: noteId });
    expect(snake.status).toBe(201);
    const snakeId = ((await snake.json()) as Record<string, unknown>).companionId as string;

    // camel-keyed body on the PROJECTED route.
    const camel = await post(token, '/companions', { ...COMPANION, noteId });
    expect(camel.status).toBe(201);

    // BOTH casings of the same column in one body: the documented ambiguity 400, unchanged.
    const both = await post(token, '/companions', { ...COMPANION, note_id: noteId, noteId });
    expect(both.status).toBe(400);

    // Wire-named body keys are NOT accepted: the projection renames responses, never requests.
    const wireKey = await post(token, '/companions', { ...COMPANION, companionId: snakeId });
    expect(wireKey.status).toBe(400);

    // The stored row (read through the raw accept-control route) carries exactly the sent values.
    const raw = (await (await get(token, `/companions-raw/${snakeId}`)).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(raw).sort()).toEqual([...RAW_COMPANION_KEYS]);
    expect(raw.name).toBe('ada');
    expect(raw.note_id).toBe(noteId);
    expect(raw.score).toBe(1.5);
    expect(raw.price).toBe('12.34');
  });

  it('the QUERY surface stays AUTHOR-named on a projected route (the documented request/response split)', async () => {
    testsRan += 1;
    const { token } = await principal('proj-query@example.com', 'ProjQueryOrg');
    const noteId = '00000000-0000-4000-8000-000000000021';
    await post(token, '/companions-raw', { ...COMPANION, note_id: noteId });
    await post(token, '/companions-raw', { ...COMPANION, name: 'grace' });

    // Filters and order keep the DECLARED column names…
    const filtered = await get(token, `/companions-camel?note_id=${noteId}`);
    expect(filtered.status).toBe(200);
    expect((await filtered.json()) as unknown[]).toHaveLength(1);
    expect((await get(token, '/companions-camel?order=created_at.asc')).status).toBe(200);
    expect((await get(token, '/companions-camel?score__gt=1')).status).toBe(200);

    // …and the projected WIRE names are NOT query params (fail-closed, unknown param).
    expect((await get(token, `/companions-camel?noteId=${noteId}`)).status).toBe(400);
    expect((await get(token, '/companions-camel?order=createdAt.asc')).status).toBe(400);
  });

  it('keyset pagination survives a RENAMED id: the cursor mints from the raw row and resumes', async () => {
    testsRan += 1;
    const { token } = await principal('proj-page-rename@example.com', 'ProjPageRenameOrg');
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      expect((await post(token, '/companions-raw', { ...COMPANION, name })).status).toBe(201);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const q = `limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const res = await get(token, `/companions?${q}`);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as Record<string, unknown>[];
      if (rows.length === 0) break;
      for (const r of rows) {
        // The response has NO 'id' — the rename moved it — yet the cursor still pages correctly.
        expect(Object.hasOwn(r, 'id')).toBe(false);
        seen.push(r.name as string);
      }
      cursor = res.headers.get('X-Next-Cursor');
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']); // every row exactly once
  });

  it('keyset pagination survives an OMITTED id: fields drops id entirely, the cursor still mints and resumes', async () => {
    testsRan += 1;
    const { token } = await principal('proj-page-omit@example.com', 'ProjPageOmitOrg');
    for (const name of ['p', 'q', 'r', 's', 't']) {
      expect((await post(token, '/companions-raw', { ...COMPANION, name })).status).toBe(201);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const q = `limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const res = await get(token, `/companions-min?${q}`);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as Record<string, unknown>[];
      if (rows.length === 0) break;
      for (const r of rows) {
        expect(Object.keys(r)).toEqual(['name']); // the allowlist is the whole response
        seen.push(r.name as string);
      }
      cursor = res.headers.get('X-Next-Cursor');
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(['p', 'q', 'r', 's', 't']);
  });

  it("a STORE-level project applies to the store's routes; a route-level project: {} overrides it wholesale", async () => {
    testsRan += 1;
    const { token } = await principal('proj-store-level@example.com', 'ProjStoreLevelOrg');

    // The create route inherits the store-level camel projection.
    const created = await post(token, '/sidekicks', { label: 'robin' });
    expect(created.status).toBe(201);
    const row = (await created.json()) as Record<string, unknown>;
    expect(Object.hasOwn(row, 'createdAt')).toBe(true);
    expect(Object.hasOwn(row, 'created_at')).toBe(false);
    expect(Object.hasOwn(row, 'tenantId')).toBe(true);

    // So does the list route.
    const listed = (await (await get(token, '/sidekicks')).json()) as Record<string, unknown>[];
    expect(Object.hasOwn(listed[0] ?? {}, 'createdAt')).toBe(true);

    // The `project: {}` route overrides WHOLESALE — back to the raw snake shape.
    const plain = (await (await get(token, '/sidekicks-plain')).json()) as Record<
      string,
      unknown
    >[];
    expect(Object.hasOwn(plain[0] ?? {}, 'created_at')).toBe(true);
    expect(Object.hasOwn(plain[0] ?? {}, 'createdAt')).toBe(false);
  });

  it('ACCEPT-CONTROL: a route WITHOUT project serializes the exact historical snake shape on all five sites', async () => {
    testsRan += 1;
    const { token } = await principal('proj-control@example.com', 'ProjControlOrg');
    const key = { 'idempotency-key': 'raw-key-1' };

    // create (201)
    const created = await post(token, '/companions-raw', COMPANION, key);
    expect(created.status).toBe(201);
    const row = (await created.json()) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([...RAW_COMPANION_KEYS]);
    expect(row.note_id).toBeNull();
    expect(row.score).toBe(1.5);
    expect(row.price).toBe('12.34');
    const id = row.id as string;

    // idempotency replay (200 + header)
    const replay = await post(token, '/companions-raw', COMPANION, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replay')).toBe('true');
    expect(Object.keys((await replay.json()) as object).sort()).toEqual([...RAW_COMPANION_KEYS]);

    // get
    const got = (await (await get(token, `/companions-raw/${id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(got).sort()).toEqual([...RAW_COMPANION_KEYS]);

    // update
    const upd = (await (
      await patch(token, `/companions-raw/${id}`, { role: 'captain' })
    ).json()) as Record<string, unknown>;
    expect(Object.keys(upd).sort()).toEqual([...RAW_COMPANION_KEYS]);
    expect(upd.role).toBe('captain');

    // list
    const listed = (await (await get(token, '/companions-raw')).json()) as Record<
      string,
      unknown
    >[];
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([...RAW_COMPANION_KEYS]);
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('store response-projection acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the projection arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(9);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
