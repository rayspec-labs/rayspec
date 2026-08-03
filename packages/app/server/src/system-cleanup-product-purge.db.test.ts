/**
 * The GDPR purge GATE, armed, on a PRODUCT-YAML boot — the gate-ON direction of the daily SYSTEM
 * cleanup. `RAYSPEC_GDPR_PURGE_ENABLED=true` is documented as the operator's deliberate opt-in to the
 * irreversible tombstone hard-delete; on a `*.product.yaml` deployment it must actually delete.
 *
 * Boots the REAL composition root (`assembleServer` → `deployProductYamlSpec`) against a throwaway
 * DATABASE with a real DBOS launch and the gate ARMED, then runs the cleanup through the booted
 * server's on-demand seam (the EXACT path the daily scheduled-workflow body fires on) and asserts on
 * GROUND TRUTH:
 *
 *   - `gdpr.mode === 'enabled'` and a PAST-RETENTION user tombstone is GONE from the table;
 *   - a tombstone INSIDE the retention window survives (the cutoff has teeth in both directions);
 *   - the LIVE, ungated OIDC prune deletes the expired row on the same run.
 *
 * The default (3am) crontab is deliberately left in place here so nothing fires concurrently and the
 * counts the seam returns are exactly what this call did. The gate-OFF direction + the registration
 * proof live in `system-cleanup-product-boot.db.test.ts` (DBOS is a process-global singleton — one
 * launch per process, so the second gate state needs a second process).
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDb } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  assembleServer,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const INTAKE_YAML = resolve(here, '__fixtures__/non-audio-intake.product.yaml');

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_cleanup_prod_purge_${process.pid}`;
const DBOS_SYS_DB = `${SUITE_DB}_dbos_sys`;
const TENANT = '00000000-0000-4000-8000-0000000000e2';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Past the 30-day retention default ⇒ eligible. */
const OLD_TOMBSTONE_DAYS = 90;
/** Inside the 30-day retention default ⇒ NOT eligible. */
const YOUNG_TOMBSTONE_DAYS = 2;

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

describe.skipIf(!baseUrl)('Product-YAML boot — the ARMED GDPR purge actually deletes', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
  let sql: postgres.Sql | undefined;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
    'RAYSPEC_PRODUCT_TENANT_ID',
    'RAYSPEC_CLEANUP_SCHEDULE',
    'RAYSPEC_GDPR_PURGE_ENABLED',
    'RAYSPEC_GDPR_RETENTION_DAYS',
  ] as const;

  async function seedUserTombstone(days: number): Promise<string> {
    const rows = (await sql!.unsafe(
      `INSERT INTO users (email, deleted_at) VALUES ($1, $2) RETURNING id`,
      [`purge-tombstone-${days}d@invalid`, new Date(Date.now() - days * MS_PER_DAY).toISOString()],
    )) as unknown as Array<{ id: string }>;
    return rows[0]!.id;
  }
  async function userExists(id: string): Promise<boolean> {
    const rows = await sql!.unsafe('SELECT 1 FROM users WHERE id = $1', [id]);
    return rows.length > 0;
  }
  async function oidcIds(): Promise<string[]> {
    const rows = (await sql!.unsafe('SELECT id FROM oidc_models ORDER BY id')) as unknown as Array<{
      id: string;
    }>;
    return rows.map((r) => r.id);
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'cleanup-purge-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8812';
    process.env.RAYSPEC_SPEC_PATH = INTAKE_YAML;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
    // The OPERATOR gate, armed exactly as an operator arms it. Default crontab (3am) so only the
    // on-demand call runs during the test; default retention (30 days).
    delete process.env.RAYSPEC_CLEANUP_SCHEDULE;
    process.env.RAYSPEC_GDPR_PURGE_ENABLED = 'true';
    delete process.env.RAYSPEC_GDPR_RETENTION_DAYS;

    const seed = makeDb(appDbUrl);
    try {
      await applyMigrations(seed);
      await seed.$client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Purge', 'purge')`, [
        TENANT,
      ]);
    } finally {
      await seed.$client.end();
    }

    sql = postgres(appDbUrl, { max: 2 });
    const config = loadServerConfig();
    server = await assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
    });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await sql?.end();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  const maybe = baseUrl ? it : it.skip;

  maybe(
    'gate ARMED: the past-retention tombstone is hard-deleted, the in-window one survives, and the expired oidc row is pruned',
    async () => {
      armsRan += 1;
      expect(typeof server?.runCleanupNow).toBe('function');

      const old = await seedUserTombstone(OLD_TOMBSTONE_DAYS);
      const young = await seedUserTombstone(YOUNG_TOMBSTONE_DAYS);
      await sql!.unsafe(
        `INSERT INTO oidc_models (model, id, payload, expires_at) VALUES ('Session', 'purge-expired', '{}'::jsonb, $1)`,
        [new Date(Date.now() - 60 * 60 * 1000).toISOString()],
      );

      const result = await server!.runCleanupNow!();

      expect(result.gdpr.mode).toBe('enabled');
      expect(result.gdpr.users).toBe(1);
      expect(result.gdpr.memberships).toBe(0);
      expect(result.gdpr.oldestTombstoneAgeDays).toBeGreaterThanOrEqual(OLD_TOMBSTONE_DAYS);
      // The irreversible delete actually happened — the reported count IS what was erased.
      expect(await userExists(old)).toBe(false);
      // The cutoff has teeth in the other direction too.
      expect(await userExists(young)).toBe(true);
      // The LIVE, ungated half ran on the same pass.
      expect(result.oidcPruned).toBe(1);
      expect(await oidcIds()).toEqual([]);
    },
    120_000,
  );
});

/**
 * ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the armed-gate proof did NOT run.
 */
describe('Product-YAML armed GDPR purge — ran-guard (the delete proof must not silently skip)', () => {
  it('the armed-gate arm ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(armsRan).toBe(1);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
