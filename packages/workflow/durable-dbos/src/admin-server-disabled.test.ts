/**
 * SECURITY fail-the-fix: the durable boot must NOT expose the DBOS admin
 * HTTP server.
 *
 * By default `DBOS.launch()` starts an UNAUTHENTICATED admin HTTP server on port 3001 (binds ALL
 * interfaces, wildcard CORS, can cancel/resume/restart/list workflows; it even SWALLOWS an EADDRINUSE
 * — only `logger.warn`s, verified in the installed 4.21.6 dbos.js:235-251). That contradicts the
 * LOCAL / no-hidden-listener / fail-closed posture of the platform. `DbosDurableExecutor`
 * MUST pass `runAdminServer:false` to `DBOS.setConfig` so the launch path never binds that listener.
 *
 * This test is DB-FREE and deterministic: it SPIES on `DBOS.setConfig` (and stubs the rest of the
 * lifecycle to no-ops) and asserts the EXACT object the executor hands to setConfig carries
 * `runAdminServer:false`. It is fail-the-fix: delete the `runAdminServer:false` line in executor.ts
 * and this goes RED (the captured config would default to admin-server-ON at launch). A second
 * assertion pins that `runAdminServer` is a TOP-LEVEL `DBOSConfig` field (the correct shape for the
 * programmatic setConfig surface — NOT the YAML `ConfigFile` `runtimeConfig:{…}` nesting).
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbosDurableExecutor, type DbosExecutorDeps } from './executor.js';

const deps: DbosExecutorDeps = {
  // A bare stub Db — start() never touches it (we stub launch/registerQueue), so it is unused.
  db: {} as never,
  resolveRun: () => {
    throw new Error('resolveRun must not be called in this lifecycle-only test');
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DBOS admin HTTP server is DISABLED at boot (security — no hidden listener)', () => {
  it('executor.start() passes runAdminServer:false to DBOS.setConfig (fail-the-fix)', async () => {
    // Capture the EXACT config object handed to setConfig; stub the DB-touching lifecycle to no-ops
    // so the test never launches a real engine / opens a port (deterministic + parallel-safe).
    const setConfigSpy = vi.spyOn(DBOS, 'setConfig').mockImplementation(() => {});
    vi.spyOn(DBOS, 'registerWorkflow').mockImplementation(((fn: unknown) => fn) as never);
    vi.spyOn(DBOS, 'launch').mockResolvedValue(undefined as never);
    vi.spyOn(DBOS, 'registerQueue').mockResolvedValue(undefined as never);

    const executor = new DbosDurableExecutor(deps, {
      name: 'rayspec-admin-disabled-test',
      systemDatabaseUrl: 'postgresql://localhost:5433/never_connected_dbos_sys',
    });
    await executor.start();

    expect(setConfigSpy).toHaveBeenCalledTimes(1);
    const passedConfig = setConfigSpy.mock.calls[0]![0] as Record<string, unknown>;
    // The admin server MUST be explicitly disabled (the whole point of fix A).
    expect(passedConfig.runAdminServer).toBe(false);
    // And it MUST be a TOP-LEVEL field (the DBOSConfig shape), NOT nested under `runtimeConfig`
    // (that nesting is the YAML ConfigFile shape and would be silently ignored by setConfig).
    expect(passedConfig).not.toHaveProperty('runtimeConfig');
  });
});
