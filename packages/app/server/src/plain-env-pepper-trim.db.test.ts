/**
 * REAL boot proving the PLAIN-ENV api-key pepper is whitespace-trimmed end-to-end.
 *
 * The sibling `boot-secret-file.db.test.ts` proves a _FILE-mounted pepper is trimmed and drives the
 * HMAC. This one proves the SAME contract for the plain `RAYSPEC_API_KEY_PEPPER` variable: it boots
 * the real composition root with the pepper set in the environment WITH A TRAILING NEWLINE (the
 * `echo >>` / env-file classic), mints an api key, and asserts the stored `key_hash` is the HMAC
 * under the pepper WITHOUT the newline — and NOT under the raw `<pepper>\n`. The pepper IS the HMAC
 * key, so a surviving newline would silently change every api-key hash; this is that regression pinned
 * on the plain-env path.
 *
 * DB ISOLATION: as in the sibling suites, the committed chain targets a DATABASE's default schema, so
 * the suite creates and drops its own throwaway DATABASE.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const SUITE_DB = `rayspec_server_plainpepper_${process.pid}`;
const PLAIN_PEPPER = 'plain-env-pepper-that-must-be-trimmed';

/** Point an admin connection at the server's `postgres` database (mirrors the sibling suites). */
function adminUrlOf(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

describe('boot from a plain-env pepper — the trailing newline is trimmed before the api-key HMAC', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'plain-env-pepper-trim.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
        'absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let dir = '';
  let cleanDbUrl = '';

  // Save EVERY env var the suite mutates (including the ones `assembleServer` mirrors back onto
  // process.env) so a sibling test file cannot inherit a poisoned environment.
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'DATABASE_URL',
    'DATABASE_URL_FILE',
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_JWT_SIGNING_KEY_FILE',
    'RAYSPEC_API_KEY_PEPPER',
    'RAYSPEC_API_KEY_PEPPER_FILE',
    'ALLOWED_ORIGINS',
    'PORT',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    cleanDbUrl = (() => {
      const u = new URL(baseUrl);
      u.pathname = `/${SUITE_DB}`;
      return u.toString();
    })();

    const admin = postgres(adminUrlOf(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pem = (await exportPKCS8(privateKey)).trim();

    dir = mkdtempSync(join(tmpdir(), 'rayspec-plain-pepper-'));
    // Everything from the PLAIN environment — NO _FILE mounts here. The pepper carries a trailing
    // newline: without the plain-env trim it would flow through as the raw HMAC key.
    process.env.DATABASE_URL = cleanDbUrl;
    process.env.RAYSPEC_JWT_SIGNING_KEY = pem;
    process.env.RAYSPEC_API_KEY_PEPPER = `${PLAIN_PEPPER}\n`;
    delete process.env.DATABASE_URL_FILE;
    delete process.env.RAYSPEC_JWT_SIGNING_KEY_FILE;
    delete process.env.RAYSPEC_API_KEY_PEPPER_FILE;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8799';

    const config = loadServerConfig();
    // The config-level value is already the trimmed pepper.
    expect(config.apiKeyPepper).toBe(PLAIN_PEPPER);
    server = await assembleServer(config);
  });

  afterAll(async () => {
    await server?.close();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });

    if (baseUrl && cleanDbUrl) {
      const admin = postgres(adminUrlOf(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  });

  maybe(
    'a minted api key hashes under the TRIMMED pepper, never under the raw <pepper>\\n',
    async () => {
      const reg = await server!.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'plain-pepper@example.test',
          password: 'correct-horse-battery-staple-9',
          orgName: 'Plain Pepper Co',
        }),
      });
      expect(reg.status).toBe(201);
      const { accessToken: registerToken, activeOrgId } = (await reg.json()) as {
        accessToken: string;
        activeOrgId: string;
      };

      // Mint needs an ORG-SCOPED token (the tenant is derived from the token, never from the URL).
      const switched = await server!.app.request(`/v1/orgs/${activeOrgId}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${registerToken}` },
      });
      expect(switched.status).toBe(200);
      const accessToken = ((await switched.json()) as { accessToken: string }).accessToken;

      const mint = await server!.app.request(`/v1/orgs/${activeOrgId}/api-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ scopes: ['apikey:read'] }),
      });
      expect(mint.status).toBe(201);
      const minted = (await mint.json()) as { id: string; keyPrefix: string; plaintext: string };
      const secret = minted.plaintext.split('.')[1] as string;
      expect(secret).toBeTruthy();

      const sql = postgres(cleanDbUrl, { max: 1 });
      try {
        const rows = (await sql.unsafe(
          `SELECT key_hash FROM public.api_keys WHERE id = '${minted.id}'`,
        )) as unknown as { key_hash: string }[];
        expect(rows).toHaveLength(1);
        const stored = rows[0]?.key_hash as string;
        // The stored hash is the HMAC under the TRIMMED pepper…
        expect(stored).toBe(createHmac('sha256', PLAIN_PEPPER).update(secret).digest('hex'));
        // …and NOT under the raw `<pepper>\n` (so an un-trimmed plain-env value would have failed
        // this — it changes the HMAC key).
        expect(stored).not.toBe(
          createHmac('sha256', `${PLAIN_PEPPER}\n`).update(secret).digest('hex'),
        );
      } finally {
        await sql.end();
      }

      // And the key authenticates over the real HTTP surface (mint-side hash + verify-side HMAC both
      // under the trimmed pepper).
      const listed = await server!.app.request(`/v1/orgs/${activeOrgId}/api-keys`, {
        headers: { authorization: `Bearer ${minted.plaintext}` },
      });
      expect(listed.status).toBe(200);
      const listBody = (await listed.json()) as { keys: { id: string }[] };
      expect(listBody.keys.map((k) => k.id)).toContain(minted.id);
    },
  );
});
