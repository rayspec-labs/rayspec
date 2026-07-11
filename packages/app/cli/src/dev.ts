/**
 * `rayspec dev <sub>` — the LOCAL-DEV, MUTATING command group.
 *
 * This group is CLEARLY SEPARATED from the read-only diagnostic floor (doctor/plan/gen-handler), which
 * "never mutates a real/target DB, never prints secrets". The `dev` commands DELIBERATELY mutate local
 * dev state — they create a dev database and write secret files — so they are namespaced under `dev`
 * to keep the diagnostic floor's guarantee unpolluted. They lift the product deployment's DEV-bootstrap
 * bash kernels (gen-prod-secrets / provision-db / bootstrap-tenant) into reusable CLI commands so every
 * product setup stops hand-rolling them. PROD/vendor/CORS overlays are deliberately left behind (N=1).
 *
 *   rayspec dev gen-secrets [--out <path>]            Mint the 3 platform boot secrets into a `.env`
 *                                                      (idempotent; never overwrites; never echoes a
 *                                                      value). chmod 600.
 *   rayspec dev db [--database-url <url>] [--name <db>]
 *                                                      Create the dev database if absent (idempotent;
 *                                                      never destructive).
 *   rayspec dev bootstrap-tenant --base-url <url> [--email …] [--password …] [--org-name …]
 *                                                      Create the first tenant+owner via the shipped
 *                                                      auth API; emit ORG_ID + the org-scoped token.
 *
 * Each returns a value-free (gen-secrets/db) or deliberate-credential (bootstrap-tenant) JSON summary;
 * a usage/argument problem is a `DevCliError` (mapped to exit 2 by `index.ts`).
 */
import { type BootstrapTenantResult, runBootstrapTenant } from './dev/bootstrap-tenant.js';
import { type DevDbResult, runDevDb } from './dev/db.js';
import { DevCliError } from './dev/errors.js';
import { type GenSecretsResult, runGenSecrets } from './dev/gen-secrets.js';

export { DevCliError } from './dev/errors.js';

/** The result of any `dev` command — a discriminated union (each carries `ok` + its own fields). */
export type DevResult = GenSecretsResult | DevDbResult | BootstrapTenantResult;

/**
 * Dispatch a `dev` sub-subcommand. `args` is the slice AFTER `dev` (its first token is the
 * sub-subcommand; the rest are that command's flags). Throws `DevCliError` on a missing/unknown
 * sub-subcommand (→ exit 2).
 */
export async function runDev(args: readonly string[]): Promise<DevResult> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined) {
    throw new DevCliError(
      'missing dev subcommand (expected `gen-secrets`, `db`, or `bootstrap-tenant`)',
    );
  }
  switch (sub) {
    case 'gen-secrets':
      return runGenSecrets(rest);
    case 'db':
      return runDevDb(rest);
    case 'bootstrap-tenant':
      return runBootstrapTenant(rest);
    default:
      throw new DevCliError(
        `unknown dev subcommand ${JSON.stringify(sub)} (expected \`gen-secrets\`, \`db\`, or \`bootstrap-tenant\`)`,
      );
  }
}
