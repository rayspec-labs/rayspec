/**
 * The SAFE-IDENTIFIER rule — a LEAF module, on purpose.
 *
 * The rule is not the document grammar's alone: any grammar this package grows for a surface an
 * extension pack declares has to spell its names by the SAME rule, and such a grammar is itself
 * imported BY `grammar.ts`. Were the rule to live in `grammar.ts`, that second grammar would import
 * the document grammar and close a cycle — one that compiles and resolves, and shows up only as a
 * `SafeIdentifier` that is `undefined` while a module-level `z.object` evaluates. So the rule lives
 * here, imports nothing but zod, and `grammar.ts` re-exports it: every existing import keeps working
 * and there is still exactly ONE definition of the rule.
 */
import { z } from 'zod';

/**
 * A SAFE SQL/TS IDENTIFIER for a store name / column name / FK column-or-reference (TEN-1).
 * Store/column names are interpolated VERBATIM into generated SQL (`CREATE TABLE "<name>"`)
 * AND generated TS (`export const <camel> = pgTable('<name>', …)`) — so an unconstrained
 * `z.string()` is an INJECTION seam (a name like `m" ); DROP …` lands in executable DDL, and the
 * destructive scan is a closed blocklist that can never catch every form). Fail-closed at the
 * SOURCE: a safe identifier is `[a-z_][a-z0-9_]*`, length 1..63 (the Postgres identifier limit),
 * lowercase only (Postgres folds unquoted idents to lowercase; we keep snake_case author names and
 * camelCase them for TS). `parseSpec` rejects a metacharacter/over-long name as `schema_violation`.
 * The generators re-assert the SAME shape (defense-in-depth for a code-built spec bypassing parse).
 */
export const SAFE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
export const MAX_IDENTIFIER_LENGTH = 63;
export const SafeIdentifier = z
  .string()
  .min(1)
  .max(
    MAX_IDENTIFIER_LENGTH,
    `identifier must be <= ${MAX_IDENTIFIER_LENGTH} chars (Postgres limit)`,
  )
  .regex(
    SAFE_IDENTIFIER_RE,
    'identifier must match /^[a-z_][a-z0-9_]*$/ (lowercase letters/digits/underscore, no metacharacters)',
  );

/**
 * Re-assert the safe-identifier shape OUTSIDE Zod (the generators call this on a spec that may have
 * been built in code, bypassing parseSpec). THROWS — never returns a malformed identifier into
 * generated SQL/TS. Single source of the rule shared by the grammar refine + both generators.
 */
export function assertSafeIdentifier(value: string, what: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !SAFE_IDENTIFIER_RE.test(value)
  ) {
    throw new Error(
      `unsafe identifier for ${what}: ${JSON.stringify(value)} — must match ` +
        `/^[a-z_][a-z0-9_]*$/ and be <= ${MAX_IDENTIFIER_LENGTH} chars (injection guard, TEN-1)`,
    );
  }
}
