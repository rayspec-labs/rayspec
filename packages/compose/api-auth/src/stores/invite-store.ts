/**
 * Invite store — the out-of-band org-invite token issue / resolve / consume paths.
 *
 * TENANT-SCOPED TABLE, MOSTLY-CHOKEPOINT: `invites` is registered in CORE_TENANT_SCOPED_TABLES, so
 * the ISSUE (create) and CONSUME (single-use stamp) writes go through the `forTenant(db, tenantId)`
 * CHOKEPOINT — the tenant predicate is injected structurally and a consume can only ever touch THIS
 * tenant's invite row.
 *
 * WHITELISTED for the ONE tenant-agnostic operation: `resolveByToken` — the redeem lookup — must find
 * the invite by its opaque token BEFORE any tenant is known (the presented token is the only thing the
 * redeemer holds; the org is resolved FROM the token). That is a hash-equality lookup on the unique
 * `token_hash` index via the raw injected Db — structurally identical to api-key / session bearer
 * resolution (both of which are whitelisted global-table modules). Every WRITE stays tenant-scoped
 * through `forTenant`; only this resolution read touches the raw handle, hence this file's entry on the
 * tenant-chokepoint gate's UNSCOPED_WHITELIST.
 *
 * HASHES ONLY: only the HMAC `token_hash` of the opaque invite token is stored (plaintext shown ONCE
 * at issue, conveyed out-of-band). No HTTP / Hono type appears here — pure DB + neutral row shapes.
 */
import { hashInviteToken } from '@rayspec/auth-core';
import type { Db, TenantDb } from '@rayspec/db';
import { forTenant, schema } from '@rayspec/db';
import { and, eq, gt, isNull } from 'drizzle-orm';

/**
 * Resolve the tenant-scoped handle a write runs on: the caller's transaction when one is supplied,
 * otherwise a fresh `forTenant` binding — the expression every method here compiled to before the
 * transaction parameter existed, so an omitted `tx` is byte-for-byte the previous behaviour.
 *
 * A supplied transaction bound to a DIFFERENT tenant is refused rather than trusted. `TenantDb` injects
 * its predicate structurally, so a mismatched handle would write a correctly-scoped row under the
 * WRONG tenant and look entirely healthy doing it; the tenant id a caller names and the one their
 * transaction carries must be the same claim.
 */
function scopeFor(db: Db, tenantId: string, tx?: TenantDb): TenantDb {
  if (tx === undefined) return forTenant(db, tenantId);
  if (tx.tenantId !== tenantId) {
    throw new Error(
      'InviteStore: the supplied transaction is bound to a different tenant than the one named. ' +
        'Fail-closed.',
    );
  }
  return tx;
}

/** A resolved invite (the redeem lookup result) — enough to validate + attach membership. */
export interface ResolvedInvite {
  id: string;
  /** The org (tenant) the invite grants membership in — resolved FROM the token, never a URL. */
  tenantId: string;
  /** The NORMALIZED invited email. */
  email: string;
  /** The role to grant (owner|admin|member). */
  role: string;
  expiresAt: Date;
  /** Single-use marker — NON-null means the invite was already redeemed. */
  consumedAt: Date | null;
}

export class InviteStore {
  constructor(private readonly db: Db) {}

  /**
   * ISSUE an invite for `email` + `role`, expiring at `expiresAt`. Tenant-scoped via forTenant (the
   * tenant_id is auto-stamped). Stores only the token HASH; the plaintext is minted + returned to the
   * owner by the route (shown once). Returns the new invite id.
   *
   * `tx` lets the insert JOIN a transaction the caller already holds, which is what the operator
   * provisioning path needs: it writes the owner invite in the SAME transaction as the org row, so an
   * org and the credential that makes it claimable commit together or not at all. Omitted — every
   * shipped call site — the handle is the same fresh `forTenant` binding as before.
   *
   * `createdBy` is `string | null` because `invites.created_by` is a nullable column carrying no
   * `.references()`: an invite written by an operator holding the database, rather than by a
   * principal, has no user to name and a fabricated one would be a lie in the audit trail.
   */
  async create(
    tenantId: string,
    input: {
      tokenHash: string;
      email: string;
      role: string;
      expiresAt: Date;
      createdBy: string | null;
    },
    tx?: TenantDb,
  ): Promise<{ id: string }> {
    const rows = (await scopeFor(this.db, tenantId, tx)
      .insert(schema.invites, {
        tokenHash: input.tokenHash,
        email: input.email,
        role: input.role,
        expiresAt: input.expiresAt,
        createdBy: input.createdBy,
      })
      .returning({ id: schema.invites.id })) as Array<{ id: string }>;
    return rows[0] as { id: string };
  }

  /**
   * RESOLVE a presented plaintext invite token to its invite row (the redeem lookup). Tenant-agnostic
   * by necessity — the token is the ONLY thing the redeemer holds — so it is a hash-equality lookup on
   * the unique `token_hash` index via the raw injected Db (the whitelisted bearer-resolution seam). The
   * org is read FROM the row. Returns undefined for an unknown token (no existence leak). Validation
   * (expiry / consumed) is the caller's job on the returned row.
   */
  async resolveByToken(presentedToken: string): Promise<ResolvedInvite | undefined> {
    const tokenHash = hashInviteToken(presentedToken);
    const rows = await this.db
      .select()
      .from(schema.invites)
      .where(eq(schema.invites.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0] as typeof schema.invites.$inferSelect | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    };
  }

  /**
   * The tenant's OUTSTANDING invite for `role` — still unconsumed and not yet expired — or undefined.
   *
   * This is the read that makes an idempotent provisioning run idempotent: a second run finds the
   * invite the first run minted and reports it instead of minting another, so the caller never has to
   * supply a secret (or remember one) to make a retry converge. Tenant-scoped through `TenantDb.select`,
   * which injects the tenant predicate structurally, and it returns NO token material — only the
   * invite's id, the address it was minted for, and when it lapses.
   */
  async findLiveUnconsumed(
    tenantId: string,
    role: string,
    now: Date,
    tx?: TenantDb,
  ): Promise<{ id: string; email: string; expiresAt: Date } | undefined> {
    const rows = (await scopeFor(this.db, tenantId, tx)
      .select(schema.invites)
      .where(
        and(
          eq(schema.invites.role, role),
          isNull(schema.invites.consumedAt),
          gt(schema.invites.expiresAt, now),
        ),
      )) as Array<typeof schema.invites.$inferSelect>;
    const row = rows[0];
    if (!row) return undefined;
    return { id: row.id, email: row.email, expiresAt: row.expiresAt };
  }

  /**
   * CONSUME an invite (the single-use gate) — one ATOMIC tenant-scoped UPDATE stamping `consumed_at`
   * ONLY on a row that is still unconsumed (`consumed_at IS NULL`). The `RETURNING` row set is the
   * ground truth: EXACTLY ONE of N concurrent redeems of the same token wins (its UPDATE matches the
   * still-null row); the rest match zero rows. Returns true iff THIS call consumed the invite. The
   * tenant predicate is injected by the chokepoint (a consume can never touch another tenant's row).
   *
   * `tx` exists so a re-issue can REVOKE the outstanding invite inside the same locked transaction
   * that writes its replacement, keeping "at most one live owner invite" true at every instant rather
   * than only between calls. Omitted — both shipped call sites — the UPDATE is exactly as before.
   */
  async consume(
    tenantId: string,
    inviteId: string,
    at: Date = new Date(),
    tx?: TenantDb,
  ): Promise<boolean> {
    const rows = (await scopeFor(this.db, tenantId, tx)
      .update(schema.invites, { consumedAt: at })
      .where(and(eq(schema.invites.id, inviteId), isNull(schema.invites.consumedAt)))
      .returning({ id: schema.invites.id })) as Array<{ id: string }>;
    return rows.length > 0;
  }
}
