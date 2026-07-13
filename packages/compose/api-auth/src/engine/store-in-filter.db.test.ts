/**
 * DB-backed acceptance for the `<col>__in` SET filter on the declared store `list` op.
 *
 * The list facade is AND-equality-only by default: "status = open OR status = in_progress" (a "not
 * done" view) is inexpressible in one query. The `<col>__in=v1,v2,…` form adds a per-column set filter
 * (SQL `IN`) that folds into the SAME AND-chain, so it composes with equality filters, keyset
 * pagination, and — crucially — the tenant chokepoint (`and(tenantPredicate, extra)`), which can never
 * be dropped.
 *
 * Syntax is the DISTINCT `<col>__in` suffix (NOT a bare `?col=a,b`): a bare comma-list on a text column
 * would silently change equality semantics for a comma-bearing value, so `__in` keeps plain `?col=v`
 * byte-identical + unambiguous, and a real column literally named `<x>__in` still wins as plain equality.
 *
 * Drives the REAL declared store-routes through the REAL `createAuthApp` middleware chain over an
 * isolated Postgres schema, from a SELF-CONTAINED throwaway backend-profile spec (product-free platform:
 * the neutral `orders` store + routes come from this fixture, mirroring store-soft-delete.db.test.ts).
 *
 * Fail-the-fix: WITHOUT the `inArray(col, values)` push, `?status__in=open,in_progress` either returns
 * the whole table (a silently-accepted no-op filter) or a 400 (an unknown param) — either way the union
 * assertion (exactly the open + in_progress rows, no closed row) goes RED.
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
    'store-in-filter.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the __in set-filter acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_store_in_filter';

// A self-contained throwaway backend-profile spec. Neutral names only:
//  - `status` (text)     — the union/single/plain-equality/pagination column.
//  - `priority` (integer)— proves per-element coercion in the set filter + AND-composition.
//  - `notes` (jsonb)     — a NON-filterable column (a `__in` on it must 400, as equality does).
//  - `tag__in` (text)    — a column literally named `<x>__in`, to prove the equality-precedence rule.
const IN_FILTER_YAML = `
version: '1.0'
metadata:
  name: in-filter-backend
  description: A backend proving the per-column __in set filter on the list op.
stores:
  - name: orders
    columns:
      - { name: status, type: text }
      - { name: priority, type: integer, nullable: true }
      - { name: notes, type: jsonb, nullable: true }
      - { name: tag__in, type: text, nullable: true }
api:
  - { method: POST, path: '/orders', action: { kind: store, store: orders, op: create } }
  - { method: GET, path: '/orders', action: { kind: store, store: orders, op: list } }
`;

let testsRan = 0;

interface OrderRow {
  id: string;
  status: string;
  priority: number | null;
  tag__in: string | null;
}

describeDb('store list __in set filter', () => {
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

  const createOrder = (token: string, body: Record<string, unknown>) =>
    jsonRequest(h.app, 'POST', '/orders', { body, headers: auth(token) });

  /** GET /orders?<query> (query is passed RAW — a literal comma is intentional in several cases). */
  const listOrders = (token: string, query = '') =>
    jsonRequest(h.app, 'GET', `/orders${query ? `?${query}` : ''}`, { headers: auth(token) });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(IN_FILTER_YAML);
    if (!parsed.ok) throw new Error(`in-filter fixture invalid: ${JSON.stringify(parsed.errors)}`);
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

  it('?status__in=open,in_progress returns the UNION (both states) and excludes the closed row', async () => {
    testsRan += 1;
    const { token } = await principal('in-union@example.com', 'InUnionOrg');
    for (const status of ['open', 'in_progress', 'closed', 'open']) {
      expect((await createOrder(token, { status })).status).toBe(201);
    }

    // Fail-the-fix: with the inArray push removed, this is either a 400 (unknown param) or the whole
    // table (a no-op filter that leaks the `closed` row) — both fail these assertions.
    const res = await listOrders(token, 'status__in=open,in_progress');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as OrderRow[];
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(['in_progress', 'open', 'open']); // 2 open + 1 in_progress, NO closed
    expect(statuses).not.toContain('closed');
  });

  it('a single-element ?status__in=open still works (an IN of one) and equals the plain equality result', async () => {
    testsRan += 1;
    const { token } = await principal('in-single@example.com', 'InSingleOrg');
    for (const status of ['open', 'closed', 'open']) {
      await createOrder(token, { status });
    }

    const viaIn = (await (await listOrders(token, 'status__in=open')).json()) as OrderRow[];
    const viaEq = (await (await listOrders(token, 'status=open')).json()) as OrderRow[];
    expect(viaIn.map((r) => r.status)).toEqual(['open', 'open']);
    // Same set of ids (the single-element IN and plain equality select identically).
    expect(viaIn.map((r) => r.id).sort()).toEqual(viaEq.map((r) => r.id).sort());
  });

  it('a plain ?status=open is UNCHANGED (equality; a comma-bearing value stays a single literal)', async () => {
    testsRan += 1;
    const { token } = await principal('in-plain@example.com', 'InPlainOrg');
    await createOrder(token, { status: 'open' });
    await createOrder(token, { status: 'a,b' }); // a literal comma value
    await createOrder(token, { status: 'closed' });

    // Plain equality on a normal value.
    const open = (await (await listOrders(token, 'status=open')).json()) as OrderRow[];
    expect(open.map((r) => r.status)).toEqual(['open']);

    // Plain equality on a COMMA-BEARING value matches the ONE literal row — never split into a set.
    const comma = (await (await listOrders(token, 'status=a,b')).json()) as OrderRow[];
    expect(comma.map((r) => r.status)).toEqual(['a,b']);
  });

  it('the set filter composes: an integer-typed __in coerces each element, and AND-combines with an equality filter', async () => {
    testsRan += 1;
    const { token } = await principal('in-compose@example.com', 'InComposeOrg');
    await createOrder(token, { status: 'open', priority: 1 });
    await createOrder(token, { status: 'in_progress', priority: 2 });
    await createOrder(token, { status: 'open', priority: 3 });
    await createOrder(token, { status: 'closed', priority: 1 });

    // Integer __in: each element is coerced to a number; matches priority 1 OR 3 (not 2).
    const byPriority = (await (await listOrders(token, 'priority__in=1,3')).json()) as OrderRow[];
    expect(byPriority.map((r) => r.priority).sort()).toEqual([1, 1, 3]);

    // AND-composition: status ∈ {open,in_progress} AND priority = 1 → only the (open, 1) row.
    const both = (await (
      await listOrders(token, 'status__in=open,in_progress&priority=1')
    ).json()) as OrderRow[];
    expect(both).toHaveLength(1);
    expect(both[0].status).toBe('open');
    expect(both[0].priority).toBe(1);
  });

  it('keyset pagination across an __in result pages correctly AND keeps honoring the filter (no excluded row leaks)', async () => {
    testsRan += 1;
    const { token } = await principal('in-page@example.com', 'InPageOrg');
    // 3 matching (open/in_progress) + 2 excluded (closed).
    for (const status of ['open', 'closed', 'in_progress', 'closed', 'open']) {
      await createOrder(token, { status });
    }

    // Walk the whole `?status__in=open,in_progress` result at limit=2 (default order id asc + cursor).
    const seen: string[] = [];
    const statuses: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const q = `status__in=open,in_progress&limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const res = await listOrders(token, q);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as OrderRow[];
      if (rows.length === 0) break;
      for (const r of rows) {
        seen.push(r.id);
        statuses.push(r.status);
      }
      cursor = res.headers.get('X-Next-Cursor');
      if (!cursor) break;
    }
    expect(seen).toHaveLength(3); // every matching row, exactly once
    expect(new Set(seen).size).toBe(3); // no duplicate across pages
    // The filter held on EVERY page — no `closed` row ever surfaced.
    expect(statuses.every((s) => s === 'open' || s === 'in_progress')).toBe(true);
  });

  it('fail-closed: empty / blank / oversized set, a jsonb column, an unknown prefix, and a bad-typed element all 400', async () => {
    testsRan += 1;
    const { token } = await principal('in-badreq@example.com', 'InBadReqOrg');
    await createOrder(token, { status: 'open' });

    const expect400 = async (query: string) => {
      const res = await listOrders(token, query);
      expect(res.status, `expected 400 for ?${query}`).toBe(400);
    };

    await expect400('status__in='); // empty set
    await expect400('status__in=,,'); // all-empty set
    await expect400('status__in=open,,closed'); // a blank element mid-list
    // Oversized: 101 elements exceeds the max-100 bound.
    await expect400(`status__in=${Array.from({ length: 101 }, (_, i) => `s${i}`).join(',')}`);
    await expect400('notes__in=x,y'); // a jsonb column is not filterable
    await expect400('ghost__in=x,y'); // an unknown prefix column
    await expect400('priority__in=1,abc'); // a non-integer element fails coercion
  });

  it('equality precedence: a real column literally named `tag__in` is a plain equality filter, never split into a set', async () => {
    testsRan += 1;
    const { token } = await principal('in-precedence@example.com', 'InPrecedenceOrg');
    // One row whose `tag__in` value literally contains a comma, one that does not.
    await createOrder(token, { status: 'open', tag__in: 'a,b' });
    await createOrder(token, { status: 'open', tag__in: 'a' });

    // `?tag__in=a,b` hits the EXACT column (equality precedence) → matches the ONE literal 'a,b' row,
    // NOT an IN over ['a','b'] (which would also match the 'a' row). This is the fail-closed reason the
    // suffix is distinct rather than a bare comma-list.
    const res = await listOrders(token, 'tag__in=a,b');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as OrderRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tag__in).toBe('a,b');
  });

  it('tenant isolation: a tenant-B __in query never surfaces tenant-A rows (the tenant predicate binds beneath the IN)', async () => {
    testsRan += 1;
    const a = await principal('in-tenant-a@example.com', 'InTenantOrgA');
    const b = await principal('in-tenant-b@example.com', 'InTenantOrgB');

    await createOrder(a.token, { status: 'open' });
    await createOrder(a.token, { status: 'in_progress' });

    // Tenant B has no rows; its __in over the SAME states returns nothing (cannot reach A's rows).
    const bRows = (await (
      await listOrders(b.token, 'status__in=open,in_progress')
    ).json()) as OrderRow[];
    expect(bRows).toHaveLength(0);

    // Tenant A still sees exactly its own two rows through the same filter.
    const aRows = (await (
      await listOrders(a.token, 'status__in=open,in_progress')
    ).json()) as OrderRow[];
    expect(aRows.map((r) => r.status).sort()).toEqual(['in_progress', 'open']);
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('store list __in set-filter acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the __in set-filter arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(8);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
