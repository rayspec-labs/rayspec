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
 *
 * TWO SUPPLY PATHS, ONE READER. A boot that has already resolved the secrets — from the plain
 * variables, from a `<VAR>_FILE` mount, or from a config object it built itself — hands them to this
 * process with `setBootSecrets()`. Everything else falls back to the ambient environment, which is
 * what a caller that constructs the app directly (an embedder, a test harness) relies on. The
 * supplied values WIN over the environment: they are the ones the boot validated and normalized, and
 * an env variable holding a stale or untrimmed form of the same secret must not override them. That
 * holds for a BLANK supplied value too — it counts as absent and aborts, it does not re-open the
 * environment as a fallback, so a caller that hands in a config with an empty secret gets the same
 * refusal to start it has always got rather than a silent boot on an ambient value it never chose.
 *
 * The supplied values are deliberately NOT written back to `process.env`. `process.env` is copied
 * wholesale into every child process this process spawns and is readable from outside the process,
 * so mirroring them there would undo the point of the `<VAR>_FILE` mounts (an operator provides a
 * mode-600 file precisely so the secret is not in the process environment).
 */

export const JWT_SIGNING_KEY_ENV = 'RAYSPEC_JWT_SIGNING_KEY';
export const API_KEY_PEPPER_ENV = 'RAYSPEC_API_KEY_PEPPER';

/** The two boot-required secrets, named by the environment variables that conventionally carry them. */
export type BootSecretName = typeof JWT_SIGNING_KEY_ENV | typeof API_KEY_PEPPER_ENV;

/** The resolved boot secrets a boot hands to this process via `setBootSecrets`. */
export interface BootSecrets {
  /** The PKCS#8 PEM (RS256) the access-token signer and the OIDC provider use. */
  readonly jwtSigningKeyPem: string;
  /** The HMAC pepper for api-key / session-secret / invite-token hashing. */
  readonly apiKeyPepper: string;
}

/**
 * The PROCESS-SCOPED boot secrets. Empty until a boot supplies them; a second boot in the same
 * process replaces them (the same last-writer-wins shape a process-wide value has always had here —
 * one process serves one deployment's secrets).
 */
let supplied: Partial<Record<BootSecretName, string>> = {};

/**
 * Hand the resolved boot secrets to this process. The composition root calls this once, right after
 * `loadServerConfig` has validated and normalized them, so the readers below (`assertBootSecrets`
 * inside `createAuthApp`, `getApiKeyPepper` on the api-key/session/invite hashing paths) find the
 * values THIS boot resolved without any of them touching `process.env`.
 */
export function setBootSecrets(secrets: BootSecrets): void {
  supplied = {
    [JWT_SIGNING_KEY_ENV]: secrets.jwtSigningKeyPem,
    [API_KEY_PEPPER_ENV]: secrets.apiKeyPepper,
  };
}

/**
 * Forget the process-scoped boot secrets, returning the readers to the environment-only path. The
 * counterpart to `setBootSecrets` — a suite that must exercise the fail-closed arm (nothing supplied
 * AND nothing in the environment) needs a way back to a pristine process.
 */
export function clearBootSecrets(): void {
  supplied = {};
}

/** A present, non-blank value — blank is treated as absent everywhere in the boot-secret contract. */
function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * The one resolution rule for a boot secret: what the boot supplied for this name, else — only if
 * the boot supplied nothing for it — what `env` carries, else `undefined`. The value is returned AS
 * SUPPLIED (never trimmed) — trimming is the boot's normalization contract, and a reader that
 * trimmed on its own would silently disagree with the value the boot validated.
 *
 * A boot that supplied a name OWNS it, blank included: a blank supplied secret resolves to
 * `undefined` (absent ⇒ the readers abort) and `env` is NOT consulted for it. Falling through to the
 * environment there would let an ambient variable the caller never asked for stand in for the secret
 * it configured — a different pepper hashing every api key, a different PEM signing every token —
 * on a path whose whole contract is to refuse to start.
 */
export function bootSecretValue(
  name: BootSecretName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (Object.hasOwn(supplied, name)) return nonBlank(supplied[name]);
  return nonBlank(env[name]);
}

/** Read the JWT signing key PEM; THROWS if neither supplied nor in the env (boot-required). */
export function getJwtSigningKeyPem(): string {
  const pem = bootSecretValue(JWT_SIGNING_KEY_ENV);
  if (pem === undefined) {
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
 *
 * `env` names where to look for a secret the boot has NOT supplied; a supplied secret is present
 * regardless of what `env` holds.
 */
export function assertBootSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const missing: string[] = [];
  if (bootSecretValue(JWT_SIGNING_KEY_ENV, env) === undefined) missing.push(JWT_SIGNING_KEY_ENV);
  if (bootSecretValue(API_KEY_PEPPER_ENV, env) === undefined) missing.push(API_KEY_PEPPER_ENV);
  if (missing.length > 0) {
    throw new Error(
      `Boot-required secret(s) missing: ${missing.join(', ')}. ` +
        'These live in env/secret-manager only (never DB/git). Refusing to start (fail-closed).',
    );
  }
}
