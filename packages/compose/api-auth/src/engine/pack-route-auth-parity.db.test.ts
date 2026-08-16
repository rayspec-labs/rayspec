/**
 * A PACK-CONTRIBUTED ROUTE REFUSES EXACTLY AS A DEPLOYMENT-DECLARED ONE DOES — asserted byte for byte.
 *
 * A pack contributes `api` fragments that ride the deployment's own interpreter, so auth, tenancy and
 * the refusal envelope are INHERITED rather than re-implemented. That is the design; what the tree
 * measured of it stopped short of a contributed route. `pack-route-namespace.test.ts` measures WHERE a
 * pack route may live. The refusals of the `{handler}` arm a contributed route rides ARE asserted —
 * but only for a DEPLOYMENT-declared route, and only as status codes: `declared-handler-model.db.test.ts`
 * pins the unauthenticated 401 and the under-scoped 403, `declared-route-rate-limit.db.test.ts` pins the
 * 401 for both forged credential shapes. No suite asserted a refusal on a PACK-contributed route at
 * all, and none compared a refusal's body bytes or header map against a deployment route's. So a
 * change that gave a contributed route a refusal of its own — an extra header, a `details` key on a
 * 401 — would land green; only a changed STATUS code would not.
 *
 * This suite closes that. It boots ONE app carrying BOTH kinds of route at once:
 *   - the DEPLOYMENT's own `/notebooks/{id}` (a `{store}` read, gated on `store:read`), and
 *   - the in-tree fixture pack's `/ext/fixture-pack/turns/{turn_id}` (a `{handler}` read, `readonly`,
 *     therefore gated on `store:read` too — the SAME permission, which is what makes a 403 body
 *     comparable at all: the envelope NAMES the missing permission).
 * The pack is resolved and merged by the REAL `loadExtensions`, and its handler is loaded by the REAL
 * multi-root importer — the pack route reaches the router the way a deployed one does.
 *
 * Each refusal arm sends the SAME `x-request-id` to both routes, so the echoed `requestId` is not a
 * per-request nonce and the two envelopes are comparable as BYTES rather than as shapes. Compared:
 * the status, the whole body text, and the whole response header map.
 *
 *   (1) NO CREDENTIAL          → identical 401.
 *   (2) A FORGED CREDENTIAL    → identical 401, for both credential shapes the chain accepts:
 *                                a well-formed JWT signed by a key that is not ours, and a bearer
 *                                carrying an api-key prefix that resolves to no key.
 *   (3) AN INSUFFICIENT SCOPE  → identical 403, including the named missing permission.
 *   (4) A CROSS-TENANT CALL    → a second tenant naming the first tenant's row id gets back NOTHING of
 *                                that row: the deployment route answers a uniform 404, the contributed
 *                                route answers with only what the caller itself sent, and the second
 *                                tenant's own list at the deployment route is empty.
 *                                THE LIMIT OF THIS ARM: the fixture pack's handler performs no read at
 *                                all (`gate:handler-imports` confines it to `@rayspec/handler-sdk`), so
 *                                a contributed route's DATA-PATH tenant isolation is out of this
 *                                suite's reach — what is measured is that nothing of the other tenant's
 *                                row comes back through the contributed surface, not that a reading
 *                                handler would be scoped.
 *   (5) ACCEPT CONTROL         → a correctly scoped principal of the owning tenant gets 200 from BOTH.
 *                                Without it, (1)-(3) could be passing because the app refuses
 *                                everything, and (4) because the routes serve nobody.
 *
 * The behaviour under (1)-(4) is what the platform does TODAY; this suite exists to keep it that way.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensions, loadHandlers, type ResolvedHandler } from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: every arm here is an AUTH assertion over a contributed route — a silent
// self-skip on a run that REQUIRES the database would retire the whole parity guard to a false green.
if (requireDb && !hasDb) {
  throw new Error(
    'pack-route-auth-parity.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip a security-load-bearing suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
// packages/compose/api-auth/src/engine -> packages/test/fixture-pack
const PACK_DIR = resolve(here, '../../../../test/fixture-pack');
// packages/compose/api-auth/src/engine -> repo-root/examples/acme-notes-backend
const DEPLOYMENT_YAML = resolve(here, '../../../../../examples/acme-notes-backend/rayspec.yaml');

const PACK_ID = 'fixture-pack';
/** The DEPLOYMENT's own read route — a `{store}` get, gated on `store:read`. */
const CORE_ROUTE = (id: string) => `/notebooks/${id}`;
/** The PACK's contributed read route — a `readonly` `{handler}`, gated on `store:read` too. */
const PACK_ROUTE = (id: string) => `/ext/${PACK_ID}/turns/${id}`;

let h: Harness;

/**
 * The MERGED document both routes are registered from: the deployment's stores + its `{store}` read
 * routes, plus the fixture pack's contributed route and handler, resolved through the real loader.
 *
 * The deployment's agent/tooling/trigger surface is dropped — this suite drives the auth chain, and a
 * declared agent would only add a backend the harness would have to stand in for.
 */
async function mergedSpec(): Promise<{
  spec: RaySpec;
  handlers: ReadonlyMap<string, ResolvedHandler>;
}> {
  const parsed = parseSpec(readFileSync(DEPLOYMENT_YAML, 'utf8'));
  if (!parsed.ok) throw new Error(`deployment spec invalid: ${JSON.stringify(parsed.errors)}`);
  const base = parsed.value;

  // The REAL loader, over the REAL built pack, from the directory its own deployment document names.
  const loaded = await loadExtensions([{ id: PACK_ID, module: './dist', version: '1.0.0' }], {
    packsRoot: PACK_DIR,
    deploymentRoot: PACK_DIR,
  });
  expect(loaded.api).toHaveLength(1);
  expect(loaded.api[0]?.path).toBe('/ext/fixture-pack/turns/{turn_id}');

  const spec: RaySpec = {
    ...base,
    api: [...base.api.filter((r) => r.action.kind === 'store'), ...loaded.api],
    handlers: [...loaded.handlers],
    agents: [],
    tooling: [],
    triggers: [],
    extensions: [],
  };
  // The same single-root loader a deployment uses, with the multi-root importer redirecting the
  // rewritten virtual handler path to the real pack file.
  const handlers = await loadHandlers(PACK_DIR, spec.handlers, loaded.importer);
  return { spec, handlers };
}

/** Provision a principal (register → org → switch → JWT) with the member role (store:read/write). */
async function principal(
  email: string,
  orgName: string,
): Promise<{ orgId: string; token: string }> {
  const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
    body: { email, password: 'a-long-enough-password' },
  });
  const t0 = (await reg.json()).accessToken as string;
  const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
    body: { name: orgName },
    headers: { authorization: `Bearer ${t0}` },
  });
  const orgId = (await orgRes.json()).id as string;
  const switchRes = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
    headers: { authorization: `Bearer ${t0}` },
  });
  return { orgId, token: (await switchRes.json()).accessToken as string };
}

/** Mint an org-scoped api-key with exactly `scopes` (the owner of `orgId` mints it). */
async function mintApiKey(orgId: string, ownerToken: string, scopes: string[]): Promise<string> {
  const res = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
    body: { name: 'parity-key', scopes },
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  if (res.status !== 201) {
    throw new Error(`api-key mint failed: ${res.status} ${JSON.stringify(await res.json())}`);
  }
  return (await res.json()).plaintext as string;
}

/**
 * A well-formed RS256 JWT signed by a key that is NOT the app's — a forged credential. The key pair is
 * minted here and never handed to the app, so the token is structurally valid and its signature is
 * unverifiable: the chain must refuse it exactly as it refuses no credential at all.
 */
async function forgedJwt(): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256');
  return new SignJWT({ orgId: '00000000-0000-4000-8000-000000000001', scopes: ['store:read'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'not-ours' })
    .setSubject('00000000-0000-4000-8000-000000000002')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

/** The comparable facts of one response: status, the whole body, and the whole header map. */
interface Observed {
  status: number;
  body: string;
  headers: Array<[string, string]>;
}

async function observe(res: Response): Promise<Observed> {
  return {
    status: res.status,
    body: await res.text(),
    headers: [...res.headers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

/**
 * Issue the SAME request to the deployment route and to the pack route and return both observations.
 * The fixed `x-request-id` is what makes the two envelopes comparable as bytes: the middleware echoes
 * a well-formed incoming id, so `requestId` is the same in both bodies instead of a fresh UUID.
 */
async function bothRoutes(
  requestId: string,
  id: string,
  headers: Record<string, string> = {},
): Promise<{ core: Observed; pack: Observed }> {
  const withId = { ...headers, 'x-request-id': requestId };
  const core = await jsonRequest(h.app, 'GET', CORE_ROUTE(id), { headers: withId });
  const pack = await jsonRequest(h.app, 'GET', PACK_ROUTE(id), { headers: withId });
  return { core: await observe(core), pack: await observe(pack) };
}

const SOME_ID = '00000000-0000-4000-8000-0000000000aa';

beforeAll(async () => {
  if (!hasDb) return;
  const { spec, handlers } = await mergedSpec();
  h = await createHarness({
    engineSpec: spec,
    engineHandlers: handlers,
    schema: 'rayspec_test_apiauth_packauthparity',
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

describeDb('a pack route refuses exactly as a deployment route does', () => {
  it('(1) no credential: identical 401 — status, body envelope and header map', async () => {
    const { core, pack } = await bothRoutes('parity-unauthenticated', SOME_ID);
    expect(core.status).toBe(401);
    expect(pack).toEqual(core);
    expect(JSON.parse(core.body)).toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication failed.',
        requestId: 'parity-unauthenticated',
      },
    });
  });

  it('(2) a forged JWT: identical 401 — status, body envelope and header map', async () => {
    const token = await forgedJwt();
    const { core, pack } = await bothRoutes('parity-forged-jwt', SOME_ID, {
      authorization: `Bearer ${token}`,
    });
    expect(core.status).toBe(401);
    expect(pack).toEqual(core);
    // The refusal is the UNIFORM one: a forged credential is answered exactly as an absent one, so
    // neither route tells a prober that its token was well-formed but wrongly signed.
    expect(JSON.parse(core.body).error.code).toBe('UNAUTHENTICATED');
  });

  it('(2) an unknown api-key: identical 401 — status, body envelope and header map', async () => {
    const { core, pack } = await bothRoutes('parity-unknown-api-key', SOME_ID, {
      authorization: 'Bearer rk_notaknownkey.0123456789abcdef',
    });
    expect(core.status).toBe(401);
    expect(pack).toEqual(core);
    expect(JSON.parse(core.body).error.code).toBe('UNAUTHENTICATED');
  });

  it('(3) an insufficient scope: identical 403, naming the SAME missing permission', async () => {
    const owner = await principal('parity-scope@example.test', 'Parity Scope');
    // A real, valid api-key of THIS tenant that simply does not carry `store:read`.
    const key = await mintApiKey(owner.orgId, owner.token, ['org:read']);
    const { core, pack } = await bothRoutes('parity-insufficient-scope', SOME_ID, {
      authorization: `Bearer ${key}`,
    });
    expect(core.status).toBe(403);
    expect(pack).toEqual(core);
    expect(JSON.parse(core.body)).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Forbidden.',
        requestId: 'parity-insufficient-scope',
        details: { missing_permission: 'store:read' },
      },
    });
  });

  it('(4) cross-tenant: the answer carries nothing of the other tenant’s row, and its list is empty', async () => {
    const a = await principal('parity-a@example.test', 'Parity A');
    const b = await principal('parity-b@example.test', 'Parity B');
    const created = await jsonRequest(h.app, 'POST', '/notebooks', {
      body: { title: 'SECRET_FROM_A', scheduled_at: '2026-01-01T00:00:00Z', completed: false },
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(created.status).toBe(201);
    const rowId = (await created.json()).id as string;

    // Tenant A reads its own row at the deployment route — the accept control for the empty read.
    const ownRead = await jsonRequest(h.app, 'GET', CORE_ROUTE(rowId), {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(ownRead.status).toBe(200);
    expect((await ownRead.json()).title).toBe('SECRET_FROM_A');

    // Tenant B names A's row id at BOTH routes, with a credential that is valid for B.
    const { core, pack } = await bothRoutes('parity-cross-tenant', rowId, {
      authorization: `Bearer ${b.token}`,
    });
    // The deployment route: a uniform 404 — B cannot tell A's row from one that never existed.
    expect(core.status).toBe(404);
    expect(JSON.parse(core.body).error.code).toBe('NOT_FOUND');
    expect(core.body).not.toContain('SECRET_FROM_A');
    // The pack route: it answers, and its answer carries ONLY what B itself sent. Nothing of A's row
    // — no field, no value — comes back through the contributed surface. This is not the deployment
    // route's emptiness in disguise: that one is empty because the tenant predicate excludes A's row,
    // while the fixture handler reads no row at all. What this pins is the ANSWER, not a scoped read.
    expect(pack.status).toBe(200);
    expect(JSON.parse(pack.body)).toEqual({ turnId: rowId });
    expect(pack.body).not.toContain('SECRET_FROM_A');
    // And B's list at the deployment route is EMPTY: A's row is not in B's tenant at all.
    const list = await jsonRequest(h.app, 'GET', '/notebooks', {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
  });

  it('(5) accept control: a correctly scoped principal gets 200 from BOTH routes', async () => {
    const owner = await principal('parity-accept@example.test', 'Parity Accept');
    const key = await mintApiKey(owner.orgId, owner.token, ['store:read']);
    for (const auth of [`Bearer ${owner.token}`, `Bearer ${key}`]) {
      const pack = await jsonRequest(h.app, 'GET', PACK_ROUTE(SOME_ID), {
        headers: { authorization: auth },
      });
      expect(pack.status).toBe(200);
      expect(await pack.json()).toEqual({ turnId: SOME_ID });
      const core = await jsonRequest(h.app, 'GET', '/notebooks', {
        headers: { authorization: auth },
      });
      expect(core.status).toBe(200);
    }
  });
});
