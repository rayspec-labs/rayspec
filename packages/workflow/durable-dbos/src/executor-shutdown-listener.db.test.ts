/**
 * The engine shuts down while its notification listener is reconnecting — DB-backed test.
 *
 * After an outage of the workflow system database DBOS reconnects its LISTEN connection once a second:
 * it checks out a pooled client, LISTENs, sends a self-test NOTIFY and waits for it, and only then
 * publishes the client as its listener. The installed 4.21.6 closes the system database by releasing
 * the listener it last published and ending the pool, and `pool.end()` waits for every checked-out
 * client. A shutdown that lands inside that reconnect therefore waited forever: the client the
 * reconnect checked out was published after the close had looked, and nothing released it. That is
 * how CI's `scheduled-workflow.db.test.ts` hung in its afterAll once every test had passed.
 *
 * A TCP proxy in front of Postgres (`test-support/listener-proxy.ts`) drops the listener and holds
 * the server's bytes to the reconnecting one, so the shutdown lands at an exact point. WHAT THIS PROVES:
 *  1. a shutdown during a reconnect that is past its self-test resolves, every connection of the
 *     system database closes, and no reconnect follows;
 *  2. a shutdown during a reconnect whose server stopped answering settles within the configured
 *     bound and says why, and the reconnect does not start again once the server answers;
 *  3. a server error that reaches the released listener while its socket closes (the session ended
 *     by a failover, or by `DROP DATABASE … WITH (FORCE)` right after the shutdown) raises nothing:
 *     the 4.21.6 close releases that client but leaves DBOS's error handler on it, which released it a
 *     second time and threw out of the socket's data callback, an uncaught exception.
 *
 * RED without the guard in `system-database-close.ts`: the first two shutdowns never settle, and the
 * third raises "Release called on client which has already been released" uncaught.
 * Skips without DATABASE_URL; the ran-guard hard-fails a REQUIRED run.
 */
import { makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbosDurableExecutor } from './index.js';
import {
  type WorkflowSystemDatabase,
  workflowSystemDatabase,
} from './test-support/engine-databases.js';
import { type ListenerProxy, startListenerProxy } from './test-support/listener-proxy.js';

const PID = process.pid;
const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !baseUrl) {
  throw new Error(
    'executor-shutdown-listener.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
      'but absent — refusing to silently skip this DB-backed suite.',
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
    await pause(50);
  }
}

type Settled = { settled: true; error?: unknown; ms: number } | { settled: false };

/** Whether `p` settles within `ms`, without letting a promise that never settles hang the test. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<Settled> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    p.then(
      () => ({ settled: true as const, ms: Date.now() - started }),
      (error: unknown) => ({ settled: true as const, error, ms: Date.now() - started }),
    ),
    new Promise<Settled>((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), ms);
    }),
  ]);
  clearTimeout(timer);
  return outcome;
}

/** One engine whose workflow system database is reached through a listener proxy. */
function engineThroughProxy(arm: string, closeTimeoutMs?: number) {
  const sysDb = `rayspec_dbos_shutdown_${arm}_${PID}_sys`;
  const state: {
    admin?: postgres.Sql;
    appDb?: ReturnType<typeof makeDb>;
    system?: WorkflowSystemDatabase;
    proxy?: ListenerProxy;
    executor?: DbosDurableExecutor;
  } = {};

  beforeAll(async () => {
    const url = baseUrl as string;
    state.admin = postgres(withDbName(url, 'postgres'), { max: 1 });
    await state.admin.unsafe(`DROP DATABASE IF EXISTS "${sysDb}" WITH (FORCE)`);
    state.appDb = makeDb(url, 2);
    // The superuser's system database, or in the runtime-role lane the runtime role's.
    state.system = await workflowSystemDatabase(withDbName(url, sysDb));
    state.proxy = await startListenerProxy(state.system.url);
    state.executor = new DbosDurableExecutor(
      {
        db: state.appDb,
        resolveRun: () => {
          throw new Error('resolveRun is not used: nothing is enqueued');
        },
      },
      {
        name: `rayspec-shutdown-${arm}-${PID}`,
        systemDatabaseUrl: state.proxy.route(state.system.url),
        deregisterOnShutdown: true,
        ...(closeTimeoutMs !== undefined ? { systemDatabaseCloseTimeoutMs: closeTimeoutMs } : {}),
      },
    );
    await state.executor.start();
  }, 60_000);

  afterAll(async () => {
    try {
      state.proxy?.release();
      // A no-op once the arm shut the engine down; the cleanup path if the arm failed before it.
      if (state.executor) await settlesWithin(state.executor.shutdown(), 15_000);
    } finally {
      await state.proxy?.close();
      await state.appDb?.$client.end();
      await state.admin?.unsafe(`DROP DATABASE IF EXISTS "${sysDb}" WITH (FORCE)`);
      await state.system?.close();
      await state.admin?.end();
    }
  }, 60_000);

  return state;
}

describe.skipIf(!baseUrl)('an engine shut down while its listener reconnects', () => {
  describe('past the reconnect self-test', () => {
    const state = engineThroughProxy('selftest');

    it('resolves, closes every system-database connection, and starts no reconnect', async () => {
      const proxy = state.proxy as ListenerProxy;
      const executor = state.executor as DbosDurableExecutor;

      // The listener drops; its reconnect sends the self-test NOTIFY, which the proxy keeps from it.
      const held = proxy.holdNextListener('self-test');
      proxy.dropListeners();
      await settlesWithin(held, 15_000);

      const shutdown = await settlesWithin(executor.shutdown(), 15_000);
      expect(shutdown).toMatchObject({ settled: true });
      expect(shutdown.settled && shutdown.error).toBeFalsy();

      // The pool ended, so the proxy carries nothing; and nothing reconnects afterwards.
      await eventually(() => proxy.open() === 0, 5_000);
      const accepted = proxy.accepted();
      await pause(2_500);
      expect(proxy.accepted()).toBe(accepted);
      armsRan += 1;
    }, 60_000);
  });

  describe('while the server stopped answering the reconnect', () => {
    const CLOSE_TIMEOUT_MS = 2_000;
    const state = engineThroughProxy('stalled', CLOSE_TIMEOUT_MS);

    it('settles within the bound, says why, and does not reconnect once the server answers', async () => {
      const proxy = state.proxy as ListenerProxy;
      const executor = state.executor as DbosDurableExecutor;

      // The reconnect's first LISTEN gets no answer: the close cannot end that connection.
      const held = proxy.holdNextListener('listen');
      proxy.dropListeners();
      await settlesWithin(held, 15_000);

      const shutdown = await settlesWithin(executor.shutdown(), 15_000);
      expect(shutdown).toMatchObject({ settled: true });
      if (!shutdown.settled) return;
      expect(shutdown.ms).toBeLessThan(CLOSE_TIMEOUT_MS + 3_000);
      expect(String(shutdown.error)).toMatch(
        new RegExp(`workflow system database did not close within ${CLOSE_TIMEOUT_MS} ms`),
      );

      // The server answers again: the abandoned reconnect fails against the ended pool, gives its
      // connection back, and schedules no further attempt.
      proxy.release();
      await eventually(() => proxy.open() === 0, 5_000);
      const accepted = proxy.accepted();
      await pause(2_500);
      expect(proxy.accepted()).toBe(accepted);
      armsRan += 1;
    }, 60_000);
  });

  describe('when the server ends the listener session as it closes', () => {
    const state = engineThroughProxy('fatal');

    it('resolves and raises nothing uncaught', async () => {
      const proxy = state.proxy as ListenerProxy;
      const executor = state.executor as DbosDurableExecutor;
      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown) => {
        uncaught.push(error);
      };
      process.on('uncaughtException', onUncaught);
      try {
        // The close releases the live listener; the server's FATAL reaches it before its socket ends.
        proxy.failListenersOnClose();
        const shutdown = await settlesWithin(executor.shutdown(), 15_000);
        expect(shutdown).toMatchObject({ settled: true });
        expect(shutdown.settled && shutdown.error).toBeFalsy();
        await eventually(() => proxy.open() === 0, 5_000);
        await pause(500);
      } finally {
        process.off('uncaughtException', onUncaught);
      }
      expect(uncaught.map(String)).toEqual([]);
      armsRan += 1;
    }, 60_000);
  });
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (requireDb) expect(armsRan).toBe(3);
  else expect(true).toBe(true);
});
