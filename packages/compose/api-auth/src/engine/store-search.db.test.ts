/**
 * DB-backed acceptance for the substring-search surface on the declared store `list` op:
 *   - `?search=term`         — a case-insensitive substring match OR-combined across EVERY text column;
 *   - `?<col>__contains=term`— the same match on ONE named text column.
 *
 * Both fold into the SAME AND-chain (SQL `ILIKE '%term%'`), so they compose with equality/`__in`
 * filters, keyset pagination, and — crucially — the tenant chokepoint (`and(tenantPredicate, extra)`),
 * which can never be dropped. The term's LIKE wildcards (`%`/`_`) are escaped with an explicit `ESCAPE`
 * clause, so a term containing them matches LITERALLY and can never act as a wildcard.
 *
 * Drives the REAL declared store-routes through the REAL `createAuthApp` middleware chain over an
 * isolated Postgres schema, from a SELF-CONTAINED throwaway backend-profile spec (product-free platform:
 * the neutral `docs`/`metrics` stores come from this fixture, mirroring store-in-filter.db.test.ts).
 *
 * Fail-the-fix: WITHOUT the search predicate, `?search=` / `?<col>__contains=` either returns the whole
 * table (a silently-accepted no-op filter) or a 400 (an unknown param) — either way the match/exclusion
 * assertions go RED. WITHOUT the wildcard escaping, `?search=100%` also matches `100X`/`1009` (the `%`
 * wildcard-matches), so the literal-match assertion goes RED.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * yet absent (un-skippable ran-guard at the bottom).
 */
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';
import { buildDeclaredRoutesOpenApi } from './emit-openapi.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'store-search.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the substring-search acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_store_search';

// A self-contained throwaway backend-profile spec. Neutral names only:
//  - docs.title (text)             — a searchable text column.
//  - docs.summary (text)           — a 2nd searchable text column (proves the OR spans MULTIPLE cols).
//  - docs.rank (integer)           — a NON-text column (a `__contains` on it must 400).
//  - docs.tag__contains (text)     — a column literally named `<x>__contains`, to prove equality wins.
//  - metrics.value (integer)       — an ALL-non-text store (a `?search=` on it must 400).
const SEARCH_YAML = `
version: '1.0'
metadata:
  name: search-backend
  description: A backend proving substring search on the list op.
stores:
  - name: docs
    columns:
      - { name: title, type: text }
      - { name: summary, type: text, nullable: true }
      - { name: rank, type: integer, nullable: true }
      - { name: tag__contains, type: text, nullable: true }
  - name: metrics
    columns:
      - { name: value, type: integer }
api:
  - { method: POST, path: '/docs', action: { kind: store, store: docs, op: create } }
  - { method: GET, path: '/docs', action: { kind: store, store: docs, op: list } }
  - { method: GET, path: '/metrics', action: { kind: store, store: metrics, op: list } }
`;

let testsRan = 0;

interface DocRow {
  id: string;
  title: string;
  summary: string | null;
  rank: number | null;
  tag__contains: string | null;
  created_by: string;
}

describeDb('store list substring search', () => {
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

  const createDoc = (token: string, body: Record<string, unknown>) =>
    jsonRequest(h.app, 'POST', '/docs', { body, headers: auth(token) });

  /** GET /docs?<query> (query is passed RAW — encode special chars at the call site as a real client would). */
  const listDocs = (token: string, query = '') =>
    jsonRequest(h.app, 'GET', `/docs${query ? `?${query}` : ''}`, { headers: auth(token) });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(SEARCH_YAML);
    if (!parsed.ok) throw new Error(`search fixture invalid: ${JSON.stringify(parsed.errors)}`);
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

  it('?search matches ANY text column (OR): a summary-only match is included, a non-matching row excluded', async () => {
    testsRan += 1;
    const { token } = await principal('search-or@example.com', 'SearchOrOrg');
    await createDoc(token, { title: 'apple pie', summary: 'a dessert' }); // matches via TITLE
    await createDoc(token, { title: 'banana bread', summary: 'apple sauce' }); // matches via SUMMARY only
    await createDoc(token, { title: 'cherry cake', summary: 'vanilla' }); // matches NEITHER

    // Fail-the-fix: with the search predicate removed this is a 400 (unknown param) or the whole table.
    const res = await listDocs(token, 'search=apple');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as DocRow[];
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['apple pie', 'banana bread']); // the summary-only match IS included
    expect(titles).not.toContain('cherry cake'); // the non-matching row is excluded
  });

  it('?<col>__contains matches that ONE column only (a match in a DIFFERENT text column is not returned)', async () => {
    testsRan += 1;
    const { token } = await principal('search-contains@example.com', 'SearchContainsOrg');
    await createDoc(token, { title: 'apple pie', summary: 'a dessert' }); // title contains 'apple'
    await createDoc(token, { title: 'banana bread', summary: 'apple sauce' }); // only SUMMARY has 'apple'

    // `title__contains=apple` is scoped to the title column — the banana row (apple only in summary) is out.
    const res = await listDocs(token, 'title__contains=apple');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as DocRow[];
    expect(rows.map((r) => r.title)).toEqual(['apple pie']);
  });

  it("?search escapes the '%' wildcard: a literal '100%' matches, '100X'/'1009' do NOT", async () => {
    testsRan += 1;
    const { token } = await principal('search-pct@example.com', 'SearchPctOrg');
    await createDoc(token, { title: '100%' });
    await createDoc(token, { title: '100X' });
    await createDoc(token, { title: '1009' });

    // Fail-the-fix: WITHOUT escaping, the term '100%' → LIKE '%100%%' → the trailing `%` wildcard-matches
    // '100X' and '1009' too, so this asserts the SINGLE literal-'100%' row.
    const res = await listDocs(token, `search=${encodeURIComponent('100%')}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as DocRow[];
    expect(rows.map((r) => r.title)).toEqual(['100%']);
  });

  it("?search escapes the '_' wildcard: a literal 'a_b' matches, 'axb' does NOT", async () => {
    testsRan += 1;
    const { token } = await principal('search-underscore@example.com', 'SearchUnderscoreOrg');
    await createDoc(token, { title: 'a_b' });
    await createDoc(token, { title: 'axb' });

    // Fail-the-fix: WITHOUT escaping, '_' is the LIKE single-char wildcard → 'a_b' would ALSO match 'axb'.
    const res = await listDocs(token, 'search=a_b');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as DocRow[];
    expect(rows.map((r) => r.title)).toEqual(['a_b']);
  });

  it('keyset pagination over a ?search result pages correctly AND keeps honoring the filter (no excluded row leaks)', async () => {
    testsRan += 1;
    const { token } = await principal('search-page@example.com', 'SearchPageOrg');
    // 3 matching ('keep') interleaved with 2 non-matching.
    for (const title of ['keep a', 'skip 1', 'keep b', 'skip 2', 'keep c']) {
      await createDoc(token, { title });
    }

    const seen: string[] = [];
    const titles: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const q = `search=keep&limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const res = await listDocs(token, q);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as DocRow[];
      if (rows.length === 0) break;
      for (const r of rows) {
        seen.push(r.id);
        titles.push(r.title);
      }
      cursor = res.headers.get('X-Next-Cursor');
      if (!cursor) break;
    }
    expect(seen).toHaveLength(3); // every matching row, exactly once
    expect(new Set(seen).size).toBe(3); // no duplicate across pages
    expect(titles.every((t) => t.startsWith('keep'))).toBe(true); // the filter held on EVERY page
  });

  it('fail-closed: empty search, empty __contains, a non-text __contains, and an unknown __contains all 400', async () => {
    testsRan += 1;
    const { token } = await principal('search-badreq@example.com', 'SearchBadReqOrg');
    await createDoc(token, { title: 'x' });

    const expect400 = async (query: string) => {
      const res = await listDocs(token, query);
      expect(res.status, `expected 400 for ?${query}`).toBe(400);
    };

    await expect400('search='); // empty search term
    await expect400('title__contains='); // empty __contains term
    await expect400('rank__contains=5'); // a non-text (integer) column is not searchable
    await expect400('ghost__contains=x'); // an unknown prefix column
  });

  it('equality precedence: a real column literally named `tag__contains` is plain equality, not a substring search', async () => {
    testsRan += 1;
    const { token } = await principal('search-precedence@example.com', 'SearchPrecedenceOrg');
    await createDoc(token, { title: 'x', tag__contains: 'abc' });
    await createDoc(token, { title: 'y', tag__contains: 'zabcz' }); // substring 'abc' would match this too

    // `?tag__contains=abc` hits the EXACT column (equality precedence) → the ONE literal 'abc' row, NOT a
    // substring match (which would also match 'zabcz'). This is the fail-closed reason `__contains` is a
    // distinct suffix that a real same-named column still overrides as plain equality.
    const res = await listDocs(token, 'tag__contains=abc');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as DocRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tag__contains).toBe('abc');
  });

  it('?created_by__contains substring-filters the injected actor stamp', async () => {
    testsRan += 1;
    const { token } = await principal('search-createdby@example.com', 'SearchCreatedByOrg');
    await createDoc(token, { title: 'one' });
    await createDoc(token, { title: 'two' });

    // Every row was created by a JWT principal → created_by is `user:<userId>`, so `contains 'user'` hits
    // all of them, and a nonexistent substring hits none — proving __contains works on the injected col.
    const all = (await (await listDocs(token, 'created_by__contains=user')).json()) as DocRow[];
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.created_by.includes('user'))).toBe(true);
    const none = (await (
      await listDocs(token, 'created_by__contains=nonexistent')
    ).json()) as DocRow[];
    expect(none).toHaveLength(0);
  });

  it('tenant isolation: a tenant-B search never surfaces tenant-A rows (the tenant predicate binds beneath ILIKE)', async () => {
    testsRan += 1;
    const a = await principal('search-tenant-a@example.com', 'SearchTenantOrgA');
    const b = await principal('search-tenant-b@example.com', 'SearchTenantOrgB');

    await createDoc(a.token, { title: 'shared apple' });
    await createDoc(a.token, { title: 'another apple' });

    // Tenant B has no rows; its search over the SAME term returns nothing (cannot reach A's rows).
    const bRows = (await (await listDocs(b.token, 'search=apple')).json()) as DocRow[];
    expect(bRows).toHaveLength(0);

    // Tenant A still sees exactly its own two rows through the same search.
    const aRows = (await (await listDocs(a.token, 'search=apple')).json()) as DocRow[];
    expect(aRows.map((r) => r.title).sort()).toEqual(['another apple', 'shared apple']);
  });

  it('a ?search on a store with NO text column 400s, and the emitted OpenAPI OMITS `search` (doc agrees with server)', async () => {
    testsRan += 1;
    const { token } = await principal('search-textless@example.com', 'SearchTextlessOrg');
    // The `metrics` store has only an integer column — searching it can never match.
    const res = await jsonRequest(h.app, 'GET', '/metrics?search=x', { headers: auth(token) });
    expect(res.status).toBe(400);

    // Cross-check: the PUBLIC OpenAPI doc for the SAME fixture must NOT advertise `search` on this
    // text-less store — otherwise the document over-claims a param the server (above) rejects with 400.
    // It DOES still expose `created_by__contains` (the injected text column is `__contains`-searchable),
    // so the two surfaces agree on BOTH the omission and the exposure.
    const parsed = parseSpec(SEARCH_YAML);
    if (!parsed.ok) throw new Error(`search fixture invalid: ${JSON.stringify(parsed.errors)}`);
    const doc = buildDeclaredRoutesOpenApi(parsed.value);
    const metricsParams = doc.paths['/metrics'].get.parameters ?? [];
    expect(metricsParams.some((p) => p.name === 'search')).toBe(false);
    expect(metricsParams.some((p) => p.name === 'created_by__contains')).toBe(true);
  });

  it('additive: a plain list with NO search param returns EVERY row (no filter applied — unchanged behaviour)', async () => {
    testsRan += 1;
    const { token } = await principal('search-additive@example.com', 'SearchAdditiveOrg');
    for (const title of ['alpha', 'beta', 'gamma']) {
      await createDoc(token, { title });
    }
    const res = await listDocs(token); // no query at all
    expect(res.status).toBe(200);
    const rows = (await res.json()) as DocRow[];
    // No search param → no substring predicate → every row returned (the additive/opt-in invariant).
    expect(rows.map((r) => r.title).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('store list substring-search acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the substring-search arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(11);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
