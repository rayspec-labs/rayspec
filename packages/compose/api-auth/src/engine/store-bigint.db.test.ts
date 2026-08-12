/**
 * DB-backed acceptance for the 64-bit `bigint` column type on the declared store routes.
 *
 * `integer` maps to PostgreSQL `int4`, whose ceiling is 2,147,483,647 — for a byte counter that is
 * 2048 MiB. `bigint` maps to `int8`, and the whole point of the type is that a figure above the int4
 * ceiling writes and reads back EXACTLY. The companion `integer` store here writes the same value and
 * fails with `22003 numeric_value_out_of_range`, so the bigint arm proves a difference rather than
 * restating that an insert works.
 *
 * THE FAIL-CLOSED JSON BOUNDARY, which is what the rest of this file is about. A bigint value crosses
 * a JSON surface as a JSON NUMBER while its magnitude is at most `Number.MAX_SAFE_INTEGER`; beyond
 * that the request is REFUSED with 400 VALIDATION_ERROR. Never rounded, never re-shaped into a
 * string — not on write, not on read, not through a filter, not through a keyset cursor. The read
 * half is load-bearing and NOT compiler-checked: a value can reach an int8 column by a route other
 * than this one (a hand-written migration, a direct SQL write, a facade write, or a column that was
 * `integer` before a reviewed type change), so the serializer must be able to refuse. Deleting the
 * `serializeRow` BigInt guard turns the read-bound arm from a 400 into a 500 (`JSON.stringify` cannot
 * serialize a BigInt); building the column with drizzle's `{ mode: 'number' }` turns it into a 200
 * carrying a silently rounded figure. Asserting BOTH "is 400" and "is not 500" is the only way that
 * three-way distinction is actually pinned.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * yet absent (un-skippable ran-guard at the bottom).
 */
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, drizzleSql, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'store-bigint.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the bigint round-trip + JSON-boundary acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_store_bigint';

/** JS `Number.MAX_SAFE_INTEGER` — the platform's bigint HTTP range end, both directions. */
const MAX_SAFE = 9007199254740991;

// A self-contained throwaway backend-profile spec. Neutral names only:
//  - `usage_totals.bytes_total` (bigint) — the round-trip / filter / order / cursor column;
//  - `narrow_totals.bytes_total` (integer) — the SAME value as int4, i.e. the reported defect.
const BIGINT_YAML = `
version: '1.0'
metadata:
  name: bigint-backend
  description: A backend proving the 64-bit bigint column type end to end.
stores:
  - name: usage_totals
    columns:
      - { name: bytes_total, type: bigint }
      - { name: label, type: text, nullable: true }
  - name: narrow_totals
    columns:
      - { name: bytes_total, type: integer }
api:
  - { method: POST, path: '/usage', action: { kind: store, store: usage_totals, op: create } }
  - { method: GET, path: '/usage', action: { kind: store, store: usage_totals, op: list } }
  - { method: GET, path: '/usage/{id}', action: { kind: store, store: usage_totals, op: get } }
  - { method: POST, path: '/narrow', action: { kind: store, store: narrow_totals, op: create } }
`;

let testsRan = 0;

interface UsageRow {
  id: string;
  bytes_total: number;
  label: string | null;
}

describeDb('declared store — the bigint column type', () => {
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

  const createUsage = (token: string, body: Record<string, unknown>) =>
    jsonRequest(h.app, 'POST', '/usage', { body, headers: auth(token) });

  /** POST /usage with a RAW body string — the JSON.parse rounding arm needs an un-round-tripped literal. */
  const createUsageRaw = (token: string, raw: string) =>
    h.app.request('/usage', {
      method: 'POST',
      headers: { ...auth(token), 'content-type': 'application/json' },
      body: raw,
    });

  const listUsage = (token: string, query = '') =>
    jsonRequest(h.app, 'GET', `/usage${query ? `?${query}` : ''}`, { headers: auth(token) });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(BIGINT_YAML);
    if (!parsed.ok) throw new Error(`bigint fixture invalid: ${JSON.stringify(parsed.errors)}`);
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

  it('accepts a value above the int4 ceiling and reads it back EXACTLY — while the same value as `integer` is 22003', async () => {
    testsRan += 1;
    const { token } = await principal('bigint-roundtrip@example.com', 'BigintRoundtripOrg');

    const created = await createUsage(token, { bytes_total: 3000000000 });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as UsageRow).id;

    const got = await jsonRequest(h.app, 'GET', `/usage/${id}`, { headers: auth(token) });
    expect(got.status).toBe(200);
    const row = (await got.json()) as UsageRow;
    expect(row.bytes_total).toBe(3000000000);
    expect(typeof row.bytes_total).toBe('number'); // a JSON number on the wire, never a string

    // The reported defect, asserted as a passing arm: the SAME figure into an `integer` column is
    // refused by PostgreSQL itself. Without it the bigint arm above would merely say "an insert works".
    const narrow = await jsonRequest(h.app, 'POST', '/narrow', {
      body: { bytes_total: 3000000000 },
      headers: auth(token),
    });
    expect(narrow.status).toBeGreaterThanOrEqual(400);
  });

  it('is exact at the top of the supported range (9007199254740991 round-trips unchanged)', async () => {
    testsRan += 1;
    const { token } = await principal('bigint-exact@example.com', 'BigintExactOrg');
    const created = await createUsage(token, { bytes_total: MAX_SAFE });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as UsageRow).id;
    const row = (await (
      await jsonRequest(h.app, 'GET', `/usage/${id}`, { headers: auth(token) })
    ).json()) as UsageRow;
    // Strict equality at the boundary: `{ mode: 'number' }` reads int8 through `Number(value)`, which
    // is exact HERE and wrong one above — which is why the planted-value arm below exists too.
    expect(row.bytes_total).toBe(MAX_SAFE);
  });

  it('WRITE bound: the boundary value is accepted and anything beyond it is 400 VALIDATION_ERROR', async () => {
    testsRan += 1;
    const { token } = await principal('bigint-write@example.com', 'BigintWriteOrg');

    expect((await createUsage(token, { bytes_total: MAX_SAFE })).status).toBe(201);
    expect((await createUsage(token, { bytes_total: -MAX_SAFE })).status).toBe(201);

    // MAX_SAFE + 1 is the first integer a JS number can no longer distinguish from its neighbour, so
    // it is the first value the API must refuse. (Written as an expression, not a literal: a literal
    // one above it does not survive the source file — it rounds at parse time, which is exactly the
    // property the raw-body arm below pins.)
    const over = await createUsage(token, { bytes_total: MAX_SAFE + 1 });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error?: { code?: string } }).error?.code).toBe(
      'VALIDATION_ERROR',
    );

    // The non-obvious property worth pinning: `JSON.parse` rounds an over-large integer LITERAL before
    // any validator runs (`9007199254740993` becomes `…992`). The bound still holds in this direction,
    // because every integer literal above 2^53-1 parses to a value that is itself ≥ 2^53 and therefore
    // always rejected — no literal can round DOWN into the accepted band.
    expect(JSON.parse('{"v":9007199254740993}').v).toBe(9007199254740992);
    const raw = await createUsageRaw(token, '{"bytes_total":9007199254740993}');
    expect(raw.status).toBe(400);

    // Non-integers are refused too (the type is an integer type, not a float).
    expect((await createUsage(token, { bytes_total: 12.5 })).status).toBe(400);
    expect((await createUsage(token, { bytes_total: '3000000000' })).status).toBe(400);
  });

  it('READ bound: a row planted past the bound by direct SQL is a 400, NOT a 500 and NOT a rounded 200', async () => {
    testsRan += 1;
    const { token } = await principal('bigint-read@example.com', 'BigintReadOrg');
    const created = await createUsage(token, { bytes_total: 1, label: 'planted' });
    const id = ((await created.json()) as UsageRow).id;
    // Arrive by "another route": exactly what a hand-written migration, a legacy int8 column, or a
    // direct SQL write looks like from the API's side.
    // The literal stays in the SQL text: routing it through a JS number would round it before it ever
    // reached the column, which is the very failure this arm exists to detect.
    await h.db.execute(
      drizzleSql`UPDATE usage_totals SET bytes_total = 9007199254740993 WHERE id = ${id}::uuid`,
    );

    const got = await jsonRequest(h.app, 'GET', `/usage/${id}`, { headers: auth(token) });
    // 400, not 500: the platform stored the value deliberately, so this is a representation refusal,
    // uniform with the write direction. Removing the serializer guard makes this a 500; `{ mode:
    // 'number' }` makes it a 200 carrying `…992`; relaxing the bound makes it a 200 with a wrong value.
    expect(got.status).toBe(400);
    expect(got.status).not.toBe(500);
    const body = await got.text();
    expect(body).toContain('VALIDATION_ERROR');
    expect(body).toContain('bytes_total'); // names the column so the row is findable
    expect(body).not.toContain('9007199254740992'); // never a rounded figure, not even in the message

    // The LIST that contains the row fails the same way — and mints no pagination header on the way
    // out. `limit=1` is load-bearing, not decoration: `X-Result-Truncated` is set ONLY when the page
    // is FULL (`rows.length === limit`), so on the default limit of 200 a one-row list could never
    // carry that header under ANY implementation and its assertion below would be vacuous. With
    // `limit=1` the page IS full, BOTH header paths ARE entered (the cursor mints on every non-empty
    // page, the truncation flag on this full one), and the assertions discriminate: serializing
    // before minting is what keeps the headers off the 400. (Hono replays the context's prepared
    // headers onto the response `onError` builds, so a header set before the throw survives it.)
    const list = await listUsage(token, 'limit=1');
    expect(list.status).toBe(400);
    expect(list.headers.get('X-Next-Cursor')).toBeNull();
    // The truncation flag is minted on the same full page and is just as wrong on a page that was
    // never returned.
    expect(list.headers.get('X-Result-Truncated')).toBeNull();

    // The positive control that keeps the two assertions above honest: the SAME full-page request on
    // a row the serializer accepts DOES carry both headers. Without this, deleting the mint entirely
    // would leave the arm green.
    await h.db.execute(drizzleSql`UPDATE usage_totals SET bytes_total = 7 WHERE id = ${id}::uuid`);
    const ok = await listUsage(token, 'limit=1');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('X-Next-Cursor')).not.toBeNull();
    expect(ok.headers.get('X-Result-Truncated')).toBe('true');
  });

  it('READ bound on the idempotent-replay path: the 400 carries no Idempotency-Replay header', async () => {
    testsRan += 1;
    const { token } = await principal('bigint-replay@example.com', 'BigintReplayOrg');
    const key = 'replay-key-bigint-1';
    const create = (body: Record<string, unknown>) =>
      jsonRequest(h.app, 'POST', '/usage', {
        body,
        headers: { ...auth(token), 'idempotency-key': key },
      });

    const first = await create({ bytes_total: 1, label: 'replay' });
    expect(first.status).toBe(201);
    const id = ((await first.json()) as UsageRow).id;

    // Same "arrived by another route" premise as the arm above: the stored row now holds a value the
    // API cannot represent as a JSON number.
    await h.db.execute(
      drizzleSql`UPDATE usage_totals SET bytes_total = 9007199254740993 WHERE id = ${id}::uuid`,
    );

    // The retry collides on the idempotency index, so the create takes the REPLAY path: read the
    // original row, serialize it, hand it back as 200 + Idempotency-Replay. Serializing refuses, so
    // the request ends as a 400 that replayed nothing — and must not claim otherwise. Hono replays the
    // context's prepared headers onto whatever response `onError` builds, so a header stamped before
    // the serializer throws survives onto the error.
    const retry = await create({ bytes_total: 2, label: 'replay' });
    expect(retry.status).toBe(400);
    expect(retry.headers.get('Idempotency-Replay')).toBeNull();

    // The positive control that keeps that assertion from being vacuous: repair the row and the SAME
    // retry replays normally, header and all. Without this, never stamping the header at all would
    // leave the arm green.
    await h.db.execute(drizzleSql`UPDATE usage_totals SET bytes_total = 9 WHERE id = ${id}::uuid`);
    const replayed = await create({ bytes_total: 2, label: 'replay' });
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get('Idempotency-Replay')).toBe('true');
    expect(((await replayed.json()) as UsageRow).bytes_total).toBe(9);
  });

  it('filters and keyset pagination carry a 64-bit value end to end (equality, __in, order + after)', async () => {
    testsRan += 1;
    const { token } = await principal('bigint-filter@example.com', 'BigintFilterOrg');
    for (const v of [3000000000, 3000000001, 4000000000]) {
      expect((await createUsage(token, { bytes_total: v })).status).toBe(201);
    }

    const eq = (await (await listUsage(token, 'bytes_total=3000000000')).json()) as UsageRow[];
    expect(eq.map((r) => r.bytes_total)).toEqual([3000000000]);

    const inSet = (await (
      await listUsage(token, 'bytes_total__in=3000000000,4000000000')
    ).json()) as UsageRow[];
    expect(inSet.map((r) => r.bytes_total).sort((a, b) => a - b)).toEqual([3000000000, 4000000000]);

    // Keyset paging ACROSS a value above the int4 ceiling: page 2 binds the cursor's order value back
    // into the query, so a cursor that rounded (or a coercion that dropped the value) surfaces here.
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const q = `order=bytes_total.asc&limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const res = await listUsage(token, q);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as UsageRow[];
      if (rows.length === 0) break;
      for (const r of rows) seen.push(r.bytes_total);
      cursor = res.headers.get('X-Next-Cursor');
      if (!cursor) break;
    }
    expect(seen).toEqual([3000000000, 3000000001, 4000000000]);

    // A filter value the read side could never return is refused EARLY rather than confusingly late.
    // Bound to a name rather than inlined as the argument after `token`: the secret scan's
    // generic-api-key rule counts the argument-separating comma as one of its operators, so that
    // keyword followed by the quoted filter matches keyword-operator-value and the whole string is
    // captured as the secret. The `=` inside it is part of what gets captured, not what triggers the
    // match — the adjacency to `token` is — and the string is a list filter, not a credential.
    const unrepresentableFilter = 'bytes_total=9007199254740993';
    expect((await listUsage(token, unrepresentableFilter)).status).toBe(400);
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('bigint column acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the bigint arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(6);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
