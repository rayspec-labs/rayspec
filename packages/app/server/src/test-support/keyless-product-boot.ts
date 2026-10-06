/**
 * Test-support: boot the acme-notes example from the environment alone, with no provider key in it,
 * on throwaway databases — and drive a recording through the booted server over HTTP.
 *
 * NOTHING IS INJECTED into a boot made here. No speech adapter and no extraction executor are
 * handed to the composition root: the settings a case passes are the only configuration, exactly as
 * `rayspec deploy` reads them. One process can launch the durable worker once, so each suite boots
 * one serving deployment; a boot that refuses launches nothing and may be repeated.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { expect, vi } from 'vitest';
import {
  applyMigrations,
  assembleServer,
  type BootedServer,
  loadServerConfig,
} from '../composition-root.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The acme-notes example as committed: its document, its production extraction config, its fixtures. */
export const ACME = resolve(here, '../../../../../examples/acme-notes');
export const ACME_YAML = join(ACME, 'acme-notes.product.yaml');
export const ACME_CONFIG = join(ACME, 'extraction/extractor.json');
export const ACME_FIXTURES = join(ACME, 'stt-fixtures');

export const KEYLESS_TENANT = '00000000-0000-4000-8000-0000000000f3';

/** The provider credentials no boot made here may see. */
export const PROVIDER_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_API_KEY_FILE',
  'DEEPGRAM_API_KEY',
  'DEEPGRAM_API_KEY_FILE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY_FILE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE',
] as const;

/** Every variable a case sets or must be sure is absent; restored on teardown. */
const ENV = [
  'RAYSPEC_JWT_SIGNING_KEY',
  'RAYSPEC_API_KEY_PEPPER',
  'DATABASE_URL',
  'ALLOWED_ORIGINS',
  'PORT',
  'RAYSPEC_SPEC_PATH',
  'DBOS_SYSTEM_DATABASE_URL',
  'RAYSPEC_PRODUCT_TENANT_ID',
  'RAYSPEC_BLOB_ROOT',
  'RAYSPEC_MEDIA_SIGNING_KEY',
  'RAYSPEC_HOSTING_POSTURE',
  'STT_PROVIDER',
  'RAYSPEC_STT_FAKE_FIXTURES',
  'RAYSPEC_STT_FAKE_FALLBACK',
  'RAYSPEC_EXTRACTION_MODE',
  'RAYSPEC_EXTRACTION_CONFIG',
  'RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN',
  ...PROVIDER_KEYS,
] as const;

/** The settings a case chooses; cleared before each boot so no case inherits another's. */
const SELECTABLE = [
  'RAYSPEC_HOSTING_POSTURE',
  'STT_PROVIDER',
  'RAYSPEC_STT_FAKE_FIXTURES',
  'RAYSPEC_STT_FAKE_FALLBACK',
  'RAYSPEC_EXTRACTION_MODE',
  'RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN',
  'DEEPGRAM_API_KEY',
] as const;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface KeylessProductHarness {
  /** Create the databases and the provider-key-free environment. */
  setup(): Promise<void>;
  /** Close a serving boot, restore the environment and drop the databases. */
  teardown(): Promise<void>;
  /** Boot acme-notes on `db` with `settings`; a boot that serves is kept for the HTTP helpers. */
  boot(db: string, settings: Record<string, string>): Promise<BootedServer>;
  /** `boot`, with the non-real-provider banner it printed (undefined when it printed none). */
  bootWithBanner(
    db: string,
    settings: Record<string, string>,
  ): Promise<{ server: BootedServer; banner: string | undefined }>;
  /** The message a boot with `settings` refuses with; throws when it does not refuse. */
  refusalOf(db: string, settings: Record<string, string>): Promise<string>;
  query<T>(db: string, sql: string, params?: unknown[]): Promise<T[]>;
  /** A bearer token of an owner of the deployment tenant, on the serving boot. */
  token(db: string): Promise<string>;
  /** Upload one chunk per track and finalize both: what a client does to hand over a recording. */
  record(bearer: string, session: string): Promise<void>;
  /** Wait until `count` workflow runs exist and none is in flight; their statuses. */
  settledRuns(db: string, count: number): Promise<string[]>;
  /** GET a declared view of the serving boot (200 asserted). */
  get(bearer: string, path: string): Promise<Record<string, unknown>>;
}

/** A harness over `databases` (created on setup, dropped on teardown) of the server at `baseUrl`. */
export function keylessProductHarness(
  baseUrl: string,
  databases: readonly string[],
): KeylessProductHarness {
  let serving: BootedServer | undefined;
  let blobDir = '';
  const saved: Record<string, string | undefined> = {};
  const admin = () => postgres(withDbName(baseUrl, 'postgres'), { max: 1, onnotice: () => {} });

  async function drop(sql: postgres.Sql): Promise<void> {
    for (const db of databases) {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${db}_dbos_sys" WITH (FORCE)`);
      await sql.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    }
  }

  async function query<T>(db: string, sql: string, params: unknown[] = []): Promise<T[]> {
    const client = postgres(withDbName(baseUrl, db), { max: 1 });
    try {
      return (await client.unsafe(sql, params as never[])) as unknown as T[];
    } finally {
      await client.end();
    }
  }

  async function boot(db: string, settings: Record<string, string>): Promise<BootedServer> {
    for (const k of SELECTABLE) delete process.env[k];
    Object.assign(process.env, settings);
    process.env.DATABASE_URL = withDbName(baseUrl, db);
    serving = await assembleServer(loadServerConfig(), {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      // A suite boots in process; under the managed posture that needs naming (see the option).
      unsupervisedPrivilege: 'test-harness',
    });
    return serving;
  }

  const server = (): BootedServer => {
    if (!serving) throw new Error('no serving boot');
    return serving;
  };

  return {
    query,
    boot,

    async setup() {
      const sql = admin();
      try {
        await drop(sql);
        for (const db of databases) await sql.unsafe(`CREATE DATABASE "${db}"`);
      } finally {
        await sql.end();
      }
      blobDir = mkdtempSync(join(tmpdir(), 'rayspec-keyless-'));
      for (const k of ENV) saved[k] = process.env[k];
      // No provider key of any kind is in this environment, whatever the developer's own holds.
      for (const k of ENV) delete process.env[k];
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
      process.env.RAYSPEC_API_KEY_PEPPER = 'keyless-boot-pepper-only';
      process.env.PORT = '8811';
      process.env.RAYSPEC_SPEC_PATH = ACME_YAML;
      process.env.RAYSPEC_PRODUCT_TENANT_ID = KEYLESS_TENANT;
      process.env.RAYSPEC_BLOB_ROOT = blobDir;
      process.env.RAYSPEC_MEDIA_SIGNING_KEY = 'keyless-boot-media-secret-at-least-32-bytes';

      // The deployment tenant must be a live org before a product deployment boots.
      for (const db of databases) {
        const seed = makeDb(withDbName(baseUrl, db));
        try {
          await applyMigrations(seed);
          await seed.$client.unsafe(
            `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Acme', 'acme')`,
            [KEYLESS_TENANT],
          );
        } finally {
          await seed.$client.end();
        }
      }
    },

    async teardown() {
      await serving?.close();
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (blobDir) rmSync(blobDir, { recursive: true, force: true });
      const sql = admin();
      try {
        await drop(sql);
      } finally {
        await sql.end();
      }
    },

    async bootWithBanner(db, settings) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const booted = await boot(db, settings);
        const banner = warn.mock.calls
          .map((call) => String(call[0]))
          .find((text) => text.includes('NON-REAL PROVIDER'));
        return { server: booted, banner };
      } finally {
        warn.mockRestore();
      }
    },

    async refusalOf(db, settings) {
      try {
        await boot(db, settings);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error(`expected the boot to refuse ${JSON.stringify(settings)}`);
    },

    async token(db) {
      const email = `keyless-${Date.now()}@example.com`;
      const reg = await server().app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'a-long-enough-password' }),
      });
      expect([200, 201]).toContain(reg.status);
      const [user] = await query<{ id: string }>(db, 'SELECT id FROM users WHERE email = $1', [
        email,
      ]);
      await query(
        db,
        `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
        [KEYLESS_TENANT, user?.id],
      );
      const sw = await server().app.request(`/v1/orgs/${KEYLESS_TENANT}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${(await reg.json()).accessToken}` },
      });
      expect(sw.status).toBe(200);
      return (await sw.json()).accessToken as string;
    },

    async record(bearer, session) {
      for (const [track, bytes] of [
        ['mic', new Uint8Array([1, 2, 3])],
        ['system', new Uint8Array([4, 5])],
      ] as const) {
        const chunk = await server().app.request(`/sessions/${session}/${track}/chunks/0`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'audio/ogg' },
          body: bytes,
        });
        expect(chunk.status).toBe(200);
      }
      for (const track of ['mic', 'system']) {
        const finalized = await server().app.request(`/sessions/${session}/${track}/finalize`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify({ total_chunks: 1 }),
        });
        expect(finalized.status).toBe(200);
      }
    },

    async settledRuns(db, count) {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const runs = await query<{ status: string }>(db, 'SELECT status FROM workflow_runs');
        const statuses = runs.map((r) => r.status);
        if (
          statuses.length >= count &&
          statuses.every((s) => s !== 'running' && s !== 'retryable_failure')
        ) {
          return statuses;
        }
        if (Date.now() > deadline) {
          throw new Error(`workflow did not settle: ${statuses.join(',')}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },

    async get(bearer, path) {
      const res = await server().app.request(path, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(res.status, path).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    },
  };
}
