/**
 * A boot that is going to refuse leaves the database exactly as it found it.
 *
 * WHAT THESE ARMS PROVE. The boot used to apply the platform migration chain first and only then
 * parse the injected spec and the signing key, so pointing a broken deploy at an EMPTY database
 * still created every platform table before the refusal. Each arm here points one kind of invalid
 * input — a backend spec that does not lint, a Product-YAML document that does not parse, one that
 * parses but fails the boot-scope gate, a malformed signing key — at an empty database, checks the
 * refusal is the one the deploy path always gave, and then checks the database still holds no
 * relation and no `drizzle` schema. The same holds for a backend document whose CONFIGURATION the
 * environment does not satisfy — a stream route without a blob root, a playback route without a
 * media signing key, an unsupported speech provider, a frontend mount with nothing to serve. The last arm boots a valid spec on the same database, so the
 * reordering changes nothing for a deployment that validates.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, BootConfigError, loadServerConfig } from './composition-root.js';
import { ProductBootError } from './product-boot.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_boot_validates_${process.pid}`;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

const VALID_SPEC = `
version: '1.0'
metadata:
  name: validates-first
  description: a valid backend spec with one store
stores:
  - name: first_notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/first-notes', action: { kind: store, store: first_notes, op: create } }
`;

// Lints red: the route names a store the document does not declare.
const INVALID_SPEC = `
version: '1.0'
metadata:
  name: validates-first
  description: a route over an undeclared store
stores:
  - name: first_notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/elsewhere', action: { kind: store, store: missing_store, op: create } }
`;

// A Product-YAML document (it has a product section) that does not parse: no contracts, no id.
const INVALID_PRODUCT_SPEC = `
version: "1.0"
product: { name: Broken }
`;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('the boot validates before it mutates', () => {
  let dbUrl = '';
  let dir = '';
  let validKey = '';
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
    'RAYSPEC_BLOB_ROOT',
    'RAYSPEC_MEDIA_SIGNING_KEY',
    'STT_PROVIDER',
  ] as const;

  /** Every relation outside the system schemas, plus whether a `drizzle` schema exists. */
  async function footprint(): Promise<{ relations: number; drizzle: boolean }> {
    const sql = postgres(dbUrl, { max: 1 });
    try {
      const [row] = (await sql.unsafe(`
        SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')) AS relations,
               EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') AS drizzle`)) as unknown as {
        relations: number;
        drizzle: boolean;
      }[];
      return row as { relations: number; drizzle: boolean };
    } finally {
      await sql.end();
    }
  }

  function specFile(name: string, text: string): string {
    const path = join(dir, name);
    writeFileSync(path, text, 'utf8');
    return path;
  }

  async function bootWith(specPath: string | undefined, jwtKey = validKey) {
    process.env.RAYSPEC_JWT_SIGNING_KEY = jwtKey;
    if (specPath === undefined) delete process.env.RAYSPEC_SPEC_PATH;
    else process.env.RAYSPEC_SPEC_PATH = specPath;
    return assembleServer(loadServerConfig(), {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
    });
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    dir = mkdtempSync(join(tmpdir(), 'rayspec-validates-first-'));
    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    validKey = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'validates-first-pepper';
    process.env.DATABASE_URL = dbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8814';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    delete process.env.RAYSPEC_BLOB_ROOT;
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;
    delete process.env.STT_PROVIDER;
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
  }, 60_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('an invalid backend spec is refused as before and the empty database stays empty', async () => {
    const path = specFile('invalid.yaml', INVALID_SPEC);
    const refused = await bootWith(path).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BootConfigError);
    expect((refused as Error).message).toContain(`injected spec at ${path} is invalid`);
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
    armsRan += 1;
  }, 60_000);

  it('a Product-YAML document that does not parse is refused and the database stays empty', async () => {
    const path = specFile('broken.product.yaml', INVALID_PRODUCT_SPEC);
    const refused = await bootWith(path).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProductBootError);
    expect((refused as Error).message).toContain(`the Product-YAML spec at ${path} is invalid`);
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
    armsRan += 1;
  }, 60_000);

  it('a Product-YAML document outside the boot scope is refused and the database stays empty', async () => {
    const refused = await bootWith(join(FIXTURES, 'out-of-scope-multiscope.product.yaml')).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ProductBootError);
    expect((refused as Error).message).toMatch(/multi-scope/);
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
    armsRan += 1;
  }, 60_000);

  it('a malformed signing key is refused and the database stays empty', async () => {
    const refused = await bootWith(undefined, 'not-a-pem').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BootConfigError);
    expect((refused as Error).message).toContain('RAYSPEC_JWT_SIGNING_KEY is not a PKCS#8 PEM');
    expect(await footprint()).toEqual({ relations: 0, drizzle: false });
    armsRan += 1;
  }, 60_000);

  it('a backend document whose configuration the environment does not satisfy is refused, database untouched', async () => {
    const handler = `
handlers:
  - { id: bytes_handler, module: handlers/bytes.mjs, export: bytes, kind: route }
`;
    const cases: { name: string; spec: string; env?: Record<string, string>; message: RegExp }[] = [
      {
        name: 'stream.yaml',
        spec: `${VALID_SPEC}  - method: POST
    path: /uploads/{id}
    action: { kind: stream, handler: bytes_handler, mode: ingest }
${handler}`,
        message: /declares a 'stream' route but no blob backend is configured/,
      },
      {
        name: 'playback.yaml',
        spec: `${VALID_SPEC}  - method: GET
    path: /media/{id}
    action: { kind: stream, handler: bytes_handler, mode: playback }
${handler}`,
        env: { RAYSPEC_BLOB_ROOT: dir },
        message: /stream PLAYBACK route but no media signing key is configured/,
      },
      {
        name: 'stt.yaml',
        spec: VALID_SPEC,
        env: { STT_PROVIDER: 'no-such-provider' },
        message: /STT_PROVIDER 'no-such-provider' is not supported/,
      },
      {
        name: 'frontend.yaml',
        spec: `${VALID_SPEC}frontend:
  - { route: /, dir: ./no-such-build, spa: true }
`,
        message: /static directory '\.\/no-such-build' .* is missing or unreadable/,
      },
    ];
    for (const c of cases) {
      for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = v;
      try {
        const refused = await bootWith(specFile(c.name, c.spec)).catch((e: unknown) => e);
        expect(refused, c.name).toBeInstanceOf(BootConfigError);
        expect((refused as Error).message, c.name).toMatch(c.message);
        expect(await footprint(), c.name).toEqual({ relations: 0, drizzle: false });
      } finally {
        for (const k of Object.keys(c.env ?? {})) delete process.env[k];
      }
    }
    armsRan += 1;
  }, 90_000);

  it('a valid spec on the same empty database boots exactly as before', async () => {
    const server = await bootWith(specFile('valid.yaml', VALID_SPEC));
    try {
      expect(server.deployMode).toBe('materialized');
      const after = await footprint();
      expect(after.drizzle).toBe(true);
      expect(after.relations).toBeGreaterThan(0);
      const health = await server.app.request('/health');
      expect(health.status).toBe(200);
    } finally {
      await server.close();
    }
    armsRan += 1;
  }, 90_000);

  it('a boot refused after it read the source fence leaves no heartbeat behind', async () => {
    // The previous arm materialized the store; take a column away so the next boot refuses on drift,
    // after the platform chain and after it announced itself to the fence.
    const sql = postgres(dbUrl, { max: 1 });
    try {
      await sql.unsafe('ALTER TABLE first_notes DROP COLUMN body');
      const refused = await bootWith(specFile('valid.yaml', VALID_SPEC)).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(BootConfigError);
      expect((refused as Error).message).toMatch(/DRIFTED/);
      // Not a live, undrained process to the next quiesce.
      const [row] = await sql.unsafe('SELECT count(*)::int AS n FROM runtime_control_processes');
      expect(row).toEqual({ n: 0 });
    } finally {
      await sql.end();
    }
    armsRan += 1;
  }, 90_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(7);
  else expect(true).toBe(true);
});
