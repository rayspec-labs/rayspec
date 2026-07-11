/**
 * Authorization — the static ROLE_PERMISSIONS table + the authorize() contract.
 * DB-free here; the LIVE membership lookup is injected by the caller (api-auth holds the
 * IdentityStore). A general policy engine is overkill here — a static code constant.
 *
 * THE CRITICAL SPLIT: for SENSITIVE/MUTATING permissions the caller MUST resolve the role from a
 * LIVE membership lookup (TenantDb/IdentityStore), NOT the JWT claim — so a revoked/demoted
 * principal is denied within the ~8-min token TTL (the TTL is a bounded READ-staleness risk, not
 * a write-privilege bypass). `isSensitive(permission)` tells the caller which path to take.
 */

/**
 * The closed set of permissions.
 *
 * `store:read`/`store:write` are the GENERIC, product-agnostic CRUD permissions a
 * declared `api` route over a materialized store is gated by — read ops (list/get) require
 * `store:read`, mutating ops (create/update/delete) require `store:write`. They are NOT
 * store-specific (no `notebooks:*`): the platform stays product-free and one pair gates every
 * declared store route. `store:write` is SENSITIVE (a live-membership recheck on every mutation,
 * mirroring why a write must never trust a stale JWT claim — see the SENSITIVE set below).
 */
export type Permission =
  | 'agent:run'
  | 'agent:read'
  | 'store:read'
  | 'store:write'
  | 'org:read'
  | 'org:member:change'
  | 'org:switch'
  | 'apikey:read'
  | 'apikey:mint'
  | 'apikey:revoke';

/** Roles → the permissions they grant (static; owner ⊇ admin ⊇ member). */
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: [
    'agent:run',
    'agent:read',
    'store:read',
    'store:write',
    'org:read',
    'org:member:change',
    'org:switch',
    'apikey:read',
    'apikey:mint',
    'apikey:revoke',
  ],
  admin: [
    'agent:run',
    'agent:read',
    'store:read',
    'store:write',
    'org:read',
    'org:switch',
    'apikey:read',
    'apikey:mint',
    'apikey:revoke',
  ],
  member: ['agent:run', 'agent:read', 'store:read', 'store:write', 'org:read', 'org:switch'],
};

/**
 * SENSITIVE/MUTATING permissions — for these the caller MUST do a LIVE membership+role lookup and
 * MUST NOT trust the JWT claim. (org switch is included: it re-mints a privileged token, so it
 * re-checks live.)
 */
const SENSITIVE = new Set<Permission>([
  'apikey:mint',
  'apikey:revoke',
  'org:member:change',
  'org:switch',
  // A declared-store MUTATION (create/update/delete) must re-check live membership — a revoked/
  // demoted principal must not write product data on a stale JWT claim (the same write-bypass
  // reasoning that makes the api-key/org-management ops sensitive). store:read stays claim-trusted.
  'store:write',
]);

/** True if `permission` requires a live membership check (never trust the JWT claim). */
export function isSensitive(permission: Permission): boolean {
  return SENSITIVE.has(permission);
}

/**
 * The CLOSED set of permissions an api-key principal may EVER exercise — its scopes ∩ this set. This
 * is the SINGLE source of truth for both `authorize()` (the runtime gate) and the `ApiKeyScope` DTO
 * enum (the mint-time grammar; dto.ts derives its enum from this so the two can never silently
 * desync). It is purely scope-driven (an api-key is a machine principal with NO membership/role).
 *
 * What is DELIBERATELY ABSENT is the security boundary: the org-MANAGEMENT sensitive ops
 * (`apikey:mint`, `apikey:revoke`, `org:member:change`, `org:switch`) are NOT here, so an api-key can
 * never perform them regardless of scope. `store:write` IS here (the programmatic/agency consumer
 * model — a desktop app / automation POSTing rows authenticates via an org-scoped key); it is also
 * SENSITIVE, but for an api-key the KEY is the live credential, so requirePermission falls api-keys
 * through to authorize(), where this set ∩ scopes is the gate (no stale-claim recheck applies).
 *
 * Frozen so a caller cannot mutate the shared authority; `authorize()` reads it via `.includes`.
 */
export const API_KEY_GRANTABLE: readonly Permission[] = Object.freeze([
  'agent:run',
  'agent:read',
  'store:read',
  'store:write',
  'org:read',
  'apikey:read',
]);

/** Does `role` grant `permission` per the static table? */
export function roleGrants(role: string | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

/**
 * The principal an authorize() call evaluates. For sensitive permissions the caller supplies the
 * LIVE role (resolved via the membership store); for read-mostly permissions the JWT-claim role
 * is acceptable.
 */
export interface AuthzPrincipal {
  userId?: string;
  /** The role to evaluate against — LIVE for sensitive ops, claim-derived otherwise. */
  role?: string;
  /** API-key scopes (an api-key principal is also gated by its granted scopes). */
  scopes?: string[];
}

/**
 * Decide whether `principal` may perform `permission` in the (already tenant-resolved) org.
 *
 * Pure decision: the caller has ALREADY (a) asserted the principal belongs to the tenant and
 * (b) for a sensitive permission, set `principal.role` from a LIVE membership lookup. For an
 * api-key principal, the permission must ALSO be within its granted scopes (scope ∩ role).
 */
export function authorize(
  principal: AuthzPrincipal,
  permission: Permission,
  opts: { isApiKey?: boolean } = {},
): boolean {
  // The permissions an api-key may EVER exercise — purely its scopes, NO role (an api-key is a
  // machine principal with no membership). Sensitive org-management ops are NOT in this set, so
  // an api-key can never mint/revoke keys or change membership/switch org regardless of scope.
  if (opts.isApiKey) {
    // The api-key-grantable SET is the single shared authority (API_KEY_GRANTABLE above): an api-key
    // may exercise ONLY a permission that is BOTH in that set AND in its scopes. The org-MANAGEMENT
    // sensitive ops (apikey:mint/revoke, org:member:change, org:switch) are absent from the set, so
    // an api-key can never perform them regardless of scope. (store:write IS in the set — the
    // programmatic/agency consumer model — see API_KEY_GRANTABLE's rationale.)
    if (!API_KEY_GRANTABLE.includes(permission)) return false;
    return (principal.scopes ?? []).includes(permission);
  }
  // User principals: the role (LIVE for sensitive ops, claim-derived otherwise) must grant it.
  return roleGrants(principal.role, permission);
}
