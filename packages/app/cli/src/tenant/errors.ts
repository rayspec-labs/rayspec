/**
 * `TenantCliError` — a usage/argument problem in a `rayspec tenant <sub>` command (mapped to exit 2 by
 * the top level, exactly like `index.ts`'s `CliError` / `dev/errors.ts`'s `DevCliError`).
 *
 * It lives in its own module so both the `tenant` dispatcher (`tenant.ts`) and each `tenant/*` command
 * can import it without a circular import.
 */
export class TenantCliError extends Error {}
