/**
 * The EXTENSION-PACK mechanism END-TO-END through the REAL composition root.
 *
 * This is the headline acceptance (fail-the-fix, ground truth): the synthetic
 * stream/blob backend is now delivered as a `defineExtension` PACK loaded via `extensions[]` (the
 * deployment `rayspec.yaml` is THIN). This drives the REAL `assembleServer` against a throwaway
 * DATABASE with that thin spec and proves on GROUND TRUTH:
 *
 *   (1) DEPLOYS END-TO-END: the boot SUCCEEDS — `loadExtensions` resolved the pack (directory-only
 *       path-jailed, version-pin matched), merged its store/handler/route fragments, and `deploy()`
 *       materialized the pack store + registered the pack routes through the UNCHANGED pipeline.
 *   (2) PACK STORE rides the UNCHANGED migration gate + chokepoint probe: the pack-contributed
 *       `blob_chunks` table EXISTS in the live DB (the migration applied it — NO new migration path),
 *       and a real tenant-scoped write/read round-trips through it (the chokepoint admitted it).
 *   (3) MERGED ROUTES SERVE: a real binary INGEST POST → 200-ack (the ingest stream arm, via the pack);
 *       a real PLAYBACK GET with a minted media token + a Range header → 206 with the exact bytes (the
 *       playback stream arm, via the pack). The whole stream surface is CARRIED by the pack mechanism.
 *   (4) VERSION-PIN FAIL-CLOSED (fail-the-fix): a thin spec pinning a version the pack does NOT
 *       declare ABORTS the boot with the SKEW error (never a silent skip).
 *
 * DB ISOLATION: a whole throwaway DATABASE (mirrors stream-blob-boot.db.test.ts / boot.smoke) — the
 * migration chain materializes the platform into a database, so per-schema isolation does not fit.
 * Skips cleanly when DATABASE_URL is absent.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/server/src -> repo-root/examples/stream-backend (the THIN pack-referencing deployment dir).
const STREAM_DIR = resolve(here, '../../../../examples/stream-backend');
const FULL_YAML_PATH = resolve(STREAM_DIR, 'rayspec.yaml');

const MEDIA_SECRET = 'media-secret-at-least-32-bytes-xxxxxxxx';

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

const SUITE_DB = `rayspec_server_pack_${process.pid}`;

describe('extension-pack mechanism end-to-end (real composition root + DB)', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed extension-pack suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'stream-pack.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
        'refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let appDbUrl = '';
  let tmpDir = '';
  let blobRoot = '';
  let skewSpecPath = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_HANDLER_ROOT',
    'RAYSPEC_BLOB_ROOT',
    'RAYSPEC_MEDIA_SIGNING_KEY',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-pack-'));
    blobRoot = join(tmpDir, 'blobs');
    // A SKEW spec: references the pack but pins a version the pack manifest does NOT declare → abort.
    skewSpecPath = join(tmpDir, 'skew.yaml');
    writeFileSync(
      skewSpecPath,
      `version: '1.0'
metadata:
  name: stream-pack-skew
  description: a thin spec pinning the WRONG pack version (must abort)
extensions:
  - id: stream_pack
    module: ./packs/stream-pack
    version: 9.9.9
`,
      'utf8',
    );

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'stream-pack-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8804';
    // The pack carries a stream + playback route → a blob backend + a media key are required.
    process.env.RAYSPEC_BLOB_ROOT = blobRoot;
    process.env.RAYSPEC_MEDIA_SIGNING_KEY = MEDIA_SECRET;
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

  /** Register → org → switch → a member token (store:write gates the stream ingest). */
  async function principal(
    app: BootedServer['app'],
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; token: string }> {
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
      body: JSON.stringify({ name: orgName }),
    });
    expect(orgRes.status).toBe(201);
    const orgId = (await orgRes.json()).id as string;
    const switchRes = await app.request(`/v1/orgs/${orgId}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t0}` },
    });
    expect(switchRes.status).toBe(200);
    const token = (await switchRes.json()).accessToken as string;
    return { orgId, token };
  }

  maybe(
    '(1)+(2)+(3) the pack DEPLOYS; its store materializes (migration gate + chokepoint); the merged ingest + playback routes serve',
    async () => {
      // The THIN deployment spec references the pack; the handler root = the deployment dir (the packs
      // root). assembleServer runs the REAL pack merge + deploy().
      process.env.RAYSPEC_SPEC_PATH = FULL_YAML_PATH;
      process.env.RAYSPEC_HANDLER_ROOT = STREAM_DIR;

      const config = loadServerConfig();
      server = await assembleServer(config, {
        registerProductTables: (tables) => {
          // The A1 LOCAL stand-in: register THESE exact (pack-contributed) product-table instances.
          registerScopedTables([...tables.values()]);
        },
      });

      // (2) GROUND TRUTH — the PACK store materialized through the UNCHANGED migration gate. Query the
      //     live DB directly for the pack-contributed `blob_chunks` table (a pack store rode the
      //     SAME migration SQL as an inline store — NO new migration path).
      const sql = postgres(appDbUrl, { max: 1 });
      try {
        const rows = (await sql.unsafe(
          "select to_regclass('public.blob_chunks') as t",
        )) as unknown as Array<{ t: string | null }>;
        expect(rows[0]?.t).toBe('blob_chunks'); // the pack store exists in the live DB.
      } finally {
        await sql.end();
      }

      // (3a) the merged INGEST route serves (the ingest stream arm, via the pack): a raw binary POST → 200.
      const { orgId, token } = await principal(server.app, 'pack-e2e@example.test', 'Pack E2E Co');
      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x10, 0x20, 0x30]);
      const ingest = await server.app.request('/uploads/upl-pack/chunks/0', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: bytes,
      });
      expect(ingest.status).toBe(200);
      expect(await ingest.json()).toEqual({ next_expected_index: 1 });

      // (3b) the merged MINT route mints a media token for the caller's own chunk (a {handler} route).
      const mintRes = await server.app.request('/uploads/upl-pack/chunks/0/play-token', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(mintRes.status).toBe(200);
      const playToken = (await mintRes.json()).token as string;
      expect(typeof playToken).toBe('string');

      // (3c) the merged PLAYBACK route serves a Range/206 with the exact bytes (the playback stream arm).
      const playback = await server.app.request(
        `/uploads/upl-pack/chunks/0/playback?token=${encodeURIComponent(playToken)}`,
        { method: 'GET', headers: { range: 'bytes=0-3' } },
      );
      expect(playback.status).toBe(206);
      const back = new Uint8Array(await playback.arrayBuffer());
      expect([...back]).toEqual([...bytes.slice(0, 4)]); // bytes 0..3 inclusive.

      // (2-bis) the chokepoint admitted the pack store for a real tenant-scoped read: a FULL playback
      // GET returns the whole chunk (proving the pointer row + blob round-trip through the tenant scope).
      const fullGet = await server.app.request(
        `/uploads/upl-pack/chunks/0/playback?token=${encodeURIComponent(playToken)}`,
        { method: 'GET' },
      );
      expect(fullGet.status).toBe(200);
      void orgId;
    },
    120_000,
  );

  maybe(
    '(4) VERSION-PIN FAIL-CLOSED: a spec pinning a version the pack does NOT declare ABORTS the boot',
    async () => {
      // The skew spec pins 9.9.9; the pack manifest declares 1.0.0 → loadExtensions must abort the boot
      // with the SKEW error (NEVER a silent skip). FAIL-THE-FIX: turning the version
      // check into a silent skip would let this boot SUCCEED → this assertion goes RED.
      process.env.RAYSPEC_SPEC_PATH = skewSpecPath;
      process.env.RAYSPEC_HANDLER_ROOT = STREAM_DIR;

      const config = loadServerConfig();
      let caught: unknown;
      try {
        await assembleServer(config, {
          registerProductTables: (tables) => {
            registerScopedTables([...tables.values()]);
          },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BootConfigError);
      expect((caught as BootConfigError).message).toMatch(/version SKEW/i);
      expect((caught as BootConfigError).message).toContain('9.9.9'); // the spec's wrong pin.
      expect((caught as BootConfigError).message).toContain('1.0.0'); // the pack's real version.
    },
    120_000,
  );
});
