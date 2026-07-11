/**
 * Org + API-key routes.
 *
 * - POST /v1/orgs — create org + owner membership (one tx); Bearer required (mutating).
 * - GET  /v1/orgs — orgs the caller is a member of.
 * - POST /v1/orgs/:orgId/switch — LIVE-recheck membership, re-mint a JWT scoped to orgId. The
 *   privilege-change credential rotation IS the re-minted short-lived JWT (the long-lived refresh
 *   session is org-independent and is NOT rotated here — see the handler comment).
 * - POST /v1/orgs/:orgId/api-keys — mint (plaintext ONCE, HMAC only); Idempotency-Key tenant-scoped.
 * - GET  /v1/orgs/:orgId/api-keys — list (never plaintext/hash).
 * - DELETE /v1/orgs/:orgId/api-keys/:keyId — revoke.
 *
 * resolveTenant asserts the URL :orgId == the server-derived tenant (else 404, no existence leak).
 * requirePermission does a LIVE membership lookup for the sensitive ops (never the JWT claim).
 */

import { createHash } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ApiError,
  ChangeMemberRoleRequest,
  CreateOrgRequest,
  forbidden,
  getApiKeyPepper,
  type MintApiKeyReplay,
  MintApiKeyRequest,
  type MintApiKeyResponse,
  mintApiKey,
  newJti,
  type OrgListResponse,
} from '@rayspec/auth-core';
import type { AppDeps, AppEnv } from '../app-context.js';
import { requireAuth, requirePermission, resolveTenant } from '../http/middleware.js';

export function registerOrgRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // POST /v1/orgs — Bearer required (mutating). Any authenticated user may create an org.
  app.post('/v1/orgs', requireAuth(), requireBearerForMutation(), async (c) => {
    const principal = c.get('principal');
    if (!principal?.userId) throw forbidden();
    const body = CreateOrgRequest.parse(await c.req.json());
    const slug = body.slug
      ? body.slug.toLowerCase()
      : await deps.orgStore.deriveUniqueSlug(body.name);
    let org: { id: string; name: string; slug: string };
    try {
      org = await deps.orgStore.createOrgWithOwner({
        name: body.name,
        slug,
        ownerUserId: principal.userId,
      });
    } catch (err) {
      // slug unique-index collision → 409.
      if (String(err).includes('orgs_slug_lower_idx') || String(err).includes('duplicate')) {
        throw new ApiError('CONFLICT', 'Org slug already taken.');
      }
      throw err;
    }
    await deps.auditStore.append(
      { event: 'org_create', actorUserId: principal.userId, actorOrgId: org.id },
      c.get('requestId'),
    );
    return c.json({ id: org.id, name: org.name, slug: org.slug, role: 'owner' as const }, 201);
  });

  // GET /v1/orgs — only the caller's orgs.
  app.get('/v1/orgs', requireAuth(), async (c) => {
    const principal = c.get('principal');
    if (!principal?.userId) throw forbidden();
    const orgs = await deps.orgStore.orgsForUser(principal.userId);
    const resp: OrgListResponse = {
      orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: roleOf(o.role) })),
    };
    return c.json(resp, 200);
  });

  // POST /v1/orgs/:orgId/switch — LIVE-recheck membership + re-mint a JWT scoped to orgId.
  //
  // The privilege-change CREDENTIAL ROTATION is the re-minted short-lived JWT: a switch is a
  // Bearer-required mutation (requireBearerForMutation forces the JWT principal path), so the
  // newly-minted token carries the new org_id + the LIVE role. We do NOT rotate the opaque
  // refresh session here: it is a long-lived per-device family anchor independent of the active
  // org, and a Bearer-authenticated switch (CLI/desktop) need not carry a cookie session at all.
  // (Earlier this handler had a `principal.sessionId` cookie-rotation branch that was UNREACHABLE
  // on the Bearer path — it has been removed rather than left as dead code under a live claim.)
  app.post('/v1/orgs/:orgId/switch', requireAuth(), requireBearerForMutation(), async (c) => {
    const principal = c.get('principal');
    if (!principal?.userId) throw forbidden();
    const orgId = c.req.param('orgId');
    // LIVE membership lookup — the switch is a privilege change; the claim is NOT trusted.
    const live = await deps.identityStore.liveMembership(principal.userId, orgId);
    if (!live) {
      // a switch into an org the actor is not a LIVE member of is a cross-tenant denial
      // audit it OUT-OF-BAND (actor's authoritative tenant from the claim + the attempted target
      // as an opaque hash) BEFORE the 404, mirroring resolveTenant's denial path.
      await deps.auditStore
        .append(
          {
            event: 'cross_tenant_denied',
            actorUserId: principal.userId,
            actorOrgId: principal.orgId ?? null,
            targetHash: hashTarget(orgId),
          },
          c.get('requestId'),
        )
        .catch(() => {});
      throw new ApiError('NOT_FOUND', 'Not found.'); // no existence leak
    }

    const accessToken = await deps.signer.mint(
      { userId: principal.userId, orgId, mshipRole: live.role },
      newJti(),
    );
    await deps.auditStore.append(
      { event: 'org_switch', actorUserId: principal.userId, actorOrgId: orgId },
      c.get('requestId'),
    );
    return c.json(
      {
        accessToken,
        tokenType: 'Bearer' as const,
        // Report the signer's REAL configured TTL (TTL) — was a hardcoded 8*60; deriving it keeps a
        // configured TTL consistent with the auth-route responses (and never drifting from `exp`).
        expiresIn: deps.signer.accessTokenTtlSeconds,
        activeOrgId: orgId,
      },
      200,
    );
  });

  // POST /v1/orgs/:orgId/members/:userId/role — change a member's role (LIVE-membership authz;
  // owner|admin via org:member:change). The last-owner invariant is enforced in OrgStore.setRole.
  app.post(
    '/v1/orgs/:orgId/members/:userId/role',
    requireAuth(),
    requireBearerForMutation(),
    resolveTenant(deps),
    requirePermission(deps, 'org:member:change'),
    async (c) => {
      const orgId = c.get('tenantId');
      if (!orgId) throw new ApiError('NOT_FOUND', 'Not found.');
      const targetUserId = c.req.param('userId');
      const body = ChangeMemberRoleRequest.parse(await c.req.json());
      const outcome = await deps.orgStore.setRole(orgId, targetUserId, body.role);
      if (outcome === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
      if (outcome === 'last_owner') {
        throw new ApiError('CONFLICT', 'Cannot demote the last owner of the org.');
      }
      await deps.auditStore.append(
        {
          event: 'org_member_change',
          actorUserId: c.get('principal')?.userId ?? null,
          actorOrgId: orgId,
          meta: { targetUserId, role: body.role },
        },
        c.get('requestId'),
      );
      return c.json({ orgId, userId: targetUserId, role: body.role }, 200);
    },
  );

  // DELETE /v1/orgs/:orgId/members/:userId — remove a member (LIVE-membership authz). Refuses to
  // remove the LAST owner (would leave the org ownerless).
  app.delete(
    '/v1/orgs/:orgId/members/:userId',
    requireAuth(),
    requireBearerForMutation(),
    resolveTenant(deps),
    requirePermission(deps, 'org:member:change'),
    async (c) => {
      const orgId = c.get('tenantId');
      if (!orgId) throw new ApiError('NOT_FOUND', 'Not found.');
      const targetUserId = c.req.param('userId');
      const outcome = await deps.orgStore.removeMember(orgId, targetUserId);
      if (outcome === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
      if (outcome === 'last_owner') {
        throw new ApiError('CONFLICT', 'Cannot remove the last owner of the org.');
      }
      await deps.auditStore.append(
        {
          event: 'org_member_change',
          actorUserId: c.get('principal')?.userId ?? null,
          actorOrgId: orgId,
          meta: { targetUserId, removed: true },
        },
        c.get('requestId'),
      );
      return c.body(null, 204);
    },
  );

  // POST /v1/orgs/:orgId/api-keys — mint (LIVE-membership authz; plaintext ONCE; Idempotency-Key).
  app.post(
    '/v1/orgs/:orgId/api-keys',
    requireAuth(),
    requireBearerForMutation(),
    resolveTenant(deps),
    requirePermission(deps, 'apikey:mint'),
    async (c) => {
      const principal = c.get('principal');
      const orgId = c.get('tenantId');
      if (!orgId || !principal?.userId) throw forbidden();
      const rawBody = await c.req.json();
      const body = MintApiKeyRequest.parse(rawBody);

      // Idempotency-Key: TENANT-SCOPED replay (the run-core lesson — the lookup carries the tenant
      // predicate via forTenant). Same key+body → replay the stored snapshot; same key+diff body →
      // 409 IDEMPOTENCY_CONFLICT. Stored in the tenant-scoped idempotency_keys table.
      //
      // KILL-TRIGGER closure: the persisted snapshot is REDACTED — it NEVER carries the
      // plaintext secret (the snapshot column is jsonb with no TTL; a DB dump must not yield a
      // usable `mk_prefix.secret`). The plaintext is shown EXACTLY ONCE on the original mint
      // below; a replay returns only `{id, keyPrefix, scopes, replayed:true}` with the secret
      // OMITTED. A retry therefore does NOT re-reveal the secret (a client that lost the original
      // 201 response must mint a NEW key) — documented replay semantics.
      const idemKey = c.req.header('idempotency-key');
      const bodyHash = hashBody(rawBody);
      if (idemKey) {
        const existing = await deps.idempotency.find(orgId, 'apikey:mint', idemKey);
        if (existing) {
          if (existing.bodyHash !== bodyHash) {
            throw new ApiError(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency-Key reused with a different body.',
            );
          }
          // Replay returns the REDACTED snapshot (plaintext omitted, replayed:true), HTTP 200.
          return c.json(existing.snapshot as MintApiKeyReplay, 200);
        }
      }

      const pepper = getApiKeyPepper();
      const minted = mintApiKey(pepper);
      const row = await deps.apiKeyStore.mint({
        orgId,
        keyPrefix: minted.prefix,
        keyHash: minted.hash,
        scopes: body.scopes,
        createdBy: principal.userId,
      });
      const resp: MintApiKeyResponse = {
        id: row.id,
        keyPrefix: row.keyPrefix,
        plaintext: minted.plaintext, // shown ONCE
        scopes: body.scopes,
      };
      if (idemKey) {
        // Persist ONLY the redacted metadata — NEVER the plaintext (kill-trigger closure).
        //
        // TRACKED-LOW (external-exposure hardening exactly-once mint): record uses onConflictDoNothing
        // AFTER the key is minted, so two CONCURRENT requests carrying the same Idempotency-Key can
        // each mint a distinct api-key row; only one snapshot wins the unique (tenant,scope,idem)
        // index and the other minted key is orphaned (usable but never replayable). This does NOT
        // reopen the kill-trigger — neither plaintext is persisted (each is shown only in
        // its own 201) — so it is a correctness/exactly-once gap, not a secret-at-rest gap. Fix
        // (deferred): mint-under-the-idempotency-row (reserve the idem row in a tx, then mint).
        const redacted: MintApiKeyReplay = {
          id: row.id,
          keyPrefix: row.keyPrefix,
          scopes: body.scopes,
          replayed: true,
        };
        await deps.idempotency.record(orgId, 'apikey:mint', idemKey, bodyHash, redacted);
      }
      await deps.auditStore.append(
        {
          event: 'apikey_mint',
          actorUserId: principal.userId,
          actorOrgId: orgId,
          meta: { keyId: row.id },
        },
        c.get('requestId'),
      );
      return c.json(resp, 201);
    },
  );

  // GET /v1/orgs/:orgId/api-keys — list (never plaintext/hash).
  app.get(
    '/v1/orgs/:orgId/api-keys',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'apikey:read'),
    async (c) => {
      const orgId = c.get('tenantId');
      if (!orgId) throw new ApiError('NOT_FOUND', 'Not found.');
      const keys = await deps.apiKeyStore.listForOrg(orgId);
      return c.json(
        {
          keys: keys.map((k) => ({
            id: k.id,
            keyPrefix: k.keyPrefix,
            scopes: k.scopes,
            lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
            revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
            createdAt: k.createdAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  // DELETE /v1/orgs/:orgId/api-keys/:keyId — revoke (LIVE-membership authz).
  app.delete(
    '/v1/orgs/:orgId/api-keys/:keyId',
    requireAuth(),
    requireBearerForMutation(),
    resolveTenant(deps),
    requirePermission(deps, 'apikey:revoke'),
    async (c) => {
      const principal = c.get('principal');
      const orgId = c.get('tenantId');
      if (!orgId) throw new ApiError('NOT_FOUND', 'Not found.');
      const ok = await deps.apiKeyStore.revoke(orgId, c.req.param('keyId'));
      if (!ok) throw new ApiError('NOT_FOUND', 'Not found.');
      await deps.auditStore.append(
        {
          event: 'apikey_revoke',
          actorUserId: principal?.userId ?? null,
          actorOrgId: orgId,
          meta: { keyId: c.req.param('keyId') },
        },
        c.get('requestId'),
      );
      return c.body(null, 204);
    },
  );
}

// ---- helpers -------------------------------------------------------------------------------

/**
 * CSRF for MUTATING endpoints: a Bearer token is required (a cross-site form cannot set the
 * Authorization header). A cookie-only request to a mutating endpoint is rejected.
 */
import type { MiddlewareHandler } from 'hono';

function requireBearerForMutation(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    const authHeader = c.req.header('authorization');
    const hasBearer = authHeader?.toLowerCase().startsWith('bearer ');
    if (!principal) throw new ApiError('UNAUTHENTICATED', 'Authentication failed.');
    if (!hasBearer) {
      throw new ApiError('FORBIDDEN', 'A Bearer access token is required for this operation.');
    }
    await next();
  };
}

function hashBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? {}))
    .digest('hex');
}

/** Opaque hash of an attempted cross-tenant target org (never a target-org FK). Mirrors middleware.ts. */
function hashTarget(target: string): string {
  return createHash('sha256').update(`org:${target}`).digest('hex');
}

function roleOf(role: string): 'owner' | 'admin' | 'member' {
  return role === 'owner' || role === 'admin' ? role : 'member';
}
