/**
 * DB-backed acceptance for OPT-IN soft delete on a declared store.
 *
 * When a store declares `softDelete: true`, a DELETE STAMPS the injected `deleted_at` tombstone (the
 * row survives at the DB level) instead of physically removing the row, and a tombstoned row is
 * UNIFORMLY invisible: get → 404, list omits it, a 2nd DELETE → 404, PATCH → 404. When a store does
 * NOT declare it (the DEFAULT), a DELETE is a HARD physical delete — byte-behaviourally identical to
 * the pre-soft-delete engine (the load-bearing E-1 default invariant).
 *
 * Drives the REAL declared store-routes through the REAL `createAuthApp` middleware chain over an
 * isolated Postgres schema, from a SELF-CONTAINED throwaway backend-profile spec (product-free
 * platform: the `articles`/`pings` stores + routes come from this fixture, mirroring the acme-notes
 * harness / store-conflict.db.test.ts).
 *
 * Fail-the-fix:
 *  - the softDelete arm: WITHOUT the tombstone rewrite, DELETE would physically remove the row, so the
 *    "row SURVIVES at the DB level (count=1, deleted_at set)" assertion goes RED.
 *  - the E-1 default arm: making the delete path ALWAYS soft (ignore the flag) makes the "a
 *    non-softDelete store DELETE physically removes the row (count=0)" assertion go RED — the explicit
 *    guard against a silent data-semantics break where a non-softDelete store gets soft-deleted.
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
    'store-soft-delete.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the soft-delete + hard-delete-default acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_store_soft_delete';

// A self-contained throwaway backend-profile spec:
//  - `articles` OPTS INTO soft delete (`softDelete: true`) + carries a tenant-scoped author-`unique`
//    column (`code`) so the unique-after-soft-delete limitation is exercisable.
//  - `pings` does NOT opt in ⇒ the DEFAULT hard physical delete (the E-1 invariant).
const SOFT_DELETE_YAML = `
version: '1.0'
metadata:
  name: soft-delete-backend
  description: A backend proving opt-in soft delete (tombstone) vs the default hard delete.
stores:
  - name: articles
    softDelete: true
    columns:
      - { name: title, type: text }
      - { name: code, type: text, unique: true }
  - name: pings
    columns:
      - { name: label, type: text }
api:
  - { method: POST, path: '/articles', action: { kind: store, store: articles, op: create } }
  - { method: GET, path: '/articles', action: { kind: store, store: articles, op: list } }
  - { method: GET, path: '/articles/{id}', action: { kind: store, store: articles, op: get } }
  - { method: PATCH, path: '/articles/{id}', action: { kind: store, store: articles, op: update } }
  - { method: DELETE, path: '/articles/{id}', action: { kind: store, store: articles, op: delete } }
  - { method: POST, path: '/pings', action: { kind: store, store: pings, op: create } }
  - { method: GET, path: '/pings/{id}', action: { kind: store, store: pings, op: get } }
  - { method: DELETE, path: '/pings/{id}', action: { kind: store, store: pings, op: delete } }
`;

let testsRan = 0;

describeDb('store soft delete (opt-in) vs hard delete (default)', () => {
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

  const postArticle = (token: string, body: unknown, idemKey?: string) =>
    jsonRequest(h.app, 'POST', '/articles', {
      body,
      headers: { ...auth(token), ...(idemKey ? { 'idempotency-key': idemKey } : {}) },
    });
  const getArticle = (token: string, id: string) =>
    jsonRequest(h.app, 'GET', `/articles/${id}`, { headers: auth(token) });
  const listArticles = (token: string) =>
    jsonRequest(h.app, 'GET', '/articles', { headers: auth(token) });
  const patchArticle = (token: string, id: string, body: unknown) =>
    jsonRequest(h.app, 'PATCH', `/articles/${id}`, { body, headers: auth(token) });
  const deleteArticle = (token: string, id: string) =>
    jsonRequest(h.app, 'DELETE', `/articles/${id}`, { headers: auth(token) });

  const postPing = (token: string, body: unknown) =>
    jsonRequest(h.app, 'POST', '/pings', { body, headers: auth(token) });
  const deletePing = (token: string, id: string) =>
    jsonRequest(h.app, 'DELETE', `/pings/${id}`, { headers: auth(token) });

  /** Raw DB read of a row (search_path pins ${SCHEMA}, public) — bypasses the tombstone filter. */
  async function rawRow(
    tableName: string,
    id: string,
  ): Promise<{ id: string; deleted_at: Date | string | null } | undefined> {
    const rows = (await h.db.$client.unsafe(
      `SELECT id, deleted_at FROM ${tableName} WHERE id = $1`,
      [id],
    )) as unknown as Array<{ id: string; deleted_at: Date | string | null }>;
    return rows[0];
  }
  async function rawCount(tableName: string, id: string): Promise<number> {
    const rows = (await h.db.$client.unsafe(
      `SELECT count(*)::int AS n FROM ${tableName} WHERE id = $1`,
      [id],
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? -1;
  }

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(SOFT_DELETE_YAML);
    if (!parsed.ok)
      throw new Error(`soft-delete fixture invalid: ${JSON.stringify(parsed.errors)}`);
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

  it('softDelete store: DELETE → 204, the row SURVIVES at the DB level (deleted_at set), and is UNIFORMLY invisible (get 404 / list omits / 2nd DELETE 404 / PATCH 404)', async () => {
    testsRan += 1;
    const a = await principal('sd-uniform@example.com', 'SoftDeleteOrg');

    const created = await postArticle(a.token, { title: 'To be tombstoned', code: 'ART-1' });
    expect(created.status).toBe(201);
    const id = (await created.json()).id as string;

    // Sanity: live before delete — get 200, listed, deleted_at null at the DB level.
    expect((await getArticle(a.token, id)).status).toBe(200);
    const liveDbRow = await rawRow('articles', id);
    expect(liveDbRow?.deleted_at).toBeNull();

    // DELETE → 204 (uniform with hard delete — no body leak).
    const del = await deleteArticle(a.token, id);
    expect(del.status).toBe(204);

    // The row SURVIVES physically (fail-the-fix: a hard delete would make count=0) with deleted_at SET.
    expect(await rawCount('articles', id)).toBe(1);
    const dbRow = await rawRow('articles', id);
    // `deleted_at` is stamped (the raw postgres.js driver returns timestamptz as a string; assert it is
    // present AND a valid timestamp, driver-agnostically — not merely truthy garbage).
    expect(dbRow?.deleted_at).not.toBeNull();
    expect(Number.isNaN(new Date(dbRow?.deleted_at as string | Date).getTime())).toBe(false);

    // Uniform invisibility through the API surface:
    expect((await getArticle(a.token, id)).status).toBe(404); // get → 404
    const listed = await (await listArticles(a.token)).json();
    expect(listed).toHaveLength(0); // list omits the tombstoned row
    expect((await deleteArticle(a.token, id)).status).toBe(404); // 2nd DELETE → 404
    expect((await patchArticle(a.token, id, { title: 'changed' })).status).toBe(404); // PATCH → 404
  });

  it('E-1 DEFAULT (non-softDelete store): DELETE physically REMOVES the row (count=0) — the load-bearing default-hard invariant', async () => {
    testsRan += 1;
    const a = await principal('hard-default@example.com', 'HardDeleteOrg');

    const created = await postPing(a.token, { label: 'ephemeral' });
    expect(created.status).toBe(201);
    const id = (await created.json()).id as string;
    expect(await rawCount('pings', id)).toBe(1);

    const del = await deletePing(a.token, id);
    expect(del.status).toBe(204);

    // Fail-the-fix: making the delete path ALWAYS soft (ignore store.softDelete) leaves a physical row
    // (deleted_at stamped) → count=1 → this assertion goes RED. A non-softDelete store must be a HARD
    // delete — a silent soft-delete here is the data-semantics break this arm forbids.
    expect(await rawCount('pings', id)).toBe(0);
  });

  it('cross-tenant: tenant B DELETE cannot tombstone tenant A row (predicate binds; A row stays visible)', async () => {
    testsRan += 1;
    const a = await principal('sd-tenant-a@example.com', 'SoftDeleteOrgA');
    const b = await principal('sd-tenant-b@example.com', 'SoftDeleteOrgB');

    const created = await postArticle(a.token, { title: 'A owns this', code: 'A-CODE' });
    expect(created.status).toBe(201);
    const aId = (await created.json()).id as string;

    // Tenant B DELETEs A's id → uniform 404 (the tenant predicate is AND-combined by TenantDb).
    expect((await deleteArticle(b.token, aId)).status).toBe(404);

    // A's row is UNTOUCHED: still visible to A, still live at the DB level (deleted_at null).
    expect((await getArticle(a.token, aId)).status).toBe(200);
    const dbRow = await rawRow('articles', aId);
    expect(dbRow?.deleted_at).toBeNull();
    const listed = await (await listArticles(a.token)).json();
    expect(listed).toHaveLength(1);
  });

  it('re-creating a unique value AFTER a soft delete is a 409 (documented limitation: the tenant-scoped unique index does NOT exclude tombstones)', async () => {
    testsRan += 1;
    const a = await principal('sd-unique@example.com', 'SoftDeleteUniqueOrg');

    const first = await postArticle(a.token, { title: 'Original', code: 'DUP-CODE' });
    expect(first.status).toBe(201);
    const id = (await first.json()).id as string;

    // Soft-delete it (tombstone stays physically present, still holding `code = DUP-CODE`).
    expect((await deleteArticle(a.token, id)).status).toBe(204);

    // Re-creating the SAME unique value → 409: the `articles_code_unique` compound (tenant_id, code)
    // index is a plain unique, NOT a partial `WHERE deleted_at IS NULL`, so the tombstoned row still
    // occupies the value. Known limitation (unlike the core users partial index) — asserted here so a
    // future change that makes the index partial is a deliberate, visible decision.
    const dup = await postArticle(a.token, { title: 'Reuse the code', code: 'DUP-CODE' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe('CONFLICT');
  });

  it('idempotency replay of a create whose row was soft-deleted REPLAYS the tombstoned row (200 + Idempotency-Replay) — key tracks the physical creation event', async () => {
    testsRan += 1;
    const a = await principal('sd-idem@example.com', 'SoftDeleteIdemOrg');

    // Create with an Idempotency-Key → 201.
    const first = await postArticle(a.token, { title: 'Keyed', code: 'IDEM-CODE' }, 'SD-K1');
    expect(first.status).toBe(201);
    const firstId = (await first.json()).id as string;

    // Soft-delete it (the physical row + its idempotency_key survive as a tombstone).
    expect((await deleteArticle(a.token, firstId)).status).toBe(204);

    // Retry the create with the SAME key → REPLAYS the (tombstoned) original row: 200 + Idempotency-
    // Replay, SAME id. The replay read is keyed on the physical (tenant, idempotency_key) row and is
    // deliberately NOT filtered by deleted_at (documented in store-routes.ts). No new row is created.
    const retry = await postArticle(a.token, { title: 'Keyed', code: 'IDEM-CODE' }, 'SD-K1');
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotency-Replay')).toBe('true');
    expect((await retry.json()).id).toBe(firstId);

    // The replayed row is still the SAME single physical (tombstoned) row — the retry created nothing.
    expect(await rawCount('articles', firstId)).toBe(1);
    const dbRow = await rawRow('articles', firstId);
    expect(dbRow?.deleted_at).not.toBeNull();
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('store soft-delete acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the soft-delete arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(5);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
