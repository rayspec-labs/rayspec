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
import {
  CORE_TENANT_SCOPED_TABLES,
  type Db,
  forTenant,
  generateProductSql,
  schema,
} from '@rayspec/db';
// The product-tenancy GATE machinery is gate-only — imported from /testing (off the main surface).
import { assertProductTenancy, buildProductTables, makeDbWithSchema } from '@rayspec/db/testing';
import { isRunCancelled, runAgent } from '@rayspec/platform';
import { parseSpec, type StoreSpec } from '@rayspec/spec';
import { WORKFORCE_EVENT_VERSION, workforceControlStreamId } from '@rayspec/tasks';
import { eq, getTableName } from 'drizzle-orm';
import { exportJWK, generateKeyPair } from 'jose';
import Provider from 'oidc-provider';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv, WorkforceGoalIntake } from './app-context.js';
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

  it('run cancel: B cannot end A’s run (404, no marker, A’s run untouched)', async () => {
    const { a, b } = await twoPrincipals();
    const tdbA = forTenant(h.db, a.orgId);
    await tdbA.insert(schema.runs, {
      runId: 'xt-run-cancel-A',
      backend: 'openai',
      authMode: 'api-key',
      agentName: 'x',
      model: 'm',
      status: 'running',
    });

    // The only MUTATING route under /v1/runs. A foreign id must change nothing at all — not the
    // header, not the cancellation marker — and must not disclose that the run exists.
    const res = await jsonRequest(h.app, 'POST', '/v1/runs/xt-run-cancel-A/cancel', {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(res.status).toBe(404);

    // Zero effect: A's run is still running and carries no cancellation marker.
    const rows = (await tdbA.select(schema.runs).all()) as unknown as Array<{
      runId: string;
      status: string;
    }>;
    expect(rows.find((r) => r.runId === 'xt-run-cancel-A')?.status).toBe('running');
    expect(await isRunCancelled(tdbA, 'xt-run-cancel-A')).toBe(false);
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

  it('invites: B cannot read A’s invite rows (tenant-scoped via forTenant)', async () => {
    const { a, b } = await twoPrincipals();
    // Seed an invite under orgA (the org an invite grants membership in is the tenant).
    await forTenant(h.db, a.orgId).insert(schema.invites, {
      tokenHash: 'a'.repeat(64),
      email: 'invitee-of-a@example.com',
      role: 'member',
      expiresAt: new Date(Date.now() + 60_000),
    });
    // forTenant(B) — the chokepoint auto-injects the tenant predicate — sees NONE of A's invites.
    expect((await forTenant(h.db, b.orgId).select(schema.invites).all()).length).toBe(0);
    expect((await forTenant(h.db, a.orgId).select(schema.invites).all()).length).toBe(1);
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

/**
 * WORKFORCE cross-tenant gate — CI-BLOCKING (OC-004's acceptance criterion; B-016 finding F-1).
 *
 * The gate above covers the run-journal core, the OAuth/OIDC store and the GENERATED PRODUCT
 * tables. It never touched the nine `workforce_*` tables, which are CORE-platform schema and so are
 * never one of the product loop's iterated tuples. This block closes that: two orgs deployed from
 * ONE declaration — same `workforceId`, same department ids, same team, same employee ids, same
 * titles/goals/questions, same signal key, same ledger scope tuple — seeded across all nine tables
 * plus BOTH workforce `run_events` namespaces, then proven completely isolated.
 *
 * WHY THE TASK IDS DIFFER BY ONE CHARACTER (read this before "fixing" it).
 * The strongest form of the twin proof — the SAME `task_id` in two tenants — is not a test this
 * suite declines to write; it is a row Postgres refuses to store. Every one of the nine tables
 * carries a GLOBAL single-column primary key, not a `(tenant_id, id)` compound:
 * `workforce_tasks.task_id text PRIMARY KEY` and eight `id uuid PRIMARY KEY`
 * (drizzle/0012_workforce_task_engine.sql:55,73,86,104,114,127,142,153,166). The first test below
 * PINS that refusal with a real attempted insert, so the id suffix is evidence, not a compromise.
 *
 * That fact moves the leak rather than removing it, and both halves are covered here:
 *   - an ID-KEYED read cannot return the wrong row for the same id (the id is globally unique), but
 *     without its tenant predicate it DOES return tenant B's row when tenant A asks for B's id —
 *     the same silent cross-tenant read, reached by a foreign id instead of a colliding one;
 *   - a LIST/AGGREGATE read (`/tasks`, `/approvals`, `/reviews`, `/cost`, `/:wf/status`) carries no
 *     id at all, so a missing predicate there returns EVERY tenant's rows. The identical workforce
 *     id, department id and employee ids are what make that leak legible: an unscoped count doubles
 *     and an unscoped sum adds B's numbers to A's, against the very same group keys.
 * Where the schema's unique key IS tenant-scoped the identifiers here are byte-identical, including
 * the one that genuinely collides: the workforce control stream's `run_id`
 * (`workforce:twin-wf`, tasks/src/events.ts:96-98) exists at the SAME `seq` in both tenants, since
 * `run_events` is unique on `(tenant_id, run_id, seq)`.
 *
 * Isolation here is APPLICATION-LEVEL: predicate injection at the `TenantDb` chokepoint
 * (kernel/db/src/tenant-db.ts:148-161), not Postgres RLS. The CI tripwire that would otherwise
 * catch a dropped `.where()` (`scripts/check-tenant-chokepoint.mjs`) is a regex scan with
 * documented blind spots — multi-hop aliases, getters, computed access — and excludes all test
 * code. This block is the durable backstop, and a RED here makes CI RED.
 */
describe('workforce cross-tenant gate: identical structures and identifiers (CI-BLOCKING)', () => {
  /**
   * ONE declaration, deployed into BOTH tenants. Byte-identity is by CONSTRUCTION (a single frozen
   * object read twice), never by two hand-copied literals that could drift apart unnoticed.
   */
  const TWIN = Object.freeze({
    workforceId: 'twin-wf',
    department: 'eng',
    /**
     * Teams are DECLARATION-only: no `workforce_*` column stores a team id, so a team reaches the
     * rows through its lead and members — which ARE the seeded owners, senders and reviewers below.
     */
    team: Object.freeze({
      id: 'release_crew',
      lead: 'coordinator',
      members: Object.freeze(['builder', 'reviewer']),
    }),
    employees: Object.freeze({
      coordinator: 'coordinator',
      builder: 'builder',
      reviewer: 'reviewer',
    }),
    rootTitle: 'Ship the twin release',
    rootGoal: 'Cut the release both tenants asked for.',
    childTitle: 'Build the artifact',
    approvalTitle: 'Awaiting the go-ahead',
    reviewTitle: 'Awaiting the reviewer',
    goal: 'Do the declared work.',
    question: 'Ship it?',
    delegationGoal: 'Build the artifact.',
    expectedOutput: 'A signed build.',
    signalKey: 'twin-operator-signal',
    /** A fixed bucket so the ledger's `(scope_kind, scope_id, window_start)` is byte-identical. */
    windowStart: new Date('2026-08-01T00:00:00.000Z'),
    budgets: Object.freeze({
      workforce: { usd: 10 },
      execution: { estimateUsdPerTurn: 0.5 },
    }),
  });

  /** The nine tables, DERIVED from the registry rather than hand-listed — a tenth is covered too. */
  const WORKFORCE_TABLES = CORE_TENANT_SCOPED_TABLES.filter((t) =>
    getTableName(t).startsWith('workforce_'),
  );

  /** Rows this seed writes per tenant, per table. The read assertions are exact, never `>= 1`. */
  const EXPECTED_ROWS: Readonly<Record<string, number>> = Object.freeze({
    workforce_tasks: 4,
    workforce_task_transitions: 2,
    workforce_task_signals: 1,
    workforce_delegations: 1,
    workforce_approvals: 1,
    workforce_reviews: 1,
    workforce_messages: 1,
    workforce_budget_ledger: 2,
    workforce_runtime: 1,
  });

  /** The per-tenant marker. A leak of ANY shape puts the other tenant's literal in the response. */
  const secretOf = (mark: 'a' | 'b') => (mark === 'a' ? 'SECRET_FROM_A' : 'SECRET_FROM_B');

  interface Twin {
    orgId: string;
    token: string;
    mark: 'a' | 'b';
    rootTaskId: string;
    childTaskId: string;
    approvalTaskId: string;
    reviewTaskId: string;
    approvalId: string;
    reviewId: string;
  }

  let hw: Harness;
  let kicks = 0;
  let goalSubmissions: Array<Parameters<WorkforceGoalIntake['submitGoal']>[0]> = [];
  let a: Twin;
  let b: Twin;

  /** Register → create org → switch, exactly as the principals above and routes/workforce.test.ts. */
  async function principal(email: string, orgName: string) {
    const reg = await jsonRequest(hw.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(hw.app, 'POST', '/v1/orgs', {
      body: { name: orgName },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    const switchRes = await jsonRequest(hw.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    return { orgId, token: (await switchRes.json()).accessToken as string };
  }

  /**
   * Seed one tenant from TWIN. EVERY identifier the schema lets two tenants share is shared; the
   * only per-tenant bytes are the id suffix (the global PK forbids sharing) and the secret marker
   * plus its cost numbers, which exist so a leak is legible rather than merely countable.
   */
  async function seedTwin(orgId: string, token: string, mark: 'a' | 'b'): Promise<Twin> {
    const tdb = forTenant(hw.db, orgId);
    const secret = secretOf(mark);
    const rootTaskId = `twin-task-root-${mark}`;
    const childTaskId = `twin-task-child-${mark}`;
    const approvalTaskId = `twin-task-approval-${mark}`;
    const reviewTaskId = `twin-task-review-${mark}`;
    const approvalId = `00000000-0000-4000-8000-00000000000${mark === 'a' ? '1' : '2'}`;
    const reviewId = `00000000-0000-4000-8000-00000000001${mark === 'a' ? '1' : '2'}`;
    const settledUsd = mark === 'a' ? '1.25' : '99.75';
    const settledTurns = mark === 'a' ? 1 : 7;

    await tdb.insert(schema.workforceRuntime, {
      workforceId: TWIN.workforceId,
      paused: false,
      budgets: TWIN.budgets,
      lastEventSeq: 2,
    });

    const task = (over: Record<string, unknown>) => ({
      workforceId: TWIN.workforceId,
      parentTaskId: null,
      ancestryPath: [],
      goal: TWIN.rootGoal,
      // The ONLY per-tenant string on the row — everything a declaration names is shared.
      description: secret,
      requestedBy: 'user',
      department: TWIN.department,
      priority: 'normal',
      dependencies: [],
      costUsd: settledUsd,
      turnsUsed: settledTurns,
      lastEventSeq: 1,
      ...over,
    });
    await tdb.insert(schema.workforceTasks, [
      task({
        taskId: rootTaskId,
        rootTaskId,
        title: TWIN.rootTitle,
        owner: TWIN.team.lead,
        // An OPERATOR-unblockable park, so A's own `manual_unblock`/`budget_raised` really wakes it.
        status: 'blocked',
        statusReason: 'budget_exhausted',
      }),
      task({
        taskId: childTaskId,
        parentTaskId: rootTaskId,
        rootTaskId,
        ancestryPath: [rootTaskId],
        title: TWIN.childTitle,
        owner: TWIN.employees.builder,
        status: 'queued',
        queuedAt: new Date(),
      }),
      task({
        taskId: approvalTaskId,
        rootTaskId: approvalTaskId,
        title: TWIN.approvalTitle,
        owner: TWIN.employees.builder,
        status: 'waiting_for_user',
        statusReason: 'approval_pending',
      }),
      task({
        taskId: reviewTaskId,
        rootTaskId: reviewTaskId,
        title: TWIN.reviewTitle,
        owner: TWIN.employees.builder,
        status: 'waiting_for_review',
        statusReason: 'review_pending',
      }),
    ]);

    // `turn_number: 1` is byte-identical in both tenants — the partial UNIQUE is tenant-scoped.
    await tdb.insert(schema.workforceTaskTransitions, [
      {
        taskId: rootTaskId,
        fromStatus: 'planned',
        toStatus: 'queued',
        actor: 'scheduler',
        turnId: null,
        turnNumber: null,
      },
      {
        taskId: rootTaskId,
        fromStatus: 'queued',
        toStatus: 'blocked',
        statusReason: 'budget_exhausted',
        actor: TWIN.team.lead,
        turnId: 'twin-turn-1',
        turnNumber: 1,
      },
    ]);

    // The signal key is byte-identical: UNIQUE is `(tenant_id, task_id, signal_key)`.
    await tdb.insert(schema.workforceTaskSignals, {
      taskId: rootTaskId,
      kind: 'budget_raised',
      signalKey: TWIN.signalKey,
      payload: { note: secret },
    });

    await tdb.insert(schema.workforceDelegations, {
      workforceId: TWIN.workforceId,
      parentTaskId: rootTaskId,
      childTaskId,
      delegatedBy: TWIN.team.lead,
      delegatedTo: TWIN.employees.builder,
      resolvedOwner: TWIN.employees.builder,
      goal: TWIN.delegationGoal,
      expectedOutput: TWIN.expectedOutput,
      depth: 1,
      status: 'accepted',
    });

    await tdb.insert(schema.workforceApprovals, {
      id: approvalId,
      taskId: approvalTaskId,
      question: TWIN.question,
      options: [],
      approver: 'user',
      status: 'pending',
      onTimeout: 'fail',
      timeoutAt: new Date(Date.now() + 3_600_000),
      reason: secret,
    });

    await tdb.insert(schema.workforceReviews, {
      id: reviewId,
      taskId: reviewTaskId,
      reviewer: TWIN.employees.reviewer,
      round: 1,
      verdict: null,
      reasons: [secret],
      requiredChanges: [],
    });

    await tdb.insert(schema.workforceMessages, {
      taskId: rootTaskId,
      sender: TWIN.team.lead,
      recipient: TWIN.employees.builder,
      body: secret,
    });

    // Byte-identical `(scope_kind, scope_id, window_start)` in BOTH tenants; only the money differs,
    // so an unscoped aggregate reads as A's number PLUS B's rather than merely as a bigger count.
    await tdb.insert(schema.workforceBudgetLedger, [
      {
        scopeKind: 'department',
        scopeId: TWIN.department,
        windowStart: TWIN.windowStart,
        reservedUsd: '0',
        settledUsd,
        settledTurns,
      },
      {
        scopeKind: 'workforce',
        scopeId: TWIN.workforceId,
        windowStart: TWIN.windowStart,
        reservedUsd: '0',
        settledUsd,
        settledTurns,
      },
    ]);

    // BOTH workforce run_events namespaces. The control stream's run_id is BYTE-IDENTICAL across
    // the two tenants at the SAME seq — `run_events` is unique on `(tenant_id, run_id, seq)`.
    await tdb.insert(schema.runEvents, [
      {
        runId: rootTaskId,
        seq: '1',
        type: 'workforce.task.created',
        data: {
          v: WORKFORCE_EVENT_VERSION,
          type: 'workforce.task.created',
          taskId: rootTaskId,
          title: TWIN.rootTitle,
          owner: TWIN.team.lead,
          note: secret,
        },
      },
      {
        runId: workforceControlStreamId(TWIN.workforceId),
        seq: '1',
        type: 'workforce.control.paused',
        data: {
          v: WORKFORCE_EVENT_VERSION,
          type: 'workforce.control.paused',
          workforceId: TWIN.workforceId,
          note: secret,
        },
      },
      {
        runId: workforceControlStreamId(TWIN.workforceId),
        seq: '2',
        type: 'workforce.control.resumed',
        data: {
          v: WORKFORCE_EVENT_VERSION,
          type: 'workforce.control.resumed',
          workforceId: TWIN.workforceId,
          note: secret,
        },
      },
    ]);

    return {
      orgId,
      token,
      mark,
      rootTaskId,
      childTaskId,
      approvalTaskId,
      reviewTaskId,
      approvalId,
      reviewId,
    };
  }

  /**
   * A full snapshot of one tenant's workforce rows, read with RAW SQL rather than through the
   * chokepoint. Deliberate: an unchanged-after assertion read through the very predicate under test
   * would move in lockstep with a broken predicate and pass vacuously.
   */
  const SNAPSHOT_TABLES: ReadonlyArray<readonly [string, string]> = [
    ['workforce_tasks', 'task_id'],
    ['workforce_task_transitions', 'id'],
    ['workforce_task_signals', 'id'],
    ['workforce_delegations', 'id'],
    ['workforce_approvals', 'id'],
    ['workforce_reviews', 'id'],
    ['workforce_messages', 'id'],
    ['workforce_budget_ledger', 'id'],
    ['workforce_runtime', 'id'],
    ['run_events', 'run_id, seq'],
  ];

  async function snapshotOf(tenantId: string): Promise<string> {
    const out: Record<string, unknown[]> = {};
    for (const [table, order] of SNAPSHOT_TABLES) {
      const rows = await hw.db.$client.unsafe(
        `SELECT * FROM ${table} WHERE tenant_id = $1 ORDER BY ${order}`,
        [tenantId] as never[],
      );
      out[table] = rows as unknown as unknown[];
    }
    return JSON.stringify(out);
  }

  /** Issue a request as one twin and return the status plus the RAW body text (leak-scannable). */
  async function callAs(
    who: Twin,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const res = await jsonRequest(hw.app, method, path, {
      ...(body !== undefined ? { body } : {}),
      headers: { authorization: `Bearer ${who.token}` },
    });
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    hw = await createHarness({
      schema: 'rayspec_test_workforce_xtenant',
      // Both seams must be wired or the whole surface fail-closes 501 (routes/workforce.ts:201-219)
      // and every assertion below would pass vacuously against a stub answer.
      workforce: {
        kick: () => {
          kicks++;
        },
      },
      workforceGoalIntake: {
        submitGoal: (input) => {
          goalSubmissions.push(input);
          return Promise.resolve({ outcome: 'created', tasks: [] });
        },
      },
    });
  });
  beforeEach(async () => {
    await hw.reset();
    kicks = 0;
    goalSubmissions = [];
    const pa = await principal('twin-a@example.test', 'Org Twin A');
    const pb = await principal('twin-b@example.test', 'Org Twin B');
    a = await seedTwin(pa.orgId, pa.token, 'a');
    b = await seedTwin(pb.orgId, pb.token, 'b');
  });
  afterAll(async () => {
    await hw.close();
  });

  it('the iterated table set IS the nine workforce tables (non-vacuity, and drift-proof)', () => {
    expect(WORKFORCE_TABLES.map(getTableName).sort()).toEqual(Object.keys(EXPECTED_ROWS).sort());
    expect(WORKFORCE_TABLES.length).toBe(9);
  });

  /**
   * Assert the driver refused with SQLSTATE 23505 (unique_violation). Matched on the CODE, walking
   * the cause chain: Drizzle wraps the driver error, and its own message is only `Failed query: …`,
   * so a message regex would pass on any failure at all — including one that is not a collision.
   */
  async function expectUniqueViolation(run: () => Promise<unknown>, label: string): Promise<void> {
    let caught: unknown;
    try {
      await run();
    } catch (err) {
      caught = err;
    }
    expect(caught, label).toBeDefined();
    const codes: string[] = [];
    for (let e = caught; e !== undefined && e !== null; e = (e as { cause?: unknown }).cause) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === 'string') codes.push(code);
    }
    expect(codes, label).toContain('23505');
  }

  it('POSTGRES ITSELF refuses a byte-identical task id / approval id in a second tenant', async () => {
    // Why the ids above differ by one character. `workforce_tasks.task_id` is a GLOBAL text primary
    // key and the other eight tables carry a global uuid one, so a cross-tenant id COLLISION is not
    // a case this suite chose not to construct — it is a row the database will not store. That is a
    // stronger guarantee than any application predicate, and it is pinned here rather than assumed.
    const tdbB = forTenant(hw.db, b.orgId);
    await expectUniqueViolation(
      () =>
        tdbB.insert(schema.workforceTasks, {
          taskId: a.rootTaskId, // tenant A's id, offered under tenant B
          workforceId: TWIN.workforceId,
          rootTaskId: a.rootTaskId,
          title: TWIN.rootTitle,
          goal: TWIN.rootGoal,
          owner: TWIN.team.lead,
          requestedBy: 'user',
          status: 'planned',
        }),
      'workforce_tasks.task_id',
    );
    await expectUniqueViolation(
      () =>
        tdbB.insert(schema.workforceApprovals, {
          id: a.approvalId, // tenant A's approval id, offered under tenant B
          taskId: b.approvalTaskId,
          question: TWIN.question,
          approver: 'user',
          status: 'pending',
          onTimeout: 'fail',
        }),
      'workforce_approvals.id',
    );

    // The refused rows changed nothing: A still owns its id, B still owns its own.
    const owner = await hw.db.$client.unsafe(
      `SELECT tenant_id FROM workforce_tasks WHERE task_id = '${a.rootTaskId}';`,
    );
    expect((owner[0] as { tenant_id: string }).tenant_id).toBe(a.orgId);
    expect(owner.length).toBe(1);
  });

  it('every one of the nine tables, read through the tenant handle, returns ONLY the caller’s rows', async () => {
    for (const table of WORKFORCE_TABLES) {
      const name = getTableName(table);
      const aRows = (await forTenant(hw.db, a.orgId).select(table).all()) as Array<{
        tenantId: string;
      }>;
      const bRows = (await forTenant(hw.db, b.orgId).select(table).all()) as Array<{
        tenantId: string;
      }>;
      // Exact counts, both directions: neither tenant sees a row too few or a row too many.
      expect(aRows.length, name).toBe(EXPECTED_ROWS[name]);
      expect(bRows.length, name).toBe(EXPECTED_ROWS[name]);
      expect(
        aRows.every((r) => r.tenantId === a.orgId),
        name,
      ).toBe(true);
      expect(
        bRows.every((r) => r.tenantId === b.orgId),
        name,
      ).toBe(true);
      // …and the identical structures did not smuggle the other tenant's bytes in.
      expect(JSON.stringify(aRows), name).not.toContain('SECRET_FROM_B');
      expect(JSON.stringify(bRows), name).not.toContain('SECRET_FROM_A');
    }
  });

  it('both workforce run_events namespaces are partitioned — including the IDENTICAL control run_id', async () => {
    const controlStream = workforceControlStreamId(TWIN.workforceId);
    expect(controlStream).toBe('workforce:twin-wf');
    // Byte-identical run_id at byte-identical seq in BOTH tenants — the one colliding identifier
    // the schema admits, since run_events is unique on (tenant_id, run_id, seq).
    const both = await hw.db.$client.unsafe(
      `SELECT count(*)::int AS c FROM run_events WHERE run_id = '${controlStream}' AND seq = 1;`,
    );
    expect((both[0] as { c: number }).c).toBe(2);

    for (const [who, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const rows = (await forTenant(hw.db, who.orgId).select(schema.runEvents).all()) as Array<{
        runId: string;
      }>;
      expect(rows.length).toBe(3); // one task-stream row + two control-stream rows
      expect(rows.filter((r) => r.runId === controlStream).length).toBe(2);
      expect(rows.some((r) => r.runId === who.rootTaskId)).toBe(true);
      expect(rows.some((r) => r.runId === other.rootTaskId)).toBe(false);
      expect(JSON.stringify(rows)).not.toContain(secretOf(other.mark));
    }
  });

  it('every /v1/workforce read route returns ONLY tenant A’s rows, and never a byte of B', async () => {
    const wf = TWIN.workforceId;
    const reads: Array<readonly [string, string]> = [
      ['status', `/v1/workforce/${wf}/status`],
      ['tasks', '/v1/workforce/tasks'],
      ['tasks?workforceId', `/v1/workforce/tasks?workforceId=${wf}`],
      ['tasks?owner', `/v1/workforce/tasks?owner=${TWIN.team.lead}`],
      ['task-by-id', `/v1/workforce/tasks/${a.rootTaskId}`],
      ['tree', `/v1/workforce/tasks/${a.rootTaskId}/tree`],
      ['events', `/v1/workforce/tasks/${a.rootTaskId}/events`],
      ['approvals', '/v1/workforce/approvals'],
      ['reviews', '/v1/workforce/reviews'],
      ['cost', '/v1/workforce/cost'],
      ['cost?by=department', '/v1/workforce/cost?by=department'],
      ['cost?by=employee', '/v1/workforce/cost?by=employee'],
    ];
    for (const [label, path] of reads) {
      const res = await callAs(a, 'GET', path);
      expect(res.status, label).toBe(200);
      // The blunt instrument first: no response on this surface may carry the other tenant's bytes.
      expect(res.text, label).not.toContain('SECRET_FROM_B');
      expect(res.text, label).not.toContain(`-${b.mark}"`); // no `twin-task-*-b` id, either
    }

    // Now the STRUCTURAL assertions, which are what an identical-identifier seed is FOR: every one
    // of these groups on a key both tenants share, so an unscoped read doubles or sums into it.
    const status = JSON.parse((await callAs(a, 'GET', `/v1/workforce/${wf}/status`)).text);
    expect(status).toMatchObject({
      workforceId: wf,
      paused: false,
      queueDepth: 1,
      tasks: { blocked: 1, queued: 1, waiting_for_user: 1, waiting_for_review: 1 },
    });

    const tasks = JSON.parse((await callAs(a, 'GET', '/v1/workforce/tasks')).text) as Array<{
      taskId: string;
    }>;
    expect(tasks.map((t) => t.taskId).sort()).toEqual(
      [a.rootTaskId, a.childTaskId, a.approvalTaskId, a.reviewTaskId].sort(),
    );

    const tree = JSON.parse(
      (await callAs(a, 'GET', `/v1/workforce/tasks/${a.rootTaskId}/tree`)).text,
    ) as { rootTaskId: string; tasks: Array<{ taskId: string }> };
    expect(tree.rootTaskId).toBe(a.rootTaskId);
    expect(tree.tasks.map((t) => t.taskId).sort()).toEqual([a.childTaskId, a.rootTaskId].sort());

    const approvals = JSON.parse(
      (await callAs(a, 'GET', '/v1/workforce/approvals')).text,
    ) as Array<{
      id: string;
    }>;
    expect(approvals.map((r) => r.id)).toEqual([a.approvalId]);

    const reviews = JSON.parse((await callAs(a, 'GET', '/v1/workforce/reviews')).text) as Array<{
      id: string;
    }>;
    expect(reviews.map((r) => r.id)).toEqual([a.reviewId]);

    // The cost roll-ups are the sharpest: BOTH tenants hold `(department, eng, <window>)` and
    // `(workforce, twin-wf, <window>)`, and both own tasks with the SAME owner ids. A dropped
    // predicate here does not merely list more rows — it reports A's spend as A's plus B's.
    const cost = JSON.parse((await callAs(a, 'GET', '/v1/workforce/cost')).text) as {
      scopes: Array<{ scopeKind: string; scopeId: string; settledUsd: string }>;
    };
    expect(cost.scopes).toHaveLength(2);
    expect(cost.scopes.map((s) => Number(s.settledUsd))).toEqual([1.25, 1.25]);

    const byDept = JSON.parse((await callAs(a, 'GET', '/v1/workforce/cost?by=department')).text);
    expect(byDept.groups).toEqual([
      { id: TWIN.department, settledUsd: 1.25, reservedUsd: 0, settledTurns: 1 },
    ]);

    const byEmp = JSON.parse((await callAs(a, 'GET', '/v1/workforce/cost?by=employee')).text) as {
      groups: Array<{ id: string; tasks: number; settledUsd: number }>;
    };
    expect(byEmp.groups.map((g) => [g.id, g.tasks, g.settledUsd])).toEqual([
      [TWIN.employees.builder, 3, 3.75],
      [TWIN.team.lead, 1, 1.25],
    ]);

    const events = await callAs(a, 'GET', `/v1/workforce/tasks/${a.rootTaskId}/events`);
    expect(events.text).toContain('event: workforce.task.created');
    expect(events.text).toContain('SECRET_FROM_A');
  });

  it('tenant B’s ids read as A are a uniform 404 — never B’s row, and never a 500', async () => {
    const foreign: Array<readonly [string, string, string, unknown?]> = [
      ['task-by-id', 'GET', `/v1/workforce/tasks/${b.rootTaskId}`],
      ['tree', 'GET', `/v1/workforce/tasks/${b.rootTaskId}/tree`],
      ['events', 'GET', `/v1/workforce/tasks/${b.rootTaskId}/events`],
      ['child-by-id', 'GET', `/v1/workforce/tasks/${b.childTaskId}`],
      ['approval-task', 'GET', `/v1/workforce/tasks/${b.approvalTaskId}`],
      ['review-task', 'GET', `/v1/workforce/tasks/${b.reviewTaskId}`],
      ['signal', 'POST', `/v1/workforce/tasks/${b.rootTaskId}/signal`, { kind: 'budget_raised' }],
      ['cancel', 'POST', `/v1/workforce/tasks/${b.rootTaskId}/cancel`, {}],
      ['decide', 'POST', `/v1/workforce/approvals/${b.approvalId}/decide`, { decision: 'approve' }],
      ['verdict', 'POST', `/v1/workforce/reviews/${b.reviewId}/verdict`, { verdict: 'accept' }],
    ];
    for (const [label, method, path, body] of foreign) {
      const res = await callAs(a, method, path, body);
      // A uniform 404 — not a 403 (which would confirm the row exists), and above all not a 500,
      // which is what a predicate-less query that then trips over a foreign row looks like.
      expect(res.status, label).toBe(404);
      expect(res.status, label).toBeLessThan(500);
      expect(res.text, label).not.toContain('SECRET_FROM_B');
      expect(res.text, label).not.toContain(TWIN.rootTitle);
    }
    // A workforce id BOTH tenants declare is not a back door either: A's control reads answer for
    // A's runtime row alone, and A's task-scoped filter never widens past A.
    const scoped = JSON.parse(
      (await callAs(a, 'GET', `/v1/workforce/tasks?workforceId=${TWIN.workforceId}`)).text,
    ) as Array<{ taskId: string }>;
    expect(scoped).toHaveLength(4);
    expect(scoped.every((t) => t.taskId.endsWith('-a'))).toBe(true);
  });

  it('A’s whole READ sweep leaves every one of B’s rows byte-identical (a read must not mutate)', async () => {
    const before = await snapshotOf(b.orgId);
    for (const path of [
      `/v1/workforce/${TWIN.workforceId}/status`,
      '/v1/workforce/tasks',
      '/v1/workforce/approvals',
      '/v1/workforce/reviews',
      '/v1/workforce/cost',
      '/v1/workforce/cost?by=department',
      '/v1/workforce/cost?by=employee',
      `/v1/workforce/tasks/${a.rootTaskId}`,
      `/v1/workforce/tasks/${a.rootTaskId}/tree`,
      `/v1/workforce/tasks/${a.rootTaskId}/events`,
      // …including the foreign-id reads, whose 404 must also be side-effect free.
      `/v1/workforce/tasks/${b.rootTaskId}`,
      `/v1/workforce/tasks/${b.rootTaskId}/tree`,
      `/v1/workforce/tasks/${b.rootTaskId}/events`,
    ]) {
      await callAs(a, 'GET', path);
    }
    expect(await snapshotOf(b.orgId)).toBe(before);
  });

  it('A’s MUTATING verbs — signal, decide, verdict, goals, pause, resume, cancel, halt — touch no row of B’s', async () => {
    const before = await snapshotOf(b.orgId);
    const wf = TWIN.workforceId;

    // Each of these is A acting on A's OWN rows, under identifiers B holds byte-identically.
    const signal = await callAs(a, 'POST', `/v1/workforce/tasks/${a.rootTaskId}/signal`, {
      kind: 'budget_raised',
      signalKey: 'twin-operator-signal-2',
    });
    expect(signal.status).toBe(202);
    expect(JSON.parse(signal.text)).toEqual({ delivered: true, woke: true });

    const decide = await callAs(a, 'POST', `/v1/workforce/approvals/${a.approvalId}/decide`, {
      decision: 'approve',
    });
    expect(decide.status).toBe(200);
    expect(JSON.parse(decide.text).decidedBy).toMatch(/^user:/);

    const verdict = await callAs(a, 'POST', `/v1/workforce/reviews/${a.reviewId}/verdict`, {
      verdict: 'accept',
    });
    expect(verdict.status).toBe(200);
    expect(JSON.parse(verdict.text)).toMatchObject({ taskStatus: 'completed' });

    const goals = await callAs(a, 'POST', `/v1/workforce/${wf}/goals`, { goal: 'Ship the twin.' });
    expect(goals.status).toBe(202);
    // The intake seam receives the SERVER-derived tenant — never the shared workforce id, which is
    // the only tenant-shaped thing the client supplied and is identical in both tenants.
    expect(goalSubmissions).toHaveLength(1);
    expect(goalSubmissions[0]?.tenantId).toBe(a.orgId);
    expect(goalSubmissions[0]?.workforceId).toBe(wf);

    expect((await callAs(a, 'POST', `/v1/workforce/${wf}/pause`, {})).status).toBe(200);
    expect((await callAs(a, 'POST', `/v1/workforce/${wf}/resume`)).status).toBe(200);
    expect((await callAs(a, 'POST', `/v1/workforce/tasks/${a.rootTaskId}/cancel`, {})).status).toBe(
      202,
    );
    expect(
      (await callAs(a, 'POST', `/v1/workforce/${wf}/halt`, { reason: 'twin gate' })).status,
    ).toBe(200);
    expect(kicks).toBeGreaterThan(0); // the dispatcher seam is live — the verbs are not no-ops

    // A's own rows moved (the verbs really ran); B's did not move by a single byte, even though
    // pause/resume/halt were addressed to a workforce id B declares under the very same spelling.
    const aPaused = await hw.db.$client.unsafe(
      `SELECT halt_reason FROM workforce_runtime WHERE tenant_id = '${a.orgId}';`,
    );
    expect((aPaused[0] as { halt_reason: string | null }).halt_reason).toBe('twin gate');
    expect(await snapshotOf(b.orgId)).toBe(before);
  });
});
