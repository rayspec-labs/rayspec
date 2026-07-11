/**
 * The media-token signer/verifier — the SECOND auth path.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A SEPARATE KEY + ALGORITHM (the load-bearing security contract).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A media token authorizes a streaming READ of a single blob via a `?token=` query param (so a
 * native player / a plain <audio src> can stream without an Authorization header on every Range
 * request). It is a SECOND auth path that does NOT traverse `resolveTenant` — so it MUST be
 * cryptographically + algorithmically DISJOINT from the RS256 API/JWKS chain:
 *
 *   - DISTINCT SECRET. A media token is HS256, signed with `RAYSPEC_MEDIA_SIGNING_KEY` — a symmetric
 *     secret SEPARATE from the RS256 PKCS#8 PEM (`RAYSPEC_JWT_SIGNING_KEY`) the API/OIDC chain uses.
 *     A leaked media URL/token therefore grants NOTHING on the API surface, and a leaked API token
 *     authorizes NOTHING on the playback route (the two key chains never overlap).
 *   - ALG PINNED. The verifier pins `algorithms: ['HS256']`. `jose.jwtVerify` then REJECTS, before any
 *     application logic runs: an `alg:none` token, an RS256-signed token (the classic alg-confusion —
 *     an attacker re-signing/forging with the PUBLIC RS key and hoping we verify it with the HS
 *     secret-as-HMAC-key), and any token whose alg is not exactly HS256. We ALSO never hand the RS
 *     verification key to this verifier — the only key it knows is the HS media secret.
 *
 * THE CLAIM IS NOT TRUSTED ALONE. The token carries `tenantId` + an OPAQUE `resource` reference (the
 * blob the bearer may read). The verifier authenticates the token (signature + alg + exp) and surfaces
 * those claims, but the PLAYBACK HANDLER MUST still re-validate the requested resource's ACTUAL owning
 * tenant against the DB (through the tenant-bound `init.db`) before serving a single byte — it must
 * NEVER serve off the self-asserted `tenantId` claim alone. (This module owns only token integrity; the
 * ownership re-check is the handler's job — see the stream-backend playback handler.)
 *
 * REUSE ACROSS RANGE REQUESTS (the jti model — deliberate). A media token is REUSED across the many
 * Range requests of one streaming playback, so it is NOT single-use: the verifier does NOT reject a
 * token merely because its `jti` was seen before. "Replay" defense is the `exp` check (a short TTL,
 * scaled to the recording duration, bounds the window) PLUS an OPTIONAL in-process revocation DENYLIST
 * keyed by `jti` (a mint route / an admin path may add a jti to revoke a token before its exp). The
 * `jti` is also the audit correlation id. (A single-use model would BREAK streaming — the second Range
 * request of the same playback would 401; that is why this is exp + optional-denylist, not consume-once.)
 *
 * PRODUCT-AGNOSTIC: `resource` is an OPAQUE string (the platform never parses it — the pack chose it as
 * the blob key it minted for). Zero media/audio vocabulary lives here; this is a generic
 * "short-lived, tenant-scoped, resource-bound, distinct-key bearer token" mechanism.
 */

import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';

/** The fixed media-token algorithm — pinned on BOTH sign and verify. Never widened (alg-confusion). */
const MEDIA_ALG = 'HS256' as const;

/** A media-token issuer/audience pin — a defense-in-depth claim the verifier also checks. */
const MEDIA_ISSUER = 'rayspec-media';
const MEDIA_AUDIENCE = 'rayspec-media-playback';

/** Verified, trusted-AFTER-signature media-token claims surfaced to the route middleware. */
export interface MediaTokenClaims {
  /** The token's asserted tenant (org) id. DATA — the handler RE-VALIDATES resource ownership in the DB. */
  readonly tenantId: string;
  /** The OPAQUE resource reference the bearer may read (the pack's blob key). Never parsed by core. */
  readonly resource: string;
  /** The token id (audit + the optional revocation denylist key). */
  readonly jti: string;
  /** The id of the principal (user) the token was minted FOR — surfaced for the per-user semaphore. */
  readonly sub: string;
}

/** The outcome of a media-token verification — a typed discriminated result (never leaks a reason). */
export type MediaVerifyResult =
  | { readonly ok: true; readonly claims: MediaTokenClaims }
  | { readonly ok: false; readonly reason: MediaVerifyFailure };

/** WHY a verify failed — for an out-of-band log only; the route returns a UNIFORM generic denial. */
export type MediaVerifyFailure =
  | 'malformed' // not a compact JWS / missing/blank required claims
  | 'bad_signature' // signature did not verify under the media secret
  | 'alg_rejected' // alg was not exactly HS256 (none / RS256 / other) — alg-confusion blocked
  | 'expired' // exp in the past (or nbf in the future)
  | 'revoked'; // jti is on the in-process denylist

/**
 * An OPTIONAL in-process media-token revocation denylist (per-node). A `jti` added here is rejected by
 * `verify` even before its `exp`. This is the in-process, best-effort revocation channel the
 * security contract documents; it is NOT a distributed store (a multi-node deploy would need a shared
 * denylist — a future concern, like the per-user semaphore's per-node note).
 */
export interface MediaTokenDenylist {
  /** True if this jti has been revoked (must be rejected). */
  has(jti: string): boolean;
  /** Revoke a jti (a mint/admin path may call this). */
  add(jti: string): void;
}

/** A trivial in-process Set-backed denylist (the default; per-node, best-effort). */
export function createMediaDenylist(): MediaTokenDenylist {
  const revoked = new Set<string>();
  return {
    has: (jti) => revoked.has(jti),
    add: (jti) => {
      revoked.add(jti);
    },
  };
}

/**
 * The media-token signer/verifier, built ONCE at the composition root from the HS256 media secret. The
 * `key` is the raw `RAYSPEC_MEDIA_SIGNING_KEY` bytes (utf8) — DISTINCT from the RS256 PEM. A handle is
 * SERIALIZABLE-shaped to call (string in, string/typed-result out) so it is isolate-friendly.
 */
export interface MediaTokenService {
  /**
   * Mint a short-lived HS256 token authorizing `sub` (a user) to read `resource` for `tenantId`.
   * `ttlSeconds` is the hard expiry window (the caller scales it to the recording duration). Returns
   * the compact JWS string the caller embeds as `?token=`. A fresh random `jti` is minted per call.
   */
  mint(args: {
    tenantId: string;
    resource: string;
    sub: string;
    ttlSeconds: number;
  }): Promise<string>;
  /**
   * Verify a `?token=` string: pins alg=HS256 (rejecting none/RS256/other), checks the signature under
   * the media secret, checks exp/iss/aud, and consults the optional denylist. Returns a typed result —
   * a failure is a reason discriminant the route maps to a UNIFORM generic denial (no enumeration leak).
   */
  verify(token: string): Promise<MediaVerifyResult>;
  /** The shared denylist (a mint/admin path may revoke a jti through it). */
  readonly denylist: MediaTokenDenylist;
}

/** The minimum length of the media secret (a short secret weakens HS256 — fail closed at boot). */
export const MIN_MEDIA_SECRET_BYTES = 32;

/**
 * The platform CEILING on a media token's TTL, clamped in `mint` at the trust boundary. A media token
 * is a bearer credential delivered in a URL `?token=` — a longer-lived one is a larger leaked-URL blast
 * radius — so the platform bounds it regardless of what a (trusted-author) handler/pack requests. 24h is
 * generous for streaming even a long recording end-to-end while keeping the bearer window finite (a
 * caller wanting indefinite access re-mints; the per-Range reuse model means one mint covers a whole
 * playback session). This is a CEILING; the `mint` chain still applies a 1s FLOOR (`Math.max(1, …)`).
 */
export const MEDIA_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60;

/**
 * Build the media-token service from the raw `RAYSPEC_MEDIA_SIGNING_KEY` (utf8). Fail-closed on a
 * missing/too-short secret (a weak HMAC key undermines the whole second auth path). The denylist is
 * in-process (per-node); pass one in to share it with a mint route, else a fresh one is created.
 */
export function createMediaTokenService(
  rawSecret: string,
  denylist: MediaTokenDenylist = createMediaDenylist(),
): MediaTokenService {
  if (
    typeof rawSecret !== 'string' ||
    Buffer.byteLength(rawSecret, 'utf8') < MIN_MEDIA_SECRET_BYTES
  ) {
    throw new Error(
      `createMediaTokenService: RAYSPEC_MEDIA_SIGNING_KEY must be at least ${MIN_MEDIA_SECRET_BYTES} ` +
        'bytes (a short HMAC secret weakens HS256). Fail-closed.',
    );
  }
  // The HS256 key — the distinct media secret, NEVER the RS256 PEM. Encoded once.
  const key = new TextEncoder().encode(rawSecret);

  return {
    denylist,
    async mint({ tenantId, resource, sub, ttlSeconds }): Promise<string> {
      // crypto.randomUUID gives a high-entropy jti (audit + the optional denylist key).
      const jti = crypto.randomUUID();
      // Clamp the TTL at the platform trust boundary: a 1s FLOOR and the MEDIA_TOKEN_MAX_TTL_SECONDS
      // CEILING. Done HERE (not at a single caller) so EVERY mint path — incl. the route-handlers mint
      // closure a trusted-author handler drives — is bounded; a handler/pack cannot mint an
      // arbitrarily long-lived bearer token.
      const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), MEDIA_TOKEN_MAX_TTL_SECONDS);
      return new SignJWT({ tenantId, resource, sub })
        .setProtectedHeader({ alg: MEDIA_ALG, typ: 'JWT' })
        .setIssuer(MEDIA_ISSUER)
        .setAudience(MEDIA_AUDIENCE)
        .setJti(jti)
        .setIssuedAt()
        .setExpirationTime(`${ttl}s`)
        .sign(key);
    },
    async verify(token: string): Promise<MediaVerifyResult> {
      if (typeof token !== 'string' || token.length === 0) {
        return { ok: false, reason: 'malformed' };
      }
      let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
      try {
        // ALG PINNED HERE: `algorithms: ['HS256']` makes jose REJECT a none/RS256/other-alg token
        // BEFORE the signature step (ERR_JOSE_ALG_NOT_ALLOWED) — the alg-confusion block. The key is
        // the media HS secret; an RS256 token can NEVER verify against it even if the pin were absent.
        // iss/aud are pinned too (a token minted for a different audience is rejected). `requiredClaims:
        // ['exp']` makes jose REJECT a (correctly-signed) token that carries NO exp — `mint` always sets
        // one, so an exp-less token is malformed/forged-shaped and must not be treated as never-expiring.
        ({ payload } = await jwtVerify(token, key, {
          algorithms: [MEDIA_ALG],
          issuer: MEDIA_ISSUER,
          audience: MEDIA_AUDIENCE,
          requiredClaims: ['exp'],
        }));
      } catch (err) {
        // Map jose's typed errors to a coarse reason (logged out-of-band; the route denial is uniform).
        if (err instanceof joseErrors.JOSEAlgNotAllowed)
          return { ok: false, reason: 'alg_rejected' };
        if (err instanceof joseErrors.JWTExpired) return { ok: false, reason: 'expired' };
        if (err instanceof joseErrors.JWTClaimValidationFailed) {
          // A future-dated nbf surfaces here too; treat a claim/time failure as expired-class (denied).
          return { ok: false, reason: 'expired' };
        }
        if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
          return { ok: false, reason: 'bad_signature' };
        }
        // A malformed compact JWS (wrong segment count, bad base64) lands here — treat as malformed.
        return { ok: false, reason: 'malformed' };
      }
      // Signature + alg + exp + iss/aud all passed. Validate the required claim SHAPE (all strings,
      // non-empty) — a token missing tenantId/resource/jti/sub is malformed (never a partial grant).
      const tenantId = payload.tenantId;
      const resource = payload.resource;
      const jti = payload.jti;
      const sub = payload.sub;
      if (
        typeof tenantId !== 'string' ||
        tenantId.length === 0 ||
        typeof resource !== 'string' ||
        resource.length === 0 ||
        typeof jti !== 'string' ||
        jti.length === 0 ||
        typeof sub !== 'string' ||
        sub.length === 0
      ) {
        return { ok: false, reason: 'malformed' };
      }
      // The optional in-process revocation denylist (checked AFTER signature — a forged jti never
      // reaches here). A revoked jti is denied even before its exp.
      if (denylist.has(jti)) return { ok: false, reason: 'revoked' };
      return { ok: true, claims: { tenantId, resource, jti, sub } };
    },
  };
}
