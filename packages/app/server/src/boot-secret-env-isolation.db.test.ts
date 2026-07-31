/**
 * The boot must not put the two auth secrets into the PROCESS ENVIRONMENT.
 *
 * `<VAR>_FILE` exists so an operator can hand the platform a secret as a mode-600 file INSTEAD of an
 * environment variable. That gain is only real if the boot leaves it there: `process.env` is copied
 * wholesale into every child this process spawns (the anthropic adapter passes `{ ...process.env }`
 * to the agent CLI; `ffmpeg` is spawned with the ambient environment). The exposure a mirror creates
 * is the CHILDREN, exactly: this process's own `/proc/<pid>/environ` keeps reporting the environment
 * it was exec'd with, so a value written into `process.env` afterwards never shows up there — it
 * shows up in the environ entry of every child exec'd after the write, where it is readable by
 * anything that can see that child. A boot that writes the resolved secrets back onto `process.env`
 * hands them to all of that.
 *
 * So this suite boots the REAL composition root from mounted files ONLY — all three plain variables
 * deleted first — and then proves three things:
 *   1. `process.env` still carries NEITHER boot secret after the boot;
 *   2. a REAL child process spawned afterwards does not receive them either;
 *   3. the boot is nonetheless LIVE on those secrets — a minted api key's stored hash is the HMAC
 *      under the pepper that exists only in the file. Without (3) the first two assertions would
 *      also hold for a boot that never obtained the secrets at all.
 *
 * Both negative assertions carry their own positive control, because "the key is not there" is the
 * kind of claim that passes for the wrong reason: (1) checks that a variable the suite DID set is
 * visible, and (2) plants a canary variable immediately before the spawn and requires the child to
 * report it — so the child really is inheriting this process's environment.
 *
 * DB ISOLATION: as in the sibling boot suites, the committed chain targets a DATABASE's default
 * schema, so the suite creates and drops its own throwaway DATABASE.
 */
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const SUITE_DB = `rayspec_server_envisolation_${process.pid}`;
const FILE_PEPPER = 'pepper-that-must-never-reach-the-process-environment';
const DECOY_PEPPER = 'a-different-pepper-the-boot-must-not-have-used';
/** Planted immediately before the spawn: the child MUST report it, or the spawn proves nothing. */
const CANARY_ENV = 'RAYSPEC_CHILD_ENV_CANARY';
const CANARY_VALUE = 'inherited-by-the-child';

/** What the child process reports back about the environment it was handed. */
interface ChildEnvReport {
  jwtSigningKeyPresent: boolean;
  apiKeyPepperPresent: boolean;
  canary: string | null;
}

/** Point an admin connection at the server's `postgres` database (mirrors the sibling suites). */
function adminUrlOf(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

describe('boot secrets stay in-process — process.env and spawned children never see them', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'boot-secret-env-isolation.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
        'but absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let dir = '';
  let cleanDbUrl = '';

  // Save EVERY env var the suite mutates so a sibling test file cannot inherit a poisoned
  // environment (this file runs with the plain secret variables deleted).
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
    CANARY_ENV,
  ] as const;

  /** Write a secret file with a trailing newline, mode 600 — the real secret-mount shape. */
  function mountSecret(name: string, value: string): string {
    const path = join(dir, name);
    writeFileSync(path, `${value}\n`);
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
    const filePem = (await exportPKCS8(privateKey)).trim();

    dir = mkdtempSync(join(tmpdir(), 'rayspec-env-isolation-'));
    process.env.DATABASE_URL_FILE = mountSecret('database-url', cleanDbUrl);
    process.env.RAYSPEC_JWT_SIGNING_KEY_FILE = mountSecret('jwt-signing-key', filePem);
    process.env.RAYSPEC_API_KEY_PEPPER_FILE = mountSecret('api-key-pepper', FILE_PEPPER);

    // The operator posture this suite is about: the secrets exist ONLY as files.
    delete process.env.DATABASE_URL;
    delete process.env.RAYSPEC_JWT_SIGNING_KEY;
    delete process.env.RAYSPEC_API_KEY_PEPPER;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env[CANARY_ENV];
    process.env.PORT = '8797';

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

  maybe('after the boot, process.env carries neither boot secret', () => {
    // Positive control FIRST: a variable this suite did set IS observable through the same lookup,
    // so the assertions below are reading a live environment, not an empty stand-in.
    expect('PORT' in process.env).toBe(true);
    expect('RAYSPEC_API_KEY_PEPPER_FILE' in process.env).toBe(true);

    // Asserted on PRESENCE, never on the value: a failing assertion here must not print key
    // material into a CI log. `in` is also the right question — a child environment is built by
    // ENUMERATING process.env, so a present-but-empty key would still travel.
    expect('RAYSPEC_JWT_SIGNING_KEY' in process.env).toBe(false);
    expect('RAYSPEC_API_KEY_PEPPER' in process.env).toBe(false);
  });

  maybe('a REAL child process spawned after the boot does not inherit either secret', () => {
    // Planted here, after the boot: the child must see THIS, which is what makes the two negative
    // findings below evidence of absence rather than evidence of a non-inheriting spawn.
    process.env[CANARY_ENV] = CANARY_VALUE;

    // No `env` option — the child gets this process's environment exactly as any spawn would.
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify({' +
          'jwtSigningKeyPresent: "RAYSPEC_JWT_SIGNING_KEY" in process.env,' +
          'apiKeyPepperPresent: "RAYSPEC_API_KEY_PEPPER" in process.env,' +
          `canary: process.env.${CANARY_ENV} ?? null }))`,
      ],
      { encoding: 'utf8' },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);

    const report = JSON.parse(child.stdout) as ChildEnvReport;
    // The control: inheritance is live in this spawn.
    expect(report.canary).toBe(CANARY_VALUE);
    // The finding: the two boot secrets did not travel with it.
    expect(report.jwtSigningKeyPresent).toBe(false);
    expect(report.apiKeyPepperPresent).toBe(false);
  });

  maybe(
    'the boot is live on the mounted secrets: a minted api key hashes under the file pepper',
    async () => {
      const reg = await server!.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'env-isolation@example.test',
          password: 'correct-horse-battery-staple-9',
          orgName: 'Isolation Co',
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

      // The pepper reached the HMAC without ever passing through the environment…
      const sql = postgres(cleanDbUrl, { max: 1 });
      try {
        const rows =
          (await sql`SELECT key_hash FROM public.api_keys WHERE id = ${minted.id}`) as unknown as {
            key_hash: string;
          }[];
        expect(rows).toHaveLength(1);
        const stored = rows[0]?.key_hash as string;
        expect(stored).toBe(createHmac('sha256', FILE_PEPPER).update(secret).digest('hex'));
        // …and it is THAT pepper, not any pepper (so the equality above discriminates).
        expect(stored).not.toBe(createHmac('sha256', DECOY_PEPPER).update(secret).digest('hex'));
      } finally {
        await sql.end();
      }

      // And the verify side works too — both halves of the hot auth path run on the in-process value.
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
