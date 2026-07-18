/**
 * Org invite routes — the out-of-band invite-token flow (§ external-hardening account-existence closure).
 *
 * - POST /v1/orgs/:orgId/invites  — ISSUE an invite (OWNER-ONLY; org:member:add authz). Creates an
 *   invite for an email + role and returns the opaque token ONCE (the owner conveys it out-of-band).
 *   The issue path NEVER looks up account existence, so its response + timing are IDENTICAL whether or
 *   not the email has an account — closing the account-existence oracle the direct member-add carries.
 *
 * - POST /v1/invites/accept  — REDEEM an invite (the INVITEE acts, not the owner; optional auth). The
 *   org is resolved FROM the token (never a URL). Single-use (an atomic consume gate) + expiry are
 *   enforced. Account existence is resolved HERE, by the invitee:
 *     • the email has NO account  → the invitee provisions it by setting their own `password`, joins,
 *       and is logged in (a fresh session);
 *     • the email HAS an account  → the invitee must be AUTHENTICATED as that account (a token bearer
 *       can never set/reset an existing user's credential), then joins.
 *   Either way the OWNER never learns whether the address was already registered.
 */

import { createHash } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  AcceptInviteRequest,
  type AcceptInviteResponse,
  ApiError,
  forbidden,
  hashPassword,
  IssueInviteRequest,
  type IssueInviteResponse,
  mintInviteToken,
  newJti,
  normalizeEmail,
} from '@rayspec/auth-core';
import { isUniqueViolation } from '@rayspec/db';
import type { AppDeps, AppEnv } from '../app-context.js';
import { readBoundedJson } from '../http/bounded-body.js';
import { clientIpFromContext } from '../http/client-ip.js';
import { refreshCookie } from '../http/cookies.js';
import { requireAuth, requirePermission, resolveTenant } from '../http/middleware.js';
import { SESSION_TTL_MS } from '../services/auth-service.js';
import { requireBearerForMutation } from './orgs.js';

/** Default invite lifetime when the caller does not request one (7 days). */
export const INVITE_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Floor on an invite's requested lifetime (5 minutes) — a sub-minute invite is a footgun. */
export const INVITE_MIN_TTL_SECONDS = 5 * 60;
/** Ceiling on an invite's lifetime (30 days) — bounds the leaked-token blast radius. */
export const INVITE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

export function registerInviteRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // POST /v1/orgs/:orgId/invites — ISSUE (owner-only; live-membership authz via org:member:add, so a
  // stale JWT claim cannot grant it and an api-key principal is rejected — org:member:add is not
  // api-key-grantable). Mirrors the member-add chain exactly.
  app.post(
    '/v1/orgs/:orgId/invites',
    requireAuth(),
    requireBearerForMutation(),
    resolveTenant(deps),
    requirePermission(deps, 'org:member:add'),
    async (c) => {
      const principal = c.get('principal');
      const orgId = c.get('tenantId');
      if (!orgId || !principal?.userId) throw forbidden();
      const body = IssueInviteRequest.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
      let email: string;
      try {
        email = normalizeEmail(body.email);
      } catch {
        throw new ApiError('VALIDATION_ERROR', 'A valid email address is required.');
      }

      const ttl = Math.min(
        Math.max(body.expiresInSeconds ?? INVITE_DEFAULT_TTL_SECONDS, INVITE_MIN_TTL_SECONDS),
        INVITE_MAX_TTL_SECONDS,
      );
      const expiresAt = new Date(Date.now() + ttl * 1000);

      // Mint the opaque token (256-bit) and store ONLY its hash. The plaintext is returned ONCE below.
      // NOTHING here branches on whether `email` has an account (no findUserByEmail), so the response +
      // timing are uniform regardless of account existence — no account-existence oracle.
      const { token, hash } = mintInviteToken();
      const invite = await deps.inviteStore.create(orgId, {
        tokenHash: hash,
        email,
        role: body.role,
        expiresAt,
        createdBy: principal.userId,
      });

      await deps.auditStore.append(
        {
          event: 'org_invite_issued',
          actorUserId: principal.userId,
          actorOrgId: orgId,
          meta: { inviteId: invite.id, role: body.role },
        },
        c.get('requestId'),
      );

      const resp: IssueInviteResponse = {
        inviteToken: token, // shown ONCE
        email,
        role: body.role,
        expiresAt: expiresAt.toISOString(),
      };
      return c.json(resp, 201);
    },
  );

  // POST /v1/invites/accept — REDEEM (the invitee; optional auth). Rate-limited per source IP (the
  // endpoint is unauthenticated + can provision an account). The org is resolved FROM the token.
  app.post('/v1/invites/accept', async (c) => {
    const rid = c.get('requestId');
    const ip = clientIpFromContext(c, deps.trustedProxies ?? []);
    const { allowed, retryAfterMs } = deps.rateLimiter.check('invite-accept', ip);
    if (!allowed) throw new ApiError('RATE_LIMITED', 'Too many requests.', { retryAfterMs });

    const body = AcceptInviteRequest.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));

    // Resolve the token → its invite row (tenant-agnostic; the org is read FROM the token). A uniform
    // generic rejection for an unknown / expired / already-consumed token (no distinguishing oracle).
    const invalid = () =>
      new ApiError('VALIDATION_ERROR', 'This invite is invalid, expired, or already used.');
    const resolved = await deps.inviteStore.resolveByToken(body.token);
    if (!resolved || resolved.consumedAt || resolved.expiresAt.getTime() <= Date.now()) {
      throw invalid();
    }
    const tenantId = resolved.tenantId;
    const role = roleOf(resolved.role);

    const existing = await deps.identityStore.findUserByEmail(resolved.email);

    if (existing) {
      // The email ALREADY has an account → a token bearer must PROVE ownership by being authenticated
      // as that account (never set/reset an existing user's credential from a token alone). We do NOT
      // consume the invite on this failure, so the invitee can sign in and retry. This tells the
      // REDEEMER (who holds a token minted for their OWN email) that the address is registered — not an
      // owner oracle: the redeemer can already learn that via login/register.
      const principal = c.get('principal');
      if (principal?.kind !== 'user' || principal.userId !== existing.id) {
        throw forbidden(
          'This email already has an account. Sign in as that account, then accept the invite.',
        );
      }
      // Atomic single-use gate: exactly one concurrent redeem wins the consume.
      const won = await deps.inviteStore.consume(tenantId, resolved.id);
      if (!won) throw invalid();

      const attach = await deps.orgStore.addInvitedMember(tenantId, existing.id, role);
      const effectiveRole = roleOf(attach.role);
      const accessToken = await deps.signer.mint(
        { userId: existing.id, orgId: tenantId, mshipRole: effectiveRole },
        newJti(),
      );
      await deps.auditStore.append(
        {
          event: 'org_member_add',
          actorUserId: existing.id,
          actorOrgId: tenantId,
          meta: { targetUserId: existing.id, viaInvite: true, activated: attach.activated },
        },
        rid,
      );
      const resp: AcceptInviteResponse = {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: deps.signer.accessTokenTtlSeconds,
        activeOrgId: tenantId,
        userId: existing.id,
        role: effectiveRole,
      };
      return c.json(resp, 200);
    }

    // The email has NO account → the invitee provisions it by setting their OWN initial password, then
    // joins and is logged in. Provision BEFORE the consume so a create failure does not burn the invite.
    if (!body.password) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'A password is required to accept this invite for a new account.',
      );
    }
    let userId: string;
    try {
      const created = await deps.identityStore.createUser(
        resolved.email,
        await hashPassword(body.password),
      );
      userId = created.id;
    } catch (err) {
      // A concurrent register of the SAME email won the users email-unique index between our
      // findUserByEmail miss and this insert. We cannot prove the token bearer owns that just-created
      // account, so fail closed (the invite is NOT consumed) — the invitee signs in and retries.
      if (!isUniqueViolation(err)) throw err;
      throw forbidden(
        'This email already has an account. Sign in as that account, then accept the invite.',
      );
    }

    // Atomic single-use gate. On a lost race the freshly-provisioned account remains a valid login
    // (the invitee set its password); it simply did not get the membership — a benign, rare residual.
    const won = await deps.inviteStore.consume(tenantId, resolved.id);
    if (!won) throw invalid();

    const attach = await deps.orgStore.addInvitedMember(tenantId, userId, role);
    const effectiveRole = roleOf(attach.role);
    const sess = await deps.authService.issueSessionFor(userId, tenantId, effectiveRole, {
      ua: c.req.header('user-agent') ?? null,
      ip,
    });
    await deps.auditStore.appendMany(
      [
        {
          event: 'org_member_add',
          actorUserId: userId,
          actorOrgId: tenantId,
          meta: {
            targetUserId: userId,
            viaInvite: true,
            provisioned: true,
            activated: attach.activated,
          },
        },
        ...sess.audit,
      ],
      rid,
      ipHashOf(ip),
    );

    // Deliver the refresh secret on ONE channel: the JSON body for a gated + opted-in non-browser
    // client (OS-secure storage), else the host-prefixed refresh cookie (browser default).
    const bodyRefresh = deps.bodyRefreshEnabled && body.deliverRefreshTokenInBody === true;
    if (!bodyRefresh) setRefresh(c, sess.refreshSecret);

    const resp: AcceptInviteResponse = {
      accessToken: sess.accessToken,
      tokenType: 'Bearer',
      expiresIn: deps.signer.accessTokenTtlSeconds,
      activeOrgId: tenantId,
      userId,
      role: effectiveRole,
      ...(bodyRefresh ? { refreshToken: sess.refreshSecret } : {}),
    };
    return c.json(resp, 201);
  });
}

// ---- helpers -------------------------------------------------------------------------------

/** Hash the resolved client IP for the audit log ('unknown' ⇒ no hash), mirroring auth.ts. */
function ipHashOf(ip: string): string | null {
  return ip === 'unknown' ? null : createHash('sha256').update(ip).digest('hex');
}

// biome-ignore lint/suspicious/noExplicitAny: Hono context typing varies per route registration.
function setRefresh(c: any, secret: string): void {
  c.header('Set-Cookie', refreshCookie(secret, SESSION_TTL_SECONDS), { append: true });
}

function roleOf(role: string): 'owner' | 'admin' | 'member' {
  return role === 'owner' || role === 'admin' ? role : 'member';
}
