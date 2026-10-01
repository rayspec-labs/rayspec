/**
 * Owner-recovery store — the operator's one-time way back in for an owner who holds no password.
 *
 * WHITELISTED global-table module: `owner_recovery_tokens`, `users`, `memberships` and `sessions` are
 * global tables (no `tenant_id`), reached through the injected raw Db like the api-key and session
 * paths. A token is resolved by its HMAC before any tenant is known.
 *
 * ISSUE (`issue`) is the operator's path, run with the database and the pepper in hand
 * (`rayspec tenant recover-owner`): it names one account that is an active OWNER and holds NO
 * password, replaces any token still outstanding for it, stores only the new token's HMAC and appends
 * an `owner_recovery_issued` audit row. It refuses while the environment is fenced, so a source that
 * an export fenced never gets a credential written into it. The plaintext token is returned to the
 * caller and to nobody else.
 *
 * REDEEM (`redeem`) is the owner's path (`POST /v1/auth/owner-recovery`): in one transaction it locks
 * the token row, checks it is unexpired, unconsumed and not replaced, that the account is still an
 * active owner without a password, stamps the token consumed, sets the password hash and revokes any
 * session the account still has. Exactly one of two concurrent redemptions wins the row lock and the
 * consume; the other sees a consumed token.
 */
import {
  type AuditEvent,
  hashOwnerRecoveryToken,
  mintOwnerRecoveryToken,
  verificationPeppers,
} from '@rayspec/auth-core';
import type { Db } from '@rayspec/db';
import { schema } from '@rayspec/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

/** Why an issue was refused; the operator's command reports each in its own words. */
export type OwnerRecoveryIssueRefusal =
  | 'NO_SUCH_OWNER'
  | 'AMBIGUOUS_ORGANIZATION'
  | 'PASSWORD_PRESENT'
  | 'ENVIRONMENT_FENCED';

export class OwnerRecoveryIssueError extends Error {
  constructor(
    readonly code: OwnerRecoveryIssueRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'OwnerRecoveryIssueError';
  }
}

/** What an issue produced. `token` is the only copy of the plaintext anywhere. */
export interface IssuedOwnerRecovery {
  recoveryId: string;
  userId: string;
  orgId: string;
  expiresAt: Date;
  /** Tokens for the same owner that were still outstanding and are now replaced. */
  replaced: number;
  token: string;
  audit: AuditEvent[];
}

/** A redeemed token: the owner it signed in. */
export interface RedeemedOwnerRecovery {
  recoveryId: string;
  userId: string;
  orgId: string;
  audit: AuditEvent[];
}

export class OwnerRecoveryStore {
  constructor(private readonly db: Db) {}

  /**
   * Issue a recovery token for the active owner `email` (normalized by the caller) of `orgId`, or of
   * the one organization the account owns when `orgId` is omitted. `pepper` is the pepper of the
   * deployment that will redeem it.
   */
  async issue(input: {
    email: string;
    orgId?: string;
    ttlSeconds: number;
    pepper: string;
    now?: Date;
  }): Promise<IssuedOwnerRecovery> {
    const now = input.now ?? new Date();
    return this.db.transaction(async (tx) => {
      // The fence, read with a share lock so a quiesce cannot take it before this commits.
      const [control] = (await tx.execute(
        sql`SELECT to_regclass('runtime_control_state') IS NOT NULL AS present`,
      )) as unknown as { present: boolean }[];
      if (control?.present === true) {
        const [state] = (await tx.execute(
          sql`SELECT fence_state FROM runtime_control_state WHERE id = 1 FOR SHARE`,
        )) as unknown as { fence_state: string }[];
        if (state !== undefined && state.fence_state !== 'open') {
          throw new OwnerRecoveryIssueError(
            'ENVIRONMENT_FENCED',
            'The environment is fenced (quiesced for an export, or an import target before its ' +
              'cutover), so no recovery token was issued. Issue it on the target once it serves.',
          );
        }
      }
      const owners = await tx
        .select({
          userId: schema.users.id,
          orgId: schema.memberships.orgId,
          passwordHash: schema.users.passwordHash,
        })
        .from(schema.users)
        .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
        .where(
          and(
            eq(sql`lower(${schema.users.email})`, input.email.toLowerCase()),
            isNull(schema.users.deletedAt),
            isNull(schema.memberships.deletedAt),
            eq(schema.memberships.status, 'active'),
            eq(schema.memberships.role, 'owner'),
            ...(input.orgId !== undefined ? [eq(schema.memberships.orgId, input.orgId)] : []),
          ),
        )
        .for('update', { of: schema.users });
      if (owners.length === 0) {
        throw new OwnerRecoveryIssueError(
          'NO_SUCH_OWNER',
          'No active owner with that address' +
            (input.orgId !== undefined ? ' in that organization' : '') +
            '. Owner recovery is only for an owner of an organization.',
        );
      }
      if (owners.length > 1) {
        throw new OwnerRecoveryIssueError(
          'AMBIGUOUS_ORGANIZATION',
          'That account owns more than one organization; name the one to recover with --org-id.',
        );
      }
      const owner = owners[0] as { userId: string; orgId: string; passwordHash: string | null };
      if (owner.passwordHash !== null) {
        throw new OwnerRecoveryIssueError(
          'PASSWORD_PRESENT',
          'That owner holds a password and signs in with it; owner recovery is only for an owner ' +
            'who has none (whose only credential was an API key).',
        );
      }
      const replaced = (await tx
        .update(schema.ownerRecoveryTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.ownerRecoveryTokens.userId, owner.userId),
            isNull(schema.ownerRecoveryTokens.consumedAt),
            isNull(schema.ownerRecoveryTokens.revokedAt),
            gt(schema.ownerRecoveryTokens.expiresAt, now),
          ),
        )
        .returning({ id: schema.ownerRecoveryTokens.id })) as { id: string }[];
      const { token, hash } = mintOwnerRecoveryToken(input.pepper);
      const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
      const [row] = (await tx
        .insert(schema.ownerRecoveryTokens)
        .values({
          orgId: owner.orgId,
          userId: owner.userId,
          tokenHash: hash,
          expiresAt,
          createdAt: now,
        })
        .returning({ id: schema.ownerRecoveryTokens.id })) as { id: string }[];
      const recoveryId = (row as { id: string }).id;
      const audit: AuditEvent[] = [
        {
          event: 'owner_recovery_issued',
          actorUserId: null,
          actorOrgId: owner.orgId,
          meta: {
            recoveryId,
            targetUserId: owner.userId,
            expiresAt: expiresAt.toISOString(),
            replaced: replaced.length,
            issuedBy: 'operator',
          },
        },
      ];
      // In the same transaction: a token exists exactly when its issue is on record.
      await tx.insert(schema.authAudit).values(
        audit.map((event) => ({
          actorOrgId: event.actorOrgId ?? null,
          actorUserId: event.actorUserId ?? null,
          event: event.event,
          requestId: null,
          meta: event.meta ?? {},
        })),
      );
      return {
        recoveryId,
        userId: owner.userId,
        orgId: owner.orgId,
        expiresAt,
        replaced: replaced.length,
        token,
        audit,
      };
    });
  }

  /**
   * Redeem a presented token, setting `passwordHash` (argon2id, computed by the caller) on the owner
   * it was issued for. Undefined for every token that does not redeem — unknown, expired, consumed,
   * replaced, or one whose account is no longer an active owner without a password — so the caller
   * answers all of them alike.
   */
  async redeem(
    presentedToken: string,
    passwordHash: string,
    now: Date = new Date(),
  ): Promise<RedeemedOwnerRecovery | undefined> {
    return this.db.transaction(async (tx) => {
      let found: typeof schema.ownerRecoveryTokens.$inferSelect | undefined;
      // Under the current pepper, else — during a pepper rotation — under the previous one.
      for (const pepper of verificationPeppers()) {
        const rows = await tx
          .select()
          .from(schema.ownerRecoveryTokens)
          .where(
            eq(
              schema.ownerRecoveryTokens.tokenHash,
              hashOwnerRecoveryToken(presentedToken, pepper),
            ),
          )
          .limit(1)
          .for('update');
        found = rows[0];
        if (found !== undefined) break;
      }
      if (
        found === undefined ||
        found.consumedAt !== null ||
        found.revokedAt !== null ||
        found.expiresAt.getTime() <= now.getTime()
      ) {
        return undefined;
      }
      const eligible = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
        .where(
          and(
            eq(schema.users.id, found.userId),
            isNull(schema.users.deletedAt),
            isNull(schema.users.passwordHash),
            eq(schema.memberships.orgId, found.orgId),
            isNull(schema.memberships.deletedAt),
            eq(schema.memberships.status, 'active'),
            eq(schema.memberships.role, 'owner'),
          ),
        )
        .for('update', { of: schema.users });
      if (eligible.length !== 1) return undefined;
      const consumed = await tx
        .update(schema.ownerRecoveryTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(schema.ownerRecoveryTokens.id, found.id),
            isNull(schema.ownerRecoveryTokens.consumedAt),
          ),
        )
        .returning({ id: schema.ownerRecoveryTokens.id });
      if (consumed.length !== 1) return undefined;
      await tx.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, found.userId));
      await tx
        .update(schema.sessions)
        .set({ revokedAt: now, revokedReason: 'owner-recovery' })
        .where(and(eq(schema.sessions.userId, found.userId), isNull(schema.sessions.revokedAt)));
      return {
        recoveryId: found.id,
        userId: found.userId,
        orgId: found.orgId,
        audit: [
          {
            event: 'owner_recovery_redeemed',
            actorUserId: found.userId,
            actorOrgId: found.orgId,
            meta: { recoveryId: found.id },
          },
        ],
      };
    });
  }
}
