/**
 * `rayspec tenant <sub>` — the PRODUCTION-MUTATING organization-provisioning command group.
 *
 * It is a TOP-LEVEL group, deliberately not a member of `dev`. `dev` is documented — in its own module
 * doc, in the package description and in the CLI reference — as local-development only, and that
 * scoping is exactly the gap this group closes: a production deployment needs an organization to exist
 * before it boots, and the only automation for that lived in a command an operator was told not to
 * point at production.
 *
 *   rayspec tenant ensure --org-id <uuid> --name <n> [--owner-email <e>]
 *                         [--owner-invite-out <path>] [--invite-ttl-seconds <n>]
 *                         [--reissue-owner-invite]
 *                                                    Create or resolve the organization under that
 *                                                    id, idempotently, and optionally mint the owner
 *                                                    handoff invite. Speaks to DATABASE_URL directly;
 *                                                    needs no running server and no HTTP route.
 *   rayspec tenant erase  --org-id <uuid> [--confirm <uuid> --reason <text>] [--journal-scrub]
 *                                                    The destructive counterpart: PREVIEW, or with a
 *                                                    matching --confirm actually PERFORM, the
 *                                                    irreversible erasure of that tenant's data. The
 *                                                    real delete additionally requires the operator
 *                                                    gate RAYSPEC_ERASURE_ENABLED to be exactly
 *                                                    "true"; without it every call is a counts-only
 *                                                    preview. Mounts no HTTP route either.
 *
 * Every command here returns a JSON summary that contains NO secret material; a usage/argument problem
 * is a `TenantCliError` (mapped to exit 2 by `index.ts`).
 */
import { runTenantEnsure, type TenantEnsureResult } from './tenant/ensure.js';
import { runTenantErase, type TenantEraseResult } from './tenant/erase.js';
import { TenantCliError } from './tenant/errors.js';

export { TenantCliError } from './tenant/errors.js';

/** The result of any `tenant` command — a union, shaped like `DevResult`. */
export type TenantResult = TenantEnsureResult | TenantEraseResult;

/**
 * Dispatch a `tenant` sub-subcommand. `args` is the slice AFTER `tenant` (its first token is the
 * sub-subcommand; the rest are that command's flags). Throws `TenantCliError` on a missing/unknown
 * sub-subcommand (→ exit 2).
 */
export async function runTenant(args: readonly string[]): Promise<TenantResult> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined) {
    throw new TenantCliError('missing tenant subcommand (expected `ensure` or `erase`)');
  }
  switch (sub) {
    case 'ensure':
      return runTenantEnsure(rest);
    case 'erase':
      return runTenantErase(rest);
    default:
      throw new TenantCliError(
        `unknown tenant subcommand ${JSON.stringify(sub)} (expected \`ensure\` or \`erase\`)`,
      );
  }
}
