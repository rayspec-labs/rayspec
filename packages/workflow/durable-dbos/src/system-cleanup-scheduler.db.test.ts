/**
 * The SYSTEM cleanup scheduler — DB-backed test.
 *
 * Drives the REAL DBOS engine (`DbosDurableExecutor`) + the `SystemCleanupScheduler` against a
 * throwaway DBOS SYSTEM database (no app schema needed — the cleanup logic is INJECTED as a fake, so this
 * test proves the SCHEDULER wiring, not the cleanup SQL — that is `cleanup.db.test.ts` in api-auth). It
 * proves, on GROUND TRUTH (the WHOLE invariant, un-skippable):
 *
 *  1. The scheduled-workflow REGISTERS in the executor's pre-launch window (no throw at launch) — exercises
 *     `attachPreLaunchHook(() => scheduler.registerScheduledWorkflow())` exactly as the composition root wires it.
 *  2. `runCleanupNow()` invokes the injected `runCleanup` EXACTLY ONCE and returns its structured outcome —
 *     the same path the daily scheduled-workflow body fires on (the deterministic seam, like cron's fireNow).
 *  3. The injected cleanup is the SINGLE source of truth (the scheduler adds no deletes of its own — it only
 *     registers + logs); a second `runCleanupNow()` invokes the cleanup again (naturally idempotent ops).
 *
 * Single-executor deterministic harness (the single-executor pattern): pid-unique sys DB, one executor,
 * a clean shutdown before dropping the sys DB. NEVER run two DBOS suites concurrently (process-global singleton).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbosDurableExecutor, type SystemCleanupOutcome, SystemCleanupScheduler } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '..', '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const PID = process.pid;
const DBOS_SYS_DB = `rayspec_dbos_cleanup_${PID}_sys`;
const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite proves the system-cleanup scheduler wiring over a REAL
// DBOS engine — it must never silently self-skip to a false green. When the DB is REQUIRED but absent,
// hard-fail at collection rather than skip.
if (requireDb && !hasDb) {
  throw new Error(
    'system-cleanup-scheduler.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip this DB-backed suite.',
  );
}

let executor: DbosDurableExecutor;
let scheduler: SystemCleanupScheduler;
let appBaseUrl: string;

/** The injected fake cleanup: records each invocation + returns a canned outcome (the scheduler logs it). */
let cleanupCalls = 0;
const fakeOutcome: SystemCleanupOutcome = {
  oidcPruned: 7,
  gdpr: { mode: 'disabled', users: 2, memberships: 3, oldestTombstoneAgeDays: 41 },
};
async function fakeRunCleanup(): Promise<SystemCleanupOutcome> {
  cleanupCalls += 1;
  return fakeOutcome;
}

/** A silent logger so the test does not spam — we assert on the RETURNED outcome, not the log (robust). */
const silentLogger = { info: () => {}, error: () => {} };

function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function dropSysDbSafely(baseUrl: string, sysDb: string): Promise<void> {
  const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${sysDb}"`);
        return;
      } catch (e) {
        if (attempt === 5) throw e;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  } finally {
    await admin.end();
  }
}

describe.skipIf(!hasDb)('SystemCleanupScheduler — registers + runs the injected cleanup', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL as string;
    appBaseUrl = url;
    await dropSysDbSafely(url, DBOS_SYS_DB);

    // The executor needs an app DB handle for its resolveRun (unused here — the cleanup body never
    // enqueues a run). Point it at the app DB; we never touch app tables in this suite.
    const { makeDb } = await import('@rayspec/db');
    const appDb = makeDb(url, 2);

    executor = new DbosDurableExecutor(
      {
        db: appDb,
        resolveRun: () => {
          throw new Error('resolveRun not used in the cleanup scheduler test');
        },
      },
      { name: `rayspec-cleanup-${PID}`, systemDatabaseUrl: withDbName(url, DBOS_SYS_DB) },
    );

    scheduler = new SystemCleanupScheduler({
      runCleanup: fakeRunCleanup,
      schedule: '0 3 * * *',
      logger: silentLogger,
      executor,
    });
    // Register the scheduled workflow in the pre-launch window (the composition-root wiring shape).
    executor.attachPreLaunchHook(() => scheduler.registerScheduledWorkflow());
    await executor.start();
    // Keep a close() for the appDb pool too.
    (executor as unknown as { _appDb?: ReturnType<typeof makeDb> })._appDb = appDb;
  }, 60_000);

  beforeEach(() => {
    cleanupCalls = 0;
  });

  afterAll(async () => {
    try {
      await executor.shutdown();
    } finally {
      const appDb = (executor as unknown as { _appDb?: { $client: { end: () => Promise<void> } } })
        ._appDb;
      if (appDb) await appDb.$client.end();
      await dropSysDbSafely(appBaseUrl, DBOS_SYS_DB);
    }
  }, 30_000);

  it('exposes the configured schedule (the daily crontab)', () => {
    expect(scheduler.schedule).toBe('0 3 * * *');
  });

  it('registered the scheduled-workflow in the pre-launch window (no throw at launch)', () => {
    // If registration had thrown or landed in the wrong window, executor.start() (beforeAll) would have
    // failed and this suite would not have reached here. The successful start IS the proof.
    expect(scheduler).toBeInstanceOf(SystemCleanupScheduler);
  });

  it('runCleanupNow invokes the injected cleanup EXACTLY ONCE and returns its structured outcome', async () => {
    const outcome = await scheduler.runCleanupNow();
    expect(cleanupCalls).toBe(1);
    expect(outcome).toEqual(fakeOutcome);
    expect(outcome.oidcPruned).toBe(7);
    expect(outcome.gdpr.mode).toBe('disabled');
  });

  it('a second runCleanupNow invokes the cleanup again (naturally idempotent ops, no reserve)', async () => {
    await scheduler.runCleanupNow();
    await scheduler.runCleanupNow();
    expect(cleanupCalls).toBe(2);
  });
});
