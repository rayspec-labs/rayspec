/**
 * API-key / client-secret hashing primitive — HMAC-SHA256 with a server PEPPER (a deliberate
 * choice: fast on the hot per-request auth path, sound for ≥128-bit machine secrets;
 * argon2id is reserved for low-entropy passwords). Uses node:crypto (stdlib) only.
 *
 * The pepper is REQUIRED-AT-BOOT: `getApiKeyPepper()` throws if RAYSPEC_API_KEY_PEPPER is
 * unset/blank, so a misconfigured deploy fails closed instead of silently hashing keys with
 * an empty pepper. (RAYSPEC_API_KEY_PEPPER is wired into ci.yml + the boot-fails-closed
 * test; here the primitive is the boot-required seam.)
 *
 * Storage model: plaintext shown ONCE at mint; only the public `keyPrefix` (indexed for O(1)
 * lookup) + the HMAC `keyHash` are persisted. Verification recomputes the HMAC and compares
 * in constant time (timingSafeEqual) so a stored-hash comparison cannot be timed.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PEPPER_ENV = 'RAYSPEC_API_KEY_PEPPER';

/**
 * Read the api-key pepper from the environment. THROWS if missing/blank — the boot-required
 * contract (the pepper is in the boot-fails-closed set alongside the JWT signing key).
 */
export function getApiKeyPepper(): string {
  const pepper = process.env[PEPPER_ENV];
  if (!pepper || pepper.trim().length === 0) {
    throw new Error(
      `${PEPPER_ENV} is required at boot (the api-key HMAC pepper). Refusing to start without it.`,
    );
  }
  return pepper;
}

/** HMAC-SHA256 the secret with the boot-required pepper; returns a lowercase hex digest. */
export function hashApiKey(secret: string, pepper: string = getApiKeyPepper()): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

/**
 * Constant-time verify of a presented secret against a stored HMAC hash. Recomputes the HMAC
 * under the pepper and compares with timingSafeEqual (length-guarded so a wrong-length hash
 * does not throw). Never branches observably on the hash contents.
 */
export function verifyApiKey(
  storedHash: string,
  secret: string,
  pepper: string = getApiKeyPepper(),
): boolean {
  const computed = hashApiKey(secret, pepper);
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface MintedApiKey {
  /** The full plaintext shown to the user ONCE: `${prefix}.${secret}`. Never stored. */
  plaintext: string;
  /** The public, indexed lookup handle (safe to store + query). */
  prefix: string;
  /** The HMAC hash to persist (key_hash). */
  hash: string;
}

/**
 * Mint a new api-key: a short public prefix + a ≥128-bit secret. Returns the one-time
 * plaintext, the prefix to index, and the HMAC hash to store. The secret is 32 bytes
 * (256-bit) of CSPRNG, base64url-encoded.
 */
export function mintApiKey(pepper: string = getApiKeyPepper()): MintedApiKey {
  const prefix = `mk_${randomBytes(6).toString('base64url')}`;
  const secret = randomBytes(32).toString('base64url'); // 256-bit
  const plaintext = `${prefix}.${secret}`;
  return { plaintext, prefix, hash: hashApiKey(secret, pepper) };
}
