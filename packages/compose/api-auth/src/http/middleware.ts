/**
 * The ordered Hono middleware chain — the one request chokepoint:
 *   requestId → securityHeaders → rateLimit → authenticate → resolveTenant → requirePermission.
 *
 * - requestId: a per-request id (echoed in the error envelope + audit).
 * - securityHeaders: conservative defaults (no-sniff, frame-deny, referrer, HSTS).
 * - authenticate: Bearer JWT, opaque cookie session, OR api-key prefix→constant-time HMAC; UNIFORM
 *   generic failure on miss (no enumeration). Sets ctx.principal.
 * - resolveTenant: ctx.tenantId is SERVER-DERIVED ONLY (session.current_org or api_key.org_id) —
 *   NEVER from URL/body/header. A URL :orgId is asserted == ctx.tenantId else 404 (no existence
 *   leak). Provides forTenant(db, tenantId) to handlers.
 * - requirePermission: static role check + a LIVE membership lookup for sensitive ops (never the
 *   JWT claim) — closing the revocation-bypass-on-write hole.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  ApiError,
  authorize,
  forbidden,
  isSensitive,
  type Permission,
  unauthenticated,
} from '@rayspec/auth-core';
import { forTenant, type TenantDb } from '@rayspec/db';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps, AppVariables, AuthContext } from '../app-context.js';
import { readRefreshCookie } from './cookies.js';

type Env = { Variables: AppVariables };

/** Attach a request id. */
export const requestId: MiddlewareHandler<Env> = async (c, next) => {
  const incoming = c.req.header('x-request-id');
  c.set('requestId', incoming && incoming.length <= 200 ? incoming : randomUUID());
  await next();
};

/** Conservative security headers on every response. */
export const securityHeaders: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Default to no-store, but do NOT clobber a route that DELIBERATELY set Cache-Control (the
  // public JWKS sets `public, max-age=300` so resource servers can cache the verification keys —
  // overwriting it with no-store would force a JWKS fetch on every token verify). securityHeaders
  // runs AFTER the handler (post-next), so an explicit handler value is already present here.
  if (!c.res.headers.has('Cache-Control')) {
    c.header('Cache-Control', 'no-store');
  }
};

/**
 * authenticate — resolve a principal from (in order): an Authorization: Bearer JWT, an api-key
 * (Bearer that is NOT a JWT, i.e. our `<prefix>.<secret>` form), or the opaque refresh-cookie
 * session. Sets ctx.principal. Does NOT 401 by itself when no credential is present — that is the
 * route's call (some routes are public); requireAuth() enforces presence.
 */
export function authenticate(deps: AppDeps): MiddlewareHandler<Env> {
  return async (c, next) => {
    const authHeader = c.req.header('authorization');
    const bearer = authHeader?.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : undefined;

    if (bearer) {
      // A RaySpec api-key has the `<prefix>.<secret>` shape (prefix starts `mk_`), NOT 3 dot-
      // separated base64url JWT segments. Disambiguate: JWTs have exactly two dots.
      const looksLikeJwt = bearer.split('.').length === 3 && !bearer.startsWith('mk_');
      if (looksLikeJwt) {
        try {
          const v = await deps.jwks.verify(bearer);
          const principal: AuthContext = {
            kind: 'user',
            userId: v.userId,
            orgId: v.orgId,
            role: v.mshipRole,
            scopes: v.scopes,
          };
          c.set('principal', principal);
        } catch {
          /* invalid JWT → no principal (uniform; route decides) */
        }
      } else {
        const resolved = await deps.apiKeyStore.resolve(bearer);
        if (resolved) {
          c.set('principal', {
            kind: resolved.type === 'm2m_client' ? 'm2m' : 'apikey',
            orgId: resolved.orgId,
            scopes: resolved.scopes,
            apiKeyId: resolved.id,
          });
        }
      }
    } else {
      // Cookie session path.
      const secret = readRefreshCookie(c.req.header('cookie'));
      if (secret) {
        const session = await deps.authService.sessionFromSecret(secret);
        if (session) {
          c.set('principal', {
            kind: 'user',
            userId: session.userId,
            orgId: session.currentOrgId ?? undefined,
            scopes: [],
            sessionId: session.id,
          });
        }
      }
    }
    await next();
  };
}

/** Enforce that a principal was resolved (uniform 401 otherwise). */
export function requireAuth(): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!c.get('principal')) throw unauthenticated();
    await next();
  };
}

/**
 * resolveTenant — establish ctx.tenantId SERVER-SIDE only (principal.orgId from the session's
 * current_org or the api-key's org_id). If the route carries a :orgId param it must EQUAL the
 * server-derived tenant, else 404 (cross-tenant IDOR closed without an existence leak). When the
 * principal has no active org (e.g. just-registered user before creating one) the route may still
 * run if it does not need a tenant; tenant-scoped handlers call requireTenant().
 */
export function resolveTenant(deps: AppDeps): MiddlewareHandler<Env> {
  return async (c, next) => {
    const principal = c.get('principal');
    const serverOrg = principal?.orgId;
    const urlOrg = c.req.param('orgId');
    if (urlOrg) {
      // The URL org must match the server-derived tenant; otherwise 404 (no existence leak).
      if (!serverOrg || urlOrg !== serverOrg) {
        // audit the cross-tenant denial OUT-OF-BAND (its own committed write) BEFORE the
        // 404/rollback, recording the ACTOR's resolved tenant authoritatively + the attempted
        // target as an opaque HASH (never a target-org FK the actor does not own).
        await deps.auditStore
          .append(
            {
              event: 'cross_tenant_denied',
              actorUserId: principal?.userId ?? null,
              actorOrgId: serverOrg ?? null,
              targetHash: hashTarget(urlOrg),
            },
            c.get('requestId'),
          )
          .catch(() => {
            /* audit is best-effort-durable; never fail the request on an audit error */
          });
        throw new ApiError('NOT_FOUND', 'Not found.');
      }
    }
    if (serverOrg) c.set('tenantId', serverOrg);
    await next();
  };
}

/** Opaque hash of an attempted cross-tenant target (never stored as a target-org FK). */
function hashTarget(target: string): string {
  return createHash('sha256').update(`org:${target}`).digest('hex');
}

/** A forTenant(db) handle for the resolved tenant; throws 404 if no tenant is established. */
export function tenantDb(c: Context<Env>, deps: AppDeps): TenantDb {
  const tenantId = c.get('tenantId');
  if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
  return forTenant(deps.db, tenantId);
}

/**
 * requirePermission — the authz chokepoint. For a SENSITIVE permission it does a LIVE membership
 * lookup (never the JWT claim); for read-mostly permissions the claim role is acceptable. An
 * api-key principal is additionally gated by its scopes. A deny is a 403 (and audits it).
 */
export function requirePermission(deps: AppDeps, permission: Permission): MiddlewareHandler<Env> {
  return async (c, next) => {
    const principal = c.get('principal');
    if (!principal) throw unauthenticated();
    const tenantId = c.get('tenantId');
    if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');

    const auditDeny = async () => {
      await deps.auditStore
        .append(
          {
            event: 'authz_denied',
            actorUserId: principal.userId ?? null,
            actorOrgId: tenantId,
            meta: { permission },
          },
          c.get('requestId'),
        )
        .catch(() => {});
    };

    let effectiveRole = principal.role;
    if (isSensitive(permission)) {
      // LIVE membership lookup — the JWT/session claim is NOT trusted for sensitive/mutating ops.
      if (principal.kind === 'user' && principal.userId) {
        const live = await deps.identityStore.liveMembership(principal.userId, tenantId);
        if (!live) {
          c.set('principal', { ...principal, role: undefined });
          await auditDeny();
          // Stays BARE (no `missing_permission` hint). This is a MEMBERSHIP failure, not a scope
          // gap: a principal that was revoked/removed from the tenant since its token was minted may
          // still HOLD `permission` via its (now-stale) role claim — labeling this `missing_permission`
          // would mislead. The honest 403 here is the uniform bare `Forbidden.`; the scope-gap hint
          // belongs only at the authorize()==false site below.
          throw forbidden();
        }
        effectiveRole = live.role;
        // Keep the live role on the principal for the handler.
        c.set('principal', { ...principal, role: live.role });
      } else {
        // An api-key / m2m principal has no user membership; the KEY itself IS the live credential
        // (no stale-claim problem — same as a non-sensitive api-key op). It does NOT get the
        // membership recheck; it falls through to authorize(), which gates by the api-key-grantable
        // SET ∩ scopes. The org-MANAGEMENT sensitive ops (apikey:mint/revoke, org:member:change,
        // org:switch) are NOT in that set, so authorize() still denies them outright; only a
        // sensitive op that IS api-key-grantable (store:write — a programmatic data write the
        // deployer explicitly scoped at mint) is allowed. So an api-key can never perform an
        // org-management sensitive op, but CAN write product data when scoped. (No bespoke recheck
        // — authorize() is the single grantable-set authority.)
      }
    }

    const ok = authorize(
      { userId: principal.userId, role: effectiveRole, scopes: principal.scopes },
      permission,
      { isApiKey: principal.kind === 'apikey' || principal.kind === 'm2m' },
    );
    if (!ok) {
      await auditDeny();
      // Name the missing permission so an AUTHENTICATED operator sees a *scope/role* gap is the
      // cause, rather than a bare `{code:"FORBIDDEN"}`. This throw is reached ONLY past the
      // authenticated-principal (401) and tenant (404) checks above — the caller is a valid
      // member/credential of THIS tenant — and `authorize()` returned false, i.e. the role does not
      // grant `permission` (user) or the permission is outside the api-key's granted scope ∩
      // grantable set (api-key). Both are a true "you lack `permission`" gap, so the hint is accurate
      // and safe. Unauthenticated (401) and cross-tenant (404) responses never reach here, so they
      // stay bare — no existence/scope leak.
      throw forbidden('Forbidden.', { missing_permission: permission });
    }
    await next();
  };
}
