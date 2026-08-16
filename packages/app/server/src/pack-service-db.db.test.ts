/**
 * THE PACK DATABASE DOOR, against a REAL Postgres — the door a service reaches its own tables through.
 *
 * The door used to be one method (`query`), so a pack could write single statements and nothing else.
 * A pack whose correctness rests on writing two rows atomically, or on holding a row lock across a
 * read-decide-write, could not be built on it. `transaction(fn)` is the second method, and the whole
 * of what it promises is a database fact rather than a shape — so every arm here is measured against a
 * live server, with a SECOND connection standing outside as the observer:
 *
 *   (1) WHY THE METHOD EXISTS — the pooled half, unchanged. A bare `BEGIN` through `query()` is
 *       refused by the driver (`UNSAFE_TRANSACTION`), and a `SELECT … FOR UPDATE` through `query()`
 *       holds NOTHING once the call returns: a second connection takes the same row with
 *       `FOR UPDATE NOWAIT` immediately. Correct behaviour for a pool, and fatal for a lock order.
 *       ACCEPT CONTROL: the very same `NOWAIT` IS refused (55P03) while a `transaction()` callback
 *       holds the row — so the probe reads a real difference rather than never firing.
 *   (2) THE CONNECTION IS PINNED for the callback's duration, and released with it.
 *   (3) ATOMIC, AND ROLLED BACK ON A THROW: two statements in one callback land together; a callback
 *       that throws leaves NEITHER of them visible to the second connection, and the error the caller
 *       catches is the one the callback threw — same instance, same class, same message.
 *   (4) NESTING IS REFUSED with a typed error rather than silently demoted to a savepoint, and the
 *       refusal rolls the transaction it was attempted in back.
 *   (5) NO WIDENING: the handle the callback receives is exactly a pack database — `query` and
 *       `transaction`, nothing else. A pack has no tenant to name in or out of a transaction (its
 *       context carries no `tenantId`), and opening one hands it no member that could carry one.
 *
 * DB ISOLATION: one whole throwaway DATABASE named with process.pid, as the neighbouring boot suites.
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePackServiceDatabase, PackTransactionError } from './pack-service-db.js';

const baseUrl = process.env.DATABASE_URL;
const SUITE_DB = `rayspec_pack_tx_${process.pid}`;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

if (dbRequired && !baseUrl) {
  throw new Error(
    'pack-service-db.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent ' +
      '— refusing to silently skip this DB-backed suite.',
  );
}

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

describe.skipIf(!baseUrl)('the pack database door', () => {
  let appDbUrl = '';
  let db: ReturnType<typeof makeDb>;
  /** The OBSERVER — a connection of its own, so every lock/rollback claim is read from outside. */
  let second: postgres.Sql;

  /** Take row 1 with `FOR UPDATE NOWAIT` from the observer: what the row's holder looks like outside. */
  async function observerTakesRow(): Promise<'took-the-row' | string> {
    try {
      await second.unsafe('SELECT id FROM pack_tx_ledger WHERE id = 1 FOR UPDATE NOWAIT');
      return 'took-the-row';
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  }

  /** What the observer sees in the ledger — read on its OWN connection, never the door's. */
  async function observedHolders(): Promise<string[]> {
    const rows = (await second.unsafe(
      'SELECT holder FROM pack_tx_ledger ORDER BY id',
    )) as unknown as { holder: string }[];
    return rows.map((r) => r.holder);
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    // The deployment's one handle, at its production pool size — the handle the door is built over.
    db = makeDb(appDbUrl);
    second = postgres(appDbUrl, { max: 1 });
    await db.$client.unsafe(
      'CREATE TABLE pack_tx_ledger (id int PRIMARY KEY, holder text NOT NULL)',
    );
  }, 60_000);

  afterAll(async () => {
    await second?.end();
    await db?.$client.end();
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
    if (dbRequired && armsRan === 0) {
      throw new Error(
        'pack-service-db.db.test: the DB was REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but no arm ' +
          'ran — refusing to report a green that measured nothing.',
      );
    }
  }, 60_000);

  it('(1) the pooled half cannot open one, and holds no lock — and the accept control fires', async () => {
    armsRan += 1;
    // A handle of THIS arm's own: the driver refuses the `BEGIN` only after the server has already
    // started the transaction, so the pooled connection it was issued on stays inside one. That is a
    // second reason a pack must not try — and a reason this arm must not hand its pool to the others.
    const poisoned = makeDb(appDbUrl);
    try {
      const door = makePackServiceDatabase(poisoned);
      await expect(door.query('BEGIN')).rejects.toThrow(/UNSAFE_TRANSACTION/);
    } finally {
      await poisoned.$client.end();
    }

    const door = makePackServiceDatabase(db);
    await door.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (1, 'initial')");

    // Through `query()`, the lock is gone the moment the call returns.
    await door.query('SELECT id FROM pack_tx_ledger WHERE id = 1 FOR UPDATE');
    expect(await observerTakesRow()).toBe('took-the-row');

    // ACCEPT CONTROL: the same statement, from the same observer, IS refused while the transactional
    // door holds the row — so the reading above is a real difference, not a probe that never fires.
    await door.transaction(async (tx) => {
      await tx.query('SELECT id FROM pack_tx_ledger WHERE id = 1 FOR UPDATE');
      expect(await observerTakesRow()).toBe('55P03');
    });
  }, 60_000);

  it('(2) the connection is pinned for the callback, and released with it', async () => {
    armsRan += 1;
    const door = makePackServiceDatabase(db);
    await door.transaction(async (tx) => {
      await tx.query('SELECT id FROM pack_tx_ledger WHERE id = 1 FOR UPDATE');
      expect(await observerTakesRow()).toBe('55P03');
    });
    // The pin is the CALLBACK's, not the door's: once it returns, the row is anybody's again.
    expect(await observerTakesRow()).toBe('took-the-row');
  }, 60_000);

  it('(3) two statements land together, a throw rolls both back, and the error is the pack’s own', async () => {
    armsRan += 1;
    const door = makePackServiceDatabase(db);

    const written = await door.transaction(async (tx) => {
      await tx.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (2, 'paired-a')");
      await tx.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (3, 'paired-b')");
      return await tx.query('SELECT holder FROM pack_tx_ledger ORDER BY id');
    });
    // The callback's own return value reaches the caller unchanged — rows included.
    expect(written.map((r) => r.holder)).toEqual(['initial', 'paired-a', 'paired-b']);
    expect(await observedHolders()).toEqual(['initial', 'paired-a', 'paired-b']);

    class LedgerAbandoned extends Error {}
    const thrown = new LedgerAbandoned('the ledger sweep was abandoned mid-write');
    let caught: unknown;
    try {
      await door.transaction(async (tx) => {
        await tx.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (4, 'rolled-back-a')");
        await tx.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (5, 'rolled-back-b')");
        throw thrown;
      });
    } catch (e) {
      caught = e;
    }
    // The error propagates UNCHANGED — the same instance, so class and message survive too.
    expect(caught).toBe(thrown);
    expect(caught).toBeInstanceOf(LedgerAbandoned);
    // And the rollback is what the OBSERVER sees: neither half of the abandoned pair is there.
    expect(await observedHolders()).toEqual(['initial', 'paired-a', 'paired-b']);
  }, 60_000);

  it('(4) a nested transaction is REFUSED with a typed error, and the outer one rolls back', async () => {
    armsRan += 1;
    const door = makePackServiceDatabase(db);
    let caught: unknown;
    try {
      await door.transaction(async (tx) => {
        await tx.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (6, 'before-the-nesting')");
        await tx.transaction(async () => 'never reached');
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PackTransactionError);
    expect((caught as Error).message).toMatch(/already inside a transaction/);
    // The refusal is a failure like any other: what the callback had written is gone.
    expect(await observedHolders()).toEqual(['initial', 'paired-a', 'paired-b']);
  }, 60_000);

  it('(5) the callback is handed a pack database and nothing wider', async () => {
    armsRan += 1;
    const door = makePackServiceDatabase(db);
    const [members, sameRows] = await door.transaction(async (tx) => {
      // Exactly the two members of the contract: there is no tenant handle, no journal writer and no
      // escape hatch on it, so a transaction cannot be the seam a pack widens its reach through.
      const keys = Object.keys(tx).sort();
      const inside = await tx.query('SELECT holder FROM pack_tx_ledger ORDER BY id');
      return [keys, inside.map((r) => r.holder)] as const;
    });
    expect(members).toEqual(['query', 'transaction']);
    // Same reach, not a wider one: the pinned handle reads exactly what the pooled one reads.
    expect(sameRows).toEqual(await observedHolders());
  }, 60_000);
});
