/**
 * DB-backed acceptance for the bounded COMPARISON-operator family on the declared store `list` op:
 * `?<col>__gt=` / `__gte=` / `__lt=` / `__lte=`.
 *
 * The list facade was equality/`__in`/`__contains`-only: "give me everything after X" — the natural
 * read for any append-only or time-ordered data — was inexpressible. The operator suffixes extend the
 * `__in` precedent: a distinct per-column suffix, coerced through the SAME per-type coercion equality
 * uses, folded into the SAME AND-chain (so it composes with equality, `__in`, `order`, keyset
 * pagination, and — crucially — the tenant chokepoint, which can never be dropped).
 *
 * ELIGIBILITY IS FAIL-CLOSED: an operator is accepted ONLY on a non-nullable, non-jsonb DECLARED
 * business column. A nullable declared column, a jsonb declared column (even a non-nullable one), an
 * undeclared column, and every injected column (`id`, `created_at`, `created_by`) each 400 — a typo'd
 * operator must never widen a read. And a real column literally named `<x>__gt` still wins as plain
 * equality (the `__in` Precedence-1 discipline), so no currently-legal query changes meaning.
 *
 * Drives the REAL declared store-routes through the REAL `createAuthApp` middleware chain over an
 * isolated Postgres schema, from a SELF-CONTAINED throwaway backend-profile spec (product-free
 * platform: the neutral `events` store + routes come from this fixture, mirroring
 * store-in-filter.db.test.ts).
 *
 * Fail-the-fix: WITHOUT the operator parse, `?seq__gt=3` is an unknown param → 400 — the range
 * assertions go RED.
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
    'store-comparison-filter.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the comparison-operator acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_store_cmp_filter';

// A self-contained throwaway backend-profile spec. Neutral names only:
//  - `seq` (integer)        — the monotonic range column (the "everything after X" counterproof).
//  - `score` (double)       — a fractional comparable column (the double/numeric comparability proof).
//  - `kind` (text)          — the equality/`__in` composition column.
//  - `due_at` (timestamp, nullable) — a NULLABLE declared column (an operator on it must 400).
//  - `payload` (jsonb)      — a NON-NULLABLE jsonb declared column (sortable today, but an operator
//                             on it must still 400 — the eligibility rule is non-nullable AND non-jsonb).
//  - `label__gt` (text)     — a column literally named `<x>__gt`, to prove the equality-precedence rule.
const CMP_FILTER_YAML = `
version: '1.0'
metadata:
  name: comparison-filter-backend
  description: A backend proving the bounded comparison-operator family on the list op.
stores:
  - name: events
    columns:
      - { name: seq, type: integer }
      - { name: score, type: double }
      - { name: kind, type: text }
      - { name: due_at, type: timestamp, nullable: true }
      - { name: payload, type: jsonb }
      - { name: label__gt, type: text, nullable: true }
api:
  - { method: POST, path: '/events', action: { kind: store, store: events, op: create } }
  - { method: GET, path: '/events', action: { kind: store, store: events, op: list } }
`;

let testsRan = 0;

interface EventRow {
  id: string;
  seq: number;
  score: number;
  kind: string;
  label__gt: string | null;
}

describeDb('store list comparison operators (__gt/__gte/__lt/__lte)', () => {
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

  const createEvent = (token: string, body: Record<string, unknown>) =>
    jsonRequest(h.app, 'POST', '/events', { body, headers: auth(token) });

  const listEvents = (token: string, query = '') =>
    jsonRequest(h.app, 'GET', `/events${query ? `?${query}` : ''}`, { headers: auth(token) });

  /** Seed one row per seq with a derived score/kind (payload is a required jsonb column). */
  async function seed(token: string, seqs: number[], kind = 'a'): Promise<void> {
    for (const seq of seqs) {
      const res = await createEvent(token, { seq, score: seq + 0.5, kind, payload: { seq } });
      expect(res.status).toBe(201);
    }
  }

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(CMP_FILTER_YAML);
    if (!parsed.ok) throw new Error(`cmp-filter fixture invalid: ${JSON.stringify(parsed.errors)}`);
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

  it('?seq__gt=3 returns EXACTLY the rows with seq > 3 (and __gte/__lt/__lte bound as documented)', async () => {
    testsRan += 1;
    const { token } = await principal('cmp-range@example.com', 'CmpRangeOrg');
    await seed(token, [1, 2, 3, 4, 5]);

    // Fail-the-fix: without the operator parse this is a 400 (unknown query parameter).
    const gt = await listEvents(token, 'seq__gt=3');
    expect(gt.status).toBe(200);
    expect(((await gt.json()) as EventRow[]).map((r) => r.seq).sort()).toEqual([4, 5]);

    const gte = (await (await listEvents(token, 'seq__gte=3')).json()) as EventRow[];
    expect(gte.map((r) => r.seq).sort()).toEqual([3, 4, 5]);

    const lt = (await (await listEvents(token, 'seq__lt=2')).json()) as EventRow[];
    expect(lt.map((r) => r.seq)).toEqual([1]);

    const lte = (await (await listEvents(token, 'seq__lte=2')).json()) as EventRow[];
    expect(lte.map((r) => r.seq).sort()).toEqual([1, 2]);
  });

  it('operators fold into the AND-chain: two bounds make a range, and equality/__in still compose', async () => {
    testsRan += 1;
    const { token } = await principal('cmp-compose@example.com', 'CmpComposeOrg');
    await seed(token, [1, 2, 3], 'a');
    await seed(token, [4, 5], 'b');

    // A range: 1 < seq <= 4 → 2, 3, 4.
    const range = (await (await listEvents(token, 'seq__gt=1&seq__lte=4')).json()) as EventRow[];
    expect(range.map((r) => r.seq).sort()).toEqual([2, 3, 4]);

    // Range AND equality: 1 < seq <= 4 AND kind = a → 2, 3.
    const withEq = (await (
      await listEvents(token, 'seq__gt=1&seq__lte=4&kind=a')
    ).json()) as EventRow[];
    expect(withEq.map((r) => r.seq).sort()).toEqual([2, 3]);

    // Range AND a `__in` set: seq > 2 AND kind IN (a, b) → 3, 4, 5.
    const withIn = (await (await listEvents(token, 'seq__gt=2&kind__in=a,b')).json()) as EventRow[];
    expect(withIn.map((r) => r.seq).sort()).toEqual([3, 4, 5]);
  });

  it('a double column compares through the same per-type coercion (the fractional-type comparability proof)', async () => {
    testsRan += 1;
    const { token } = await principal('cmp-double@example.com', 'CmpDoubleOrg');
    await seed(token, [1, 2, 3]); // scores 1.5, 2.5, 3.5

    const gt = (await (await listEvents(token, 'score__gt=2.5')).json()) as EventRow[];
    expect(gt.map((r) => r.score)).toEqual([3.5]);

    const lte = (await (await listEvents(token, 'score__lte=2.5')).json()) as EventRow[];
    expect(lte.map((r) => r.score).sort((a, b) => a - b)).toEqual([1.5, 2.5]);

    // A malformed operator value fails the SAME per-type coercion equality uses.
    expect((await listEvents(token, 'score__gt=abc')).status).toBe(400);
  });

  it('an operator composes with order + after: the range holds on every keyset page', async () => {
    testsRan += 1;
    const { token } = await principal('cmp-page@example.com', 'CmpPageOrg');
    await seed(token, [1, 2, 3, 4, 5, 6]);

    // seq > 1 at limit=2, ordered by seq asc: walk the pages; the operator must hold on each.
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const q = `seq__gt=1&order=seq.asc&limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const res = await listEvents(token, q);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as EventRow[];
      if (rows.length === 0) break;
      for (const r of rows) seen.push(r.seq);
      cursor = res.headers.get('X-Next-Cursor');
      if (!cursor) break;
    }
    expect(seen).toEqual([2, 3, 4, 5, 6]); // every matching row exactly once, in order, none below the bound
  });

  it('fail-closed 400: a nullable column, a non-nullable jsonb column, an undeclared column, every injected column, and a malformed value', async () => {
    testsRan += 1;
    const { token } = await principal('cmp-badreq@example.com', 'CmpBadReqOrg');
    await seed(token, [1]);

    const expect400 = async (query: string) => {
      const res = await listEvents(token, query);
      expect(res.status, `expected 400 for ?${query}`).toBe(400);
    };

    await expect400('due_at__gt=2026-01-01T00:00:00Z'); // a NULLABLE declared column
    await expect400('payload__gt=x'); // a NON-NULLABLE jsonb declared column (sortable, but never comparable)
    await expect400('ghost__gt=1'); // an undeclared column
    await expect400('id__gt=00000000-0000-4000-8000-000000000001'); // injected id — not operator-eligible
    await expect400('created_at__gt=2026-01-01T00:00:00Z'); // injected created_at — not operator-eligible
    await expect400('created_by__gt=user:x'); // injected created_by (filterable, but never comparable)
    await expect400('seq__gt=abc'); // a malformed operator value (per-type coercion)
    await expect400('seq__gt='); // an empty operator value
  });

  it('accept-control: a column literally named `label__gt` stays PLAIN EQUALITY, and operator-free queries are unchanged', async () => {
    testsRan += 1;
    const { token } = await principal('cmp-precedence@example.com', 'CmpPrecedenceOrg');
    await createEvent(token, { seq: 1, score: 0.5, kind: 'a', payload: {}, label__gt: '10' });
    await createEvent(token, { seq: 2, score: 0.5, kind: 'a', payload: {}, label__gt: '9' });

    // `?label__gt=10` hits the EXACT column (Precedence 1, equality): ONLY the literal '10' row —
    // never a `label > 10` comparison (which, lexicographically, would also match '9').
    const res = await listEvents(token, 'label__gt=10');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as EventRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].label__gt).toBe('10');

    // Operator-free queries stay byte-identical: plain equality and the bare list are untouched.
    const eq = (await (await listEvents(token, 'seq=2')).json()) as EventRow[];
    expect(eq.map((r) => r.seq)).toEqual([2]);
    const all = (await (await listEvents(token)).json()) as EventRow[];
    expect(all).toHaveLength(2);
  });

  it('tenant isolation: a tenant-B operator query never surfaces tenant-A rows (the tenant predicate binds beneath)', async () => {
    testsRan += 1;
    const a = await principal('cmp-tenant-a@example.com', 'CmpTenantOrgA');
    const b = await principal('cmp-tenant-b@example.com', 'CmpTenantOrgB');
    await seed(a.token, [1, 2, 3]);

    const bRows = (await (await listEvents(b.token, 'seq__gt=0')).json()) as EventRow[];
    expect(bRows).toHaveLength(0);

    const aRows = (await (await listEvents(a.token, 'seq__gt=0')).json()) as EventRow[];
    expect(aRows.map((r) => r.seq).sort()).toEqual([1, 2, 3]);
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('store list comparison-operator acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the comparison-operator arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(7);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
