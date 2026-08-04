/**
 * The RAYSPEC_FS_SOURCE_ROOT boot refusal, on GROUND TRUTH through the REAL composition root, in BOTH
 * boot profiles that build the read-only fs-source factory:
 *   - the BACKEND spec path (`composition-root.ts` `deployDeclaredSpec`), and
 *   - the PRODUCT-YAML path (`product-boot.ts` `deployProductYamlSpec`).
 *
 * `makeFsSourceFactory` takes a plain `root: string` and legitimately cannot know which variable the
 * server resolved it from, so its refusal names the resolved path and nothing else. Each boot re-raises
 * it in its OWN house form, and these arms pin what an operator actually reads:
 *
 *   (a) ACCEPT CONTROL (both profiles): an EXISTING readable directory boots — the backend spec
 *       materializes + serves, and the Product-YAML doc composes + serves. Without this the reject arms
 *       below would be vacuous (any boot of these fixtures failing would satisfy them).
 *   (b) REJECT — a root that does not exist, and a root naming a REGULAR FILE, in both profiles: the
 *       boot aborts with the profile's own operator-actionable class (BootConfigError / ProductBootError),
 *       and the message names BOTH `RAYSPEC_FS_SOURCE_ROOT` and the offending resolved path. Drop the
 *       variable name from either message and these go RED — a later refactor cannot lose it silently.
 *   (c) FAIL-CLOSED: the refusing boot returns no server AND does not create the missing directory
 *       (asserted after each reject arm — nothing here is allowed to materialize a source root).
 *   (d) The entrypoint print: both classes sit in `serve.ts`'s message-only branch, so the refusal
 *       prints without a Node stack trace. `serve.ts`'s `main().catch(...)` is not importable (it runs
 *       under `isProcessEntrypoint()`), so the branch membership is pinned against its comment-stripped
 *       SOURCE as ONE shape — the same way boot-timeout.test.ts and serve-bind.test.ts pin the
 *       entrypoint's other wiring — while the CLASS of each refusal is measured at runtime above.
 *
 * DB ISOLATION: two whole throwaway DATABASEs named with process.pid (a backend one and a Product-YAML
 * one), exactly as the neighbouring boot suites. Skips without DATABASE_URL; the un-skippable ran-guard
 * hard-fails a REQUIRED run that did not run (the false-green class).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  assembleServer,
  BootConfigError,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';
import { ProductBootError } from './product-boot.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
// A NON-audio, zero-agent, no-stt product doc — it boots demanding NONE of the conditional env vars,
// so what these arms vary is RAYSPEC_FS_SOURCE_ROOT and nothing else.
const NON_AUDIO_YAML = resolve(here, '__fixtures__/non-audio-intake.product.yaml');

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SPEC_DB = `rayspec_fs_source_spec_${process.pid}`;
const PRODUCT_DB = `rayspec_fs_source_product_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-0000000000f7';

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('RAYSPEC_FS_SOURCE_ROOT — the boot refusal names the variable', () => {
  let specDbUrl = '';
  let productDbUrl = '';
  let specServer: BootedServer | undefined;
  let productServer: BootedServer | undefined;
  let fixtureDir = '';
  let goodRoot = '';
  let missingRoot = '';
  let fileRoot = '';
  let specPath = '';
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_FS_SOURCE_ROOT',
    'RAYSPEC_PRODUCT_TENANT_ID',
    'DBOS_SYSTEM_DATABASE_URL',
  ] as const;

  /** Boot the REAL composition root with RAYSPEC_FS_SOURCE_ROOT pointed at `root`. */
  async function boot(spec: string, dbUrl: string, root: string): Promise<BootedServer> {
    process.env.DATABASE_URL = dbUrl;
    process.env.RAYSPEC_SPEC_PATH = spec;
    process.env.RAYSPEC_FS_SOURCE_ROOT = root;
    const config = loadServerConfig();
    return assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
    });
  }

  /** The rejected boot's error — and the fail-closed half: no server, and no directory created. */
  async function refusalOf(spec: string, dbUrl: string, root: string): Promise<unknown> {
    let caught: unknown;
    let booted: BootedServer | undefined;
    try {
      booted = await boot(spec, dbUrl, root);
    } catch (err) {
      caught = err;
    }
    if (booted) {
      await booted.close();
      throw new Error(`the boot with RAYSPEC_FS_SOURCE_ROOT='${root}' SERVED — it must refuse`);
    }
    return caught;
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    specDbUrl = withDbName(baseUrl, SPEC_DB);
    productDbUrl = withDbName(baseUrl, PRODUCT_DB);

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      for (const d of [`${PRODUCT_DB}_dbos_sys`, SPEC_DB, PRODUCT_DB]) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
      }
      for (const d of [SPEC_DB, PRODUCT_DB]) await admin.unsafe(`CREATE DATABASE "${d}"`);
    } finally {
      await admin.end();
    }

    // The three roots under test: an existing readable directory (the accept control), a path that
    // does not exist, and a path naming a REGULAR FILE.
    fixtureDir = mkdtempSync(join(tmpdir(), 'rayspec-fs-source-root-'));
    goodRoot = join(fixtureDir, 'source-root');
    mkdirSync(goodRoot, { recursive: true });
    writeFileSync(join(goodRoot, 'note.md'), '# deployment-static\n', 'utf8');
    missingRoot = join(fixtureDir, 'does-not-exist');
    fileRoot = join(fixtureDir, 'not-a-directory.txt');
    writeFileSync(fileRoot, 'a regular file, not a source root\n', 'utf8');

    // The backend-profile spec: a plain store + one declared route (no frontend, no agents, no
    // stream) — the smallest spec that reaches the fs-source factory build.
    specPath = join(fixtureDir, 'rayspec.yaml');
    writeFileSync(
      specPath,
      `version: '1.0'
metadata:
  name: fs-source-root-boot
stores:
  - name: notes
    columns:
      - { name: title, type: text }
api:
  - { method: GET, path: '/api/notes', action: { kind: store, store: notes, op: list } }
`,
      'utf8',
    );

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'fs-source-root-boot-pepper-only';
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.PORT = '8809';
    process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;

    // The Product-YAML deployment binds to a LIVE org; seed it before any arm boots, or that refusal
    // would pre-empt the fs-source refusal these arms exist to pin.
    const seed = makeDb(productDbUrl);
    try {
      await applyMigrations(seed);
      await seed.$client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'FsSource', 'fss')`,
        [TENANT],
      );
    } finally {
      await seed.$client.end();
    }
  }, 180_000);

  afterAll(async () => {
    await specServer?.close();
    if (productServer?.durableExecutorShutdown) await productServer.durableExecutorShutdown();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        for (const d of [`${PRODUCT_DB}_dbos_sys`, SPEC_DB, PRODUCT_DB]) {
          await admin.unsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
        }
      } finally {
        await admin.end();
      }
    }
  }, 120_000);

  // ── (a) the ACCEPT control, backend profile ────────────────────────────────────────────────────

  it('ACCEPT: an existing readable directory boots the backend spec and it serves', async () => {
    specServer = await boot(specPath, specDbUrl, goodRoot);
    expect(specServer.deployMode).toBe('materialized');
    expect(specServer.declaredRoutes.map((r) => `${r.method} ${r.path}`)).toContain(
      'GET /api/notes',
    );
    const res = await specServer.app.request('/health');
    expect(res.status).toBe(200);
    armsRan += 1;
  }, 180_000);

  // ── (b)+(c) the backend-profile rejects ────────────────────────────────────────────────────────

  it('REJECT: a MISSING root aborts the backend boot naming RAYSPEC_FS_SOURCE_ROOT and the path', async () => {
    const caught = await refusalOf(specPath, specDbUrl, missingRoot);
    expect(caught).toBeInstanceOf(BootConfigError);
    const message = (caught as Error).message;
    expect(message).toContain('RAYSPEC_FS_SOURCE_ROOT');
    expect(message).toContain(missingRoot);
    // The operator reads this message and nothing else — pin it whole, house prefix included.
    expect(message).toBe(
      `Boot aborted — RAYSPEC_FS_SOURCE_ROOT='${missingRoot}' does not exist or is not a ` +
        'directory. It is the READ-ONLY source root `init.fsSource` reads under; point it at an ' +
        'existing directory on the box (nothing here creates it). Fail-closed.',
    );
    // FAIL-CLOSED: the refusal never materializes the root it refused.
    expect(existsSync(missingRoot)).toBe(false);
    armsRan += 1;
  }, 180_000);

  it('REJECT: a root naming a REGULAR FILE aborts the backend boot naming the variable and the path', async () => {
    const caught = await refusalOf(specPath, specDbUrl, fileRoot);
    expect(caught).toBeInstanceOf(BootConfigError);
    const message = (caught as Error).message;
    expect(message).toContain('RAYSPEC_FS_SOURCE_ROOT');
    expect(message).toContain(fileRoot);
    expect(message).toContain('Fail-closed');
    armsRan += 1;
  }, 180_000);

  // ── (b)+(c) the Product-YAML rejects (they throw at step 3, before any DBOS launch) ────────────

  it('REJECT: a MISSING root aborts the Product-YAML boot naming RAYSPEC_FS_SOURCE_ROOT and the path', async () => {
    const caught = await refusalOf(NON_AUDIO_YAML, productDbUrl, missingRoot);
    expect(caught).toBeInstanceOf(ProductBootError);
    const message = (caught as Error).message;
    expect(message).toContain('RAYSPEC_FS_SOURCE_ROOT');
    expect(message).toContain(missingRoot);
    // Pinned whole, including the `Boot aborted (Product-YAML) — ` prefix this boot's own class adds.
    expect(message).toBe(
      `Boot aborted (Product-YAML) — RAYSPEC_FS_SOURCE_ROOT='${missingRoot}' does not exist or is ` +
        'not a directory. It is the READ-ONLY source root `init.fsSource` reads under; point it at ' +
        'an existing directory on the box (nothing here creates it). Fail-closed.',
    );
    expect(existsSync(missingRoot)).toBe(false);
    armsRan += 1;
  }, 180_000);

  it('REJECT: a root naming a REGULAR FILE aborts the Product-YAML boot naming the variable and the path', async () => {
    const caught = await refusalOf(NON_AUDIO_YAML, productDbUrl, fileRoot);
    expect(caught).toBeInstanceOf(ProductBootError);
    const message = (caught as Error).message;
    expect(message).toContain('RAYSPEC_FS_SOURCE_ROOT');
    expect(message).toContain(fileRoot);
    expect(message).toContain('Fail-closed');
    armsRan += 1;
  }, 180_000);

  // ── (a) the ACCEPT control, Product-YAML profile (LAST — the one full DBOS launch) ─────────────

  it('ACCEPT: an existing readable directory boots the Product-YAML doc and it serves', async () => {
    productServer = await boot(NON_AUDIO_YAML, productDbUrl, goodRoot);
    expect(productServer.deployMode).toBe('materialized');
    expect(productServer.declaredRoutes.map((r) => `${r.method} ${r.path}`)).toContain(
      'POST /records/{record_id}/submit',
    );
    const res = await productServer.app.request('/records/rec-fss/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hello' }),
    });
    expect(res.status).toBe(401);
    armsRan += 1;
  }, 180_000);
});

// ── (d) the entrypoint print ───────────────────────────────────────────────────────────────────

describe('the entrypoint prints both refusal classes message-only, with no stack', () => {
  const src = readFileSync(join(here, 'serve.ts'), 'utf8');
  // Strip comments so the assertion reads the CODE, not prose that merely names the wiring.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('serve.ts routes BootConfigError and ProductBootError to the message-only branch', () => {
    // ONE shape, not three independent tokens: the whole guard condition through to the
    // message-only print. Naming the classes in separate assertions would let the branch be
    // rewired around them (e.g. `(false && err instanceof ProductBootError)`) and still read
    // green — measured — so the condition and the print it guards are matched together.
    expect(code).toMatch(
      /if\s*\(\s*err instanceof BootConfigError\s*\|\|\s*err instanceof DeployError\s*\|\|\s*err instanceof ProductBootError\s*\|\|\s*err instanceof BootTimeoutError\s*\)\s*\{\s*console\.error\(`\[rayspec-serve\] \$\{err\.message\}`\)/,
    );
  });
});

// UN-SKIPPABLE ran-guard: a REQUIRED run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost DATABASE_URL would
// otherwise SILENTLY SKIP the whole refusal proof and read GREEN.
describe('fs-source-root refusal ran-guard', () => {
  it('the accept + reject arms ran under a required DB run', () => {
    // 2 accept controls (backend + Product-YAML) + 4 rejects (missing / regular file, in both).
    if (dbRequired) expect(armsRan).toBeGreaterThanOrEqual(6);
    else expect(true).toBe(true);
  });
});
