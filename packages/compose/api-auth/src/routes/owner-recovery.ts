/**
 * Owner recovery — POST /v1/auth/owner-recovery.
 *
 * The owner of an organization who holds no password (their only credential was an API key, which
 * a new API-key pepper breaks) redeems the one-time token the operator issued with `rayspec tenant
 * recover-owner`, sets a password and is signed in. The token is the whole credential, so the route
 * is unauthenticated and rate-limited per source, like an invite accept.
 *
 * Every token that does not redeem — unknown, expired, already used, replaced by a newer one, or
 * issued for an account that is no longer an active owner without a password — gets the same 400,
 * so the route is no oracle for any of those states. A redeemed token never redeems again. The
 * redemption is audited (`owner_recovery_redeemed`, then the `login` of the new session); the token
 * itself is never logged, and only its HMAC was ever stored.
 */

import { createHash } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ApiError,
  hashPassword,
  OwnerRecoveryRequest,
  type OwnerRecoveryResponse,
} from '@rayspec/auth-core';
import type { AppDeps, AppEnv } from '../app-context.js';
import { readBoundedJson } from '../http/bounded-body.js';
import { clientIpFromContext } from '../http/client-ip.js';
import { refreshCookie } from '../http/cookies.js';
import { SESSION_TTL_MS } from '../services/auth-service.js';

const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

export function registerOwnerRecoveryRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.post('/v1/auth/owner-recovery', async (c) => {
    const rid = c.get('requestId');
    const ip = clientIpFromContext(c, deps.trustedProxies ?? []);
    const { allowed, retryAfterMs } = await deps.rateLimiter.checkAsync('owner-recovery', ip);
    if (!allowed) throw new ApiError('RATE_LIMITED', 'Too many requests.', { retryAfterMs });

    const body = OwnerRecoveryRequest.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
    // The password is hashed before the token is looked at, so a token that redeems and one that
    // does not cost the same work.
    const passwordHash = await hashPassword(body.password);
    const redeemed = await deps.ownerRecoveryStore.redeem(body.token, passwordHash);
    if (redeemed === undefined) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'This recovery token is invalid, expired, or already used.',
      );
    }
    const session = await deps.authService.issueSessionFor(
      redeemed.userId,
      redeemed.orgId,
      'owner',
      { ua: c.req.header('user-agent') ?? null, ip },
    );
    await deps.auditStore.appendMany(
      [...redeemed.audit, ...session.audit],
      rid,
      ip === 'unknown' ? null : createHash('sha256').update(ip).digest('hex'),
    );

    // The refresh secret on one channel: the body for a gated, opted-in non-browser client, else the
    // host-prefixed refresh cookie.
    const bodyRefresh = deps.bodyRefreshEnabled && body.deliverRefreshTokenInBody === true;
    if (!bodyRefresh) {
      c.header('Set-Cookie', refreshCookie(session.refreshSecret, SESSION_TTL_SECONDS), {
        append: true,
      });
    }
    const resp: OwnerRecoveryResponse = {
      accessToken: session.accessToken,
      tokenType: 'Bearer',
      expiresIn: deps.signer.accessTokenTtlSeconds,
      activeOrgId: redeemed.orgId,
      userId: redeemed.userId,
      role: 'owner',
      ...(bodyRefresh ? { refreshToken: session.refreshSecret } : {}),
    };
    return c.json(resp, 200);
  });
}
