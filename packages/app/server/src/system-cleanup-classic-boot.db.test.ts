/**
 * The daily SYSTEM cleanup on a CLASSIC `rayspec.yaml` boot — the PARITY half of the cleanup-wiring
 * proof. The classic backend profile has always wired the housekeeping job; nothing here changes it,
 * and this suite exists so that a future regression on THIS path fails just as loudly as one on the
 * Product-YAML path. The two files assert the same observables against the same seeded rows, so the
 * documented rule ("wired whenever a durable worker is launched") is pinned in both directions.
 *
 * Boots the REAL composition root (`assembleServer` → `deployDeclaredSpec`) against a throwaway
 * DATABASE with a `deployment.durableWorker: true` spec and a real DBOS launch, then asserts on GROUND
 * TRUTH, from the BOOTED server:
 *
 *   1. REGISTRATION: with `RAYSPEC_CLEANUP_SCHEDULE` set to a per-second crontab, an EXPIRED
 *      `oidc_models` row seeded after the boot disappears with NOBODY calling the on-demand seam —
 *      the DBOS schedule loop fired the registered `system:cleanup` workflow. A non-expired row and a
 *      NULL-expiry row survive.
 *   2. THE ON-DEMAND SEAM: `runCleanupNow` is present on the booted server and returns the STRUCTURED
 *      result — `gdpr.mode === 'disabled'` with the gate unset.
 *   3. THE GATE HAS TEETH IN THE OFF DIRECTION: an eligible tombstone is COUNTED but NOT deleted.
 *
 * The gate-ON direction is `system-cleanup-classic-purge.db.test.ts` (DBOS is a process-global
 * singleton — one launch per process, so the second gate state needs a second process).
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

const SUITE_DB = `rayspec_cleanup_classic_${process.pid}`;
const DBOS_SYS_DB = `${SUITE_DB}_dbos_sys`;
/** A per-SECOND crontab (DBOS accepts the 6-spot form) so the daily job's schedule loop fires inside the test. */
const EVERY_SECOND = '* * * * * *';
const OLD_TOMBSTONE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A minimal `rayspec.yaml` that wires a DURABLE WORKER. The declared agent exists only so the
 * composition root builds the backend map and constructs the executor; this suite never fires a run.
 */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: cleanup-classic-boot-test
  description: minimal durable-worker fixture for the system-cleanup wiring proof
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
    throw new Error('the system-cleanup boot fixture never fires an agent run');
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
  'classic rayspec.yaml boot — the daily SYSTEM cleanup is registered on the durable worker',
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

    async function seedOidc(id: string, expiresAt: Date | null): Promise<void> {
      await sql!.unsafe(
        `INSERT INTO oidc_models (model, id, payload, expires_at) VALUES ('Session', $1, '{}'::jsonb, $2)`,
        [id, expiresAt === null ? null : expiresAt.toISOString()],
      );
    }
    async function oidcIds(): Promise<string[]> {
      const rows = (await sql!.unsafe(
        'SELECT id FROM oidc_models ORDER BY id',
      )) as unknown as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }
    async function seedUserTombstone(days: number): Promise<string> {
      const rows = (await sql!.unsafe(
        `INSERT INTO users (email, deleted_at) VALUES ($1, $2) RETURNING id`,
        [
          `cleanup-tombstone-${days}d@invalid`,
          new Date(Date.now() - days * MS_PER_DAY).toISOString(),
        ],
      )) as unknown as Array<{ id: string }>;
      return rows[0]!.id;
    }
    async function userExists(id: string): Promise<boolean> {
      const rows = await sql!.unsafe('SELECT 1 FROM users WHERE id = $1', [id]);
      return rows.length > 0;
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

      tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-cleanup-classic-'));
      const specPath = join(tmpDir, 'rayspec.yaml');
      writeFileSync(specPath, SPEC_YAML, 'utf8');

      for (const k of ENV) saved[k] = process.env[k];
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
      process.env.RAYSPEC_API_KEY_PEPPER = 'cleanup-classic-pepper-only';
      process.env.DATABASE_URL = appDbUrl;
      delete process.env.ALLOWED_ORIGINS;
      process.env.PORT = '8813';
      process.env.RAYSPEC_SPEC_PATH = specPath;
      delete process.env.DBOS_SYSTEM_DATABASE_URL;
      process.env.RAYSPEC_CLEANUP_SCHEDULE = EVERY_SECOND;
      delete process.env.RAYSPEC_GDPR_PURGE_ENABLED;
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
      'REGISTERED: the daily cleanup fires UNATTENDED on this boot — an expired oidc_models row is pruned with nobody calling the seam',
      async () => {
        armsRan += 1;
        const now = Date.now();
        await seedOidc('expired-1', new Date(now - 60 * 60 * 1000));
        await seedOidc('fresh-1', new Date(now + 60 * 60 * 1000));
        await seedOidc('no-expiry-1', null);
        expect(await oidcIds()).toEqual(['expired-1', 'fresh-1', 'no-expiry-1']);

        const deadline = Date.now() + 45_000;
        let ids = await oidcIds();
        while (ids.includes('expired-1')) {
          if (Date.now() > deadline) {
            throw new Error(
              `the daily system cleanup never fired on this classic boot: oidc_models still ${JSON.stringify(ids)}`,
            );
          }
          await new Promise((r) => setTimeout(r, 250));
          ids = await oidcIds();
        }
        expect(ids).toEqual(['fresh-1', 'no-expiry-1']);
      },
      120_000,
    );

    maybe(
      'ON-DEMAND SEAM: runCleanupNow is present, and with the gate unset it reports gdpr.mode disabled and deletes NOTHING',
      async () => {
        armsRan += 1;
        expect(typeof server?.runCleanupNow).toBe('function');

        const tombstone = await seedUserTombstone(OLD_TOMBSTONE_DAYS);
        const result = await server!.runCleanupNow!();

        expect(result.gdpr.mode).toBe('disabled');
        expect(result.gdpr.users).toBeGreaterThanOrEqual(1);
        expect(result.gdpr.oldestTombstoneAgeDays).toBeGreaterThanOrEqual(OLD_TOMBSTONE_DAYS);
        expect(result.gdpr.memberships).toBe(0);
        expect(result.oidcPruned).toBeGreaterThanOrEqual(0);

        expect(await userExists(tombstone)).toBe(true);
        await new Promise((r) => setTimeout(r, 3_000));
        expect(await userExists(tombstone)).toBe(true);
      },
      120_000,
    );
  },
);

/**
 * ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the arms above did NOT run.
 */
describe('classic system cleanup — ran-guard (the parity proof must not silently skip)', () => {
  it('the cleanup-wiring arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(armsRan).toBe(2);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
