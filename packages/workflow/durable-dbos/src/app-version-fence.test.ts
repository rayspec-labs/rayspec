/**
 * The durable worker is FENCED to the document it was booted with.
 *
 * DBOS scopes its dequeue by application version (`application_version IS NULL OR
 * application_version = $3` in `findAndMarkStartableWorkflows`, verified in the installed 4.21.6
 * system_database.js:1824), and when nothing supplies one it COMPUTES an md5 over the source of the
 * workflow functions registered in the process plus the SDK version (dbos-executor.js:887-898). Every
 * function this platform registers is a thin delegating wrapper carrying nothing from the deployed
 * document, and `executorID` is the literal `'local'` in every process (utils.js:54) — so two
 * processes running DIFFERENT documents through the same profile against one DATABASE_URL derive the
 * SAME version and dequeue each other's jobs.
 * `DbosExecutorConfig.applicationVersion` is the seam that separates them: `DBOS.launch`
 * assigns it to `globalParams.appVersion` (dbos.js:172-175) BEFORE `init()` reaches the
 * `if (globalParams.appVersion === '')` compute branch (dbos-executor.js:140-144).
 *
 * DB-FREE and deterministic, exactly like admin-server-disabled.test.ts: it SPIES on `DBOS.setConfig`
 * / `DBOS.registerQueue` and stubs the rest of the lifecycle to no-ops, then reads the EXACT objects
 * the executor hands them. Fail-the-fix in both directions — a configured version must be forwarded
 * verbatim, and an executor constructed WITHOUT one must not send the key at all (DBOS then computes
 * its own hash, the behaviour every caller that names no document keeps).
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_RUNS_QUEUE, DbosDurableExecutor, type DbosExecutorDeps } from './executor.js';
import { DbosWorkflowExecutor, WORKFLOW_RUNS_QUEUE } from './workflow-executor.js';

const deps: DbosExecutorDeps = {
  // A bare stub Db — start() never touches it (we stub launch/registerQueue), so it is unused.
  db: {} as never,
  resolveRun: () => {
    throw new Error('resolveRun must not be called in this lifecycle-only test');
  },
};

/** Stub the DB-touching lifecycle so `start()` never launches an engine; return the two spies. */
function stubLifecycle(): {
  setConfig: ReturnType<typeof vi.spyOn>;
  registerQueue: ReturnType<typeof vi.spyOn>;
} {
  const setConfig = vi.spyOn(DBOS, 'setConfig').mockImplementation(() => {});
  vi.spyOn(DBOS, 'registerWorkflow').mockImplementation(((fn: unknown) => fn) as never);
  vi.spyOn(DBOS, 'launch').mockResolvedValue(undefined as never);
  const registerQueue = vi.spyOn(DBOS, 'registerQueue').mockResolvedValue(undefined as never);
  return { setConfig, registerQueue };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the durable executor fences DBOS to the deployment document', () => {
  it('forwards a configured applicationVersion to DBOS.setConfig verbatim', async () => {
    const { setConfig } = stubLifecycle();

    const executor = new DbosDurableExecutor(deps, {
      name: 'rayspec-app-version-test',
      systemDatabaseUrl: 'postgresql://localhost:5433/never_connected_dbos_sys',
      applicationVersion: 'doc-00112233445566ff',
    });
    await executor.start();

    expect(setConfig).toHaveBeenCalledTimes(1);
    const passedConfig = setConfig.mock.calls[0]![0] as Record<string, unknown>;
    expect(passedConfig.applicationVersion).toBe('doc-00112233445566ff');
  });

  it('omits applicationVersion entirely when none is configured (DBOS keeps computing its own)', async () => {
    const { setConfig } = stubLifecycle();

    const executor = new DbosDurableExecutor(deps, {
      name: 'rayspec-app-version-test',
      systemDatabaseUrl: 'postgresql://localhost:5433/never_connected_dbos_sys',
    });
    await executor.start();

    const passedConfig = setConfig.mock.calls[0]![0] as Record<string, unknown>;
    // ABSENT, not `undefined`: `DBOS.launch` branches on truthiness (dbos.js:172-175), so either
    // shape works there — but the property must not appear, so a config dump never reads as if a
    // version were configured when it is not.
    expect(passedConfig).not.toHaveProperty('applicationVersion');
  });
});

describe('queue registration survives a per-document application version', () => {
  it('both queues register with onConflict:always_update', async () => {
    const { registerQueue } = stubLifecycle();

    const executor = new DbosDurableExecutor(deps, {
      name: 'rayspec-app-version-test',
      systemDatabaseUrl: 'postgresql://localhost:5433/never_connected_dbos_sys',
      applicationVersion: 'doc-00112233445566ff',
    });
    await executor.start();
    await new DbosWorkflowExecutor({
      db: {} as never,
      resolveWorkflowRun: () => {
        throw new Error('resolveWorkflowRun must not be called in this lifecycle-only test');
      },
    }).registerQueueAfterLaunch();

    // `DBOS.registerQueue` DEFAULTS to onConflict:'update_if_latest_version' (dbos.js:1782), which
    // resolves to an `ON CONFLICT DO NOTHING` for any process whose version is not the newest row in
    // `application_versions` (dbos.js:1792-1794). Per-document versions make that the normal case, so
    // without an explicit 'always_update' a deployment's `workerConcurrency` would look accepted and
    // silently not be applied.
    const byName = new Map(
      registerQueue.mock.calls.map(
        (call) => [call[0], call[1]] as [unknown, Record<string, unknown> | undefined],
      ),
    );
    expect(byName.get(AGENT_RUNS_QUEUE)?.onConflict).toBe('always_update');
    expect(byName.get(WORKFLOW_RUNS_QUEUE)?.onConflict).toBe('always_update');
  });
});
