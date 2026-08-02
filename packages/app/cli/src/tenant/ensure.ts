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
import type {
  loadTenantProvisionSecrets,
  OwnerHandoff,
  provisionTenant,
  TenantProvisionSecrets,
} from '@rayspec/server';
import { TenantCliError } from './errors.js';

/** The org id is an org UUID — the same 8-4-4-4-12 shape the tenant chokepoint and the boot gate use. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Injection seam for the suite: both default to the real implementations, dynamically imported. It
 * exists so the output contract can be driven end-to-end without a database.
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
  const { loadTenantProvisionSecrets: loadReal, provisionTenant: provisionReal } = await import(
    '@rayspec/server'
  );
  const loadSecrets = deps.loadSecretsImpl ?? loadReal;
  const provision = deps.provisionImpl ?? provisionReal;

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
      ownerHandoff: out.ownerHandoff,
      acceptPath: out.acceptPath,
      errors: [],
    };
  } catch (err) {
    const code =
      typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'PROVISION_FAILED';
    return {
      ok: false,
      command: 'tenant ensure',
      errors: [{ code, message: redactSecrets(errorMessage(err), secrets) }],
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
