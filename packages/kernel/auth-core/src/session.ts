/**
 * Opaque server-session secret primitives (DB-free).
 *
 * The session cookie carries an OPAQUE secret minted server-side; only its HASH is stored
 * (sessions.token_hash). The session id is server-minted too (no client-proposed id → no
 * fixation). `family_id` binds a refresh family for reuse-detection + targeted revoke.
 *
 * Hashing: the opaque secret is a ≥256-bit CSPRNG value (high entropy), so a fast keyed HMAC
 * (SHA-256, keyed by the api-key pepper) is the right primitive — NOT argon2id (reserved for
 * low-entropy passwords). Verification is by exact hash equality on the indexed unique column
 * (constant-time compare where a secret is presented).
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getApiKeyPepper } from './api-key.js';

/** A freshly minted opaque session secret + the hash to persist. */
export interface MintedSessionSecret {
  /** The opaque secret placed in the refresh cookie. Shown to the client ONCE per rotation. */
  secret: string;
  /** The HMAC hash to store in sessions.token_hash. */
  tokenHash: string;
}

/** HMAC-SHA256 the opaque session secret with the boot-required pepper (hex digest). */
export function hashSessionSecret(secret: string, pepper: string = getApiKeyPepper()): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

/** Mint a new opaque session secret (256-bit base64url) + its stored hash. */
export function mintSessionSecret(pepper: string = getApiKeyPepper()): MintedSessionSecret {
  const secret = randomBytes(32).toString('base64url'); // 256-bit
  return { secret, tokenHash: hashSessionSecret(secret, pepper) };
}

/** Constant-time compare a presented secret's hash against a stored hash. */
export function sessionSecretMatches(
  storedHash: string,
  presentedSecret: string,
  pepper: string = getApiKeyPepper(),
): boolean {
  const computed = hashSessionSecret(presentedSecret, pepper);
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A fresh server-minted family id (refresh family). */
export function newFamilyId(): string {
  return randomUUID();
}

/** A fresh server-minted JWT id (jti) for an access token. */
export function newJti(): string {
  return randomUUID();
}
