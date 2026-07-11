/**
 * Boot-required secret configuration (no plaintext secrets, fail-closed at boot).
 *
 * Two secrets are REQUIRED-AT-BOOT and live ONLY in env/secret-manager, never in the DB or git:
 *   - RAYSPEC_JWT_SIGNING_KEY — the PKCS#8 PEM private key the access-token signer uses.
 *   - RAYSPEC_API_KEY_PEPPER  — the HMAC pepper for api-key/client-secret hashing (api-key.ts).
 *
 * `assertBootSecrets()` throws if either is missing/blank, so a misconfigured deploy fails to
 * start rather than silently minting unsignable tokens or hashing keys with an empty pepper. The
 * api-auth app calls it at construction; the boot-fails-closed test asserts it throws when a
 * secret is absent.
 */

export const JWT_SIGNING_KEY_ENV = 'RAYSPEC_JWT_SIGNING_KEY';
export const API_KEY_PEPPER_ENV = 'RAYSPEC_API_KEY_PEPPER';

/** Read the JWT signing key PEM; THROWS if unset/blank (boot-required). */
export function getJwtSigningKeyPem(): string {
  const pem = process.env[JWT_SIGNING_KEY_ENV];
  if (!pem || pem.trim().length === 0) {
    throw new Error(
      `${JWT_SIGNING_KEY_ENV} is required at boot (the JWT signing key, PKCS#8 PEM). ` +
        'Refusing to start without it.',
    );
  }
  return pem;
}

/**
 * Assert BOTH boot-required secrets are present. Throws a single combined error listing every
 * missing one. Call this once at app construction (fail-closed boot). Does NOT validate the key
 * material itself — the token module does that lazily on first sign (which also fails closed).
 */
export function assertBootSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const missing: string[] = [];
  if (!env[JWT_SIGNING_KEY_ENV] || env[JWT_SIGNING_KEY_ENV]?.trim().length === 0) {
    missing.push(JWT_SIGNING_KEY_ENV);
  }
  if (!env[API_KEY_PEPPER_ENV] || env[API_KEY_PEPPER_ENV]?.trim().length === 0) {
    missing.push(API_KEY_PEPPER_ENV);
  }
  if (missing.length > 0) {
    throw new Error(
      `Boot-required secret(s) missing: ${missing.join(', ')}. ` +
        'These live in env/secret-manager only (never DB/git). Refusing to start (fail-closed).',
    );
  }
}
