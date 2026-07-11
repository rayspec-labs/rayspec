/**
 * argon2id password primitive — unit-testable without HTTP.
 */
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { ARGON2ID_PARAMS, hashPassword, needsRehash, verifyPassword } from './password.js';

describe('hashPassword', () => {
  it('produces an argon2id-formatted hash that is not the plaintext and embeds the params', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toBe('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain(`m=${ARGON2ID_PARAMS.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2ID_PARAMS.timeCost}`);
    expect(hash).toContain(`p=${ARGON2ID_PARAMS.parallelism}`);
  });

  it('salts differently — the same password hashes to different strings', async () => {
    const a = await hashPassword('hunter2');
    const b = await hashPassword('hunter2');
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('returns true for the right password and false for the wrong one', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(await verifyPassword(hash, 's3cret-pass')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('returns false (does not throw) on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
  });
});

describe('needsRehash (upgrade-on-login)', () => {
  it('is false for a hash made with the current params', async () => {
    const hash = await hashPassword('pw');
    expect(needsRehash(hash)).toBe(false);
  });

  it('is true for a hash made with WEAKER params (so login can transparently re-hash)', async () => {
    const weak = await argon2.hash('pw', {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });
    expect(needsRehash(weak)).toBe(true);
    // ...and after a re-hash with the current params it no longer needs one.
    const upgraded = await hashPassword('pw');
    expect(needsRehash(upgraded)).toBe(false);
  });
});
