/**
 * Org store — orgs + the org↔user membership edge (GLOBAL/auth tables).
 *
 * WHITELISTED global-table module: orgs/memberships have no tenant_id column (orgs.id IS the
 * tenant_id), so they are reached via the injected raw Db, not forTenant(). Org CREATE makes the
 * caller an OWNER membership in one transaction; the last-owner invariant is enforced here.
 *
 * `reserveOrgById` is the one method that opens its transaction through `forTenant`. It still reaches
 * `orgs`/`memberships` unscoped — that does not change — but the org being reserved IS a tenant, and
 * the callback it hands out writes TENANT-SCOPED rows (the owner invite) that must ride the chokepoint
 * in the same transaction. See its own docblock.
 */
import type { Role } from '@rayspec/auth-core';
import type { Db, TenantDb } from '@rayspec/db';
import { forTenant, schema } from '@rayspec/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ageInDays } from '../cleanup/retention.js';

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
}

/**
 * A CHOSEN org id that is already taken. Distinct from a slug collision (which the unique lower(slug)
 * index raises as a driver error) because it is the one collision an operator can act on: the id they
 * meant to deploy against is not theirs to bind. The bootstrap route maps it to a 409 — never a 500,
 * and never a silent success under a DIFFERENT id, which is the failure that would send a deployment
 * at an org it does not own.
 */
export class OrgIdInUseError extends Error {
  constructor(orgId: string) {
    super(`org id ${orgId} already exists`);
    this.name = 'OrgIdInUseError';
  }
}

/**
 * A chosen org id whose row is SOFT-DELETED. `orgs.id` is a PRIMARY KEY, so a tombstone permanently
 * occupies its id: the INSERT conflicts while `findById` (which filters `deleted_at IS NULL`) sees
 * nothing. Distinct from {@link OrgIdInUseError} so an operator is told to choose a different id
 * rather than hunting an org they cannot see. `assertProductTenantBootable` already treats a
 * tombstone as absent, so resolving one here would hand back an org the next deploy refuses.
 */
export class OrgTombstonedError extends Error {
  constructor(orgId: string) {
    super(`org id ${orgId} names a soft-deleted org`);
    this.name = 'OrgTombstonedError';
  }
}

export class OrgStore {
  /**
   * `tenantBootstrapEnabled` is the deployment's operator posture (RAYSPEC_TENANT_BOOTSTRAP_ENABLED),
   * carried HERE rather than checked per caller: org creation is this store's capability, so this is
   * the single point at which a chosen id is admitted or refused. Default `false` — a store built the
   * one-argument way (the cleanup composition, every existing suite) behaves exactly as before.
   */
  readonly tenantBootstrapEnabled: boolean;

  constructor(
    private readonly db: Db,
    opts: { tenantBootstrapEnabled?: boolean } = {},
  ) {
    this.tenantBootstrapEnabled = opts.tenantBootstrapEnabled ?? false;
  }

  /**
   * Create an org + the caller's OWNER membership in ONE transaction (org.id becomes tenant_id).
   * Throws on a slug collision (the partial unique lower(slug) index). Returns the new org.
   *
   * `id` is OPTIONAL and gated. Unset (every path but the operator bootstrap) ⇒ the INSERT names
   * name+slug only and the database generates the id via `defaultRandom()`, exactly as before. Set ⇒
   * the org row is created WITH that id — and, because the owner membership is written in the SAME
   * transaction, THIS path can never leave a memberless org behind. That matters because an org with
   * no way to grant the first membership is a permanent dead end rather than an inconvenience: on the
   * HTTP surface an invite can only be issued by an owner (`org:member:add`), so nobody is left who
   * could issue one. The operator provisioning path (`reserveOrgById`) reaches the same guarantee by
   * the other route — it writes an owner INVITE in the same transaction as the org row instead of a
   * membership — so an org is still never created without the thing that makes it claimable.
   *
   * Passing an id WITHOUT the posture is refused here rather than upstream: an org id is normally
   * server-generated and unguessable, and that unguessability is load-bearing (a deployment binds
   * `RAYSPEC_PRODUCT_TENANT_ID` to one). The refusal is the backstop under the route gate, so the
   * capability cannot be reached by a caller that simply forgot to check.
   */
  async createOrgWithOwner(input: {
    name: string;
    slug: string;
    ownerUserId: string;
    id?: string;
  }): Promise<OrgRow> {
    const chosenId = input.id;
    if (chosenId !== undefined && !this.tenantBootstrapEnabled) {
      throw new Error(
        'createOrgWithOwner: an explicit org id requires the tenant-bootstrap operator posture ' +
          '(RAYSPEC_TENANT_BOOTSTRAP_ENABLED). Fail-closed.',
      );
    }
    return this.db.transaction(async (tx) => {
      // The chosen-id INSERT alone carries `ON CONFLICT (id) DO NOTHING`, so a taken id comes back as
      // an empty RETURNING (→ OrgIdInUseError) instead of a driver 23505 that would poison the tx. The
      // no-id INSERT is untouched — including the slug collision it has always thrown.
      const orgs =
        chosenId === undefined
          ? await tx.insert(schema.orgs).values({ name: input.name, slug: input.slug }).returning()
          : await tx
              .insert(schema.orgs)
              .values({ id: chosenId, name: input.name, slug: input.slug })
              .onConflictDoNothing({ target: schema.orgs.id })
              .returning();
      const org = orgs[0] as OrgRow | undefined;
      // Only reachable on the chosen-id path: DO NOTHING swallowed the insert because the id is taken.
      // The no-id INSERT always returns its row (or throws on the slug index, as it always has).
      if (!org) throw new OrgIdInUseError(chosenId as string);
      await tx
        .insert(schema.memberships)
        .values({ orgId: org.id, userId: input.ownerUserId, role: 'owner', status: 'active' });
      return org;
    });
  }

  /**
   * CREATE-OR-RESOLVE an org under an id the operator chose — the reservation the automated
   * provisioning path is built on. Unlike `createOrgWithOwner` it creates NO user and NO membership;
   * what it takes instead is a REQUIRED `claim` callback, invoked inside the same transaction with a
   * tenant-scoped handle, the org row and the state the caller needs to decide what to write. That is
   * the invariant stated at the type level: an org id cannot be reserved without the caller being
   * asked what makes the org claimable.
   *
   * IDEMPOTENT WITHOUT A SECOND LEDGER. `orgs.id` is the PRIMARY KEY, so the database itself is the
   * single-flight point — no mapping table, no operation key beside the id. The INSERT is the SAME
   * `ON CONFLICT (id) DO NOTHING` statement the bootstrap route uses: a taken id comes back as an
   * empty RETURNING rather than a 23505 that would poison the transaction. On that resolve branch the
   * row is then re-read `FOR UPDATE`, which serializes a concurrent second caller behind the winner
   * (measured: DO NOTHING itself already waits for a conflicting uncommitted insert to commit, and the
   * follow-up read sees the winner's row) and holds the org while `claim` decides. On the created
   * branch our own uncommitted insert already holds the row exclusively for the rest of the
   * transaction, so no extra lock is taken.
   *
   * The `deleted_at` filter is deliberately ABSENT from that re-read: a tombstone must be VISIBLE
   * here. It still occupies its id, so silently treating it as a fresh reservation would hand back an
   * org that `assertProductTenantBootable` counts as absent — a deployment that provisions green and
   * then refuses to boot.
   *
   * `TenantDb.transaction` (rather than the raw handle) is what carries this: it performs the
   * transaction-handle cast internally, sets the tenant GUC transaction-locally, hands `claim` a real
   * tenant-scoped handle so a tenant-scoped write inside it rides the actual chokepoint, and — via the
   * TenantDb constructor — fail-closes on an id that is not UUID-shaped, the same rule the product
   * boot gate is held to. `orgs`/`memberships` are global tables, so the reads and the insert here go
   * through `unscoped()` exactly as the rest of this whitelisted module does.
   *
   * RETURNS the org row as the DATABASE holds it, never the operator's spelling of the id or the name
   * they passed on a resolve: `orgs.id` is a `uuid` column that matches in any letter case and answers
   * canonically, while a deployment compares its bound tenant as a string (the reason
   * `resolveLiveTenantOrgId` resolves rather than echoes). `uuidgen` prints upper case on macOS.
   */
  async reserveOrgById(
    input: { readonly id: string; readonly name: string; readonly slug: string },
    claim: (
      tx: TenantDb,
      org: OrgRow,
      state: { readonly created: boolean; readonly owners: number },
    ) => Promise<void>,
  ): Promise<{ readonly org: OrgRow; readonly created: boolean; readonly owners: number }> {
    // The same fail-closed backstop `createOrgWithOwner` carries, for the same reason: the store is the
    // single point at which a chosen id is admitted. `claim` is not invoked on this path.
    if (!this.tenantBootstrapEnabled) {
      throw new Error(
        'reserveOrgById: reserving an org under a chosen id requires the tenant-bootstrap operator ' +
          'posture (RAYSPEC_TENANT_BOOTSTRAP_ENABLED). Fail-closed.',
      );
    }
    // BIND THE CANONICAL SPELLING, not the operator's. `orgs.id` is a `uuid` column, so Postgres
    // matches an id supplied in any letter case and answers in lower case — and the shape check below
    // is case-insensitive too, so a SHOUTED id (which is what `uuidgen` prints on macOS) would
    // otherwise open a transaction whose tenant GUC, and whose handle handed to `claim`, name a
    // spelling the database never uses, while the row read back names the canonical one. Every
    // tenant-scoped write inside `claim` compares those as strings. Lower-casing is exact here rather
    // than approximate: the shape check admits only 8-4-4-4-12 hex, which is the canonical form's own
    // alphabet. A malformed id still fails closed in the TenantDb constructor, as before.
    const tenantId = input.id.toLowerCase();
    return forTenant(this.db, tenantId).transaction(async (ttx) => {
      const raw = ttx.unscoped();
      const insertedRows = await raw
        .insert(schema.orgs)
        .values({ id: tenantId, name: input.name, slug: input.slug })
        .onConflictDoNothing({ target: schema.orgs.id })
        .returning();
      const created = insertedRows.length > 0;

      let org: OrgRow;
      if (created) {
        const row = insertedRows[0] as OrgRow;
        org = { id: row.id, name: row.name, slug: row.slug };
      } else {
        const locked = (await raw
          .select({
            id: schema.orgs.id,
            name: schema.orgs.name,
            slug: schema.orgs.slug,
            deletedAt: schema.orgs.deletedAt,
          })
          .from(schema.orgs)
          .where(eq(schema.orgs.id, tenantId))
          .limit(1)
          .for('update')) as Array<OrgRow & { deletedAt: Date | null }>;
        const row = locked[0];
        // Zero rows means the winner of the conflict rolled back between our INSERT and this read. We
        // do NOT loop: a retry could spin against a caller that keeps failing, and the id genuinely was
        // taken at the moment we asked, which is what the operator needs to be told.
        if (!row) throw new OrgIdInUseError(tenantId);
        if (row.deletedAt !== null) throw new OrgTombstonedError(tenantId);
        org = { id: row.id, name: row.name, slug: row.slug };
      }

      // The active-owner count UNDER THE LOCK, with the predicate `ownerCount` uses. Read here rather
      // than by the caller so it cannot be answered outside the transaction that holds the row: it is
      // what lets a resolve refuse to grant ownership of an org that already has an owner.
      const ownerRows = await raw
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.orgId, org.id),
            eq(schema.memberships.role, 'owner'),
            eq(schema.memberships.status, 'active'),
            isNull(schema.memberships.deletedAt),
          ),
        );
      const owners = ownerRows.length;

      await claim(ttx, org, { created, owners });
      return { org, created, owners };
    });
  }

  /**
   * Idempotently add a user to an org as a plain `member` (the org is the resolved tenant). Returns
   * the effective role + whether the membership was activated by THIS call. Cases:
   *  - an ACTIVE membership already exists → an idempotent no-op: the existing role is returned
   *    UNCHANGED (never demote an owner/admin who is re-added) and `activated` is false;
   *  - a soft-deleted (revoked) tombstone exists → it is reactivated as a plain member (a
   *    previously-removed user can be re-added; the `memberships` UNIQUE(user_id, org_id) is not
   *    partial, so the tombstone occupies the slot and must be revived rather than re-inserted);
   *  - no row exists → a fresh `member` row is inserted.
   *
   * ATOMIC single-flight — one `INSERT … ON CONFLICT (user_id, org_id) DO UPDATE` statement, NOT a
   * read-then-insert: two CONCURRENT fresh adds would both read "no row" and both INSERT, the second
   * violating the non-partial UNIQUE(user_id, org_id) → 23505 → HTTP 500, breaking the promised
   * idempotency. The upsert makes the DB's own row-level atomicity the single-flight point (the
   * lesson — the platform's atomicity, not a TOCTOU read-then-insert). The role CASE preserves the
   * semantics EXACTLY: a fresh row and a reactivated TOMBSTONE become `member`, while an already-
   * ACTIVE row keeps its stored role (`deleted_at IS NULL` ⇒ an owner/admin re-add is never demoted).
   * `activated` is derived from the PRE-image (read in the SAME statement via the `prior` CTE, so
   * there is no separate read to race) so the route still returns 201 on a fresh add or a
   * reactivation and 200 on an idempotent no-op.
   */
  async addMember(orgId: string, userId: string): Promise<{ role: string; activated: boolean }> {
    const rows = (await this.db.execute(sql`
      WITH prior AS (
        SELECT ${schema.memberships.status} AS status, ${schema.memberships.deletedAt} AS deleted_at
        FROM ${schema.memberships}
        WHERE ${schema.memberships.userId} = ${userId} AND ${schema.memberships.orgId} = ${orgId}
      ),
      upserted AS (
        INSERT INTO ${schema.memberships} (user_id, org_id, role, status, deleted_at)
        VALUES (${userId}, ${orgId}, 'member', 'active', NULL)
        ON CONFLICT (user_id, org_id) DO UPDATE
          SET deleted_at = NULL,
              status = 'active',
              role = CASE
                WHEN ${schema.memberships.deletedAt} IS NOT NULL THEN 'member'
                ELSE ${schema.memberships.role}
              END
        RETURNING role
      )
      SELECT upserted.role AS role,
             (prior.status IS NULL OR prior.status <> 'active' OR prior.deleted_at IS NOT NULL) AS activated
      FROM upserted LEFT JOIN prior ON true
    `)) as unknown as Array<{ role: string; activated: boolean }>;
    const row = rows[0];
    return { role: row?.role ?? 'member', activated: row?.activated ?? true };
  }

  /**
   * Idempotently add a user to an org with a SPECIFIC role (the invite-accept path — the role the
   * owner chose at issue). Mirrors {@link addMember}'s single-statement upsert semantics EXACTLY, with
   * ONE difference: a FRESH row or a reactivated TOMBSTONE gets `role` (the invited role) instead of the
   * hardcoded `member`. An already-ACTIVE membership keeps its stored role UNCHANGED — an invite accept
   * NEVER demotes (or re-promotes) a current member (`deleted_at IS NULL` ⇒ keep the stored role), so a
   * replayed/duplicate accept is a safe no-op. `activated` is derived from the PRE-image (same-statement
   * `prior` CTE) so the route returns 201 on a fresh add/reactivation and 200 on an idempotent no-op.
   * The role is bound as a parameter (never string-interpolated). ATOMIC single-flight (the DB's
   * row-level `ON CONFLICT` atomicity is the single-flight point — no read-then-insert TOCTOU).
   */
  async addInvitedMember(
    orgId: string,
    userId: string,
    role: Role,
  ): Promise<{ role: string; activated: boolean }> {
    const rows = (await this.db.execute(sql`
      WITH prior AS (
        SELECT ${schema.memberships.status} AS status, ${schema.memberships.deletedAt} AS deleted_at
        FROM ${schema.memberships}
        WHERE ${schema.memberships.userId} = ${userId} AND ${schema.memberships.orgId} = ${orgId}
      ),
      upserted AS (
        INSERT INTO ${schema.memberships} (user_id, org_id, role, status, deleted_at)
        VALUES (${userId}, ${orgId}, ${role}, 'active', NULL)
        ON CONFLICT (user_id, org_id) DO UPDATE
          SET deleted_at = NULL,
              status = 'active',
              role = CASE
                WHEN ${schema.memberships.deletedAt} IS NOT NULL THEN ${role}
                ELSE ${schema.memberships.role}
              END
        RETURNING role
      )
      SELECT upserted.role AS role,
             (prior.status IS NULL OR prior.status <> 'active' OR prior.deleted_at IS NOT NULL) AS activated
      FROM upserted LEFT JOIN prior ON true
    `)) as unknown as Array<{ role: string; activated: boolean }>;
    const row = rows[0];
    return { role: row?.role ?? role, activated: row?.activated ?? true };
  }

  /** Active members of an org (id + email + role), joined to users; excludes soft-deleted rows. */
  async listMembers(orgId: string): Promise<{ userId: string; email: string; role: string }[]> {
    const rows = await this.db
      .select({
        userId: schema.memberships.userId,
        email: schema.users.email,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
      .where(
        and(
          eq(schema.memberships.orgId, orgId),
          eq(schema.memberships.status, 'active'),
          isNull(schema.memberships.deletedAt),
          isNull(schema.users.deletedAt),
        ),
      );
    return rows as { userId: string; email: string; role: string }[];
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
