/**
 * Identity store — data access for the GLOBAL/auth tables (users, sessions, memberships).
 *
 * WHITELISTED global-table module: these tables have NO tenant_id column (users are
 * global principals; sessions/memberships are keyed by user+org but are auth-plane state), so
 * they are reached via the raw, INJECTED Drizzle handle — NOT through forTenant() (which only
 * auto-scopes the run-journal tables in TENANT_SCOPED_TABLES). The chokepoint gate whitelists
 * this file precisely because it is one of the reviewed global-table modules.
 *
 * No HTTP / Hono / SDK type appears here — pure DB + neutral row shapes.
 */
import type { Db } from '@rayspec/db';
import { schema } from '@rayspec/db';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { ageInDays } from '../cleanup/retention.js';

export interface UserRow {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  passwordHash: string | null;
}

export interface SessionRow {
  id: string;
  userId: string;
  currentOrgId: string | null;
  tokenHash: string;
  familyId: string;
  rotatedAt: Date | null;
  replacedBy: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  /** WHY a revoked session was revoked: 'logout' (benign) | 'reuse' (token theft). NULL if live. */
  revokedReason: string | null;
}

export interface MembershipRow {
  id: string;
  orgId: string;
  userId: string;
  role: string;
  status: string;
}

export class IdentityStore {
  constructor(private readonly db: Db) {}

  // ---- users -------------------------------------------------------------------------------

  /** Find a non-deleted user by NORMALIZED email (caller normalizes first). */
  async findUserByEmail(normalizedEmail: string): Promise<UserRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(
        and(eq(sql`lower(${schema.users.email})`, normalizedEmail), isNull(schema.users.deletedAt)),
      )
      .limit(1);
    return rows[0] as UserRow | undefined;
  }

  async findUserById(id: string): Promise<UserRow | undefined> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return rows[0] as UserRow | undefined;
  }

  /** Insert a user with a NORMALIZED email + argon2id hash. Returns the new id. */
  async createUser(normalizedEmail: string, passwordHash: string): Promise<UserRow> {
    const rows = await this.db
      .insert(schema.users)
      .values({ email: normalizedEmail, passwordHash })
      .returning();
    return rows[0] as UserRow;
  }

  /** Upgrade-on-login: replace the stored hash (argon2id param bump). */
  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
  }

  /**
   * GDPR user delete — a security boundary, not just an FK cascade.
   *
   * Soft-delete TOMBSTONE + PII scrub + credential revocation, in ONE transaction:
   *  - SCRUB the email to an opaque, unique tombstone (`deleted+<id>@invalid`) and null the
   *    password hash — so a DB dump after erasure yields no PII and the partial-unique email index
   *    (WHERE deleted_at IS NULL) frees the address for re-registration;
   *  - stamp `deleted_at` (the tombstone the deferred purge executor later hard-deletes);
   *  - REVOKE every session for the user (the cookie/refresh credential dies immediately);
   *  - SOFT-DELETE the user's memberships (live-membership authz then denies them everywhere);
   *  - REVOKE every PERSONAL api-key the user minted (`api_keys.created_by = userId`) — these have
   *    NO FK to users, so a user delete would otherwise leave a live credential the user owned.
   * The append-only auth_audit/journal retain only hashes/metadata (untouched here).
   */
  async deleteUser(userId: string): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({
          email: `deleted+${userId}@invalid`,
          passwordHash: null,
          deletedAt: now,
        })
        .where(eq(schema.users.id, userId));
      await tx
        .update(schema.sessions)
        .set({ revokedAt: now, revokedReason: 'user_deleted' })
        .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
      await tx
        .update(schema.memberships)
        .set({ status: 'revoked', deletedAt: now })
        .where(and(eq(schema.memberships.userId, userId), isNull(schema.memberships.deletedAt)));
      // Personal api-keys (created_by has no FK to users) — revoke so no credential outlives the user.
      await tx
        .update(schema.apiKeys)
        .set({ revokedAt: now })
        .where(and(eq(schema.apiKeys.createdBy, userId), isNull(schema.apiKeys.revokedAt)));
    });
  }

  // GDPR hard-delete purge (the scheduled tombstone reaper) ---
  //
  // The soft-delete `deleteUser` above creates a TOMBSTONE (`users.deleted_at` stamped, PII scrubbed).
  // The GDPR retention contract then HARD-DELETES that tombstone once it is older than
  // the retention window — the irreversible erasure. These two methods are the COUNT (dry-run, zero
  // deletes) and DELETE halves the scheduled cleanup orchestrator drives; the GATE (the env flag that
  // decides which half runs) lives in the orchestrator (`cleanup.ts`), NOT here — a store method just
  // exposes the capability; it never decides policy.
  //
  // GLOBAL-TABLE / NOT forTenant (the -sanctioned reconciliation — read this): `users` has NO
  // tenant_id column (a user is a GLOBAL principal spanning orgs — schema.ts), so it is NOT in
  // TENANT_SCOPED_TABLES and is UNREACHABLE through the `forTenant`/`TenantDb` chokepoint by design. It
  // is therefore reached via the raw, INJECTED `this.db` — the EXACT whitelisted global-table-module
  // pattern the soft-delete `deleteUser` already uses (this file is on the chokepoint gate whitelist for
  // precisely that reason). The platform's "tenant-predicated chokepoint" invariant assumed tenant-scoped
  // product tables; the actual tombstone is on a GLOBAL table, so the sanctioned global-module pattern is
  // the correct (and only) seam — not a tenant predicate that cannot exist on a tenant-less table.
  //
  // RETENTION: USER tombstones use the FLAT default cutoff (a user has no single org, so no per-org
  // `orgs.retention_days` override applies — that override is honored for MEMBERSHIP tombstones in
  // OrgStore). The cutoff is computed by the orchestrator and passed in as an absolute timestamp so the
  // count and the delete agree by construction (one cutoff, derived once).

  /**
   * DRY-RUN count of USER tombstones eligible for hard-delete: `deleted_at IS NOT NULL AND deleted_at <
   * cutoff` (strictly OLDER than the retention cutoff — a tombstone exactly at/younger than the cutoff is
   * NOT yet purgeable). ZERO deletes. Also returns the age (in whole days) of the OLDEST such tombstone
   * (0 when none) so the scheduler can log "would purge N, oldest M days". The age is computed against the
   * passed `now` (the SAME clock the orchestrator derived `cutoff` from) so the reported age is exact +
   * deterministic. A tombstone is identified by `deleted_at IS NOT NULL` (the soft-delete stamps it); a
   * live user (`deleted_at IS NULL`) is never counted.
   */
  async countPurgeableUserTombstones(
    cutoff: Date,
    now: Date,
  ): Promise<{ count: number; oldestAgeDays: number }> {
    const rows = (await this.db
      .select({
        count: sql<number>`count(*)::int`,
        oldest: sql<Date | null>`min(${schema.users.deletedAt})`,
      })
      .from(schema.users)
      .where(and(isNotNull(schema.users.deletedAt), lt(schema.users.deletedAt, cutoff)))) as Array<{
      count: number;
      oldest: Date | string | null;
    }>;
    const count = rows[0]?.count ?? 0;
    const oldest = rows[0]?.oldest ?? null;
    return { count, oldestAgeDays: oldest ? ageInDays(oldest, now) : 0 };
  }

  /**
   * HARD-DELETE every USER tombstone strictly older than `cutoff` (`deleted_at IS NOT NULL AND deleted_at
   * < cutoff`). IRREVERSIBLE — the orchestrator calls this ONLY when the operator gate is explicitly ON.
   * The FK cascade (`memberships`/`sessions`/`current_org_id` all `ON DELETE CASCADE` from `users.id`)
   * erases the user's downstream rows in the same statement, so a purged user's memberships disappear with
   * it (the membership reaper below only catches tombstoned memberships of a NON-deleted user). Returns the
   * number of user rows hard-deleted (for the structured result + the log line).
   */
  async hardDeletePurgeableUserTombstones(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(schema.users)
      .where(and(isNotNull(schema.users.deletedAt), lt(schema.users.deletedAt, cutoff)))
      .returning({ id: schema.users.id });
    return deleted.length;
  }

  // ---- sessions ----------------------------------------------------------------------------

  /** Create an opaque server session. The id is server-minted (defaultRandom) — no fixation. */
  async createSession(input: {
    userId: string;
    currentOrgId: string | null;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    ua?: string | null;
    ip?: string | null;
  }): Promise<SessionRow> {
    const rows = await this.db
      .insert(schema.sessions)
      .values({
        userId: input.userId,
        currentOrgId: input.currentOrgId,
        tokenHash: input.tokenHash,
        familyId: input.familyId,
        expiresAt: input.expiresAt,
        ua: input.ua ?? null,
        ip: input.ip ?? null,
      })
      .returning();
    return rows[0] as SessionRow;
  }

  /** Resolve a session by the presented secret's HASH (the indexed unique column). */
  async findSessionByTokenHash(tokenHash: string): Promise<SessionRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.tokenHash, tokenHash))
      .limit(1);
    return rows[0] as SessionRow | undefined;
  }

  async findSessionById(id: string): Promise<SessionRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .limit(1);
    return rows[0] as SessionRow | undefined;
  }

  /**
   * Rotate a session: mark the old row rotated + create the replacement in ONE transaction, so a
   * concurrent refresh cannot observe a half-rotated state. The new row inherits family + user.
   * Returns the new session row.
   */
  async rotateSession(
    old: SessionRow,
    next: {
      tokenHash: string;
      expiresAt: Date;
      currentOrgId?: string | null;
      /**
       * The instant to stamp on the OLD row's `rotatedAt` (the grace window is measured from it).
       * The caller passes it from its own time source so the stamp and the grace comparison agree;
       * defaults to the wall clock (`new Date()`) so a caller that omits it is unchanged.
       */
      rotatedAt?: Date;
    },
  ): Promise<SessionRow> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.sessions)
        .values({
          userId: old.userId,
          currentOrgId: next.currentOrgId ?? old.currentOrgId,
          tokenHash: next.tokenHash,
          familyId: old.familyId,
          expiresAt: next.expiresAt,
        })
        .returning();
      const newRow = inserted[0] as SessionRow;
      await tx
        .update(schema.sessions)
        .set({ rotatedAt: next.rotatedAt ?? new Date(), replacedBy: newRow.id })
        .where(eq(schema.sessions.id, old.id));
      return newRow;
    });
  }

  /** Revoke a single session (logout). Reason 'logout' → a benign stale-cookie refresh is NOT reuse. */
  async revokeSession(id: string, reason = 'logout'): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(eq(schema.sessions.id, id));
  }

  /** Revoke EVERY session in a refresh family (reuse-detection family revoke). Reason 'reuse'. */
  async revokeFamily(familyId: string, reason = 'reuse'): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(schema.sessions.familyId, familyId), isNull(schema.sessions.revokedAt)));
  }

  // ---- memberships -------------------------------------------------------------------------

  /** All non-deleted memberships for a user (for /me + org list). */
  async membershipsForUser(userId: string): Promise<MembershipRow[]> {
    const rows = await this.db
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, userId), isNull(schema.memberships.deletedAt)));
    return rows as MembershipRow[];
  }

  /**
   * The LIVE membership lookup for (userId, orgId) — the authoritative source for sensitive
   * authz (authz.ts MUST NOT trust the JWT claim). Returns undefined if no active membership.
   */
  async liveMembership(userId: string, orgId: string): Promise<MembershipRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.orgId, orgId),
          eq(schema.memberships.status, 'active'),
          isNull(schema.memberships.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] as MembershipRow | undefined;
  }
}
