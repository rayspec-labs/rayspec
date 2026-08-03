/**
 * A Postgres implementation of `SharedRateLimitStore` — TEST-SUPPORT ONLY.
 *
 * WHY IT EXISTS. The port's contract is that the decision and the retry hint come out of ONE
 * operation, so two instances cannot both grant the last token. That claim is unfalsifiable against an
 * in-process fake, because a fake has no concurrency to lose an update to. This store gives the suite
 * a REAL concurrent substrate to prove the contract on: several connections, one table, one statement
 * per decision.
 *
 * IT IS NOT A DEPLOYED STORE, and nothing in the shipped server constructs it. Two things are missing
 * that a production store would need. There is no SWEEPER: an expired row is reused in place when its
 * key is next consumed, but a key that never returns leaves its row behind forever. And there is no
 * counterpart to the in-process store's ENTRY BOUND — `InMemoryRateLimitStore` prunes and evicts to
 * stay under `DEFAULT_MAX_RATE_LIMIT_ENTRIES`, this table simply grows. Lifting it into production
 * additionally costs a migration for the table, an entry in the reserved store names (which several
 * drift locks sit behind), and a configuration flag to select it — none of which this change makes.
 *
 * HOW THE ONE STATEMENT WORKS. `consume` with a policy is a single `INSERT … ON CONFLICT (key) DO
 * UPDATE`. Its `SET` arms cover the three states a row can be in, in the same order `RateLimiter.check`
 * evaluates them: a LIVE LOCK leaves both the count and the window untouched (the lock short-circuits
 * before any budget is consulted); an EXPIRED window restarts at one; anything else increments. The
 * `RETURNING` list then computes BOTH the decision and the hint from the row as it now stands, which is
 * what makes them one operation rather than two. `now()` is fixed for the whole statement, so every
 * arm and the returned hint read one clock.
 *
 * The hint column is cast `::integer` rather than `::bigint` as belt and braces — the `Number(...)`
 * coercion at the store boundary already carries the contract on its own (measured: switching the
 * cast to `::bigint` keeps every arm green). It matters because the driver returns `bigint` as a JavaScript
 * STRING and `integer` as a NUMBER, and the repository asserts that `error.details.retryAfterMs` is a
 * number. It is clamped to `LEAST(window, GREATEST(1, …))` so a refusal never advises zero (which would
 * degrade every `429` to the minimum whole second) and never advises longer than the window it is
 * describing, and `Number()` is applied again at this boundary as belt and braces.
 *
 * A LOCK refusal reports the `REUSE_LOCK_MS` constant imported from `@rayspec/auth-core`, never a
 * literal and never the true remaining lock time — that is what the in-memory path reports, and a
 * second observable the two backends could disagree on would also let a caller poll a locked key to
 * learn how much of its lock is left.
 *
 * `consume` with NO policy is the lock-only arm: a plain `SELECT` of the lock state that creates no
 * row, matching `RateLimiter.check`, which checks the lock and then fails open without ever reaching
 * the counter for a bucket that has no policy.
 */
import type { RateLimitDecision, RateLimitPolicy, SharedRateLimitStore } from '@rayspec/auth-core';
import { REUSE_LOCK_MS } from '@rayspec/auth-core';
import type { Db } from '@rayspec/db';

/** The table every statement below addresses, resolved through the connection's `search_path`. */
export const SHARED_RATE_LIMIT_TABLE = 'shared_rate_limit_buckets';

/** The DDL a suite runs once before building the store. */
export const SHARED_RATE_LIMIT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${SHARED_RATE_LIMIT_TABLE} (
  key            text PRIMARY KEY,
  hits           integer     NOT NULL,
  window_ends_at timestamptz NOT NULL,
  locked_until   timestamptz
)`;

/**
 * The one seam every statement goes through: a parameterised query returning its rows. Injecting it
 * rather than a handle lets a suite count round trips, which is how "the hint came from the operation
 * that made the decision" is proved rather than merely asserted about a plausible-looking number.
 */
export type PgRateLimitExecutor = (
  text: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/** Build an executor over a Drizzle handle, using the raw-SQL idiom the harness already uses. */
export function pgRateLimitExecutor(db: Db): PgRateLimitExecutor {
  return async (text, params) =>
    (await db.$client.unsafe(
      text,
      params as Parameters<typeof db.$client.unsafe>[1],
    )) as unknown as readonly Record<string, unknown>[];
}

/** `$1` key, `$2` window ms, `$3` max hits, `$4` the lock-refusal hint. */
const CONSUME_SQL = `INSERT INTO ${SHARED_RATE_LIMIT_TABLE} AS b (key, hits, window_ends_at, locked_until)
VALUES ($1, 1, now() + ($2::double precision * interval '1 millisecond'), NULL)
ON CONFLICT (key) DO UPDATE SET
  hits = CASE
    WHEN b.locked_until IS NOT NULL AND b.locked_until > now() THEN b.hits
    WHEN b.window_ends_at <= now() THEN 1
    ELSE b.hits + 1
  END,
  window_ends_at = CASE
    WHEN b.locked_until IS NOT NULL AND b.locked_until > now() THEN b.window_ends_at
    WHEN b.window_ends_at <= now() THEN now() + ($2::double precision * interval '1 millisecond')
    ELSE b.window_ends_at
  END
RETURNING
  ((locked_until IS NULL OR locked_until <= now()) AND hits <= $3::bigint) AS allowed,
  (CASE
     WHEN locked_until IS NOT NULL AND locked_until > now() THEN $4::bigint
     WHEN hits > $3::bigint
       THEN LEAST($2::bigint, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_ends_at - now())) * 1000)))
     ELSE 0
   END)::integer AS retry_after_ms`;

const LOCK_STATE_SQL = `SELECT locked_until FROM ${SHARED_RATE_LIMIT_TABLE} WHERE key = $1`;

const LOCK_SQL = `INSERT INTO ${SHARED_RATE_LIMIT_TABLE} (key, hits, window_ends_at, locked_until)
VALUES ($1, 0, now(), now() + ($2::double precision * interval '1 millisecond'))
ON CONFLICT (key) DO UPDATE SET locked_until = EXCLUDED.locked_until`;

const RESET_SQL = `DELETE FROM ${SHARED_RATE_LIMIT_TABLE} WHERE key = $1`;

const CLEAR_ALL_SQL = `DELETE FROM ${SHARED_RATE_LIMIT_TABLE}`;

/** A Postgres-backed `SharedRateLimitStore`. See the module docblock for its scope and its limits. */
export class PgSharedRateLimitStore implements SharedRateLimitStore {
  private readonly exec: PgRateLimitExecutor;

  constructor(exec: PgRateLimitExecutor) {
    this.exec = exec;
  }

  async consume(key: string, policy: RateLimitPolicy | undefined): Promise<RateLimitDecision> {
    if (!policy) {
      // No budget for this bucket: check the lock and fail open, creating nothing — the counter is
      // never reached on this path in the in-process store either.
      const rows = await this.exec(LOCK_STATE_SQL, [key]);
      const until = rows[0]?.locked_until;
      const locked = until != null && new Date(String(until)).getTime() > Date.now();
      return locked
        ? { allowed: false, retryAfterMs: REUSE_LOCK_MS }
        : { allowed: true, retryAfterMs: 0 };
    }
    const rows = await this.exec(CONSUME_SQL, [key, policy.windowMs, policy.max, REUSE_LOCK_MS]);
    const row = rows[0];
    if (!row) {
      throw new Error(
        `PgSharedRateLimitStore.consume: the upsert returned no row for key '${key}'. The decision ` +
          'and its hint come from that row, so there is nothing to fail open on.',
      );
    }
    return { allowed: row.allowed === true, retryAfterMs: Number(row.retry_after_ms) };
  }

  async lock(key: string, ms: number): Promise<void> {
    await this.exec(LOCK_SQL, [key, ms]);
  }

  async reset(key: string): Promise<void> {
    await this.exec(RESET_SQL, [key]);
  }

  async clearAll(): Promise<void> {
    await this.exec(CLEAR_ALL_SQL, []);
  }
}
