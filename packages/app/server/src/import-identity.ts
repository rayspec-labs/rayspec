/**
 * THE IDENTITY OF AN IMPORTED TARGET — its new boot secrets, and the identity policy the snapshot
 * states, carried out and recorded.
 *
 * NEW BOOT SECRETS (`mintBootSecrets`). A portability import never reuses the source's secrets: the
 * snapshot does not carry them, and the target mints its own signing key (RS256, PKCS#8 PEM), API-key
 * pepper and media signing key, each a fresh CSPRNG value, into a new directory the operator names
 * (mode 0700, files mode 0600, created exclusively and never through a link). The values are printed
 * nowhere; the target's deployment reads the first two through their `_FILE` variables. Everything
 * keyed by the source's secrets stops working on the target:
 *   - the pepper keys API keys, refresh sessions, invite tokens and owner-recovery tokens;
 *   - the signing key keys access tokens and the OIDC artifacts;
 *   - the media key keys playback tokens.
 * The snapshot carries none of those credentials' rows either (category `credential-state`), so the
 * reset holds twice over.
 *
 * THE IDENTITY POLICY (`applyIdentityPolicy`), run as the migration role after the verification:
 *   - user ids are preserved (the restore carried them unchanged);
 *   - password hashes are argon2id with their own salt, independent of every secret, and are carried
 *     only through this step: each user's carried hash is recorded in the target's `auth_audit` as an
 *     `identity_imported` row naming the import operation and the migration bundle's digest;
 *   - sessions, API keys, invites, OIDC artifacts and owner-recovery tokens are empty, checked again;
 *   - the report says who signs in again with their password, which owner needs owner recovery
 *     (`rayspec tenant recover-owner`) because they hold no password, and which account has no way
 *     in at all. The snapshot carries no API key, so every key of the source is reissued by an owner
 *     after the cutover.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type BundleError, bundleError } from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';

/** The three files a portability import mints, by the variable each one is for. */
export const BOOT_SECRET_FILES = {
  RAYSPEC_JWT_SIGNING_KEY: 'jwt-signing-key.pem',
  RAYSPEC_API_KEY_PEPPER: 'api-key-pepper',
  RAYSPEC_MEDIA_SIGNING_KEY: 'media-signing-key',
} as const;

export type BootSecretName = keyof typeof BOOT_SECRET_FILES;

/**
 * Check, before anything is restored, that `path` can take the target's new boot secrets: it does
 * not exist, and its parent is a directory. Returns the refusal, or null.
 */
export async function bootSecretsDirectoryRefusal(path: string): Promise<BundleError | null> {
  try {
    await lstat(path);
    return bundleError(
      'RAY_USAGE',
      "--secrets-out names something that already exists; the target's new boot secrets go into a " +
        'new directory, so nothing is overwritten',
      { path: '/secrets-out' },
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('not a directory');
  } catch {
    return bundleError('RAY_USAGE', 'the parent directory of --secrets-out does not exist', {
      path: '/secrets-out',
    });
  }
  return null;
}

async function writeSecretFile(path: string, value: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Mint the target's three boot secrets into the new directory `path` (mode 0700). Returns each
 * file's path by the variable it is for; the values never leave the files.
 */
export async function mintBootSecrets(path: string): Promise<Record<BootSecretName, string>> {
  await mkdir(path, { mode: 0o700 });
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const values: Record<BootSecretName, string> = {
    RAYSPEC_JWT_SIGNING_KEY: privateKey,
    RAYSPEC_API_KEY_PEPPER: randomBytes(48).toString('base64'),
    RAYSPEC_MEDIA_SIGNING_KEY: randomBytes(48).toString('base64'),
  };
  const files = {} as Record<BootSecretName, string>;
  for (const name of Object.keys(BOOT_SECRET_FILES) as BootSecretName[]) {
    files[name] = join(path, BOOT_SECRET_FILES[name]);
    await writeSecretFile(files[name], values[name]);
  }
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return files;
}

/** What each account of the imported organization does after the cutover. */
export type IdentityAction = 'sign-in-again' | 'owner-recovery' | 'no-credential';

export interface IdentityReportUser {
  userId: string;
  email: string;
  /** The account's role in the organization, or null when it holds no active membership. */
  role: 'owner' | 'admin' | 'member' | null;
  /** Whether a password hash was carried. */
  password: boolean;
  action: IdentityAction;
}

/** Who must do what before the target is useful to them. */
export interface IdentityReport {
  users: IdentityReportUser[];
  counts: Record<IdentityAction, number>;
}

/** The credential tables that must be empty on a portability target. */
const CREDENTIAL_TABLES = [
  'sessions',
  'api_keys',
  'invites',
  'oidc_models',
  'owner_recovery_tokens',
] as const;

/**
 * Carry out the snapshot's identity policy on the restored target and record it. `control` is the
 * target's application database as the migration role. Throws on a credential row (a target that
 * would not reset) — the caller has verified the tables already, so this is the last check.
 */
export async function applyIdentityPolicy(
  control: Db,
  input: { tenantId: string; operationId: string; migrationBundleSha256: string },
): Promise<IdentityReport> {
  return control.$client.begin(async (tx) => {
    const [credentials] = (await tx.unsafe(
      `SELECT ${CREDENTIAL_TABLES.map((t) => `(SELECT count(*) FROM ${t})::int`).join(' + ')} AS n`,
    )) as unknown as { n: number }[];
    if (Number(credentials?.n) !== 0) {
      throw new Error('a credential table of the target is not empty');
    }
    const rows = (await tx.unsafe(
      `SELECT u.id::text AS id, u.email, u.password_hash IS NOT NULL AS password, m.role
         FROM users u
         LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = $1::uuid
                                AND m.deleted_at IS NULL AND m.status = 'active'
        WHERE u.deleted_at IS NULL
        ORDER BY u.email, u.id`,
      [input.tenantId],
    )) as unknown as { id: string; email: string; password: boolean; role: string | null }[];
    const users: IdentityReportUser[] = rows.map((r) => {
      const role =
        r.role === 'owner' || r.role === 'admin' || r.role === 'member'
          ? r.role
          : r.role === null
            ? null
            : 'member';
      const action: IdentityAction = r.password
        ? 'sign-in-again'
        : role === 'owner'
          ? 'owner-recovery'
          : 'no-credential';
      return { userId: r.id, email: r.email, role, password: r.password, action };
    });
    // The audited path: each account's carried identity, on the target's own security record.
    for (const u of users) {
      await tx.unsafe(
        `INSERT INTO auth_audit (actor_org_id, actor_user_id, event, request_id, meta)
         VALUES ($1::uuid, $2::uuid, 'identity_imported', NULL, $3::jsonb)`,
        [
          u.role === null ? null : input.tenantId,
          u.userId,
          JSON.stringify({
            operationId: input.operationId,
            migrationBundleSha256: input.migrationBundleSha256,
            userId: 'preserved',
            passwordHash: u.password ? 'preserved' : 'absent',
            sessions: 'reset',
            apiKeys: 'reset',
            invites: 'reset',
            oidcArtifacts: 'reset',
          }),
        ],
      );
    }
    const counts: Record<IdentityAction, number> = {
      'sign-in-again': 0,
      'owner-recovery': 0,
      'no-credential': 0,
    };
    for (const u of users) counts[u.action] += 1;
    return { users, counts };
  }) as Promise<IdentityReport>;
}
