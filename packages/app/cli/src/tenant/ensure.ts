/**
 * `rayspec tenant ensure` — idempotently create or resolve ONE organization under an id the operator
 * chose, and emit exactly one JSON object describing it.
 *
 * It is the PRODUCTION path for the thing `rayspec dev bootstrap-tenant` does locally. The difference
 * is not the outcome but the posture: this command speaks to the database directly (so it needs no
 * running server and mounts no route), it creates NO user, and it prints NO credential. Run twice with
 * the same `--org-id` it converges — the id is the operation id, and `orgs.id` is a primary key, so the
 * database itself is the ledger.
 *
 * WHAT NEVER APPEARS ON A STREAM. When `--owner-email` is given, an owner invite is minted; its token
 * is a tenant-takeover credential until it is consumed or expires. It is written to the mode-600 file
 * named by `--owner-invite-out` and nowhere else. There is deliberately no `--owner-invite-token` flag
 * either: a secret passed as an argument lands in shell history and in `ps`. `TenantEnsureResult` has
 * no field capable of holding a token, which is the structural version of that promise rather than a
 * reviewer's assurance.
 *
 * `@rayspec/server` is imported DYNAMICALLY inside the handler (the same reason `deploy` does): the
 * composition root drags in Drizzle, Hono and the durable worker, and `rayspec doctor`'s cold start
 * must not pay for a command it is not running.
 */
import { parseArgs } from 'node:util';
import { operatorSafeDbErrorMessage } from '@rayspec/db';
import type {
  loadTenantProvisionSecrets,
  OwnerHandoff,
  provisionTenant,
  TenantProvisionSecrets,
} from '@rayspec/server';
import { TenantCliError } from './errors.js';

/** The org id is an org UUID — the same 8-4-4-4-12 shape the tenant chokepoint and the boot gate use. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this plausibly an email address? Exactly one `@`, something either side of it, no whitespace, and
 * within the 254-character limit the platform enforces. Deliberately NOT a copy of the platform's
 * `normalizeEmail`, which is the authority and is stricter (NFKC, invisible-character rejection): a
 * SUBSET check can only refuse what the server refuses too, so the two can never disagree in the
 * direction that would reject a legitimate operator.
 */
function isPlausibleEmail(value: string): boolean {
  if (value.length > 254 || /\s/.test(value)) return false;
  const at = value.indexOf('@');
  return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1;
}

/** Did the provisioning layer itself throw this — i.e. may its `code` name the documented namespace? */
function isProvisionError(err: unknown): err is { code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'TenantProvisionError' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

export interface TenantEnsureResult {
  readonly ok: boolean;
  readonly command: 'tenant ensure';
  readonly orgId?: string;
  readonly name?: string;
  readonly slug?: string;
  readonly org?: 'created' | 'existing';
  readonly ownerHandoff?: OwnerHandoff;
  readonly acceptPath?: '/v1/invites/accept';
  readonly errors: { readonly code: string; readonly message: string }[];
}

/**
 * Injection seam for the suite: each defaults to the real implementation, dynamically imported. It
 * exists so the output contract can be driven without a database — and supplying BOTH means the
 * provisioning package is never imported at all, so the seam is a real substitute rather than a
 * decoration on top of one.
 */
export interface TenantEnsureDeps {
  readonly provisionImpl?: typeof provisionTenant;
  readonly loadSecretsImpl?: typeof loadTenantProvisionSecrets;
}

/**
 * Parse `tenant ensure`'s flags. Every problem here is a `TenantCliError` (exit 2) rather than an
 * `ok:false` result, because none of them is an outcome — they are all "this invocation could not mean
 * anything", and answering them before a connection is opened is what keeps a typo from migrating a
 * database.
 */
function parseEnsureArgs(args: readonly string[]): {
  orgId: string;
  name: string;
  ownerEmail?: string;
  ownerInviteOut?: string;
  inviteTtlSeconds?: number;
  reissueOwnerInvite?: boolean;
} {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        'org-id': { type: 'string' },
        name: { type: 'string' },
        'owner-email': { type: 'string' },
        'owner-invite-out': { type: 'string' },
        'invite-ttl-seconds': { type: 'string' },
        'reissue-owner-invite': { type: 'boolean' },
      },
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (e) {
    throw new TenantCliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (positionals.length > 0) {
    throw new TenantCliError(
      `tenant ensure takes no positional arguments (got ${JSON.stringify(positionals[0])})`,
    );
  }

  const orgId = (values['org-id'] as string | undefined)?.trim();
  if (!orgId) {
    throw new TenantCliError(
      '--org-id <uuid> is required — it is the operation id, so a retry must name the same one',
    );
  }
  if (!UUID_SHAPE.test(orgId)) {
    throw new TenantCliError(
      `--org-id must be an org UUID (8-4-4-4-12), got ${JSON.stringify(orgId)}`,
    );
  }
  const name = (values.name as string | undefined)?.trim();
  if (!name) throw new TenantCliError('--name <n> is required (the organization display name)');

  const ownerEmail = (values['owner-email'] as string | undefined)?.trim() || undefined;
  const ownerInviteOut = (values['owner-invite-out'] as string | undefined)?.trim() || undefined;
  if (ownerEmail !== undefined && ownerInviteOut === undefined) {
    throw new TenantCliError(
      '--owner-invite-out <path> is required with --owner-email: the minted invite token is written ' +
        'to that file and is never printed, returned or logged',
    );
  }
  // A DELIBERATELY WEAKER shape check than the platform's `normalizeEmail`, which stays the authority
  // (it also rejects invisible and control characters, after NFKC). Weaker is the safe direction: this
  // can only refuse an address the server would refuse too, never one it would accept. It exists
  // because the alternative is worse than a late error — without it a mistyped address is not caught
  // until inside the reservation, i.e. AFTER the migration chain has already run against the target
  // database, which contradicts this parser's own promise that a typo cannot migrate anything.
  if (ownerEmail !== undefined && !isPlausibleEmail(ownerEmail)) {
    throw new TenantCliError(
      `--owner-email must be an email address (one @, text on both sides, no spaces), got ${JSON.stringify(ownerEmail)}`,
    );
  }

  const rawTtl = (values['invite-ttl-seconds'] as string | undefined)?.trim();
  let inviteTtlSeconds: number | undefined;
  if (rawTtl !== undefined && rawTtl !== '') {
    const n = Number(rawTtl);
    if (!Number.isInteger(n) || n <= 0) {
      throw new TenantCliError(
        `--invite-ttl-seconds must be a positive whole number of seconds, got ${JSON.stringify(rawTtl)}`,
      );
    }
    inviteTtlSeconds = n;
  }

  return {
    orgId,
    name,
    ...(ownerEmail === undefined ? {} : { ownerEmail }),
    ...(ownerInviteOut === undefined ? {} : { ownerInviteOut }),
    ...(inviteTtlSeconds === undefined ? {} : { inviteTtlSeconds }),
    ...(values['reissue-owner-invite'] === true ? { reissueOwnerInvite: true } : {}),
  };
}

/**
 * Run the command. A usage problem THROWS `TenantCliError` (exit 2); an operational failure — a
 * tombstoned id, a name that already slugs to an existing org, an invite-out path that is taken, a
 * missing secret — comes back as `ok:false` with a machine-readable code (exit 1). The message is what
 * an operator acts on, so it names the remedy and never a secret value.
 */
export async function runTenantEnsure(
  args: readonly string[],
  deps: TenantEnsureDeps = {},
): Promise<TenantEnsureResult> {
  const parsed = parseEnsureArgs(args);
  let loadSecrets = deps.loadSecretsImpl;
  let provision = deps.provisionImpl;
  if (loadSecrets === undefined || provision === undefined) {
    // Only for an implementation that was NOT supplied: the composition root drags in Drizzle, Hono
    // and the durable worker, so a caller that injected both must not pay for loading it.
    const real = await import('@rayspec/server');
    loadSecrets ??= real.loadTenantProvisionSecrets;
    provision ??= real.provisionTenant;
  }

  let secrets: TenantProvisionSecrets;
  try {
    secrets = loadSecrets();
  } catch (err) {
    // The loader's abort names the VARIABLES and, for a broken file mount, the path — never a byte of
    // content, which the boot-secret suite pins. So it is safe to surface verbatim.
    return {
      ok: false,
      command: 'tenant ensure',
      errors: [
        { code: 'SECRETS_MISSING', message: err instanceof Error ? err.message : String(err) },
      ],
    };
  }

  try {
    const out = await provision(secrets, parsed);
    return {
      ok: true,
      command: 'tenant ensure',
      orgId: out.orgId,
      name: out.name,
      slug: out.slug,
      org: out.org,
      ownerHandoff: narrowHandoff(out.ownerHandoff),
      acceptPath: out.acceptPath,
      errors: [],
    };
  } catch (err) {
    // `errors[].code` is a documented namespace of THIS command's own codes, so only the provisioning
    // layer's own error may name one. Reading `code` off any thrown value put a Postgres SQLSTATE
    // ('23505') or a Node errno ('ECONNREFUSED') into the same field the reference documents as
    // ORG_TOMBSTONED / OWNER_INVITE_OUT_EXISTS / ORG_NAME_SLUG_IN_USE — a caller matching on it would
    // be reading a namespace nobody promised. Everything else is a plain PROVISION_FAILED.
    //
    // The driver's own words do NOT reach the operator through `message` any more — by BOTH doors.
    // Rendering here closes only the first: the provisioning layer bakes a driver sentence into
    // `TenantProvisionError.message` itself, and a value already inside that string cannot be
    // withheld by anything downstream, this line included. So the layer builds that message from the
    // same rendering (`tenant-provision.ts`), and this call re-renders a raw error that reaches it by
    // another route. Two places, because there are two doors, not because one distrusts the other.
    // Provisioning
    // writes an org and its owner, so the values it binds are the operator's own inputs — and a
    // constraint violation on them (a taken slug, a duplicate owner email) comes back with the value
    // in the driver's `detail`, while a coercion refusal puts it in the message itself.
    // `redactSecrets` below masks the DATABASE_URL and the pepper; it was never a row-value filter,
    // and widening it into one would be an allowlist against a vocabulary the server owns. The
    // renderer keeps the SQLSTATE, the constraint and the statement, which is what an operator acts
    // on, and withholds the values visibly.
    //
    // Matched by NAME rather than `instanceof`: `@rayspec/server` is loaded dynamically (and is
    // replaced wholesale in tests), so the constructor identity here is not guaranteed to be the one
    // that threw, while `TenantProvisionError` sets `this.name` in its constructor.
    const code = isProvisionError(err) ? err.code : 'PROVISION_FAILED';
    return {
      ok: false,
      command: 'tenant ensure',
      errors: [{ code, message: redactSecrets(operatorSafeDbErrorMessage(err), secrets) }],
    };
  }
}

/**
 * Rebuild the handoff FIELD BY FIELD instead of forwarding the provisioning layer's object.
 *
 * `OwnerHandoff` has no member capable of declaring a token, but a structural pass-through would still
 * print whatever property the value arrived with — a type stops a field being written in source, not
 * an object from carrying one at runtime. Copying by name is what makes "no credential reaches a
 * stream" a property of this function rather than a property of everything upstream of it.
 */
function narrowHandoff(handoff: OwnerHandoff): OwnerHandoff {
  switch (handoff.status) {
    case 'not_requested':
      return { status: 'not_requested' };
    case 'already_owned':
      return { status: 'already_owned', owners: handoff.owners };
    case 'pending':
      return {
        status: 'pending',
        inviteId: handoff.inviteId,
        email: handoff.email,
        expiresAt: handoff.expiresAt,
      };
    case 'issued':
      return {
        status: 'issued',
        inviteId: handoff.inviteId,
        email: handoff.email,
        expiresAt: handoff.expiresAt,
        tokenFile: handoff.tokenFile,
      };
    default: {
      // Fail closed on a shape this command does not know how to strip: the caller gets an
      // `ok:false` (the block above catches this), never an object forwarded unread. Only the
      // status name is quoted — never the value it came in.
      const status = (handoff as { status?: unknown }).status;
      throw new Error(`unrecognized owner handoff status ${JSON.stringify(String(status))}`);
    }
  }
}

/**
 * Blank out either resolved secret if a driver/library error quoted it back at us.
 *
 * A connection string carries a password, and a failure deep in a driver is exactly the moment nobody
 * is auditing what an error string happens to contain. The command's whole contract is that neither
 * secret reaches a stream, so it is enforced on the way out rather than assumed of every dependency.
 */
function redactSecrets(message: string, secrets: TenantProvisionSecrets): string {
  return message
    .split(secrets.databaseUrl)
    .join('<DATABASE_URL>')
    .split(secrets.apiKeyPepper)
    .join('<RAYSPEC_API_KEY_PEPPER>');
}
