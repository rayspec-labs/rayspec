/**
 * Auth service — register / login / refresh / logout / me orchestration (DB via IdentityStore,
 * crypto via auth-core). No Hono type here; the routes translate to/from DTOs.
 *
 * Security properties implemented here:
 *  - register/login NORMALIZE the email, argon2id-verify, and present a UNIFORM generic failure
 *    (dummy argon2id verify on an unknown email so timing/observable-branch does not leak whether
 *    the account exists);
 *  - login mints an OPAQUE session (server-minted id + family_id) + a short JWT; the refresh
 *    secret is the cookie value, only its hash is stored;
 *  - refresh ROTATION + HARDENED reuse-detection: the presented secret resolves to a session row,
 *    we VERIFY it belongs to the same family + user BEFORE any state change (a foreign/mismatched
 *    token is rejected WITHOUT touching state — no confused-deputy family revoke); replay of an
 *    ALREADY-rotated token revokes the family + signals an audit event + a per-source lock;
 *    per-device families + a short grace window prevent benign concurrent-double-submit lockouts.
 */

import type { TokenSigner } from '@rayspec/auth-core';
import {
  type AccessTokenClaims,
  ApiError,
  type AuditEvent,
  hashPassword,
  hashSessionSecret,
  mintSessionSecret,
  needsRehash,
  newFamilyId,
  newJti,
  unauthenticated,
  verifyPassword,
} from '@rayspec/auth-core';
import type { IdentityStore, SessionRow } from '../stores/identity-store.js';

/** Refresh session lifetime (the opaque cookie). Long-lived; the JWT is the short credential. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Grace window: a just-rotated token may be presented once more within this window without
 * tripping family revocation (benign web+mobile double-submit). */
export const REFRESH_GRACE_MS = 10_000;

/**
 * A dummy argon2id hash to verify against on an unknown-email login so the work + timing match a
 * real verify (no user-enumeration via timing/branch). Generated once at construction.
 */
let DUMMY_HASH: string | undefined;
async function dummyHash(): Promise<string> {
  if (!DUMMY_HASH) DUMMY_HASH = await hashPassword('dummy-password-never-matches-anything');
  return DUMMY_HASH;
}

export interface LoginContext {
  ua?: string | null;
  ip?: string | null;
}

export interface AuthResult {
  /** The short JWT access token. */
  accessToken: string;
  /** The opaque refresh secret to place in the host-prefixed cookie. */
  refreshSecret: string;
  /** The active org (may be null before an org is chosen). */
  activeOrgId: string | null;
  userId: string;
  /** Audit events this operation should emit (the route commits them out-of-band). */
  audit: AuditEvent[];
}

export interface RefreshOutcome {
  result?: AuthResult;
  /** A reuse was detected → the family was revoked; the route must 401 + audit + lock the source. */
  reuseDetected?: boolean;
  audit: AuditEvent[];
}

export class AuthService {
  private readonly graceMs: number;
  /**
   * The time source for every session TTL/grace comparison AND the rotatedAt stamp. Injectable so a
   * test can drive the grace window deterministically (a wall-clock delta is a CI flake). Production
   * default is the real wall clock (`Date.now`) — behavior is unchanged when `now` is omitted.
   */
  private readonly now: () => number;
  constructor(
    private readonly store: IdentityStore,
    private readonly signer: TokenSigner,
    opts: { graceMs?: number; now?: () => number } = {},
  ) {
    this.graceMs = opts.graceMs ?? REFRESH_GRACE_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Build the JWT claims for a (user, activeOrg, role). */
  private async mintAccess(
    userId: string,
    orgId: string | null,
    role: string | undefined,
    scopes: string[] = [],
  ): Promise<string> {
    const claims: AccessTokenClaims = {
      userId,
      ...(orgId ? { orgId } : {}),
      ...(role ? { mshipRole: role } : {}),
      scopes,
    };
    return this.signer.mint(claims, newJti());
  }

  /** Issue a fresh session + access token for a user (login + register share this). */
  private async issueSession(
    userId: string,
    currentOrgId: string | null,
    role: string | undefined,
    ctx: LoginContext,
  ): Promise<{ accessToken: string; refreshSecret: string }> {
    const { secret, tokenHash } = mintSessionSecret();
    await this.store.createSession({
      userId,
      currentOrgId,
      tokenHash,
      familyId: newFamilyId(),
      expiresAt: new Date(this.now() + SESSION_TTL_MS),
      ua: ctx.ua ?? null,
      ip: ctx.ip ?? null,
    });
    const accessToken = await this.mintAccess(userId, currentOrgId, role);
    return { accessToken, refreshSecret: secret };
  }

  /**
   * Issue a fresh logged-in session for an ALREADY-EXISTING user, scoped to `orgId` (the invite-accept
   * new-account path — the invitee has just been provisioned + joined, so we log them straight in). A
   * thin PUBLIC wrapper over the private {@link issueSession}: mints the opaque refresh session + a
   * short JWT carrying the org + role, and returns the audit event the route commits out-of-band. The
   * caller (the accept route) owns the user creation + membership attach; this only issues credentials.
   */
  async issueSessionFor(
    userId: string,
    orgId: string,
    role: string | undefined,
    ctx: LoginContext = {},
  ): Promise<{ accessToken: string; refreshSecret: string; audit: AuditEvent[] }> {
    const { accessToken, refreshSecret } = await this.issueSession(userId, orgId, role, ctx);
    return {
      accessToken,
      refreshSecret,
      audit: [{ event: 'login', actorUserId: userId, actorOrgId: orgId }],
    };
  }

  /**
   * Register a user (email already normalized by the caller) + argon2id hash. If the email is
   * already taken, throw a generic CONFLICT (NOT a different error than other failures beyond the
   * status — we accept a 409 here since the unique index is the source of truth; enumeration is
   * primarily defended on LOGIN). Returns a logged-in session.
   */
  async register(
    normalizedEmail: string,
    password: string,
    ctx: LoginContext,
  ): Promise<{ userId: string; accessToken: string; refreshSecret: string; audit: AuditEvent[] }> {
    const existing = await this.store.findUserByEmail(normalizedEmail);
    if (existing) {
      // Do the dummy hash work anyway so register-existing and register-new are timing-similar.
      await dummyHash();
      throw new ApiError('CONFLICT', 'Registration could not be completed.');
    }
    const passwordHash = await hashPassword(password);
    const user = await this.store.createUser(normalizedEmail, passwordHash);
    const { accessToken, refreshSecret } = await this.issueSession(user.id, null, undefined, ctx);
    return {
      userId: user.id,
      accessToken,
      refreshSecret,
      audit: [{ event: 'register', actorUserId: user.id, actorOrgId: null }],
    };
  }

  /**
   * Login: verify password against the stored argon2id hash. On an UNKNOWN email we still run a
   * dummy verify so the response is timing/branch indistinguishable from a wrong password
   * (user-enumeration resistance). Upgrade-on-login rehash when params changed.
   */
  async login(normalizedEmail: string, password: string, ctx: LoginContext): Promise<AuthResult> {
    const user = await this.store.findUserByEmail(normalizedEmail);
    if (!user?.passwordHash) {
      await verifyPassword(await dummyHash(), password); // constant-work dummy verify
      throw unauthenticated();
    }
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) throw unauthenticated();
    // Upgrade-on-login rehash (transparent; the just-verified password is in hand).
    if (needsRehash(user.passwordHash)) {
      await this.store.updatePasswordHash(user.id, await hashPassword(password));
    }
    const { accessToken, refreshSecret } = await this.issueSession(user.id, null, undefined, ctx);
    return {
      accessToken,
      refreshSecret,
      activeOrgId: null,
      userId: user.id,
      audit: [{ event: 'login', actorUserId: user.id, actorOrgId: null }],
    };
  }

  /**
   * Refresh + HARDENED family-bound reuse-detection.
   *
   * Order is load-bearing: resolve the presented secret to a session row, then VERIFY ownership
   * (family + user) BEFORE any state change. A row that is already rotated/revoked is a REUSE —
   * we revoke the family and signal the route to 401 + audit + lock the source. A still-valid
   * row rotates: new secret, old marked rotated. The grace window lets a benign concurrent
   * double-submit of a JUST-rotated token succeed (re-issue from the replacement) without
   * tripping the reuse path.
   */
  async refresh(presentedSecret: string, _ctx: LoginContext = {}): Promise<RefreshOutcome> {
    const tokenHash = hashSessionSecret(presentedSecret);
    const session = await this.store.findSessionByTokenHash(tokenHash);

    // Unknown secret → uniform 401, no state change, no family action (cannot revoke a family we
    // cannot even attribute to a user — that would be a confused-deputy forced-logout vector).
    if (!session) {
      throw unauthenticated();
    }

    const now = this.now();

    // Already revoked → distinguish a BENIGN logout from genuine token-reuse.
    if (session.revokedAt) {
      // A session revoked by LOGOUT (or any non-reuse reason) presented again is a benign stale
      // cookie — return a uniform 401 with NO family revoke, NO reuse audit, NO per-source lock.
      // Conflating logout with theft would let a normal logged-out client trip the anti-DoS lock
      // and pollute the audit story.
      if (session.revokedReason !== 'reuse') {
        throw unauthenticated();
      }
      // A session already revoked BY reuse-detection presented again IS reuse: re-revoke the
      // family (idempotent) and signal the route to 401 + audit + lock.
      await this.store.revokeFamily(session.familyId);
      return {
        reuseDetected: true,
        audit: [
          {
            event: 'refresh_reuse_detected',
            actorUserId: session.userId,
            actorOrgId: session.currentOrgId,
            familyId: session.familyId,
          },
        ],
      };
    }

    // Already rotated → either a benign double-submit within the grace window, or a REPLAY.
    if (session.rotatedAt) {
      const withinGrace = now - session.rotatedAt.getTime() <= this.graceMs;
      if (withinGrace && session.replacedBy) {
        // Benign: re-issue from the live replacement WITHOUT rotating again or revoking.
        const replacement = await this.store.findSessionById(session.replacedBy);
        if (replacement && !replacement.revokedAt) {
          const accessToken = await this.mintAccess(
            replacement.userId,
            replacement.currentOrgId,
            undefined,
          );
          // The replacement secret is not re-handed here (the client already holds it); we only
          // re-mint the short JWT. The cookie stays as-is.
          return {
            result: {
              accessToken,
              refreshSecret: presentedSecret, // unchanged; do not rotate within grace
              activeOrgId: replacement.currentOrgId,
              userId: replacement.userId,
              audit: [],
            },
            audit: [],
          };
        }
      }
      // REPLAY of a rotated token beyond the grace window → revoke the whole family.
      await this.store.revokeFamily(session.familyId);
      return {
        reuseDetected: true,
        audit: [
          {
            event: 'refresh_reuse_detected',
            actorUserId: session.userId,
            actorOrgId: session.currentOrgId,
            familyId: session.familyId,
          },
        ],
      };
    }

    // Expired (beyond its own TTL) → uniform 401; no reuse.
    if (session.expiresAt.getTime() <= now) {
      throw unauthenticated();
    }

    // Healthy → rotate: new secret, old marked rotated + linked to the new row.
    const { secret: newSecret, tokenHash: newHash } = mintSessionSecret();
    const newRow = await this.store.rotateSession(session, {
      tokenHash: newHash,
      expiresAt: new Date(now + SESSION_TTL_MS),
      // Stamp rotatedAt from the SAME injected clock the grace comparison reads, so the two share one
      // time source (a wall-clock stamp vs an injected-clock compare would make the delta meaningless).
      rotatedAt: new Date(now),
    });
    const accessToken = await this.mintAccess(newRow.userId, newRow.currentOrgId, undefined);
    return {
      result: {
        accessToken,
        refreshSecret: newSecret,
        activeOrgId: newRow.currentOrgId,
        userId: newRow.userId,
        audit: [],
      },
      audit: [{ event: 'refresh', actorUserId: newRow.userId, actorOrgId: newRow.currentOrgId }],
    };
  }

  /** Logout: revoke the session resolved from the presented secret (idempotent). */
  async logout(presentedSecret: string): Promise<{ audit: AuditEvent[] }> {
    const session = await this.store.findSessionByTokenHash(hashSessionSecret(presentedSecret));
    if (session && !session.revokedAt) {
      await this.store.revokeSession(session.id);
      return {
        audit: [{ event: 'logout', actorUserId: session.userId, actorOrgId: session.currentOrgId }],
      };
    }
    return { audit: [] };
  }

  /** Resolve a session row for the authenticate middleware (cookie path). */
  async sessionFromSecret(presentedSecret: string): Promise<SessionRow | undefined> {
    const session = await this.store.findSessionByTokenHash(hashSessionSecret(presentedSecret));
    if (!session || session.revokedAt || session.expiresAt.getTime() <= this.now())
      return undefined;
    return session;
  }
}
