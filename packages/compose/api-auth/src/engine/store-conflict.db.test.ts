/**
 * DB-backed acceptance: a same-tenant store-write uniqueness violation is a 409 CONFLICT (was a bare
 * 500), and it is TENANT-SAFE — two tenants may hold the SAME author-`unique` value (S1's tenant-scoped
 * compound index), so the 409 fires ONLY within a tenant and its message names the COLUMN, never the
 * offending value or any foreign-tenant data.
 *
 * Drives the REAL declared store-route through the REAL `createAuthApp` middleware chain over an
 * isolated Postgres schema, from a SELF-CONTAINED throwaway backend-profile spec (product-free
 * platform: the `catalog` store + its routes come from this fixture, mirroring the acme-notes harness).
 *
 * Fail-the-fix: WITHOUT the 23505→409 mapping the same-tenant duplicate would fall through `onError`'s
 * unrecognized-error branch to a bare `{"code":"INTERNAL"}` 500 — every `expect(...).toBe(409)` /
 * `code === 'CONFLICT'` assertion below would go RED.
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
    'store-conflict.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the tenant-scoped-unique + 409-conflict acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_store_conflict';

// A self-contained throwaway backend-profile spec: one store with an AUTHOR-declared `unique: true`
// column (`sku`) + store CRUD routes. Backend-profile ⇒ no conflict keys ⇒ the secure default: the
// `sku` unique index is TENANT-SCOPED compound `(tenant_id, sku)` (S1).
const CATALOG_YAML = `
version: '1.0'
metadata:
  name: catalog-backend
  description: A minimal catalog backend proving tenant-scoped author-unique + 409 conflict mapping.
stores:
  - name: catalog
    columns:
      - { name: sku, type: text, unique: true }
      - { name: label, type: text, nullable: true }
api:
  - { method: POST, path: '/catalog', action: { kind: store, store: catalog, op: create } }
  - { method: GET, path: '/catalog', action: { kind: store, store: catalog, op: list } }
  - { method: GET, path: '/catalog/{id}', action: { kind: store, store: catalog, op: get } }
  - { method: PATCH, path: '/catalog/{id}', action: { kind: store, store: catalog, op: update } }
`;

let testsRan = 0;

describeDb('store-write 409 conflict-mapping (tenant-scoped author-unique)', () => {
  let h: Harness;

  /** Register → org → switch → an org-scoped owner token (owner holds store:write). */
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

  const post = (token: string, body: unknown) =>
    jsonRequest(h.app, 'POST', '/catalog', { body, headers: { authorization: `Bearer ${token}` } });
  const patch = (token: string, id: string, body: unknown) =>
    jsonRequest(h.app, 'PATCH', `/catalog/${id}`, {
      body,
      headers: { authorization: `Bearer ${token}` },
    });
  const list = (token: string) =>
    jsonRequest(h.app, 'GET', '/catalog', { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(CATALOG_YAML);
    if (!parsed.ok) throw new Error(`catalog fixture invalid: ${JSON.stringify(parsed.errors)}`);
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

  it('the sku unique index is TENANT-SCOPED compound (tenant_id, sku) — the S1 precondition (pg_catalog)', async () => {
    testsRan += 1;
    // Ground truth: the backing index is compound `(tenant_id, sku)` (secure default), which is WHY two
    // tenants below can each hold the same value. Fail-the-fix against an accidental global index.
    const cols = (await h.db.$client.unsafe(
      `SELECT a.attname AS column_name, k.ord
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND c.relname = 'catalog_sku_unique' AND i.indisunique
        ORDER BY k.ord`,
      [SCHEMA],
    )) as unknown as Array<{ column_name: string; ord: string }>;
    expect(cols.map((c) => c.column_name)).toEqual(['tenant_id', 'sku']);
  });

  it('two tenants hold the SAME sku (both 201); a same-tenant duplicate is a 409 CONFLICT (tenant-safe), not a 500', async () => {
    testsRan += 1;
    const a = await principal('conflict-a@example.com', 'ConflictOrgA');
    const b = await principal('conflict-b@example.com', 'ConflictOrgB');
    const SKU = 'ORBIT-CRM-2026'; // the distinctive value that must NEVER appear in the 409 body

    // Tenant A creates the value → 201.
    const aCreate = await post(a.token, { sku: SKU, label: 'A catalog' });
    expect(aCreate.status).toBe(201);

    // Tenant B creates the SAME value → 201 (tenant-scoped compound index; NO cross-tenant collision).
    const bCreate = await post(b.token, { sku: SKU, label: 'B catalog' });
    expect(bCreate.status).toBe(201);

    // Tenant A re-creates the SAME value → 409 CONFLICT (a same-tenant duplicate — the caller's OWN row).
    const aDup = await post(a.token, { sku: SKU, label: 'A duplicate' });
    expect(aDup.status).toBe(409); // NOT a 500
    const body = await aDup.json();
    expect(body.error.code).toBe('CONFLICT');
    // TENANT-SAFE message: NAMES the violated column …
    expect(body.error.message).toContain('sku');
    // … and NEVER echoes the offending value or ANY foreign-tenant data (label 'B catalog', SKU value).
    const asText = JSON.stringify(body);
    expect(asText).not.toContain(SKU);
    expect(asText).not.toContain('B catalog');

    // Both tenants' rows survived (each still holds exactly one) — the writes committed, tenant-scoped.
    const aRows = await (await list(a.token)).json();
    const bRows = await (await list(b.token)).json();
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].sku).toBe(SKU);
    expect(bRows[0].label).toBe('B catalog');
  });

  it('an UPDATE that collides on the unique column is also a 409 CONFLICT (tenant-safe), not a 500', async () => {
    testsRan += 1;
    const a = await principal('conflict-upd@example.com', 'ConflictUpdOrg');

    const first = await post(a.token, { sku: 'SKU-ALPHA' });
    expect(first.status).toBe(201);
    const second = await post(a.token, { sku: 'SKU-BETA' });
    expect(second.status).toBe(201);
    const secondId = (await second.json()).id as string;

    // PATCH the second row's sku to the first row's value → a same-tenant unique collision → 409.
    const clash = await patch(a.token, secondId, { sku: 'SKU-ALPHA' });
    expect(clash.status).toBe(409); // NOT a 500
    const body = await clash.json();
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('sku');
    expect(JSON.stringify(body)).not.toContain('SKU-ALPHA'); // no offending value echoed
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('store-conflict acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the conflict-mapping arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(3);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
