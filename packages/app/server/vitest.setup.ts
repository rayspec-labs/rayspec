/**
 * The runtime-role lane of the server suites (RAYSPEC_TEST_DATABASE_ISOLATION=roles).
 *
 * Every server suite boots the real composition root on a throwaway database it creates as the
 * compose superuser. In this lane `assembleServer` is wrapped: before the boot, the lane's own three
 * roles are prepared in that database and in its workflow system database by the shipped setup SQL,
 * and the boot is handed the migration role's and the runtime role's connections instead of the
 * superuser's — role separation, exactly as an operator turns it on. The boot must then report the
 * isolated posture active, or the wrapper fails the suite. The suite itself keeps its superuser
 * connections for seeding and inspecting. A boot that already sets the migration connection is
 * passed through unchanged, and so is one whose database cannot be reached (it is meant to fail).
 * `provisionTenant` (`rayspec tenant ensure`) is wrapped the same way.
 *
 * Without the lane nothing is wrapped. The roles are dropped when the file ends.
 */
import { createRuntimeRoleLane, testDatabaseIsolation } from '@rayspec/db/testing';
import { afterAll, vi } from 'vitest';
import type * as CompositionRoot from './src/composition-root.js';
import type * as TenantProvision from './src/tenant-provision.js';

const lane = testDatabaseIsolation() ? createRuntimeRoleLane() : undefined;

vi.mock('./src/composition-root.js', async (importOriginal) => {
  const real = await importOriginal<typeof CompositionRoot>();
  if (lane === undefined) return real;
  const assembleServer: typeof real.assembleServer = async (config, opts) => {
    if (config.migrationDatabaseUrl !== undefined) return real.assembleServer(config, opts);
    const urls = await lane.bootUrls(config.databaseUrl, config.dbosSystemDatabaseUrl);
    if (urls === undefined) return real.assembleServer(config, opts);
    const booted = await real.assembleServer({ ...config, ...urls }, opts);
    const isolation = booted.databaseIsolation;
    if (isolation.mode !== 'role-separated' || !isolation.active) {
      await booted.close().catch(() => {});
      throw new Error(
        `the runtime-role lane booted without an active isolated posture: ${JSON.stringify(isolation.findings)}`,
      );
    }
    return booted;
  };
  return { ...real, assembleServer };
});

// `rayspec tenant ensure` the way an operator runs it under role separation: with the migration
// role's connection beside the runtime role's.
vi.mock('./src/tenant-provision.js', async (importOriginal) => {
  const real = await importOriginal<typeof TenantProvision>();
  if (lane === undefined) return real;
  const provisionTenant: typeof real.provisionTenant = async (secrets, input, opts) => {
    if (secrets.migrationDatabaseUrl !== undefined)
      return real.provisionTenant(secrets, input, opts);
    const app = await lane.prepare(secrets.databaseUrl, 'application');
    if (app === undefined) return real.provisionTenant(secrets, input, opts);
    return real.provisionTenant(
      { ...secrets, databaseUrl: app.runtime, migrationDatabaseUrl: app.migration },
      input,
      opts,
    );
  };
  return { ...real, provisionTenant };
});

afterAll(async () => {
  await lane?.drop();
});
