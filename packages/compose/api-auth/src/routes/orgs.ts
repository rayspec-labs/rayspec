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

import { createHash, randomBytes } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  AddOrgMemberRequest,
  type AddOrgMemberResponse,
  ApiError,
  ChangeMemberRoleRequest,
  CreateOrgRequest,
  forbidden,
  getApiKeyPepper,
  hashPassword,
  type MintApiKeyReplay,
  MintApiKeyRequest,
  type MintApiKeyResponse,
  mintApiKey,
  newJti,
  normalizeEmail,
  type OrgListResponse,
  type OrgMemberListResponse,
  verifyPassword,
} from '@rayspec/auth-core';
import { isUniqueViolation } from '@rayspec/db';
import type { AppDeps, AppEnv } from '../app-context.js';
import { readBoundedJson } from '../http/bounded-body.js';
import { requireAuth, requirePermission, resolveTenant } from '../http/middleware.js';

export function registerOrgRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // POST /v1/orgs — Bearer required (mutating). Any authenticated user may create an org.
  app.post('/v1/orgs', requireAuth(), requireBearerForMutation(), async (c) => {
    const principal = c.get('principal');
    if (!principal?.userId) throw forbidden();
    const body = CreateOrgRequest.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
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
      const body = ChangeMemberRoleRequest.parse(
        await readBoundedJson(c, deps.maxJsonBodyBytes, {}),
      );
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

  // POST /v1/orgs/:orgId/members — add a user to the org by email (OWNER-ONLY; live-membership authz
  // via the sensitive org:member:add permission, so a stale JWT claim cannot grant it, and an api-key
  // principal is rejected because org:member:add is not api-key-grantable). If the email has no user
  // yet, a fresh account is provisioned with a one-time password returned ONCE in the owner's response
  // (core has no outbound mail; the operator conveys it out-of-band).
  app.post(
    '/v1/orgs/:orgId/members',
    requireAuth(),
    requireBearerForMutation(),
    resolveTenant(deps),
    requirePermission(deps, 'org:member:add'),
    async (c) => {
      const principal = c.get('principal');
      const orgId = c.get('tenantId');
      if (!orgId || !principal?.userId) throw forbidden();
      const body = AddOrgMemberRequest.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));
      let email: string;
      try {
        email = normalizeEmail(body.email);
      } catch {
        throw new ApiError('VALIDATION_ERROR', 'A valid email address is required.');
      }

      // Resolve (or provision) the target user, then idempotently attach the membership.
      //
      // ⚠ ACCEPTED beta limitation (response-shape account-existence oracle): the response reveals to
      // the org owner whether `email` already has a GLOBAL account — a `oneTimePassword` is present
      // ONLY when THIS call provisioned a NEW account. This DIRECT in-band member-add is a trusted-beta
      // convenience: an owner can probe whether an address is registered platform-wide. The AVOIDABLE
      // second channel — argon2id timing — IS equalized here (see equalizeProvisionTiming below) so
      // latency does not compound the oracle.
      //
      // The ORACLE-FREE alternative now ships in the core: the out-of-band invite-token flow (POST
      // /v1/orgs/:orgId/invites → POST /v1/invites/accept, see routes/invites.ts + SECURITY.md). The
      // issue path creates an invite for ANY email without ever looking up account existence, so it
      // leaks no account-existence signal; the account-existence question is resolved only at redeem,
      // by the invitee. Prefer the invite flow when the owner must not learn whether an address is
      // registered. This direct path is retained for backward compatibility / trusted-beta use.
      const existing = await deps.identityStore.findUserByEmail(email);
      let userId: string;
      let oneTimePassword: string | undefined;
      if (existing) {
        userId = existing.id;
        // Timing equalization: the provisioning branch runs one argon2id hash. Do the SAME argon2id
        // work here (a dummy verify, mirroring the login enumeration defense in auth-service.ts) so an
        // existing-account response is not measurably faster than a provisioned one.
        await equalizeProvisionTiming();
      } else {
        // ≥43 URL-safe chars (256-bit) — comfortably above the login password minimum; shown ONCE.
        const otp = randomBytes(32).toString('base64url');
        try {
          const created = await deps.identityStore.createUser(email, await hashPassword(otp));
          userId = created.id;
          oneTimePassword = otp;
        } catch (err) {
          // A CONCURRENT add of the same NEW email (or a racing /v1/auth/register) can win the users
          // email-unique index between the findUserByEmail miss above and this insert → 23505 → HTTP
          // 500. Recover idempotently: the account now exists, so re-read and proceed as the existing-
          // user path. We surface NO one-time password (this call did not create the account and must
          // never reset an existing user's credential). createUser is a standalone statement (no open
          // transaction), so the 23505 does not poison a tx — the re-read is safe.
          if (!isUniqueViolation(err)) throw err;
          const raced = await deps.identityStore.findUserByEmail(email);
          if (!raced) throw err; // not the expected unique-violation race — surface the original error
          userId = raced.id;
        }
      }
      const { role, activated } = await deps.orgStore.addMember(orgId, userId);

      await deps.auditStore.append(
        {
          event: 'org_member_add',
          actorUserId: principal.userId,
          actorOrgId: orgId,
          meta: { targetUserId: userId, provisioned: oneTimePassword !== undefined, activated },
        },
        c.get('requestId'),
      );
      const resp: AddOrgMemberResponse = {
        userId,
        email,
        role: roleOf(role),
        ...(oneTimePassword ? { oneTimePassword } : {}),
      };
      // 201 when this call added/activated the membership; 200 on an idempotent no-op (already a member).
      return c.json(resp, activated ? 201 : 200);
    },
  );

  // GET /v1/orgs/:orgId/members — list the org's active members (id + email + role). Read auth mirrors
  // the org-read routes (owner|admin|member may list); resolveTenant scopes it to the caller's org so
  // it cannot leak across tenants.
  app.get(
    '/v1/orgs/:orgId/members',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'org:read'),
    async (c) => {
      const orgId = c.get('tenantId');
      if (!orgId) throw new ApiError('NOT_FOUND', 'Not found.');
      const members = await deps.orgStore.listMembers(orgId);
      const resp: OrgMemberListResponse = {
        members: members.map((m) => ({ userId: m.userId, email: m.email, role: roleOf(m.role) })),
      };
      return c.json(resp, 200);
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
      // Fallback `undefined` (NOT `{}`): an empty or unparseable body must be a 400 VALIDATION_ERROR,
      // not a silent scopeless mint. `readBoundedJson` returns the fallback for an empty OR malformed
      // body, so a `{}` fallback would parse to `{ scopes: [] }` and mint a real (dead) scopeless key
      // on no input at all. `undefined` makes `MintApiKeyRequest.parse` reject it — the same 400 the
      // sibling create/role/member routes return for a missing required body. An over-cap body still
      // 413s first, and an EXPLICIT `{}` body is a deliberate scopeless mint and stays valid.
      const rawBody = await readBoundedJson(c, deps.maxJsonBodyBytes, undefined);
      const body = MintApiKeyRequest.parse(rawBody);

      // Idempotency-Key: TENANT-SCOPED, EXACTLY-ONCE mint via reserve-before-mint (the run-core
      // lesson — the reservation carries the tenant predicate via forTenant). A single atomic
      // INSERT ... ON CONFLICT DO NOTHING RETURNING on UNIQUE(tenant,scope,key) lets EXACTLY ONE of N
      // concurrent same-key callers WIN the reservation and mint; the rest replay the winner's key
      // (200) or 409. Same key+diff body → 409 IDEMPOTENCY_CONFLICT. Stored in the tenant-scoped
      // idempotency_keys table.
      //
      // KILL-TRIGGER closure: NO snapshot ever carries the plaintext secret — the reservation holds a
      // NON-SECRET placeholder ({status:'pending'}) and is finalized to redacted metadata
      // ({id, keyPrefix, scopes, replayed:true}); the snapshot column is jsonb with no TTL, so a DB
      // dump must not yield a usable `<prefix>.<secret>`. The plaintext is shown EXACTLY ONCE on the
      // original mint below; a replay returns only the redacted metadata with the secret OMITTED. A
      // retry therefore does NOT re-reveal the secret (a client that lost the original 201 response
      // must mint a NEW key) — documented replay semantics.
      const idemKey = c.req.header('idempotency-key');
      const bodyHash = hashBody(rawBody);
      if (idemKey) {
        // Reserve BEFORE the side effects: on a win WE own the reservation and mint under it; on a
        // loss a prior/concurrent caller owns it and we MUST NOT mint a second key.
        const reservation = await deps.idempotency.reserve(
          orgId,
          'apikey:mint',
          idemKey,
          bodyHash,
          {
            status: 'pending',
          },
        );
        if (!reservation.won) {
          const existing = reservation.existing;
          if (existing && existing.bodyHash !== bodyHash) {
            throw new ApiError(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency-Key reused with a different body.',
            );
          }
          // Same body: replay the winner's key IF it has finalized (its snapshot carries the id);
          // otherwise the winner is STILL minting (a true concurrent collision) → a clean 409, and
          // the loser never mints a second key.
          const snapshot = existing?.snapshot as MintApiKeyReplay | undefined;
          if (snapshot?.id) {
            return c.json(snapshot, 200);
          }
          throw new ApiError(
            'IDEMPOTENCY_CONFLICT',
            'An API-key mint is already in progress for this Idempotency-Key.',
          );
        }
        // reservation.won === true → fall through and mint under the reservation we own.
      }

      const pepper = getApiKeyPepper();
      let minted: ReturnType<typeof mintApiKey>;
      let row: Awaited<ReturnType<typeof deps.apiKeyStore.mint>>;
      try {
        minted = mintApiKey(pepper);
        row = await deps.apiKeyStore.mint({
          orgId,
          keyPrefix: minted.prefix,
          keyHash: minted.hash,
          scopes: body.scopes,
          createdBy: principal.userId,
        });
      } catch (err) {
        // A mint THROW releases the reservation so the key stays RE-RUNNABLE — a client whose mint
        // failed can retry under the same key. This catch deliberately wraps ONLY the mint: a throw
        // from the post-commit finalize/audit below is NOT released (it leaves the reservation as an
        // in-progress 409 for retries, never a duplicate mint).
        //
        // HONEST caveat — this is exactly-once EXCEPT for one rare ambiguous outcome. apiKeyStore.mint
        // is a single INSERT ... RETURNING, and the driver rejects its promise if the connection drops
        // AFTER the server commits the row but BEFORE the RETURNING result is read (an in-doubt commit).
        // In that window we release a reservation whose row DID commit, so a same-key retry can mint a
        // SECOND row. That second key is DORMANT and NOT authenticatable — its plaintext was never
        // returned to any client — so it is a benign correctness residual, not a usable-credential leak,
        // and it is strictly better than the pre-fix behaviour (which duplicated a USABLE key on ANY
        // mint throw). The closest structural analog, the run-enqueue path, closes this by probing for
        // the row's presence before releasing; a probe-before-release here is a possible future
        // hardening (NOT implemented — it would trade the benign dormant orphan for a stuck in-progress
        // 409 on the genuinely-failed-mint retry).
        if (idemKey) await deps.idempotency.release(orgId, 'apikey:mint', idemKey).catch(() => {});
        throw err;
      }
      const resp: MintApiKeyResponse = {
        id: row.id,
        keyPrefix: row.keyPrefix,
        plaintext: minted.plaintext, // shown ONCE
        scopes: body.scopes,
      };
      if (idemKey) {
        // Finalize the reservation WE already won with the REDACTED metadata — NEVER the plaintext
        // (kill-trigger closure). The row already exists (we won the reserve), so this is an UPDATE,
        // not a second insert — the earlier find-then-record concurrent orphan window (two usable keys,
        // one replayable snapshot) is structurally gone (modulo the rare in-doubt-commit residual noted
        // in the catch above).
        const redacted: MintApiKeyReplay = {
          id: row.id,
          keyPrefix: row.keyPrefix,
          scopes: body.scopes,
          replayed: true,
        };
        await deps.idempotency.updateSnapshot(orgId, 'apikey:mint', idemKey, redacted);
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

export function requireBearerForMutation(): MiddlewareHandler<AppEnv> {
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

/**
 * A fixed argon2id hash to verify against so member-add's existing-user branch performs the SAME
 * argon2id work as the new-user provisioning branch (which runs `hashPassword` on the one-time
 * password). Without it, an already-registered email would return measurably faster — a timing side-
 * channel on top of the (accepted) response-shape account-existence oracle. Mirrors the dummy-argon2id
 * enumeration defense in auth-service.ts: the hash is computed once; the per-request cost is the
 * constant-work verify.
 */
let DUMMY_PROVISION_HASH: string | undefined;
async function equalizeProvisionTiming(): Promise<void> {
  if (!DUMMY_PROVISION_HASH) {
    DUMMY_PROVISION_HASH = await hashPassword('provision-timing-equalizer-never-matches');
  }
  await verifyPassword(DUMMY_PROVISION_HASH, 'provision-timing-equalizer-presented-never-matches');
}

/** Opaque hash of an attempted cross-tenant target org (never a target-org FK). Mirrors middleware.ts. */
function hashTarget(target: string): string {
  return createHash('sha256').update(`org:${target}`).digest('hex');
}

function roleOf(role: string): 'owner' | 'admin' | 'member' {
  return role === 'owner' || role === 'admin' ? role : 'member';
}
