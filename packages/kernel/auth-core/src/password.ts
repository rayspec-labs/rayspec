/**
 * Password hashing primitive — argon2id, isolated behind hashPassword/verifyPassword so no
 * call site touches the argon2 API directly (argon2id for low-entropy
 * passwords). Verified live (doc-first, 2026-06-22) against argon2 0.44.0:
 *   - argon2.argon2id === 2; hash(pw, {type, memoryCost, timeCost, parallelism}) returns an
 *     encoded string with the params embedded ($argon2id$v=19$m=19456,t=2,p=1$...);
 *   - verify(hash, pw) → boolean; needsRehash(hash, params) → true when params increased.
 *
 * Params are OWASP Password Storage Cheat Sheet (2024): argon2id, m=19 MiB, t=2, p=1.
 * Because the params live INSIDE the hash, raising ARGON2ID_PARAMS later lets verify() keep
 * accepting old hashes while needsRehash() flags them for an upgrade-on-login re-hash.
 */
import argon2 from 'argon2';

/** OWASP-2024 argon2id parameters. Bump these to strengthen; old hashes still verify. */
export const ARGON2ID_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB, in KiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash a plaintext password with argon2id (params embedded in the returned encoded hash). */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2ID_PARAMS);
}

/** Verify a plaintext password against an argon2id-encoded hash. Never throws on a mismatch. */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    // A malformed/unrecognized hash is a verification failure, not a crash.
    return false;
  }
}

/**
 * Upgrade-on-login helper: true when `hash` was produced with weaker params than the current
 * ARGON2ID_PARAMS, so the caller should transparently re-hash the (just-verified) password.
 */
export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, {
    memoryCost: ARGON2ID_PARAMS.memoryCost,
    timeCost: ARGON2ID_PARAMS.timeCost,
    parallelism: ARGON2ID_PARAMS.parallelism,
  });
}
