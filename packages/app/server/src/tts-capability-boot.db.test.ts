/**
 * TTS capability boot test — the composition-root wiring for the backend-profile `init.tts`
 * capability: `TTS_PROVIDER` unset ⇒ the capability is ABSENT; `TTS_PROVIDER=fake` ⇒ a declared
 * `{handler}` route synthesizes DETERMINISTICALLY; `TTS_PROVIDER=openai` with no key ⇒ the boot
 * REFUSES (fail-closed at boot, mirroring the transcription capability's eager credential demand).
 *
 * This drives the REAL composition root (`assembleServer`) against a throwaway DATABASE with a
 * backend-profile spec, asserting END-TO-END on ground truth (fail-the-fix, not pass-the-shape):
 *
 *   (a) ACCEPT CONTROL: with TTS_PROVIDER UNSET the boot succeeds and the handler observes
 *       `'tts' in init === false` — ABSENT, not `undefined` (the init shape stays exact, so a handler
 *       that needs speech fail-closes loudly instead of calling a stub).
 *   (b) HAPPY: TTS_PROVIDER=fake ⇒ the boot builds + injects the capability and a real POST through
 *       the composition-root app returns audio — TWICE, BYTE-identical (identical input ⇒ identical
 *       bytes, content type and duration). This goes GREEN only because env → engine.ttsCapability →
 *       init.tts is wired end-to-end through the REAL composition root (not a harness handing it in).
 *   (c) FAIL-THE-FIX: TTS_PROVIDER=openai with OPENAI_API_KEY unset aborts the boot with the
 *       specific `BootConfigError` naming the variable. NO network call is made anywhere in this file.
 *
 * DB ISOLATION: a whole throwaway DATABASE (not a per-schema), exactly as stt-capability-boot.db.test.ts
 * — the migration chain materializes the platform into a database's default + `drizzle` schema.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerScopedTables } from '@rayspec/db/testing';
import { typeStrippingImporter } from '@rayspec/platform';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** A backend-profile spec: no stores, one `{handler}` route that synthesizes through `init.tts`. */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: tts-capability-boot-test
  description: backend-profile spec whose {handler} route synthesizes through init.tts
handlers:
  - id: speak_handler
    module: handlers/speak.ts
    export: speak
    kind: route
api:
  - method: POST
    path: /speak
    action: { kind: handler, handler: speak_handler }
`;

/**
 * The route handler, written to the temp handler root (loaded through the REAL path-jailed loader).
 * It REPORTS whether the capability is present rather than assuming it — so the unset arm asserts the
 * ABSENT-not-undefined contract on ground truth — and reports a DIGEST of the audio so the wired arm
 * pins byte-identity across two calls through a JSON body.
 */
const HANDLER_TS = `
import { createHash } from 'node:crypto';

export const speak = async (init) => {
  const present = 'tts' in init;
  if (!present) return { tts_present: false };
  const body = init.body ?? {};
  const result = await init.tts.synthesize(body.text ?? '', { format: 'wav' });
  return {
    tts_present: true,
    content_type: result.contentType,
    duration_seconds: result.durationSeconds ?? null,
    byte_length: result.bytes.length,
    audio_sha256: createHash('sha256').update(result.bytes).digest('hex'),
  };
};
`;

const SUITE_DB = `rayspec_server_tts_${process.pid}`;

describe('TTS capability boot — composition-root wiring, fail-closed credential demand', () => {
  const baseUrl = process.env.DATABASE_URL;
  // DB-backed: skip cleanly when there is no Postgres (mirrors the other boot suites' guard).
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed boot suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'tts-capability-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
        'absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let tmpDir = '';
  let specPath = '';
  // Save EVERY env var the suite mutates so it cannot poison a sibling test file.
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_HANDLER_ROOT',
    'TTS_PROVIDER',
    'OPENAI_API_KEY',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    const appDbUrl = withDbName(baseUrl, SUITE_DB);

    // Fresh empty throwaway APP database (drop any leftover from a crashed prior run first).
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    // A temp dir holding the spec + the handler root (both cleaned in afterAll).
    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-tts-boot-'));
    specPath = join(tmpDir, 'rayspec.yaml');
    writeFileSync(specPath, SPEC_YAML, 'utf8');
    mkdirSync(join(tmpDir, 'handlers'), { recursive: true });
    writeFileSync(join(tmpDir, 'handlers', 'speak.ts'), HANDLER_TS, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'tts-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8806';
    process.env.RAYSPEC_SPEC_PATH = specPath;
    // The handler module path is `handlers/speak.ts`; the jail root is the temp dir's `handlers`
    // parent — point the root at the temp dir and write the module under it.
    process.env.RAYSPEC_HANDLER_ROOT = tmpDir;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  /** Register → org → switch → a member token (store:write gates a `{handler}` route). */
  async function memberToken(app: BootedServer['app'], email: string): Promise<string> {
    const reg = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple-9' }),
    });
    expect(reg.status).toBe(201);
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await app.request('/v1/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t0}` },
      body: JSON.stringify({ name: 'Tts Boot Co' }),
    });
    expect(orgRes.status).toBe(201);
    const orgId = (await orgRes.json()).id as string;
    const switchRes = await app.request(`/v1/orgs/${orgId}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t0}` },
    });
    expect(switchRes.status).toBe(200);
    return (await switchRes.json()).accessToken as string;
  }

  async function speak(app: BootedServer['app'], token: string): Promise<Response> {
    return app.request('/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: 'Guten Morgen.' }),
    });
  }

  maybe(
    '(a) ACCEPT CONTROL: TTS_PROVIDER unset ⇒ the boot succeeds and init.tts is ABSENT',
    async () => {
      delete process.env.TTS_PROVIDER;
      delete process.env.OPENAI_API_KEY;

      const config = loadServerConfig();
      expect(config.ttsProvider).toBeUndefined();

      server = await assembleServer(config, {
        registerProductTables: (tables) => {
          registerScopedTables([...tables.values()]);
        },
        // The temp handler is un-built `.ts`; opt into the type-stripping importer seam (production
        // loads compiled `.js` only and never sets this).
        moduleImporter: typeStrippingImporter,
      });
      const token = await memberToken(server.app, 'tts-unset@example.test');
      const res = await speak(server.app, token);
      expect(res.status).toBe(200);
      // ABSENT, not undefined — an unset provider leaves the init shape exact.
      expect(await res.json()).toEqual({ tts_present: false });
      await server.close();
      server = undefined;
    },
    120_000,
  );

  maybe(
    '(b) HAPPY: TTS_PROVIDER=fake ⇒ the handler synthesizes, and identical input yields BYTE-identical audio',
    async () => {
      process.env.TTS_PROVIDER = 'fake';
      delete process.env.OPENAI_API_KEY;

      const config = loadServerConfig();
      expect(config.ttsProvider).toBe('fake');

      // Capture what the boot reported instead of writing it to the console — the non-real-provider
      // warning is part of the contract (warn-only, never fail-closed).
      const warnings: string[] = [];
      server = await assembleServer(config, {
        registerProductTables: (tables) => {
          registerScopedTables([...tables.values()]);
        },
        moduleImporter: typeStrippingImporter,
        bootWarn: (line: string) => warnings.push(line),
      });
      // The boot WARNED that the selected provider does not synthesize speech — and still booted.
      expect(warnings.some((w) => w.includes('TTS_PROVIDER=fake'))).toBe(true);
      const token = await memberToken(server.app, 'tts-fake@example.test');

      const first = await speak(server.app, token);
      expect(first.status).toBe(200);
      const body = (await first.json()) as {
        tts_present: boolean;
        content_type: string;
        duration_seconds: number | null;
        byte_length: number;
        audio_sha256: string;
      };
      // GROUND TRUTH: env(TTS_PROVIDER) → engine.ttsCapability → init.tts wired end-to-end through
      // the REAL composition root, and the fake path is a WORKING synthesizer (not a boot posture).
      expect(body.tts_present).toBe(true);
      expect(body.content_type).toBe('audio/wav');
      expect(body.byte_length).toBeGreaterThan(44); // a RIFF header plus real sample data
      expect(body.duration_seconds).toBeGreaterThan(0);

      // DETERMINISTIC: the same text synthesizes to BYTE-identical audio on a second call — the
      // digest, the byte length, the content type and the duration all match exactly.
      const second = await speak(server.app, token);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(body);

      await server.close();
      server = undefined;
    },
    120_000,
  );

  maybe(
    '(c) FAIL-THE-FIX: TTS_PROVIDER=openai with no OPENAI_API_KEY aborts the boot',
    async () => {
      process.env.TTS_PROVIDER = 'openai';
      delete process.env.OPENAI_API_KEY;

      const config = loadServerConfig();
      expect(config.openaiApiKey).toBeUndefined();

      // assembleServer must THROW the SPECIFIC BootConfigError — the backend profile demands the
      // credential EAGERLY at boot (the adapter's own lazy resolution would otherwise turn every
      // call into a content-free `provider_unavailable` at request time). One call only: a
      // guard-rejected boot leaves the pool un-closed (the throwaway DB is dropped WITH (FORCE)).
      let caught: unknown;
      try {
        await assembleServer(config, {
          registerProductTables: (tables) => {
            registerScopedTables([...tables.values()]);
          },
          moduleImporter: typeStrippingImporter,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BootConfigError);
      expect((caught as BootConfigError).message).toContain('OPENAI_API_KEY');
      expect((caught as BootConfigError).message).toMatch(/TTS_PROVIDER=openai/);
    },
    120_000,
  );
});
