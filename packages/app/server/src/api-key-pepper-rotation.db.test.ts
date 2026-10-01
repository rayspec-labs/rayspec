/**
 * Rotating the API-key pepper, and resetting it.
 *
 * `RAYSPEC_API_KEY_PEPPER` keys the HMAC of three stored credentials: API keys, refresh sessions and
 * invite tokens. With the old pepper in `RAYSPEC_API_KEY_PEPPER_PREVIOUS` they keep verifying for an
 * overlap window and are renewed under the new pepper when they are used: an API key is re-hashed, a
 * session is replaced when it is refreshed, an invite is redeemed. Once the previous pepper is gone,
 * whatever was renewed keeps working and whatever was not is refused — which is also exactly what a
 * reset (a new pepper with no previous one, for a pepper that leaked) does to every credential.
 * Passwords never touch the pepper, so every user signs in again with the same password.
 *
 * DB ISOLATION: the suite creates and drops its own throwaway database.
 */
import { hashApiKey } from '@rayspec/auth-core';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const SUITE_DB = `rayspec_server_pepperrotation_${process.pid}`;
const REFRESH_COOKIE = '__Host-rayspec_refresh';
const OLD_PEPPER = 'old-pepper-of-the-rotation-suite-0123456789';
const NEW_PEPPER = 'new-pepper-of-the-rotation-suite-9876543210';
const PASSWORD = 'correct horse battery staple';

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe('rotating and resetting the API-key pepper', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  if (requireDb && !baseUrl) {
    throw new Error(
      'api-key-pepper-rotation.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
        'but absent — refusing to silently skip this DB-backed suite.',
    );
  }

  const ENV_KEYS = [
    'DATABASE_URL',
    'DATABASE_URL_FILE',
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_JWT_SIGNING_KEY_FILE',
    'RAYSPEC_JWT_SIGNING_KEY_PREVIOUS',
    'RAYSPEC_API_KEY_PEPPER',
    'RAYSPEC_API_KEY_PEPPER_FILE',
    'RAYSPEC_API_KEY_PEPPER_PREVIOUS',
    'RAYSPEC_API_KEY_PEPPER_PREVIOUS_FILE',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_SINGLE_TENANT',
    'ALLOWED_ORIGINS',
    'PORT',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let sql: ReturnType<typeof postgres> | undefined;

  /** What the old pepper issued, and what was renewed during the window. */
  const issued = {
    orgId: '',
    usedKey: '',
    unusedKey: '',
    refreshedSession: '',
    idleSession: '',
    redeemedInvite: '',
    idleInvite: '',
  };

  beforeAll(async () => {
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DATABASE_URL = withDbName(baseUrl, SUITE_DB);
    process.env.RAYSPEC_JWT_SIGNING_KEY = (
      await exportPKCS8((await generateKeyPair('RS256', { extractable: true })).privateKey)
    ).trim();
    process.env.PORT = '8797';
    sql = postgres(withDbName(baseUrl, SUITE_DB), { max: 1 });
  });

  afterAll(async () => {
    await sql?.end();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  async function boot(pepper: string, previous?: string): Promise<BootedServer> {
    process.env.RAYSPEC_API_KEY_PEPPER = pepper;
    if (previous === undefined) delete process.env.RAYSPEC_API_KEY_PEPPER_PREVIOUS;
    else process.env.RAYSPEC_API_KEY_PEPPER_PREVIOUS = previous;
    return assembleServer(loadServerConfig());
  }

  function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    };
  }

  function refreshCookieOf(res: Response): string {
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${REFRESH_COOKIE}=`))
      ?.slice(REFRESH_COOKIE.length + 1)
      .split(';')[0];
    if (cookie === undefined) throw new Error('no refresh cookie');
    return cookie;
  }

  async function refresh(server: BootedServer, secret: string): Promise<Response> {
    return server.app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { cookie: `${REFRESH_COOKIE}=${secret}`, 'sec-fetch-site': 'same-origin' },
    });
  }

  async function listKeys(server: BootedServer, key: string): Promise<number> {
    const res = await server.app.request(`/v1/orgs/${issued.orgId}/api-keys`, {
      headers: { authorization: `Bearer ${key}` },
    });
    return res.status;
  }

  async function storedHashOf(key: string): Promise<string> {
    const prefix = key.slice(0, key.indexOf('.'));
    const rows = (await sql!`SELECT key_hash FROM api_keys WHERE key_prefix = ${prefix}`) as {
      key_hash: string;
    }[];
    return rows[0]?.key_hash ?? '';
  }

  async function accept(server: BootedServer, token: string): Promise<number> {
    const res = await server.app.request('/v1/invites/accept', json({ token, password: PASSWORD }));
    return res.status;
  }

  maybe('under the old pepper: keys, sessions and invites are issued', async () => {
    const server = await boot(OLD_PEPPER);
    try {
      const reg = await server.app.request(
        '/v1/auth/register',
        json({ email: 'owner@example.com', password: PASSWORD, orgName: 'Rotation' }),
      );
      expect(reg.status).toBe(201);
      const body = (await reg.json()) as { accessToken: string; activeOrgId: string };
      issued.orgId = body.activeOrgId;
      issued.refreshedSession = refreshCookieOf(reg);
      const login = await server.app.request(
        '/v1/auth/login',
        json({ email: 'owner@example.com', password: PASSWORD }),
      );
      expect(login.status).toBe(200);
      issued.idleSession = refreshCookieOf(login);

      const bearer = { authorization: `Bearer ${body.accessToken}` };
      for (const which of ['usedKey', 'unusedKey'] as const) {
        const minted = await server.app.request(
          `/v1/orgs/${issued.orgId}/api-keys`,
          json({ scopes: ['apikey:read'] }, bearer),
        );
        expect(minted.status).toBe(201);
        issued[which] = ((await minted.json()) as { plaintext: string }).plaintext;
      }
      for (const [which, email] of [
        ['redeemedInvite', 'joiner@example.com'],
        ['idleInvite', 'late@example.com'],
      ] as const) {
        const invite = await server.app.request(
          `/v1/orgs/${issued.orgId}/invites`,
          json({ email, role: 'member' }, bearer),
        );
        expect(invite.status).toBe(201);
        issued[which] = ((await invite.json()) as { inviteToken: string }).inviteToken;
      }
      expect(await listKeys(server, issued.usedKey)).toBe(200);
      expect(await storedHashOf(issued.usedKey)).toBe(
        hashApiKey(issued.usedKey.slice(issued.usedKey.indexOf('.') + 1), OLD_PEPPER),
      );
    } finally {
      await server.close();
    }
  });

  maybe(
    'during the window: each still verifies, and use renews it under the new pepper',
    async () => {
      const server = await boot(NEW_PEPPER, OLD_PEPPER);
      try {
        // The API key verifies and is re-hashed under the new pepper by that use.
        expect(await listKeys(server, issued.usedKey)).toBe(200);
        const secret = issued.usedKey.slice(issued.usedKey.indexOf('.') + 1);
        expect(await storedHashOf(issued.usedKey)).toBe(hashApiKey(secret, NEW_PEPPER));
        // The session refreshes, which replaces it by one hashed under the new pepper.
        const refreshed = await refresh(server, issued.refreshedSession);
        expect(refreshed.status).toBe(200);
        issued.refreshedSession = refreshCookieOf(refreshed);
        // The invite redeems.
        expect(await accept(server, issued.redeemedInvite)).toBe(201);
        // New credentials are hashed under the new pepper only.
        expect(
          (
            await server.app.request(
              '/v1/auth/login',
              json({ email: 'joiner@example.com', password: PASSWORD }),
            )
          ).status,
        ).toBe(200);
      } finally {
        await server.close();
      }
    },
  );

  maybe('after the window: what was renewed works, what was not is refused', async () => {
    const server = await boot(NEW_PEPPER);
    try {
      expect(await listKeys(server, issued.usedKey)).toBe(200);
      expect(await listKeys(server, issued.unusedKey)).toBe(401);
      expect((await refresh(server, issued.refreshedSession)).status).toBe(200);
      expect((await refresh(server, issued.idleSession)).status).toBe(401);
      expect(await accept(server, issued.idleInvite)).toBe(400);
      // Passwords never touch the pepper: everyone signs in again.
      const login = await server.app.request(
        '/v1/auth/login',
        json({ email: 'owner@example.com', password: PASSWORD }),
      );
      expect(login.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  maybe(
    'a reset (a new pepper with no previous one) refuses every credential of the old one',
    async () => {
      const leaked = 'pepper-that-leaked-and-is-reset-0000000000';
      const issuedUnder = await boot(leaked);
      let key = '';
      let session = '';
      try {
        const login = await issuedUnder.app.request(
          '/v1/auth/login',
          json({ email: 'owner@example.com', password: PASSWORD }),
        );
        session = refreshCookieOf(login);
        const access = ((await login.clone().json()) as { accessToken: string }).accessToken;
        const switched = await issuedUnder.app.request(`/v1/orgs/${issued.orgId}/switch`, {
          method: 'POST',
          headers: { authorization: `Bearer ${access}` },
        });
        const scoped = ((await switched.json()) as { accessToken: string }).accessToken;
        const minted = await issuedUnder.app.request(
          `/v1/orgs/${issued.orgId}/api-keys`,
          json({ scopes: ['apikey:read'] }, { authorization: `Bearer ${scoped}` }),
        );
        expect(minted.status).toBe(201);
        key = ((await minted.json()) as { plaintext: string }).plaintext;
        expect(await listKeys(issuedUnder, key)).toBe(200);
      } finally {
        await issuedUnder.close();
      }
      const reset = await boot(NEW_PEPPER);
      try {
        expect(await listKeys(reset, key)).toBe(401);
        expect((await refresh(reset, session)).status).toBe(401);
        expect(
          (
            await reset.app.request(
              '/v1/auth/login',
              json({ email: 'owner@example.com', password: PASSWORD }),
            )
          ).status,
        ).toBe(200);
      } finally {
        await reset.close();
      }
    },
  );
});
