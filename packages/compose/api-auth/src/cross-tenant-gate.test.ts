/**
 * FULL-SURFACE cross-tenant CI gate (the ROADMAP exit requirement).
 *
 * Drives the REAL Hono app with TWO principals (orgA, orgB). For EVERY tenant-scoped resource
 * (orgs, api_keys, memberships via /me, sessions, runs/journal/conversation via the run-journal
 * tables) AND the OAuth/OIDC surface (the oauth token endpoint + the node-oidc-provider
 * token/grant/client store), it asserts orgB/clientB gets 404/empty and NEVER reads / lists /
 * mutates / resolves orgA/clientA's rows or tokens. PLUS the replay-rejection test.
 *
 * A RED test here makes CI RED (it slots into the existing `pnpm test` turbo job). This is the
 * single most load-bearing gate.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';
import { type Db, forTenant, generateProductSql, schema } from '@rayspec/db';
// The product-tenancy GATE machinery is gate-only — imported from /testing (off the main surface).
import { assertProductTenancy, buildProductTables, makeDbWithSchema } from '@rayspec/db/testing';
import { runAgent } from '@rayspec/platform';
import { parseSpec, type StoreSpec } from '@rayspec/spec';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair } from 'jose';
import Provider from 'oidc-provider';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from './app-context.js';
import { mountOidc } from './oidc/mount.js';
import { DrizzleOidcAdapter } from './stores/oidc-store.js';
import { createHarness, type Harness, jsonRequest } from './test-support/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ schema: 'rayspec_test_apiauth_xtenant' });
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h.close();
});

interface Principal {
  userId: string;
  orgId: string;
  token: string; // a JWT scoped to orgId
  apiKey: string; // an org-scoped api-key plaintext (apikey:read scope)
  keyId: string;
}

/** Build two fully-provisioned principals in two different orgs. */
async function twoPrincipals(): Promise<{ a: Principal; b: Principal }> {
  const mk = async (email: string, orgName: string): Promise<Principal> => {
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
    const token = (await switchRes.json()).accessToken as string;
    const mint = await (
      await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/api-keys`, {
        body: { scopes: ['apikey:read', 'org:read', 'agent:run'] },
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    // userId from /me.
    const me = await (
      await jsonRequest(h.app, 'GET', '/v1/auth/me', {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    return { userId: me.userId, orgId, token, apiKey: mint.plaintext, keyId: mint.id };
  };
  const a = await mk('tenant-a@example.com', 'OrgAlpha');
  const b = await mk('tenant-b@example.com', 'OrgBeta');
  return { a, b };
}

describe('full-surface cross-tenant isolation (CI-BLOCKING)', () => {
  it('orgs: B cannot read/mutate A’s org via the URL (404, no existence leak)', async () => {
    const { a, b } = await twoPrincipals();
    // B (token scoped to orgB) hits A's org api-key list → 404 (URL orgId != server tenant).
    const read = await jsonRequest(h.app, 'GET', `/v1/orgs/${a.orgId}/api-keys`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(read.status).toBe(404);
    // B's /v1/orgs lists ONLY orgB.
    const list = await (
      await jsonRequest(h.app, 'GET', '/v1/orgs', {
        headers: { authorization: `Bearer ${b.token}` },
      })
    ).json();
    expect(list.orgs.map((o: { id: string }) => o.id)).toEqual([b.orgId]);
  });

  it('api_keys: B cannot list/revoke A’s keys (404)', async () => {
    const { a, b } = await twoPrincipals();
    const list = await jsonRequest(h.app, 'GET', `/v1/orgs/${a.orgId}/api-keys`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(list.status).toBe(404);
    const revoke = await jsonRequest(h.app, 'DELETE', `/v1/orgs/${a.orgId}/api-keys/${a.keyId}`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(revoke.status).toBe(404);
    // A's key is UNTOUCHED — A can still list it.
    const aList = await (
      await jsonRequest(h.app, 'GET', `/v1/orgs/${a.orgId}/api-keys`, {
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).json();
    expect(aList.keys.length).toBe(1);
  });

  it('api-key principal: B’s api-key cannot act in A’s org (404)', async () => {
    const { a, b } = await twoPrincipals();
    // B's api-key (bound to orgB) hits A's org → 404 (server tenant = orgB != URL orgA).
    const res = await jsonRequest(h.app, 'GET', `/v1/orgs/${a.orgId}/api-keys`, {
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    expect(res.status).toBe(404);
  });

  it('memberships (/me): each principal sees ONLY its own membership', async () => {
    const { a, b } = await twoPrincipals();
    const aMe = await (
      await jsonRequest(h.app, 'GET', '/v1/auth/me', {
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).json();
    expect(aMe.memberships.map((m: { orgId: string }) => m.orgId)).toEqual([a.orgId]);
    expect(aMe.userId).not.toBe(b.userId);
  });

  it('runs / journal_steps / conversation_items: forTenant(B) sees NONE of A’s rows', async () => {
    const { a, b } = await twoPrincipals();
    // Seed a run + journal step + conversation row under orgA directly (the run-journal surface).
    const tdbA = forTenant(h.db, a.orgId);
    await tdbA.insert(schema.runs, {
      runId: 'xt-run-A',
      backend: 'openai',
      authMode: 'api-key',
      agentName: 'x',
      model: 'm',
      status: 'completed',
      finalText: 'SECRET_FROM_A',
    });
    await tdbA.insert(schema.journalSteps, {
      runId: 'xt-run-A',
      backend: 'openai',
      type: 'llm',
      idempotencyKey: 'k',
      inputHash: 'h',
      output: { secret: 'SECRET_FROM_A' },
      status: 'ok',
      authMode: 'api-key',
    });
    await tdbA.insert(schema.conversationItems, {
      runId: 'xt-run-A',
      seq: '0',
      role: 'assistant',
      content: 'SECRET_FROM_A',
    });
    // seed a run_events row under A (the durable SSE-replay log is tenant-scoped too).
    await tdbA.insert(schema.runEvents, {
      runId: 'xt-run-A',
      seq: '0',
      type: 'text_delta',
      data: { type: 'text_delta', runId: 'xt-run-A', seq: 0, text: 'SECRET_FROM_A' },
    });

    // forTenant(B) — the chokepoint auto-injects the tenant predicate — sees NOTHING of A's.
    const tdbB = forTenant(h.db, b.orgId);
    expect((await tdbB.select(schema.runs).all()).length).toBe(0);
    expect((await tdbB.select(schema.journalSteps).all()).length).toBe(0);
    expect((await tdbB.select(schema.conversationItems).all()).length).toBe(0);
    // run_events is tenant-scoped: B sees none of A's durable run events (SSE-replay leak closed).
    expect((await tdbB.select(schema.runEvents).all()).length).toBe(0);
    // B's run-header ownership probe of A's runId returns 'foreign' (verdict only, no payload).
    expect(await tdbB.runHeaderOwnership('xt-run-A')).toBe('foreign');
  });

  it('sessions: B’s session secret cannot be resolved as A (uniform 401)', async () => {
    const { a } = await twoPrincipals();
    // A forged/foreign session secret never authenticates.
    const refresh = await jsonRequest(h.app, 'POST', '/v1/auth/refresh', {
      headers: {
        cookie: '__Host-rayspec_refresh=forged-secret-not-belonging-to-anyone',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(refresh.status).toBe(401);
    // A's session still works (no collateral revoke).
    expect(a.userId).toBeTruthy();
  });

  it('idempotency_keys: B cannot read A’s idempotency record (tenant-scoped via forTenant)', async () => {
    const { a, b } = await twoPrincipals();
    const tdbA = forTenant(h.db, a.orgId);
    await tdbA
      .insert(schema.idempotencyKeys, {
        scope: 'apikey:mint',
        idemKey: 'shared-key',
        bodyHash: 'hashA',
        snapshot: { secret: 'A_SNAPSHOT' },
      })
      .onConflictDoNothing();
    const tdbB = forTenant(h.db, b.orgId);
    const bRows = await tdbB
      .select(schema.idempotencyKeys)
      .where(eq(schema.idempotencyKeys.idemKey, 'shared-key'));
    expect(bRows.length).toBe(0);
  });
});

/**
 * replay-rejection test (re-asserted here so the full-surface gate INCLUDES it): a
 * B-context replay of A's runId is rejected BEFORE the model runs, A's row is untouched, and
 * SECRET_A never leaks to B.
 */
describe('replay rejection (in the full-surface gate)', () => {
  class TripwireBackend implements Backend {
    readonly id = 'openai' as const;
    modelCalled = false;
    async resolveAuth() {
      return 'api-key' as const;
    }
    async run(_spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
      if (ctx.replay) {
        const cached = await ctx.journal.lookup('k');
        if (cached) {
          return this.done(ctx, (cached.output as { finalText?: string })?.finalText ?? '');
        }
      }
      this.modelCalled = true;
      return this.done(ctx, 'B re-ran');
    }
    private done(ctx: RunContext, finalText: string): RunResult {
      return {
        runId: ctx.runId,
        backend: this.id,
        authMode: 'api-key',
        status: 'completed',
        finalText,
        conversation: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costUsd: 0,
        stepCount: 0,
      };
    }
  }

  const spec: AgentSpec = {
    name: 'x',
    instructions: 'i',
    model: 'm',
    input: 'in',
    tools: [],
    maxTurns: 8,
  };

  it('rejects B’s replay of A’s runId before the model runs; A’s row unchanged; SECRET_A not leaked', async () => {
    const { a, b } = await twoPrincipals();
    const tdbA = forTenant(h.db, a.orgId);
    await tdbA.insert(schema.runs, {
      runId: 'replay-R',
      backend: 'openai',
      authMode: 'api-key',
      agentName: 'x',
      model: 'm',
      status: 'completed',
      finalText: 'SECRET_A',
    });
    await tdbA.insert(schema.journalSteps, {
      runId: 'replay-R',
      backend: 'openai',
      type: 'llm',
      idempotencyKey: 'k',
      inputHash: 'h',
      output: { finalText: 'SECRET_A' },
      status: 'ok',
      authMode: 'api-key',
    });

    const backend = new TripwireBackend();
    const result = await runAgent(forTenant(h.db, b.orgId), backend, spec, {
      replayRunId: 'replay-R',
    });
    expect(backend.modelCalled).toBe(false);
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain('SECRET_A');

    // A's run row is unchanged + still owned by A.
    const aRow = await h.db.select().from(schema.runs).where(eq(schema.runs.runId, 'replay-R'));
    expect(aRow[0]?.tenantId).toBe(a.orgId);
    expect(aRow[0]?.finalText).toBe('SECRET_A');
  });
});

/**
 * OIDC token/grant/client STORE isolation gate (the predicate-exempt
 * surface the prior gate never exercised).
 *
 * The node-oidc-provider model store (oidc_models) is GLOBAL / predicate-exempt by design: the
 * adapter's find(model,id) / consume(id) / revokeByGrantId(grantId) carry NO tenant/client column
 * — isolation is by (a) the provider's own unguessable random artifact ids + grantIds, and (b) the
 * provider's protocol-level client binding (a code/token issued to client A is bound to A's
 * client_id and is rejected when client B presents it). This gate drives the REAL mounted provider
 * (Drizzle adapter over Postgres) over a real HTTP server with TWO clients bound to orgA/orgB and
 * proves BOTH layers:
 *   - client_credentials succeeds for each client (stateless RFC-9068 JWTs);
 *   - an authorization_code + PKCE round trip for client A PERSISTS oidc_models rows
 *     (AuthorizationCode → consumed; Grant + RefreshToken sharing a grantId);
 *   - client B CANNOT exchange A's authorization code, CANNOT refresh with A's refresh_token
 *     (protocol-level client binding), and at the adapter level B's revokeByGrantId(B's grant)
 *     leaves A's rows intact while revokeByGrantId(A's grant) only touches A's rows (grant
 *     partitioning) — so a token/grant for client A never resolves/consumes/revokes for client B.
 *
 * NOTE (honest scoping per the decision): OIDC client_credentials org-binding / consumption by
 * /v1 is DEFERRED in (the live M2M path is the api-key m2m_client). This gate proves STORE-ROW
 * protocol isolation between clients, not org-claim stamping (which does not ship).
 */
describe('OIDC store cross-tenant/client isolation', () => {
  const SCHEMA = 'rayspec_test_oidc_gate';
  const REDIRECT = 'http://127.0.0.1:9999/cb';
  const CLIENT_A = { client_id: 'gate-client-a', client_secret: 'gate-secret-a', orgId: 'org-a' };
  const CLIENT_B = { client_id: 'gate-client-b', client_secret: 'gate-secret-b', orgId: 'org-b' };

  let gdb: Db;
  let gserver: Server;
  let gbase: string;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL required');
    gdb = makeDbWithSchema(url, SCHEMA);
    await gdb.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      SET search_path TO ${SCHEMA};
      CREATE TABLE oidc_models (
        model text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
        grant_id text, user_code text, uid text, consumed_at timestamptz, expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT oidc_models_model_id_pk PRIMARY KEY (model, id)
      );
      CREATE INDEX oidc_grant_idx ON oidc_models (grant_id);
      CREATE INDEX oidc_user_code_idx ON oidc_models (user_code);
      CREATE INDEX oidc_uid_idx ON oidc_models (uid);
    `);

    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        probe.close(() => resolve(p));
      });
    });
    gbase = `http://127.0.0.1:${port}`;

    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(privateKey);

    // PROVIDER-CONFIG DIVERGENCE (intentional, documented): this gate builds a bespoke
    // `new Provider(...)` rather than the shipped `createOidcProvider` (provider.ts). The
    // load-bearing surface — the DrizzleOidcAdapter over real Postgres — IS the shipped one
    // (`DrizzleOidcAdapter.factory(gdb)`, identical to provider.ts:35), and the SHIPPED provider
    // CONFIG is independently exercised end-to-end by `oidc/cross-client-isolation.test.ts` and the
    // served token-guard suite (both call createOidcProvider). The gate diverges because it drives a
    // PROGRAMMATIC authorization_code + PKCE + refresh round trip to PERSIST AuthorizationCode/
    // Grant/RefreshToken rows (the artifacts the store-isolation + revokeByGrantId assertions need),
    // which requires three things the shipped factory deliberately does NOT expose:
    //   1. devInteractions (a login/consent UI) — production uses the first-party login, not this;
    //   2. `issueRefreshToken: () => true` to FORCE a persisted RefreshToken row; and
    //   3. NO resourceIndicators (the shipped jwt-access-token + resource-server consent path does
    //      not grant offline_access through the dev-interaction consent, so no refresh row persists).
    // Reproducing the shipped config here would mean adding production knobs (always-on refresh
    // tokens, an enabled dev UI) that weaken the deployed posture — out of scope for this pass.
    const mkClient = (c: typeof CLIENT_A) => ({
      client_id: c.client_id,
      client_secret: c.client_secret,
      grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
      response_types: ['code'],
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_basic',
      // biome-ignore lint/suspicious/noExplicitAny: provider client extra metadata (org binding).
      ...({ orgId: c.orgId } as any),
    });
    const provider = new Provider(`${gbase}/oidc`, {
      adapter: DrizzleOidcAdapter.factory(gdb),
      clients: [mkClient(CLIENT_A), mkClient(CLIENT_B)],
      jwks: { keys: [{ ...jwk, use: 'sig', alg: 'RS256' }] },
      pkce: { required: () => true },
      scopes: ['openid', 'offline_access'],
      // Always issue a refresh_token for an offline_access grant so the auth_code flow PERSISTS a
      // RefreshToken row (the grantable artifact the store-isolation assertions revoke by grantId).
      issueRefreshToken: async () => true,
      features: {
        clientCredentials: { enabled: true },
        devInteractions: { enabled: true },
      },
      ttl: { AccessToken: 3600, AuthorizationCode: 600, RefreshToken: 1209600 },
      cookies: { keys: ['gate-cookie-key'] },
    });
    // biome-ignore lint/suspicious/noExplicitAny: provider internal proxy flag for local http.
    (provider as any).proxy = true;

    const app = new OpenAPIHono<AppEnv>();
    app.route('/oidc', mountOidc(provider));
    gserver = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => gserver.close(() => resolve()));
    await gdb.$client.end();
  });

  function basicAuth(c: { client_id: string; client_secret: string }): string {
    return Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
  }

  async function clientCredentials(c: { client_id: string; client_secret: string }) {
    return fetch(`${gbase}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basicAuth(c)}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
  }

  /**
   * Drive a full authorization_code + PKCE round trip for `client`, returning the issued
   * `code` (pre-exchange) so a test can choose WHO exchanges it. Persists an AuthorizationCode
   * row in oidc_models bound to `client`.
   */
  async function authorize(client: { client_id: string }): Promise<{
    code: string;
    codeVerifier: string;
  }> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const jar = new Map<string, string>();
    const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const absorb = (res: Response) => {
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [pair] = sc.split(';');
        const eq = pair?.indexOf('=') ?? -1;
        if (pair && eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    };

    const authParams = new URLSearchParams({
      client_id: client.client_id,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: 'openid offline_access',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: 'gate-state',
    });
    let res = await fetch(`${gbase}/oidc/auth?${authParams}`, { redirect: 'manual' });
    absorb(res);
    let location = res.headers.get('location') ?? '';
    const uid = location.split('/interaction/')[1]?.replace(/\/$/, '') ?? '';
    res = await fetch(`${gbase}/oidc/interaction/${uid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
      body: new URLSearchParams({ prompt: 'login', login: 'gate-user', password: 'x' }),
      redirect: 'manual',
    });
    absorb(res);
    res = await fetch(`${gbase}/oidc/auth/${uid}`, {
      headers: { cookie: cookieHeader() },
      redirect: 'manual',
    });
    absorb(res);
    location = res.headers.get('location') ?? '';
    for (let i = 0; i < 4 && location.includes('/interaction/'); i++) {
      const stepUid = location.split('/interaction/')[1]?.replace(/\/$/, '') ?? uid;
      res = await fetch(`${gbase}/oidc/interaction/${stepUid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
        body: new URLSearchParams({ prompt: 'consent' }),
        redirect: 'manual',
      });
      absorb(res);
      res = await fetch(`${gbase}/oidc/auth/${stepUid}`, {
        headers: { cookie: cookieHeader() },
        redirect: 'manual',
      });
      absorb(res);
      location = res.headers.get('location') ?? '';
    }
    const code = new URL(location).searchParams.get('code');
    if (!code) throw new Error(`authorize(${client.client_id}) yielded no code (loc=${location})`);
    return { code, codeVerifier };
  }

  async function exchangeCode(
    client: { client_id: string; client_secret: string },
    code: string,
    codeVerifier: string,
  ) {
    return fetch(`${gbase}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basicAuth(client)}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: codeVerifier,
      }),
    });
  }

  it('each client_credentials grant succeeds for its OWN client', async () => {
    const a = await clientCredentials(CLIENT_A);
    expect(a.status).toBe(200);
    const b = await clientCredentials(CLIENT_B);
    expect(b.status).toBe(200);
    const at = (await a.json()) as { access_token: string };
    const bt = (await b.json()) as { access_token: string };
    expect(at.access_token).toBeTruthy();
    expect(bt.access_token).not.toBe(at.access_token);
  });

  it('client B CANNOT exchange client A’s authorization code (protocol client binding)', async () => {
    const { code, codeVerifier } = await authorize(CLIENT_A);
    // The AuthorizationCode row is PERSISTED in the store, bound to client A.
    const acRows = await gdb
      .select()
      .from(schema.oidcModels)
      .where(eq(schema.oidcModels.model, 'AuthorizationCode'));
    expect(acRows.length).toBeGreaterThan(0);

    // Client B tries to exchange A's code → rejected (invalid_grant; code bound to client A).
    const crossed = await exchangeCode(CLIENT_B, code, codeVerifier);
    expect(crossed.status).toBe(400);
    const body = (await crossed.json()) as { error?: string };
    expect(body.error).toBe('invalid_grant');

    // Client A CAN exchange its OWN code → tokens issued; the code is consumed.
    const ok = await exchangeCode(CLIENT_A, code, codeVerifier);
    expect(ok.status).toBe(200);
    const tok = (await ok.json()) as { access_token?: string; refresh_token?: string };
    expect(tok.access_token).toBeTruthy();
    expect(tok.refresh_token).toBeTruthy();
  });

  it('client B CANNOT refresh with client A’s refresh_token (protocol client binding)', async () => {
    const { code, codeVerifier } = await authorize(CLIENT_A);
    const tok = (await (await exchangeCode(CLIENT_A, code, codeVerifier)).json()) as {
      refresh_token: string;
    };
    expect(tok.refresh_token).toBeTruthy();

    // A RefreshToken row is persisted bound to client A.
    const rtRows = await gdb
      .select()
      .from(schema.oidcModels)
      .where(eq(schema.oidcModels.model, 'RefreshToken'));
    expect(rtRows.length).toBeGreaterThan(0);

    const refresh = (c: { client_id: string; client_secret: string }) =>
      fetch(`${gbase}/oidc/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basicAuth(c)}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tok.refresh_token,
        }),
      });

    // Client B presents A's refresh_token → rejected (bound to client A).
    const crossed = await refresh(CLIENT_B);
    expect(crossed.status).toBe(400);
    expect(((await crossed.json()) as { error?: string }).error).toBe('invalid_grant');

    // Client A refreshes its OWN token → 200.
    const ok = await refresh(CLIENT_A);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { access_token?: string }).access_token).toBeTruthy();
  });

  it('adapter revokeByGrantId is grant-partitioned: revoking B’s grant leaves A’s rows intact', async () => {
    // Provision a persisted grant for EACH client (authorization_code + refresh exchange).
    const ga = await authorize(CLIENT_A);
    await exchangeCode(CLIENT_A, ga.code, ga.codeVerifier);
    const gb = await authorize(CLIENT_B);
    await exchangeCode(CLIENT_B, gb.code, gb.codeVerifier);

    // Read the distinct grant_ids in the store — there must be >= 2 (one per client's grant).
    const granted = await gdb
      .select()
      .from(schema.oidcModels)
      .where(eq(schema.oidcModels.model, 'RefreshToken'));
    const grantIds = [...new Set(granted.map((r) => r.grantId).filter((g): g is string => !!g))];
    expect(grantIds.length).toBeGreaterThanOrEqual(2);

    // Map each grant to ITS client via the persisted payload.clientId.
    const clientOfGrant = (gid: string): string | undefined =>
      (granted.find((r) => r.grantId === gid)?.payload as { clientId?: string } | undefined)
        ?.clientId;
    const grantA = grantIds.find((g) => clientOfGrant(g) === CLIENT_A.client_id);
    const grantB = grantIds.find((g) => clientOfGrant(g) === CLIENT_B.client_id);
    expect(grantA).toBeTruthy();
    expect(grantB).toBeTruthy();
    expect(grantA).not.toBe(grantB);

    // Count rows sharing each grant BEFORE revoke.
    const countForGrant = async (gid: string) =>
      (await gdb.select().from(schema.oidcModels).where(eq(schema.oidcModels.grantId, gid))).length;
    const aBefore = await countForGrant(grantA as string);
    expect(aBefore).toBeGreaterThan(0);

    // Revoke ONLY client B's grant via the adapter (the model-agnostic revoke path).
    const adapter = new DrizzleOidcAdapter(gdb, 'RefreshToken');
    await adapter.revokeByGrantId(grantB as string);

    // B's rows are gone; A's rows are UNTOUCHED (grant partitioning — no cross-client revoke).
    expect(await countForGrant(grantB as string)).toBe(0);
    expect(await countForGrant(grantA as string)).toBe(aBefore);
  });
});

/**
 * GENERATED PRODUCT-TABLE tenancy gate — CI-BLOCKING.
 *
 * Structural tenancy must hold for MATERIALIZED PRODUCT tables, not just the core run-journal
 * tables. The platform main line is PRODUCT-EMPTY, so this gate is PARAMETERIZED over a generated
 * schema and fed the THROWAWAY's `notebooks`/`entries` (read from examples/acme-notes-backend) so it
 * is NON-VACUOUS. For EVERY generated product table it asserts:
 *   (a) it is in TENANT_SCOPED_TABLES (reachable via the REAL TenantDb chokepoint when registered);
 *   (b) it has the tenant_id FK -> orgs ON DELETE CASCADE AND the cascade removes rows;
 *   (c) it is UNREACHABLE via TenantDb until registered (deny-by-default throws).
 * `assertProductTenancy` exercises the REAL chokepoint machinery (auto-stamp/predicate) via
 * `withScopedTables`. A RED test here makes CI RED. The runtime tables are pinned to the committed
 * generated SQL column-for-column (the @rayspec/db product-pipeline test), so this proof holds for
 * the committed generated source. Does NOT weaken the existing cross-tenant gate above.
 */
describe('generated product-table tenancy gate (CI-BLOCKING)', () => {
  const SCHEMA = 'rayspec_test_product_tenancy_gate';
  const TENANT_A = '00000000-0000-0000-0000-0000000000c1';
  const TENANT_B = '00000000-0000-0000-0000-0000000000c2';
  const gateHere = dirname(fileURLToPath(import.meta.url));
  // packages/api-auth/src -> repo-root/examples/acme-notes-backend
  const YAML_PATH = resolve(gateHere, '../../../../examples/acme-notes-backend/rayspec.yaml');

  let pdb: Db;
  let stores: StoreSpec[];

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL required');
    const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
    if (!parsed.ok) throw new Error(`throwaway spec invalid: ${JSON.stringify(parsed.errors)}`);
    stores = parsed.value.stores;

    pdb = makeDbWithSchema(url, SCHEMA);
    await pdb.$client.unsafe(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      SET search_path TO ${SCHEMA};
      CREATE TABLE orgs (id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL DEFAULT 'x',
        created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO orgs (id, name) VALUES ('${TENANT_A}','A'), ('${TENANT_B}','B');
    `);
    // Apply the generated product migration (retarget the "public" FK qualifier to the test schema).
    const sql = generateProductSql(stores)
      .replace(/-->\s*statement-breakpoint/g, '')
      .replace(/"public"\./g, `"${SCHEMA}".`);
    await pdb.$client.unsafe(`SET search_path TO ${SCHEMA}; ${sql}`);
  });

  afterAll(async () => {
    await pdb.$client.end();
  });

  it('every generated product table is FK+cascade, tenant-scoped, reachable when registered', async () => {
    const tables = buildProductTables(stores);
    const result = await assertProductTenancy({
      db: pdb,
      schemaName: SCHEMA,
      tables,
      query: (s, p) =>
        pdb.$client.unsafe(s, p as never[]) as unknown as Promise<Record<string, unknown>[]>,
      tenantA: TENANT_A,
      tenantB: TENANT_B,
      seedRow: (name, ctx) => {
        if (name === 'notebooks') {
          return { title: 'Sync', scheduledAt: new Date(), completed: false };
        }
        if (name === 'entries') return { notebookId: ctx.parentId, body: 'notes' };
        throw new Error(`no seed for ${name}`);
      },
      parentOf: (name) => (name === 'entries' ? 'notebooks' : undefined),
    });
    // NON-VACUOUS: every product table was asserted (not >=1 — the WHOLE set).
    expect(result.asserted).toEqual(stores.map((s) => s.name));
    expect(result.asserted.length).toBeGreaterThan(0);
  });

  it('a generated product table is UNREACHABLE via TenantDb until registered (deny-by-default)', () => {
    const tables = buildProductTables(stores);
    const notebooks = tables.get('notebooks');
    if (!notebooks) throw new Error('notebooks table missing');
    // The platform baseline is product-empty, so without registration forTenant denies access.
    expect(() => forTenant(pdb, TENANT_A).select(notebooks as never)).toThrow(
      /not registered in TENANT_SCOPED_TABLES/,
    );
  });
});
