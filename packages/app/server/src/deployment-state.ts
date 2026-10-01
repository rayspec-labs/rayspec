/**
 * THE DEPLOYMENT STATE DIRECTORY — what a self-hosted bundle deployment keeps on its host, beside the
 * state its application database holds. One directory holds exactly one deployment:
 *
 *   deployment.json          {deploymentFormatVersion: 1, deploymentId, createdAt, applicationId},
 *                            written once, when the first deploy creates the deployment
 *   active.json              {bundleSha256, activatedAt, environmentRevision}: the version the
 *                            deployment serves, replaced atomically (temporary file, fsync, rename)
 *   versions/<bundleSha256>/ the extracted, immutable version directory of each staged bundle
 *   plans/<planDigest>.json  a plan record written by `rayspec deploy --dry-run`
 *   receipts/<name>.json     the local operation receipt of an export, which names no secret, no
 *                            record content and no store
 *   scratch/                 the private scratch space of an export: its lock file and, while it
 *                            runs, the directory its plaintext snapshot is captured into
 *
 * It never holds a secret value, a connection string or a key: the database and the blob root come
 * from the explicit process environment, and a plan record carries binding revision ids, never values.
 *
 * PERMISSIONS. The directory is created with mode 0700 and must stay owned by the invoking user and
 * closed to group and others; a directory that is a link, owned by someone else or open to others is
 * refused (`RAY_BINDINGS_FILE_INSECURE`). Files are created with mode 0600 and read without following
 * a link.
 *
 * A VERSION DIRECTORY is content addressed: its name is the SHA-256 of the bundle it was extracted
 * from, by the one bundle reader, into a private staging directory that is renamed into place only
 * once every file matches the manifest's inventory. Its files are then made read-only. A version
 * directory that already exists is verified file by file against the inventory before it is used
 * again, so a changed file, an extra file or a link is found rather than served.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { extractBundle } from '@rayspec/bundle';
import {
  type ApplicationManifest,
  type BundleError,
  bundleError,
  canonicalJsonFile,
  isSha256,
  parseTimestamp,
} from '@rayspec/bundle-contract';

/** The default state directory, relative to the working directory. */
export const DEFAULT_STATE_DIR = '.rayspec-state';

/** The version of `deployment.json`. */
export const DEPLOYMENT_FORMAT_VERSION = 1;

/** A deployment id: 16 lowercase hex characters from a cryptographic random source. */
const DEPLOYMENT_ID = /^[a-z0-9-]{1,64}$/;

/** The name of a local operation receipt: the operation and its id. */
const RECEIPT_NAME = /^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The largest state file this module reads; every one it writes is far smaller. */
const MAX_STATE_FILE_BYTES = 256 * 1024;

/** A refusal about the state directory or a file in it, with the contract code it reports. */
export class StateDirectoryError extends Error {
  readonly error: BundleError;
  constructor(error: BundleError) {
    super(error.message);
    this.name = 'StateDirectoryError';
    this.error = error;
  }
}

function insecure(message: string): StateDirectoryError {
  return new StateDirectoryError(bundleError('RAY_BINDINGS_FILE_INSECURE', message));
}

function usage(message: string): StateDirectoryError {
  return new StateDirectoryError(bundleError('RAY_USAGE', message));
}

function unavailable(message: string): StateDirectoryError {
  return new StateDirectoryError(bundleError('RAY_INFRA_UNAVAILABLE', message));
}

/** `deployment.json`. */
export interface DeploymentRecord {
  deploymentFormatVersion: typeof DEPLOYMENT_FORMAT_VERSION;
  deploymentId: string;
  createdAt: string;
  applicationId: string;
}

/** `active.json`. */
export interface ActiveRecord {
  bundleSha256: string;
  activatedAt: string;
  environmentRevision: number;
}

/** A new deployment id: 16 lowercase hex characters. */
export function newDeploymentId(): string {
  return randomBytes(8).toString('hex');
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Check a path the operator named as a protected file: a regular file, not a link, owned by the
 * invoking user and neither readable nor writable by group or others. The contract's checks for a
 * bindings file, an identity file and a key file. Returns the refusal, or null.
 */
export async function protectedFileRefusal(
  path: string,
  what: string,
): Promise<StateDirectoryError | null> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch {
    return usage(`${what} cannot be read: there is no file at that path`);
  }
  if (stat.isSymbolicLink()) return insecure(`${what} is a symbolic link; name the file itself`);
  if (!stat.isFile()) return insecure(`${what} is not a regular file`);
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    return insecure(`${what} is not owned by the user running the command`);
  }
  if ((stat.mode & 0o077) !== 0) {
    return insecure(
      `${what} is readable or writable by group or others; restrict it with chmod 600`,
    );
  }
  return null;
}

/**
 * Read a protected file, at most `maxBytes`, without following a link and re-checking what was
 * opened. A file larger than `maxBytes` is refused.
 */
export async function readProtectedFile(
  path: string,
  what: string,
  maxBytes: number,
): Promise<Buffer> {
  const refusal = await protectedFileRefusal(path, what);
  if (refusal !== null) throw refusal;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw usage(`${what} cannot be opened`);
  }
  try {
    const stat = await handle.stat();
    const uid = currentUid();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      throw insecure(`${what} changed while it was opened`);
    }
    if (stat.size > maxBytes) throw usage(`${what} is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) throw usage(`${what} is larger than ${maxBytes} bytes`);
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

async function checkDirectory(path: string, what: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch {
    throw usage(`${what} does not exist`);
  }
  if (stat.isSymbolicLink()) throw insecure(`${what} is a symbolic link`);
  if (!stat.isDirectory()) throw usage(`${what} is not a directory`);
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw insecure(`${what} is not owned by the user running the command`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw insecure(`${what} is open to group or others; restrict it with chmod 700`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Write `text` to `path` through a temporary file in the same directory: fsync, then rename. */
async function writeAtomically(dir: string, name: string, text: string): Promise<void> {
  const temporary = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, join(dir, name));
  } catch (err) {
    await rm(temporary, { force: true });
    throw err;
  }
  const directory = await open(dir, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Write `text` to a new file `path`; an existing file is never replaced. */
async function writeExclusive(path: string, text: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

async function readStateJson(path: string, what: string): Promise<unknown | null> {
  if (!(await exists(path))) return null;
  const bytes = await readProtectedFile(path, what, MAX_STATE_FILE_BYTES);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw usage(`${what} is not valid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Open the state directory at `path`. With `create`, a directory that does not exist yet is created
 * with mode 0700 (its parent must exist); without it, a missing directory is returned as absent.
 */
export async function openStateDirectory(
  path: string,
  options: { create: boolean },
): Promise<StateDirectory | null> {
  if (!(await exists(path))) {
    if (!options.create) return null;
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw usage('the state directory cannot be created: its parent directory does not exist');
      }
    }
  }
  await checkDirectory(path, 'the state directory');
  return new StateDirectory(path);
}

/** One deployment's state directory, checked when it was opened. */
export class StateDirectory {
  constructor(readonly root: string) {}

  /** The directory a bundle's version is extracted into. */
  versionPath(bundleSha256: string): string {
    if (!isSha256(bundleSha256)) throw new RangeError('a version is named by a SHA-256');
    return join(this.root, 'versions', bundleSha256);
  }

  planPath(planDigest: string): string {
    if (!isSha256(planDigest)) throw new RangeError('a plan is named by its digest');
    return join(this.root, 'plans', `${planDigest}.json`);
  }

  async #subdirectory(name: 'versions' | 'plans' | 'receipts' | 'scratch'): Promise<string> {
    const dir = join(this.root, name);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    await checkDirectory(dir, `the ${name} directory of the state directory`);
    return dir;
  }

  /** The scratch directory of an export (mode 0700, created when missing), checked like the root. */
  async scratchDirectory(): Promise<string> {
    return this.#subdirectory('scratch');
  }

  /** The directory of the local operation receipts (mode 0700, created when missing). */
  async receiptsDirectory(): Promise<string> {
    return this.#subdirectory('receipts');
  }

  /** Write a local operation receipt as `receipts/<name>.json`, replacing it atomically. */
  async writeReceipt(name: string, receipt: unknown): Promise<string> {
    if (!RECEIPT_NAME.test(name)) throw new RangeError('a receipt is named by its operation');
    const dir = await this.receiptsDirectory();
    await writeAtomically(dir, `${name}.json`, canonicalJsonFile(receipt));
    return join(dir, `${name}.json`);
  }

  /** A local operation receipt, or null when there is none of that name. */
  async readReceipt(name: string): Promise<unknown | null> {
    if (!RECEIPT_NAME.test(name)) throw new RangeError('a receipt is named by its operation');
    return readStateJson(join(this.root, 'receipts', `${name}.json`), 'the operation receipt');
  }

  /** `deployment.json`, or null before the first deploy. */
  async readDeployment(): Promise<DeploymentRecord | null> {
    const value = await readStateJson(join(this.root, 'deployment.json'), 'deployment.json');
    if (value === null) return null;
    if (
      !isRecord(value) ||
      value.deploymentFormatVersion !== DEPLOYMENT_FORMAT_VERSION ||
      typeof value.deploymentId !== 'string' ||
      !DEPLOYMENT_ID.test(value.deploymentId) ||
      parseTimestamp(value.createdAt) === null ||
      typeof value.applicationId !== 'string'
    ) {
      throw usage('deployment.json in the state directory is not a deployment record');
    }
    return value as unknown as DeploymentRecord;
  }

  /** Write `deployment.json` once; an existing record is kept and returned instead. */
  async createDeployment(record: DeploymentRecord): Promise<DeploymentRecord> {
    const written = await writeExclusive(
      join(this.root, 'deployment.json'),
      canonicalJsonFile(record),
    );
    if (written) return record;
    const existing = await this.readDeployment();
    if (existing === null) throw unavailable('deployment.json could not be written');
    return existing;
  }

  /** `active.json`, or null before a version was activated. */
  async readActive(): Promise<ActiveRecord | null> {
    const value = await readStateJson(join(this.root, 'active.json'), 'active.json');
    if (value === null) return null;
    if (
      !isRecord(value) ||
      !isSha256(value.bundleSha256) ||
      parseTimestamp(value.activatedAt) === null ||
      typeof value.environmentRevision !== 'number' ||
      !Number.isSafeInteger(value.environmentRevision)
    ) {
      throw usage('active.json in the state directory is not an active-version record');
    }
    return value as unknown as ActiveRecord;
  }

  /** Switch the active version: `active.json` is replaced in one rename. */
  async writeActive(record: ActiveRecord): Promise<void> {
    await writeAtomically(this.root, 'active.json', canonicalJsonFile(record));
  }

  /** Write a plan record; it names no secret. */
  async writePlanRecord(planDigest: string, record: unknown): Promise<string> {
    const dir = await this.#subdirectory('plans');
    await writeAtomically(dir, `${planDigest}.json`, canonicalJsonFile(record));
    return this.planPath(planDigest);
  }

  /** A plan record, or null when there is none for that digest. */
  async readPlanRecord(planDigest: string): Promise<unknown | null> {
    return readStateJson(this.planPath(planDigest), 'the plan record');
  }

  /**
   * Stage a bundle into its version directory: extracted by the bundle reader into a private
   * staging directory, verified against the inventory, renamed into place and made read-only. A
   * version directory that already exists is verified instead. Returns the version directory.
   */
  async stageVersion(
    bundlePath: string,
    bundleSha256: string,
    manifest: ApplicationManifest,
  ): Promise<string> {
    const target = this.versionPath(bundleSha256);
    if (await exists(target)) {
      await verifyVersion(target, manifest);
      return target;
    }
    const versions = await this.#subdirectory('versions');
    const staging = join(versions, `.staging-${randomBytes(8).toString('hex')}`);
    const extracted = await extractBundle(bundlePath, staging, {
      operation: 'deploy',
    });
    if (!extracted.ok) {
      throw new StateDirectoryError(extracted.errors[0] ?? bundleError('RAY_INTERNAL', 'failed'));
    }
    try {
      if (extracted.value.archiveSha256 !== bundleSha256) {
        throw new StateDirectoryError(
          bundleError('RAY_DIGEST_MISMATCH', 'the bundle changed while it was staged', {
            reason: 'bundle-sha256',
          }),
        );
      }
      await verifyVersion(staging, manifest);
      try {
        await rename(staging, target);
      } catch (err) {
        // Another deploy staged the same bundle meanwhile: use its directory once it verifies.
        if (!(await exists(target))) throw err;
        await removeTree(staging);
        await verifyVersion(target, manifest);
        return target;
      }
    } catch (err) {
      await removeTree(staging).catch(() => {});
      throw err;
    }
    await makeReadOnly(target);
    return target;
  }
}

/**
 * Check a version directory against the manifest's inventory: exactly the inventory's files under
 * `payload/`, each a regular file with the recorded size and SHA-256, and nothing else — no link,
 * no special file, no extra entry. `ray.json` is kept beside them and must be a regular file.
 */
export async function verifyVersion(root: string, manifest: ApplicationManifest): Promise<void> {
  const { createHash } = await import('node:crypto');
  const expected = new Map(manifest.inventory.map((e) => [e.path, e]));
  const seen = new Set<string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, relative);
        continue;
      }
      if (!entry.isFile()) throw versionChanged();
      if (relative === 'ray.json') continue;
      const item = expected.get(relative);
      if (item === undefined) throw versionChanged();
      const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          hash.update(chunk as Buffer);
          size += (chunk as Buffer).length;
        }
        if (size !== item.size || hash.digest('hex') !== item.sha256) throw versionChanged();
      } finally {
        await handle.close();
      }
      seen.add(relative);
    }
  };
  await walk(root, '');
  if (seen.size !== expected.size) throw versionChanged();
}

function versionChanged(): StateDirectoryError {
  return new StateDirectoryError(
    bundleError(
      'RAY_DIGEST_MISMATCH',
      'a staged version directory no longer matches its bundle: a file was changed, added or ' +
        'removed. Remove that version directory and deploy again',
      { reason: 'entry-sha256' },
    ),
  );
}

/** Files 0400 and directories 0500, deepest first. */
async function makeReadOnly(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await makeReadOnly(full);
    else if (entry.isFile()) await chmod(full, 0o400);
  }
  await chmod(dir, 0o500);
}

/** Remove a directory tree this module made read-only. */
export async function removeTree(dir: string): Promise<void> {
  const writable = async (path: string): Promise<void> => {
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(path);
    } catch {
      return;
    }
    if (!stat.isDirectory()) return;
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await writable(join(path, entry));
  };
  await writable(dir);
  await rm(dir, { recursive: true, force: true });
}
