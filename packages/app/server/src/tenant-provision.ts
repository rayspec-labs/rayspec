/**
 * OPERATOR TENANT PROVISIONING — create or resolve one organization under an id the operator chose,
 * and hand it to a human, without leaving a platform user behind and without any HTTP surface.
 *
 * THE PROBLEM THIS SOLVES. A product or cron deployment must be pointed at an organization that
 * ALREADY exists (`RAYSPEC_PRODUCT_TENANT_ID` is checked at boot and the boot refuses a phantom one),
 * while the organization service owns id generation. Automating that meant booting the auth surface
 * alone, registering a user through the public API, reading the generated id back, stopping, and
 * booting the real profile. Four steps for a one-step need — and the temporary user it registers can
 * never be removed: `removeMember` refuses to remove the last owner, and a user delete is a SOFT
 * delete that leaves a row. #197 made the id choosable, which removed half the problem; this removes
 * the other half.
 *
 * WHAT IT WRITES, AND WHAT IT DELIBERATELY DOES NOT. It writes the `orgs` row and, when an owner
 * address is supplied, ONE `role='owner'`, `created_by = NULL` invite in the SAME transaction. It
 * creates NO user and NO membership. A real human then redeems that invite through the completely
 * unmodified public `POST /v1/invites/accept`, which provisions their account with their OWN password
 * and attaches the owner membership. So the org is never memberless-and-unclaimable (the invite is
 * the claim credential, committed with the org), and it is never claimed by an account nobody asked
 * for.
 *
 * THE POSTURE WIN. The org store is constructed here with `tenantBootstrapEnabled: true`,
 * unconditionally. That is not a bypass of the operator gate — it is the recognition that this
 * caller's authority IS possession of `DATABASE_URL` and the pepper, so an environment flag would add
 * nothing a holder of the connection string could not already do. What it buys is the important part:
 * `RAYSPEC_TENANT_BOOTSTRAP_ENABLED` never has to be set in production, so `POST
 * /v1/auth/bootstrap-tenant` is never REGISTERED on a production listener at all. The capability has
 * no route in any posture; `tenant-provision-unreachable.db.test.ts` pins that on all three levels.
 *
 * SECRETS. Exactly two, both resolved by the caller through the shipped `<VAR>_FILE` convention
 * (`loadTenantProvisionSecrets`): the connection string, and the api-key pepper the invite token is
 * HMAC'd with. Not the JWT signing key — nothing here mints a JWT. The minted token itself is written
 * to a mode-600 file that is never overwritten, and it appears in no return value, no log line and no
 * audit row.
 *
 * THE ORDER IS LOAD-BEARING: mint → write the file → insert the invite → commit. Reversed, a failure
 * between the commit and the write would leave a committed invite whose token is lost while
 * `findLiveUnconsumed` blocks re-issuing it — a tenant that is silently unrecoverable. Written this
 * way, a failed write rolls the whole reservation back, and no file survives a reservation that did
 * not commit: a failure DURING the write is cleaned up by the writer (the only code that knows the
 * file exists yet), and a failure after it by this module's own tracker.
 *
 * IT APPLIES THE COMMITTED MIGRATION CHAIN. That is what makes it genuinely one step against a fresh
 * database, and it is the same idempotent chain every boot runs — but it does mean the command
 * migrates whatever `DATABASE_URL` it is pointed at. The step is serialized by an advisory lock, so
 * two runs fanned out at the same instant against an EMPTY database converge here too and not only at
 * the reservation.
 */

import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import {
  AuditStore,
  INVITE_MAX_TTL_SECONDS,
  INVITE_MIN_TTL_SECONDS,
  InviteStore,
  OrgIdInUseError,
  OrgStore,
  OrgTombstonedError,
} from '@rayspec/api-auth';
import { mintInviteToken, normalizeEmail } from '@rayspec/auth-core';
import { isUniqueViolation, makeDb } from '@rayspec/db';
import { applyMigrations } from './composition-root.js';

/** The two secrets the provisioning path uses — resolved by `loadTenantProvisionSecrets`. */
export interface TenantProvisionSecrets {
  readonly databaseUrl: string;
  readonly apiKeyPepper: string;
}

export interface TenantProvisionInput {
  /** The chosen org id — the OPERATION id. `orgs.id` is the primary key, so it is also the ledger. */
  readonly orgId: string;
  /** The organization's display name; the slug is derived from it exactly as every other path does. */
  readonly name: string;
  /** The address the owner invite is minted for. Omitted ⇒ no handoff is attempted at all. */
  readonly ownerEmail?: string;
  /** Where the minted token is written (mode 600, never overwritten). Required with `ownerEmail`. */
  readonly ownerInviteOut?: string;
  /** Invite lifetime, clamped by the SHIPPED bounds. Omitted ⇒ the operator default (1 hour). */
  readonly inviteTtlSeconds?: number;
  /** Revoke the outstanding owner invite and mint a replacement (the lost-token recovery path). */
  readonly reissueOwnerInvite?: boolean;
}

/**
 * What happened to the owner handoff. It is a closed union so every state an operator can observe is
 * named, and — the point of the shape — NONE of its members has a field that could hold a token.
 */
export type OwnerHandoff =
  | { readonly status: 'not_requested' }
  /** The org already has at least one active owner, so nothing was written. */
  | { readonly status: 'already_owned'; readonly owners: number }
  /** A live invite from an earlier run is still outstanding; this run minted nothing. */
  | {
      readonly status: 'pending';
      readonly inviteId: string;
      readonly email: string;
      readonly expiresAt: string;
    }
  /** A token was minted and written to `tokenFile`. It appears nowhere else. */
  | {
      readonly status: 'issued';
      readonly inviteId: string;
      readonly email: string;
      readonly expiresAt: string;
      readonly tokenFile: string;
    };

export interface TenantProvisionResult {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly org: 'created' | 'existing';
  readonly ownerHandoff: OwnerHandoff;
  /** The public route the invite is redeemed through — the same one every other invite uses. */
  readonly acceptPath: '/v1/invites/accept';
}

/**
 * A provisioning failure an operator can ACT on, carrying a stable machine-readable `code`. Anything
 * that is not one of these is a genuine fault and propagates unwrapped.
 */
export class TenantProvisionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TenantProvisionError';
    this.code = code;
  }
}

/**
 * The OPERATOR default owner-invite lifetime: ONE HOUR, deliberately far shorter than the HTTP
 * surface's seven days.
 *
 * The two are not the same risk. An invite issued over HTTP is shown once to a signed-in owner who
 * conveys it out of band; this one sits AT REST in a file on whichever machine ran the command, and
 * until it is consumed or expires it is a tenant-takeover credential — `/v1/invites/accept` lets any
 * holder provision the target account with a password of their choosing when that address has no
 * account yet. A provisioning run is followed within minutes by the human who asked for it, so the
 * window has no reason to be a week. `--invite-ttl-seconds` overrides it and is clamped by the SAME
 * shipped `INVITE_MIN/MAX_TTL_SECONDS` the route uses — this is a default, not a second policy.
 */
export const OPERATOR_INVITE_DEFAULT_TTL_SECONDS = 60 * 60;

/**
 * The advisory-lock the migration step serializes on. `0x72617973` is a namespace this project owns,
 * so the pair cannot collide with an unrelated application holding advisory locks on the same
 * database; slot 1 is the platform migration chain. Any pair works as long as every runner of this
 * command uses the SAME one, which is why it is a constant rather than a parameter.
 */
const MIGRATION_LOCK_NAMESPACE = 0x7261_7973;
const MIGRATION_LOCK_SLOT = 1;

/**
 * Apply the committed chain with the whole step serialized by a Postgres ADVISORY LOCK.
 *
 * The migrator takes no lock of its own, and its first two statements — `CREATE SCHEMA IF NOT EXISTS
 * "drizzle"` and `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations"` — are not
 * concurrency-safe: `IF NOT EXISTS` checks the catalogue and then creates, so two runs started
 * together against a FRESH database both see nothing and the loser dies on a duplicate-object error
 * before it ever reaches the reservation. That is precisely the shape a deploy script produces when
 * it fans out on a first bring-up, and it is the one case where "safe to call unconditionally" would
 * otherwise be false. Serialized, the loser waits, then finds the chain applied and no-ops — which is
 * what the reservation below already does, one layer down.
 *
 * The lock is transaction-scoped and the transaction does nothing else, so it is released by the
 * COMMIT — and by the connection dying, so a killed run never leaves the next one waiting. The
 * migration itself runs on a different connection of the same pool: an advisory lock is a mutex
 * between runners, not a data lock, so it blocks the other command, never our own work.
 */
async function migrateUnderLock(db: ReturnType<typeof makeDb>): Promise<void> {
  await db.$client.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_NAMESPACE}::int4, ${MIGRATION_LOCK_SLOT}::int4)`;
    await applyMigrations(db);
  });
}

/**
 * Write the minted token to `path`, creating it EXCLUSIVELY at mode 600.
 *
 * `wx` is the whole point: an existing path is an error, never an overwrite — the same never-clobber
 * posture `dev gen-secrets` takes with an operator's `.env`. The explicit `chmod` after the open is
 * belt and braces against a permissive umask on platforms where the open mode is masked. The file is
 * the token and nothing else (no trailing newline), so a machine reader needs no trimming rule.
 */
async function writeTokenFile(path: string, token: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new TenantProvisionError(
        'OWNER_INVITE_OUT_EXISTS',
        `${path} already exists. The owner-invite file is never overwritten — a token already at ` +
          'that path may be an outstanding credential. Choose a different --owner-invite-out path.',
      );
    }
    throw err;
  }
  try {
    await handle.chmod(0o600);
    await handle.write(token);
    await handle.close();
  } catch (err) {
    // The open already SUCCEEDED, so the path holds a file this call created — empty or partial. A
    // full volume or a quota is enough to land here, and `provisionTenant`'s own cleanup cannot help:
    // it only learns the path once this function resolves. Left behind, the file grants nothing (the
    // reservation rolls back) but the never-clobber guard would refuse that path forever after. So
    // the writer removes exactly what the writer created — and never touches a pre-existing file,
    // which is the EEXIST branch above and returns before this point.
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw err;
  }
}

/**
 * Provision (create or resolve) the organization named by `input.orgId`, idempotently.
 *
 * `opts.writeToken` is injectable so a suite can prove the token never reaches a stream without
 * touching a disk; `opts.now` so expiry assertions are deterministic. Both default to the real thing.
 */
export async function provisionTenant(
  secrets: TenantProvisionSecrets,
  input: TenantProvisionInput,
  opts: {
    readonly writeToken?: (path: string, token: string) => Promise<void>;
    readonly now?: () => Date;
  } = {},
): Promise<TenantProvisionResult> {
  const writeToken = opts.writeToken ?? writeTokenFile;
  const now = opts.now?.() ?? new Date();
  if (input.ownerEmail !== undefined && input.ownerInviteOut === undefined) {
    throw new TenantProvisionError(
      'OWNER_INVITE_OUT_REQUIRED',
      'An owner handoff mints a token that must land somewhere the operator controls: pass the path ' +
        'to write it to. It is deliberately never returned, printed or logged.',
    );
  }

  const db = makeDb(secrets.databaseUrl);
  // Tracked outside the transaction so a failure AFTER the token file exists — including at commit —
  // can remove it. A stray file holding a credential for a reservation that rolled back is exactly
  // the residue this whole path exists to avoid.
  let writtenTokenFile: string | undefined;
  try {
    // The committed platform chain, idempotent on an already-migrated database and the bootstrap of a
    // clean one. This is the side effect that makes the command one step — and the reason pointing it
    // at an unexpected DATABASE_URL migrates that database. A failure here is reported as ITS OWN
    // code: the migrator's rejection is a multi-line query dump, and an operator handed one has no
    // way to tell that nothing was reserved.
    try {
      await migrateUnderLock(db);
    } catch (err) {
      throw new TenantProvisionError(
        'MIGRATION_FAILED',
        'Applying the committed migration chain to the target database failed, so no organization ' +
          'was created or resolved. Check that DATABASE_URL names the database you meant and that ' +
          `its role may create schemas and tables in it. Reported by the database: ${oneLine(err)}`,
      );
    }

    // The posture is hardcoded, not read from the environment — see the module docblock.
    const orgStore = new OrgStore(db, { tenantBootstrapEnabled: true });
    const inviteStore = new InviteStore(db);
    const auditStore = new AuditStore(db);

    // Declared WITHOUT an initializer on purpose: the only writer is the callback below, and an
    // initializer would let the compiler narrow this to that one member at every read site here.
    let claimed: OwnerHandoff | undefined;

    /**
     * What makes the reserved org claimable, written INSIDE the reservation transaction. Named rather
     * than inlined because the reservation below may be attempted twice (see the slug race).
     */
    const claim: Parameters<OrgStore['reserveOrgById']>[1] = async (ttx, org, state) => {
      if (input.ownerEmail === undefined) return;
      // THE SAFETY PROPERTY that makes an idempotent resolve safe to automate: once an org has a
      // committed active owner, this command will not hand out ownership of it. Without the check, a
      // run against a live tenant would be a takeover with a typo as its only precondition.
      //
      // The honest limit of "once committed": the redemption route consumes the invite and writes the
      // membership in two separate statements (routes/invites.ts), so a run landing between them sees
      // no live invite AND no owner yet, and mints. The result is a second owner invite for an org
      // that is about to have its first owner — an extra owner, never a displaced one — and it is
      // bounded by operator authority, since reaching this code at all means holding DATABASE_URL.
      if (state.owners > 0) {
        claimed = { status: 'already_owned', owners: state.owners };
        return;
      }

      const live = await inviteStore.findLiveUnconsumed(org.id, 'owner', now, ttx);
      if (live && input.reissueOwnerInvite !== true) {
        // THIS is what makes the second run idempotent — the outstanding invite, not a secret the
        // caller had to keep. A retry converges without minting a second live credential.
        claimed = {
          status: 'pending',
          inviteId: live.id,
          email: live.email,
          expiresAt: live.expiresAt.toISOString(),
        };
        return;
      }
      if (live) {
        // Re-issue: revoke the outstanding invite in THIS transaction, so "at most one live owner
        // invite" holds at every instant rather than only between calls.
        await inviteStore.consume(org.id, live.id, now, ttx);
      }

      const outPath = input.ownerInviteOut as string;
      const ttl = Math.min(
        Math.max(
          input.inviteTtlSeconds ?? OPERATOR_INVITE_DEFAULT_TTL_SECONDS,
          INVITE_MIN_TTL_SECONDS,
        ),
        INVITE_MAX_TTL_SECONDS,
      );
      const expiresAt = new Date(now.getTime() + ttl * 1000);
      // The EXPLICIT-pepper form: no `setBootSecrets`, so this path never holds the JWT signing key.
      const { token, hash } = mintInviteToken(secrets.apiKeyPepper);
      await writeToken(outPath, token);
      writtenTokenFile = outPath;
      const invite = await inviteStore.create(
        org.id,
        {
          tokenHash: hash,
          email: normalizeEmail(input.ownerEmail),
          role: 'owner',
          expiresAt,
          createdBy: null,
        },
        ttx,
      );
      claimed = {
        status: 'issued',
        inviteId: invite.id,
        email: normalizeEmail(input.ownerEmail),
        expiresAt: expiresAt.toISOString(),
        tokenFile: outPath,
      };
    };

    /** One reservation attempt: derive the slug, then reserve. Resets whatever a prior attempt left. */
    const attempt = async () => {
      claimed = undefined;
      if (writtenTokenFile !== undefined) {
        // A previous attempt rolled back, so its token belongs to no invite — and the exclusive-create
        // writer would refuse the same path a second time.
        await unlink(writtenTokenFile).catch(() => {});
        writtenTokenFile = undefined;
      }
      const slug = await orgStore.deriveUniqueSlug(input.name);
      return orgStore.reserveOrgById({ id: input.orgId, name: input.name, slug }, claim);
    };

    // THE SLUG RACE, and why exactly ONE retry closes it. `deriveUniqueSlug` is a read-then-derive
    // with no lock, and the INSERT's conflict arbiter is `(id)` — so two runs started at the same
    // instant derive the SAME slug from the same name, and the loser's INSERT trips the unique
    // lower(slug) index rather than the id arbiter it was armed for. By the time it does, the winner
    // has COMMITTED: a second attempt takes the resolve branch, where the slug is never used at all,
    // so it converges instead of racing again. A slug that is genuinely taken by a DIFFERENT
    // organization does not reach here in the first place — `deriveUniqueSlug` already appends a
    // disambiguator when the base is occupied — which is why a violation surviving the retry is
    // reported as a name problem rather than retried further.
    let reserved: Awaited<ReturnType<OrgStore['reserveOrgById']>>;
    try {
      reserved = await attempt();
    } catch (err) {
      if (!isUniqueViolation(err)) throw translateReserveError(err, input);
      try {
        reserved = await attempt();
      } catch (retryErr) {
        throw translateReserveError(retryErr, input);
      }
    }

    // No callback write means no handoff was asked for — the only path that leaves it unset.
    const handoff: OwnerHandoff = claimed ?? { status: 'not_requested' };

    // OUT OF BAND, after the commit — the same posture the invite route takes, so a rolled-back
    // reservation leaves no record of a tenant that does not exist.
    await auditStore.appendTenantProvisioned({
      tenantId: reserved.org.id,
      // An operator run has no HTTP request, so the correlation column carries a per-run id rather
      // than a borrowed or invented request id.
      requestId: randomUUID(),
      meta: {
        created: reserved.created,
        handoff: handoff.status,
        // ids and flags only — never the invited address, never the token.
        ...(handoff.status === 'issued' || handoff.status === 'pending'
          ? { inviteId: handoff.inviteId }
          : {}),
      },
    });

    return {
      orgId: reserved.org.id,
      name: reserved.org.name,
      slug: reserved.org.slug,
      org: reserved.created ? 'created' : 'existing',
      ownerHandoff: handoff,
      acceptPath: '/v1/invites/accept',
    };
  } catch (err) {
    // Best-effort: the token in that file belongs to a reservation that did not commit, so it grants
    // nothing — but leaving credential-shaped material on disk is not something to shrug at either.
    if (writtenTokenFile !== undefined) await unlink(writtenTokenFile).catch(() => {});
    throw err;
  } finally {
    await db.$client.end();
  }
}

/**
 * A driver rejection as ONE bounded line. The migrator's own message quotes the entire failing
 * statement — a whole migration file, comments included — so the database's actual complaint is
 * preferred when it is attached as the cause, and the result is capped: a message an operator has to
 * scroll past is not more informative than one they can read.
 */
function oneLine(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined;
  const text = (cause ?? (err instanceof Error ? err : undefined))?.message ?? String(err);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/**
 * Turn the store's typed refusals — and the ONE driver error this path can realistically hit — into
 * an actionable `TenantProvisionError`. Anything else propagates untouched: a fault an operator cannot
 * act on must not be dressed up as one they can.
 */
function translateReserveError(err: unknown, input: TenantProvisionInput): unknown {
  if (err instanceof TenantProvisionError) return err;
  if (err instanceof OrgTombstonedError) {
    return new TenantProvisionError(
      'ORG_TOMBSTONED',
      `${input.orgId} names a soft-deleted organization. Its id is a primary key, so it stays ` +
        'occupied and cannot be reused, while a deployment bound to it would refuse to boot ' +
        '(a soft-deleted org counts as absent). Choose a different --org-id.',
    );
  }
  if (err instanceof OrgIdInUseError) {
    return new TenantProvisionError(
      'ORG_ID_IN_USE',
      `${input.orgId} was taken by a concurrent run that then rolled back. Nothing was written. ` +
        'Run the command again.',
    );
  }
  if (isUniqueViolation(err)) {
    // The slug is derived by a read-then-derive with no lock, and the INSERT's conflict arbiter is
    // `(id)` — so a slug that is already taken surfaces as a 23505 on a DIFFERENT index. Naming the
    // remedy is the difference between an actionable message and a driver dump.
    return new TenantProvisionError(
      'ORG_NAME_SLUG_IN_USE',
      `"${input.name}" already slugs to an existing organization. Pass a different --name; ` +
        'the organization id is unaffected and nothing was written.',
    );
  }
  return err;
}
