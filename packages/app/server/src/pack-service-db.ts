/**
 * THE PACK DATABASE DOOR — the object behind `PackServiceContext['db']`, built here because this is
 * where the deployment's one raw handle lives.
 *
 * A pack service reaches the platform tables its OWN migration chain created through a parameterized
 * query executor (see `PackServiceDatabase`). That door used to be one method, so a pack could write
 * single statements and nothing else: a pack whose correctness rests on writing two rows atomically,
 * or on holding a row lock across a read-decide-write, could not be built on it. Not for want of a
 * method name — the handle underneath is POOLED, and on a pooled handle two calls are not promised the
 * same connection: a bare `BEGIN` does not survive the call, and a `SELECT … FOR UPDATE` is released
 * the moment the call returns.
 *
 * So the transactional half is built over a RESERVED connection (`sql.begin`), pinned for the
 * callback's whole duration, and the pooled half is left exactly as it was. What a pack gets inside
 * the callback is the SAME `PackDatabase` — the same parameterized `query`, so the statement a pack
 * writes inside a transaction is the statement it writes outside one.
 *
 * THE PIN COMES OUT OF THE HTTP/API POOL — the ONE the deployment serves requests on. This door is
 * built over the boot's `makeDb(config.databaseUrl)` handle, whose size is `DEFAULT_POOL_MAX` = 4
 * (`@rayspec/db`). It is NOT the durable worker's pool: that one is a separate `makeDb(…, WORKER_POOL_MAX)`
 * of its own, kept separate in the composition root precisely so long-running off-request work cannot
 * starve `/health`, `/events` and every other HTTP database caller. A reserved connection is one of
 * those four and is not returned until the callback returns, so two concurrent pack transactions hold
 * half of it. That is stated on the contract itself (`@rayspec/pack-sdk`), where a pack author reads it.
 *
 * WHAT THE DOOR SCOPES, AND WHAT IT DOES NOT. Both halves run the statement the pack wrote, against
 * the tables the pack's own chain created; the transactional handle carries exactly the members the
 * pooled one carries — no tenant handle, no journal writer, no escape hatch — so opening a transaction
 * is not a way to reach further than `query` already reaches. It is NOT a tenant filter: neither half
 * rewrites a pack's SQL, so what a statement touches is what the pack wrote (the pack runs in the
 * deployment's process as a trusted, non-sandboxed author — the manifest contract's posture note).
 * A service has no `tenantId` on its context in either case; a pack that attributes rows to a tenant
 * gets that value from the deployment, not from this door.
 *
 * ONE STATEMENT PER `query`, ON BOTH HALVES — the contract's own sentence, enforced rather than
 * hoped for. `unsafe` with no bound parameters runs Postgres's SIMPLE-QUERY protocol, which executes
 * EVERY command in the string, so a second command in the string is a second command RUN: a
 * `;`-separated `COMMIT` ends the pin from inside the callback (measured — both rows written around
 * it survived the callback's throw), and a `;`-separated `BEGIN` leaves a pooled connection
 * idle-in-transaction for the life of the process. Refusing the multi-command string closes both
 * without a verb list, and the boundary is decided by the literal-aware splitter `@rayspec/db`
 * already reads migration chains with, so a `;` inside a literal or a comment stays ordinary SQL.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { type Db, splitSqlStatements } from '@rayspec/db';
import type { PackServiceDatabase } from '@rayspec/platform';

/**
 * A refusal raised BY the door — the way a pack learns it asked for something the door does not offer.
 * Its own class (and its own `name`, which is what a pack compiling against the types-only contract
 * can branch on) so a pack reads a refusal as what it is rather than as a database error.
 */
export class PackTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackTransactionError';
  }
}

/** The ONE refusal both nesting paths raise — the direct `tx.transaction`, and the re-entrant one. */
const NESTED_TRANSACTION_MESSAGE =
  'this pack database is already inside a transaction, and a transaction cannot be nested. A second ' +
  'one — opened through `tx`, or through the same `ctx.db` from inside the callback — could only be ' +
  'a SAVEPOINT (a different guarantee under the same name, whose rollback leaves the outer ' +
  'transaction alive and committing) or a genuinely INDEPENDENT transaction on a second pooled ' +
  'connection, which commits even when the outer one rolls back and blocks forever on any row the ' +
  'outer one holds. Do the work in the transaction you are in, or split it into two.';

/** Transaction-control keywords, by first token — the statements that move transaction state. */
const TRANSACTION_CONTROL = new Set([
  'ABORT',
  'BEGIN',
  'COMMIT',
  'END',
  'RELEASE',
  'ROLLBACK',
  'SAVEPOINT',
  'START',
]);
/** The same, where the first token alone is innocent (`PREPARE stmt AS …`, `SET search_path …`). */
const TRANSACTION_CONTROL_PAIRS = new Set(['PREPARE TRANSACTION', 'SET TRANSACTION']);

/**
 * Refuse a statement that would move the connection's transaction state under the door's feet.
 *
 * It reads the leading keywords, after stripping leading whitespace and SQL comments. That is a
 * TRIPWIRE for the direct attempt — `db.query('BEGIN')` is what a pack author tries before finding
 * `transaction()` — and it is deliberately not a parser: a pack is a trusted, non-sandboxed author
 * and can always reach further if it means to. What it buys is that the ordinary mistake fails
 * CLOSED, before the statement reaches the wire, instead of costing the deployment a connection.
 *
 * IT READS THE FIRST TOKEN ONLY, which is why it is not the whole guard — see
 * `refuseMultipleStatements` below, which is what closes the `SELECT 1; COMMIT` shape.
 */
function refuseTransactionControl(sql: string, consequence: string): void {
  const head = sql.replace(/^(?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '');
  const words = /^([A-Za-z]+)(?:\s+([A-Za-z]+))?/.exec(head);
  if (!words) return;
  const first = words[1]?.toUpperCase() ?? '';
  const pair = words[2] ? `${first} ${words[2].toUpperCase()}` : '';
  if (!TRANSACTION_CONTROL.has(first) && !TRANSACTION_CONTROL_PAIRS.has(pair)) return;
  throw new PackTransactionError(
    `a pack database handle does not take the transaction-control statement \`${pair || first}\`: ` +
      `${consequence} Use \`transaction(fn)\`, which pins one connection for the callback and ` +
      'commits or rolls back around it.',
  );
}

/** What issuing one through the POOLED half would cost — the reason it is refused before the wire. */
const POOLED_CONSEQUENCE =
  'the pooled handle does not promise two calls the same connection, and the server starts the ' +
  'transaction before the driver refuses it, so the connection goes back to the pool left inside a ' +
  'transaction nothing ever commits — every later write that lands on it is invisible to everyone ' +
  'else and its locks are held indefinitely.';

/** What issuing one INSIDE a callback would cost — the transaction the callback is running in. */
const PINNED_CONSEQUENCE =
  'the connection is already inside the transaction this callback runs in, so the statement would ' +
  'move or end that transaction under the code that opened it. A savepoint is no way around it ' +
  'either: the driver latches the first statement error on this connection and re-raises it when ' +
  'the callback returns, so a rolled-back savepoint does not make the call succeed.';

/** What to write instead, on the POOLED half — where "together" is what `transaction` is for. */
const POOLED_SPLIT_ADVICE =
  'Issue each statement through its own `query` call, and put them in `transaction(fn)` if they ' +
  'must land together.';

/** The same, INSIDE a callback — where they already land together, so the advice would be circular. */
const PINNED_SPLIT_ADVICE =
  'Issue each statement through its own `query` call — they are already inside this callback’s ' +
  'transaction, so they already land together.';

/**
 * Refuse a string that carries MORE THAN ONE command. This is the guard the tripwire above cannot
 * be: it reads the FIRST token, and every transaction-control verb in the language is reachable
 * behind an innocent one.
 *
 * WHY A SECOND COMMAND IS NOT A SECOND CALL. `query` runs the statement through `postgres`'s
 * `unsafe`, and `unsafe` with no bound parameters selects Postgres's SIMPLE-QUERY protocol, which
 * executes EVERY command in the string on that connection. So `query('SELECT 1; COMMIT')` inside a
 * callback ends the pin — measured: the two rows written around it both survived the callback's
 * throw, and the wrapper's rollback found `25P01 there is no transaction in progress` — and
 * `query('SELECT 1; BEGIN')` on the pooled half leaves its connection idle-in-transaction for the
 * life of the process, because the driver's own refusal arrives only after the server has run it.
 * The extended protocol does not help: `prepare: true` accepts `SELECT 1; SELECT 2` too, so this is
 * a text decision or it is nothing.
 *
 * THIS IS ENFORCING THE CONTRACT, NOT ADDING A RULE. `query` is documented as running ONE
 * parameterized statement, on both halves. A `;`-separated `COMMIT` is refused here for being a
 * SECOND COMMAND rather than for what it says, which is why the guard needs no verb list of its own
 * and closes both shapes at once — including the ones no verb list would have named.
 *
 * THE BOUNDARY DECISION IS NOT MADE HERE. It is `@rayspec/db`'s `splitSqlStatements`, the same
 * literal-aware splitter the pack-migration scan reads, so a `;` inside a string literal, a
 * dollar-quoted body or a comment is NOT a second command in either place. That matters more than
 * the refusal does: a guard that rejected `INSERT INTO t VALUES ('a;b')` would refuse correct code
 * and leave the author a typed error and no way around it.
 *
 * A STRING THE SPLITTER CANNOT READ IS REFUSED TOO, and that branch is not belt-and-braces. Three of
 * the four unterminated-literal kinds are syntax errors the server rejects outright, so passing them
 * through would cost nothing — but the fourth is not. The splitter opens a dollar-quote on the
 * `$tag$` SHAPE, and `$b$` inside the perfectly legal identifier `a$b$c` HAS that shape: measured,
 * `SELECT 1 AS a$b$c; INSERT INTO t (id) VALUES (99)` reads as ONE unterminated statement here while
 * Postgres reads two commands and runs both (row 99 landed). So an unreadable string fails CLOSED.
 * What that costs is an identifier carrying two `$`, which now gets a typed refusal naming the
 * literal instead of running — the one accept-control case this guard knowingly gives up, written
 * down here so the next reader does not mistake the branch for paranoia and delete it.
 */
function refuseMultipleStatements(sql: string, advice: string): void {
  const { statements, unterminated } = splitSqlStatements(sql);
  if (unterminated) {
    throw new PackTransactionError(
      'a pack database handle could not read where the commands in this string end: an ' +
        `unterminated ${unterminated.what} runs to the end of it, so everything after it was read ` +
        'as part of that literal and a second command could be hiding behind it. Close the literal ' +
        `— or, if it is an identifier carrying a \`$…$\` run, quote it ("a$b$c"). ${advice}`,
    );
  }
  if (statements.length <= 1) return;
  throw new PackTransactionError(
    `a pack database handle runs ONE statement per \`query\` call, and this string carries ` +
      `${statements.length} commands. A multi-command string is sent in Postgres's simple-query ` +
      'mode, which runs every command in it — so a `;`-separated `COMMIT`, `BEGIN` or `ROLLBACK` ' +
      'would move the connection’s transaction state however the leading statement reads. ' +
      advice,
  );
}

/**
 * Build the database door over the deployment's one raw handle.
 *
 * `query` is the pooled executor. `transaction` reserves a connection for the callback, commits when
 * it returns and rolls back when it throws, re-raising the value the callback threw so a pack's own
 * error class and message reach the caller intact.
 *
 * NESTING IS REFUSED rather than silently reinterpreted, and the refusal covers BOTH ways a pack can
 * reach for a second transaction. The direct one — `tx.transaction(…)` — throws from the handle
 * itself. The RE-ENTRANT one — calling `transaction` again on the same `ctx.db` the service holds for
 * its whole life, from inside a callback, which is the ordinary factoring once a helper takes a
 * `PackDatabase` — is caught by an `AsyncLocalStorage` scope that is open for exactly the callback's
 * duration. Left to the driver, that second call is not a savepoint at all: it reserves a SECOND
 * connection out of the same four-connection pool and opens an independent transaction, which commits
 * even when the outer callback throws and rolls back, and blocks forever on any row the outer one
 * holds (the outer is awaiting it, and there is no `lock_timeout`). Both refusals are failures inside
 * the callback like any other, so the transaction they were attempted in rolls back.
 *
 * WHAT IS *NOT* REFUSED: a transaction opened on this door from an UNRELATED async context — a timer
 * the service armed, a second request in flight — is not nesting and runs as its own transaction on
 * its own connection, exactly as before. That includes a context the callback itself CREATED and left
 * running — the sweep a service arms in the same transaction that writes the row it sweeps — once the
 * callback has settled, which is what the scope's `open` flag below buys.
 */
export function makePackServiceDatabase(db: Db): PackServiceDatabase {
  const client = db.$client;
  /**
   * Open for exactly one callback's duration — how a re-entrant `transaction` is recognised.
   *
   * The flag is not ceremony. An `AsyncLocalStorage` store is INHERITED by every async context created
   * inside the callback, and those contexts OUTLIVE it: a timer armed there, a promise left floating.
   * Entering a store and never closing it would therefore refuse THEIR transactions forever, long after
   * this one committed, with a message asserting a transaction that is over. Closing the scope when the
   * callback settles ends the refusal with the callback rather than with the context tree it created.
   */
  const insideTransaction = new AsyncLocalStorage<{ open: boolean }>();

  return {
    query: async (sql: string, params: readonly unknown[] = []) => {
      refuseTransactionControl(sql, POOLED_CONSEQUENCE);
      refuseMultipleStatements(sql, POOLED_SPLIT_ADVICE);
      return (await client.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];
    },

    transaction: async <T>(fn: (tx: PackServiceDatabase) => Promise<T>): Promise<T> => {
      if (insideTransaction.getStore()?.open === true) {
        throw new PackTransactionError(NESTED_TRANSACTION_MESSAGE);
      }
      const scope = { open: true };
      // `client.begin` resolves an ARRAY its callback returns element by element (a `Promise.all`
      // convenience) — but ONLY for a callback that returns one SYNCHRONOUSLY, and the callback below
      // is `async`, so what it returns is always a Promise and that branch cannot fire. The cast is
      // the driver's return type (`UnwrapPromiseArray<T>`) staying deferred over a naked `T`.
      return (await client.begin(async (tx) =>
        insideTransaction.run(scope, async () => {
          try {
            return await fn({
              query: async (sql: string, params: readonly unknown[] = []) => {
                refuseTransactionControl(sql, PINNED_CONSEQUENCE);
                refuseMultipleStatements(sql, PINNED_SPLIT_ADVICE);
                return (await tx.unsafe(sql, params as never[])) as unknown as Record<
                  string,
                  unknown
                >[];
              },
              transaction: async () => {
                throw new PackTransactionError(NESTED_TRANSACTION_MESSAGE);
              },
            });
          } finally {
            // Ends the refusal with the callback — a context it created and left running is not
            // nesting once the transaction is over, and must not be refused as if it were.
            scope.open = false;
          }
        }),
      )) as T;
    },
  };
}
