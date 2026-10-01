import { describe, expect, it } from 'vitest';
import { hashApiKey } from './api-key.js';
import { hashInviteToken } from './invite.js';
import { hashOwnerRecoveryToken, mintOwnerRecoveryToken } from './owner-recovery.js';
import { hashSessionSecret } from './session.js';

const PEPPER = ['owner', 'recovery', 'unit', 'pepper'].join('-');

describe('owner recovery token', () => {
  it('mints a 256-bit URL-safe token and the HMAC its redemption looks up', () => {
    const { token, hash } = mintOwnerRecoveryToken(PEPPER);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(hashOwnerRecoveryToken(token, PEPPER)).toBe(hash);
  });

  it('never mints the same token twice', () => {
    expect(mintOwnerRecoveryToken(PEPPER).token).not.toBe(mintOwnerRecoveryToken(PEPPER).token);
  });

  it('is domain-separated from the API-key, session and invite hashes under the same pepper', () => {
    const secret = 'one-secret-value';
    const recovery = hashOwnerRecoveryToken(secret, PEPPER);
    expect(recovery).not.toBe(hashApiKey(secret, PEPPER));
    expect(recovery).not.toBe(hashSessionSecret(secret, PEPPER));
    expect(recovery).not.toBe(hashInviteToken(secret, PEPPER));
  });

  it('is keyed by the pepper: a new pepper never verifies a token minted under the old one', () => {
    const { token, hash } = mintOwnerRecoveryToken(PEPPER);
    expect(hashOwnerRecoveryToken(token, `${PEPPER}-new`)).not.toBe(hash);
  });
});
