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
 * detector from here rather than re-inlining the walk. The scan lives in this MODULE and nowhere else
 * — which is the property that matters, and is not the same as there being one function. There are
 * several walks here because they answer different questions (which node holds a statement, which
 * holds a SQLSTATE, which holds the driver's own fault token, is the chain deeper than the bound),
 * and collapsing them into one parameterised scan would trade a readable answer per question for a
 * flag argument. What must never happen is a SEVENTH copy appearing in a caller.
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
 * A failed statement's own shape: the SQL it ran, and the values it bound. Detected STRUCTURALLY
 * (a `query` string beside an array of bound values) rather than by class identity, for the same
 * reason the SQLSTATE walk above is structural — the shapes belong to the ORM and the driver, are
 * not exported, and an `instanceof` against either would silently stop matching on a version bump.
 */
interface WrappedStatement {
  readonly node: { readonly cause?: unknown };
  readonly query: string;
  readonly params: readonly unknown[];
}

/**
 * The bound values, under EITHER of the two names the stack uses for them.
 *
 * The ORM's wrapper calls them `params`; the driver's own error calls them `parameters`. Both sit
 * beside a `query` string, so one reader covers both — which is what lets the raw-SQL door render
 * exactly like the ORM door instead of falling through to the driver's own sentence.
 */
function boundValues(node: {
  params?: unknown;
  parameters?: unknown;
}): readonly unknown[] | undefined {
  if (Array.isArray(node.params)) return node.params;
  if (Array.isArray(node.parameters)) return node.parameters;
  return undefined;
}

/** Walk the bounded, cycle-safe `.cause` chain for the node carrying a statement + its values. */
function wrappedStatement(err: unknown): WrappedStatement | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null; depth++) {
    const node = cur as {
      query?: unknown;
      params?: unknown;
      parameters?: unknown;
      cause?: unknown;
    };
    const values = boundValues(node);
    if (typeof node.query === 'string' && values !== undefined) {
      return { node, query: node.query, params: values };
    }
    cur = node.cause;
  }
  return undefined;
}

/**
 * A SQLSTATE IS FIVE CHARACTERS FROM A VOCABULARY THE SERVER PUBLISHES — and nothing else is.
 *
 * The driver hangs its OWN faults on the same `code` property, using words instead of codes:
 * `CONNECTION_CLOSED`, `UNSAFE_TRANSACTION`. So a walk that accepts any string `code` cannot tell a
 * refusal the server sent from a fault the driver raised without ever reaching it. Measured, by
 * terminating the backend with a statement in flight: the error carries `code: 'CONNECTION_CLOSED'`,
 * a statement, its values, and NO `severity` — and an ungated walk rendered it as
 * `(SQLSTATE CONNECTION_CLOSED)`, asserting both that the server answered and that this is a code an
 * operator can look up. Neither is true, and the driver's own message — which names the host and
 * port, the one fact a connectivity failure is about — was dropped in favour of that assertion.
 */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

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
  // "a value", not "a bound value": the coercion classes also fire on DDL that casts a column, where
  // the offending value is an EXISTING ROW and the statement bound nothing at all. Measured on
  // `ALTER TABLE … TYPE uuid USING label::uuid` over a table holding one bad row.
  '22001': 'a value was too long for its column',
  '22003': 'a value was out of range for its column type',
  '22007': 'a value was not a valid timestamp',
  '22P02': 'a value was not valid for its column type',
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

/**
 * The structured node the driver hung the SQLSTATE on, if the chain carries one.
 *
 * The walk STARTS AT `from` itself rather than at its `.cause`, because the node carrying the
 * statement is not always a wrapper around the driver error — through the raw-SQL door it IS the
 * driver error, with the SQLSTATE on the same object as the statement. Starting one link in cost
 * that door its reason phrase and left it falling back to the server's own sentence. For the ORM
 * wrapper this changes nothing: the wrapper carries no `code`, so the first hit is still its cause.
 */
function sqlstateNode(from: { readonly cause?: unknown }): Record<string, unknown> | undefined {
  let cur: unknown = from;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null; depth++) {
    const node = cur as Record<string, unknown>;
    if (typeof node.code === 'string' && SQLSTATE_SHAPE.test(node.code)) return node;
    cur = node.cause;
  }
  return undefined;
}

/**
 * The DRIVER'S OWN fault token, for a chain that carries no server SQLSTATE at all.
 *
 * Kept, rather than collapsed into the generic sentence, because it is the only thing that
 * distinguishes a dropped connection from a refused statement — and it is driver-authored, from a
 * fixed vocabulary, so it can no more carry caller data than a SQLSTATE can. Bounded and collapsed
 * onto one line for the same reason the schema identifiers are.
 *
 * IT REFUSES A SQLSTATE-SHAPED CODE, which is not redundant with its one caller checking first. A
 * mutation sweep found it: with this walk accepting any code, breaking the SQLSTATE walk no longer
 * turned the suite red — the fault path caught the server's own code and rendered `23505` as a driver
 * error, which is both wrong and, worse, indistinguishable from correct to every test. A fallback
 * that can answer for the branch it is a fallback FOR hides that branch's failures.
 */
function driverFaultCode(from: { readonly cause?: unknown }): string | undefined {
  let cur: unknown = from;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null; depth++) {
    const node = cur as Record<string, unknown>;
    if (typeof node.code === 'string' && node.code.length > 0 && !SQLSTATE_SHAPE.test(node.code)) {
      return node.code.replace(/\s+/g, ' ').trim().slice(0, 40);
    }
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
  if (node !== undefined) {
    const code = String(node.code);
    const phrase = REFUSAL_BY_SQLSTATE[code] ?? 'the database refused the statement';
    const named = schemaIdentifiers(node);
    const detail = named.length > 0 ? `, ${named.join(', ')}` : '';
    return `${phrase} (SQLSTATE ${code}${detail})`;
  }
  // NO SQLSTATE ANYWHERE IN THE CHAIN means the server never answered this statement, so calling the
  // failure a refusal would be wrong twice over: it names the wrong party, and it sends an operator
  // looking up a code no SQLSTATE table contains.
  const fault = driverFaultCode(from);
  return fault === undefined
    ? 'the database refused the statement'
    : `the statement did not complete (driver error ${fault})`;
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
 * AND THE MESSAGE IS NOT THE ONLY FIELD. Postgres fills `detail` with the offending value on every
 * constraint violation — `Key (id)=(…) already exists` for a unique, `Key (parent)=(…) is not
 * present in table …` for a foreign key, and for a CHECK the whole failing row: `Failing row
 * contains (…)`. `detail` is an OWN ENUMERABLE property of the driver's error while `message` and
 * `stack` are not, so it escapes through the shapes that never touch `.message` at all —
 * `console.error(msg, err)`, `JSON.stringify(err)`, `{...err}`, `Object.entries(err)`. Nothing here
 * reads it; that is a property of the assembly, not a filter applied to it.
 *
 * BOTH DOORS, NOT ONE. The ORM wraps a driver failure in an error of its own; the raw-SQL door
 * (`sql.unsafe`, a pack service's `tx.query`) throws the driver's error DIRECTLY, with its statement
 * under `parameters` rather than `params` and its SQLSTATE on the same object rather than on a
 * `.cause`. Shipped code catches both, so both render from the owned parts. An earlier revision
 * covered only the wrapped door and returned a bare driver error's message unchanged — which for a
 * coercion refusal is the offending value, handed back by the very function a caller reached for to
 * avoid printing it.
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
  if (wrapped !== undefined) {
    // SAY WHAT WAS WITHHELD, not only how many values there were. A statement that bound nothing
    // still had something withheld — the server's own sentence — and reporting `0 bind values
    // withheld` told an operator the opposite, that nothing was hidden. The case is not exotic: a
    // migration casting a column (`ALTER TABLE … TYPE uuid USING label::uuid`) binds no values and
    // fails with an EXISTING ROW quoted in the message.
    const count = wrapped.params.length;
    const values =
      count === 0
        ? 'this statement bound no values'
        : `${count === 1 ? '1 bind value' : `${count} bind values`} withheld`;
    return `${refusalReason(wrapped.node)} — failed statement: ${oneLine(wrapped.query)} (${values}; the server's own message is withheld too — a refusal can quote caller data, and neither belongs in a log)`;
  }
  // A DATABASE FAILURE CARRYING NO STATEMENT KEEPS ITS OWN MESSAGE. That is a measured decision, not
  // a gap: what reaches this line cannot hold a bind value, because a bind value only exists inside a
  // statement and EVERY statement-scoped failure carries its statement. Measured across all eight
  // doors this repository uses — tagged template, `unsafe` with parameters, `unsafe` without them,
  // inside `begin`, on a reserved connection, through a cursor, a constraint violation, a syntax
  // error — `query` is a string and `parameters` an array in every one, including simple-query mode
  // where that array is empty. So the branch above claims every error that could carry caller data.
  //
  // What is left is the CONNECTION-SCOPED set, and there the server's own sentence IS the diagnosis:
  // `database "x" does not exist` (3D000), `password authentication failed for user "y"` (28P01),
  // `invalid value for parameter "statement_timeout": "z"` (22023). Each of those values came from
  // the connection string or the connection options — operator configuration, not caller data. An
  // earlier revision rendered this class from the phrase table too, which replaced the single fact an
  // operator needs (WHICH database, WHICH user) with a sentence naming two hazards, `detail` and a
  // coercion message, that a connect-time refusal does not have. Withholding is not free: withheld
  // where there is nothing to withhold, it only costs the diagnosis.
  const message = err instanceof Error ? err.message : String(err);
  // A chain deeper than the walk fails in the SAFE direction — nothing is re-emitted — but the
  // operator silently loses the statement and has no way to tell that from an error that never
  // carried one. Say which happened, keeping the withholding visible the same way the value count
  // does. `cause` at the boundary is the only evidence available without walking further.
  return deeperThanTheWalk(err)
    ? `${message} (the failed statement is not recoverable from this error: its cause chain is deeper than ${MAX_CAUSE_DEPTH} links)`
    : message;
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
  // Both statement-carrying shapes get the replaced header: the ORM wrapper, whose stack begins with
  // the statement and its values, AND a bare driver error from the raw-SQL door, whose stack begins
  // with the server's own sentence — the one that echoes the offending value on a coercion refusal.
  // A failure with no statement keeps its header, for the reason given in the message renderer.
  if (wrappedStatement(err) === undefined) return err.stack;
  // Frames start at the first `    at …` line; everything above it is the message header.
  const frames = err.stack.split('\n').filter((line) => /^\s+at\s/.test(line));
  return [operatorSafeDbErrorMessage(err), ...frames].join('\n');
}

/**
 * TRUE when this error came from the database, through either door.
 *
 * For callers that must decide WHETHER to say anything rather than HOW to phrase it. The renderers
 * above answer "what is the safe wording"; a sink that speaks to an API CLIENT rather than to an
 * operator needs the prior question, because for it the safe wording is no wording at all — a
 * statement is schema, and schema is not a caller's business even when the values are withheld.
 *
 * Recognised by the same two structural marks the renderers use, so a caller's disposition cannot
 * drift from theirs: a node carrying a statement beside its values, or a node carrying a SQLSTATE.
 */
export function isDatabaseError(err: unknown): boolean {
  return (
    wrappedStatement(err) !== undefined || sqlstateNode(err as { cause?: unknown }) !== undefined
  );
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
