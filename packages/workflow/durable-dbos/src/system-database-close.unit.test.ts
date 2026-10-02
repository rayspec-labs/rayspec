/**
 * The bounded close of the workflow system database (system-database-close.ts), without a database.
 *
 * The DB-backed proof is `executor-shutdown-listener.db.test.ts`; this pins the guard's own contract
 * on a stand-in system database, and that the installed SDK still has the fields the guard takes over
 * (an SDK upgrade that renamed them would otherwise leave the shutdown unguarded without a word).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  guardSystemDatabaseClose,
  hasSystemDatabaseFields,
  type SystemDatabaseFields,
} from './system-database-close.js';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeClient {
  released: boolean[];
  errorListeners: number;
  cleared: number;
  release(destroy?: boolean): void;
  removeAllListeners(): void;
  on(event: 'error', listener: (error: unknown) => void): void;
}

function fakeClient(): FakeClient {
  const client: FakeClient = {
    released: [],
    errorListeners: 1,
    cleared: 0,
    release(destroy) {
      if (client.released.length > 0)
        throw new Error('Release called on client which has already been released');
      client.released.push(destroy === true);
    },
    removeAllListeners() {
      client.cleared += 1;
      client.errorListeners = 0;
    },
    on() {
      client.errorListeners += 1;
    },
  };
  return client;
}

/** A stand-in with the installed SDK's field layout and a close that ends when `finish` is called. */
function fakeSystemDatabase() {
  let finish: () => void = () => {};
  const db = {
    notificationsClient: null as FakeClient | null,
    reconnectTimeout: null as ReturnType<typeof setTimeout> | null,
    closes: 0,
    async destroy() {
      db.closes += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  };
  return { db, finish: () => finish() };
}

describe('the installed SDK', () => {
  it('has the system database fields the guard takes over, as plain own fields', async () => {
    const req = createRequire(import.meta.url);
    const sdkDir = path.dirname(req.resolve('@dbos-inc/dbos-sdk'));
    const { SystemDatabase } = req(path.join(sdkDir, 'system_database.js')) as {
      SystemDatabase: new (
        url: string,
        logger: unknown,
        serializer: unknown,
      ) => { pool: { end(): Promise<void> } };
    };
    // Constructing it opens nothing: the pool connects on first use.
    const systemDatabase = new SystemDatabase('postgres://nobody@127.0.0.1:1/none', {}, {});
    try {
      expect(hasSystemDatabaseFields(systemDatabase)).toBe(true);
    } finally {
      await systemDatabase.pool.end();
    }
  });
});

describe('guardSystemDatabaseClose', () => {
  it('leaves the fields alone until the close begins', () => {
    const { db } = fakeSystemDatabase();
    guardSystemDatabaseClose(db as unknown as SystemDatabaseFields, 1_000);
    const client = fakeClient();
    db.notificationsClient = client;
    expect(db.notificationsClient).toBe(client);
    expect(client.released).toEqual([]);
    expect(client.cleared).toBe(0);
  });

  it('releases a listener the reconnect publishes once the close began, and absorbs its later errors', async () => {
    const { db, finish } = fakeSystemDatabase();
    const stale = fakeClient();
    db.notificationsClient = stale;
    guardSystemDatabaseClose(db as unknown as SystemDatabaseFields, 5_000);
    const closing = db.destroy();

    // The listener the close releases itself loses DBOS's handlers for one that absorbs errors.
    expect(stale.cleared).toBe(1);
    expect(stale.errorListeners).toBe(1);
    expect(stale.released).toEqual([]);

    const late = fakeClient();
    db.notificationsClient = late;
    expect(late.released).toEqual([true]);
    expect(late.cleared).toBe(1);
    expect(late.errorListeners).toBe(1);
    // The client the close found is still the one it reads.
    expect(db.notificationsClient).toBe(stale);
    // A second publication of the released client does not release it twice.
    expect(() => {
      db.notificationsClient = late;
    }).not.toThrow();

    finish();
    await closing;
    expect(db.closes).toBe(1);
  });

  it('clears a reconnect timer armed once the close began', async () => {
    const { db, finish } = fakeSystemDatabase();
    guardSystemDatabaseClose(db as unknown as SystemDatabaseFields, 5_000);
    const closing = db.destroy();

    let reconnected = false;
    db.reconnectTimeout = setTimeout(() => {
      reconnected = true;
    }, 10);
    // The reconnect checks this field before it arms another timer; it must not read as pending.
    expect(db.reconnectTimeout).toBeNull();
    await pause(50);
    expect(reconnected).toBe(false);

    finish();
    await closing;
  });

  it('resolves a close that does not finish within the bound and reports it', async () => {
    const { db } = fakeSystemDatabase();
    const close = guardSystemDatabaseClose(db as unknown as SystemDatabaseFields, 100);
    const started = Date.now();
    await db.destroy();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(close.timedOut()).toBe(true);
  });

  it('reports no timeout for a close that finishes, and passes its failure on', async () => {
    const { db, finish } = fakeSystemDatabase();
    const close = guardSystemDatabaseClose(db as unknown as SystemDatabaseFields, 5_000);
    const closing = db.destroy();
    finish();
    await closing;
    expect(close.timedOut()).toBe(false);

    const failing = {
      notificationsClient: null,
      reconnectTimeout: null,
      destroy: async () => {
        throw new Error('pool end failed');
      },
    };
    const failed = guardSystemDatabaseClose(failing as unknown as SystemDatabaseFields, 5_000);
    await expect(failing.destroy()).rejects.toThrow('pool end failed');
    expect(failed.timedOut()).toBe(false);
  });
});
