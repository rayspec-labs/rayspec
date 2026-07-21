/**
 * REAL boot from mounted secret files only.
 *
 * The unit suite (`boot-secret-file.test.ts`) proves the resolution rules against an injected env.
 * This one proves the whole process actually RUNS on file-sourced secrets: it deletes all three
 * plain variables from `process.env`, points the three `<VAR>_FILE` variables at mode-600 files, and
 * boots the REAL composition root against a throwaway database via the committed migration chain.
 *
 * Each secret is then proven to have DONE ITS JOB, not merely "not thrown":
 *   - DATABASE_URL_FILE          — the chain ran in the throwaway database and `/health` round-trips it;
 *   - RAYSPEC_JWT_SIGNING_KEY_FILE — a minted access token VERIFIES under the public key of the PEM in
 *     the file (and is REJECTED by an unrelated key, so the check discriminates);
 *   - RAYSPEC_API_KEY_PEPPER_FILE  — a minted api key's stored hash equals the HMAC under the pepper in
 *     the file (and NOT under a decoy pepper), and the key authenticates over the real HTTP surface.
 *
 * Every secret file is written with a TRAILING NEWLINE — the form `echo`/`printf`/a container secret
 * projection produces — so this also proves the trim is what makes the file form usable.
 *
 * DB ISOLATION: as in the sibling boot smoke suite, the committed chain targets a DATABASE's default
 * schema, so the suite creates and drops its own throwaway DATABASE.
 */
import { createHmac, createPublicKey } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const SUITE_DB = `rayspec_server_secretfile_${process.pid}`;
const FILE_PEPPER = 'pepper-that-exists-only-in-the-mounted-file';
const DECOY_PEPPER = 'a-different-pepper-the-boot-must-not-have-used';

/** Point an admin connection at the server's `postgres` database (mirrors the boot smoke suite). */
function adminUrlOf(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

describe('boot from mounted secret files — the real composition root on _FILE secrets only', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'boot-secret-file.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
        'absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let dir = '';
  let cleanDbUrl = '';
  let filePem = '';
  /** An unrelated key pair — the token must NOT verify under it (proves the check discriminates). */
  let decoyPublicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'] | undefined;

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

  /** Write a secret file with a trailing newline, mode 600 — the real secret-mount shape. */
  function mountSecret(name: string, value: string, leading = ''): string {
    const path = join(dir, name);
    writeFileSync(path, `${leading}${value}\n`);
    chmodSync(path, 0o600);
    return path;
  }

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
    filePem = (await exportPKCS8(privateKey)).trim();
    decoyPublicKey = (await generateKeyPair('RS256', { extractable: true })).publicKey;

    dir = mkdtempSync(join(tmpdir(), 'rayspec-boot-mount-'));
    process.env.DATABASE_URL_FILE = mountSecret('database-url', cleanDbUrl);
    // The key file carries a byte-order mark AND a leading newline on top of the trailing one — the
    // shape an editor or a `--from-file` round-trip produces. A PKCS#8 import needs the PEM header
    // at offset 0, so an un-trimmed read of this exact file cannot produce a working signer: booting
    // at all, and then verifying a real signature below, is what proves the trim.
    process.env.RAYSPEC_JWT_SIGNING_KEY_FILE = mountSecret('jwt-signing-key', filePem, '﻿\n');
    process.env.RAYSPEC_API_KEY_PEPPER_FILE = mountSecret('api-key-pepper', FILE_PEPPER);

    // The whole point: NONE of the three secrets is in the environment. If the file mounts were
    // ignored the boot below would abort with the missing-variable error.
    delete process.env.DATABASE_URL;
    delete process.env.RAYSPEC_JWT_SIGNING_KEY;
    delete process.env.RAYSPEC_API_KEY_PEPPER;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8798';

    const config = loadServerConfig();
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
    'DATABASE_URL_FILE drove the boot: the chain ran in the throwaway DB and /health is ok',
    async () => {
      const sql = postgres(cleanDbUrl, { max: 1 });
      try {
        const [{ applied }] = (await sql.unsafe(
          'SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations',
        )) as unknown as [{ applied: number }];
        expect(applied).toBeGreaterThan(0);
        const tables = (await sql.unsafe(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1",
        )) as unknown as { table_name: string }[];
        const names = tables.map((t) => t.table_name);
        for (const expected of ['orgs', 'users', 'memberships', 'api_keys']) {
          expect(names).toContain(expected);
        }
      } finally {
        await sql.end();
      }

      const res = await server!.app.request('/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });
      // The connection string was never in the environment this boot read.
      expect(savedEnv.DATABASE_URL).not.toBe(cleanDbUrl);
    },
  );

  maybe(
    'RAYSPEC_JWT_SIGNING_KEY_FILE drove the signer: a minted token verifies under THAT key',
    async () => {
      const reg = await server!.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'mounted@example.test',
          password: 'correct-horse-battery-staple-9',
          orgName: 'Mounted Co',
        }),
      });
      expect(reg.status).toBe(201);
      const regBody = (await reg.json()) as { accessToken: string; activeOrgId: string };
      expect(regBody.accessToken.split('.')).toHaveLength(3);

      // The token verifies under the PUBLIC key derived from the PEM that exists ONLY in the file.
      const publicKey = createPublicKey(filePem);
      const { payload, protectedHeader } = await jwtVerify(regBody.accessToken, publicKey);
      expect(protectedHeader.alg).toBe('RS256');
      expect(payload.sub).toBeTruthy();

      // …and NOT under an unrelated key — so the assertion above is a real signature check, not a
      // check that passes for any input.
      await expect(jwtVerify(regBody.accessToken, decoyPublicKey!)).rejects.toThrow();

      // A real authed round-trip on that token.
      const me = await server!.app.request('/v1/auth/me', {
        headers: { authorization: `Bearer ${regBody.accessToken}` },
      });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { email: string }).email).toBe('mounted@example.test');
    },
  );

  maybe(
    'RAYSPEC_API_KEY_PEPPER_FILE drove the api-key HMAC: the stored hash is under THAT pepper',
    async () => {
      const reg = await server!.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'mounted-pepper@example.test',
          password: 'correct-horse-battery-staple-9',
          orgName: 'Pepper Co',
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

      // The persisted hash is the HMAC of the secret under the pepper THE FILE HOLDS…
      const sql = postgres(cleanDbUrl, { max: 1 });
      try {
        const rows = (await sql.unsafe(
          `SELECT key_hash FROM public.api_keys WHERE id = '${minted.id}'`,
        )) as unknown as { key_hash: string }[];
        expect(rows).toHaveLength(1);
        const stored = rows[0]?.key_hash as string;
        expect(stored).toBe(createHmac('sha256', FILE_PEPPER).update(secret).digest('hex'));
        // …and NOT under a different pepper (so the equality above is discriminating, and a trailing
        // newline surviving the read would have failed this too — it changes the HMAC key).
        expect(stored).not.toBe(createHmac('sha256', DECOY_PEPPER).update(secret).digest('hex'));
        expect(stored).not.toBe(
          createHmac('sha256', `${FILE_PEPPER}\n`).update(secret).digest('hex'),
        );
      } finally {
        await sql.end();
      }

      // And the key authenticates over the real HTTP surface (mint-side hash + verify-side HMAC both
      // under the mounted pepper).
      const listed = await server!.app.request(`/v1/orgs/${activeOrgId}/api-keys`, {
        headers: { authorization: `Bearer ${minted.plaintext}` },
      });
      expect(listed.status).toBe(200);
      const listBody = (await listed.json()) as { keys: { id: string }[] };
      expect(listBody.keys.map((k) => k.id)).toContain(minted.id);

      // Fail-closed cross-check: a tampered secret under the SAME prefix is rejected.
      const bad = await server!.app.request(`/v1/orgs/${activeOrgId}/api-keys`, {
        headers: { authorization: `Bearer ${minted.keyPrefix}.not-the-real-secret` },
      });
      expect(bad.status).toBe(401);
    },
  );
});
