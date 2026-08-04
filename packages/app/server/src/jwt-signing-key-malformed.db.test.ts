/**
 * A present-but-MALFORMED `RAYSPEC_JWT_SIGNING_KEY` refuses the boot as a NAMED, fail-closed config
 * abort — not as the `jose` library's own error with a stack trace.
 *
 * `loadServerConfig` checks the secret is present; the first thing to look at the bytes is `jose`, so
 * before this the two malformed shapes an operator actually produces surfaced as a bare
 * `TypeError: "pkcs8" must be PKCS#8 formatted string` and a bare `DOMException: Invalid character`,
 * neither naming the variable, and both taking the entrypoint's unexpected-error branch (stack trace,
 * absolute build paths). `BootConfigError` is one of the four classes the entrypoint prints
 * message-only (`serve.ts`), so raising it is what removes the stack as well as naming the variable.
 *
 * Both malformed shapes come from ONE documented value. `rayspec dev gen-secrets` writes the PEM on a
 * single line, literal `\n` escapes behind a leading `"`. The entrypoint's local `.env` loader
 * un-escapes that form, but it skips any variable already present in the environment — so a value
 * copied out of `.env` into an inline assignment is never un-escaped. With the dotenv quotes attached
 * the PEM header is not at offset 0; with them stripped the literal `\n` survives into base64.
 *
 * ACCEPT CONTROLS in the same run, so the reject arms cannot pass vacuously: the SAME generated key
 * as a real multi-line PEM boots the composition root, and so does that key mounted through
 * `RAYSPEC_JWT_SIGNING_KEY_FILE`. Without them a refusal that rejected everything would look correct.
 *
 * DB ISOLATION: the committed chain targets a DATABASE's default schema, so this suite creates and
 * drops its own throwaway DATABASE (the sibling boot suites' pattern).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

const SUITE_DB = `rayspec_server_jwtmalformed_${process.pid}`;

/** Point an admin connection at the server's `postgres` database (the sibling suites' pattern). */
function adminUrlOf(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe('a malformed RAYSPEC_JWT_SIGNING_KEY is a named fail-closed refusal, not a library crash', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'jwt-signing-key-malformed.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
        'but absent — refusing to silently skip this DB-backed suite.',
    );
  }

  const ENV_KEYS = [
    'DATABASE_URL',
    'DATABASE_URL_FILE',
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_JWT_SIGNING_KEY_FILE',
    'RAYSPEC_API_KEY_PEPPER',
    'RAYSPEC_API_KEY_PEPPER_FILE',
    'RAYSPEC_SPEC_PATH',
    'ALLOWED_ORIGINS',
    'PORT',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  let cleanDbUrl = '';
  let dir = '';
  /** The one generated key, in the three forms the arms need. */
  let realPem = '';
  let dotenvQuoted = '';
  let escapedNoQuotes = '';
  /** A distinctive slice of the key's base64 body — no message may contain it. */
  let keyFingerprint = '';

  beforeAll(async () => {
    if (!baseUrl) return;
    cleanDbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(adminUrlOf(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    realPem = (await exportPKCS8(privateKey)).trim();
    // EXACTLY what `rayspec dev gen-secrets` writes into .env (gen-secrets.ts): one line, literal \n,
    // wrapped in double quotes. The two reject arms are this value copied out with and without them.
    escapedNoQuotes = realPem.replace(/\n/g, '\\n');
    dotenvQuoted = `"${escapedNoQuotes}"`;
    // A 40-char slice of the base64 body, past the header — long enough that its appearance in a
    // message could only come from the key itself.
    keyFingerprint = realPem.split('\n')[1]?.slice(0, 40) ?? '';
    expect(keyFingerprint.length).toBe(40);

    dir = mkdtempSync(join(tmpdir(), 'rayspec-jwt-malformed-'));

    delete process.env.DATABASE_URL_FILE;
    delete process.env.RAYSPEC_JWT_SIGNING_KEY_FILE;
    delete process.env.RAYSPEC_API_KEY_PEPPER_FILE;
    delete process.env.RAYSPEC_SPEC_PATH; // auth-only boot: no spec to deploy
    delete process.env.ALLOWED_ORIGINS;
    process.env.DATABASE_URL = cleanDbUrl;
    process.env.RAYSPEC_API_KEY_PEPPER = 'pepper-for-the-malformed-key-suite';
    process.env.PORT = '8799';
  });

  afterAll(async () => {
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

  /** Boot with the given raw value for the key and return whatever the boot threw. */
  async function bootAndCatch(rawKeyValue: string): Promise<unknown> {
    process.env.RAYSPEC_JWT_SIGNING_KEY = rawKeyValue;
    let caught: unknown;
    let server: BootedServer | undefined;
    try {
      server = await assembleServer(loadServerConfig());
    } catch (err) {
      caught = err;
    } finally {
      await server?.close();
    }
    return caught;
  }

  maybe(
    'the .env value copied out WITH its dotenv quotes refuses, naming the variable and echoing no key byte',
    async () => {
      const caught = await bootAndCatch(dotenvQuoted);
      // The class is what buys the message-only, no-stack print at the entrypoint (serve.ts lists
      // BootConfigError among the four operator-actionable classes).
      expect(caught).toBeInstanceOf(BootConfigError);
      const message = (caught as Error).message;
      expect(message).toContain('RAYSPEC_JWT_SIGNING_KEY');
      expect(message).toContain('-----BEGIN PRIVATE KEY-----');
      expect(message).toContain('Fail-closed.');
      // Not the library's own wording, which named neither the variable nor the shape.
      expect(message).not.toContain('"pkcs8" must be PKCS#8 formatted string');
      // No byte of the key reaches the operator's log.
      expect(message).not.toContain(keyFingerprint);
    },
  );

  maybe(
    'the same value with the quotes stripped — literal \\n intact — refuses the same way',
    async () => {
      const caught = await bootAndCatch(escapedNoQuotes);
      expect(caught).toBeInstanceOf(BootConfigError);
      const message = (caught as Error).message;
      expect(message).toContain('RAYSPEC_JWT_SIGNING_KEY');
      expect(message).toContain('Fail-closed.');
      // This shape failed inside base64 decoding, whose error is less legible still.
      expect(message).not.toContain('Invalid character');
      expect(message).not.toContain(keyFingerprint);
    },
  );

  maybe('ACCEPT CONTROL: the same key as a real multi-line PEM boots', async () => {
    process.env.RAYSPEC_JWT_SIGNING_KEY = realPem;
    const server = await assembleServer(loadServerConfig());
    try {
      expect(server.issuer).toContain('8799');
    } finally {
      await server.close();
    }
  });

  maybe(
    'ACCEPT CONTROL: the same key mounted through RAYSPEC_JWT_SIGNING_KEY_FILE boots',
    async () => {
      const file = join(dir, 'jwt-signing-key');
      writeFileSync(file, `${realPem}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      delete process.env.RAYSPEC_JWT_SIGNING_KEY;
      process.env.RAYSPEC_JWT_SIGNING_KEY_FILE = file;
      try {
        const server = await assembleServer(loadServerConfig());
        try {
          expect(server.issuer).toContain('8799');
        } finally {
          await server.close();
        }
      } finally {
        delete process.env.RAYSPEC_JWT_SIGNING_KEY_FILE;
      }
    },
  );
});
