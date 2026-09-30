/**
 * A schedule outlives an unreachable workflow system database — DB-backed test.
 *
 * Drives the REAL DBOS engine (`DbosDurableExecutor`) with the system cleanup scheduled every second,
 * then makes its SYSTEM database refuse connections for a few seconds (`ALLOW_CONNECTIONS false` and
 * every open connection terminated — what a failover or a restart of that database looks like to the
 * process). DBOS's own scheduler loop let the rejected start escape as an unhandled rejection, which
 * ends a server process, and the schedule stopped with it. WHAT THIS PROVES, on ground truth:
 *  1. nothing escaped as an unhandled rejection;
 *  2. the outage really reached a scheduled start (the schedule reported the failure);
 *  3. the schedule fires again once the database accepts connections, with no restart;
 *  4. the instants keep DBOS's workflow ids, `sched-.<name>-<ISO>`.
 *
 * Single-executor harness (pid-unique system database, one executor, a clean shutdown before the
 * system database is dropped). Skips without DATABASE_URL; the ran-guard hard-fails a REQUIRED run.
 */
import { makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DbosDurableExecutor,
  SYSTEM_CLEANUP_WORKFLOW_NAME,
  type SystemCleanupOutcome,
  SystemCleanupScheduler,
} from './index.js';
import {
  type WorkflowSystemDatabase,
  workflowSystemDatabase,
} from './test-support/engine-databases.js';

const PID = process.pid;
const SYS_DB = `rayspec_dbos_schedule_outage_${PID}_sys`;
const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !baseUrl) {
  throw new Error(
    'scheduled-workflow.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually(check: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${budgetMs} ms`);
    await pause(100);
  }
}

describe.skipIf(!baseUrl)(
  'a scheduled workflow while its system database refuses connections',
  () => {
    let admin: postgres.Sql;
    let appDb: ReturnType<typeof makeDb>;
    let executor: DbosDurableExecutor;
    let system: WorkflowSystemDatabase | undefined;
    const fired: number[] = [];
    const errors: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    const outcome: SystemCleanupOutcome = {
      oidcPruned: 0,
      gdpr: { mode: 'disabled', users: 0, memberships: 0, oldestTombstoneAgeDays: 0 },
    };

    beforeAll(async () => {
      const url = baseUrl as string;
      admin = postgres(withDbName(url, 'postgres'), { max: 1 });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SYS_DB}" WITH (FORCE)`);
      appDb = makeDb(url, 2);
      // The engine's system database: the superuser's, or in the runtime-role lane the runtime role's.
      system = await workflowSystemDatabase(withDbName(url, SYS_DB));
      executor = new DbosDurableExecutor(
        {
          db: appDb,
          resolveRun: () => {
            throw new Error('resolveRun is not used by a scheduled cleanup');
          },
        },
        { name: `rayspec-schedule-outage-${PID}`, systemDatabaseUrl: system.url },
      );
      const scheduler = new SystemCleanupScheduler({
        runCleanup: async () => {
          fired.push(Date.now());
          return outcome;
        },
        schedule: '* * * * * *',
        logger: { info: () => {}, error: (m) => errors.push(m) },
        executor,
      });
      executor.attachPreLaunchHook(() => scheduler.registerScheduledWorkflow());
      process.on('unhandledRejection', onUnhandled);
      await executor.start();
    }, 60_000);

    afterAll(async () => {
      try {
        await admin?.unsafe(`ALTER DATABASE "${SYS_DB}" ALLOW_CONNECTIONS true`).catch(() => {});
        await executor?.shutdown();
      } finally {
        process.off('unhandledRejection', onUnhandled);
        await appDb?.$client.end();
        await admin?.unsafe(`DROP DATABASE IF EXISTS "${SYS_DB}" WITH (FORCE)`);
        await system?.close();
        await admin?.end();
      }
    }, 60_000);

    it('keeps the schedule, raises nothing unhandled, and fires again once it accepts connections', async () => {
      await eventually(() => fired.length >= 2, 15_000);

      await admin.unsafe(`ALTER DATABASE "${SYS_DB}" ALLOW_CONNECTIONS false`);
      try {
        await admin.unsafe(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          [SYS_DB],
        );
        // Until an instant has met the outage, then long enough that several more do.
        await eventually(
          () => unhandled.length > 0 || errors.some((m) => m.includes('[schedule]')),
          15_000,
        );
        await pause(2_000);
      } finally {
        await admin.unsafe(`ALTER DATABASE "${SYS_DB}" ALLOW_CONNECTIONS true`);
      }
      const restored = Date.now();

      // 1. Nothing escaped.
      expect(unhandled.map(String)).toEqual([]);
      // 2. The outage reached a scheduled start, and the schedule said so.
      expect(errors.find((m) => m.includes('[schedule]'))).toMatch(
        new RegExp(`scheduled workflow '\\.${SYSTEM_CLEANUP_WORKFLOW_NAME}' failed`),
      );
      // 3. It fires again, in the same process, once the database is back.
      await eventually(() => fired.some((t) => t > restored), 30_000);

      // 4. The instants' workflow ids are the ones DBOS's own scheduler gave them.
      const sys = postgres(withDbName(baseUrl as string, SYS_DB), { max: 1 });
      try {
        const ids = (await sys.unsafe(
          "SELECT workflow_uuid AS id FROM dbos.workflow_status WHERE workflow_uuid LIKE 'sched-%'",
        )) as unknown as { id: string }[];
        expect(ids.length).toBeGreaterThan(0);
        for (const { id } of ids) {
          expect(id).toMatch(
            new RegExp(`^sched-\\.${SYSTEM_CLEANUP_WORKFLOW_NAME}-\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z$`),
          );
        }
      } finally {
        await sys.end();
      }
      armsRan += 1;
    }, 120_000);
  },
);

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (requireDb) expect(armsRan).toBe(1);
  else expect(true).toBe(true);
});
