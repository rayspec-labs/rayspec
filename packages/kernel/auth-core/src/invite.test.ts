import { beforeAll, describe, expect, it } from 'vitest';
import { hashInviteToken, mintInviteToken } from './invite.js';

const PEPPER = 'test-pepper-for-invite-unit';

beforeAll(() => {
  process.env.RAYSPEC_API_KEY_PEPPER = PEPPER;
});

describe('invite token', () => {
  it('mints a 256-bit URL-safe token + a deterministic HMAC hash', () => {
    const { token, hash } = mintInviteToken();
    // base64url of 32 bytes → 43 chars, URL-safe alphabet only (no +/=).
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // The plaintext is NEVER equal to its stored hash.
    expect(hash).not.toBe(token);
    // hashInviteToken(token) reproduces the stored hash (the redeem lookup key).
    expect(hashInviteToken(token)).toBe(hash);
  });

  it('is unguessable — two mints never collide', () => {
    const a = mintInviteToken();
    const b = mintInviteToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it('is domain-separated from the api-key HMAC (same pepper, different digest)', async () => {
    const { hashApiKey } = await import('./api-key.js');
    const secret = 'shared-secret-value';
    // Even with the SAME secret + pepper, the invite hash (invite: prefix) != the api-key hash.
    expect(hashInviteToken(secret, PEPPER)).not.toBe(hashApiKey(secret, PEPPER));
  });

  it('binds to the pepper — a different pepper yields a different hash', () => {
    const token = mintInviteToken().token;
    expect(hashInviteToken(token, 'pepper-A')).not.toBe(hashInviteToken(token, 'pepper-B'));
  });
});
