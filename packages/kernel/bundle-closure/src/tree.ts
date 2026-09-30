/**
 * Reading the application tree without leaving it.
 *
 * Every path the resolver touches is anchored inside the application root, the directory of the
 * spec. A reference is refused before anything is read when it is absolute, climbs out of the root,
 * or passes through a symbolic link: a bundle holds regular files only, and following a link would
 * either copy a file from outside the root or put one file into the bundle under two names. The one
 * place links are followed is a dependency lookup in `node_modules`, where package managers link
 * packages into place; there the link's real target must still lie inside the root.
 *
 * A hard link is no symbolic link, but it is the same file under another name, and that name may
 * lie outside the root; the digest reports the link count so the resolver can refuse it.
 *
 * Files are opened without following links and read in chunks; each read computes the size, the
 * SHA-256, the private-key scan of the bundle's secret rules and the native-binary header check in
 * one pass.
 */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PrivateKeyScanner } from '@rayspec/bundle';
import { NATIVE_HEADER_BYTES, nativeBinaryPlatform } from './native.js';
import { refuse } from './refusal.js';

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CHUNK_BYTES = 1024 * 1024;

/** The size, digest and private-key verdict of one file's bytes. */
export interface FileDigest {
  size: number;
  sha256: string;
  privateKey: boolean;
  /** The platform when the file starts like a native binary (ELF, Mach-O or PE). */
  nativePlatform: string | undefined;
  /** How many names the file has on disk; more than one is a hard link. */
  links: number;
}

/** The size, digest and private-key verdict of bytes in memory. */
export function digestBytes(bytes: Uint8Array): FileDigest {
  const scanner = new PrivateKeyScanner();
  scanner.update(bytes);
  return {
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    privateKey: scanner.found,
    nativePlatform: nativeBinaryPlatform(bytes.subarray(0, NATIVE_HEADER_BYTES)),
    links: 1,
  };
}

export class ApplicationTree {
  private constructor(
    /** The real path of the application root. */
    readonly root: string,
  ) {}

  /** Open the tree rooted at `directory`, resolved to its real path. */
  static async open(directory: string): Promise<ApplicationTree> {
    return new ApplicationTree(await realpath(resolve(directory)));
  }

  /** The root-relative path of an absolute path inside the root, with `/` separators. */
  relativePath(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/');
  }

  /** Whether an absolute path lies inside the root (the root itself excluded). */
  contains(absolute: string): boolean {
    const rel = relative(this.root, absolute);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  }

  /**
   * Resolve a reference relative to `fromDirectory` and anchor it inside the root. Refused when it
   * is absolute, when it lands outside the root, or when any directory on the way, or the target
   * itself, is a symbolic link. Returns the absolute path and its status, or no status when the
   * target does not exist.
   */
  async anchor(
    fromDirectory: string,
    reference: string,
    what: string,
  ): Promise<{ path: string; stats: Stats | undefined }> {
    if (isAbsolute(reference) || /^[A-Za-z]:[\\/]/.test(reference)) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `${what} '${reference}' is an absolute path; name it relative to the spec`,
        {
          reason: 'escaping-link',
        },
      );
    }
    const target = resolve(fromDirectory, reference);
    if (!this.contains(target)) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `${what} '${reference}' resolves outside the application root, the directory of the spec; ` +
          'move it inside that directory',
        { reason: 'escaping-link' },
      );
    }
    return { path: target, stats: await this.statInside(target, what) };
  }

  /**
   * The status of a path already known to lie inside the root, checking that no directory between
   * the root and it, and not the path itself, is a symbolic link. No status when it does not exist.
   */
  async statInside(target: string, what: string): Promise<Stats | undefined> {
    const segments = relative(this.root, target).split(sep);
    let current = this.root;
    let stats: Stats | undefined;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        stats = await lstat(current);
      } catch {
        return undefined;
      }
      if (stats.isSymbolicLink()) await this.refuseLink(current, what);
    }
    return stats;
  }

  /** Refuse a symbolic link met in the tree, saying whether it escapes the root. */
  async refuseLink(path: string, what: string): Promise<never> {
    let escapes = true;
    try {
      escapes = !this.contains(await realpath(path));
    } catch {
      // A dangling link escapes nothing, but it is still a link.
      escapes = false;
    }
    return refuse(
      'RAY_CLOSURE_INVALID',
      escapes
        ? `${what} '${this.relativePath(path)}' is a symbolic link that leads outside the ` +
            'application root; copy the file it points to into the application instead'
        : `${what} '${this.relativePath(path)}' is a symbolic link; a bundle holds regular files ` +
            'only, so replace the link with the file it points to',
      { reason: 'escaping-link' },
    );
  }

  /**
   * Every regular file under `directory`, sorted by relative path, walking only into directories
   * that `keepDirectory` accepts and keeping only files `keepFile` accepts. A symbolic link or any
   * other entry that is not a regular file or a directory is refused.
   */
  async walk(
    directory: string,
    what: string,
    keepDirectory: (absolute: string, name: string) => boolean,
    keepFile: (absolute: string, name: string) => boolean,
  ): Promise<string[]> {
    const found: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) await this.refuseLink(path, what);
        if (entry.isDirectory()) {
          if (keepDirectory(path, entry.name)) await visit(path);
        } else if (entry.isFile()) {
          if (keepFile(path, entry.name)) found.push(path);
        } else {
          refuse(
            'RAY_CLOSURE_INVALID',
            `${what} '${this.relativePath(path)}' is not a regular file; a bundle holds regular ` +
              'files only',
            { reason: 'excluded-file' },
          );
        }
      }
    };
    await visit(directory);
    return found;
  }

  /** Read a whole file, without following a link. */
  async readFile(path: string): Promise<Buffer> {
    const handle = await open(path, READ_FLAGS);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        refuse('RAY_CLOSURE_INVALID', `'${this.relativePath(path)}' is not a regular file`, {
          reason: 'excluded-file',
        });
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  /** The size, SHA-256 and private-key verdict of a file, read in chunks without following a link. */
  async digestFile(path: string): Promise<FileDigest> {
    const handle = await open(path, READ_FLAGS);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        refuse('RAY_CLOSURE_INVALID', `'${this.relativePath(path)}' is not a regular file`, {
          reason: 'excluded-file',
        });
      }
      const hash = createHash('sha256');
      const scanner = new PrivateKeyScanner();
      const buffer = Buffer.alloc(CHUNK_BYTES);
      let size = 0;
      let nativePlatform: string | undefined;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, size);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        if (size === 0)
          nativePlatform = nativeBinaryPlatform(chunk.subarray(0, NATIVE_HEADER_BYTES));
        hash.update(chunk);
        scanner.update(chunk);
        size += bytesRead;
      }
      return {
        size,
        sha256: hash.digest('hex'),
        privateKey: scanner.found,
        nativePlatform,
        links: stats.nlink,
      };
    } finally {
      await handle.close();
    }
  }
}
