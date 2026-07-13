/**
 * Postgres error-shape detectors (driver-aware), the ONE shared home for the 23505 walk.
 *
 * The driver (postgres.js v3.4.9) surfaces the SQLSTATE on a `PostgresError.code`; drizzle-orm 0.45.2
 * then WRAPS that in a `DrizzleQueryError` (message `Failed query: …`) whose `.cause` is the original
 * `PostgresError` — the WRAPPER itself carries NO `code`. So we detect STRUCTURALLY by WALKING the
 * `.cause` chain (bounded depth, cycle-safe), matching whether the raw driver error or the drizzle
 * wrapper is thrown, independent of the message text. (Doc-first verified against the installed
 * drizzle-orm@0.45.2 + postgres@3.4.9.)
 *
 * Request-path + capability code that must map a UNIQUE violation to a typed conflict imports the
 * detector from here rather than re-inlining the walk (there is exactly ONE canonical copy of the
 * cause-chain scan).
 */

/** Bounded depth for the `.cause` walk — deep enough for driver→drizzle wrapping, cycle-safe. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True if `err` (or a bounded `.cause`-chain ancestor) is a Postgres UNIQUE violation (SQLSTATE
 * 23505). Detection ONLY — the caller maps it to a typed conflict and issues NO further in-transaction
 * statement (an in-tx 23505 poisons the transaction; there is no in-tx recovery here).
 */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorNode(err, '23505') !== undefined;
}

/**
 * True if `err` (or a bounded `.cause`-chain ancestor) is a Postgres FOREIGN KEY violation (SQLSTATE
 * 23503). Detection ONLY — the caller maps it to a typed 4xx (create/update onto a non-existent target
 * → 400; a restrict-blocked parent delete → 409) and issues NO further in-transaction statement (an
 * in-tx error poisons the transaction).
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorNode(err, '23503') !== undefined;
}

/**
 * The Postgres constraint name a 23503 names (product FKs are `<table>_<col>_<parent>_<refcol>_fk`), or
 * `undefined` when the error is not a 23503 / carries no constraint name.
 *
 * TENANT-SAFETY: the constraint name is derived from the SCHEMA (table/column identifiers), never from a
 * row value — the offending VALUE lives on the error's `detail` field, which this NEVER reads. A caller
 * maps the returned name to a DECLARED FK column before surfacing it (so the wire names an author column,
 * not the raw constraint identifier, and never a foreign row value).
 */
export function foreignKeyViolationConstraintName(err: unknown): string | undefined {
  const node = pgErrorNode(err, '23503') as { constraint_name?: unknown } | undefined;
  return node && typeof node.constraint_name === 'string' ? node.constraint_name : undefined;
}

/**
 * The Postgres constraint/index name a 23505 names (drizzle emits unique indexes as
 * `<table>_<col>_unique`), or `undefined` when the error is not a 23505 / carries no constraint name.
 *
 * TENANT-SAFETY: the constraint name is derived from the SCHEMA (table + column identifiers), never
 * from a row value — the offending VALUE lives on the error's `detail` field, which this NEVER reads.
 * A caller should still map the returned name to a DECLARED column before surfacing it (so the wire
 * message names an author column, not the raw index identifier).
 */
export function uniqueViolationConstraintName(err: unknown): string | undefined {
  const node = pgErrorNode(err, '23505') as { constraint_name?: unknown } | undefined;
  return node && typeof node.constraint_name === 'string' ? node.constraint_name : undefined;
}

/** Walk the bounded, cycle-safe `.cause` chain for the first object whose `.code` === `sqlstate`. */
function pgErrorNode(err: unknown, sqlstate: string): object | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null; depth++) {
    if (typeof cur === 'object' && (cur as { code?: unknown }).code === sqlstate) {
      return cur as object;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
