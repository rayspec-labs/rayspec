/**
 * OWNER RECOVERY, THE OPERATOR'S SIDE — issue a one-time recovery token for an organization owner who
 * holds no password, on the deployment `DATABASE_URL` names (`rayspec tenant recover-owner`).
 *
 * WHEN. After a portability import every API key stops verifying (the target mints its own pepper),
 * and an owner whose only credential was an API key has nothing to sign in with. Members with a
 * password sign in as before. The operator, whose authority is the database and the deployment's
 * pepper, issues a token for that owner; the owner redeems it once at `POST /v1/auth/owner-recovery`,
 * setting a password.
 *
 * WHAT IT WRITES. One `owner_recovery_tokens` row holding the token's HMAC under the deployment's
 * pepper, the replacement of any token still outstanding for that owner, and an
 * `owner_recovery_issued` audit row, in one transaction (`OwnerRecoveryStore.issue`). It refuses an
 * owner who holds a password, an account that is not an active owner, and a fenced environment (an
 * exported source, or an import target before its cutover). It runs no migration: the deployment it
 * names is already deployed.
 *
 * WHAT IT RETURNS. The plaintext token, for the caller to print exactly once. It is in no log line,
 * no audit row and no receipt.
 */
import {
  type IssuedOwnerRecovery,
  OwnerRecoveryIssueError,
  OwnerRecoveryStore,
} from '@rayspec/api-auth';
import {
  normalizeEmail,
  OWNER_RECOVERY_DEFAULT_TTL_SECONDS,
  OWNER_RECOVERY_MAX_TTL_SECONDS,
  OWNER_RECOVERY_MIN_TTL_SECONDS,
} from '@rayspec/auth-core';
import { makeDb } from '@rayspec/db';
import type { OwnerRecoverySecrets } from './composition-root.js';

export interface OwnerRecoveryInput {
  /** The owner's address. */
  readonly email: string;
  /** The organization, when the account owns more than one. */
  readonly orgId?: string;
  /** The token's lifetime, clamped to 5 minutes – 24 hours. Default 30 minutes. */
  readonly ttlSeconds?: number;
}

/** A refusal of the issue: an address that is not one, or the store's own refusals. */
export class OwnerRecoveryError extends Error {
  constructor(
    readonly code: 'INVALID_EMAIL' | OwnerRecoveryIssueError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'OwnerRecoveryError';
  }
}

/** Issue a recovery token. Throws `OwnerRecoveryError` for a refusal; nothing is written then. */
export async function issueOwnerRecovery(
  secrets: OwnerRecoverySecrets,
  input: OwnerRecoveryInput,
  opts: { readonly now?: Date } = {},
): Promise<Omit<IssuedOwnerRecovery, 'audit'>> {
  let email: string;
  try {
    email = normalizeEmail(input.email);
  } catch {
    throw new OwnerRecoveryError(
      'INVALID_EMAIL',
      'The owner address is not a valid email address.',
    );
  }
  const ttlSeconds = Math.min(
    Math.max(
      input.ttlSeconds ?? OWNER_RECOVERY_DEFAULT_TTL_SECONDS,
      OWNER_RECOVERY_MIN_TTL_SECONDS,
    ),
    OWNER_RECOVERY_MAX_TTL_SECONDS,
  );
  const db = makeDb(secrets.migrationDatabaseUrl ?? secrets.databaseUrl, 2, {
    applicationName: 'rayspec-owner-recovery',
  });
  try {
    const { audit: _audit, ...issued } = await new OwnerRecoveryStore(db).issue({
      email,
      ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
      ttlSeconds,
      pepper: secrets.apiKeyPepper,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    return issued;
  } catch (err) {
    if (err instanceof OwnerRecoveryIssueError) throw new OwnerRecoveryError(err.code, err.message);
    throw err;
  } finally {
    await db.$client.end().catch(() => {});
  }
}
