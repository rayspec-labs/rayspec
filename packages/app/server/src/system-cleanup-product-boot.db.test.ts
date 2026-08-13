/**
 * The daily SYSTEM cleanup on a PRODUCT-YAML boot — the wiring had ZERO coverage on this boot shape.
 *
 * `.env.example` and `ServerConfig.cleanup` both promise that the platform housekeeping job (the LIVE
 * OIDC prune + the operator-gated GDPR purge) is wired onto the durable worker's daily
 * scheduled-workflow WHENEVER a durable worker is launched, INDEPENDENT of which spec profile launched
 * it. A `*.product.yaml` boot DOES launch a durable worker — so the promise covers it. This suite boots
 * the REAL composition root (`assembleServer` → `deployProductYamlSpec`) against a throwaway DATABASE
 * with a real DBOS launch and asserts the promise on GROUND TRUTH, from the BOOTED server:
 *
 *   1. REGISTRATION (the load-bearing arm): the boot runs with `RAYSPEC_CLEANUP_SCHEDULE` set to a
 *      per-second crontab, so the DBOS schedule loop fires the registered `system:cleanup` workflow
 *      unattended. An EXPIRED `oidc_models` row seeded after the boot therefore disappears with NOBODY
 *      calling the on-demand seam — which is only possible if `registerScheduledWorkflow()` ran in this
 *      boot's pre-launch window. A non-expired row and a NULL-expiry row survive (the prune is
 *      expiry-scoped, not a truncate).
 *   2. THE ON-DEMAND SEAM: the dispatcher propagates `runCleanupNow` off the product deploy, and it
 *      returns the STRUCTURED result — `gdpr.mode === 'disabled'` with the gate unset.
 *   3. THE GATE HAS TEETH IN THE OFF DIRECTION: an eligible (past-retention) user tombstone is COUNTED
 *      as would-purge but performs ZERO deletes — it is still there after the on-demand run AND after
 *      several further scheduled ticks.
 *
 * The gate-ON direction (an eligible tombstone actually purged on a product boot) is a SEPARATE file:
 * the gate is resolved once at boot, and DBOS is a process-global singleton that permits exactly ONE
 * launch per process — so a second gate state needs a second process.
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
// The NON-audio, zero-agent, no-stt product fixture: it demands NONE of the doc-driven env vars, so
// the boot isolates the cleanup wiring rather than an env demand.
const INTAKE_YAML = resolve(here, '__fixtures__/non-audio-intake.product.yaml');

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_cleanup_product_${process.pid}`;
const DBOS_SYS_DB = `${SUITE_DB}_dbos_sys`;
const TENANT = '00000000-0000-4000-8000-0000000000e1';
/** A per-SECOND crontab (DBOS accepts the 6-spot form) so the daily job's schedule loop fires inside the test. */
const EVERY_SECOND = '* * * * * *';
/** Days-ago for the eligible tombstone — far past the 30-day retention default. */
const OLD_TOMBSTONE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  'Product-YAML boot — the daily SYSTEM cleanup is registered on the durable worker',
  () => {
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

    /** Seed an `oidc_models` row; `expiresAt: null` ⇒ never expires (must survive the prune). */
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
    /** Seed a USER tombstone (`deleted_at` stamped `days` ago) — the GDPR purge's eligible row. */
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

      for (const k of ENV) saved[k] = process.env[k];
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
      process.env.RAYSPEC_API_KEY_PEPPER = 'cleanup-product-pepper-only';
      process.env.DATABASE_URL = appDbUrl;
      delete process.env.ALLOWED_ORIGINS;
      process.env.PORT = '8811';
      process.env.RAYSPEC_SPEC_PATH = INTAKE_YAML;
      delete process.env.DBOS_SYSTEM_DATABASE_URL;
      process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
      // The scheduled job must actually FIRE inside the test window — that unattended fire IS the
      // registration proof. The GDPR gate stays UNSET (the shipped default ⇒ dry-run, zero deletes).
      process.env.RAYSPEC_CLEANUP_SCHEDULE = EVERY_SECOND;
      delete process.env.RAYSPEC_GDPR_PURGE_ENABLED;
      delete process.env.RAYSPEC_GDPR_RETENTION_DAYS;

      // The deployment tenant must be a LIVE org BEFORE the boot (a product deployment whose
      // RAYSPEC_PRODUCT_TENANT_ID names none refuses to start). The committed platform chain
      // bootstraps the clean DB so `orgs` is there to seed; the boot's own migrate then no-ops.
      const seed = makeDb(appDbUrl);
      try {
        await applyMigrations(seed);
        await seed.$client.unsafe(
          `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Cleanup', 'cleanup')`,
          [TENANT],
        );
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
      'REGISTERED: the daily cleanup fires UNATTENDED on this boot — an expired oidc_models row is pruned with nobody calling the seam',
      async () => {
        armsRan += 1;
        const now = Date.now();
        await seedOidc('expired-1', new Date(now - 60 * 60 * 1000));
        await seedOidc('fresh-1', new Date(now + 60 * 60 * 1000));
        await seedOidc('no-expiry-1', null);
        expect(await oidcIds()).toEqual(['expired-1', 'fresh-1', 'no-expiry-1']);

        // NOTHING below calls `runCleanupNow` — the row can only vanish if THIS boot registered the
        // `system:cleanup` scheduled-workflow in its pre-launch window and DBOS's schedule loop fired it.
        const deadline = Date.now() + 45_000;
        let ids = await oidcIds();
        while (ids.includes('expired-1')) {
          if (Date.now() > deadline) {
            throw new Error(
              `the daily system cleanup never fired on this Product-YAML boot: oidc_models still ${JSON.stringify(ids)}`,
            );
          }
          await new Promise((r) => setTimeout(r, 250));
          ids = await oidcIds();
        }
        // Expiry-scoped, not a truncate: the live row and the never-expiring row are untouched.
        expect(ids).toEqual(['fresh-1', 'no-expiry-1']);
      },
      120_000,
    );

    maybe(
      'ON-DEMAND SEAM: the dispatcher propagates runCleanupNow, and with the gate unset it reports gdpr.mode disabled and deletes NOTHING',
      async () => {
        armsRan += 1;
        // The seam the classic profile has always had — the product profile must expose the same one.
        expect(typeof server?.runCleanupNow).toBe('function');

        const tombstone = await seedUserTombstone(OLD_TOMBSTONE_DAYS);
        const result = await server!.runCleanupNow!();

        // Structured (not a log scrape): the gate is OFF, so this is a DRY-RUN count.
        expect(result.gdpr.mode).toBe('disabled');
        expect(result.gdpr.users).toBeGreaterThanOrEqual(1);
        expect(result.gdpr.oldestTombstoneAgeDays).toBeGreaterThanOrEqual(OLD_TOMBSTONE_DAYS);
        expect(result.gdpr.memberships).toBe(0);
        expect(result.oidcPruned).toBeGreaterThanOrEqual(0);

        // ZERO deletes — the counted tombstone is still there, and stays there across several further
        // scheduled ticks (the per-second crontab fires many times in this window).
        expect(await userExists(tombstone)).toBe(true);
        await new Promise((r) => setTimeout(r, 3_000));
        expect(await userExists(tombstone)).toBe(true);
      },
      120_000,
    );

    maybe(
      'THE PRODUCT PROFILE SWEEPS A STREAM WITHOUT DECLARING ONE: the cleanup result carries the event-bus half',
      async () => {
        armsRan += 1;
        // The product document below declares NOTHING about an event bus — the product grammar has no
        // key to declare one with (no `deployment` section exists there at all). What this arm pins is
        // the RETENTION half of that structural posture: the product boot hands the housekeeping pass a
        // window, so the sweep runs on a document that asked for nothing.
        //
        // WHAT IT DOES NOT PIN, stated so nobody reads more into it: this says nothing about a product
        // handler receiving `init.emit`. It cannot — a product document declares no handlers, no
        // tooling and no api (`ProductSpec`, product-grammar.ts), and the composed engine spec is built
        // with `agents: [], tooling: [], handlers: []` (buildProductEngineSpec, compose.ts), so there is
        // no product-authored code on this profile to observe the capability from. The emit path itself
        // is proven where author code exists: the backend profile's boot arm
        // (event-bus-capability-boot.db.test.ts) and the engine seam
        // (api-auth/src/engine/route-handler-emit.db.test.ts).
        const result = await server!.runCleanupNow!();
        expect(result.eventBus).toBeDefined();
        // Nothing has been emitted on this boot, so the sweep is a well-defined no-op — the POINT is
        // that it ran. (A backend-profile boot that did not enable the bus reports no such half; that
        // control is asserted in system-cleanup-classic-boot.db.test.ts.)
        expect(result.eventBus).toEqual({ deleted: 0, tenants: 0 });
      },
      120_000,
    );
  },
);

/**
 * ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the arms above did NOT run — a lost DATABASE_URL would otherwise
 * silently skip the whole cleanup-wiring proof and still read GREEN.
 */
describe('Product-YAML system cleanup — ran-guard (the wiring proof must not silently skip)', () => {
  it('the cleanup-wiring arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(armsRan).toBe(3);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
