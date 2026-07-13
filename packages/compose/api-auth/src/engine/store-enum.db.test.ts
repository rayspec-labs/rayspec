/**
 * DB-backed acceptance: a declared text-column `enum` whitelist is enforced by the PLATFORM (server-side
 * 400), not merely a client-side convention. A create/update whose value is outside the whitelist is a
 * VALIDATION_ERROR (400); an in-whitelist value succeeds; a nullable enum column also accepts JSON null.
 *
 * Drives the REAL declared store-route through the REAL createAuthApp middleware chain over an isolated
 * Postgres schema, from a SELF-CONTAINED throwaway backend-profile spec (product-free platform).
 *
 * Fail-the-fix: WITHOUT the `z.enum` derivation in store-validation (revert to `z.string()`) the
 * out-of-whitelist create/update would 201/200 — every `expect(...).toBe(400)` below goes RED.
 *
 * Skips without DATABASE_URL; HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but
 * absent (un-skippable ran-guard at the bottom).
 */
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'store-enum.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the server-side enum-whitelist acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_store_enum';

// A store with a REQUIRED enum column (`status`) + a NULLABLE enum column (`severity`).
const TASKS_YAML = `
version: '1.0'
metadata:
  name: tasks-backend
  description: A minimal task backend proving server-side text enum-whitelist enforcement.
stores:
  - name: tasks
    columns:
      - { name: title, type: text }
      - { name: status, type: text, enum: ['open', 'in_progress', 'closed'] }
      - { name: severity, type: text, nullable: true, enum: ['low', 'high'] }
api:
  - { method: POST, path: '/tasks', action: { kind: store, store: tasks, op: create } }
  - { method: GET, path: '/tasks', action: { kind: store, store: tasks, op: list } }
  - { method: GET, path: '/tasks/{id}', action: { kind: store, store: tasks, op: get } }
  - { method: PATCH, path: '/tasks/{id}', action: { kind: store, store: tasks, op: update } }
`;

let testsRan = 0;

describeDb('store enum whitelist — server-side 400 enforcement', () => {
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
    jsonRequest(h.app, 'POST', '/tasks', { body, headers: { authorization: `Bearer ${token}` } });
  const patch = (token: string, id: string, body: unknown) =>
    jsonRequest(h.app, 'PATCH', `/tasks/${id}`, {
      body,
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(TASKS_YAML);
    if (!parsed.ok) throw new Error(`tasks fixture invalid: ${JSON.stringify(parsed.errors)}`);
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

  it('an in-whitelist status creates (201); an out-of-whitelist status is a 400 VALIDATION_ERROR', async () => {
    testsRan += 1;
    const a = await principal('enum-a@example.com', 'EnumOrgA');

    const ok = await post(a.token, { title: 'T1', status: 'open' });
    expect(ok.status).toBe(201);

    const bad = await post(a.token, { title: 'T2', status: 'bogus' });
    expect(bad.status).toBe(400); // NOT 201
    const body = await bad.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('an out-of-whitelist status on UPDATE is a 400 VALIDATION_ERROR (not a 200)', async () => {
    testsRan += 1;
    const a = await principal('enum-upd@example.com', 'EnumUpdOrg');
    const created = await post(a.token, { title: 'T', status: 'open' });
    expect(created.status).toBe(201);
    const id = (await created.json()).id as string;

    const bad = await patch(a.token, id, { status: 'nope' });
    expect(bad.status).toBe(400); // NOT 200
    expect((await bad.json()).error.code).toBe('VALIDATION_ERROR');

    // A valid transition still succeeds (isolates the whitelist check from a blanket reject).
    const good = await patch(a.token, id, { status: 'closed' });
    expect(good.status).toBe(200);
    expect((await good.json()).status).toBe('closed');
  });

  it('a nullable enum column accepts JSON null AND an in-whitelist value; rejects out-of-whitelist', async () => {
    testsRan += 1;
    const a = await principal('enum-null@example.com', 'EnumNullOrg');

    // severity: null on a nullable enum → accepted.
    const withNull = await post(a.token, { title: 'T', status: 'open', severity: null });
    expect(withNull.status).toBe(201);
    expect((await withNull.json()).severity).toBeNull();

    // omitting the nullable enum entirely → accepted.
    const omitted = await post(a.token, { title: 'T2', status: 'open' });
    expect(omitted.status).toBe(201);

    // an in-whitelist severity → accepted.
    const withVal = await post(a.token, { title: 'T3', status: 'open', severity: 'high' });
    expect(withVal.status).toBe(201);

    // an out-of-whitelist severity → 400 (the nullable wrap does NOT widen the whitelist).
    const bad = await post(a.token, { title: 'T4', status: 'open', severity: 'medium' });
    expect(bad.status).toBe(400);
  });
});

describe('store-enum acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the enum-enforcement arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(3);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
