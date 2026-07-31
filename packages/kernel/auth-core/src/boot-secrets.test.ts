/**
 * The in-process boot-secret supply path.
 *
 * `setBootSecrets` is how a boot hands the two REQUIRED-AT-BOOT secrets to this package without
 * routing them through `process.env` (which every spawned child inherits). The properties that make
 * that safe to rely on, pinned here:
 *
 *   - supplying the secrets NEVER writes `process.env` — that is the whole point;
 *   - a supplied secret satisfies the readers with the environment variables absent;
 *   - a supplied secret WINS over the environment, because the boot's value is the validated,
 *     whitespace-normalized one and a stale/untrimmed env variable must not override it;
 *   - the environment remains the fallback for a caller that constructs the app directly;
 *   - fail-closed is unchanged: nothing supplied AND nothing in the environment still throws, and a
 *     BLANK supplied secret throws too — the boot owns every name it hands over, so a blank one
 *     aborts instead of re-opening the environment as a fallback for that name.
 *
 * The suite unsets the two variables itself (the package's vitest setup provisions a dev pepper) and
 * restores them afterwards, and clears the supplied secrets between cases so no case can pass on a
 * neighbour's leftovers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getApiKeyPepper, hashApiKey } from './api-key.js';
import {
  API_KEY_PEPPER_ENV,
  assertBootSecrets,
  getJwtSigningKeyPem,
  JWT_SIGNING_KEY_ENV,
  resetBootSecretsForTests,
  setBootSecrets,
} from './config.js';

const SUPPLIED_PEM = '-----BEGIN PRIVATE KEY-----supplied-----END PRIVATE KEY-----';
const SUPPLIED_PEPPER = 'pepper-handed-to-the-process-by-the-boot';

describe('boot secrets supplied in-process', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [JWT_SIGNING_KEY_ENV, API_KEY_PEPPER_ENV]) saved[k] = process.env[k];
    delete process.env[JWT_SIGNING_KEY_ENV];
    delete process.env[API_KEY_PEPPER_ENV];
    resetBootSecretsForTests();
  });

  afterEach(() => {
    resetBootSecretsForTests();
    for (const k of [JWT_SIGNING_KEY_ENV, API_KEY_PEPPER_ENV]) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('does not put the secrets into process.env', () => {
    setBootSecrets({ jwtSigningKeyPem: SUPPLIED_PEM, apiKeyPepper: SUPPLIED_PEPPER });
    // Asserted on PRESENCE, never on the value — a failure here must not print key material. `in`
    // is the right question: a child environment is built by ENUMERATING process.env.
    expect(JWT_SIGNING_KEY_ENV in process.env).toBe(false);
    expect(API_KEY_PEPPER_ENV in process.env).toBe(false);
  });

  it('satisfies the readers with both environment variables absent', () => {
    setBootSecrets({ jwtSigningKeyPem: SUPPLIED_PEM, apiKeyPepper: SUPPLIED_PEPPER });
    expect(() => assertBootSecrets()).not.toThrow();
    expect(getJwtSigningKeyPem()).toBe(SUPPLIED_PEM);
    expect(getApiKeyPepper()).toBe(SUPPLIED_PEPPER);
    // The pepper reaches the actual HMAC path, not just the accessor.
    expect(hashApiKey('a-secret')).toBe(hashApiKey('a-secret', SUPPLIED_PEPPER));
  });

  it('wins over a value in the environment (the boot resolved and normalized this one)', () => {
    process.env[JWT_SIGNING_KEY_ENV] = 'stale-pem-from-the-environment';
    process.env[API_KEY_PEPPER_ENV] = `${SUPPLIED_PEPPER}\n`;
    setBootSecrets({ jwtSigningKeyPem: SUPPLIED_PEM, apiKeyPepper: SUPPLIED_PEPPER });
    expect(getJwtSigningKeyPem()).toBe(SUPPLIED_PEM);
    // The untrimmed env form would change the HMAC key on every api key hashed under it.
    expect(getApiKeyPepper()).toBe(SUPPLIED_PEPPER);
  });

  it('falls back to the environment when the boot supplied nothing', () => {
    process.env[JWT_SIGNING_KEY_ENV] = 'pem-from-the-environment';
    process.env[API_KEY_PEPPER_ENV] = 'pepper-from-the-environment';
    expect(() => assertBootSecrets()).not.toThrow();
    expect(getJwtSigningKeyPem()).toBe('pem-from-the-environment');
    expect(getApiKeyPepper()).toBe('pepper-from-the-environment');
  });

  it('still fails closed when neither source has the secrets', () => {
    expect(() => assertBootSecrets()).toThrow(new RegExp(JWT_SIGNING_KEY_ENV));
    expect(() => assertBootSecrets()).toThrow(new RegExp(API_KEY_PEPPER_ENV));
    expect(() => getJwtSigningKeyPem()).toThrow(/required at boot/);
    expect(() => getApiKeyPepper()).toThrow(/required at boot/);
  });

  it('treats a blank supplied secret as missing, exactly like a blank environment variable', () => {
    setBootSecrets({ jwtSigningKeyPem: '   ', apiKeyPepper: SUPPLIED_PEPPER });
    expect(() => assertBootSecrets()).toThrow(new RegExp(JWT_SIGNING_KEY_ENV));
    expect(() => getJwtSigningKeyPem()).toThrow(/required at boot/);
  });

  it('a blank supplied secret still aborts when the environment holds a value for it', () => {
    // The boot OWNS every name it supplied. A blank one is an absent one, and it must abort rather
    // than resolve to whatever the ambient environment happens to carry — that would silently run
    // the deployment on a secret the caller never configured (a different pepper hashes every api
    // key, a different PEM signs every token), where the boot used to refuse to start.
    process.env[JWT_SIGNING_KEY_ENV] = 'ambient-pem-the-caller-did-not-configure';
    process.env[API_KEY_PEPPER_ENV] = 'ambient-pepper-the-caller-did-not-configure';
    setBootSecrets({ jwtSigningKeyPem: '', apiKeyPepper: '   ' });
    expect(() => assertBootSecrets()).toThrow(new RegExp(JWT_SIGNING_KEY_ENV));
    expect(() => assertBootSecrets()).toThrow(new RegExp(API_KEY_PEPPER_ENV));
    expect(() => getJwtSigningKeyPem()).toThrow(/required at boot/);
    expect(() => getApiKeyPepper()).toThrow(/required at boot/);
  });

  it('resetBootSecretsForTests returns the process to the environment-only path', () => {
    setBootSecrets({ jwtSigningKeyPem: SUPPLIED_PEM, apiKeyPepper: SUPPLIED_PEPPER });
    expect(getApiKeyPepper()).toBe(SUPPLIED_PEPPER);
    resetBootSecretsForTests();
    expect(() => getApiKeyPepper()).toThrow(/required at boot/);
  });
});
