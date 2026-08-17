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
 * True if `err` (or a bounded `.cause`-chain ancestor) is a Postgres LOCK TIMEOUT (SQLSTATE 55P03,
 * `lock_not_available`) — the statement waited longer than the transaction's `lock_timeout` for a row
 * another transaction holds and was aborted rather than left waiting.
 *
 * Detection ONLY, and it is a distinct outcome from a failure: the statement did not run, nothing was
 * written, and the caller decides what a contended row means for it (typically: leave the row to the
 * transaction that holds it). Like every other detector here the whole transaction is already aborted,
 * so the caller issues NO further in-transaction statement.
 */
export function isLockTimeout(err: unknown): boolean {
  return pgErrorNode(err, '55P03') !== undefined;
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

/**
 * The ORM wrapper's own shape: the statement it ran, and the values it bound. Detected STRUCTURALLY
 * (a `query` string beside a `params` array) rather than by class identity, for the same reason the
 * SQLSTATE walk above is structural — the wrapper is the ORM's internal class, it is not exported,
 * and an `instanceof` against it would silently stop matching on a version bump.
 */
interface WrappedStatement {
  readonly node: { readonly cause?: unknown };
  readonly query: string;
  readonly params: readonly unknown[];
}

/** Walk the bounded, cycle-safe `.cause` chain for the wrapper carrying a statement + its values. */
function wrappedStatement(err: unknown): WrappedStatement | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null; depth++) {
    const node = cur as { query?: unknown; params?: unknown; cause?: unknown };
    if (typeof node.query === 'string' && Array.isArray(node.params)) {
      return { node, query: node.query, params: node.params };
    }
    cur = node.cause;
  }
  return undefined;
}

/** The driver's own primary message — what says WHY the statement failed, carrying no bind value. */
function driverPrimaryMessage(from: { readonly cause?: unknown }): string | undefined {
  let cur: unknown = from.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null; depth++) {
    const node = cur as { message?: unknown; cause?: unknown };
    if (typeof node.message === 'string' && node.message.length > 0) return node.message;
    cur = node.cause;
  }
  return undefined;
}

/** Collapse a statement onto one line — a log entry is a line, and the ORM emits multi-line SQL. */
function oneLine(statement: string): string {
  return statement.replace(/\s+/g, ' ').trim();
}

/**
 * AN OPERATOR-SAFE RENDERING OF A DATABASE FAILURE — the statement, never the values.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT LEAKS, AND WHY IT NEEDS A SHARED ANSWER.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * When a statement fails, the ORM wraps the driver's error in one of its own whose `message` embeds
 * both the SQL and every bound value, and which carries them AGAIN as enumerable own properties. So
 * the values escape three different ways, and two of them look nothing like a mistake at the call
 * site: `${err.message}` in a refusal, `String(err)` in a template, and `console.error(msg, err)` —
 * which inspects the object and prints the enumerable properties whether or not the message was
 * touched. The driver's OWN error does not do this; the wrapper does, so any code path that
 * stringifies a caught database error is exposed regardless of which of the three shapes it used.
 *
 * Bind values are arbitrary row data — whatever a caller decided to persist, from whatever source it
 * read. An operator-facing log is exactly where that must not appear, because those logs travel:
 * into tickets, into chat threads, into support attachments.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS KEPT, AND WHY.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The refusal stays diagnosable. It keeps the driver's primary message (WHY it failed — a constraint
 * name, a missing relation; it carries no row value) and the parameterized statement (WHICH write
 * failed — the SQL holds `$n` placeholders, not values). What it drops is the value list, and it
 * says SO: a count of what was withheld, so a reader knows there is more and does not conclude the
 * statement ran without parameters.
 *
 * The driver's `detail` field is deliberately NOT included: on a unique violation Postgres echoes the
 * offending value into it (`Key (id)=(…) already exists`), which is the same disclosure by another
 * name. This builds its message from named safe parts rather than passing anything through, so a
 * field nobody thought about cannot ride along.
 *
 * An error carrying no statement is returned unchanged — this is a redactor for database failures,
 * not a general message filter, and rewriting refusals it does not understand would cost every other
 * caller its own wording.
 */
export function operatorSafeDbErrorMessage(err: unknown): string {
  const wrapped = wrappedStatement(err);
  if (wrapped === undefined) return err instanceof Error ? err.message : String(err);
  const why = driverPrimaryMessage(wrapped.node) ?? 'the database rejected the statement';
  const count = wrapped.params.length;
  const withheld = count === 1 ? '1 bind value withheld' : `${count} bind values withheld`;
  return `${why} — failed statement: ${oneLine(wrapped.query)} (${withheld} from this message; they are caller data and do not belong in a log)`;
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
