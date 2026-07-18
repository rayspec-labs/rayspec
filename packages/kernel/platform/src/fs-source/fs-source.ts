/**
 * The fs-backed `FsSource` impl — the deployer-injected, READ-ONLY, path-jailed local-file reader.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SECURITY — the path jail IS the ENTIRE containment for this capability.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * An `FsSource` reads real files off the box, so a jail escape would read ARBITRARY host files
 * (`/etc/passwd`, another deployment's secrets). There is no second line of defense — this impl is the
 * ONLY one — so it enforces containment STRUCTURALLY, in independent layers (defense-in-depth):
 *
 *   1. READ-ONLY BY CONSTRUCTION. The handle exposes only `list`/`read`/`search` — no write / delete /
 *      move / create surface exists at all, so a handler cannot mutate the source tree through it.
 *
 *   2. THE PATH JAIL. Every caller path is REJECTED fail-closed if it could escape the configured root:
 *      empty (for a read), a null byte, a URL-significant char (`% # ?` — `%2e%2e` URL-decodes to `..`),
 *      a leading `/` / absolute path, OR a `..` traversal segment. THEN the resolved on-disk path is
 *      realpath'd and asserted to be STRICTLY under the realpath of the root (`realTarget.startsWith(
 *      realRoot + sep)`) — the segment-boundary assert that catches any SYMLINK / normalization escape
 *      the lexical checks missed (a symlink whose real target climbs out of the root is refused). Both
 *      must pass or the operation throws (`FsSourceJailError`) — never a read of foreign bytes.
 *
 *   3. ENUMERATION NEVER TRAVERSES A SYMLINK. `list`/`search` report/scan only REGULAR files +
 *      directories (a symlink dirent is skipped), so a symlink planted inside the root can never
 *      redirect a walk out of it. An EXPLICIT `read` of a symlink is still allowed IFF its real target
 *      stays within the root (the layer-2 realpath assert decides) — a symlink pointing OUT is refused.
 *
 * NOT TENANT-PARTITIONED: unlike the `BlobStore` (per-tenant writable storage), an `FsSource` reads
 * DEPLOYMENT-static assets shared across the deployment; v1 is one-deployment-one-tenant, so there is no
 * per-tenant partition (per-tenant read roots are a later, hardening-adjacent concern). The factory
 * therefore takes no tenant argument.
 *
 * TRUSTED-AUTHOR, NOT SANDBOXED: a handler runs in-process and could reach `fs` directly via Node
 * globals; this impl is the DB-capability-equivalent seam for local files (the sanctioned, contained
 * path), real confinement is the per-tenant isolate. The jail still holds for any handler that uses the
 * injected handle (the `gate:extension-capability` tripwire forbids self-constructing one).
 */

import { realpathSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type {
  FsSource,
  FsSourceEntry,
  FsSourceFactory,
  FsSourceMatch,
  FsSourceNotFound,
  FsSourceReadOptions,
  FsSourceReadResult,
  FsSourceSearchOptions,
} from '@rayspec/handler-sdk';

/** URL-significant chars that are a URL-decode / fragment jail-bypass vector (`%2e%2e` → `..`). */
const URL_SIGNIFICANT = /[%#?]/;

/** The default byte cap on a single `read` (a read is buffered, not streamed) — 8 MiB. */
export const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;

/** The default cap on the number of `search` matches returned (the walk stops once it is reached). */
export const DEFAULT_MAX_SEARCH_RESULTS = 200;

/** `search` skips any file larger than this (a huge file is not a text source we scan line-by-line) — 2 MiB. */
const SEARCH_MAX_FILE_SCAN_BYTES = 2 * 1024 * 1024;

/** `search` descends at most this many directory levels below its start dir (a bounded walk). */
const SEARCH_MAX_DEPTH = 32;

/** `search` scans at most this many files total (a bounded walk — a pathological tree cannot run away). */
const SEARCH_MAX_FILES_SCANNED = 5000;

/** A path-jail violation — a caller path that could escape the source root. Fail-closed (never an I/O op). */
export class FsSourceJailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsSourceJailError';
  }
}

/** An fs-source misconfiguration (e.g. the configured root does not exist / is not a directory). Fail-closed. */
export class FsSourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsSourceConfigError';
  }
}

/** An fs-source operational refusal (e.g. a `read` of a file larger than the byte cap). Fail-closed. */
export class FsSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsSourceError';
  }
}

/** `realpathSync`, returning undefined on ENOENT/any error (best-effort symlink resolution). */
function realpathSafe(p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** Walk up from `p` to the first ancestor that exists on disk (for the realpath assert on an absent path). */
function deepestExisting(p: string): string {
  let cur = p;
  for (;;) {
    const parent = resolve(cur, '..');
    if (parent === cur) return cur; // reached the fs root
    if (realpathSafe(parent)) return parent;
    cur = parent;
  }
}

/** Render an absolute path UNDER `root` as a POSIX-style (forward-slash) root-relative path. */
function toPosixRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel.split(sep).join('/');
}

/**
 * Validate + resolve a root-relative caller path to its absolute on-disk path UNDER `root`, fail-closed
 * on any escape. Pure-ish (lexical checks + a realpath assert); throws `FsSourceJailError`. `root` is the
 * already-resolved source root. Layered (mirrors the blob path jail):
 *   (0) reject null-byte / URL-significant (`% # ?`) paths at the SOURCE;
 *   (1) an EMPTY / '.' path is the ROOT itself when `allowRoot` (list/search may target the root), else
 *       fail-closed (a read needs a file path);
 *   (2) reject an absolute / leading-`/` path;
 *   (3) reject a `..` traversal segment in the RAW path (before normalize collapses it);
 *   (4) resolve under the root + assert the relative result does not climb out (lexical belt);
 *   (5) realpath the root + the deepest existing ancestor of the target and assert the target is STRICTLY
 *       under the real root — the segment-boundary assert that defeats a SYMLINK / normalization escape.
 */
export function jailPath(root: string, callerPath: string, allowRoot = false): string {
  if (typeof callerPath !== 'string') {
    throw new FsSourceJailError('fs-source path must be a string (fail-closed).');
  }
  // (0) null byte — truncates a path at the C-string boundary in some syscalls; reject outright.
  if (callerPath.includes('\0')) {
    throw new FsSourceJailError('fs-source path contains a null byte (fail-closed).');
  }
  // (0) URL-significant chars — `%2e%2e` URL-decodes to `..`; `#`/`?` start a URL fragment/query.
  if (URL_SIGNIFICANT.test(callerPath)) {
    throw new FsSourceJailError(
      `fs-source path '${callerPath}' contains a URL-significant char (% # ?) — a URL-decode/fragment ` +
        'jail-bypass vector (e.g. %2e%2e → ..). Rejected at the source (fail-closed).',
    );
  }
  // (1) empty / '.' → the root itself (list/search) OR fail-closed (read needs a file path).
  if (callerPath === '' || callerPath === '.') {
    if (allowRoot) return root;
    throw new FsSourceJailError(
      'fs-source path is empty (fail-closed) — a root-relative file path is required.',
    );
  }
  // (2) absolute / leading-slash — a path is always RELATIVE to the source root.
  if (isAbsolute(callerPath) || callerPath.startsWith('/') || callerPath.startsWith('\\')) {
    throw new FsSourceJailError(
      `fs-source path '${callerPath}' is absolute / leading-slash — paths are relative to the source ` +
        'root (fail-closed).',
    );
  }
  // (3) a `..` traversal segment ANYWHERE in the raw path — checked BEFORE normalize (which would
  // collapse an inward `a/../b` and slip past a normalized check). Forbid the segment outright.
  const rawSegments = callerPath.split(/[/\\]/);
  if (rawSegments.includes('..')) {
    throw new FsSourceJailError(
      `fs-source path '${callerPath}' contains a '..' traversal segment — a path may not climb out of ` +
        'the source root (fail-closed).',
    );
  }
  // (4) lexical containment belt: resolve under the root, confirm the relative result stays in.
  const absolute = resolve(root, normalize(callerPath));
  const rel = relative(root, absolute);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new FsSourceJailError(
      `fs-source path '${callerPath}' resolves OUTSIDE the source root — refusing (fail-closed).`,
    );
  }
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new FsSourceJailError(
      `fs-source path '${callerPath}' does not resolve UNDER the source root — refusing (fail-closed).`,
    );
  }
  // (5) realpath segment-boundary assert (defense-in-depth — catches a symlink/normalization escape):
  // realpath the root + the deepest EXISTING ancestor of the target, and assert the target is strictly
  // under the real root. Best-effort on a not-yet-existing target (the deepest existing ancestor is
  // checked — so a symlinked ANCESTOR that climbs out is caught even for an absent leaf).
  const realRoot = realpathSafe(root);
  const realTarget = realpathSafe(absolute) ?? realpathSafe(deepestExisting(absolute));
  if (realRoot && realTarget && realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new FsSourceJailError(
      `fs-source path '${callerPath}' resolves (after following symlinks) to '${realTarget}', OUTSIDE ` +
        `the source root '${realRoot}' — refusing (fail-closed, realpath segment-boundary).`,
    );
  }
  return absolute;
}

/** Does `buf` look like binary (a NUL byte in the scanned prefix)? `search` skips such files. */
function looksBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

/**
 * Build a READ-ONLY `FsSource` over an already-resolved absolute `root`. Every path a caller supplies is
 * jailed strictly under `root`. The handle is stateless (read-only), so the SAME handle is safe to reuse
 * across runs.
 */
function makeFsSource(root: string): FsSource {
  return {
    async list(dir?: string): Promise<FsSourceEntry[] | FsSourceNotFound> {
      const absDir = jailPath(root, dir ?? '', true);
      let dirents: Awaited<ReturnType<typeof readdir>>;
      try {
        dirents = await readdir(absDir, { withFileTypes: true });
      } catch {
        // ENOENT (absent dir) / ENOTDIR (a file, not a dir) → the typed not-found (fail-closed).
        return { notFound: true, path: dir ?? '' };
      }
      const entries: FsSourceEntry[] = [];
      for (const dirent of dirents) {
        // Enumerate ONLY regular files + directories — a SYMLINK dirent (isSymbolicLink) is skipped so a
        // planted symlink can never redirect the listing out of the root (an explicit `read` follows an
        // in-root symlink; enumeration never does).
        const abs = resolve(absDir, dirent.name);
        const path = toPosixRelative(root, abs);
        if (dirent.isFile()) {
          let size = 0;
          try {
            size = (await stat(abs)).size;
          } catch {
            continue; // vanished between readdir + stat — skip fail-closed.
          }
          entries.push({ name: dirent.name, path, type: 'file', size });
        } else if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, path, type: 'directory', size: 0 });
        }
        // else: a symlink / socket / device / fifo — not enumerated.
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return entries;
    },

    async read(
      path: string,
      opts?: FsSourceReadOptions,
    ): Promise<FsSourceReadResult | FsSourceNotFound> {
      const absolute = jailPath(root, path, false);
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(absolute); // follows a symlink — the jail already confirmed the real target is in-root.
      } catch {
        return { notFound: true, path }; // ENOENT → typed not-found (fail-closed).
      }
      // A directory / non-regular file is not readable as bytes → typed not-found (never a throw).
      if (!st.isFile()) return { notFound: true, path };
      const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_READ_BYTES;
      if (st.size > maxBytes) {
        // Refuse fail-closed rather than silently truncate (a truncated read is a subtle correctness bug).
        throw new FsSourceError(
          `fs-source read of '${path}' is ${st.size} bytes, over the ${maxBytes}-byte cap — refusing ` +
            '(fail-closed; raise maxBytes to read a larger file).',
        );
      }
      const buf = await readFile(absolute);
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      return { bytes, contentLength: bytes.length };
    },

    async search(query: string, opts?: FsSourceSearchOptions): Promise<FsSourceMatch[]> {
      const matches: FsSourceMatch[] = [];
      if (query.length === 0) return matches; // an empty query matches nothing (never "everything").
      const maxResults = opts?.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS;
      const caseSensitive = opts?.caseSensitive ?? true;
      const needle = caseSensitive ? query : query.toLowerCase();
      const startDir = jailPath(root, opts?.dir ?? '', true);

      let filesScanned = 0;
      const walk = async (absDir: string, depth: number): Promise<void> => {
        if (matches.length >= maxResults || depth > SEARCH_MAX_DEPTH) return;
        let dirents: Awaited<ReturnType<typeof readdir>>;
        try {
          dirents = await readdir(absDir, { withFileTypes: true });
        } catch {
          return; // an unreadable / absent dir contributes nothing (fail-closed, never throws mid-walk).
        }
        for (const dirent of dirents) {
          if (matches.length >= maxResults) return;
          // Skip a SYMLINK (never traverse it) + anything that is neither a regular file nor a directory.
          if (dirent.isSymbolicLink()) continue;
          const abs = resolve(absDir, dirent.name);
          if (dirent.isDirectory()) {
            await walk(abs, depth + 1);
            continue;
          }
          if (!dirent.isFile()) continue;
          if (filesScanned >= SEARCH_MAX_FILES_SCANNED) return;
          filesScanned += 1;
          let buf: Buffer;
          try {
            const st = await stat(abs);
            if (st.size > SEARCH_MAX_FILE_SCAN_BYTES) continue; // too large to scan as text — skip.
            buf = await readFile(abs);
          } catch {
            continue; // unreadable / vanished — skip fail-closed.
          }
          if (looksBinary(buf)) continue; // a binary file is not a text source we scan line-by-line.
          const relPath = toPosixRelative(root, abs);
          const lines = buf.toString('utf8').split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i] as string;
            const hay = caseSensitive ? line : line.toLowerCase();
            if (hay.includes(needle)) {
              matches.push({ path: relPath, line: i + 1, text: line.replace(/\r$/, '') });
              if (matches.length >= maxResults) return;
            }
          }
        }
      };
      await walk(startDir, 0);
      return matches;
    },
  };
}

/**
 * Build the composition-root `FsSourceFactory` over a deployer-configured local `root`. The engine calls
 * `factory()` per run/request; this returns a READ-ONLY handle jailed under `root`. The `root` is the
 * deployer's read directory (LOCAL/self-host — before external-exposure hardening; a shared, deployment-
 * static content root, NOT per-tenant data).
 *
 * The `root` is resolved to an absolute path and VALIDATED to be an existing directory ONCE at build
 * time — a missing / non-directory root fail-closes with an `FsSourceConfigError` (a read-only source
 * with no directory is a deploy misconfiguration; nothing here creates it).
 */
export function makeFsSourceFactory(root: string): FsSourceFactory {
  const absRoot = resolve(root);
  let isDir = false;
  try {
    isDir = statSync(absRoot).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new FsSourceConfigError(
      `FsSource: the configured source root '${absRoot}' does not exist or is not a directory — ` +
        'refusing (fail-closed; a read-only source root must be an existing directory on the box).',
    );
  }
  const handle = makeFsSource(absRoot);
  return (): FsSource => handle;
}

/**
 * The path-jail primitive, exported for the fail-the-fix jail unit test (it asserts the EXACT logic the
 * impl runs). `root` is the resolved source root; returns the jailed absolute path or throws
 * `FsSourceJailError`. `allowRoot` mirrors the list/search "empty path = the root" allowance.
 */
export { jailPath as __jailPathForTest };
