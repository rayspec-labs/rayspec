/**
 * The PRODUCT-tenant boot gate, on GROUND TRUTH through the REAL composition root
 * (`assembleServer` → `deployProductYamlSpec`) against a throwaway DATABASE.
 *
 * `RAYSPEC_PRODUCT_TENANT_ID` is the ONE org every workflow run, every capability event and every
 * authenticated principal of a product deployment binds to. A value that names no live org therefore
 * makes the deployment unusable for EVERYONE — and, before this gate, it still booted green: the
 * failure surfaced later as a bare 404 on the reprocess seam or a `cross_tenant` throw in a capability
 * sink, far from the misconfigured variable. The four arms pin the gate on both sides:
 *
 *   1. SHAPE: a malformed (non-UUID) value aborts the boot — the same `forTenant` rule the cron
 *      variable is held to, so the shape law has ONE source of truth (the TenantDb chokepoint).
 *   2. ABSENT: a well-formed id matching no `orgs` row aborts the boot.
 *   3. TOMBSTONED: an org with `deleted_at` set counts as ABSENT and aborts the boot — a deployment
 *      must never bind to a tenant that has been erased.
 *   4. LIVE: the SAME spec + a real org id boots exactly as before (materialized, routes mounted).
 *
 * Arms 1–3 abort at step 2 of `deployProductYamlSpec`, before the DBOS executor is constructed — so
 * this file performs exactly ONE full launch (arm 4, last). The platform migration chain is applied
 * up front (so `orgs` exists to seed), which the boot's own `applyMigrations` then no-ops over.
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
import { assertProductTenantBootable } from './product-boot.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
// The NON-audio, zero-agent, no-stt fixture: it demands NONE of the doc-driven env vars, so every
// arm below isolates the tenant gate rather than an env demand.
const INTAKE_YAML = resolve(here, '__fixtures__/non-audio-intake.product.yaml');

const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_product_tenant_${process.pid}`;
const LIVE_TENANT = '00000000-0000-4000-8000-0000000000f1';
const DEAD_TENANT = '00000000-0000-4000-8000-0000000000f2';
const ABSENT_TENANT = '00000000-0000-4000-8000-0000000000f3';

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

describe.skipIf(!baseUrl)('Product-YAML boot — the deployment-tenant gate', () => {
  let dbUrl = '';
  let server: BootedServer | undefined;
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
    'STT_PROVIDER',
    'RAYSPEC_EXTRACTION_MODE',
    'RAYSPEC_BLOB_ROOT',
    'RAYSPEC_MEDIA_SIGNING_KEY',
  ] as const;

  async function boot(tenantId: string): Promise<BootedServer> {
    process.env.RAYSPEC_PRODUCT_TENANT_ID = tenantId;
    const config = loadServerConfig();
    return assembleServer(config, {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
    });
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'product-tenant-pepper-only';
    process.env.DATABASE_URL = dbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8807';
    process.env.RAYSPEC_SPEC_PATH = INTAKE_YAML;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    delete process.env.STT_PROVIDER;
    delete process.env.RAYSPEC_EXTRACTION_MODE;
    delete process.env.RAYSPEC_BLOB_ROOT;
    delete process.env.RAYSPEC_MEDIA_SIGNING_KEY;

    // The tenant must be REAL before the deployment boots — which is the whole point of the gate, and
    // why the org rows are seeded here rather than after `assembleServer`. The committed platform
    // chain bootstraps a clean DB, so `orgs` exists to seed into; the boot's own migrate no-ops.
    const seed = makeDb(dbUrl);
    try {
      await applyMigrations(seed);
      await seed.$client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Intake', 'intake'), ($2, 'Gone', 'gone')`,
        [LIVE_TENANT, DEAD_TENANT],
      );
      await seed.$client.unsafe(`UPDATE orgs SET deleted_at = now() WHERE id = $1`, [DEAD_TENANT]);
    } finally {
      await seed.$client.end();
    }
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  it('SHAPE: a malformed RAYSPEC_PRODUCT_TENANT_ID aborts the boot, naming the variable', async () => {
    await expect(boot('not-a-uuid')).rejects.toThrow(
      /RAYSPEC_PRODUCT_TENANT_ID='not-a-uuid' is not a valid org UUID/,
    );
    armsRan += 1;
  }, 120_000);

  it('ABSENT: a well-formed id that matches no org aborts the boot with the create-it-first remedy', async () => {
    await expect(boot(ABSENT_TENANT)).rejects.toThrow(
      new RegExp(`RAYSPEC_PRODUCT_TENANT_ID='${ABSENT_TENANT}' does not name a live org`),
    );
    // The abort is ACTIONABLE: it names the supported order, not just the defect.
    await expect(boot(ABSENT_TENANT)).rejects.toThrow(/dev bootstrap-tenant --org-id/);
    armsRan += 1;
  }, 120_000);

  it('TOMBSTONED: a soft-deleted org counts as absent and aborts the boot', async () => {
    await expect(boot(DEAD_TENANT)).rejects.toThrow(
      new RegExp(`RAYSPEC_PRODUCT_TENANT_ID='${DEAD_TENANT}' does not name a live org`),
    );
    armsRan += 1;
  }, 120_000);

  // The gate answers in uuid space — the shape regex is case-insensitive and `orgs.id` is a `uuid`
  // column — while every runtime tenant comparison is a STRING comparison against a tenant the server
  // read back from that same column (`event.tenant_id !== boundTenant` in the capability sinks,
  // `reqTenant !== tenantId` on the reprocess seam). So a boot that bound the configured spelling
  // would pass this gate and then refuse every event: exactly the silent misconfiguration the gate
  // exists to end, one layer down. Not hypothetical — `uuidgen` prints upper case on macOS/BSD, which
  // is how the documented recipe mints an id.
  it('CASE: an id that differs only in letter case binds the form the database stores', async () => {
    const shouted = LIVE_TENANT.toUpperCase();
    expect(shouted).not.toBe(LIVE_TENANT); // the fixture id has hex letters, so the case differs

    // The gate resolves rather than echoes.
    const probe = makeDb(dbUrl);
    try {
      await expect(assertProductTenantBootable(probe, shouted)).resolves.toBe(LIVE_TENANT);
    } finally {
      await probe.$client.end();
    }

    // That the BOOT binds what the gate resolved is pinned by the LIVE arm below, which boots with
    // this same shouted spelling (one boot per process: the durable executor registers its workflows
    // process-globally, so a second `assembleServer` here would collide on the registration).
    armsRan += 1;
  }, 120_000);

  it('LIVE: a real org id boots unchanged, bound to the form the database stores', async () => {
    // Booted with the SHOUTED spelling deliberately: it exercises the ordinary boot AND pins that the
    // deployment binds the resolved id rather than the configured one — the value every runtime tenant
    // comparison is made against.
    server = await boot(LIVE_TENANT.toUpperCase());
    expect(server.productTenantId).toBe(LIVE_TENANT);
    expect(server.deployMode).toBe('materialized');
    const routes = server.declaredRoutes.map((r) => `${r.method} ${r.path}`);
    expect(routes).toContain('POST /records/{record_id}/submit');
    expect(routes).toContain('GET /intake/{record_id}/status');
    const health = await server.app.request('/health');
    expect(health.status).toBe(200);
    armsRan += 1;
  }, 180_000);
});

// UN-SKIPPABLE ran-guard: a REQUIRED run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost DATABASE_URL would
// otherwise SILENTLY SKIP the whole tenant-gate proof and read GREEN.
describe('product-tenant boot gate — ran-guard', () => {
  it('the gate arms actually ran under a required run', () => {
    if (dbRequired) expect(armsRan).toBe(5);
    else expect(true).toBe(true);
  });
});
