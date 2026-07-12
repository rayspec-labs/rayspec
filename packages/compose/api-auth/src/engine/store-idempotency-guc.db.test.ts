/**
 * The idempotency REPLAY-READ runs inside a tenant transaction that sets the
 * `app.current_tenant` GUC (RLS-safe), not a bare `.select()`.
 *
 * When a store.create with an `Idempotency-Key` collides on a unique index, the create tx throws
 * `IdempotencyReplayNeeded` and rolls back; the OUTER catch reads the prior `(tenant, key)` row to
 * replay it. The replay runs that read in `forTenant(deps.db, tenantId).transaction(tx => tx.select(...))`
 * so it sets the `app.current_tenant` GUC — the same invariant every store touch holds — so an
 * external-exposure RLS policy binds to a populated GUC and the read never fail-closes. Reverting it to
 * a bare `.select()` leaves ALL other tests green (no RLS is mounted today, so the GUC has no observable
 * effect), which is exactly the blind spot this suite closes.
 *
 * The proof uses the A3 `wrapDb` GUC-capture seam (test-support/harness.ts): the wrapper observes
 * `current_setting('app.current_tenant')` INSIDE every transaction that runs through `deps.db`. We RESET
 * the captured value to a sentinel right BEFORE the idempotent RETRY, so the ONLY transaction that can
 * repopulate it on that request is the replay-read (the retry's create tx THROWS before the wrapper's
 * capture line, so it never captures; middleware uses the UNWRAPPED stores). If the replay is reverted to a
 * bare non-tx select, the replay-read never runs through `deps.db.transaction`, the sentinel survives,
 * and the assertion goes RED.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * yet absent (un-skippable ran-guard at the bottom).
 */
import { type Db, TENANT_GUC } from '@rayspec/db';
import { parseSpec } from '@rayspec/spec';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'store-idempotency-guc.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the idempotency replay-read GUC (RLS-safety) acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_idempotency_guc';

// A minimal backend-profile spec: one keyless store + a CREATE route. The injected idempotency-key
// unique index is enough to make an identical idempotent RETRY collide (23505) → the idempotency replay path.
const NOTES_YAML = `
version: '1.0'
metadata:
  name: guc-backend
  description: A minimal store exercising the idempotency replay-read GUC invariant.
stores:
  - name: notes
    columns:
      - { name: content, type: text }
api:
  - { method: POST, path: '/notes', action: { kind: store, store: notes, op: create } }
  - { method: GET, path: '/notes', action: { kind: store, store: notes, op: list } }
`;

const SENTINEL = 'UNCAPTURED-sentinel';
let testsRan = 0;

describeDb('the replay-read runs in a tenant tx that sets the GUC', () => {
  let h: Harness;
  // The GUC value read INSIDE each transaction that runs through deps.db (repopulated per tx).
  const capturedGuc: { value: string | null } = { value: SENTINEL };

  // Wrap the raw Db so any `forTenant(deps.db, …).transaction(…)` body is observed: after TenantDb's
  // set_config + the body run, read current_setting on the SAME tx handle. A throwing tx (the retry's
  // create) never reaches the capture line, so it cannot mask the replay-read's capture.
  function wrapDb(db: Db): Db {
    const realTransaction = db.transaction.bind(db);
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (inner: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
            realTransaction(
              async (tx: unknown) => {
                const r = await inner(tx);
                const rows = (await (tx as Db).execute(
                  sql`select current_setting(${TENANT_GUC}, true) as tenant`,
                )) as unknown as Array<{ tenant: string | null }>;
                capturedGuc.value = rows[0]?.tenant ?? null;
                return r;
              },
              ...(rest as []),
            ) as unknown;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
  }

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

  const post = (token: string, body: unknown, idemKey: string) =>
    jsonRequest(h.app, 'POST', '/notes', {
      body,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': idemKey },
    });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(NOTES_YAML);
    if (!parsed.ok) throw new Error(`notes fixture invalid: ${JSON.stringify(parsed.errors)}`);
    h = await createHarness({ engineSpec: parsed.value, schema: SCHEMA, wrapDb });
  });
  beforeEach(async () => {
    if (!hasDb) return;
    await h.reset();
    capturedGuc.value = SENTINEL;
  });
  afterAll(async () => {
    if (!hasDb) return;
    await h.close();
  });

  it('the idempotent RETRY replays 200 AND its replay-read tx populated app.current_tenant with the request tenant', async () => {
    testsRan += 1;
    const a = await principal('guc-a@example.com', 'GucOrgA');

    // (1) First create with Idempotency-Key K → 201. Its create tx sets the GUC (A3) — proven by the
    // capture reflecting the row's tenant. Read the tenant off the response (serializeRow exposes it).
    const first = await post(a.token, { content: 'hello' }, 'K-GUC-1');
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const firstId = firstBody.id as string;
    const tenantId = firstBody.tenant_id as string;
    expect(typeof tenantId).toBe('string');
    // The create tx ran with the GUC populated to the request tenant (baseline A3 invariant).
    expect(capturedGuc.value).toBe(tenantId);

    // (2) RESET the sentinel: only a transaction on the RETRY may repopulate it now. The retry's create
    // tx throws IdempotencyReplayNeeded (never reaching the wrapper's capture line), so the replay-read
    // is the ONLY transaction that can set it — and ONLY if the replay kept it inside forTenant(...).transaction.
    capturedGuc.value = SENTINEL;

    // (3) IDENTICAL retry (same K) → 200 + Idempotency-Replay, the SAME row id (no duplicate).
    const retry = await post(a.token, { content: 'hello' }, 'K-GUC-1');
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotency-Replay')).toBe('true');
    expect((await retry.json()).id).toBe(firstId);

    // THE replay-read assertion: the replay-read ran inside a tenant transaction that set app.current_tenant to
    // the request tenant. Reverting the replay to a bare `.select()` (no tx, no set_config) leaves the sentinel
    // in place → this goes RED. (A bare non-tx read would ALSO set no GUC, so RLS would fail-close it.)
    expect(capturedGuc.value).not.toBe(SENTINEL);
    expect(capturedGuc.value).toBe(tenantId);
  });
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that fails when the DB is REQUIRED (CI /
 * RAYSPEC_REQUIRE_DB_TESTS) but the acceptance arm did not run (no silent false-green).
 */
describe('replay-read GUC — ran-guard (must not silently skip in CI)', () => {
  it('the replay-read GUC arm ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(1);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
