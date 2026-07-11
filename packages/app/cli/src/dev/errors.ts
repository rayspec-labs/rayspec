/**
 * `DevCliError` — a usage/argument problem in a `rayspec dev <sub>` command (mapped to exit 2 by
 * the top level, exactly like `index.ts`'s `CliError` / `gen-handler.ts`'s `GenHandlerCliError`).
 *
 * It lives in its own module so both the `dev` dispatcher (`dev.ts`) and each `dev/*` command can
 * import it without a circular import.
 */
export class DevCliError extends Error {}
