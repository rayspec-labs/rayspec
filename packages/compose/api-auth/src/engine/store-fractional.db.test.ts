/**
 * DB-backed acceptance for the FRACTIONAL column types on the declared store routes:
 * `double` (float8) and `numeric(precision, scale)` (exact decimal).
 *
 * `double` round-trips as a JSON NUMBER with float8 semantics — the honest contract is IEEE-754
 * binary64, so what a client reads back is exactly the float64 it wrote, never a re-rounded decimal.
 *
 * `numeric` is the exact type, and exactness is the whole point — which JSON numbers cannot deliver:
 * `JSON.parse` maps every numeric literal through float64 BEFORE any validator runs, so a decimal
 * with 18+ significant digits is corrupted before the platform could even see it. The wire form is
 * therefore a STRING, both directions: a write is a decimal string validated against the declared
 * `(precision, scale)` — refused rather than rounded when it does not fit — and a read emits the
 * exact stored decimal as a string (Postgres's canonical rendering with exactly `scale` fractional
 * digits). A JSON number on a numeric column is refused outright: after float64 the author's exact
 * decimal can no longer be proven, and this API never stores a value it cannot prove.
 *
 * Sortability is part of the contract and proven here: both types order numerically (a numeric
 * string is compared as a NUMBER server-side, never lexicographically) and keyset-paginate.
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
    'store-fractional.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the double/numeric round-trip acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_store_fractional';

/**
 * A decimal a float64 round-trip CORRUPTS (18 integer digits + nonzero cents): `Number()` of it is
 * 123456789012345680, so any code path that touches float64 loses the value. numeric(24, 6) holds it
 * exactly, and the byte-equal read below is the proof the platform never touched float64.
 */
const EXACT_DECIMAL = '123456789012345678.123456';

// A self-contained throwaway backend-profile spec. Neutral names only:
//  - `readings.confidence` (double) — the float8 round-trip / filter / order / cursor column;
//  - `ledger_lines.amount` (numeric(24, 6)) — the exact-decimal column.
const FRACTIONAL_YAML = `
version: '1.0'
metadata:
  name: fractional-backend
  description: A backend proving the double and numeric column types end to end.
stores:
  - name: readings
    columns:
      - { name: confidence, type: double }
      - { name: label, type: text, nullable: true }
  - name: ledger_lines
    columns:
      - { name: amount, type: numeric, precision: 24, scale: 6 }
      - { name: note, type: text, nullable: true }
api:
  - { method: POST, path: '/readings', action: { kind: store, store: readings, op: create } }
  - { method: GET, path: '/readings', action: { kind: store, store: readings, op: list } }
  - { method: GET, path: '/readings/{id}', action: { kind: store, store: readings, op: get } }
  - { method: POST, path: '/lines', action: { kind: store, store: ledger_lines, op: create } }
  - { method: GET, path: '/lines', action: { kind: store, store: ledger_lines, op: list } }
  - { method: GET, path: '/lines/{id}', action: { kind: store, store: ledger_lines, op: get } }
  - method: GET
    path: /plines
    action: { kind: store, store: ledger_lines, op: list }
    project: { fields: [id, note] }
`;

let testsRan = 0;

interface ReadingRow {
  id: string;
  confidence: number;
  label: string | null;
}
interface LineRow {
  id: string;
  amount: string;
  note: string | null;
}

describeDb('declared store — the double and numeric column types', () => {
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

  const createReading = (token: string, body: Record<string, unknown>) =>
    jsonRequest(h.app, 'POST', '/readings', { body, headers: auth(token) });
  const listReadings = (token: string, query = '') =>
    jsonRequest(h.app, 'GET', `/readings${query ? `?${query}` : ''}`, { headers: auth(token) });
  const createLine = (token: string, body: Record<string, unknown>) =>
    jsonRequest(h.app, 'POST', '/lines', { body, headers: auth(token) });
  const listLines = (token: string, query = '') =>
    jsonRequest(h.app, 'GET', `/lines${query ? `?${query}` : ''}`, { headers: auth(token) });
  /** The SAME store and the same rows, through a route whose projection drops `amount`. */
  const listProjectedLines = (token: string, query = '') =>
    jsonRequest(h.app, 'GET', `/plines${query ? `?${query}` : ''}`, { headers: auth(token) });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(FRACTIONAL_YAML);
    if (!parsed.ok) throw new Error(`fractional fixture invalid: ${JSON.stringify(parsed.errors)}`);
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

  it('double: a fractional value round-trips as a JSON number via float8 (float64 semantics, verbatim)', async () => {
    testsRan += 1;
    const { token } = await principal('double-roundtrip@example.com', 'DoubleRoundtripOrg');

    // 0.1 + 0.2 in float64 is 0.30000000000000004 — the honest contract is that the float the client
    // wrote is the float it reads back, not a decimal the platform re-rounded on either side.
    const values = [0.5, 0.30000000000000004, 1e-7, 12345.678901234567];
    for (const v of values) {
      const created = await createReading(token, { confidence: v });
      expect(created.status).toBe(201);
      const id = ((await created.json()) as ReadingRow).id;
      const got = await jsonRequest(h.app, 'GET', `/readings/${id}`, { headers: auth(token) });
      expect(got.status).toBe(200);
      const row = (await got.json()) as ReadingRow;
      expect(row.confidence).toBe(v); // exact float64 identity, never a re-rounded decimal
      expect(typeof row.confidence).toBe('number'); // a JSON number on the wire, never a string
    }

    // A string body on a double column is refused (the wire form of a double is a JSON number).
    expect((await createReading(token, { confidence: '0.5' })).status).toBe(400);
  });

  it('numeric: a decimal past float64 exactness round-trips BYTE-EQUAL as a string', async () => {
    testsRan += 1;
    const { token } = await principal('numeric-exact@example.com', 'NumericExactOrg');

    // The in-test demonstration that float64 corrupts this value — the reason the wire is a string.
    expect(String(Number(EXACT_DECIMAL))).not.toBe(EXACT_DECIMAL);

    const created = await createLine(token, { amount: EXACT_DECIMAL });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as LineRow).id;
    const got = await jsonRequest(h.app, 'GET', `/lines/${id}`, { headers: auth(token) });
    expect(got.status).toBe(200);
    const row = (await got.json()) as LineRow;
    expect(row.amount).toBe(EXACT_DECIMAL); // byte-equal: the platform never touched float64
    expect(typeof row.amount).toBe('string'); // a string on the wire, both directions

    // A value with FEWER fractional digits than the scale is exact too; the read emits Postgres's
    // canonical rendering with exactly `scale` fractional digits (value-preserving, documented).
    const short = await createLine(token, { amount: '7.5' });
    expect(short.status).toBe(201);
    const shortId = ((await short.json()) as LineRow).id;
    const shortRow = (await (
      await jsonRequest(h.app, 'GET', `/lines/${shortId}`, { headers: auth(token) })
    ).json()) as LineRow;
    expect(shortRow.amount).toBe('7.500000');
  });

  it('numeric WRITE envelope: refused (never rounded) when the value does not fit numeric(24, 6)', async () => {
    testsRan += 1;
    const { token } = await principal('numeric-refuse@example.com', 'NumericRefuseOrg');

    // A JSON NUMBER is refused outright: JSON.parse already mapped it through float64, so the
    // author's exact decimal can no longer be proven — fail-closed, never a silent re-rendering.
    const asNumber = await createLine(token, { amount: 12.5 });
    expect(asNumber.status).toBe(400);

    // More fractional digits than the scale would ROUND in Postgres — refused instead.
    expect((await createLine(token, { amount: '1.2345671' })).status).toBe(400);
    // ... even when the extra digits are zeros (the envelope is "at most `scale` fractional digits").
    expect((await createLine(token, { amount: '1.5000000' })).status).toBe(400);
    // More integer digits than precision - scale would overflow (Postgres 22003) — refused early.
    expect((await createLine(token, { amount: '1234567890123456789.5' })).status).toBe(400);
    // Malformed decimals: exponent/hex/blank/multi-dot/plus-sign forms are not the wire shape.
    for (const bad of ['abc', '1e5', '0x10', '', ' 1 ', '1.2.3', '+1', '1.', '.5', 'NaN']) {
      expect((await createLine(token, { amount: bad })).status).toBe(400);
    }

    // The refusal is a VALIDATION_ERROR, not a server fault.
    const over = await createLine(token, { amount: '1.2345671' });
    expect(((await over.json()) as { error?: { code?: string } }).error?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('double READ guard: a non-finite float8 planted by direct SQL is a 400, NOT a silent null', async () => {
    testsRan += 1;
    const { token } = await principal('double-read@example.com', 'DoubleReadOrg');
    const created = await createReading(token, { confidence: 0.5, label: 'planted' });
    const id = ((await created.json()) as ReadingRow).id;
    // float8 can hold NaN/Infinity at the SQL level; JSON cannot carry them, and JSON.stringify
    // would silently turn NaN into null — the exact silent corruption the read guard refuses.
    await h.db.execute(
      drizzleSql`UPDATE readings SET confidence = 'NaN'::float8 WHERE id = ${id}::uuid`,
    );
    const got = await jsonRequest(h.app, 'GET', `/readings/${id}`, { headers: auth(token) });
    expect(got.status).toBe(400);
    expect(got.status).not.toBe(500);
    const body = await got.text();
    expect(body).toContain('VALIDATION_ERROR');
    expect(body).toContain('confidence'); // names the column so the row is findable
  });

  it('double: filters and keyset pagination order NUMERICALLY (equality, __in, order + after)', async () => {
    testsRan += 1;
    const { token } = await principal('double-filter@example.com', 'DoubleFilterOrg');
    for (const v of [2.5, 0.5, 1.5]) {
      expect((await createReading(token, { confidence: v })).status).toBe(201);
    }

    const eq = (await (await listReadings(token, 'confidence=1.5')).json()) as ReadingRow[];
    expect(eq.map((r) => r.confidence)).toEqual([1.5]);

    const inSet = (await (
      await listReadings(token, 'confidence__in=0.5,2.5')
    ).json()) as ReadingRow[];
    expect(inSet.map((r) => r.confidence).sort((a, b) => a - b)).toEqual([0.5, 2.5]);

    // Keyset paging: page 2 binds the cursor's order value back into the query, so a cursor that
    // dropped or re-rounded the float surfaces here.
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const q = `order=confidence.asc&limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const res = await listReadings(token, q);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as ReadingRow[];
      if (rows.length === 0) break;
      for (const r of rows) seen.push(r.confidence);
      cursor = res.headers.get('X-Next-Cursor');
      if (!cursor) break;
    }
    expect(seen).toEqual([0.5, 1.5, 2.5]);

    // A malformed filter value is refused early.
    expect((await listReadings(token, 'confidence=abc')).status).toBe(400);
  });

  it('numeric: filters and keyset pagination order NUMERICALLY, never lexicographically', async () => {
    testsRan += 1;
    const { token } = await principal('numeric-filter@example.com', 'NumericFilterOrg');
    // '9.999999' sorts AFTER '10.000001' lexicographically — the discriminator that proves the
    // ordering is the DB's numeric comparison, not a string comparison anywhere on the path.
    for (const v of ['10.000002', '9.999999', '10.000001']) {
      expect((await createLine(token, { amount: v })).status).toBe(201);
    }

    const eq = (await (await listLines(token, 'amount=9.999999')).json()) as LineRow[];
    expect(eq.map((r) => r.amount)).toEqual(['9.999999']);

    const inSet = (await (
      await listLines(token, 'amount__in=10.000001,10.000002')
    ).json()) as LineRow[];
    expect(inSet.map((r) => r.amount).sort()).toEqual(['10.000001', '10.000002']);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const q = `order=amount.asc&limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const res = await listLines(token, q);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as LineRow[];
      if (rows.length === 0) break;
      for (const r of rows) seen.push(r.amount);
      cursor = res.headers.get('X-Next-Cursor');
      if (!cursor) break;
    }
    expect(seen).toEqual(['9.999999', '10.000001', '10.000002']);

    // A filter beyond the declared scale is a valid decimal — the comparison is EXACT, so it
    // honestly matches zero rows (never a rounded match).
    const beyondScale = (await (await listLines(token, 'amount=10.0000015')).json()) as LineRow[];
    expect(beyondScale).toEqual([]);

    // A malformed filter value is refused early.
    expect((await listLines(token, 'amount=1e5')).status).toBe(400);
  });

  it('numeric READ guard: a NaN planted by direct SQL is a 400, and no page mints a cursor on it', async () => {
    testsRan += 1;
    const { token } = await principal('numeric-read@example.com', 'NumericReadOrg');
    for (const v of ['1.000000', '2.000000']) {
      expect((await createLine(token, { amount: v })).status).toBe(201);
    }
    const planted = (await (await listLines(token, 'amount=1.000000')).json()) as LineRow[];
    const id = planted[0]?.id as string;
    // numeric can hold NaN (and, from PostgreSQL 14, ±Infinity) at the SQL level. The write paths
    // refuse it — only direct SQL can plant it — and it is not a decimal, so it is not a value the
    // string wire form of this type can carry.
    await h.db.execute(
      drizzleSql`UPDATE ledger_lines SET amount = 'NaN'::numeric WHERE id = ${id}::uuid`,
    );

    const got = await jsonRequest(h.app, 'GET', `/lines/${id}`, { headers: auth(token) });
    expect(got.status).toBe(400);
    expect(got.status).not.toBe(500);
    const body = await got.text();
    expect(body).toContain('VALIDATION_ERROR');
    expect(body).toContain('amount'); // names the column so the row is findable
    expect(body).not.toContain('"NaN"'); // and never ships the value as the read envelope's decimal

    // The LIST page containing the row refuses too — which is what keeps THIS feed followable: the
    // cursor is minted from the last row of a page that was served, so a page that refuses mints
    // nothing, and no client of this route is handed an `after=` value the next request would
    // reject as a filter. The reach of that is exactly the routes that SERVE the column — the next
    // test pins the other side.
    const page = await listLines(token, 'order=amount.desc&limit=1'); // NaN sorts highest in SQL
    expect(page.status).toBe(400);
    expect(page.headers.get('X-Next-Cursor')).toBe(null);

    // The rest of the feed is unaffected: the row is one row, not the whole store.
    const rest = await listLines(token, 'amount=2.000000');
    expect(rest.status).toBe(200);
    expect(((await rest.json()) as LineRow[]).map((r) => r.amount)).toEqual(['2.000000']);
  });

  it('numeric READ guard REACH: a projection that drops the column drops the guard with it — the page serves and still mints the cursor the next request refuses', async () => {
    testsRan += 1;
    const { token } = await principal('numeric-proj@example.com', 'NumericProjOrg');
    expect((await createLine(token, { amount: '2.000000' })).status).toBe(201);
    expect((await createLine(token, { amount: '1.000000' })).status).toBe(201);
    const planted = (await (await listLines(token, 'amount=1.000000')).json()) as LineRow[];
    const id = planted[0]?.id as string;
    await h.db.execute(
      drizzleSql`UPDATE ledger_lines SET amount = 'NaN'::numeric WHERE id = ${id}::uuid`,
    );

    // ACCEPT CONTROL — the SAME row through a route that SERVES `amount`: the guard fires, the page
    // is refused as a whole, and no cursor is minted. Without this arm a broken fixture would make
    // the projected arm below look like a finding when it is really measuring nothing.
    const unprojected = await listLines(token, 'order=amount.desc&limit=1');
    expect(unprojected.status).toBe(400);
    expect(unprojected.headers.get('X-Next-Cursor')).toBe(null);

    // The REACH boundary. `/plines` projects `amount` away, and `serializeRow` skips a column absent
    // from the projection BEFORE any read guard runs — so the guard never sees the value and the page
    // is served. `order` is validated against the store's columns, never against the projection (the
    // documented author-named query surface), so `order=amount.desc` is accepted here, and the cursor
    // mints from the RAW row. The client is handed an `after=` value its own next request refuses.
    const page = await listProjectedLines(token, 'order=amount.desc&limit=1');
    expect(page.status).toBe(200);
    const rows = (await page.json()) as Record<string, unknown>[];
    expect(rows.map((r) => Object.keys(r).sort())).toEqual([['id', 'note']]); // `amount` never on the wire
    const cursor = page.headers.get('X-Next-Cursor');
    expect(cursor).not.toBe(null);
    const decoded = JSON.parse(Buffer.from(cursor as string, 'base64url').toString('utf8'));
    expect(decoded).toMatchObject({ c: 'amount', d: 'desc', v: 'NaN' });

    // Following it is the stranded-client shape the guard removes on a route that serves the column.
    const followUp = await listProjectedLines(
      token,
      `order=amount.desc&limit=1&after=${encodeURIComponent(cursor as string)}`,
    );
    expect(followUp.status).toBe(400);
    expect(await followUp.text()).toContain(
      "Filter 'amount' must be a plain decimal string (no exponent).",
    );
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('fractional column acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the double/numeric arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(8);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
