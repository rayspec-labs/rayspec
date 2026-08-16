/**
 * THE PACK DATABASE DOOR, against a REAL Postgres — the door a service reaches its own tables through.
 *
 * The door used to be one method (`query`), so a pack could write single statements and nothing else.
 * A pack whose correctness rests on writing two rows atomically, or on holding a row lock across a
 * read-decide-write, could not be built on it. `transaction(fn)` is the second method, and the whole
 * of what it promises is a database fact rather than a shape — so every arm here is measured against a
 * live server, with a SECOND connection standing outside as the observer:
 *
 *   (1) WHY THE METHOD EXISTS — the pooled half. A `SELECT … FOR UPDATE` through `query()` holds
 *       NOTHING once the call returns: a second connection takes the same row with `FOR UPDATE NOWAIT`
 *       immediately. Correct behaviour for a pool, and fatal for a lock order. ACCEPT CONTROL: the very
 *       same `NOWAIT` IS refused (55P03) while a `transaction()` callback holds the row — so the probe
 *       reads a real difference rather than never firing.
 *   (1b) AND THE POOLED HALF REFUSES TO PRETEND. `query('BEGIN')` is refused BY THE DOOR, before the
 *       statement reaches the server, and the connection it would have been issued on is unharmed:
 *       the next write through the same door is visible to the observer. Left to the driver the
 *       refusal arrives only after the server has already begun the transaction, and the pooled
 *       connection goes back inside one — measured here as the counterproof, on a throwaway pool.
 *   (2) THE CONNECTION IS PINNED for the callback's duration, and released with it.
 *   (3) ATOMIC, AND ROLLED BACK ON A THROW: two statements in one callback land together; a callback
 *       that throws leaves NEITHER of them visible to the second connection, and the error the caller
 *       catches is the one the callback threw — same instance, same class, same message.
 *   (4) NESTING IS REFUSED with a typed error rather than silently demoted to a savepoint, and the
 *       refusal rolls the transaction it was attempted in back.
 *   (4b) AND SO IS RE-ENTRY THROUGH THE DOOR THE SERVICE HOLDS — `ctx.db.transaction(…)` called from
 *       inside a callback, which is what a helper that closed over the door would do. Left to the
 *       driver that is not nesting at all but a SECOND connection with a transaction of its own, which
 *       commits under a rolled-back outer one; the counterproof measures exactly that. Two
 *       transactions from UNRELATED contexts are the accept control: they are not nesting and both run.
 *   (4c) AND THE REFUSAL ENDS WITH THE CALLBACK. The carve-out's headline case is a context the
 *       callback ITSELF created and left running — arming the periodic sweep in the same transaction
 *       that writes the row it sweeps — which keeps working once the callback settles. Measured on the
 *       timer and on a floating promise, with the counterproof beside it: an `AsyncLocalStorage` store
 *       is INHERITED by such a context, so a scope that is entered and never closed would refuse its
 *       transactions forever, long after the one that opened it committed.
 *   (5) NO WIDENING: the handle the callback receives is exactly a pack database — `query` and
 *       `transaction`, nothing else. A pack has no tenant to name in or out of a transaction (its
 *       context carries no `tenantId`), and opening one hands it no member that could carry one.
 *   (6) THE HONEST LIMIT, pinned so it cannot drift out of the docblock: a statement that FAILS inside
 *       the callback aborts the whole call even when the pack CATCHES it and returns normally — the
 *       driver latches the first error on the pinned connection and re-raises it. A pack's own
 *       savepoint is no way around it, which is why `tx.query('SAVEPOINT …')` is refused outright.
 *
 * DB ISOLATION: one whole throwaway DATABASE named with process.pid, as the neighbouring boot suites.
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
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

  /** Backends this database is holding INSIDE a transaction with nothing running — the poison state. */
  async function idleInTransactionBackends(): Promise<number> {
    const rows = (await second.unsafe(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() ' +
        "AND state = 'idle in transaction'",
    )) as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
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

  it('(1) the pooled half holds no lock — and the accept control fires', async () => {
    armsRan += 1;
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

  it('(1b) the door refuses transaction control on the pooled half, and the pool survives it', async () => {
    armsRan += 1;
    const door = makePackServiceDatabase(db);

    // Every form a pack reaches for, refused BY THE DOOR — the typed refusal, not a database error.
    for (const statement of [
      'BEGIN',
      '  begin;',
      'START TRANSACTION',
      'COMMIT',
      'ROLLBACK',
      'SAVEPOINT sp',
      '-- open one\nBEGIN',
      '/* open one */ BEGIN',
      "PREPARE TRANSACTION 'x'",
    ]) {
      await expect(door.query(statement)).rejects.toBeInstanceOf(PackTransactionError);
      await expect(door.query(statement)).rejects.toThrow(/transaction\(fn\)/);
    }
    // An ordinary statement whose first word merely starts the same way is NOT refused — the accept
    // control for the tripwire, so "everything is refused" cannot pass as "the right thing is".
    expect(await door.query("SELECT 'commitment' AS v")).toEqual([{ v: 'commitment' }]);

    // AND THE POOL IS UNHARMED: the refusal happened before the wire, so the next write through the
    // same door is committed and visible to a connection standing outside.
    await door.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (10, 'after-the-refusal')");
    expect(await observedHolders()).toContain('after-the-refusal');
    await door.query('DELETE FROM pack_tx_ledger WHERE id = 10');

    // COUNTERPROOF, on a throwaway pool of its own at the deployment's own size: left to the driver,
    // the refusal arrives only AFTER the server has already begun the transaction, so the connection
    // goes back to the pool INSIDE one — and everything written on it afterwards is invisible to
    // everyone else, indefinitely. That is what the door refuses before the wire to avoid.
    const unguarded = makeDb(appDbUrl);
    try {
      await expect(unguarded.$client.unsafe('BEGIN')).rejects.toThrow(/UNSAFE_TRANSACTION/);
      expect(await idleInTransactionBackends()).toBeGreaterThan(0);
      await unguarded.$client.unsafe(
        "INSERT INTO pack_tx_ledger (id, holder) VALUES (11, 'swallowed')",
      );
      expect(await observedHolders()).not.toContain('swallowed');
    } finally {
      await unguarded.$client.end();
    }
    expect(await idleInTransactionBackends()).toBe(0);
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

  it('(4b) re-entering through the door the service holds is refused too, and the outer rolls back', async () => {
    armsRan += 1;
    const door = makePackServiceDatabase(db);

    // The ordinary factoring: a helper that closed over the service's OWN `ctx.db` and opened a
    // transaction on it, called from inside another callback. Refused with the same typed error.
    let caught: unknown;
    try {
      await door.transaction(async (tx) => {
        await tx.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (7, 'before-the-reentry')");
        await door.transaction(async (inner) => {
          await inner.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (8, 'reentrant')");
        });
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PackTransactionError);
    expect((caught as Error).message).toMatch(/already inside a transaction/);
    // Neither write survives: the refusal rolled the transaction it was attempted in back, and the
    // inner one never opened at all.
    expect(await observedHolders()).toEqual(['initial', 'paired-a', 'paired-b']);

    // COUNTERPROOF, on a throwaway pool of its own: WITHOUT the refusal the inner call is not a
    // nested transaction but an INDEPENDENT one on a second connection — it commits even though the
    // outer callback then throws and rolls back. That is the partial write the refusal exists for.
    const unguarded = makeDb(appDbUrl, 4);
    try {
      const raw = unguarded.$client;
      await raw
        .begin(async (tx) => {
          await tx.unsafe(
            "INSERT INTO pack_tx_ledger (id, holder) VALUES (7, 'outer-rolled-back')",
          );
          await raw.begin(async (independent) => {
            await independent.unsafe(
              "INSERT INTO pack_tx_ledger (id, holder) VALUES (8, 'committed-anyway')",
            );
          });
          throw new Error('the outer transaction rolls back after all');
        })
        .catch(() => undefined);
      const holders = await observedHolders();
      expect(holders).not.toContain('outer-rolled-back');
      expect(holders).toContain('committed-anyway');
      await raw.unsafe('DELETE FROM pack_tx_ledger WHERE id = 8');
    } finally {
      await unguarded.$client.end();
    }

    // ACCEPT CONTROL: two transactions on the same door from UNRELATED contexts are not nesting, and
    // both run — the guard is scoped to the callback, not a lock on the door.
    const [a, b] = await Promise.all([
      door.transaction(async (tx) => (await tx.query('SELECT 1 AS n'))[0]?.n),
      door.transaction(async (tx) => (await tx.query('SELECT 2 AS n'))[0]?.n),
    ]);
    expect([a, b]).toEqual([1, 2]);
    // And so is one opened AFTER the callback returned, on the same door.
    expect(await door.transaction(async (tx) => (await tx.query('SELECT 3 AS n'))[0]?.n)).toBe(3);
  }, 60_000);

  it('(4c) a context the callback armed keeps working after it settles — the guard ends with the callback', async () => {
    armsRan += 1;
    const door = makePackServiceDatabase(db);

    // THE ORDINARY SHAPE the carve-out is about: write the opening row and ARM THE PERIODIC SWEEP as
    // one decision, so a crash between the two cannot leave the row unswept. The timer is a context
    // CREATED INSIDE the callback and outliving it — not nesting, and not refusable as such.
    const refusals: string[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    const returned = await door.transaction(async (tx) => {
      await tx.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (30, 'armed-the-sweep')");
      timer = setInterval(() => {
        void door
          .transaction(async (sweep) => {
            await sweep.query('UPDATE pack_tx_ledger SET holder = holder || $1 WHERE id = 30', [
              '+',
            ]);
          })
          .catch((e: Error) => refusals.push(e.name));
      }, 20);
      return 'armed';
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      if (timer) clearInterval(timer);
    }
    expect(returned).toBe('armed');
    // Every tick RAN: none refused, and the observer reads the sweeps the timer committed.
    expect(refusals).toEqual([]);
    const swept = (await observedHolders()).find((h) => h.startsWith('armed-the-sweep'));
    expect(swept).toMatch(/^armed-the-sweep\+\+/);

    // The same for a promise the callback left FLOATING, which resolves after it returned.
    let settleFloated: (v: unknown) => void = () => undefined;
    const floated = new Promise<unknown>((resolve) => {
      settleFloated = resolve;
    });
    await door.transaction(async (tx) => {
      await tx.query('SELECT 1 AS n');
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await door
          .transaction(async (later) => (await later.query("SELECT 'ran' AS v"))[0]?.v)
          .then(settleFloated, (e: Error) => settleFloated(`REFUSED: ${e.name}`));
      })();
      return 'left one floating';
    });
    expect(await floated).toBe('ran');

    // COUNTERPROOF — the mechanism WITHOUT that scoping, which is what an `AsyncLocalStorage` entered
    // and never closed does: the store is INHERITED by a context the callback created, so the value a
    // guard would branch on is still set long after the transaction committed, and every transaction
    // that context opens is refused forever with a message asserting a transaction that is over.
    const inherited = new AsyncLocalStorage<true>();
    let readAfterwards: unknown = 'the probe never fired';
    await inherited.run(true, async () => {
      setTimeout(() => {
        readAfterwards = inherited.getStore();
      }, 20);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(readAfterwards).toBe(true);

    await door.query('DELETE FROM pack_tx_ledger WHERE id = 30');
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

  it('(6) a statement that fails inside the callback aborts the call even when the pack catches it', async () => {
    armsRan += 1;
    const door = makePackServiceDatabase(db);
    const before = await observedHolders();

    // The ordinary "catch the unique violation, treat it as already-recorded, carry on" shape. It
    // does NOT carry on: the driver latched the statement's error on the pinned connection and
    // re-raises it once the callback resolves, so the call rejects with the error the pack swallowed
    // and the value the callback returned never reaches the caller.
    let caught: unknown;
    let returned: unknown = 'the callback did not return';
    try {
      returned = await door.transaction(async (tx) => {
        await tx.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (20, 'before-the-failure')");
        try {
          // id 1 is taken — a duplicate key the pack believes it has handled.
          await tx.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (1, 'duplicate')");
        } catch {
          // handled, as far as the pack is concerned
        }
        return 'the value the pack meant to return';
      });
    } catch (e) {
      caught = e;
    }
    expect(returned).toBe('the callback did not return');
    expect((caught as { code?: string }).code).toBe('23505');
    // …and the whole callback rolled back, including the write that had succeeded before it.
    expect(await observedHolders()).toEqual(before);

    // A PACK'S OWN SAVEPOINT IS NOT A WAY AROUND IT, so the door refuses one rather than letting a
    // pack believe it recovered: `ROLLBACK TO SAVEPOINT` would not clear that latch.
    let savepointRefusal: unknown;
    try {
      await door.transaction(async (tx) => {
        await tx.query('SAVEPOINT recover_here');
      });
    } catch (e) {
      savepointRefusal = e;
    }
    expect(savepointRefusal).toBeInstanceOf(PackTransactionError);

    // ACCEPT CONTROL: the same shape with the failing statement REPLACED by a read that decides —
    // which is what the docblock tells a pack to write — commits and returns its value.
    const decided = await door.transaction(async (tx) => {
      const taken = await tx.query('SELECT id FROM pack_tx_ledger WHERE id = $1 FOR UPDATE', [1]);
      if (taken.length > 0) return 'already recorded';
      await tx.query("INSERT INTO pack_tx_ledger (id, holder) VALUES (1, 'recorded')");
      return 'recorded';
    });
    expect(decided).toBe('already recorded');
    expect(await observedHolders()).toEqual(before);
  }, 60_000);
});
