/**
 * THE PACK DATABASE DOOR — the object behind `PackServiceContext['db']`, built here because this is
 * where the deployment's one raw handle lives.
 *
 * A pack service reaches the platform tables its OWN migration chain created through a parameterized
 * query executor (see `PackServiceDatabase`). That door used to be one method, so a pack could write
 * single statements and nothing else: a pack whose correctness rests on writing two rows atomically,
 * or on holding a row lock across a read-decide-write, could not be built on it. Not for want of a
 * method name — the handle underneath is POOLED, and on a pooled handle two calls are not promised the
 * same connection: the driver refuses a bare `BEGIN` outright (`UNSAFE_TRANSACTION`), and a
 * `SELECT … FOR UPDATE` is released the moment the call returns.
 *
 * So the transactional half is built over a RESERVED connection (`sql.begin`), pinned for the
 * callback's whole duration, and the pooled half is left exactly as it was. What a pack gets inside
 * the callback is the SAME `PackDatabase` — the same parameterized `query`, so the statement a pack
 * writes inside a transaction is the statement it writes outside one.
 *
 * THE PIN COMES OUT OF A SHARED POOL. The reserved connection is one of the deployment's, and it is
 * not returned until the callback returns, so a long-running transaction is a resource decision rather
 * than a free convenience. That is stated on the contract itself (`@rayspec/pack-sdk`), where a pack
 * author reads it.
 *
 * TENANCY IS UNCHANGED BY IT. The transactional handle is scoped exactly as the pooled one and carries
 * nothing else — no tenant handle, no journal writer, no escape hatch — so a pack cannot widen its
 * reach by opening a transaction. A service has no tenant of its own to name in either case: there is
 * no `tenantId` on its context, in a transaction or out of one, exactly as there is none on
 * `TurnDispatchRequest`.
 */
import type { Db } from '@rayspec/db';
import type { PackServiceDatabase } from '@rayspec/platform';

/**
 * A refusal raised BY the door — today, the one way a pack can ask it for something it does not offer.
 * Its own class (and its own `name`, which is what a pack compiling against the types-only contract
 * can branch on) so a pack reads a refusal as what it is rather than as a database error.
 */
export class PackTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackTransactionError';
  }
}

/**
 * Build the database door over the deployment's one raw handle.
 *
 * `query` is the pooled executor, unchanged. `transaction` reserves a connection for the callback,
 * commits when it returns and rolls back when it throws, re-raising the value the callback threw so a
 * pack's own error class and message reach the caller intact.
 *
 * NESTING IS REFUSED rather than silently reinterpreted. A nested call cannot be a second transaction
 * — the connection is already in one — so it could only be a SAVEPOINT, which is a different guarantee
 * wearing the same name: rolling a savepoint back leaves the OUTER transaction alive and committing, so
 * a pack that believed it had opened a transaction would watch its "rollback" commit. The refusal is a
 * failure inside the callback like any other, so the transaction it was attempted in rolls back.
 */
export function makePackServiceDatabase(db: Db): PackServiceDatabase {
  const client = db.$client;
  return {
    query: async (sql: string, params: readonly unknown[] = []) =>
      (await client.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[],

    transaction: async <T>(fn: (tx: PackServiceDatabase) => Promise<T>): Promise<T> => {
      // The callback's value is returned WRAPPED: postgres.js resolves an ARRAY a `begin` callback
      // returns element by element (its `Promise.all` convenience for a returned batch of queries),
      // which would silently rewrite the rows a pack returns straight out of its transaction. An
      // object is not an array, so what `fn` returned is what the caller gets.
      const outcome = await client.begin(async (tx) => ({
        value: await fn({
          query: async (sql: string, params: readonly unknown[] = []) =>
            (await tx.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[],
          transaction: async () => {
            throw new PackTransactionError(
              'this pack database handle is already inside a transaction, and a transaction cannot ' +
                'be nested: the connection is pinned, so an inner call could only be a savepoint — a ' +
                'different guarantee under the same name, whose rollback leaves the outer transaction ' +
                'alive and committing. Do the work in the transaction you are in, or split it into two.',
            );
          },
        }),
      }));
      return outcome.value;
    },
  };
}
