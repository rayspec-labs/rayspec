/**
 * jose access-token module tests (DB-free).
 *
 * Covers the token assertions: typ at+jwt, the iss/aud/scope/org_id claims,
 * verifies against the JWKS, ~8m exp, tampered/expired rejected, aud cross-check rejected, and
 * the kid-rotation overlap window (a token under an old kid still verifies while the old key is
 * in the JWKS, fails after retirement).
 */
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ACCESS_TOKEN_TYP,
  AUDIENCE_AGENT_RUNTIME,
  AUDIENCE_API,
  createSigner,
  JwksProvider,
  TOKEN_ISSUER,
  TokenSigner,
} from './tokens.js';

async function makeSigner(): Promise<TokenSigner> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  return TokenSigner.fromKeys(privateKey, publicKey, 'RS256');
}

describe('access-token mint + verify', () => {
  it('mints a token with typ at+jwt and the expected claims, verifies against the JWKS', async () => {
    const signer = await makeSigner();
    const jwks = new JwksProvider([signer.publicKeyJwk()]);
    const token = await signer.mint(
      { userId: 'u1', orgId: 'org-1', mshipRole: 'owner', scopes: ['agent:run', 'org:read'] },
      'jti-1',
    );

    expect(decodeProtectedHeader(token).typ).toBe(ACCESS_TOKEN_TYP);
    const claims = decodeJwt(token);
    expect(claims.iss).toBe(TOKEN_ISSUER);
    expect(claims.aud).toBe(AUDIENCE_API);
    expect(claims.sub).toBe('u1');
    expect(claims.org_id).toBe('org-1');
    expect(claims.mship_role).toBe('owner');
    expect(claims.scope).toBe('agent:run org:read');
    // exp ≈ now + TTL.
    const now = Math.floor(Date.now() / 1000);
    expect((claims.exp ?? 0) - now).toBeGreaterThan(ACCESS_TOKEN_TTL_SECONDS - 30);
    expect((claims.exp ?? 0) - now).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_SECONDS + 1);

    const verified = await jwks.verify(token);
    expect(verified.userId).toBe('u1');
    expect(verified.orgId).toBe('org-1');
    expect(verified.mshipRole).toBe('owner');
    expect(verified.scopes).toEqual(['agent:run', 'org:read']);
    expect(verified.jti).toBe('jti-1');
  });

  it('rejects a tampered token', async () => {
    const signer = await makeSigner();
    const jwks = new JwksProvider([signer.publicKeyJwk()]);
    const token = await signer.mint({ userId: 'u1' }, 'jti');
    const parts = token.split('.');
    // Flip a character in the payload segment.
    const badPayload = `${parts[1]?.slice(0, -1)}${parts[1]?.endsWith('A') ? 'B' : 'A'}`;
    const tampered = `${parts[0]}.${badPayload}.${parts[2]}`;
    await expect(jwks.verify(tampered)).rejects.toBeDefined();
  });

  it('rejects an expired token (beyond the clock tolerance)', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const signer = await TokenSigner.fromKeys(privateKey, publicKey, 'RS256');
    const jwks = new JwksProvider([signer.publicKeyJwk()]);
    // Hand-sign an already-expired token (exp 10 min ago) with the SAME key + headers.
    const expired = await new SignJWT({ scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: signer.kid, typ: ACCESS_TOKEN_TYP })
      .setIssuer(TOKEN_ISSUER)
      .setSubject('u1')
      .setAudience(AUDIENCE_API)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 1200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 600)
      .sign(privateKey);
    await expect(jwks.verify(expired)).rejects.toBeDefined();
  });

  it('rejects a token minted for aud rayspec-api when verified for the agent-runtime aud', async () => {
    const signer = await makeSigner();
    const jwks = new JwksProvider([signer.publicKeyJwk()]);
    const token = await signer.mint({ userId: 'u1' }, 'jti'); // default aud = rayspec-api
    await expect(jwks.verify(token, AUDIENCE_AGENT_RUNTIME)).rejects.toBeDefined();
    // ...but verifies for its real audience.
    await expect(jwks.verify(token, AUDIENCE_API)).resolves.toBeDefined();
  });
});

describe('configurable access-token TTL', () => {
  it('defaults to ACCESS_TOKEN_TTL_SECONDS (480) when no ttl is given', async () => {
    const signer = await makeSigner();
    expect(signer.accessTokenTtlSeconds).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(480);
    const token = await signer.mint({ userId: 'u1' }, 'jti-default');
    const claims = decodeJwt(token);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('TokenSigner.fromKeys mints with a CUSTOM ttlSeconds (exp - iat ≈ 3600)', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const signer = await TokenSigner.fromKeys(privateKey, publicKey, 'RS256', 3600);
    expect(signer.accessTokenTtlSeconds).toBe(3600);
    const token = await signer.mint({ userId: 'u1' }, 'jti-custom');
    const claims = decodeJwt(token);
    const delta = (claims.exp ?? 0) - (claims.iat ?? 0);
    expect(delta).toBeGreaterThanOrEqual(3600 - 2);
    expect(delta).toBeLessThanOrEqual(3600 + 2);
  });

  it('createSigner threads a CUSTOM ttlSeconds through to the minted token', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pkcs8 = await exportPKCS8(privateKey);
    const signer = await createSigner(pkcs8, 'RS256', 3600);
    expect(signer.accessTokenTtlSeconds).toBe(3600);
    const token = await signer.mint({ userId: 'u1' }, 'jti-createSigner');
    const claims = decodeJwt(token);
    const delta = (claims.exp ?? 0) - (claims.iat ?? 0);
    expect(delta).toBeGreaterThanOrEqual(3600 - 2);
    expect(delta).toBeLessThanOrEqual(3600 + 2);
    // The default still holds when no ttl is passed (existing callers unaffected).
    const defaultSigner = await createSigner(pkcs8, 'RS256');
    expect(defaultSigner.accessTokenTtlSeconds).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });
});

describe('JWKS kid rotation overlap window', () => {
  it('a token under the OLD kid verifies while the old key is still in the JWKS, fails after retirement', async () => {
    const oldSigner = await makeSigner();
    const newSigner = await makeSigner();
    expect(oldSigner.kid).not.toBe(newSigner.kid);

    const tokenUnderOld = await oldSigner.mint({ userId: 'u1' }, 'jti');

    // Overlap window: BOTH public keys published. The old token still verifies.
    const overlap = new JwksProvider([newSigner.publicKeyJwk(), oldSigner.publicKeyJwk()]);
    await expect(overlap.verify(tokenUnderOld)).resolves.toBeDefined();

    // After retirement: only the new key remains. The old token no longer verifies.
    const afterRetire = new JwksProvider([newSigner.publicKeyJwk()]);
    await expect(afterRetire.verify(tokenUnderOld)).rejects.toBeDefined();
  });
});
