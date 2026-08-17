/**
 * A boot that trips the RESERVED-PATH rule leaves NO product schema behind — proved by INSPECTING the
 * live catalog after the refusal, not by reading an exit code.
 *
 * A declared `api[]` route may not claim a path the platform registers itself (`/v1/`, `/oidc/`, the
 * two readiness probes, a declared static frontend mount). That is a fact about the DOCUMENT: it needs
 * no schema, no connection and no roll-out to decide. So it is decided at the document gate, before the
 * deploy pipeline reaches its migrate step — and a deployment refused for it carries none of the
 * document's PRODUCT DDL, rather than the tables of a roll-out that never served a request. (Not "no
 * DDL at all": the platform's own migration chain runs earlier in the boot, so a refusal on a fresh
 * database still leaves the platform tables. It is the product half this rule is about, and the arms
 * below read exactly that — the presence of `notes`.)
 *
 * The harness is `mount-without-deploy.db.test.ts`'s (a whole throwaway DATABASE, env save/restore,
 * `loadServerConfig` + `assembleServer`, drop on teardown), and it runs against ONE database across the
 * arms because the point is what each boot did (and did not) leave in it:
 *
 *   1. refusal      — the document claiming `/health` is REFUSED and `notes` is ABSENT from the catalog.
 *   2. accept       — the SAME document with the route at `/healthy` boots, and `notes` IS in the
 *                     catalog: the ACCEPT CONTROL for arm 1's absence reading (a probe that could never
 *                     see the table would report "absent" for a boot that materialized it).
 *   3. two faults   — a document wrong in TWO ways (the reserved path AND a handler module that is not
 *                     on disk) reports the reserved path, which is the fault an author can see and fix
 *                     without a database at all.
 *
 * UN-SKIPPABLE RAN-GUARD (the false-green class): a DB-backed proof must never silently self-skip. A
 * separate, NON-skipped describe hard-FAILS when the DB is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but
 * the arms did not run.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, BootConfigError, loadServerConfig } from './composition-root.js';

/** The document under test: one store, and a declared route claiming the generic readiness probe. */
const CLAIMS_HEALTH = `
version: '1.0'
metadata:
  name: reserved-route-boot
  description: a declared route claiming a platform path
stores:
  - name: notes
    columns:
      - { name: body, type: text }
api:
  - { method: GET, path: '/health', action: { kind: store, store: notes, op: list } }
`;

/** The ACCEPT control: the same document with the route one character outside the reserved set. */
const CLAIMS_HEALTHY = CLAIMS_HEALTH.replace("'/health'", "'/healthy'");

/** Wrong in TWO ways at once: the reserved path AND a handler module that is not on disk. */
const TWO_FAULTS = `
version: '1.0'
metadata:
  name: reserved-route-boot-two-faults
  description: a reserved path and a handler module that is not on disk
stores:
  - name: notes
    columns:
      - { name: body, type: text }
api:
  - { method: GET, path: '/health', action: { kind: handler, handler: list_notes } }
handlers:
  - { id: list_notes, module: handlers/absent.mjs, export: listNotes, kind: route }
`;

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

const SUITE_DB = `rayspec_server_reserved_route_${process.pid}`;

let armsRan = 0;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

describe('reserved-path refusal — no product DDL is committed', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;

  let appDbUrl = '';
  let dbosSysDb = '';
  let tmpDir = '';
  let claimsHealthPath = '';
  let claimsHealthyPath = '';
  let twoFaultsPath = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    dbosSysDb = `${SUITE_DB}_dbos_sys`; // no worker in these documents; dropped defensively anyway.

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-reserved-route-boot-'));
    claimsHealthPath = join(tmpDir, 'claims-health.yaml');
    claimsHealthyPath = join(tmpDir, 'claims-healthy.yaml');
    twoFaultsPath = join(tmpDir, 'two-faults.yaml');
    writeFileSync(claimsHealthPath, CLAIMS_HEALTH, 'utf8');
    writeFileSync(claimsHealthyPath, CLAIMS_HEALTHY, 'utf8');
    writeFileSync(twoFaultsPath, TWO_FAULTS, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'reserved-route-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8807';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  /** Boot the real composition root against the throwaway DB with the given document. */
  async function boot(whichSpecPath: string): Promise<{ close: () => Promise<void> }> {
    process.env.RAYSPEC_SPEC_PATH = whichSpecPath;
    const config = loadServerConfig();
    return assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
    });
  }

  /** Is a table of this name in the live catalog? Asked on a connection of the test's own. */
  async function tableExists(name: string): Promise<boolean> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      const rows = await client`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${name}
      `;
      return rows.length > 0;
    } finally {
      await client.end();
    }
  }

  /** Boot ONCE and capture the refusal (never the server), so each arm reads a boot of its own. */
  async function refusal(whichSpecPath: string): Promise<{ error: unknown; message: string }> {
    const error = await boot(whichSpecPath).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (error === undefined) throw new Error(`expected the boot of ${whichSpecPath} to be refused`);
    return { error, message: error instanceof Error ? error.message : String(error) };
  }

  maybe(
    '(1) the refusal names the reserved prefix and leaves NO product table behind',
    async () => {
      armsRan++;
      const refused = await refusal(claimsHealthPath);
      expect(refused.message).toMatch(/is under a path this deployment reserves/);
      // The load-bearing reading: the catalog itself, not the exit code. A refusal raised while the
      // app was being assembled would already have committed this store's CREATE TABLE.
      expect(await tableExists('notes')).toBe(false);
      // And the refusal is a boot-config one — the document gate answered, not a deploy-pipeline
      // abort raised on a schema this boot had already written to.
      expect(refused.error).toBeInstanceOf(BootConfigError);
    },
    120_000,
  );

  maybe(
    '(2) ACCEPT CONTROL: the same document with a servable path materializes `notes`',
    async () => {
      armsRan++;
      const server = await boot(claimsHealthyPath);
      try {
        // The catalog probe of arm 1 CAN see a materialized store — its "absent" reading is a fact
        // about the refused boot, not about the query.
        expect(await tableExists('notes')).toBe(true);
      } finally {
        await server.close();
      }
    },
    120_000,
  );

  maybe(
    '(3) a document wrong in TWO ways reports the one an author can fix without a database',
    async () => {
      armsRan++;
      // The handler module is absent from the deployment tree too, which the deploy pipeline can only
      // discover once it is rolling out — i.e. after the migrate step. The document-shape fault is
      // decided first, so that is the refusal an operator reads.
      const refused = await refusal(twoFaultsPath);
      expect(refused.message).toMatch(/is under a path this deployment reserves/);
      expect(refused.message).not.toMatch(/handler load failed/);
    },
    120_000,
  );
});

/**
 * Ran-guard (the false-green class): a SEPARATE, NON-skipped describe that fails the run when the DB is
 * REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the arms above did NOT run — a CI run that lost
 * DATABASE_URL must never read as a green "no DDL is left behind" proof.
 */
describe('reserved-path refusal — ran-guard (the no-DDL proof must not silently skip in CI)', () => {
  it('the three arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(armsRan).toBe(3);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
