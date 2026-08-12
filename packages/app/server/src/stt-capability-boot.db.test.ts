/**
 * STT capability boot test — the composition-root wiring for the backend-profile `init.stt`
 * capability: `STT_PROVIDER` unset ⇒ the capability is ABSENT; `STT_PROVIDER=fake` ⇒ a declared
 * `{handler}` route transcribes DETERMINISTICALLY; `STT_PROVIDER=deepgram` with no key ⇒ the boot
 * REFUSES (fail-closed at boot, mirroring the product profile's eager credential demand).
 *
 * This drives the REAL composition root (`assembleServer`) against a throwaway DATABASE with a
 * backend-profile spec, asserting END-TO-END on ground truth (fail-the-fix, not pass-the-shape):
 *
 *   (a) ACCEPT CONTROL: with STT_PROVIDER UNSET the boot succeeds and the handler observes
 *       `'stt' in init === false` — ABSENT, not `undefined` (the init shape stays exact, so a handler
 *       that needs transcription fail-closes loudly instead of calling a stub).
 *   (b) HAPPY: STT_PROVIDER=fake ⇒ the boot builds + injects the capability and a real POST through
 *       the composition-root app returns a `completed` transcript — TWICE, byte-identical (identical
 *       input ⇒ identical output). This goes GREEN only because env → engine.sttCapability → init.stt
 *       is wired end-to-end through the REAL composition root (not a harness handing it in).
 *   (c) FAIL-THE-FIX: STT_PROVIDER=deepgram with DEEPGRAM_API_KEY unset aborts the boot with the
 *       specific `BootConfigError` naming the variable. NO network call is made anywhere in this file.
 *
 * DB ISOLATION: a whole throwaway DATABASE (not a per-schema), exactly as stream-blob-boot.db.test.ts
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

/** A backend-profile spec: no stores, one `{handler}` route that transcribes through `init.stt`. */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: stt-capability-boot-test
  description: backend-profile spec whose {handler} route transcribes through init.stt
handlers:
  - id: transcribe_handler
    module: handlers/transcribe.ts
    export: transcribe
    kind: route
api:
  - method: POST
    path: /transcribe
    action: { kind: handler, handler: transcribe_handler }
`;

/**
 * The route handler, written to the temp handler root (loaded through the REAL path-jailed loader).
 * It REPORTS whether the capability is present rather than assuming it — so the unset arm asserts the
 * ABSENT-not-undefined contract on ground truth, and the wired arm asserts the transcript itself.
 */
const HANDLER_TS = `
export const transcribe = async (init) => {
  const present = 'stt' in init;
  if (!present) return { stt_present: false };
  const body = init.body ?? {};
  const bytes = Uint8Array.from(Buffer.from(body.audio_base64 ?? '', 'base64'));
  const result = await init.stt.transcribe(bytes, { contentType: 'audio/ogg' });
  return { stt_present: true, status: result.status, transcript: result.transcript };
};
`;

const SUITE_DB = `rayspec_server_stt_${process.pid}`;
/** The audio a test posts (opaque bytes — the fake never decodes them; the real provider would). */
const AUDIO_B64 = Buffer.from(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x7f])).toString(
  'base64',
);

describe('STT capability boot — composition-root wiring, fail-closed credential demand', () => {
  const baseUrl = process.env.DATABASE_URL;
  // DB-backed: skip cleanly when there is no Postgres (mirrors the other boot suites' guard).
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed boot suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'stt-capability-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
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
    'STT_PROVIDER',
    'DEEPGRAM_API_KEY',
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
    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-stt-boot-'));
    specPath = join(tmpDir, 'rayspec.yaml');
    writeFileSync(specPath, SPEC_YAML, 'utf8');
    mkdirSync(join(tmpDir, 'handlers'), { recursive: true });
    writeFileSync(join(tmpDir, 'handlers', 'transcribe.ts'), HANDLER_TS, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'stt-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8804';
    process.env.RAYSPEC_SPEC_PATH = specPath;
    // The handler module path is `handlers/transcribe.ts`; the jail root is the temp dir's `handlers`
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
      body: JSON.stringify({ name: 'Stt Boot Co' }),
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

  async function transcribe(app: BootedServer['app'], token: string): Promise<Response> {
    return app.request('/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ audio_base64: AUDIO_B64 }),
    });
  }

  maybe(
    '(a) ACCEPT CONTROL: STT_PROVIDER unset ⇒ the boot succeeds and init.stt is ABSENT',
    async () => {
      delete process.env.STT_PROVIDER;
      delete process.env.DEEPGRAM_API_KEY;

      const config = loadServerConfig();
      expect(config.sttProvider).toBeUndefined();

      server = await assembleServer(config, {
        registerProductTables: (tables) => {
          registerScopedTables([...tables.values()]);
        },
        // The temp handler is un-built `.ts`; opt into the type-stripping importer seam (production
        // loads compiled `.js` only and never sets this).
        moduleImporter: typeStrippingImporter,
      });
      const token = await memberToken(server.app, 'stt-unset@example.test');
      const res = await transcribe(server.app, token);
      expect(res.status).toBe(200);
      // ABSENT, not undefined — an unset provider leaves the init shape exact.
      expect(await res.json()).toEqual({ stt_present: false });
      await server.close();
      server = undefined;
    },
    120_000,
  );

  maybe(
    '(b) HAPPY: STT_PROVIDER=fake ⇒ the handler transcribes, and identical input yields identical output',
    async () => {
      process.env.STT_PROVIDER = 'fake';
      delete process.env.DEEPGRAM_API_KEY;

      const config = loadServerConfig();
      expect(config.sttProvider).toBe('fake');

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
      // The boot WARNED that the selected provider does not transcribe — and still booted.
      expect(warnings.some((w) => w.includes('STT_PROVIDER=fake'))).toBe(true);
      const token = await memberToken(server.app, 'stt-fake@example.test');

      const first = await transcribe(server.app, token);
      expect(first.status).toBe(200);
      const body = (await first.json()) as {
        stt_present: boolean;
        status: string;
        transcript: { full_text: string; provider: string; status: string };
      };
      // GROUND TRUTH: env(STT_PROVIDER) → engine.sttCapability → init.stt wired end-to-end through
      // the REAL composition root, and the fake path is a WORKING transcriber (not a boot posture).
      expect(body.stt_present).toBe(true);
      expect(body.status).toBe('completed');
      expect(body.transcript.status).toBe('completed');
      expect(body.transcript.full_text.length).toBeGreaterThan(0);

      // DETERMINISTIC: the same bytes transcribe to the byte-identical artifact on a second call.
      const second = await transcribe(server.app, token);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(body);

      await server.close();
      server = undefined;
    },
    120_000,
  );

  maybe(
    '(c) FAIL-THE-FIX: STT_PROVIDER=deepgram with no DEEPGRAM_API_KEY aborts the boot',
    async () => {
      process.env.STT_PROVIDER = 'deepgram';
      delete process.env.DEEPGRAM_API_KEY;

      const config = loadServerConfig();
      expect(config.deepgramApiKey).toBeUndefined();

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
      expect((caught as BootConfigError).message).toContain('DEEPGRAM_API_KEY');
      expect((caught as BootConfigError).message).toMatch(/STT_PROVIDER=deepgram/);
    },
    120_000,
  );
});
