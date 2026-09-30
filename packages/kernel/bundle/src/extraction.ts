/**
 * The directory an archive is extracted into.
 *
 * The directory must not exist when extraction starts, and its parent must. It is created with
 * mode 0700; every directory below it is created by this code, one level at a time, and every file
 * is opened with `O_CREAT | O_EXCL | O_NOFOLLOW`, so nothing that exists is ever written through,
 * followed or overwritten. Names reaching here have passed every name rule of the reader (ASCII,
 * no `.` or `..`, no absolute or drive path, no backslash, no case or prefix collision), and each
 * resolved path is still checked to lie under the root.
 *
 * A directory under the root could still be swapped for a link by another process of the same
 * user while extraction runs. So before a file is opened, and again once it is open, the real path
 * of its directory must be the one it has under the root, and the path must lead to the file that
 * was opened; otherwise the file is closed before any byte is written and extraction is refused.
 * Such a swap can at most leave an empty file or directory where the link pointed.
 */
import { constants, type promises as fsp } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Refusal, refusal } from './source.js';

const FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export class ExtractionTarget {
  private created = false;
  /** The real path of the root, taken when it was created. */
  private realRoot = '';
  private readonly directories = new Set<string>();

  private constructor(readonly root: string) {}

  /** Check the destination before any byte of the archive is read. */
  static async prepare(destination: unknown): Promise<ExtractionTarget> {
    if (typeof destination !== 'string' || destination === '') {
      throw refusal('RAY_USAGE', 'the extraction directory is not a path');
    }
    const root = resolve(destination);
    if (await exists(root)) {
      throw refusal('RAY_OUTPUT_EXISTS', 'the extraction directory already exists');
    }
    let parent: Awaited<ReturnType<typeof lstat>>;
    try {
      parent = await lstat(dirname(root));
    } catch {
      throw refusal('RAY_USAGE', 'the parent of the extraction directory does not exist');
    }
    if (!parent.isDirectory()) {
      throw refusal('RAY_USAGE', 'the parent of the extraction directory is not a directory');
    }
    return new ExtractionTarget(root);
  }

  /** Create the root. It must still not exist. */
  async create(): Promise<void> {
    try {
      await mkdir(this.root, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw refusal('RAY_OUTPUT_EXISTS', 'the extraction directory already exists');
      }
      throw err;
    }
    this.created = true;
    // The mode given to mkdir is narrowed by the umask; the directory is private either way.
    await chmod(this.root, 0o700);
    this.realRoot = await realpath(this.root);
  }

  /** Create one file, and the directories above it, for writing. */
  async openFile(name: string): Promise<fsp.FileHandle> {
    if (!this.created) throw new Error('the extraction directory was not created');
    const path = resolve(this.root, name);
    const inside = relative(this.root, path);
    if (inside === '' || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
      throw refusal('RAY_INVALID_ARCHIVE', 'an entry would be written outside its directory', {
        reason: 'dot-segment',
      });
    }
    const segments = inside.split(sep);
    let dir = this.root;
    for (const segment of segments.slice(0, -1)) {
      dir = `${dir}${sep}${segment}`;
      if (this.directories.has(dir)) continue;
      await mkdir(dir, { mode: 0o700 });
      this.directories.add(dir);
    }
    const parent = join(this.realRoot, ...segments.slice(0, -1));
    await this.checkDirectory(dirname(path), parent);
    const handle = await open(path, FILE_FLAGS, 0o600);
    try {
      await this.checkDirectory(dirname(path), parent);
      const [opened, found] = await Promise.all([handle.stat(), lstat(path)]);
      if (opened.dev !== found.dev || opened.ino !== found.ino) throw directoryChanged();
    } catch (err) {
      await handle.close();
      throw err instanceof Refusal ? err : directoryChanged();
    }
    return handle;
  }

  /** Refuse unless the real path of `dir` is `expected`. */
  private async checkDirectory(dir: string, expected: string): Promise<void> {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      throw directoryChanged();
    }
    if (real !== expected) throw directoryChanged();
  }

  /** Remove the root and everything under it, if this target created it. */
  async discard(): Promise<void> {
    if (!this.created) return;
    await rm(this.root, { recursive: true, force: true });
    this.created = false;
  }
}

function directoryChanged() {
  return refusal(
    'RAY_INTERNAL',
    'the extraction directory changed while the archive was extracted',
  );
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
