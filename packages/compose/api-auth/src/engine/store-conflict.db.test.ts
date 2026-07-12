/**
 * DB-backed acceptance: a same-tenant store-write uniqueness violation is a 409 CONFLICT (was a bare
 * 500), and it is TENANT-SAFE — two tenants may hold the SAME author-`unique` value (the tenant-scoped
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
const SCHEMA_KEYED = 'rayspec_test_store_conflict_keyed';
const SCHEMA_IDEMPOTENCY = 'rayspec_test_store_conflict_idempotency';

// A self-contained throwaway backend-profile spec: one store with an AUTHOR-declared `unique: true`
// column (`sku`) + store CRUD routes. Backend-profile ⇒ no conflict keys ⇒ the secure default: the
// `sku` unique index is TENANT-SCOPED compound `(tenant_id, sku)`.
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

// A store mirroring a PRODUCT-profile shape: `sku` is a GLOBAL conflict-key column (a durable
// `ON CONFLICT` target — single-column unique) and `code` is a plain author-`unique` column (tenant-
// scoped compound). The keyed carve-out is supplied to the harness as `conflictKeys = {catalog2:{sku}}`,
// exactly what `deriveConflictKeys` produces for a declared store with `key: [sku]` + a second unique.
const CATALOG_KEYED_YAML = `
version: '1.0'
metadata:
  name: catalog-keyed-backend
  description: A store with a global conflict-key column (sku) + a tenant-scoped author-unique column (code).
stores:
  - name: catalog2
    columns:
      - { name: sku, type: text, unique: true }
      - { name: code, type: text, unique: true }
api:
  - { method: POST, path: '/catalog2', action: { kind: store, store: catalog2, op: create } }
  - { method: GET, path: '/catalog2', action: { kind: store, store: catalog2, op: list } }
`;

// The per-store conflict-key carve-out: `sku` is the global key column; `code` is not (tenant-scoped).
const KEYED_CONFLICT_KEYS = new Map([['catalog2', new Set(['sku'])]]);
const GENERIC_CONFLICT_MESSAGE = 'A record with a conflicting unique value already exists.';

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

  it('the sku unique index is TENANT-SCOPED compound (tenant_id, sku) — the tenant-scoped precondition (pg_catalog)', async () => {
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
 * A store with a GLOBAL conflict-key column proves the carve-out — a
 * 23505 on the key column (`sku`, a single-column global unique that can collide CROSS-tenant) uses
 * the GENERIC 409 message (NEVER names `sku`, so the wire is not a cross-tenant existence oracle),
 * while a 23505 on a tenant-scoped author-`unique` column (`code`) STILL names its column (the safe
 * case — a tenant-scoped unique is not a cross-tenant oracle). The carve-out is threaded via `conflictKeys` exactly as the
 * product route-registration path does.
 */
describeDb('store-write 409 — a GLOBAL conflict-key column is never named', () => {
  let h: Harness;

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
    jsonRequest(h.app, 'POST', '/catalog2', {
      body,
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(CATALOG_KEYED_YAML);
    if (!parsed.ok) throw new Error(`keyed fixture invalid: ${JSON.stringify(parsed.errors)}`);
    const spec: RaySpec = parsed.value;
    h = await createHarness({
      engineSpec: spec,
      conflictKeys: KEYED_CONFLICT_KEYS,
      schema: SCHEMA_KEYED,
    });
  });
  beforeEach(async () => {
    if (!hasDb) return;
    await h.reset();
  });
  afterAll(async () => {
    if (!hasDb) return;
    await h.close();
  });

  it('the sku index is a SINGLE-column global unique (sku) — the conflict-key carve-out precondition', async () => {
    testsRan += 1;
    const cols = (await h.db.$client.unsafe(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND c.relname = 'catalog2_sku_unique' AND i.indisunique
        ORDER BY k.ord`,
      [SCHEMA_KEYED],
    )) as unknown as Array<{ column_name: string }>;
    // A GLOBAL single-column unique (no tenant_id) — this is WHY naming it would leak cross-tenant.
    expect(cols.map((c) => c.column_name)).toEqual(['sku']);
  });

  it('a 23505 on the GLOBAL key column (sku) uses the GENERIC message — never names sku', async () => {
    testsRan += 1;
    const a = await principal('keyed-a@example.com', 'KeyedOrgA');
    const first = await post(a.token, { sku: 'ORBIT-CRM', code: 'C1' });
    expect(first.status).toBe(201);
    // Same tenant, duplicate sku (global key) → 409, but the message must NOT name the key column.
    const dup = await post(a.token, { sku: 'ORBIT-CRM', code: 'C2' });
    expect(dup.status).toBe(409);
    const body = await dup.json();
    expect(body.error.code).toBe('CONFLICT');
    // Fail-the-fix: without the carve-out, `conflictColumn` would resolve + name `sku`.
    expect(body.error.message).toBe(GENERIC_CONFLICT_MESSAGE);
    expect(body.error.message).not.toContain('sku');
    expect(JSON.stringify(body)).not.toContain('ORBIT-CRM'); // never the offending value either
  });

  it('a 23505 on a tenant-scoped author-unique column (code) STILL names its column (the safe case)', async () => {
    testsRan += 1;
    const a = await principal('keyed-b@example.com', 'KeyedOrgB');
    const first = await post(a.token, { sku: 'SKU-1', code: 'DUP-CODE' });
    expect(first.status).toBe(201);
    // New sku (no key collision), duplicate code (tenant-scoped compound) → 409 that DOES name `code`.
    const dup = await post(a.token, { sku: 'SKU-2', code: 'DUP-CODE' });
    expect(dup.status).toBe(409);
    const body = await dup.json();
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('code'); // the tenant-scoped column IS named …
    expect(JSON.stringify(body)).not.toContain('DUP-CODE'); // … but the value is never echoed.
  });
});

/**
 * Idempotency replay on a store that HAS a declared `unique` business column (`catalog.sku`) — the case
 * a keyless store (`notebooks`) does not exercise: a declared `unique` index has a LOWER OID than the
 * injected idempotency index, so an identical idempotent RETRY makes Postgres report `catalog_sku_unique`
 * (the BUSINESS constraint) — NOT `catalog_idempotency_key_unique`. Keying the replay off that exact
 * idempotency-constraint NAME would FALL THROUGH to a 409 instead of replaying 200.
 *
 * Fail-the-fix: assertion (2) below (the identical retry → 200 + Idempotency-Replay + SAME id) goes RED
 * if the replay is keyed off the constraint name (it returns 409). Assertion (3) (a NEW key, same value →
 * a genuine 409) stays GREEN — a real business conflict on a new key must NOT become a silent replay.
 */
describeDb('idempotency replay on a store WITH a declared unique column', () => {
  let h: Harness;

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

  const post = (token: string, body: unknown, idemKey?: string) =>
    jsonRequest(h.app, 'POST', '/catalog', {
      body,
      headers: {
        authorization: `Bearer ${token}`,
        ...(idemKey ? { 'idempotency-key': idemKey } : {}),
      },
    });
  const list = (token: string) =>
    jsonRequest(h.app, 'GET', '/catalog', { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(CATALOG_YAML);
    if (!parsed.ok) throw new Error(`catalog fixture invalid: ${JSON.stringify(parsed.errors)}`);
    h = await createHarness({ engineSpec: parsed.value, schema: SCHEMA_IDEMPOTENCY });
  });
  beforeEach(async () => {
    if (!hasDb) return;
    await h.reset();
  });
  afterAll(async () => {
    if (!hasDb) return;
    await h.close();
  });

  it('identical idempotent retry REPLAYS (200 + Idempotency-Replay, SAME id, no duplicate); a new key with the same value is a genuine 409', async () => {
    testsRan += 1;
    const a = await principal('uniq-replay-a@example.com', 'UniqReplayOrgA');
    const SKU = 'IDEMP-SKU-1';

    // (1) create with Idempotency-Key K + unique value V → 201.
    const first = await post(a.token, { sku: SKU, label: 'first' }, 'K-1');
    expect(first.status).toBe(201);
    const firstId = (await first.json()).id as string;

    // (2) IDENTICAL retry (same K, same V) → 200 + Idempotency-Replay, the SAME row id, NO duplicate.
    // RED against the pre-fix code: the sku unique index (lower OID) fires first, so the pre-fix
    // name-check misses the idempotency constraint and returns 409 here.
    const retry = await post(a.token, { sku: SKU, label: 'first' }, 'K-1');
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotency-Replay')).toBe('true');
    expect((await retry.json()).id).toBe(firstId);

    // (3) a DIFFERENT key, SAME value V → a GENUINE business-unique conflict → 409 (must stay green).
    const conflict = await post(a.token, { sku: SKU, label: 'other' }, 'K-2');
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('CONFLICT');

    // Exactly ONE row exists for the tenant (the replay + the 409 created nothing).
    const rows = await (await list(a.token)).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstId);
  });

  it('a replay returns the ORIGINAL row even when the retry body DIFFERS (key-based idempotency)', async () => {
    testsRan += 1;
    const a = await principal('uniq-replay-b@example.com', 'UniqReplayOrgB');

    const first = await post(a.token, { sku: 'SKU-ORIG', label: 'orig' }, 'K-BODY');
    expect(first.status).toBe(201);
    const firstId = (await first.json()).id as string;

    // Same key, DIFFERENT body (different sku) → still replays the ORIGINAL row (no new row, no error).
    const retry = await post(a.token, { sku: 'SKU-CHANGED', label: 'changed' }, 'K-BODY');
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotency-Replay')).toBe('true');
    const replayed = await retry.json();
    expect(replayed.id).toBe(firstId);
    expect(replayed.sku).toBe('SKU-ORIG'); // the ORIGINAL value, not the retry's changed value

    const rows = await (await list(a.token)).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe('SKU-ORIG');
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arms did not run (no silent false-green).
 */
describe('store-conflict acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the conflict-mapping arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(8);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
