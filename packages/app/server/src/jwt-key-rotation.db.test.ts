/**
 * Rotating the JWT signing key with an overlap window: `RAYSPEC_JWT_SIGNING_KEY_PREVIOUS` keeps the key
 * in use before the rotation in both key sets (the first-party JWKS and the OIDC provider's), so an
 * access token signed before the rotation keeps verifying until it expires, while every new token is
 * signed with the new key. Without the previous key the old token is refused: that arm is what shows
 * the overlap is the variable's doing.
 *
 * DB ISOLATION: the suite creates and drops its own throwaway database (the sibling boot suites'
 * pattern).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

const SUITE_DB = `rayspec_server_jwtrotation_${process.pid}`;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe('rotating the JWT signing key keeps tokens signed before the rotation valid', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  if (requireDb && !baseUrl) {
    throw new Error(
      'jwt-key-rotation.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
        'absent — refusing to silently skip this DB-backed suite.',
    );
  }

  const ENV_KEYS = [
    'DATABASE_URL',
    'DATABASE_URL_FILE',
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_JWT_SIGNING_KEY_FILE',
    'RAYSPEC_JWT_SIGNING_KEY_PREVIOUS',
    'RAYSPEC_JWT_SIGNING_KEY_PREVIOUS_FILE',
    'RAYSPEC_API_KEY_PEPPER',
    'RAYSPEC_API_KEY_PEPPER_FILE',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_SINGLE_TENANT',
    'ALLOWED_ORIGINS',
    'PORT',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let dir = '';
  let oldKey = '';
  let newKey = '';
  let oldToken = '';

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
    process.env.RAYSPEC_API_KEY_PEPPER = 'pepper-for-the-key-rotation-suite';
    process.env.PORT = '8798';
    oldKey = (
      await exportPKCS8((await generateKeyPair('RS256', { extractable: true })).privateKey)
    ).trim();
    newKey = (
      await exportPKCS8((await generateKeyPair('RS256', { extractable: true })).privateKey)
    ).trim();
    dir = mkdtempSync(join(tmpdir(), 'rayspec-jwt-rotation-'));
  });

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  async function boot(current: string, previous?: { value?: string; file?: string }) {
    process.env.RAYSPEC_JWT_SIGNING_KEY = current;
    delete process.env.RAYSPEC_JWT_SIGNING_KEY_PREVIOUS;
    delete process.env.RAYSPEC_JWT_SIGNING_KEY_PREVIOUS_FILE;
    if (previous?.value !== undefined)
      process.env.RAYSPEC_JWT_SIGNING_KEY_PREVIOUS = previous.value;
    if (previous?.file !== undefined) {
      process.env.RAYSPEC_JWT_SIGNING_KEY_PREVIOUS_FILE = previous.file;
    }
    return assembleServer(loadServerConfig());
  }

  async function me(server: BootedServer, token: string): Promise<number> {
    const res = await server.app.request('/v1/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    return res.status;
  }

  async function login(server: BootedServer): Promise<string> {
    const res = await server.app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'rotate@example.com', password: 'correct horse battery' }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { accessToken: string }).accessToken;
  }

  async function kids(server: BootedServer, path: string): Promise<string[]> {
    const res = await server.app.request(path);
    expect(res.status).toBe(200);
    return ((await res.json()) as { keys: { kid: string }[] }).keys.map((k) => k.kid);
  }

  /** The OIDC provider answers on the raw Node request, so it is asked over a real socket. */
  async function oidcKeyCount(server: BootedServer): Promise<number> {
    const http = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: server.app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
        resolve(s),
      );
    });
    try {
      const port = (http.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/oidc/jwks`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { keys: unknown[] }).keys.length;
    } finally {
      await new Promise((resolve) => http.close(() => resolve(null)));
    }
  }

  maybe('a token signed with the old key, before the rotation', async () => {
    const server = await boot(oldKey);
    try {
      const res = await server.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'rotate@example.com', password: 'correct horse battery' }),
      });
      expect(res.status).toBe(201);
      oldToken = ((await res.json()) as { accessToken: string }).accessToken;
      expect(await me(server, oldToken)).toBe(200);
      expect(await kids(server, '/v1/oauth/jwks')).toHaveLength(1);
      expect(await oidcKeyCount(server)).toBe(1);
    } finally {
      await server.close();
    }
  });

  maybe('verifies after the rotation while the old key is the previous one', async () => {
    const server = await boot(newKey, { value: oldKey });
    try {
      expect(await me(server, oldToken)).toBe(200);
      const newToken = await login(server);
      expect(await me(server, newToken)).toBe(200);
      // New tokens are signed with the new key only; both keys are published.
      const oldKid = decodeProtectedHeader(oldToken).kid;
      const newKid = decodeProtectedHeader(newToken).kid;
      expect(newKid).not.toBe(oldKid);
      expect(await kids(server, '/v1/oauth/jwks')).toEqual([newKid, oldKid]);
      expect(await oidcKeyCount(server)).toBe(2);
    } finally {
      await server.close();
    }
  });

  maybe('the previous key may come from a file, like every boot secret', async () => {
    const file = join(dir, 'previous.pem');
    writeFileSync(file, `${oldKey}\n`);
    chmodSync(file, 0o600);
    const server = await boot(newKey, { file });
    try {
      expect(await me(server, oldToken)).toBe(200);
    } finally {
      await server.close();
    }
  });

  maybe('is refused once the previous key is removed', async () => {
    const server = await boot(newKey);
    try {
      expect(await me(server, oldToken)).toBe(401);
      expect(await me(server, await login(server))).toBe(200);
      expect(await kids(server, '/v1/oauth/jwks')).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  maybe(
    'a previous key that is not a PEM refuses the boot by name, echoing nothing of it',
    async () => {
      const fingerprint = oldKey.split('\n')[1]?.slice(0, 40) ?? '';
      let caught: unknown;
      try {
        const server = await boot(newKey, { value: oldKey.replaceAll('\n', '\\n') });
        await server.close();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BootConfigError);
      const message = (caught as Error).message;
      expect(message).toContain('RAYSPEC_JWT_SIGNING_KEY_PREVIOUS');
      expect(message).not.toContain(fingerprint);
    },
  );
});
