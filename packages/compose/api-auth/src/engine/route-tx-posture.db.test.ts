/**
 * The `{handler}` route-arm TX-POSTURE branch, pinned DB-OBSERVABLY (the api-auth half of
 * the PM-mandated shared-surface pins; the platform invoke halves live in
 * platform/src/handlers/route-init.test.ts). The observable is real rollback-vs-commit through the
 * REAL createAuthApp chain on a real Postgres schema — not a spy:
 *
 *  1. UNFLAGGED DEFAULT (every existing handler entry): the engine holds ONE route transaction
 *     around the handler, so a write followed by a handler THROW is ROLLED BACK — the row must be
 *     ABSENT after the 500. A posture regression that stopped wrapping the default path would leave
 *     the row behind and fail this arm.
 *  2. `routeTx: 'handler-managed'`: the engine opens NO route transaction — a handler-managed
 *     `init.db.transaction(...)` COMMITS independently, so the SAME write-then-throw leaves the row
 *     PRESENT after the 500 (the intake-ordering law's foundation: a later fault cannot roll back a
 *     committed intake). If the engine wrapped the flagged handler anyway, the row would vanish and
 *     this arm fails (fail-the-fix).
 *  3. The flagged posture serves a normal success response identically (JSON body, same auth chain,
 *     same store:write gate) — the posture changes transaction ownership, nothing else.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run.
 */
import { forTenant } from '@rayspec/db';
import { makeHandlerDb, type ResolvedHandler, type RouteHandlerInit } from '@rayspec/platform';
import type { RaySpec, StoreSpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let postureTestsRan = 0;

const STORES: StoreSpec[] = [
  {
    name: 'posture_probe',
    columns: [
      { name: 'note', type: 'text', nullable: false, unique: false },
      { name: 'probe_ref', type: 'text', nullable: false, unique: true },
    ],
    foreignKeys: [],
  },
];

/** Default-posture probe: write THEN throw — under the engine tx the write must ROLL BACK. */
const writeThenThrowDefault = async (init: RouteHandlerInit): Promise<unknown> => {
  await init.db.insert('posture_probe', { note: 'default', probe_ref: `${init.tenantId}:default` });
  throw new Error('post-insert fault (default posture — the engine tx must roll the write back)');
};

/** Handler-managed probe: commit an EXPLICIT short tx THEN throw — the commit must SURVIVE. */
const writeThenThrowManaged = async (init: RouteHandlerInit): Promise<unknown> => {
  await init.db.transaction(async (tx) => {
    await tx.insert('posture_probe', { note: 'managed', probe_ref: `${init.tenantId}:managed` });
  });
  throw new Error('post-commit fault (handler-managed — the committed tx must survive)');
};

/** Handler-managed success path: normal short-tx write + JSON return (posture changes nothing else). */
const writeOkManaged = async (init: RouteHandlerInit): Promise<unknown> => {
  const row = await init.db.transaction(async (tx) =>
    tx.insert('posture_probe', { note: 'ok', probe_ref: `${init.tenantId}:ok` }),
  );
  return { wrote: row.probe_ref };
};

describe.skipIf(!hasDb)('{handler} route tx posture (default vs handler-managed)', () => {
  let h: Harness;

  beforeAll(async () => {
    const handlers = new Map<string, ResolvedHandler>([
      ['probe_default', { kind: 'route', fn: writeThenThrowDefault }],
      ['probe_managed', { kind: 'route', fn: writeThenThrowManaged, routeTx: 'handler-managed' }],
      ['probe_managed_ok', { kind: 'route', fn: writeOkManaged, routeTx: 'handler-managed' }],
    ]);
    const engineSpec: RaySpec = {
      version: '1.0',
      metadata: { name: 'route-tx-posture-test' },
      stores: STORES,
      api: [
        {
          method: 'POST',
          path: '/probe/default',
          action: { kind: 'handler', handler: 'probe_default' },
        },
        {
          method: 'POST',
          path: '/probe/managed',
          action: { kind: 'handler', handler: 'probe_managed' },
        },
        {
          method: 'POST',
          path: '/probe/managed-ok',
          action: { kind: 'handler', handler: 'probe_managed_ok' },
        },
      ],
      agents: [],
      tooling: [],
      triggers: [],
      handlers: [],
      extensions: [],
    };
    h = await createHarness({
      engineSpec,
      engineHandlers: handlers,
      schema: 'rayspec_test_txposture',
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  async function principal(
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgId = (
      await (
        await jsonRequest(h.app, 'POST', '/v1/orgs', {
          body: { name: orgName },
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).id as string;
    const token = (
      await (
        await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).accessToken as string;
    return { orgId, token };
  }

  function probeRows(orgId: string) {
    const engine = h.deps.engine;
    if (!engine) throw new Error('engine not wired');
    return makeHandlerDb(forTenant(h.db, orgId), engine.productTables).select('posture_probe');
  }

  it('UNFLAGGED DEFAULT: a handler write followed by a throw is ROLLED BACK (one engine tx)', async () => {
    postureTestsRan += 1;
    const { orgId, token } = await principal('posture-a@example.com', 'posture-org-a');
    const res = await jsonRequest(h.app, 'POST', '/probe/default', {
      body: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(500);
    // THE PIN: the engine route tx rolled the handler's write back — nothing persisted.
    expect(await probeRows(orgId)).toEqual([]);
  });

  it("routeTx:'handler-managed': a COMMITTED handler tx SURVIVES a later handler throw (zero engine tx)", async () => {
    postureTestsRan += 1;
    const { orgId, token } = await principal('posture-b@example.com', 'posture-org-b');
    const res = await jsonRequest(h.app, 'POST', '/probe/managed', {
      body: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(500);
    // THE PIN (fail-the-fix): the handler-managed short tx committed BEFORE the fault, and no
    // engine tx exists to roll it back — the row is PRESENT. If the engine wrapped the flagged
    // handler, the row would be gone and this fails.
    const rows = await probeRows(orgId);
    expect(rows.map((r) => r.note)).toEqual(['managed']);
    expect(rows[0]?.probe_ref).toBe(`${orgId}:managed`);
  });

  it('handler-managed success path: same auth chain, same JSON contract', async () => {
    postureTestsRan += 1;
    const { orgId, token } = await principal('posture-c@example.com', 'posture-org-c');
    // Unauthenticated → 401 through the SAME chain (the posture does not weaken auth).
    const noAuth = await jsonRequest(h.app, 'POST', '/probe/managed-ok', { body: {} });
    expect(noAuth.status).toBe(401);
    const res = await jsonRequest(h.app, 'POST', '/probe/managed-ok', {
      body: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ wrote: `${orgId}:ok` });
    expect((await probeRows(orgId)).map((r) => r.note)).toEqual(['ok']);
  });
});

describe('route-tx-posture — ran-guard', () => {
  it('all 3 posture arms actually ran when the DB was required', () => {
    if (dbRequired && !hasDb) {
      throw new Error(
        'route-tx-posture.db.test.ts was REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but DATABASE_URL ' +
          'is absent — the tx-posture pins silently skipped (false-green hazard).',
      );
    }
    if (hasDb) expect(postureTestsRan).toBe(3);
  });
});
