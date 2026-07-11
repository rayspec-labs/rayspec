/**
 * Access-token module — short-lived RFC-9068 JWTs (jose), DB-free + unit-testable.
 *
 * Opaque server sessions + SHORT JWT access tokens. The JWT is the stateless, aud+scope-
 * bound credential a resource server can verify WITHOUT a DB hit; the opaque session (sessions
 * table) is the single revocation point. Tokens are NEVER persisted.
 *
 * Verified doc-first (2026-06-22) against jose 6.2.3 (everything re-exported from the main entry):
 *   - new SignJWT(claims).setProtectedHeader({alg, kid, typ}).setIssuer/Audience/IssuedAt/
 *     ExpirationTime/Jti(...).sign(privateKey)
 *   - jwtVerify(token, keyOrJWKS, { issuer, audience, clockTolerance, typ })
 *   - importPKCS8(pem, alg) / generateKeyPair(alg) / exportJWK(publicKey) / createLocalJWKSet
 *
 * CLAIMS: iss, sub (userId), aud, scope (space-delimited), org_id, mship_role,
 * jti, iat, exp. exp ~8 min; verify clockTolerance 30s. `typ` is `at+jwt` (RFC 9068).
 *
 * KEY ROTATION (documented): each signer has a `kid` (the public-key JWK thumbprint). To rotate,
 * publish a NEW kid in the JWKS, sign new tokens under it, and KEEP the old public key in the
 * JWKS for verification until every token minted under it has expired (≥ TTL + clockTolerance).
 * Then retire the old key. A token's `kid` header selects its verification key, so old + new
 * coexist during the overlap window and rotation is never an auth outage.
 */
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
} from 'jose';

/** Issuer — the RaySpec auth control plane. */
export const TOKEN_ISSUER = 'rayspec-auth';
/** The control-plane API audience (this server). The agent runtime uses a DIFFERENT aud. */
export const AUDIENCE_API = 'rayspec-api';
/** The agent-runtime resource-server audience (forward-compatible; not minted by default). */
export const AUDIENCE_AGENT_RUNTIME = 'rayspec-agent-runtime';

/** Access-token TTL (~8 min) and verify clock tolerance (~30s). */
export const ACCESS_TOKEN_TTL_SECONDS = 8 * 60;
export const CLOCK_TOLERANCE_SECONDS = 30;
/** RFC 9068 access-token media type — set in the JWT `typ` header and checked on verify. */
export const ACCESS_TOKEN_TYP = 'at+jwt';

/** Supported signing algorithms (RS256 primary, EdDSA accepted). */
export type SigningAlg = 'RS256' | 'EdDSA';

/**
 * The private-key type jose hands back from importPKCS8 / generateKeyPair. Derived from the API
 * rather than naming the WebCrypto `CryptoKey` global (our tsconfig lib is ES2023, no DOM types),
 * so the signer is typed without pulling in the DOM lib.
 */
type JosePrivateKey = Awaited<ReturnType<typeof importPKCS8>>;

/** The claims a RaySpec access token carries (beyond the registered iss/aud/sub/iat/exp/jti). */
export interface AccessTokenClaims {
  /** Subject — the global user id. */
  userId: string;
  /** The active org (tenant) this token is scoped to (may be undefined before an org is chosen). */
  orgId?: string;
  /** The caller's membership role in `orgId` at mint time (read-staleness bounded; never trusted
   * for sensitive writes — those re-check live, see authz.ts). */
  mshipRole?: string;
  /** OAuth-style scopes granted to this token. */
  scopes?: string[];
  /** Audience (defaults to the control-plane API). */
  audience?: string;
}

/** A verified token's normalized claims (what callers read after verifyAccessToken). */
export interface VerifiedAccessToken {
  userId: string;
  orgId?: string;
  mshipRole?: string;
  scopes: string[];
  jti?: string;
  audience: string;
}

/**
 * A token signer bound to ONE key (one kid). Construct via `createSigner` (from a PEM) or
 * `createSignerFromKeyPair` (tests). Holds the private key for signing + the public JWK for the
 * JWKS endpoint. The verifier resolves a token's `kid` against a key set (see JwksProvider).
 */
export class TokenSigner {
  readonly kid: string;
  readonly alg: SigningAlg;
  private readonly privateKey: JosePrivateKey;
  private readonly publicJwk: Record<string, unknown>;
  /** The access-token TTL (seconds) this signer mints with. Default ACCESS_TOKEN_TTL_SECONDS (480). */
  private readonly ttlSeconds: number;

  constructor(
    kid: string,
    alg: SigningAlg,
    privateKey: JosePrivateKey,
    publicJwk: Record<string, unknown>,
    ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
  ) {
    this.kid = kid;
    this.alg = alg;
    this.privateKey = privateKey;
    this.publicJwk = publicJwk;
    this.ttlSeconds = ttlSeconds;
  }

  /** Build a signer from a private + public CryptoKey pair (used by tests + createSigner). */
  static async fromKeys(
    privateKey: JosePrivateKey,
    publicKey: JosePrivateKey,
    alg: SigningAlg,
    ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
  ): Promise<TokenSigner> {
    const publicJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
    const kid = await calculateJwkThumbprint(
      publicJwk as Parameters<typeof calculateJwkThumbprint>[0],
    );
    publicJwk.kid = kid;
    publicJwk.use = 'sig';
    publicJwk.alg = alg;
    return new TokenSigner(kid, alg, privateKey, publicJwk, ttlSeconds);
  }

  /** The public JWK (with kid/use/alg) to publish in the JWKS endpoint. */
  publicKeyJwk(): Record<string, unknown> {
    return { ...this.publicJwk };
  }

  /**
   * The configured access-token TTL in seconds (default ACCESS_TOKEN_TTL_SECONDS). Callers (the auth
   * routes) report THIS in the response `expiresIn` so it can never drift from the minted token's `exp`.
   */
  get accessTokenTtlSeconds(): number {
    return this.ttlSeconds;
  }

  /** Mint a signed access token. exp = now + the signer's configured ttlSeconds (default ACCESS_TOKEN_TTL_SECONDS). */
  async mint(claims: AccessTokenClaims, jti: string): Promise<string> {
    const payload: Record<string, unknown> = {};
    if (claims.orgId !== undefined) payload.org_id = claims.orgId;
    if (claims.mshipRole !== undefined) payload.mship_role = claims.mshipRole;
    payload.scope = (claims.scopes ?? []).join(' ');
    return new SignJWT(payload)
      .setProtectedHeader({ alg: this.alg, kid: this.kid, typ: ACCESS_TOKEN_TYP })
      .setIssuer(TOKEN_ISSUER)
      .setSubject(claims.userId)
      .setAudience(claims.audience ?? AUDIENCE_API)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .setJti(jti)
      .sign(this.privateKey);
  }
}

/**
 * Build a signer from a PKCS#8 PEM private key + its algorithm. The PUBLIC key for the JWKS is
 * derived from the private key via jose's import (RS256/EdDSA carry the public component).
 * RS256 PKCS#8 is the documented default (RAYSPEC_JWT_SIGNING_KEY).
 */
export async function createSigner(
  pkcs8Pem: string,
  alg: SigningAlg = 'RS256',
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): Promise<TokenSigner> {
  const privateKey = await importPKCS8(pkcs8Pem, alg, { extractable: true });
  // Derive the public JWK from the private key: export the private JWK, strip the private fields.
  const privJwk = (await exportJWK(privateKey)) as Record<string, unknown>;
  const pubJwk: Record<string, unknown> = { ...privJwk };
  // Remove private-key components so the JWKS never exposes private material.
  for (const k of ['d', 'p', 'q', 'dp', 'dq', 'qi']) delete pubJwk[k];
  const kid = await calculateJwkThumbprint(pubJwk as Parameters<typeof calculateJwkThumbprint>[0]);
  pubJwk.kid = kid;
  pubJwk.use = 'sig';
  pubJwk.alg = alg;
  return new TokenSigner(kid, alg, privateKey, pubJwk, ttlSeconds);
}

/**
 * The JWKS view + the verifier. Holds one or more public JWKs (the active signer plus any
 * not-yet-retired rotated keys) and verifies a token's signature against the matching kid, its
 * issuer, audience, exp (with clock tolerance), and the `at+jwt` type.
 */
export class JwksProvider {
  private readonly jwks: { keys: Record<string, unknown>[] };

  constructor(publicJwks: Record<string, unknown>[]) {
    this.jwks = { keys: publicJwks };
  }

  /** The public JWKS document served at GET /v1/oauth/jwks. */
  toJwks(): { keys: Record<string, unknown>[] } {
    return { keys: this.jwks.keys.map((k) => ({ ...k })) };
  }

  /**
   * Verify an access token. Checks signature (by kid → key), issuer, audience, exp (±30s), and
   * the RFC-9068 `typ`. Throws on any failure (caller maps to 401). `expectedAudience` defaults
   * to the control-plane API audience — a token minted for a different aud is rejected here.
   */
  async verify(
    token: string,
    expectedAudience: string = AUDIENCE_API,
  ): Promise<VerifiedAccessToken> {
    const jwkSet = createLocalJWKSet(this.jwks as Parameters<typeof createLocalJWKSet>[0]);
    const { payload } = await jwtVerify(token, jwkSet, {
      issuer: TOKEN_ISSUER,
      audience: expectedAudience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      typ: ACCESS_TOKEN_TYP,
    });
    const scopeClaim = typeof payload.scope === 'string' ? payload.scope : '';
    return {
      userId: typeof payload.sub === 'string' ? payload.sub : '',
      orgId: typeof payload.org_id === 'string' ? payload.org_id : undefined,
      mshipRole: typeof payload.mship_role === 'string' ? payload.mship_role : undefined,
      scopes: scopeClaim.length > 0 ? scopeClaim.split(' ') : [],
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
      audience: expectedAudience,
    };
  }
}
