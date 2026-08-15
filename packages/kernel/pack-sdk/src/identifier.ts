/**
 * The IDENTIFIER rule — the one part of this contract a type cannot express.
 *
 * A store name and a column name are interpolated VERBATIM into generated SQL (`CREATE TABLE
 * "<name>"`) and into generated TypeScript, so an unconstrained string is an injection seam: a name
 * carrying a quote or a semicolon lands in executable DDL. The rule is therefore fail-closed at the
 * source — a safe identifier is `/^[a-z_][a-z0-9_]*$/`, at most 63 characters (the Postgres
 * identifier limit), lowercase only (Postgres folds unquoted identifiers to lowercase, and the
 * generators camel-case these snake_case author names for TypeScript).
 *
 * A pack that spells its names out as literals needs nothing but the rule. A pack that DERIVES a
 * name — from its own configuration, from a caller-supplied fragment — needs to check one, and a
 * regular expression bounded by a length is not expressible as a type. `isSafeIdentifier` is that
 * check and the only executable line in this package: pure, total, allocation-free, no state, no
 * I/O. Everything else here is types.
 *
 * The check is ADVISORY at authoring time, not a substitute for the platform's own: the parse pass
 * re-asserts the same rule over the merged document and refuses a violating name as a
 * `schema_violation`, and the generators re-assert it a third time for a document assembled in
 * code. Checking early only turns a boot failure into an authoring-time one.
 */

/** The safe-identifier pattern: lowercase letters, digits and underscore, never leading with a digit. */
export const SAFE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/** The Postgres identifier limit — a longer name is silently truncated by the database, so it is refused. */
export const MAX_IDENTIFIER_LENGTH = 63;

/**
 * True iff `value` is a safe identifier: it matches the pattern AND is within the length bound. The
 * pattern already requires at least one character, so an empty string is rejected by it.
 */
export function isSafeIdentifier(value: string): boolean {
  return value.length <= MAX_IDENTIFIER_LENGTH && SAFE_IDENTIFIER_RE.test(value);
}
