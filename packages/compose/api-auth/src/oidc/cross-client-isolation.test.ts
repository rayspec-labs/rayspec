/**
 * Cross-client OIDC isolation smoke (pulled forward into — High finding).
 *
 * The oidc-provider model store is GLOBAL / predicate-exempt (the largest such surface), so it
 * needs an EXPLICIT isolation test where it is introduced. This drives the REAL mounted provider
 * (Drizzle adapter over Postgres) with TWO clients on TWO different orgs and asserts:
 *   1. each client_credentials grant succeeds and yields a token bound to its OWN client;
 *   2. a token issued for client A is attributed to client A ONLY (the client_id claim) and client
 *      B cannot use client A's client_id+secret.
 *
 * SCOPE (honest): client_credentials with accessTokenFormat 'jwt' yields STATELESS RFC-9068 tokens
 * that are NOT persisted in the adapter, so THIS file asserts isolation at the token-CLAIM level.
 * The PERSISTED store-row isolation (AuthorizationCode/Grant/RefreshToken rows partitioned by
 * client + grant, and revokeByGrantId grant-partitioning) is proven in the full-surface gate —
 * see `cross-tenant-gate.test.ts` › "OIDC store cross-tenant/client isolation". does NOT ship
 * OIDC client_credentials ORG-binding (no org_id stamped onto the token; an OIDC token cannot
 * authenticate a /v1 endpoint); the live M2M path in is the api-key `m2m_client`. OIDC
 * org-binding / consumption-by-/v1 is DEFERRED.
 */
import { createServer, type Server } from 'node:http';
import { serve } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Db } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../app-context.js';
import { mountOidc } from './mount.js';
import { createOidcProvider } from './provider.js';

const SCHEMA = 'rayspec_test_oidc_iso';
let server: Server;
let base: string;
let db: Db;

const CLIENT_A = { client_id: 'client-a', client_secret: 'secret-a', orgId: 'org-a' };
const CLIENT_B = { client_id: 'client-b', client_secret: 'secret-b', orgId: 'org-b' };

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  db = makeDbWithSchema(url, SCHEMA);
  await db.$client.unsafe(`
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
  base = `http://127.0.0.1:${port}`;

  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(privateKey);

  const provider = createOidcProvider({
    issuer: `${base}/oidc`,
    db,
    jwks: { keys: [{ ...jwk, use: 'sig', alg: 'RS256' }] },
    proxy: true,
    clients: [
      {
        client_id: CLIENT_A.client_id,
        client_secret: CLIENT_A.client_secret,
        grant_types: ['client_credentials'],
        response_types: [],
        redirect_uris: [],
        token_endpoint_auth_method: 'client_secret_basic',
        // Bind this client to org A (the org/scope binding the store isolates by).
        // biome-ignore lint/suspicious/noExplicitAny: provider client extra metadata.
        ...({ orgId: CLIENT_A.orgId } as any),
      },
      {
        client_id: CLIENT_B.client_id,
        client_secret: CLIENT_B.client_secret,
        grant_types: ['client_credentials'],
        response_types: [],
        redirect_uris: [],
        token_endpoint_auth_method: 'client_secret_basic',
        // biome-ignore lint/suspicious/noExplicitAny: provider client extra metadata.
        ...({ orgId: CLIENT_B.orgId } as any),
      },
    ],
  });

  const app = new OpenAPIHono<AppEnv>();
  app.route('/oidc', mountOidc(provider));
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.$client.end();
});

async function clientCredentials(client: { client_id: string; client_secret: string }) {
  const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
  return fetch(`${base}/oidc/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
}

describe('cross-client OIDC isolation', () => {
  it('each client_credentials grant succeeds for its own client', async () => {
    const a = await clientCredentials(CLIENT_A);
    expect(a.status).toBe(200);
    const at = (await a.json()) as { access_token: string };
    expect(at.access_token).toBeTruthy();

    const b = await clientCredentials(CLIENT_B);
    expect(b.status).toBe(200);
    const bt = (await b.json()) as { access_token: string };
    expect(bt.access_token).toBeTruthy();
    expect(bt.access_token).not.toBe(at.access_token);
  });

  it('client B cannot authenticate with client A’s id + B’s secret (or vice versa)', async () => {
    const crossed = await clientCredentials({
      client_id: CLIENT_A.client_id,
      client_secret: CLIENT_B.client_secret,
    });
    expect(crossed.status).toBe(401);
  });

  it('each issued token is attributed to its OWN client (client_id claim), never the other', async () => {
    // With resourceIndicators + accessTokenFormat 'jwt' the access tokens are STATELESS RFC-9068
    // JWTs (not persisted in the adapter), so isolation is carried in the token's own client_id
    // claim. (The full-surface matrix exercises the PERSISTED authorization_code/grant
    // store rows, which ARE written to oidc_models.) Decode each token and assert attribution.
    const aTok = (await (await clientCredentials(CLIENT_A)).json()) as { access_token: string };
    const bTok = (await (await clientCredentials(CLIENT_B)).json()) as { access_token: string };
    const aClaims = decodeJwt(aTok.access_token);
    const bClaims = decodeJwt(bTok.access_token);
    expect(aClaims.client_id).toBe(CLIENT_A.client_id);
    expect(bClaims.client_id).toBe(CLIENT_B.client_id);
    // A's token is NOT attributed to B and vice versa.
    expect(aClaims.client_id).not.toBe(CLIENT_B.client_id);
    expect(bClaims.client_id).not.toBe(CLIENT_A.client_id);
  });
});
