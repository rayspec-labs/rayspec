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

/**
 * OUR OWN PHRASE PER SQLSTATE — never the server's sentence.
 *
 * The driver's primary message is NOT safe to re-emit, which is the whole reason this table exists.
 * Measured across ten SQLSTATE classes against real Postgres, the coercion failures echo the OFFENDING
 * VALUE into the message itself: `invalid input syntax for type uuid: "<the caller's value>"`, and the
 * same for integer, numeric and enum. A renderer that passed that through would print a bind value in
 * the same sentence that announces bind values were withheld — the disclosure and a false assurance
 * about it, together.
 *
 * ⚠ AND THE LEAKING SET IS NOT ONE SQLSTATE. The timestamp case reports `22007`, not the `22P02` the
 * other three share, so an allowlist of "codes whose message is safe" is a list somebody has to keep
 * complete against a server that owns the vocabulary. That is the argument for not reading the
 * message AT ALL rather than for reading it more carefully.
 *
 * A code absent from this table is not a gap: it falls through to a fixed sentence plus the code, so
 * an unanticipated refusal is diagnosable and still cannot carry a value. The list earns its keep by
 * making the common refusals readable, not by being exhaustive.
 */
const REFUSAL_BY_SQLSTATE: Readonly<Record<string, string>> = {
  '22001': 'a bound value was too long for its column',
  '22003': 'a bound value was out of range for its column type',
  '22007': 'a bound value was not a valid timestamp',
  '22P02': 'a bound value was not valid for its column type',
  '23502': 'a not-null constraint was violated',
  '23503': 'a foreign key constraint was violated',
  '23505': 'a unique constraint was violated',
  '23514': 'a check constraint was violated',
  '40001': 'the transaction was rolled back to preserve serializability',
  '40P01': 'the transaction was rolled back to break a deadlock',
  '42601': 'the statement is not valid SQL',
  '42703': 'the statement names a column that does not exist',
  '42P01': 'the statement names a relation that does not exist',
  '53300': 'the server refused another connection',
  '55P03': 'a row lock was not available inside the statement timeout',
  '57014': 'the statement was cancelled',
};

/** The structured node the driver hung the SQLSTATE on, if the chain carries one. */
function sqlstateNode(from: { readonly cause?: unknown }): Record<string, unknown> | undefined {
  let cur: unknown = from.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null; depth++) {
    const node = cur as Record<string, unknown>;
    if (typeof node.code === 'string') return node;
    cur = node.cause;
  }
  return undefined;
}

/**
 * The SCHEMA identifiers a refusal names — the constraint, relation and column it was about.
 *
 * These are DDL names, authored in a migration, and they are the one part of a driver error that
 * describes the SCHEMA rather than a row. The existing constraint-name readers in this module rest on
 * exactly that distinction and say so; this is the same claim used for the same reason. `detail`,
 * which is where Postgres echoes the offending VALUE (`Key (id)=(…) already exists`), is not read
 * here and is not read anywhere in this module.
 */
function schemaIdentifiers(node: Record<string, unknown>): string[] {
  const named: string[] = [];
  const take = (field: string, label: string): void => {
    const value = node[field];
    // Identifiers only: collapse whitespace so a pathological name cannot break the log line.
    if (typeof value === 'string' && value.length > 0) {
      named.push(`${label} "${value.replace(/\s+/g, ' ').trim()}"`);
    }
  };
  take('constraint_name', 'constraint');
  take('table_name', 'relation');
  take('column_name', 'column');
  return named;
}

/**
 * WHY the statement failed, assembled from parts this module owns.
 *
 * Every component is one of: a phrase from the table above, a SQLSTATE (five characters from a
 * vocabulary the server publishes and no value can occupy), or a schema identifier. The driver's
 * `message` and `detail` are never read, so there is no path along which server free text — and with
 * it a value the server chose to echo — can reach the output. That is the mechanism behind this
 * module's claim, rather than an assertion about what messages happen to contain.
 */
function refusalReason(from: { readonly cause?: unknown }): string {
  const node = sqlstateNode(from);
  if (node === undefined) return 'the database refused the statement';
  const code = String(node.code);
  const phrase = REFUSAL_BY_SQLSTATE[code] ?? 'the database refused the statement';
  const named = schemaIdentifiers(node);
  const detail = named.length > 0 ? `, ${named.join(', ')}` : '';
  return `${phrase} (SQLSTATE ${code}${detail})`;
}

/** True when the chain still had links at the walk's boundary — see `operatorSafeDbErrorMessage`. */
function deeperThanTheWalk(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null; depth++) {
    cur = (cur as { cause?: unknown }).cause;
  }
  return cur != null;
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
 * touched. Any code path that stringifies a caught database error is exposed regardless of which of
 * the three shapes it used.
 *
 * THE DRIVER'S OWN MESSAGE IS NOT A SAFE FALLBACK EITHER, which an earlier version of this renderer
 * assumed. Postgres echoes the offending value into the primary message on every coercion failure, so
 * that version printed a value in the same sentence that announced values were withheld. See
 * `REFUSAL_BY_SQLSTATE` for the measurement and for why an allowlist of safe codes is the wrong shape.
 *
 * Bind values are arbitrary row data — whatever a caller decided to persist, from whatever source it
 * read. An operator-facing log is exactly where that must not appear, because those logs travel:
 * into tickets, into chat threads, into support attachments.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS KEPT, AND THE MECHANISM THAT MAKES IT SAFE.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The refusal stays diagnosable: WHY it failed (a phrase this module owns, the SQLSTATE, and the
 * schema identifiers the refusal named) and WHICH write failed (the parameterized statement, whose
 * text holds `$n` placeholders rather than values). What it drops is the value list, and it says so —
 * a count, so a reader knows there is more and does not conclude the statement ran without parameters.
 *
 * The safety is STRUCTURAL rather than asserted: the output is assembled from a fixed phrase table, a
 * SQLSTATE code, schema identifiers and the statement, and no server-authored free text is read at
 * all. A refusal shape nobody anticipated therefore renders as its code and a generic sentence — it
 * fails closed, rather than passing through on the assumption that its message was harmless.
 *
 * An error carrying no statement is returned unchanged — this is a redactor for database failures,
 * not a general message filter, and rewriting refusals it does not understand would cost every other
 * caller its own wording.
 */
export function operatorSafeDbErrorMessage(err: unknown): string {
  const wrapped = wrappedStatement(err);
  if (wrapped === undefined) {
    const message = err instanceof Error ? err.message : String(err);
    // A chain deeper than the walk fails in the SAFE direction — nothing is re-emitted — but the
    // operator silently loses the statement and has no way to tell that from an error that never
    // carried one. Say which happened, keeping the withholding visible the same way the value count
    // does. `cause` at the boundary is the only evidence available without walking further.
    return deeperThanTheWalk(err)
      ? `${message} (the failed statement is not recoverable from this error: its cause chain is deeper than ${MAX_CAUSE_DEPTH} links)`
      : message;
  }
  const count = wrapped.params.length;
  const withheld = count === 1 ? '1 bind value withheld' : `${count} bind values withheld`;
  return `${refusalReason(wrapped.node)} — failed statement: ${oneLine(wrapped.query)} (${withheld} from this message; they are caller data and do not belong in a log)`;
}

/**
 * The same rendering, with the stack frames kept — for a log that prints a stack beside its message.
 *
 * A wrapped error's `stack` BEGINS with its message, so printing the stack alone re-emits everything
 * the message would have: the statement and every bound value, above the frames. This replaces that
 * header with the safe rendering and keeps the frames, which are file paths and line numbers and
 * carry no caller data. An error with no stack, or one carrying no statement, is passed through.
 */
export function operatorSafeDbErrorStack(err: unknown): string | undefined {
  if (!(err instanceof Error) || typeof err.stack !== 'string') return undefined;
  if (wrappedStatement(err) === undefined) return err.stack;
  // Frames start at the first `    at …` line; everything above it is the message header.
  const frames = err.stack.split('\n').filter((line) => /^\s+at\s/.test(line));
  return [operatorSafeDbErrorMessage(err), ...frames].join('\n');
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
