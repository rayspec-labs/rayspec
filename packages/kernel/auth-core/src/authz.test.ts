/**
 * authz unit tests — the ROLE_PERMISSIONS matrix + the sensitive-op / api-key-scope rules.
 */
import { describe, expect, it } from 'vitest';
import {
  API_KEY_GRANTABLE,
  authorize,
  isSensitive,
  type Permission,
  ROLE_PERMISSIONS,
  roleGrants,
} from './authz.js';
import { ApiKeyScope } from './dto.js';

const ALL_PERMISSIONS: Permission[] = [
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
];

describe('ROLE_PERMISSIONS matrix', () => {
  it('owner grants every permission', () => {
    for (const p of ALL_PERMISSIONS) expect(roleGrants('owner', p)).toBe(true);
  });

  it('admin grants all but org:member:change', () => {
    expect(roleGrants('admin', 'apikey:mint')).toBe(true);
    expect(roleGrants('admin', 'apikey:revoke')).toBe(true);
    expect(roleGrants('admin', 'org:member:change')).toBe(false);
  });

  it('member grants only the read-mostly + agent-run + store surface', () => {
    expect(roleGrants('member', 'agent:run')).toBe(true);
    expect(roleGrants('member', 'org:read')).toBe(true);
    expect(roleGrants('member', 'store:read')).toBe(true);
    expect(roleGrants('member', 'store:write')).toBe(true);
    expect(roleGrants('member', 'apikey:mint')).toBe(false);
    expect(roleGrants('member', 'apikey:revoke')).toBe(false);
    expect(roleGrants('member', 'org:member:change')).toBe(false);
  });

  it('an unknown/undefined role grants nothing', () => {
    expect(roleGrants(undefined, 'agent:run')).toBe(false);
    expect(roleGrants('nonexistent', 'agent:run')).toBe(false);
  });

  it('the static table is the union of exactly the declared roles', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(['admin', 'member', 'owner']);
  });
});

describe('isSensitive', () => {
  it('marks mint/revoke/member-change/switch sensitive (live-check required)', () => {
    expect(isSensitive('apikey:mint')).toBe(true);
    expect(isSensitive('apikey:revoke')).toBe(true);
    expect(isSensitive('org:member:change')).toBe(true);
    expect(isSensitive('org:switch')).toBe(true);
  });
  it('marks read-mostly ops NOT sensitive (claim role acceptable)', () => {
    expect(isSensitive('agent:run')).toBe(false);
    expect(isSensitive('agent:read')).toBe(false);
    expect(isSensitive('org:read')).toBe(false);
    expect(isSensitive('apikey:read')).toBe(false);
    expect(isSensitive('store:read')).toBe(false);
  });
  it('marks store:write SENSITIVE — a product-data mutation re-checks live membership', () => {
    expect(isSensitive('store:write')).toBe(true);
  });
});

describe('authorize for a user principal', () => {
  it('owner may mint; member may not', () => {
    expect(authorize({ role: 'owner' }, 'apikey:mint')).toBe(true);
    expect(authorize({ role: 'member' }, 'apikey:mint')).toBe(false);
  });
  it('no membership (no role) is denied even for agent:run', () => {
    expect(authorize({ role: undefined }, 'agent:run')).toBe(false);
  });
});

describe('authorize for an api-key principal (scope-gated, no role)', () => {
  it('grants a scope-gated permission ONLY if the scope is present', () => {
    expect(authorize({ scopes: ['agent:run'] }, 'agent:run', { isApiKey: true })).toBe(true);
    expect(authorize({ scopes: ['org:read'] }, 'agent:run', { isApiKey: true })).toBe(false);
  });
  it('NEVER grants a sensitive org-management op to an api-key, even with a matching scope name', () => {
    // An api-key cannot mint/revoke keys or change membership/switch org regardless of scopes.
    expect(authorize({ scopes: ['apikey:mint'] as never }, 'apikey:mint', { isApiKey: true })).toBe(
      false,
    );
    expect(authorize({ scopes: [] }, 'org:member:change', { isApiKey: true })).toBe(false);
    expect(authorize({ scopes: [] }, 'org:switch', { isApiKey: true })).toBe(false);
  });
  it('grants store:read AND store:write to an api-key WITH the matching scope (scope chosen at mint)', () => {
    expect(authorize({ scopes: ['store:read'] }, 'store:read', { isApiKey: true })).toBe(true);
    expect(authorize({ scopes: [] }, 'store:read', { isApiKey: true })).toBe(false);
    // store:write IS api-key-grantable (the programmatic/agency consumer model) — granted WITH the
    // scope, denied without. (requirePermission falls api-keys through the sensitive branch to this
    // authorize() gate; the KEY is the live credential, so no membership recheck applies.)
    expect(authorize({ scopes: ['store:write'] }, 'store:write', { isApiKey: true })).toBe(true);
    expect(authorize({ scopes: [] }, 'store:write', { isApiKey: true })).toBe(false);
  });
});

/**
 * The api-key-grantable WHOLE-MATRIX invariant guard. authorize() and the
 * ApiKeyScope DTO both read the SINGLE `API_KEY_GRANTABLE` authority; this derives the expected
 * answer for EVERY permission from that authority and asserts the gate agrees — so a permission can
 * never be added to (or dropped from) the grantable set without the matrix moving in lockstep, AND
 * an org-management sensitive op can never become api-key-reachable. Fail-the-fix: adding a fake
 * sensitive perm to API_KEY_GRANTABLE turns the "with ALL scopes" sensitive-deny case below red.
 */
describe('API_KEY_GRANTABLE — derived whole-matrix invariant (single source of truth)', () => {
  // The FULL permission universe = owner's grants (owner ⊇ admin ⊇ member, so this is every Permission).
  const ALL: readonly Permission[] = ROLE_PERMISSIONS.owner;
  const grantable = new Set<Permission>(API_KEY_GRANTABLE);

  it('for EVERY permission, authorize(isApiKey, scope=[p]) === API_KEY_GRANTABLE.has(p)', () => {
    for (const p of ALL) {
      // Grant the api-key the EXACT scope for p; the answer must be ENTIRELY decided by membership in
      // the grantable set (scope is present, so the only remaining gate is the set).
      const decided = authorize({ scopes: [p] }, p, { isApiKey: true });
      expect(decided).toBe(grantable.has(p));
    }
  });

  it('a grantable permission with the scope ABSENT is still denied (scope ∩ set, not set alone)', () => {
    for (const p of API_KEY_GRANTABLE) {
      expect(authorize({ scopes: [] }, p, { isApiKey: true })).toBe(false);
    }
  });

  it('EVERY org-management sensitive op is denied an api-key even with ALL scopes granted', () => {
    // The security boundary: regardless of how broadly a key is scoped, it can never perform an
    // org-management sensitive op. (This is the case that goes RED if a fake sensitive perm is added
    // to API_KEY_GRANTABLE.)
    const orgManagementSensitive: Permission[] = [
      'apikey:mint',
      'apikey:revoke',
      'org:member:change',
      'org:switch',
    ];
    const allScopes = [...ALL] as string[]; // grant the key EVERY scope name
    for (const op of orgManagementSensitive) {
      expect(grantable.has(op)).toBe(false); // none is in the grantable authority
      expect(authorize({ scopes: allScopes }, op, { isApiKey: true })).toBe(false);
    }
  });

  it('API_KEY_GRANTABLE and the ApiKeyScope DTO enum are the SAME closed set (cannot desync)', () => {
    // dto.ts derives ApiKeyScope from API_KEY_GRANTABLE, so this is structurally guaranteed; assert
    // it too, so a future refactor that re-introduces a parallel literal is caught immediately.
    expect([...API_KEY_GRANTABLE].sort()).toEqual([...ApiKeyScope.options].sort());
  });

  it('API_KEY_GRANTABLE is frozen (the shared authority cannot be mutated by a caller)', () => {
    expect(Object.isFrozen(API_KEY_GRANTABLE)).toBe(true);
  });
});
