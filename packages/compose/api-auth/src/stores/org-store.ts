/**
 * Org store — orgs + the org↔user membership edge (GLOBAL/auth tables).
 *
 * WHITELISTED global-table module: orgs/memberships have no tenant_id column (orgs.id IS the
 * tenant_id), so they are reached via the injected raw Db, not forTenant(). Org CREATE makes the
 * caller an OWNER membership in one transaction; the last-owner invariant is enforced here.
 */
import type { Role } from '@rayspec/auth-core';
import type { Db } from '@rayspec/db';
import { schema } from '@rayspec/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ageInDays } from '../cleanup/retention.js';

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
}

export class OrgStore {
  constructor(private readonly db: Db) {}

  /**
   * Create an org + the caller's OWNER membership in ONE transaction (org.id becomes tenant_id).
   * Throws on a slug collision (the partial unique lower(slug) index). Returns the new org.
   */
  async createOrgWithOwner(input: {
    name: string;
    slug: string;
    ownerUserId: string;
  }): Promise<OrgRow> {
    return this.db.transaction(async (tx) => {
      const orgs = await tx
        .insert(schema.orgs)
        .values({ name: input.name, slug: input.slug })
        .returning();
      const org = orgs[0] as OrgRow;
      await tx
        .insert(schema.memberships)
        .values({ orgId: org.id, userId: input.ownerUserId, role: 'owner', status: 'active' });
      return org;
    });
  }

  /** Orgs the user is an active member of, with the caller's role in each. */
  async orgsForUser(userId: string): Promise<(OrgRow & { role: string })[]> {
    const rows = await this.db
      .select({
        id: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.orgs, eq(schema.memberships.orgId, schema.orgs.id))
      .where(
        and(
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.status, 'active'),
          isNull(schema.memberships.deletedAt),
          isNull(schema.orgs.deletedAt),
        ),
      );
    return rows as (OrgRow & { role: string })[];
  }

  async findById(orgId: string): Promise<OrgRow | undefined> {
    const rows = await this.db
      .select({ id: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug })
      .from(schema.orgs)
      .where(and(eq(schema.orgs.id, orgId), isNull(schema.orgs.deletedAt)))
      .limit(1);
    return rows[0] as OrgRow | undefined;
  }

  /** Count active OWNER memberships in an org (the last-owner invariant). */
  async ownerCount(orgId: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.orgId, orgId),
          eq(schema.memberships.role, 'owner'),
          eq(schema.memberships.status, 'active'),
          isNull(schema.memberships.deletedAt),
        ),
      );
    return rows.length;
  }

  /**
   * Change an ACTIVE member's role, refusing to demote the LAST owner (invariant). Returns a typed
   * outcome the route maps to HTTP: 'not_found' (no active membership), 'last_owner' (would leave
   * the org ownerless), or 'ok'. The owner count is read INSIDE the transaction so a concurrent
   * demotion cannot race the org into an ownerless state.
   */
  async setRole(
    orgId: string,
    userId: string,
    role: Role,
  ): Promise<'ok' | 'not_found' | 'last_owner'> {
    return this.db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.orgId, orgId),
            eq(schema.memberships.userId, userId),
            eq(schema.memberships.status, 'active'),
            isNull(schema.memberships.deletedAt),
          ),
        )
        .limit(1);
      const row = current[0];
      if (!row) return 'not_found';
      if (row.role === 'owner' && role !== 'owner') {
        const owners = await tx
          .select()
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.orgId, orgId),
              eq(schema.memberships.role, 'owner'),
              eq(schema.memberships.status, 'active'),
              isNull(schema.memberships.deletedAt),
            ),
          );
        if (owners.length <= 1) return 'last_owner';
      }
      await tx
        .update(schema.memberships)
        .set({ role })
        .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)));
      return 'ok';
    });
  }

  /**
   * Remove (soft-delete) an ACTIVE member, refusing to remove the LAST owner (invariant). Same
   * typed outcome as setRole. Soft-delete sets status='revoked' + deleted_at so the live-membership
   * check denies the removed principal on the next sensitive op (tombstone).
   */
  async removeMember(orgId: string, userId: string): Promise<'ok' | 'not_found' | 'last_owner'> {
    return this.db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.orgId, orgId),
            eq(schema.memberships.userId, userId),
            eq(schema.memberships.status, 'active'),
            isNull(schema.memberships.deletedAt),
          ),
        )
        .limit(1);
      const row = current[0];
      if (!row) return 'not_found';
      if (row.role === 'owner') {
        const owners = await tx
          .select()
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.orgId, orgId),
              eq(schema.memberships.role, 'owner'),
              eq(schema.memberships.status, 'active'),
              isNull(schema.memberships.deletedAt),
            ),
          );
        if (owners.length <= 1) return 'last_owner';
      }
      await tx
        .update(schema.memberships)
        .set({ status: 'revoked', deletedAt: new Date() })
        .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)));
      return 'ok';
    });
  }

  // GDPR hard-delete purge — MEMBERSHIP tombstones -----
  //
  // `removeMember` (above) soft-deletes a membership (status='revoked' + deleted_at). The GDPR retention
  // contract then HARD-DELETES that tombstone once it is older than retention. Unlike the USER reaper
  // (flat default — a user has no single org), a MEMBERSHIP belongs to exactly one org, so its retention
  // is that org's `orgs.retention_days` if set, ELSE the flat default. The cutoff is therefore PER-ROW:
  // `deleted_at < now - (COALESCE(org.retention_days, default) days)`. We compute it in SQL by joining the
  // membership to its org so each row is compared against its own org's window.
  //
  // GLOBAL-TABLE / NOT forTenant (the reconciliation): `memberships` carries `org_id` but NO
  // `tenant_id` column, so it is not in TENANT_SCOPED_TABLES and is reached via the raw injected `this.db`
  // — the same whitelisted global-table-module pattern `removeMember`/`deleteUser` use. The per-row org
  // join IS the org predicate (each row's retention is decided by its own org); there is no tenant column
  // to predicate on. `defaultRetentionDays` is the orchestrator's flat fallback for an org with NULL
  // `retention_days`. `now` is passed so the count and the delete share one clock (agree by construction).
  //
  // SCOPE NOTE (the org-tombstone→cascade arm): a hard-delete of an ORG tombstone (which would cascade
  // its whole tenant) is OUT OF SCOPE for — there is NO org-soft-delete WRITER today (orgs.deleted_at is
  // a reserved column with no setter). When an org-delete writer ships, the reserved extension is to add
  // an org-tombstone reaper here mirroring these two methods (count + cascade-delete by orgs.deleted_at).
  // NOT built — documented so the gap is a known reserved seam, not a silent omission.

  /**
   * DRY-RUN count of MEMBERSHIP tombstones eligible for hard-delete, honoring per-org retention:
   * `m.deleted_at IS NOT NULL AND m.deleted_at < now - (effectiveRetentionDays * INTERVAL '86400 seconds')`.
   * ZERO deletes. Returns the count + the oldest eligible tombstone's age in whole days (0 when none). A
   * membership of an org whose retention window EXCEEDS the tombstone's age is NOT counted (its org keeps
   * it longer). The default is bound as a parameter (never string-interpolated).
   *
   * Fail-closed retention resolution (irreversible-delete safety): a NULL OR NEGATIVE per-org
   * `retention_days` falls back to `defaultRetentionDays` — NEVER a smaller/aggressive (future-cutoff)
   * window — so an invalid/negative column can never over-purge fresh tombstones (zero stays zero =
   * purge-eligible-now, a deliberate operator choice). The `INTERVAL '86400 seconds'` is a FIXED-second
   * duration (not the DST/wall-clock-aware `INTERVAL '1 day'`), keeping this cutoff DST-independent and
   * consistent with the user reaper's fixed-ms `MS_PER_DAY` regardless of the Postgres session timezone.
   */
  async countPurgeableMembershipTombstones(
    now: Date,
    defaultRetentionDays: number,
  ): Promise<{ count: number; oldestAgeDays: number }> {
    const rows = (await this.db.execute(sql`
      SELECT
        count(*)::int AS count,
        min(m.deleted_at) AS oldest
      FROM ${schema.memberships} m
      INNER JOIN ${schema.orgs} o ON o.id = m.org_id
      WHERE m.deleted_at IS NOT NULL
        AND m.deleted_at < ${now.toISOString()}::timestamptz - ((CASE WHEN o.retention_days IS NULL OR o.retention_days < 0 THEN ${defaultRetentionDays} ELSE o.retention_days END) * INTERVAL '86400 seconds')
    `)) as unknown as Array<{ count: number; oldest: Date | string | null }>;
    const count = Number(rows[0]?.count ?? 0);
    const oldestRaw = rows[0]?.oldest ?? null;
    const oldest = oldestRaw == null ? null : new Date(oldestRaw);
    return { count, oldestAgeDays: oldest ? ageInDays(oldest, now) : 0 };
  }

  /**
   * HARD-DELETE every MEMBERSHIP tombstone older than its org's retention window (per-org `retention_days`
   * else `defaultRetentionDays`). IRREVERSIBLE — the orchestrator calls this ONLY when the operator gate
   * is explicitly ON. Returns the number of membership rows hard-deleted. (Memberships of an ALREADY
   * hard-deleted user are gone via the user-delete FK cascade; this reaps the tombstones `removeMember`
   * left on a still-live user.) The DELETE..USING joins each membership to its org so the per-org cutoff is
   * applied per row; the default is a bound parameter (no string interpolation of the value).
   *
   * Fail-closed retention resolution (irreversible-delete safety): a NULL OR NEGATIVE per-org
   * `retention_days` falls back to `defaultRetentionDays` — NEVER a smaller/aggressive (future-cutoff)
   * window — so an invalid/negative column can never over-purge fresh tombstones (zero stays zero =
   * purge-eligible-now, a deliberate operator choice). The `INTERVAL '86400 seconds'` is a FIXED-second
   * duration (not the DST/wall-clock-aware `INTERVAL '1 day'`), keeping this cutoff DST-independent and
   * consistent with the user reaper's fixed-ms `MS_PER_DAY` regardless of the Postgres session timezone.
   */
  async hardDeletePurgeableMembershipTombstones(
    now: Date,
    defaultRetentionDays: number,
  ): Promise<number> {
    const rows = (await this.db.execute(sql`
      DELETE FROM ${schema.memberships} m
      USING ${schema.orgs} o
      WHERE o.id = m.org_id
        AND m.deleted_at IS NOT NULL
        AND m.deleted_at < ${now.toISOString()}::timestamptz - ((CASE WHEN o.retention_days IS NULL OR o.retention_days < 0 THEN ${defaultRetentionDays} ELSE o.retention_days END) * INTERVAL '86400 seconds')
      RETURNING m.id
    `)) as unknown as Array<{ id: string }>;
    return rows.length;
  }

  /** Build a slug from a name (lowercase, hyphenate) + a short disambiguator if needed. */
  async deriveUniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize('NFKC')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 180) || 'org';
    // Find existing slugs that collide on the base (lower).
    const existing = await this.db
      .select({ slug: schema.orgs.slug })
      .from(schema.orgs)
      .where(inArray(sql`lower(${schema.orgs.slug})`, [base]));
    if (existing.length === 0) return base;
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
