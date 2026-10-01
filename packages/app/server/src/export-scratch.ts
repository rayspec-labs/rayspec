/**
 * THE SCRATCH SPACE OF AN EXPORT — `scratch/` in the deployment state directory (mode 0700, owned by
 * the operator, checked like the state directory itself), where the capture's private directory and
 * the plaintext inner snapshot live while an export runs, and nowhere else.
 *
 * ONE EXPORT AT A TIME. An export holds `scratch/export.lock` (created exclusively, mode 0600, holding
 * the process id and the operation id) for as long as it runs. A second export of the same deployment
 * finds the lock of a live process and is refused with `RAY_LOCK_TIMEOUT` (retryable).
 *
 * A KILLED EXPORT cannot clean up: its lock and its capture directory, plaintext included, stay
 * behind. The next export finds a lock whose process is gone, removes everything else in `scratch/`
 * (only exports write there, and none is running), removes the lock, takes its own, and reports
 * which operation it cleaned up after, so that operation's receipt can be closed.
 *
 * The liveness check is `kill(pid, 0)`: a process id the system reused for an unrelated process
 * keeps a stale lock looking live, and the export is refused until that process ends or the operator
 * removes the lock. That fails safe: nothing is removed while it could belong to a running export.
 */
import { constants } from 'node:fs';
import { chmod, lstat, open, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { bundleError } from '@rayspec/bundle-contract';
import { type StateDirectory, StateDirectoryError } from './deployment-state.js';

export const EXPORT_LOCK_NAME = 'export.lock';

export interface ExportScratch {
  /** The scratch directory: the parent of the capture's private directory. */
  dir: string;
  /** The operation a killed export left its scratch data under, now removed; null when none. */
  cleanedUpAfter: string | null;
  /** How many leftover entries were removed. */
  removedEntries: number;
  /** Remove every entry this export left and give the lock up. */
  release(): Promise<void>;
}

interface LockRecord {
  pid: number;
  operationId: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LockRecord>;
    if (Number.isSafeInteger(value.pid) && typeof value.operationId === 'string') {
      return { pid: value.pid as number, operationId: value.operationId };
    }
  } catch {
    // unreadable or half written: treated as a lock without a live owner below
  }
  return null;
}

async function createLock(path: string, record: LockRecord): Promise<boolean> {
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
    await handle.writeFile(JSON.stringify(record), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/** Remove every entry of `dir` but the lock file; returns how many there were. */
async function clearExceptLock(dir: string): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(dir)) {
    if (entry === EXPORT_LOCK_NAME) continue;
    await makeRemovable(join(dir, entry));
    await rm(join(dir, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Give the owner write access to every directory under `path`, so the removal cannot stop half way. */
async function makeRemovable(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (stat === null || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(path, 0o700).catch(() => {});
    for (const entry of await readdir(path).catch(() => [] as string[])) {
      await makeRemovable(join(path, entry));
    }
  }
}

/**
 * Take the scratch space of the deployment for the export `operationId`. Refuses with
 * `RAY_LOCK_TIMEOUT` while another export of it is running; cleans up after one that was killed.
 * Throws `StateDirectoryError` for a refusal.
 */
export async function takeExportScratch(
  stateDir: StateDirectory,
  operationId: string,
): Promise<ExportScratch> {
  const dir = await stateDir.scratchDirectory();
  const lock = join(dir, EXPORT_LOCK_NAME);
  const mine: LockRecord = { pid: process.pid, operationId };
  let cleanedUpAfter: string | null = null;
  let removedEntries = 0;
  for (let attempt = 0; ; attempt++) {
    if (await createLock(lock, mine)) break;
    const held = await readLock(lock);
    if (held !== null && held.pid !== process.pid && isAlive(held.pid)) {
      throw new StateDirectoryError(
        bundleError(
          'RAY_LOCK_TIMEOUT',
          `another export of this deployment is running (process ${held.pid}); wait for it to end`,
        ),
      );
    }
    if (attempt > 0) {
      throw new StateDirectoryError(
        bundleError(
          'RAY_LOCK_TIMEOUT',
          'the scratch lock of this deployment keeps changing; retry',
        ),
      );
    }
    // The export that held it is gone: what it left is removed before the lock is.
    cleanedUpAfter = held?.operationId ?? null;
    removedEntries = await clearExceptLock(dir);
    await unlink(lock).catch(() => {});
  }
  return {
    dir,
    cleanedUpAfter,
    removedEntries,
    release: async () => {
      await clearExceptLock(dir).catch(() => 0);
      const held = await readLock(lock);
      if (held?.operationId === operationId && held.pid === process.pid) {
        await unlink(lock).catch(() => {});
      }
    },
  };
}
