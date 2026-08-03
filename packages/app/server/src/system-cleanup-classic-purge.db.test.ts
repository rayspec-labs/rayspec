/**
 * The GDPR purge GATE, armed, on a CLASSIC `rayspec.yaml` boot — the PARITY half of the armed-gate
 * proof. The classic backend profile has always wired the housekeeping job; nothing here changes it,
 * and this suite exists so that a future regression on THIS path fails just as loudly as one on the
 * Product-YAML path (`system-cleanup-product-purge.db.test.ts` asserts the same observables).
 *
 * Boots the REAL composition root (`assembleServer` → `deployDeclaredSpec`) against a throwaway
 * DATABASE with `deployment.durableWorker: true`, a real DBOS launch and
 * `RAYSPEC_GDPR_PURGE_ENABLED=true`, then runs the cleanup through the booted server's on-demand seam
 * (the EXACT path the daily scheduled-workflow body fires on):
 *
 *   - `gdpr.mode === 'enabled'` and a PAST-RETENTION user tombstone is GONE from the table;
 *   - a tombstone INSIDE the retention window survives;
 *   - the LIVE, ungated OIDC prune deletes the expired row on the same run.
 *
 * The default (3am) crontab is left in place so nothing fires concurrently and the returned counts are
 * exactly what this call did.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend, BackendId, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_cleanup_cls_purge_${process.pid}`;
const DBOS_SYS_DB = `${SUITE_DB}_dbos_sys`;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const OLD_TOMBSTONE_DAYS = 90;
const YOUNG_TOMBSTONE_DAYS = 2;

const SPEC_YAML = `
version: '1.0'
metadata:
  name: cleanup-classic-purge-test
  description: minimal durable-worker fixture for the armed GDPR-purge parity proof
deployment:
  durableWorker: true
stores:
  - name: notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/notes', action: { kind: store, store: notes, op: create } }
agents:
  - id: echo
    name: echo-agent
    backend: openai
    model: gpt-4o-mini
    instructions: Echo the input back.
    maxTurns: 2
`;

/** The `openai` slot the declared agent resolves to. Never invoked — a run here would be a test bug. */
class UnusedBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(): Promise<RunResult> {
    throw new Error('the system-cleanup purge fixture never fires an agent run');
  }
}

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

describe.skipIf(!baseUrl)(
  'classic rayspec.yaml boot — the ARMED GDPR purge actually deletes',
  () => {
    let server: BootedServer | undefined;
    let appDbUrl = '';
    let tmpDir = '';
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
      'RAYSPEC_CLEANUP_SCHEDULE',
      'RAYSPEC_GDPR_PURGE_ENABLED',
      'RAYSPEC_GDPR_RETENTION_DAYS',
    ] as const;

    async function seedUserTombstone(days: number): Promise<string> {
      const rows = (await sql!.unsafe(
        `INSERT INTO users (email, deleted_at) VALUES ($1, $2) RETURNING id`,
        [
          `purge-tombstone-${days}d@invalid`,
          new Date(Date.now() - days * MS_PER_DAY).toISOString(),
        ],
      )) as unknown as Array<{ id: string }>;
      return rows[0]!.id;
    }
    async function userExists(id: string): Promise<boolean> {
      const rows = await sql!.unsafe('SELECT 1 FROM users WHERE id = $1', [id]);
      return rows.length > 0;
    }
    async function oidcIds(): Promise<string[]> {
      const rows = (await sql!.unsafe(
        'SELECT id FROM oidc_models ORDER BY id',
      )) as unknown as Array<{
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

      tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-cleanup-cls-purge-'));
      const specPath = join(tmpDir, 'rayspec.yaml');
      writeFileSync(specPath, SPEC_YAML, 'utf8');

      for (const k of ENV) saved[k] = process.env[k];
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
      process.env.RAYSPEC_API_KEY_PEPPER = 'cleanup-cls-purge-pepper-only';
      process.env.DATABASE_URL = appDbUrl;
      delete process.env.ALLOWED_ORIGINS;
      process.env.PORT = '8814';
      process.env.RAYSPEC_SPEC_PATH = specPath;
      delete process.env.DBOS_SYSTEM_DATABASE_URL;
      delete process.env.RAYSPEC_CLEANUP_SCHEDULE;
      process.env.RAYSPEC_GDPR_PURGE_ENABLED = 'true';
      delete process.env.RAYSPEC_GDPR_RETENTION_DAYS;

      const config = loadServerConfig();
      server = await assembleServer(config, {
        agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
          new Map<BackendId, Backend>([['openai', new UnusedBackend()]]),
        registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      });
      sql = postgres(appDbUrl, { max: 2 });
    }, 180_000);

    afterAll(async () => {
      await server?.close();
      await sql?.end();
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
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
        expect(await userExists(old)).toBe(false);
        expect(await userExists(young)).toBe(true);
        expect(result.oidcPruned).toBe(1);
        expect(await oidcIds()).toEqual([]);
      },
      120_000,
    );
  },
);

/**
 * ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the armed-gate parity proof did NOT run.
 */
describe('classic armed GDPR purge — ran-guard (the delete proof must not silently skip)', () => {
  it('the armed-gate arm ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(armsRan).toBe(1);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
