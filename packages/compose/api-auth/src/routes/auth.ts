/**
 * Auth routes: register / login / refresh / logout / me.
 *
 * CSRF model: cookie-authenticated endpoints (refresh, logout) enforce the
 * Origin/Sec-Fetch-Site allowlist; mutating endpoints require a Bearer token (a cross-site form
 * cannot set it). Rate limiting on login/register/refresh. Uniform generic 401 + dummy argon2id
 * on unknown email (the service handles the dummy work). Audit events are committed OUT-OF-BAND.
 */

import { createHash } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ApiError,
  LoginRequest,
  type MeResponse,
  normalizeEmail,
  RefreshRequest,
  RegisterRequest,
  type TokenResponse,
} from '@rayspec/auth-core';
import type { Context } from 'hono';
import type { AppDeps, AppEnv } from '../app-context.js';
import { readBoundedRequestBytes } from '../http/bounded-body.js';
import { clientIpFromContext } from '../http/client-ip.js';
import {
  clearRefreshCookie,
  isCsrfSafeForCookieEndpoint,
  readRefreshCookie,
  refreshCookie,
} from '../http/cookies.js';
import { requireAuth } from '../http/middleware.js';
import { SESSION_TTL_MS } from '../services/auth-service.js';

const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

/** Hash the RESOLVED client IP for the audit log (no raw IP stored; 'unknown' ⇒ no hash). */
function ipHashOf(c: Context<AppEnv>, deps: AppDeps): string | null {
  const ip = clientIp(c, deps);
  return ip === 'unknown' ? null : createHash('sha256').update(ip).digest('hex');
}

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // POST /v1/auth/register
  app.post('/v1/auth/register', async (c) => {
    const rid = c.get('requestId');
    const ip = clientIp(c, deps);
    enforceRate(deps, 'register', ip);
    // Drain the body under the configured byte cap (413 for an over-cap body BEFORE any work), then
    // parse exactly as before (a malformed body still throws through to the error envelope).
    const rawBody = await readBoundedRequestBytes(c, deps.maxJsonBodyBytes);
    const body = RegisterRequest.parse(JSON.parse(new TextDecoder().decode(rawBody)));
    const email = normalizeEmail(body.email);
    const reg = await deps.authService.register(email, body.password, {
      ua: c.req.header('user-agent') ?? null,
      ip,
    });
    // Optional auto-create org + owner membership.
    let activeOrgId: string | null = null;
    if (body.orgName) {
      const slug = await deps.orgStore.deriveUniqueSlug(body.orgName);
      const org = await deps.orgStore.createOrgWithOwner({
        name: body.orgName,
        slug,
        ownerUserId: reg.userId,
      });
      activeOrgId = org.id;
      reg.audit.push({ event: 'org_create', actorUserId: reg.userId, actorOrgId: org.id });
    }
    await deps.auditStore.appendMany(reg.audit, rid, ipHashOf(c, deps));
    const refreshToken = deliverRefresh(c, deps, reg.refreshSecret, body.deliverRefreshTokenInBody);
    return c.json(
      tokenResponse(reg.accessToken, activeOrgId, deps.signer.accessTokenTtlSeconds, refreshToken),
      201,
    );
  });

  // POST /v1/auth/login
  app.post('/v1/auth/login', async (c) => {
    const rid = c.get('requestId');
    const ip = clientIp(c, deps);
    enforceRate(deps, 'login', ip);
    // Drain the body under the configured byte cap (413 for an over-cap body BEFORE any work), then
    // parse exactly as before (a malformed body still throws through to the error envelope).
    const rawBody = await readBoundedRequestBytes(c, deps.maxJsonBodyBytes);
    const body = LoginRequest.parse(JSON.parse(new TextDecoder().decode(rawBody)));
    const email = normalizeEmail(body.email);
    const result = await deps.authService.login(email, body.password, {
      ua: c.req.header('user-agent') ?? null,
      ip,
    });
    deps.rateLimiter.reset('login', ip); // a clean login resets the counter
    await deps.auditStore.appendMany(result.audit, rid, ipHashOf(c, deps));
    const refreshToken = deliverRefresh(
      c,
      deps,
      result.refreshSecret,
      body.deliverRefreshTokenInBody,
    );
    return c.json(
      tokenResponse(
        result.accessToken,
        result.activeOrgId,
        deps.signer.accessTokenTtlSeconds,
        refreshToken,
      ),
      200,
    );
  });

  // POST /v1/auth/refresh — cookie (Origin/Sec-Fetch-Site checked) OR body (desktop/CLI).
  app.post('/v1/auth/refresh', async (c) => {
    const rid = c.get('requestId');
    const ip = clientIp(c, deps);
    enforceRate(deps, 'refresh', ip);

    const cookieSecret = readRefreshCookie(c.req.header('cookie'));
    const body = RefreshRequest.parse(await safeJson(c));
    const bodySecret = body.refreshToken;

    // If the secret came from the COOKIE, enforce CSRF (Origin/Sec-Fetch-Site). A body secret is
    // a non-browser/desktop client (no ambient cookies) and is not subject to ambient CSRF.
    if (cookieSecret && !bodySecret) {
      const safe = isCsrfSafeForCookieEndpoint(
        { origin: c.req.header('origin'), secFetchSite: c.req.header('sec-fetch-site') },
        deps.allowedOrigins,
      );
      if (!safe) throw new ApiError('FORBIDDEN', 'Cross-site request rejected.');
    }
    const secret = bodySecret ?? cookieSecret;
    if (!secret) throw new ApiError('UNAUTHENTICATED', 'Authentication failed.');

    const outcome = await deps.authService.refresh(secret, {
      ua: c.req.header('user-agent') ?? null,
      ip,
    });
    if (outcome.reuseDetected) {
      // Reuse → family revoked; audit out-of-band + per-source lock (anti-DoS) + uniform 401.
      await deps.auditStore.appendMany(outcome.audit, rid, ipHashOf(c, deps));
      deps.rateLimiter.lockSource('refresh', ip);
      clearRefresh(c);
      throw new ApiError('UNAUTHENTICATED', 'Authentication failed.');
    }
    const result = outcome.result;
    if (!result) throw new ApiError('UNAUTHENTICATED', 'Authentication failed.');
    await deps.auditStore.appendMany(outcome.audit, rid, ipHashOf(c, deps));
    // Rotate the secret (changed unless we re-issued within the grace window). Deliver on ONE
    // channel: the body for a gated+opted-in non-browser client, else the rotated cookie as today.
    // BL-1: body-deliver ONLY when the presented secret was BODY-SOURCED. A cookie-sourced refresh
    // (the browser flow — the httpOnly cookie auto-attaches) must keep the rotated secret on the
    // httpOnly cookie; never convert an ambient httpOnly cookie into a JS-readable body secret (else
    // a browser XSS that forges the opt-in flag could exfiltrate it + desync the stale cookie).
    const optInBodyRefresh = body.deliverRefreshTokenInBody === true && bodySecret !== undefined;
    const refreshToken = deliverRefresh(c, deps, result.refreshSecret, optInBodyRefresh);
    return c.json(
      tokenResponse(
        result.accessToken,
        result.activeOrgId,
        deps.signer.accessTokenTtlSeconds,
        refreshToken,
      ),
      200,
    );
  });

  // POST /v1/auth/logout — cookie/session (Origin checked).
  app.post('/v1/auth/logout', async (c) => {
    const rid = c.get('requestId');
    const secret = readRefreshCookie(c.req.header('cookie'));
    if (secret) {
      const safe = isCsrfSafeForCookieEndpoint(
        { origin: c.req.header('origin'), secFetchSite: c.req.header('sec-fetch-site') },
        deps.allowedOrigins,
      );
      if (!safe) throw new ApiError('FORBIDDEN', 'Cross-site request rejected.');
      const out = await deps.authService.logout(secret);
      await deps.auditStore.appendMany(out.audit, rid, ipHashOf(c, deps));
    }
    clearRefresh(c);
    return c.body(null, 204);
  });

  // GET /v1/auth/me — Bearer JWT or cookie session.
  app.get('/v1/auth/me', requireAuth(), async (c) => {
    const principal = c.get('principal');
    if (!principal?.userId) throw new ApiError('UNAUTHENTICATED', 'Authentication failed.');
    const user = await deps.identityStore.findUserById(principal.userId);
    if (!user) throw new ApiError('UNAUTHENTICATED', 'Authentication failed.');
    const memberships = await deps.identityStore.membershipsForUser(user.id);
    const me: MeResponse = {
      userId: user.id,
      email: user.email,
      emailVerified: user.emailVerifiedAt != null,
      memberships: memberships.map((m) => ({ orgId: m.orgId, role: roleOf(m.role) })),
      activeOrgId: principal.orgId ?? null,
    };
    return c.json(me, 200);
  });
}

// ---- helpers -------------------------------------------------------------------------------

function tokenResponse(
  accessToken: string,
  activeOrgId: string | null,
  expiresIn: number,
  refreshToken?: string,
): TokenResponse {
  return {
    accessToken,
    tokenType: 'Bearer',
    // Report the signer's REAL configured TTL (TTL) so `expiresIn` can never drift from `exp`.
    expiresIn,
    activeOrgId,
    // present ONLY on the gated+opt-in non-browser path (else undefined → omitted).
    ...(refreshToken ? { refreshToken } : {}),
  };
}

/**
 * deliver the rotated refresh secret on EXACTLY ONE channel. When the operator gate
 * is on AND the request opted in (a non-browser client, `deliverRefreshTokenInBody === true`),
 * return the secret so the caller echoes it in the JSON body and SKIPS the Set-Cookie. Otherwise set
 * the host-prefixed refresh cookie exactly as today and return undefined (no secret in the body).
 * Default-OFF / no-opt-in is byte-identical to the pre- flow.
 */
function deliverRefresh(
  // biome-ignore lint/suspicious/noExplicitAny: Hono context typing varies per route registration.
  c: any,
  deps: AppDeps,
  secret: string,
  optedIn: boolean | undefined,
): string | undefined {
  if (deps.bodyRefreshEnabled && optedIn === true) {
    return secret; // body-only: deliberately do NOT Set-Cookie (one secret, one place).
  }
  setRefresh(c, secret);
  return undefined;
}

/**
 * The rate-limit/audit client identity: the socket peer unless a configured trusted proxy set the
 * forwarding header (see `clientIpFromContext`) — a caller cannot spoof its throttle identity via
 * `X-Forwarded-For`. 'unknown' when no peer is resolvable.
 */
function clientIp(c: Context<AppEnv>, deps: AppDeps): string {
  return clientIpFromContext(c, deps.trustedProxies ?? []);
}

function enforceRate(deps: AppDeps, bucket: string, id: string): void {
  const { allowed, retryAfterMs } = deps.rateLimiter.check(bucket, id);
  if (!allowed) {
    throw new ApiError('RATE_LIMITED', 'Too many requests.', { retryAfterMs });
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Hono context typing varies per route registration.
function setRefresh(c: any, secret: string): void {
  c.header('Set-Cookie', refreshCookie(secret, SESSION_TTL_SECONDS), { append: true });
}
// biome-ignore lint/suspicious/noExplicitAny: Hono context typing varies per route registration.
function clearRefresh(c: any): void {
  c.header('Set-Cookie', clearRefreshCookie(), { append: true });
}

/** Parse a JSON body that may be absent (refresh via cookie sends no body). */
// biome-ignore lint/suspicious/noExplicitAny: Hono context.
async function safeJson(c: any): Promise<unknown> {
  try {
    const text = await c.req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function roleOf(role: string): 'owner' | 'admin' | 'member' {
  return role === 'owner' || role === 'admin' ? role : 'member';
}
