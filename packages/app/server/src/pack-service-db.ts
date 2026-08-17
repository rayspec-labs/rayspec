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
 * ONE STATEMENT PER `query`, ON BOTH HALVES — the contract's own sentence, enforced by the SERVER.
 * `unsafe` with no bound parameters used to fall back to Postgres's SIMPLE-QUERY protocol, which
 * executes EVERY command in the string, so a second command in the string was a second command RUN:
 * a `;`-separated `COMMIT` ended the pin from inside the callback (measured — both rows written
 * around it survived the callback's throw), and a `;`-separated `BEGIN` left a pooled connection
 * idle-in-transaction for the life of the process. Both calls now pass `{ simple: false }`, so the
 * statement goes over the EXTENDED protocol and Postgres itself refuses a multi-command string at
 * parse time, before any part of it runs. The reason it is the server and not a scan of ours is
 * written at `asPackRefusal` below, and it is the whole argument: a hand-written parser was measured
 * wrong in both directions, and cannot be proven equivalent to the grammar the server parses.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '@rayspec/db';
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
 * IT READS THE FIRST TOKEN ONLY, and it is still LOAD-BEARING under the extended protocol: measured,
 * a bare `BEGIN` sent with `{ simple: false }` still reaches the wire and still leaves the connection
 * idle in transaction, because it is one perfectly valid command. What the server refuses is a string
 * carrying SEVERAL commands, which is a different claim — so `SELECT 1; COMMIT` is the server's case
 * and a bare `COMMIT` is this one. Neither guard covers the other.
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

/**
 * ONE COMMAND PER CALL — decided by the SERVER, not by a parser of ours.
 *
 * `query` is documented as running ONE parameterized statement. Enforcing that with a text scan was
 * tried and MEASURED, and it was wrong in BOTH directions. It read as ONE command, while the server
 * ran TWO, a string opening a NESTED block comment (Postgres nests them; a one-level scan closes at
 * the first terminator and swallows the `; COMMIT` behind it) and a string with an `E''` escape (the
 * server ends that literal at the backslash-quote, a scan reading the following pair as a doubled
 * quote stays inside it). And it REFUSED, as more than one command, four strings the server runs:
 * `SELECT E'a\\'b' AS v`, `SELECT 1 AS a$b$c`, `SELECT $é$x$é$ AS v` and a trailing `;;`.
 * A parser can never be PROVEN equivalent to the grammar the server actually parses. The server can.
 *
 * `{ simple: false }` forces the EXTENDED protocol, where Postgres itself refuses every multi-command
 * string at parse time — `42601 cannot insert multiple commands into a prepared statement`, before
 * any command runs, so nothing lands and no connection is left in a transaction. It is the `simple`
 * flag that decides this, NOT `prepare`: `postgres/src/index.js` computes
 * `simple: 'simple' in options ? options.simple : args.length === 0` and hardcodes `prepare: false`
 * for `unsafe`, so a `prepare: true` measurement tests a knob that never enters the decision.
 *
 * IT ALSO MAKES THE TWO CALL SHAPES ONE. A PARAMETERIZED call already went extended (`args.length`
 * is not 0), so `query(sql, params)` was never vulnerable; only the no-parameter call fell back to
 * simple-query mode. This does not add a rule — it stops one shape of the same method from being
 * quietly weaker than the other.
 */
const MULTI_COMMAND_ADVICE =
  'Issue each statement through its own `query` call; `transaction(fn)` is how two of them land ' +
  'together.';

/**
 * The option that selects the extended protocol — CAST IN, because the driver's published types
 * declare only `prepare` on `UnsafeQueryOptions` while its implementation reads `simple` and spreads
 * the rest. The option is real; the type declaration is incomplete.
 *
 * A cast that stopped working would fail OPEN — the statement would fall back to simple-query mode
 * and the defect would return silently — so nothing here rests on the cast being right. Arms (7),
 * (8) and (10) of `pack-service-db.db.test.ts` measure the CONSEQUENCE against a live server, by
 * surviving rows and by `idle in transaction` count, so a driver upgrade that renamed or dropped
 * this option turns those arms red instead of quietly re-opening the door.
 */
const EXTENDED_PROTOCOL = { simple: false } as unknown as { prepare?: boolean | undefined };

/**
 * The server's refusal, in the door's own vocabulary — so a pack still branches on the typed error
 * the contract promises rather than on a driver error's SQLSTATE.
 *
 * The discriminator is narrow ON PURPOSE. `42601` alone is every syntax error there is; the pack's
 * own typo would then be reported as a multi-command refusal, which is a fabricated diagnostic. The
 * message below is emitted from exactly one place in the server (`exec_parse_message`), and a
 * genuine syntax error carries the same SQLSTATE from `scanner_yyerror` with different text —
 * measured. If the wording ever moves, this stops matching and the pack sees the server's own error:
 * the failure mode is a less friendly refusal, never a wrong one, and never a statement that runs.
 */
function asPackRefusal(error: unknown): unknown {
  const e = error as { code?: string; message?: string };
  if (e?.code !== '42601' || !/cannot insert multiple commands/i.test(e.message ?? ''))
    return error;
  return new PackTransactionError(
    'a pack database handle runs ONE statement per `query` call, and the server refused this ' +
      'string for carrying more than one command (SQLSTATE 42601). Nothing in it ran. ' +
      MULTI_COMMAND_ADVICE,
  );
}

/**
 * The transaction handle the driver hands `client.begin`'s callback, as the ONE member this door uses.
 *
 * Deriving it (`Parameters<Parameters<Db['$client']['begin']>[0]>[0]`) does not work and the reason is
 * worth leaving here: `begin` is OVERLOADED, `Parameters<>` resolves the LAST overload, and that one
 * takes `(options: string, cb)` — so the derivation silently yields `string`. Spelled structurally
 * instead, and as a METHOD rather than a property: method parameters are compared bivariantly, which
 * is what lets the driver's own richer `unsafe` satisfy it. Written as a property (`unsafe: (…) => …`)
 * `strictFunctionTypes` compares them contravariantly and the driver's handle is REFUSED — measured,
 * on the first attempt at this type.
 *
 * The narrowness is the point: this door calls exactly one method on the handle, so that is all the
 * type asks for, and `postgres` stays a non-dependency of this package.
 */
interface PinnedSql {
  unsafe(
    sql: string,
    params: never[],
    options: { prepare?: boolean | undefined },
  ): Promise<unknown>;
}

/**
 * The handle a pack holds INSIDE a transaction — the pinned half, extracted so there is exactly one
 * of it. Two callers build it and they are the same situation seen from two sides:
 *
 *   · `makePackServiceDatabase` below, for the transaction IT opened on a reserved connection;
 *   · `makePackHandlerDatabase`, for the transaction the DEPLOYMENT already opened around a route —
 *     where the connection is pinned by the request rather than by this door.
 *
 * They are one implementation because they are one contract: a statement a pack writes inside a
 * transaction is the statement it writes outside one, and the refusals do not change with who opened
 * it. In particular `transaction` refuses in BOTH — the message is the same because the situation is
 * the same, and its advice ("do the work in the transaction you are in, or split it into two") is
 * exactly the advice a route author needs. What the driver would do instead is not a savepoint: it
 * reserves a SECOND connection out of the same four-connection pool and opens an independent
 * transaction, which commits even when the outer one rolls back and blocks forever on any row the
 * outer one holds. Around a ROUTE that is not a hazard but a certainty under load — the request
 * already holds one of those four for its whole duration.
 */
function pinnedPackDatabase(tx: PinnedSql): PackServiceDatabase {
  return {
    query: async (sql: string, params: readonly unknown[] = []) => {
      refuseTransactionControl(sql, PINNED_CONSEQUENCE);
      try {
        return (await tx.unsafe(sql, params as never[], EXTENDED_PROTOCOL)) as unknown as Record<
          string,
          unknown
        >[];
      } catch (e) {
        throw asPackRefusal(e);
      }
    },
    transaction: async () => {
      throw new PackTransactionError(NESTED_TRANSACTION_MESSAGE);
    },
  };
}

/**
 * The door a pack's ROUTE or TOOL handler holds onto the platform tables its OWN migration chain
 * created — the gap a pack could otherwise only close by smuggling a service's handle out of boot.
 *
 * IT IS THE SAME DOOR A SERVICE GETS, deliberately: same parameterized `query`, same three refusals,
 * same posture. The door does not rewrite a pack's SQL and is not a tenant filter, exactly as the
 * service door is not — a pack runs in the deployment's process as a trusted, non-sandboxed author.
 * What differs, and it cuts in the handler's favour, is that a handler init carries a SERVER-DERIVED
 * `tenantId` while a service context carries none: the tenancy obligation is not merely stated here,
 * it is dischargeable, and `init.tenantId` is what discharges it.
 *
 * `pinned` decides the mount, and the caller knows which because it knows which posture it is in:
 *   · a route inside the deployment's engine transaction ⇒ the connection that transaction holds, so
 *     the pack's statements are atomic with the route's own and cannot deadlock against them;
 *   · a route on the detached posture, and every tool ⇒ the pooled executor, because neither holds a
 *     transaction to join.
 */
export function makePackHandlerDatabase(
  connection:
    | { readonly pinned: true; readonly client: Parameters<typeof pinnedPackDatabase>[0] }
    | { readonly pinned: false; readonly db: Db },
): PackServiceDatabase {
  return connection.pinned
    ? pinnedPackDatabase(connection.client)
    : makePackServiceDatabase(connection.db);
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
      try {
        return (await client.unsafe(
          sql,
          params as never[],
          EXTENDED_PROTOCOL,
        )) as unknown as Record<string, unknown>[];
      } catch (e) {
        throw asPackRefusal(e);
      }
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
      //
      // THE TRANSLATION IS APPLIED HERE TOO, and not defensively. A server-side refusal reaches the
      // wire, so the driver LATCHES it on the pinned connection and re-raises it when the callback
      // returns (the limit arm (6) pins) — a path that does not go through the `tx.query` catch
      // below. Without this, a pack that caught the refusal and returned normally would get a raw
      // driver error where the contract promises a typed one. `asPackRefusal` returns anything else
      // UNCHANGED, so the pack's own thrown value still arrives as the same instance.
      try {
        return (await client.begin(async (tx) =>
          insideTransaction.run(scope, async () => {
            try {
              // The SAME pinned handle a route is handed. One implementation, so the refusals a pack
              // meets inside a transaction cannot drift apart depending on who opened it.
              return await fn(pinnedPackDatabase(tx));
            } finally {
              // Ends the refusal with the callback — a context it created and left running is not
              // nesting once the transaction is over, and must not be refused as if it were.
              scope.open = false;
            }
          }),
        )) as T;
      } catch (e) {
        throw asPackRefusal(e);
      }
    },
  };
}
