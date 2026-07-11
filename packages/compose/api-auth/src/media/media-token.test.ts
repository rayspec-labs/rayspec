/**
 * Media-token signer/verifier UNIT tests — the SECOND auth path's crypto core,
 * proven in isolation (the DB-backed end-to-end battery in stream-playback.db.test.ts proves the
 * route + the DB ownership re-validation). — fail-the-fix, not pass-the-shape:
 *
 *  - a VALID token round-trips (mint → verify → the exact claims, alg pinned to HS256);
 *  - ALG CONFUSION is blocked: an `alg:none` token, an RS256-signed token, AND a token signed with a
 *    DIFFERENT HS secret (the API-key-class confusion) all FAIL verify;
 *  - a FORGED/TAMPERED token (bad signature) fails;
 *  - an EXPIRED token fails;
 *  - a SWAPPED-claim token (re-signed by an attacker WITHOUT the media secret) fails on the signature;
 *  - the jti REVOCATION denylist denies a revoked-but-unexpired token;
 *  - a token is NOT single-use (the same token verifies repeatedly — streaming reuse).
 */
import { decodeJwt, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createMediaDenylist,
  createMediaTokenService,
  MEDIA_TOKEN_MAX_TTL_SECONDS,
} from './media-token.js';

const SECRET = 'media-secret-at-least-32-bytes-long-xxxx';
const OTHER_SECRET = 'a-totally-different-media-secret-32bytes!';

function svc(secret = SECRET, denylist = createMediaDenylist()) {
  return createMediaTokenService(secret, denylist);
}

describe('media-token service (the distinct HS256 second auth path)', () => {
  it('mints + verifies a valid token, surfacing the exact claims', async () => {
    const s = svc();
    const token = await s.mint({
      tenantId: 'tenant-A',
      resource: 'upl-1/0',
      sub: 'user-1',
      ttlSeconds: 300,
    });
    const r = await s.verify(token);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.claims).toMatchObject({ tenantId: 'tenant-A', resource: 'upl-1/0', sub: 'user-1' });
    expect(typeof r.claims.jti).toBe('string');
    expect(r.claims.jti.length).toBeGreaterThan(0);
  });

  it('a token is REUSABLE across many verifies (not single-use — streaming Range reuse)', async () => {
    const s = svc();
    const token = await s.mint({ tenantId: 't', resource: 'r', sub: 'u', ttlSeconds: 300 });
    for (let i = 0; i < 5; i++) {
      const r = await s.verify(token);
      expect(r.ok).toBe(true);
    }
  });

  it('REJECTS an alg:none token (alg-confusion)', async () => {
    // Hand-craft an unsigned `alg:none` JWT (the classic downgrade). jose's UnsecuredJWT emits it.
    const { UnsecuredJWT } = await import('jose');
    const none = new UnsecuredJWT({ tenantId: 't', resource: 'r', sub: 'u' })
      .setIssuer('rayspec-media')
      .setAudience('rayspec-media-playback')
      .setJti('x')
      .setExpirationTime('5m')
      .encode();
    const r = await svc().verify(none);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('alg_rejected');
  });

  it('REJECTS an RS256-signed token (alg-confusion — never verified with the HS key)', async () => {
    const { generateKeyPair } = await import('jose');
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const rs = await new SignJWT({ tenantId: 't', resource: 'r', sub: 'u' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('rayspec-media')
      .setAudience('rayspec-media-playback')
      .setJti('x')
      .setExpirationTime('5m')
      .sign(privateKey);
    const r = await svc().verify(rs);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('alg_rejected');
  });

  it('REJECTS a token signed with a DIFFERENT HS secret (forged/wrong-key)', async () => {
    // Mint with OTHER_SECRET, verify with SECRET → signature fails (the distinct-key isolation core).
    const forged = await svc(OTHER_SECRET).mint({
      tenantId: 't',
      resource: 'r',
      sub: 'u',
      ttlSeconds: 300,
    });
    const r = await svc(SECRET).verify(forged);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('bad_signature');
  });

  it('REJECTS a TAMPERED token (a flipped payload byte breaks the signature)', async () => {
    const s = svc();
    const token = await s.mint({ tenantId: 't', resource: 'r', sub: 'u', ttlSeconds: 300 });
    const [h, p, sig] = token.split('.');
    // Flip a char in the payload segment → the signature no longer matches.
    const tamperedP = `${p.slice(0, -1)}${p.slice(-1) === 'A' ? 'B' : 'A'}`;
    const r = await s.verify(`${h}.${tamperedP}.${sig}`);
    expect(r.ok).toBe(false);
  });

  it('REJECTS an EXPIRED token', async () => {
    const s = svc();
    // ttl of 1s, then verify after it has expired (jose enforces exp, no clock tolerance configured).
    const token = await s.mint({ tenantId: 't', resource: 'r', sub: 'u', ttlSeconds: 1 });
    await new Promise((res) => setTimeout(res, 1100));
    const r = await s.verify(token);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('expired');
  });

  it('REJECTS a revoked jti via the denylist (revoked-but-unexpired)', async () => {
    const denylist = createMediaDenylist();
    const s = svc(SECRET, denylist);
    const token = await s.mint({ tenantId: 't', resource: 'r', sub: 'u', ttlSeconds: 300 });
    // Before revocation: valid.
    expect((await s.verify(token)).ok).toBe(true);
    // Revoke its jti, then verify again → denied.
    const claims = await s.verify(token);
    if (!claims.ok) throw new Error('unreachable');
    s.denylist.add(claims.claims.jti);
    const r = await s.verify(token);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('revoked');
  });

  it('REJECTS a malformed / empty token', async () => {
    const s = svc();
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d']) {
      const r = await s.verify(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('FAIL-CLOSED on a too-short media secret (a weak HMAC key)', () => {
    expect(() => createMediaTokenService('short')).toThrow(/at least 32/i);
  });

  it('REJECTS a token whose audience is wrong (a non-playback media token)', async () => {
    const wrongAud = await new SignJWT({ tenantId: 't', resource: 'r', sub: 'u' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('rayspec-media')
      .setAudience('some-other-audience')
      .setJti('x')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(SECRET));
    const r = await svc().verify(wrongAud);
    expect(r.ok).toBe(false);
  });

  it('CLAMPS the TTL at the platform MAX ceiling (a handler/pack cannot mint an unbounded bearer)', async () => {
    const s = svc();
    // Request a TTL far beyond the cap (1 year). The minted token's exp-iat must be EXACTLY the ceiling,
    // not the requested value — the clamp lives in `mint`, so EVERY caller (incl. the route-handler mint
    // closure) is bounded.
    const requested = MEDIA_TOKEN_MAX_TTL_SECONDS * 365;
    const token = await s.mint({ tenantId: 't', resource: 'r', sub: 'u', ttlSeconds: requested });
    const { iat, exp } = decodeJwt(token);
    expect(typeof iat).toBe('number');
    expect(typeof exp).toBe('number');
    expect((exp as number) - (iat as number)).toBe(MEDIA_TOKEN_MAX_TTL_SECONDS);
    // And it still VERIFIES (the clamp does not break a legitimately long mint).
    expect((await s.verify(token)).ok).toBe(true);
  });

  it('REJECTS a correctly-signed token that carries NO exp (requiredClaims:["exp"])', async () => {
    // A token signed with the REAL media secret + correct iss/aud + a jti, but WITHOUT an expiration.
    // `mint` always sets exp, so an exp-less token is malformed-shaped — the verifier must NOT treat it
    // as never-expiring. (Before requiredClaims:['exp'] this verified ok:true.)
    const noExp = await new SignJWT({ tenantId: 't', resource: 'r', sub: 'u' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('rayspec-media')
      .setAudience('rayspec-media-playback')
      .setJti('x')
      .setIssuedAt()
      // deliberately NO .setExpirationTime(...)
      .sign(new TextEncoder().encode(SECRET));
    const r = await svc().verify(noExp);
    expect(r.ok).toBe(false);
  });
});
