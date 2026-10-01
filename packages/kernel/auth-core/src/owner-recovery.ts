/**
 * Owner-recovery token primitive — the operator's one-time credential for an organization owner who
 * holds no password.
 *
 * An owner whose only credential was an API key has nothing to sign in with once the API-key pepper
 * changes (a portability import mints a new one). The operator, whose authority is the database and
 * the pepper, issues a recovery token for that owner; the owner redeems it once over HTTP, setting a
 * password. The token is a 256-bit CSPRNG value shown to the operator exactly once; only its HMAC is
 * stored (`owner_recovery_tokens.token_hash`), so the database alone cannot redeem it.
 *
 * The HMAC is keyed by the API-key pepper with its own DOMAIN PREFIX (`owner-recovery:`), so a
 * recovery-token hash never equals an API-key, session or invite hash under the same pepper, and a
 * token minted for one purpose never resolves in another's table.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { getApiKeyPepper } from './api-key.js';

/** The shortest lifetime an operator may give a recovery token (5 minutes). */
export const OWNER_RECOVERY_MIN_TTL_SECONDS = 5 * 60;
/** The default lifetime of a recovery token (30 minutes). */
export const OWNER_RECOVERY_DEFAULT_TTL_SECONDS = 30 * 60;
/** The longest lifetime of a recovery token (24 hours): it is a takeover credential until used. */
export const OWNER_RECOVERY_MAX_TTL_SECONDS = 24 * 60 * 60;

export interface MintedOwnerRecoveryToken {
  /** The plaintext token, shown to the operator ONCE. Never stored. */
  token: string;
  /** The HMAC hash to persist (`owner_recovery_tokens.token_hash`). */
  hash: string;
}

/** HMAC-SHA256 a recovery token under the pepper and the `owner-recovery:` domain; lowercase hex. */
export function hashOwnerRecoveryToken(token: string, pepper: string = getApiKeyPepper()): string {
  return createHmac('sha256', pepper).update(`owner-recovery:${token}`).digest('hex');
}

/** Mint a recovery token: 32 bytes of CSPRNG, base64url, and its HMAC hash. */
export function mintOwnerRecoveryToken(
  pepper: string = getApiKeyPepper(),
): MintedOwnerRecoveryToken {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashOwnerRecoveryToken(token, pepper) };
}
