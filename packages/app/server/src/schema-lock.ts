/**
 * THE SHARED SCHEMA LOCK — the one advisory lock every path that mutates schema takes.
 *
 * The platform migration chain at boot, product-store DDL, `rayspec tenant ensure`, and later
 * import and apply all serialize on the same transaction-scoped pair
 * `pg_advisory_xact_lock(SCHEMA_LOCK_NAMESPACE, SCHEMA_LOCK_SLOT)`. Two of them started against the
 * same database therefore run one after the other instead of racing on the catalogue — the drizzle
 * migrator's first statements (`CREATE SCHEMA IF NOT EXISTS "drizzle"`, `CREATE TABLE IF NOT EXISTS
 * ...`) check and then create, so two runs against an EMPTY database both see nothing and the loser
 * dies on a duplicate object.
 *
 * BOUNDED WAIT. The waiter sets `lock_timeout` first (default 60 s, `RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS`
 * on the boot path), and a timeout is a `SchemaLockTimeoutError` — retryable, the contract's
 * `RAY_LOCK_TIMEOUT` — rather than an indefinite hang. After the lock is granted the transaction's
 * `lock_timeout` goes back to the session default, so the DDL the holder runs keeps the ordinary lock
 * behaviour it had before.
 *
 * RELEASE. The lock is transaction-scoped: COMMIT, ROLLBACK or the loss of the connection releases
 * it, so a killed runner never leaves the next one waiting.
 *
 * TWO SHAPES. `withSchemaLock` holds the lock in a dedicated transaction while `run` does its work on
 * OTHER connections of the pool (the drizzle migrator opens its own transaction; an advisory lock is
 * a mutex between runners, not a data lock, so it never blocks our own work). `lockSchemaInTransaction`
 * takes it inside a transaction that itself runs the DDL, so the lock and the change commit together.
 */
import {
  DEFAULT_SCHEMA_LOCK_TIMEOUT_MS,
  SCHEMA_LOCK_NAMESPACE,
  SCHEMA_LOCK_SLOT,
} from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';

/** Postgres `lock_not_available`: what a waiter past its `lock_timeout` receives. */
const LOCK_NOT_AVAILABLE = '55P03';

/** The shared schema lock was not granted within the bounded wait. Retryable. */
export class SchemaLockTimeoutError extends Error {
  readonly code = 'RAY_LOCK_TIMEOUT' as const;
  readonly retryable = true;
  constructor(timeoutMs: number) {
    super(
      `the shared schema lock was not granted within ${timeoutMs} ms — another migration, tenant ` +
        'provisioning or deploy is changing this database. Retry once it has finished.',
    );
    this.name = 'SchemaLockTimeoutError';
  }
}

/** The part of a postgres.js transaction handle the lock uses. */
export interface SchemaLockTx {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<unknown>;
}

function checkTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('the schema lock timeout must be a positive whole number of milliseconds');
  }
}

/**
 * Take the shared schema lock inside `tx`, waiting at most `timeoutMs`. Throws
 * `SchemaLockTimeoutError` when the wait runs out; the caller's transaction is then aborted.
 */
export async function lockSchemaInTransaction(
  tx: SchemaLockTx,
  timeoutMs: number = DEFAULT_SCHEMA_LOCK_TIMEOUT_MS,
): Promise<void> {
  checkTimeout(timeoutMs);
  // set_config(..., true) is SET LOCAL with a bind parameter: the wait ends with the transaction.
  await tx.unsafe("SELECT set_config('lock_timeout', $1, true)", [`${timeoutMs}ms`]);
  try {
    await tx.unsafe('SELECT pg_advisory_xact_lock($1::int4, $2::int4)', [
      SCHEMA_LOCK_NAMESPACE,
      SCHEMA_LOCK_SLOT,
    ]);
  } catch (err) {
    if ((err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new SchemaLockTimeoutError(timeoutMs);
    }
    throw err;
  }
  await tx.unsafe('SET LOCAL lock_timeout TO DEFAULT');
}

/**
 * Run `run` while this process holds the shared schema lock in a dedicated transaction. `run` does
 * its work on other connections of the same pool; the lock is released when it settles.
 */
export async function withSchemaLock<T>(
  db: Db,
  run: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCHEMA_LOCK_TIMEOUT_MS;
  let result: T | undefined;
  await db.$client.begin(async (tx) => {
    await lockSchemaInTransaction(tx, timeoutMs);
    result = await run();
  });
  return result as T;
}
