/**
 * api-key HMAC primitive — unit-testable without HTTP.
 *
 * The pepper is provisioned for the positive cases (the auth-core vitest setup sets a dev
 * RAYSPEC_API_KEY_PEPPER) and the boot-required case explicitly UNSETS it to prove
 * getApiKeyPepper() fails closed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getApiKeyPepper, hashApiKey, mintApiKey, verifyApiKey } from './api-key.js';

const PEPPER_ENV = 'RAYSPEC_API_KEY_PEPPER';
const TEST_PEPPER = 'dev-pepper-for-tests-only';

describe('getApiKeyPepper (boot-required)', () => {
  const saved = process.env[PEPPER_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[PEPPER_ENV];
    else process.env[PEPPER_ENV] = saved;
  });

  it('throws when the pepper env var is missing (fail-closed at boot)', () => {
    delete process.env[PEPPER_ENV];
    expect(() => getApiKeyPepper()).toThrow(/required at boot/);
  });

  it('throws when the pepper env var is blank', () => {
    process.env[PEPPER_ENV] = '   ';
    expect(() => getApiKeyPepper()).toThrow(/required at boot/);
  });

  it('returns the pepper when present', () => {
    process.env[PEPPER_ENV] = TEST_PEPPER;
    expect(getApiKeyPepper()).toBe(TEST_PEPPER);
  });
});

describe('hashApiKey / verifyApiKey', () => {
  it('hash is not the secret and is deterministic for a given pepper', () => {
    const hash = hashApiKey('super-secret', TEST_PEPPER);
    expect(hash).not.toBe('super-secret');
    expect(hash).toBe(hashApiKey('super-secret', TEST_PEPPER));
  });

  it('verifies the right secret and rejects the wrong one', () => {
    const hash = hashApiKey('super-secret', TEST_PEPPER);
    expect(verifyApiKey(hash, 'super-secret', TEST_PEPPER)).toBe(true);
    expect(verifyApiKey(hash, 'wrong-secret', TEST_PEPPER)).toBe(false);
  });

  it('a different pepper does not verify (pepper is load-bearing)', () => {
    const hash = hashApiKey('super-secret', TEST_PEPPER);
    expect(verifyApiKey(hash, 'super-secret', 'other-pepper')).toBe(false);
  });
});

describe('mintApiKey', () => {
  it('returns a prefix + ≥128-bit secret whose hash verifies and whose plaintext is prefix.secret', () => {
    const minted = mintApiKey(TEST_PEPPER);
    expect(minted.prefix.startsWith('rk_')).toBe(true);
    expect(minted.plaintext.startsWith(`${minted.prefix}.`)).toBe(true);
    const secret = minted.plaintext.slice(minted.prefix.length + 1);
    // 32 random bytes base64url-encoded ⇒ comfortably ≥128-bit of entropy.
    expect(Buffer.from(secret, 'base64url').length).toBe(32);
    // The stored hash verifies against the plaintext secret.
    expect(verifyApiKey(minted.hash, secret, TEST_PEPPER)).toBe(true);
    expect(minted.hash).not.toContain(secret);
  });

  it('mints distinct keys each call', () => {
    const a = mintApiKey(TEST_PEPPER);
    const b = mintApiKey(TEST_PEPPER);
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});
