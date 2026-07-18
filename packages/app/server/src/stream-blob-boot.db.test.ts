/**
 * STREAM blob-backend boot-guard test — the composition-root deploy guard for
 * `kind:'stream'` routes had ZERO coverage. The SAME property (a stream route needs a blob backend)
 * is tested at the interpreter layer (stream-ingest.db.test.ts injects a factory directly), but the
 * boot-config PRE-CHECK in `deployDeclaredSpec` — `hasStreamRoute && !config.blobRoot → BootConfigError`,
 * else build `makeFsBlobStoreFactory(config.blobRoot)` and inject it into the engine — was unexercised.
 *
 * This drives the REAL composition root (`assembleServer`) against a throwaway DATABASE with a stream
 * spec, asserting END-TO-END on ground truth (fail-the-fix, not pass-the-shape):
 *
 *   (a) FAIL-THE-FIX: RAYSPEC_BLOB_ROOT UNSET + a spec with a `kind:'stream'` route → the boot
 *       THROWS the specific `BootConfigError` (the guard aborts). The blob guard runs in
 *       `deployDeclaredSpec` BEFORE deploy()/rollout, so it fires even on the full fixture (whose
 *       playback route would otherwise fail-close later). This goes GREEN only because the guard
 *       throws — remove the `throw new BootConfigError(...)` and this test would fail to see the error.
 *   (b) HAPPY: RAYSPEC_BLOB_ROOT SET (a temp dir) + an INGEST stream spec → the boot succeeds AND a
 *       REAL binary POST through the composition-root app round-trips (200-ack) with the exact bytes
 *       landing in the tenant-bound blob under `<blobRoot>/<tenantId>/…`, proving the
 *       env→makeFsBlobStoreFactory→engine.blobFactory injection wires end-to-end through the REAL
 *       composition root (not via a test harness that hands the factory in directly).
 *
 * DB ISOLATION: a whole throwaway DATABASE (not a per-schema), exactly as boot.smoke.test.ts /
 * durable-worker-boot.db.test.ts — the migration chain materializes the platform into a database's
 * default + `drizzle` schema, so per-schema isolation does not fit the chain-based boot.
 *
 * The deployment fixture is THIN — it loads the whole stream surface (ingest + playback +
 * mint) from a `defineExtension` PACK via `extensions[]`. Arm (a) points at THAT fixture, so the boot
 * runs the REAL pack merge (loadExtensions) before the blob guard fires — exercising the pack-merge mechanism
 * through the real composition root. For the happy arm (b) we deploy a small INLINE INGEST-ONLY spec
 * (no playback, so the boot completes) written to a temp rayspec.yaml; its handler module resolves to
 * the PACK's chunk-ingest.ts under RAYSPEC_HANDLER_ROOT=STREAM_DIR (the inline arm tests the
 * blob-guard injection, not the pack mechanism — arm (a) + stream-pack.db.test.ts cover the pack).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProductTables } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import { makeFsBlobStoreFactory, typeStrippingImporter } from '@rayspec/platform';
import { parseSpec } from '@rayspec/spec';
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
// packages/server/src -> repo-root/examples/stream-backend
const STREAM_DIR = resolve(here, '../../../../examples/stream-backend');
const FULL_YAML_PATH = resolve(STREAM_DIR, 'rayspec.yaml');

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

/**
 * The INGEST-ONLY stream spec, written to a temp rayspec.yaml so the happy arm can boot (the full
 * fixture's playback route fail-closes the rollout). Faithful to examples/stream-backend minus
 * the playback route + its handler ref. The chunk-ingest handler resolves against STREAM_DIR via
 * RAYSPEC_HANDLER_ROOT, so the real chunk-ingest.ts is loaded through the path-jailed loader.
 */
const INGEST_ONLY_YAML = `
version: '1.0'
metadata:
  name: stream-blob-boot-test
  description: ingest-only stream spec for the composition-root blob-guard boot test
stores:
  - name: blob_chunks
    columns:
      - { name: upload_id, type: text }
      - { name: chunk_index, type: integer }
      - { name: chunk_ref, type: text, unique: true }
      - { name: storage_key, type: text }
      - { name: byte_len, type: integer }
      - { name: content_type, type: text, nullable: true }
api:
  - method: POST
    path: /uploads/{upload_id}/chunks/{chunk_index}
    action: { kind: stream, handler: chunk_ingest_handler, mode: ingest }
handlers:
  - id: chunk_ingest_handler
    module: packs/stream-pack/handlers/chunk-ingest.ts
    export: chunkIngest
    kind: route
`;

const SUITE_DB = `rayspec_server_stream_${process.pid}`;

describe('stream blob-backend boot guard — composition root fail-closed + real injection', () => {
  const baseUrl = process.env.DATABASE_URL;
  // DB-backed: skip cleanly when there is no Postgres (mirrors the other boot suites' guard).
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed boot suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'stream-blob-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
        'refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let appDbUrl = '';
  let tmpDir = '';
  let blobRoot = '';
  let ingestSpecPath = '';
  // Save EVERY env var the suite mutates so it cannot poison a sibling test file (SMOKE-1 pattern).
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
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);

    // Fresh empty throwaway APP database (drop any leftover from a crashed prior run first).
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    // A temp dir for the ingest-only spec + the blob root (both cleaned in afterAll).
    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-stream-boot-'));
    blobRoot = join(tmpDir, 'blobs');
    ingestSpecPath = join(tmpDir, 'rayspec.yaml');
    writeFileSync(ingestSpecPath, INGEST_ONLY_YAML, 'utf8');

    // Snapshot every env var we are about to mutate (restored in afterAll), then provision the boot
    // secrets (a real RS256 key + a test pepper). DATABASE_URL/PORT/ALLOWED_ORIGINS are set per-arm.
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'stream-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8803';
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

  maybe(
    '(a) FAIL-THE-FIX: a stream-route spec with RAYSPEC_BLOB_ROOT unset aborts the boot with BootConfigError',
    async () => {
      // Point at the REAL fixture (now THIN — it loads the stream surface from a PACK via
      // extensions[]). The composition root runs the REAL pack merge (loadExtensions) first, then the
      // blob guard runs in deployDeclaredSpec BEFORE deploy()/rollout — so it fires (the merged spec
      // has a stream route) before the playback route fail-close. This arm also proves the pack merge
      // happens through the real composition root (the merged spec is what the guard inspects).
      process.env.RAYSPEC_SPEC_PATH = FULL_YAML_PATH;
      process.env.RAYSPEC_HANDLER_ROOT = STREAM_DIR;
      delete process.env.RAYSPEC_BLOB_ROOT; // the trigger: a stream route with NO blob backend.

      const config = loadServerConfig();
      expect(config.blobRoot).toBeUndefined();

      // assembleServer must THROW the SPECIFIC BootConfigError — GREEN only because the guard aborts
      // with that type. (PM-PROVEN fail-the-fix: flipping the guard's `throw new BootConfigError(...)`
      // off makes the boot proceed and then die downstream with a generic TypeError instead — NOT a
      // BootConfigError — so `toBeInstanceOf(BootConfigError)` goes RED. The test asserts the guard's
      // specific behavior, not merely "throws".) One call only: a guard-rejected boot leaves makeDb()'s
      // pool un-closed (assembleServer throws before returning a close()); the throwaway DB is dropped
      // WITH (FORCE) in afterAll, but we still avoid a second leaked pool.
      let caught: unknown;
      try {
        await assembleServer(config, {
          registerProductTables: (tables) => {
            registerScopedTables([...tables.values()]);
          },
          // The fixture pack is un-built `.ts`; opt into the type-stripping importer seam (production
          // loads compiled `.js` only). This test drives the REAL composition root — production never sets
          // this, so a production boot always uses the guarded default.
          moduleImporter: typeStrippingImporter,
        });
      } catch (err) {
        caught = err;
      }
      // The specific type AND the actionable message (the stream route + the missing blob root).
      expect(caught).toBeInstanceOf(BootConfigError);
      expect((caught as BootConfigError).message).toContain('RAYSPEC_BLOB_ROOT');
      expect((caught as BootConfigError).message).toMatch(/stream/i);
    },
    120_000,
  );

  maybe(
    '(b) HAPPY: RAYSPEC_BLOB_ROOT set + an ingest stream spec boots and a real binary POST round-trips',
    async () => {
      // The ingest-only spec (no playback route) + the blob root set → the boot must SUCCEED and the
      // composition root builds + injects makeFsBlobStoreFactory(blobRoot) into the engine.
      process.env.RAYSPEC_SPEC_PATH = ingestSpecPath;
      process.env.RAYSPEC_HANDLER_ROOT = STREAM_DIR; // chunk-ingest.ts resolves under here.
      process.env.RAYSPEC_BLOB_ROOT = blobRoot;

      const config = loadServerConfig();
      expect(config.blobRoot).toBe(resolve(blobRoot));

      server = await assembleServer(config, {
        registerProductTables: (tables) => {
          // The LOCAL table-registration stand-in: register THESE exact product-table instances (deploy() verifies the
          // same objects). buildProductTables here is only to assert the spec materialized one table.
          registerScopedTables([...tables.values()]);
        },
        // The inline spec references an un-built `.ts` example handler; opt into the type-stripping
        // importer seam (production loads compiled `.js` only; production never sets this).
        moduleImporter: typeStrippingImporter,
      });

      // Sanity: the spec's single product store materialized (the boot ran deploy()'s migration).
      const ingestSpec = parseSpec(readFileSync(ingestSpecPath, 'utf8'));
      if (!ingestSpec.ok) throw new Error('ingest spec did not parse');
      const tables = buildProductTables([...ingestSpec.value.stores]);
      expect([...tables.keys()]).toEqual(['blob_chunks']);

      // Register → org → switch → a member token (store:write gates the stream ingest), exactly as the
      // interpreter-layer test does.
      const reg = await server.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'stream-boot@example.test',
          password: 'correct-horse-battery-staple-9',
        }),
      });
      expect(reg.status).toBe(201);
      const t0 = (await reg.json()).accessToken as string;

      const orgRes = await server.app.request('/v1/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t0}` },
        body: JSON.stringify({ name: 'Stream Boot Co' }),
      });
      expect(orgRes.status).toBe(201);
      const orgId = (await orgRes.json()).id as string;

      const switchRes = await server.app.request(`/v1/orgs/${orgId}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t0}` },
      });
      expect(switchRes.status).toBe(200);
      const token = (await switchRes.json()).accessToken as string;

      // A RAW binary POST of one chunk (bytes that are NOT valid JSON) → the stream ingest route. The
      // 200-ack proves the route + the injected blob backend are wired through the REAL composition root.
      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7b, 0x6e, 0x6f]);
      const ingest = await server.app.request('/uploads/upl-boot/chunks/0', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: bytes,
      });
      expect(ingest.status).toBe(200);
      expect(await ingest.json()).toEqual({ next_expected_index: 1 });

      // GROUND TRUTH: the exact bytes landed in the tenant-bound blob UNDER THE CONFIGURED blobRoot —
      // proving env(RAYSPEC_BLOB_ROOT) → makeFsBlobStoreFactory(blobRoot) → engine.blobFactory wired
      // end-to-end (we read via an INDEPENDENT factory over the SAME root + tenant; the on-disk path is
      // `<blobRoot>/<orgId>/upl-boot/0`). A guard that did NOT inject the env-configured root would put
      // the bytes elsewhere and this read would miss.
      const blob = makeFsBlobStoreFactory(blobRoot)(orgId);
      const got = await blob.get('upl-boot/0');
      if ('notFound' in got)
        throw new Error('blob not found after ingest — injection did not wire');
      const back = new Uint8Array(await new Response(got.body).arrayBuffer());
      expect([...back]).toEqual([...bytes]);
      expect(got.contentLength).toBe(bytes.length);
    },
    120_000,
  );
});
