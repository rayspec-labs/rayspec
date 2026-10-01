/**
 * A bounded close of the workflow system database, without the notification listener's race.
 *
 * WHY. The installed 4.21.6 keeps one pooled connection LISTENing on the system database. When that
 * connection drops (a failover, a restart, `ALLOW_CONNECTIONS false`) DBOS reconnects it once a second
 * from a timer: it checks out a client, sends three LISTENs, sends a self-test NOTIFY and waits up to
 * three seconds for it, and only then publishes the client as `notificationsClient`. Its close
 * (`SystemDatabase.destroy`) clears a PENDING reconnect timer, releases the `notificationsClient` it
 * finds and ends the pool, and `pool.end()` waits for every checked-out client. A close that lands
 * while a reconnect is in flight therefore:
 *  - releases the client that already dropped (a second release, which DBOS logs as "Release called
 *    on client which has already been released") instead of the one the reconnect holds;
 *  - waits in `pool.end()` for that client, which the reconnect then publishes and nobody releases,
 *    so the close never returns, and `DBOS.shutdown()` with it; or, when the reconnect fails against
 *    the ending pool instead, arms a fresh reconnect timer that retries every second forever.
 * And the listener it does release keeps DBOS's error handler, which releases the client: the pool
 * forgets a destroyed client at once, so the close returns while its socket is still closing, and a
 * server error that reaches it then (the session ended by a failover, or by a `DROP DATABASE … WITH
 * (FORCE)` right after the shutdown) runs that handler, whose second release throws out of the
 * socket's data callback as an uncaught exception.
 * (DBOS fixed this upstream in later releases with a stop flag the reconnect checks; this package
 * pins 4.21.6.)
 *
 * WHAT THIS DOES. At the moment DBOS starts closing the system database, after its graceful drain,
 * the guard takes over the two fields the reconnect writes: a listener client published from then on
 * is released at once, and a reconnect timer armed from then on is cleared at once. The listener the
 * close releases itself gets, in place of DBOS's handlers, one that only absorbs a late error. The close itself
 * is bounded: when it has not finished within the bound (a connection the server stopped answering
 * holds the pool), the guard lets DBOS's shutdown complete and reports that it gave up, so a host is
 * never held by the engine's teardown. Running workflows are not affected: DBOS awaits them before it
 * closes the system database, and the bound starts only then.
 *
 * The SDK's `exports` map exposes only `.` and `./datasource`, so its executor module is loaded beside
 * the SDK entrypoint, the way `scheduled-workflow.ts` loads the crontab matcher. A missing module or a
 * system database without the fields the guard takes over is an installation fault and says so.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

/** The default bound on closing the workflow system database once the engine has drained. */
export const DEFAULT_SYSTEM_DATABASE_CLOSE_TIMEOUT_MS = 10_000;

/** The parts of a pooled client the guard touches when it releases a listener published too late. */
interface ListenerClient {
  release(destroy?: boolean): void;
  removeAllListeners(): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/** The parts of the installed SDK's `SystemDatabase` the guard takes over. */
export interface SystemDatabaseFields {
  notificationsClient: ListenerClient | null;
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  destroy(): Promise<void>;
}

/** What a guarded close reports once DBOS's shutdown has returned. */
export interface SystemDatabaseClose {
  /** True when the close did not finish within the bound and was abandoned. */
  timedOut(): boolean;
}

let executorClass: { globalInstance?: { systemDatabase?: unknown } } | undefined;

function loadExecutorClass(): { globalInstance?: { systemDatabase?: unknown } } {
  if (executorClass === undefined) {
    try {
      const req = createRequire(import.meta.url);
      const sdkDir = path.dirname(req.resolve('@dbos-inc/dbos-sdk'));
      const mod = req(path.join(sdkDir, 'dbos-executor.js')) as { DBOSExecutor?: unknown };
      if (typeof mod.DBOSExecutor !== 'function') throw new Error('DBOSExecutor is missing');
      executorClass = mod.DBOSExecutor as { globalInstance?: { systemDatabase?: unknown } };
    } catch (e) {
      throw new Error(
        "the workflow engine's executor could not be loaded from the installed '@dbos-inc/dbos-sdk' " +
          `(expected 'dbos-executor.js' beside its entrypoint): ${e instanceof Error ? e.message : String(e)}. ` +
          'This is an SDK-layout fault.',
      );
    }
  }
  return executorClass;
}

/** Whether `value` has the fields the guard takes over, as the installed SDK defines them. */
export function hasSystemDatabaseFields(value: unknown): value is SystemDatabaseFields {
  if (typeof value !== 'object' || value === null) return false;
  const own = (key: string) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d !== undefined && 'value' in d && d.configurable === true;
  };
  return (
    typeof (value as { destroy?: unknown }).destroy === 'function' &&
    own('notificationsClient') &&
    own('reconnectTimeout')
  );
}

/** The launched engine's system database, or undefined when the engine is not launched. */
export function launchedSystemDatabase(): SystemDatabaseFields | undefined {
  const systemDatabase = loadExecutorClass().globalInstance?.systemDatabase;
  if (systemDatabase === undefined) return undefined;
  if (!hasSystemDatabaseFields(systemDatabase)) {
    throw new Error(
      "the installed '@dbos-inc/dbos-sdk' system database has no 'notificationsClient' / " +
        "'reconnectTimeout' fields or no 'destroy' method, which the bounded shutdown takes over. " +
        'This is an SDK-layout fault.',
    );
  }
  return systemDatabase;
}

/**
 * Replace the handlers DBOS put on a listener client with one that only absorbs a late error: DBOS's
 * releases the client, which throws once it has been released, and with no handler at all an 'error'
 * event would itself be thrown.
 */
function absorbErrors(client: ListenerClient): void {
  client.removeAllListeners();
  client.on('error', () => {});
}

/** Release a listener client the reconnect published after the close began; never throws. */
function retire(client: ListenerClient): void {
  absorbErrors(client);
  try {
    client.release(true);
  } catch {
    // Already released: nothing holds the pool.
  }
}

/**
 * Take over the listener fields of `systemDatabase` from the moment its close begins, and bound that
 * close by `timeoutMs`. Call before `DBOS.shutdown()`; read the outcome after it returns.
 */
export function guardSystemDatabaseClose(
  systemDatabase: SystemDatabaseFields,
  timeoutMs: number,
): SystemDatabaseClose {
  let timedOut = false;
  const close = systemDatabase.destroy;

  const stopReconnecting = () => {
    let timer = systemDatabase.reconnectTimeout;
    Object.defineProperty(systemDatabase, 'reconnectTimeout', {
      configurable: true,
      enumerable: true,
      get: () => timer,
      set: (next: ReturnType<typeof setTimeout> | null) => {
        // A timer armed once the close began would reconnect to an ending pool every second.
        if (next === null) timer = null;
        else clearTimeout(next);
      },
    });
    let listener = systemDatabase.notificationsClient;
    // The close releases this one itself (or tries to, when it already dropped).
    if (listener !== null) absorbErrors(listener);
    Object.defineProperty(systemDatabase, 'notificationsClient', {
      configurable: true,
      enumerable: true,
      get: () => listener,
      set: (next: ListenerClient | null) => {
        // A client published once the close began holds the pool open: release it now.
        if (next !== null && next !== listener) retire(next);
        else listener = next;
      },
    });
  };

  systemDatabase.destroy = async function boundedClose(this: SystemDatabaseFields) {
    stopReconnecting();
    const closing = close.call(this);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), timeoutMs);
    });
    try {
      if ((await Promise.race([closing, expired])) === 'expired') {
        timedOut = true;
        // Abandoned: whatever it settles to later is no longer anyone's to handle.
        closing.catch(() => {});
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return { timedOut: () => timedOut };
}
