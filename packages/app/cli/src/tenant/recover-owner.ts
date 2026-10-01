/**
 * `rayspec tenant recover-owner` — issue a one-time owner-recovery token for an organization owner who
 * holds no password, and print it once.
 *
 * WHEN. An owner whose only credential was an API key has nothing to sign in with once the API-key
 * pepper changes, which a portability import always does. The operator runs this against the
 * deployment that will serve the owner (its `DATABASE_URL` and its pepper), once it serves; the owner
 * redeems the token at `POST /v1/auth/owner-recovery` with a new password.
 *
 * THE TOKEN IS PRINTED ONCE: it is the `recoveryToken` member of the one JSON object this command
 * writes to stdout, and nowhere else — no stderr line, no audit row, no receipt carries it; the
 * database holds only its HMAC. Hand it to the owner over a channel you trust, and do not capture
 * this command's stdout in a log. Issuing again replaces a token still outstanding for the owner.
 */
import { parseArgs } from 'node:util';
import { TenantCliError } from './errors.js';

/** An org id is an org UUID. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantRecoverOwnerResult {
  readonly ok: boolean;
  readonly command: 'tenant recover-owner';
  readonly orgId?: string;
  readonly userId?: string;
  readonly recoveryId?: string;
  readonly expiresAt?: string;
  /** Outstanding tokens for the same owner this one replaced. */
  readonly replaced?: number;
  /** The one-time token. Shown here once; never stored, logged or audited. */
  readonly recoveryToken?: string;
  readonly redeemPath?: '/v1/auth/owner-recovery';
  readonly errors: { readonly code: string; readonly message: string }[];
}

type Server = typeof import('@rayspec/server');

/** Injection seam for the suite; each defaults to the real implementation. */
export interface TenantRecoverOwnerDeps {
  readonly loadSecretsImpl?: Server['loadOwnerRecoverySecrets'];
  readonly issueImpl?: Server['issueOwnerRecovery'];
}

function parseRecoverArgs(args: readonly string[]): {
  email: string;
  orgId?: string;
  ttlSeconds?: number;
} {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        email: { type: 'string' },
        'org-id': { type: 'string' },
        'ttl-seconds': { type: 'string' },
      },
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (e) {
    throw new TenantCliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (positionals.length > 0) {
    throw new TenantCliError(
      `tenant recover-owner takes no positional arguments (got ${JSON.stringify(positionals[0])})`,
    );
  }
  const email = (values.email as string | undefined)?.trim();
  if (!email) {
    throw new TenantCliError('--email <address> is required: the owner to recover');
  }
  const orgId = (values['org-id'] as string | undefined)?.trim() || undefined;
  if (orgId !== undefined && !UUID_SHAPE.test(orgId)) {
    throw new TenantCliError(
      `--org-id must be an org UUID (8-4-4-4-12), got ${JSON.stringify(orgId)}`,
    );
  }
  const rawTtl = (values['ttl-seconds'] as string | undefined)?.trim();
  let ttlSeconds: number | undefined;
  if (rawTtl !== undefined && rawTtl !== '') {
    const n = Number(rawTtl);
    if (!Number.isInteger(n) || n <= 0) {
      throw new TenantCliError(
        `--ttl-seconds must be a positive whole number of seconds, got ${JSON.stringify(rawTtl)}`,
      );
    }
    ttlSeconds = n;
  }
  return {
    email,
    ...(orgId === undefined ? {} : { orgId }),
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  };
}

/**
 * Run the command. A usage problem throws `TenantCliError` (exit 2); a refusal or a missing secret
 * comes back as `ok:false` with a code (exit 1) and no token.
 */
export async function runTenantRecoverOwner(
  args: readonly string[],
  deps: TenantRecoverOwnerDeps = {},
): Promise<TenantRecoverOwnerResult> {
  const parsed = parseRecoverArgs(args);
  let loadSecrets = deps.loadSecretsImpl;
  let issue = deps.issueImpl;
  let isRefusal = (_err: unknown): _err is { code: string; message: string } => false;
  if (loadSecrets === undefined || issue === undefined) {
    const real = await import('@rayspec/server');
    loadSecrets ??= real.loadOwnerRecoverySecrets;
    issue ??= real.issueOwnerRecovery;
    isRefusal = (err): err is { code: string; message: string } =>
      err instanceof real.OwnerRecoveryError;
  }
  const failed = (code: string, message: string): TenantRecoverOwnerResult => ({
    ok: false,
    command: 'tenant recover-owner',
    errors: [{ code, message }],
  });

  let secrets: ReturnType<Server['loadOwnerRecoverySecrets']>;
  try {
    secrets = loadSecrets();
  } catch (err) {
    // The loader names the variables and, for a broken file mount, the path — never a value.
    return failed('SECRETS_MISSING', err instanceof Error ? err.message : String(err));
  }
  try {
    const issued = await issue(secrets, parsed);
    return {
      ok: true,
      command: 'tenant recover-owner',
      orgId: issued.orgId,
      userId: issued.userId,
      recoveryId: issued.recoveryId,
      expiresAt: issued.expiresAt.toISOString(),
      replaced: issued.replaced,
      recoveryToken: issued.token,
      redeemPath: '/v1/auth/owner-recovery',
      errors: [],
    };
  } catch (err) {
    if (isRefusal(err) || (err as { name?: unknown })?.name === 'OwnerRecoveryError') {
      const e = err as { code: string; message: string };
      return failed(e.code, e.message);
    }
    return failed(
      'RECOVERY_FAILED',
      'The recovery token could not be issued: the database could not be reached or refused the ' +
        'write. Nothing was issued; check DATABASE_URL and retry.',
    );
  }
}
