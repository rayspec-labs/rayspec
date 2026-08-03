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
  BootstrapTenantRequest,
  LoginRequest,
  type MeResponse,
  normalizeEmail,
  type RateLimitDecision,
  RefreshRequest,
  RegisterRequest,
  type TokenResponse,
} from '@rayspec/auth-core';
import type { Context } from 'hono';
import type { AppDeps, AppEnv } from '../app-context.js';
import { readBoundedJson, readBoundedRequestBytes } from '../http/bounded-body.js';
import { clientIpFromContext } from '../http/client-ip.js';
import {
  clearRefreshCookie,
  isCsrfSafeForCookieEndpoint,
  readRefreshCookie,
  refreshCookie,
} from '../http/cookies.js';
import { requireAuth } from '../http/middleware.js';
import { SESSION_TTL_MS } from '../services/auth-service.js';
import { OrgIdInUseError } from '../stores/org-store.js';

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
    enforceRate(await deps.rateLimiter.checkAsync('register', ip));
    // Drain the body under the configured byte cap (413 for an over-cap body BEFORE any work), then
    // parse exactly as before (a malformed body still throws through to the error envelope).
    const rawBody = await readBoundedRequestBytes(c, deps.maxJsonBodyBytes);
    const body = RegisterRequest.parse(JSON.parse(new TextDecoder().decode(rawBody)));
    const email = normalizeEmail(body.email);
    // The optional auto-created org is handed to `register` rather than created after it, so the
    // session row, the minted token and the reported `activeOrgId` agree — see its docblock.
    const orgName = body.orgName;
    const reg = await deps.authService.register(
      email,
      body.password,
      { ua: c.req.header('user-agent') ?? null, ip },
      orgName
        ? {
            createFirstOrg: async (userId: string) => {
              const slug = await deps.orgStore.deriveUniqueSlug(orgName);
              const org = await deps.orgStore.createOrgWithOwner({
                name: orgName,
                slug,
                ownerUserId: userId,
              });
              return { orgId: org.id, role: 'owner' };
            },
          }
        : {},
    );
    await deps.auditStore.appendMany(reg.audit, rid, ipHashOf(c, deps));
    const refreshToken = deliverRefresh(c, deps, reg.refreshSecret, body.deliverRefreshTokenInBody);
    return c.json(
      tokenResponse(
        reg.accessToken,
        reg.activeOrgId,
        deps.signer.accessTokenTtlSeconds,
        refreshToken,
      ),
      201,
    );
  });

  // POST /v1/auth/bootstrap-tenant — register an owner + create their org under a CHOSEN id.
  //
  // REGISTERED ONLY IN THE OPERATOR POSTURE. On a default deployment this `if` never runs, so the
  // path does not exist (404) rather than existing-and-refusing. That is the whole mitigation: the
  // public, unauthenticated `/v1/auth/register` above keeps assigning a server-generated id, and a
  // caller who has learned the id an operator intends to deploy against has nowhere to send it — no
  // gate to guess at, no collision reply to read as an existence oracle. The store enforces the same
  // posture underneath (a chosen id without it throws), so this is a gate, not the only gate.
  //
  // Read through `?.` because this runs at REGISTRATION time, and unit-only suites build the app from
  // a partial deps cast (no store) to exercise route-independent concerns like CORS. A missing store
  // means no bootstrap route, which is the fail-closed answer anyway.
  if (deps.orgStore?.tenantBootstrapEnabled) {
    app.post('/v1/auth/bootstrap-tenant', async (c) => {
      const rid = c.get('requestId');
      const ip = clientIp(c, deps);
      // The same bucket as register — it IS a registration.
      enforceRate(await deps.rateLimiter.checkAsync('register', ip));
      const rawBody = await readBoundedRequestBytes(c, deps.maxJsonBodyBytes);
      const body = BootstrapTenantRequest.parse(JSON.parse(new TextDecoder().decode(rawBody)));
      const email = normalizeEmail(body.email);
      // Same seam as `register` above: the org is created INSIDE the registration, so the session
      // this operator call hands back is already bound to the tenant it just made. A taken id still
      // aborts before a session exists — it leaves the freshly created user behind, which an operator
      // resolves by retrying with the same email once the id question is settled.
      const reg = await deps.authService.register(
        email,
        body.password,
        { ua: c.req.header('user-agent') ?? null, ip },
        {
          createFirstOrg: async (userId: string) => {
            const slug = await deps.orgStore.deriveUniqueSlug(body.orgName);
            try {
              const created = await deps.orgStore.createOrgWithOwner({
                name: body.orgName,
                slug,
                ownerUserId: userId,
                id: body.orgId,
              });
              return { orgId: created.id, role: 'owner' };
            } catch (e) {
              // A taken id is the operator's problem to resolve, not a server fault: say so as a 409
              // rather than succeeding under a different id they would then deploy against.
              if (e instanceof OrgIdInUseError) {
                throw new ApiError('CONFLICT', 'That org id already exists.');
              }
              throw e;
            }
          },
        },
      );
      const org = { id: reg.activeOrgId as string };
      await deps.auditStore.appendMany(reg.audit, rid, ipHashOf(c, deps));
      const refreshToken = deliverRefresh(
        c,
        deps,
        reg.refreshSecret,
        body.deliverRefreshTokenInBody,
      );
      return c.json(
        tokenResponse(reg.accessToken, org.id, deps.signer.accessTokenTtlSeconds, refreshToken),
        201,
      );
    });
  }

  // POST /v1/auth/login
  app.post('/v1/auth/login', async (c) => {
    const rid = c.get('requestId');
    const ip = clientIp(c, deps);
    enforceRate(await deps.rateLimiter.checkAsync('login', ip));
    // Drain the body under the configured byte cap (413 for an over-cap body BEFORE any work), then
    // parse exactly as before (a malformed body still throws through to the error envelope).
    const rawBody = await readBoundedRequestBytes(c, deps.maxJsonBodyBytes);
    const body = LoginRequest.parse(JSON.parse(new TextDecoder().decode(rawBody)));
    const email = normalizeEmail(body.email);
    const result = await deps.authService.login(email, body.password, {
      ua: c.req.header('user-agent') ?? null,
      ip,
    });
    await deps.rateLimiter.resetAsync('login', ip); // a clean login resets the counter
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
    enforceRate(await deps.rateLimiter.checkAsync('refresh', ip));

    const cookieSecret = readRefreshCookie(c.req.header('cookie'));
    // Drain the body under the configured byte cap (413 for an over-cap body BEFORE any work). The
    // route stays lenient to an ABSENT body (cookie-only refresh): an empty/unparseable body reads as
    // `{}` exactly as before, so a cookie-only refresh is unaffected — only the byte total is bounded.
    const body = RefreshRequest.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
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
      await deps.rateLimiter.lockSourceAsync('refresh', ip);
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

/**
 * Throw the shared `RATE_LIMITED` envelope for a refusal.
 *
 * It takes the DECISION rather than the limiter deliberately. The limiter is asked asynchronously, so
 * a helper that asked it itself would have to be `async` — and a call site that then forgot to `await`
 * would carry on serving the request while an unhandled rejection surfaced elsewhere, which is a
 * silently unthrottled auth route. Nothing in the lint configuration catches a floating promise. Taking
 * the already-resolved decision makes that same mistake a type error at the call site instead.
 */
function enforceRate(decision: RateLimitDecision): void {
  const { allowed, retryAfterMs } = decision;
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

function roleOf(role: string): 'owner' | 'admin' | 'member' {
  return role === 'owner' || role === 'admin' ? role : 'member';
}
