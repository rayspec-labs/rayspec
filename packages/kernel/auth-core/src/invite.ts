/**
 * Invite-token primitive — the opaque out-of-band org-invite token + its HMAC storage hash.
 *
 * An invite token is a high-entropy (256-bit) bearer credential the org owner conveys OUT-OF-BAND to
 * the invitee (core has no outbound mail). Only its HMAC-SHA256-with-pepper hash is persisted (never
 * the plaintext); the redeem path recomputes the HMAC and looks the invite up by `token_hash` (a
 * unique index) — the same "store a hash, resolve a bearer credential by its hash" pattern as the
 * api-key + session paths. HMAC (not argon2id) is sound here: the token is machine-generated
 * high-entropy, so a slow password KDF is unnecessary and the hot redeem path stays fast.
 *
 * The pepper is the shared server HMAC secret (`RAYSPEC_API_KEY_PEPPER`, boot-required). A DOMAIN
 * PREFIX (`invite:`) is folded into the HMAC so an invite-token hash can never collide with an
 * api-key hash even under the same pepper (domain separation).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { getApiKeyPepper } from './api-key.js';

export interface MintedInviteToken {
  /** The full plaintext invite token shown to the owner ONCE (conveyed out-of-band). Never stored. */
  token: string;
  /** The HMAC hash to persist (`invites.token_hash`). */
  hash: string;
}

/**
 * HMAC-SHA256 an invite token with the boot-required pepper (+ the `invite:` domain prefix); returns a
 * lowercase hex digest. Deterministic, so the redeem path recomputes it and looks the invite up by an
 * exact `token_hash` equality on the unique index.
 */
export function hashInviteToken(token: string, pepper: string = getApiKeyPepper()): string {
  return createHmac('sha256', pepper).update(`invite:${token}`).digest('hex');
}

/**
 * Mint a new invite token: 32 bytes (256-bit) of CSPRNG, base64url-encoded (URL-safe). Returns the
 * one-time plaintext token + the HMAC hash to store. The plaintext is shown EXACTLY ONCE at issue.
 */
export function mintInviteToken(pepper: string = getApiKeyPepper()): MintedInviteToken {
  const token = randomBytes(32).toString('base64url'); // 256-bit, URL-safe
  return { token, hash: hashInviteToken(token, pepper) };
}
