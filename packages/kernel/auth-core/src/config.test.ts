/**
 * Boot-required-secrets test (the auth-core half of boot-fails-closed). The full app-level
 * boot-fails-closed test lives in api-auth (it constructs the real app); here we assert the
 * assertBootSecrets primitive throws when either secret is absent and passes when both are set.
 */
import { describe, expect, it } from 'vitest';
import { API_KEY_PEPPER_ENV, assertBootSecrets, JWT_SIGNING_KEY_ENV } from './config.js';

describe('assertBootSecrets fails closed', () => {
  it('throws when the signing key is missing', () => {
    const env = { [API_KEY_PEPPER_ENV]: 'p' } as NodeJS.ProcessEnv;
    expect(() => assertBootSecrets(env)).toThrow(new RegExp(JWT_SIGNING_KEY_ENV));
  });

  it('throws when the pepper is missing', () => {
    const env = { [JWT_SIGNING_KEY_ENV]: 'k' } as NodeJS.ProcessEnv;
    expect(() => assertBootSecrets(env)).toThrow(new RegExp(API_KEY_PEPPER_ENV));
  });

  it('throws listing BOTH when both are missing', () => {
    expect(() => assertBootSecrets({} as NodeJS.ProcessEnv)).toThrow(/missing/);
  });

  it('throws on a blank (whitespace-only) secret', () => {
    const env = {
      [JWT_SIGNING_KEY_ENV]: '   ',
      [API_KEY_PEPPER_ENV]: 'p',
    } as NodeJS.ProcessEnv;
    expect(() => assertBootSecrets(env)).toThrow(new RegExp(JWT_SIGNING_KEY_ENV));
  });

  it('passes when both are present', () => {
    const env = {
      [JWT_SIGNING_KEY_ENV]: 'key',
      [API_KEY_PEPPER_ENV]: 'pepper',
    } as NodeJS.ProcessEnv;
    expect(() => assertBootSecrets(env)).not.toThrow();
  });
});
