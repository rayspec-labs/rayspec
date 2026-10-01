/**
 * The previous API-key pepper: which peppers a presented credential is checked under. The current
 * pepper always comes first; the previous one joins it only while it is set and differs; a boot that
 * supplied its secrets owns the previous pepper too, so an ambient variable never revives one the boot
 * did not resolve.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getApiKeyPepper,
  getPreviousApiKeyPepper,
  hashApiKey,
  verificationPeppers,
  verifyApiKey,
} from './api-key.js';
import {
  API_KEY_PEPPER_ENV,
  API_KEY_PEPPER_PREVIOUS_ENV,
  resetBootSecretsForTests,
  setBootSecrets,
} from './config.js';

const PEM = '-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----';

describe('the previous API-key pepper', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [API_KEY_PEPPER_ENV, API_KEY_PEPPER_PREVIOUS_ENV]) saved[k] = process.env[k];
    delete process.env[API_KEY_PEPPER_ENV];
    delete process.env[API_KEY_PEPPER_PREVIOUS_ENV];
    resetBootSecretsForTests();
  });

  afterEach(() => {
    resetBootSecretsForTests();
    for (const k of [API_KEY_PEPPER_ENV, API_KEY_PEPPER_PREVIOUS_ENV]) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is absent unless supplied, and the current pepper is then the only one', () => {
    setBootSecrets({ jwtSigningKeyPem: PEM, apiKeyPepper: 'new-pepper' });
    expect(getPreviousApiKeyPepper()).toBeUndefined();
    expect(verificationPeppers()).toEqual(['new-pepper']);
  });

  it('joins after the current pepper while it is supplied', () => {
    setBootSecrets({
      jwtSigningKeyPem: PEM,
      apiKeyPepper: 'new-pepper',
      apiKeyPepperPrevious: 'old-pepper',
    });
    expect(getApiKeyPepper()).toBe('new-pepper');
    expect(getPreviousApiKeyPepper()).toBe('old-pepper');
    expect(verificationPeppers()).toEqual(['new-pepper', 'old-pepper']);
    // New hashes use the current pepper only.
    expect(hashApiKey('s')).toBe(hashApiKey('s', 'new-pepper'));
    expect(verifyApiKey(hashApiKey('s', 'old-pepper'), 's')).toBe(false);
    expect(verifyApiKey(hashApiKey('s', 'old-pepper'), 's', 'old-pepper')).toBe(true);
  });

  it('adds nothing when it equals the current pepper', () => {
    setBootSecrets({ jwtSigningKeyPem: PEM, apiKeyPepper: 'same', apiKeyPepperPrevious: 'same' });
    expect(getPreviousApiKeyPepper()).toBeUndefined();
    expect(verificationPeppers()).toEqual(['same']);
  });

  it('is owned by a boot that supplied its secrets: an ambient variable does not revive it', () => {
    process.env[API_KEY_PEPPER_PREVIOUS_ENV] = 'ambient-old-pepper';
    setBootSecrets({ jwtSigningKeyPem: PEM, apiKeyPepper: 'new-pepper' });
    expect(getPreviousApiKeyPepper()).toBeUndefined();
  });

  it('falls back to the environment for a caller that supplied nothing, like the pepper itself', () => {
    process.env[API_KEY_PEPPER_ENV] = 'env-pepper';
    process.env[API_KEY_PEPPER_PREVIOUS_ENV] = 'env-old-pepper';
    expect(verificationPeppers()).toEqual(['env-pepper', 'env-old-pepper']);
  });
});
