/**
 * The fs-backed `FsSink` impl — the deployer-injected, WRITE-ONLY, path-jailed, byte-bounded local-file
 * writer. The WRITE twin of `fs-source.ts`, and deliberately narrower than it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SECURITY — the path jail IS the ENTIRE containment, and a WRITE raises the stakes over a read.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * An `FsSink` writes real files onto the box, so a jail escape would OVERWRITE arbitrary host files
 * (a deployment's config, another deployment's data, an executable on a PATH). A read escape leaks;
 * a write escape corrupts. There is no second line of defense — this impl is the ONLY one — so it
 * enforces containment STRUCTURALLY, in independent layers (defense-in-depth):
 *
 *   1. WRITE-ONLY, WHOLE-FILE, BY CONSTRUCTION. The handle exposes only `write` + `quota` — no read,
 *      list, search, append, delete, move, or create-dir surface exists at all. A caller cannot use
 *      this handle to learn anything about the tree, nor to remove anything from it.
 *
 *   2. THE PATH JAIL — THE SAME ONE THE READ SIDE USES. `jailPath` is IMPORTED from `fs-source.ts`,
 *      not reimplemented: a second copy of a security-critical function is a second thing to get
 *      wrong, and a divergence between the read jail and the write jail would be invisible until it
 *      mattered. It rejects, fail-closed: a null byte, a URL-significant char (`% # ?` — `%2e%2e`
 *      URL-decodes to `..`), an empty path, a leading `/` / absolute path, a `..` traversal segment
 *      checked in the RAW path before `normalize` can collapse it, a lexical resolution outside the
 *      root, AND — the layer that catches what the string checks cannot — a `realpath` of the deepest
 *      EXISTING ancestor that lands outside the real root. That last one is what defeats a path which
 *      is INSIDE after normalization but whose PARENT DIRECTORY is a symlink pointing out.
 *
 *   3. NO SYMLINK LEAF, EVER. Where `FsSource.read` deliberately PERMITS reading an in-root symlink
 *      (its target is jailed, so the bytes are in-root either way), a write through a symlink buys
 *      nothing and costs the classic escape — so the leaf is `lstat`'d and refused if it is a symlink,
 *      and the open then carries `O_NOFOLLOW` so a symlink swapped in between the two cannot be
 *      followed either. The factory REFUSES TO BUILD on a platform without `O_NOFOLLOW` rather than
 *      silently degrading to the `lstat` check alone.
 *
 *   4. PARENTS ARE CREATED BY US, THEN RE-VERIFIED. Missing parent directories are created with a
 *      recursive `mkdir` under the root. This is a real window: at jail time the parent did not exist,
 *      so layer 2's realpath assert could only check a HIGHER ancestor. So after creating them we
 *      re-run the realpath assert ON THE NOW-EXISTING PARENT. A parent that was created as, or swapped
 *      for, a symlink out of the root is caught there.
 *
 *   5. BOUNDS ARE CHECKED BEFORE ANYTHING IS OPENED. A refused write must leave NOTHING behind — not a
 *      truncated file, not an empty one, not a created directory. So every quota check runs before the
 *      first `mkdir`, and certainly before the `O_TRUNC` open that would destroy existing content.
 *
 * THREAT MODEL — the containment assumes the configured root (and everything under it) is
 * DEPLOYMENT-CONTROLLED and NOT attacker-writable: the jail confines a caller-supplied PATH, it does not
 * defend against an adversary who can already plant/rewrite symlinks inside the root at will (out of
 * scope for the trusted, one-deployment-one-tenant, deployment-static posture). Given that root, a
 * caller can never write OUTSIDE it.
 *
 * WHAT THIS CONFINES, STATED HONESTLY: the MODEL, not the handler author. A handler runs in-process and
 * could reach `fs` directly via Node globals (`gate:handler-imports` forbids platform internals and
 * agent SDKs, NOT `node:` builtins); this impl is the DB-capability-equivalent seam for local files —
 * the sanctioned, contained path — and real confinement is the per-tenant isolate. The guarantee it
 * does make is the one that matters here: a MODEL-SUPPLIED path and MODEL-SUPPLIED bytes cannot escape
 * the root or exceed the declared budget. The `gate:extension-capability` tripwire forbids a handler
 * self-constructing one of these over a root it chose itself.
 *
 * NOT TENANT-PARTITIONED: like `FsSource`, this writes to DEPLOYMENT-static storage shared across the
 * deployment; v1 is one-deployment-one-tenant, so there is no per-tenant partition (per-tenant output
 * roots are a later, hardening-adjacent concern). The factory therefore takes no tenant argument. A
 * handler that needs per-tenant writable storage uses `BlobStore`, which IS tenant-prefixed.
 *
 * ⚠ AUDITABILITY, AND THE INFERENCE TO BLOCK. The dispatch chokepoint journals one step per call —
 * the tool's `{ path, bytesWritten, created }` verbatim on success, a `status: 'error'` step with the
 * typed message on a refusal. So WHAT was written and WHAT was refused is recorded. WHICH SEAT wrote
 * it is NOT: nothing joins a tool-step row to a seat, task or turn. "Journaled" here does not mean
 * "attributable", and the word should not be allowed to imply it. That gap is PRE-EXISTING and
 * repo-wide (every tool step, every capability), not introduced by this file — but this is the
 * capability that makes it conspicuous, because "a file was written" is a far weaker audit line than
 * "seat X on task Y wrote this file". Closing it means extending the frozen workforce event
 * vocabulary and is tracked as its own decision. See the `FsSink` contract for the full statement.
 */

import { constants as fsConstants, realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { FsSink, FsSinkFactory, FsSinkQuota, FsSinkWriteResult } from '@rayspec/handler-sdk';
import { FsSourceJailError, jailPath } from '../fs-source/fs-source.js';

/** The default cap on the bytes ONE write may carry — 1 MiB. */
export const DEFAULT_MAX_SINK_BYTES_PER_FILE = 1024 * 1024;

/** The default cap on the TOTAL bytes one sink will hold across every distinct path — 32 MiB. */
export const DEFAULT_MAX_SINK_TOTAL_BYTES = 32 * 1024 * 1024;

/** The default cap on the number of DISTINCT paths one sink will create. */
export const DEFAULT_MAX_SINK_FILES = 256;

/**
 * A path-jail violation — a caller path that could escape the output root, or a leaf that is not a
 * plain regular file. Fail-closed (thrown BEFORE any write).
 */
export class FsSinkJailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsSinkJailError';
  }
}

/**
 * A declared bound was exceeded (per-file bytes, total bytes, or file count). Fail-closed and thrown
 * BEFORE the file is opened, so nothing is written and nothing existing is truncated.
 */
export class FsSinkQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsSinkQuotaError';
  }
}

/** An fs-sink misconfiguration (root missing / not a directory / unusable platform). Fail-closed. */
export class FsSinkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsSinkConfigError';
  }
}

/** The deployer-declared bounds a sink enforces. Every field optional; each falls back to its default. */
export interface FsSinkQuotaConfig {
  readonly maxBytesPerFile?: number;
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
}

/** Render an absolute path UNDER `root` as a POSIX-style (forward-slash) root-relative path. */
function toPosixRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * Assert that an EXISTING directory resolves (after following symlinks) to a location strictly under
 * the real root. This is layer 4's re-verification: at jail time the directory may not have existed, so
 * the realpath assert could only reach a higher ancestor.
 *
 * ⚠ HONEST NOTE ON WHAT PINS THIS — corrected against the mutation battery, which disproved the first
 * version of this paragraph. In every escape a test stages, `jailPath`'s layer-5 assert refuses the path
 * BEFORE control reaches here (its `deepestExisting` walk finds the symlinked ancestor whether or not
 * the leaf exists), so mutating this re-assert away leaves the write-path arms GREEN. It is therefore
 * EXPORTED and pinned directly (`__assertRealDirUnderRootForTest`, arms R1-R5): mutating its comparison
 * reddens R3/R4, and R4 specifically fails if the segment boundary degrades to a bare `startsWith`,
 * which would admit a sibling directory sharing the root's name prefix.
 *
 * What is NOT claimed: an end-to-end proof of the TOCTOU race this exists for. And note the battery's
 * broader correction — a symlink LEAF turns out to be refused by FOUR independent layers here (jail
 * layer 5, `isSymbolicLink()`, `isFile()` — a symlink is not a regular file — and `O_NOFOLLOW`), so no
 * single one of them can be called "the" guard. Only removing all four lets the escape through.
 */
export async function assertRealDirUnderRoot(
  realRoot: string,
  dir: string,
  callerPath: string,
): Promise<void> {
  let realDir: string;
  try {
    realDir = await realpath(dir);
  } catch (e) {
    throw new FsSinkJailError(
      `fs-sink path '${callerPath}': its parent directory could not be resolved after creation ` +
        `(fail-closed): ${String(e)}`,
    );
  }
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw new FsSinkJailError(
      `fs-sink path '${callerPath}': its parent directory resolves (after following symlinks) to ` +
        `'${realDir}', OUTSIDE the output root '${realRoot}' — refusing (fail-closed, realpath ` +
        'segment-boundary re-assert after directory creation).',
    );
  }
}

/**
 * Build a WRITE-ONLY `FsSink` over an already-resolved absolute `root` with resolved bounds. The handle
 * is STATEFUL (it accounts for what it has written), so each call to the factory mints a FRESH one — a
 * run's budget is its own.
 */
function makeFsSink(root: string, realRoot: string, quota: Required<FsSinkQuotaConfig>): FsSink {
  /**
   * Per-path byte accounting. The total is the SUM of the CURRENT size of each distinct path, not a
   * running sum of every write — so re-writing a path REPLACES its contribution.
   *
   * That is not a nicety, it is required for correctness: a workforce turn re-executes on recovery, and
   * a whole-file write is offered to a seat precisely because replaying it is safe. Cumulative
   * accounting would charge the replay a second time and let a RECOVERY exhaust a budget the original
   * turn had already paid — turning crash-safety into a spurious refusal.
   */
  const bytesByPath = new Map<string, number>();
  let totalBytes = 0;

  return {
    async write(path: string, bytes: Uint8Array): Promise<FsSinkWriteResult> {
      if (!(bytes instanceof Uint8Array)) {
        throw new FsSinkJailError(
          'fs-sink write expects the file contents as a Uint8Array (fail-closed) — encode text ' +
            'yourself, e.g. new TextEncoder().encode(text).',
        );
      }
      // ---- LAYER 2: the path jail, the SAME function the read side runs. -----------------------
      // Re-thrown under this capability's own error name so a seat reads `FsSinkJailError` and knows
      // which capability refused it; the original message (which names the exact layer that fired) is
      // carried through verbatim.
      let absolute: string;
      try {
        absolute = jailPath(root, path, false);
      } catch (e) {
        if (e instanceof FsSourceJailError) {
          throw new FsSinkJailError(e.message.replace(/^fs-source /, 'fs-sink '));
        }
        throw e;
      }
      const relPath = toPosixRelative(root, absolute);

      // ---- LAYER 5: EVERY bound checked BEFORE any filesystem mutation. -------------------------
      // Ordering is the guarantee: nothing is created, nothing is truncated, on a refused write.
      const size = bytes.byteLength;
      if (size > quota.maxBytesPerFile) {
        throw new FsSinkQuotaError(
          `fs-sink refuses to write ${size} bytes to '${relPath}': one file may carry at most ` +
            `${quota.maxBytesPerFile} bytes. Write less, or split the content across files — the ` +
            "bound is the deployment's, not this call's.",
        );
      }
      const previous = bytesByPath.get(relPath);
      const projectedTotal = totalBytes - (previous ?? 0) + size;
      if (projectedTotal > quota.maxTotalBytes) {
        throw new FsSinkQuotaError(
          `fs-sink refuses to write ${size} bytes to '${relPath}': it would bring this run's total ` +
            `to ${projectedTotal} bytes, over the ${quota.maxTotalBytes}-byte budget ` +
            `(${totalBytes} already written). Re-writing a file you already wrote does not cost ` +
            'extra; writing a new one does.',
        );
      }
      if (previous === undefined && bytesByPath.size >= quota.maxFiles) {
        throw new FsSinkQuotaError(
          `fs-sink refuses to create '${relPath}': this run has already written ` +
            `${bytesByPath.size} files, the maximum. Re-writing one of those paths is still ` +
            'allowed; creating a new one is not.',
        );
      }

      // ---- LAYER 4: create the parents, then RE-VERIFY them. ------------------------------------
      const parent = dirname(absolute);
      try {
        await mkdir(parent, { recursive: true });
      } catch (e) {
        throw new FsSinkJailError(
          `fs-sink path '${path}': could not create its parent directory (fail-closed): ${String(e)}`,
        );
      }
      // The parent EXISTS now, so the realpath assert can finally see it. At jail time it may not
      // have, and layer 2 could then only check a higher ancestor.
      await assertRealDirUnderRoot(realRoot, parent, path);

      // ---- LAYER 3: no symlink leaf, and learn whether this is a creation. ----------------------
      // `lstat` (never `stat`) so a symlink is SEEN as a symlink rather than followed.
      let created = true;
      try {
        const st = await lstat(absolute);
        created = false;
        if (st.isSymbolicLink()) {
          throw new FsSinkJailError(
            `fs-sink path '${path}' is a SYMLINK — writing through a symlink is refused outright ` +
              '(fail-closed), whatever it points at. Write to a real path under the output root.',
          );
        }
        if (!st.isFile()) {
          throw new FsSinkJailError(
            `fs-sink path '${path}' exists and is not a regular file (a directory, socket or ` +
              'device) — refusing to write over it (fail-closed).',
          );
        }
      } catch (e) {
        if (e instanceof FsSinkJailError) throw e;
        // ENOENT (and only ENOENT, in practice) — the path does not exist yet; this is a creation.
        created = true;
      }

      // ---- THE WRITE: one open, O_NOFOLLOW, whole-file replace. ---------------------------------
      // O_NOFOLLOW closes the window between the `lstat` above and this open: a symlink swapped in
      // there cannot be followed, the open fails instead. O_TRUNC is what makes this a WHOLE-FILE
      // write (and therefore replay-safe) rather than an append.
      const flags =
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
      let fh: Awaited<ReturnType<typeof open>>;
      try {
        fh = await open(absolute, flags, 0o644);
      } catch (e) {
        throw new FsSinkJailError(
          `fs-sink path '${path}': the write could not be opened (fail-closed — a symlink swapped ` +
            `in after the check is refused here by O_NOFOLLOW): ${String(e)}`,
        );
      }
      try {
        if (size > 0) await fh.write(bytes, 0, size, 0);
      } finally {
        await fh.close();
      }

      // ---- ACCOUNTING, after the bytes are durable to the handle. -------------------------------
      bytesByPath.set(relPath, size);
      totalBytes = totalBytes - (previous ?? 0) + size;

      return { path: relPath, bytesWritten: size, created };
    },

    quota(): FsSinkQuota {
      return {
        maxBytesPerFile: quota.maxBytesPerFile,
        maxTotalBytes: quota.maxTotalBytes,
        maxFiles: quota.maxFiles,
        bytesWritten: totalBytes,
        filesWritten: bytesByPath.size,
      };
    },
  };
}

/**
 * Build the composition-root `FsSinkFactory` over a deployer-configured local output `root`. The engine
 * calls `factory()` per run; each call returns a FRESH handle with its OWN budget, jailed under `root`.
 *
 * The `root` is resolved to an absolute path and VALIDATED to be an existing directory ONCE at build
 * time — a missing / non-directory root fail-closes with an `FsSinkConfigError`. Nothing here CREATES
 * the root: a deployer who has not made the output directory has not decided where output goes, and
 * inventing one is exactly the kind of helpful guess that puts files somewhere nobody is watching.
 *
 * The root is also `realpath`'d ONCE here, so every per-write assert compares against a stable resolved
 * root rather than re-resolving (and re-racing) it on each call.
 *
 * REFUSES TO BUILD without `O_NOFOLLOW` (a platform that lacks it — Windows). Degrading silently to the
 * `lstat` check alone would leave a check-then-use window on the one operation that overwrites data,
 * and a capability that is weaker on some platforms than its documentation says is worse than one that
 * declines to start.
 */
export function makeFsSinkFactory(root: string, quota?: FsSinkQuotaConfig): FsSinkFactory {
  if (typeof fsConstants.O_NOFOLLOW !== 'number') {
    throw new FsSinkConfigError(
      'FsSink: this platform does not provide O_NOFOLLOW, so a symlink swapped in between the ' +
        'check and the open could not be refused — declining to build a writer whose containment ' +
        'would be weaker than its contract (fail-closed).',
    );
  }
  const absRoot = resolve(root);
  let isDir = false;
  try {
    isDir = statSync(absRoot).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new FsSinkConfigError(
      `FsSink: the configured output root '${absRoot}' does not exist or is not a directory — ` +
        'refusing (fail-closed; the deployer chooses where output goes, this never creates it).',
    );
  }
  const resolved: Required<FsSinkQuotaConfig> = {
    maxBytesPerFile: quota?.maxBytesPerFile ?? DEFAULT_MAX_SINK_BYTES_PER_FILE,
    maxTotalBytes: quota?.maxTotalBytes ?? DEFAULT_MAX_SINK_TOTAL_BYTES,
    maxFiles: quota?.maxFiles ?? DEFAULT_MAX_SINK_FILES,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new FsSinkConfigError(
        `FsSink: the configured bound '${name}' must be a positive integer, got ${String(value)} ` +
          '(fail-closed — a zero or negative bound is a misconfiguration, not "unlimited").',
      );
    }
  }
  // Resolve the root's symlinks ONCE here, so every per-write assert compares against a stable value
  // rather than re-resolving (and re-racing) it on each call. The root itself being a symlink is
  // legitimate — it is the DEPLOYER's own path — so this resolves it rather than refusing it.
  const realRoot = realpathSync(absRoot);
  return (): FsSink => makeFsSink(absRoot, realRoot, resolved);
}

/**
 * The parent-directory re-assert, exported for the fail-the-fix unit test that pins it. It asserts the
 * EXACT logic the impl runs; see the docblock on `assertRealDirUnderRoot` for why it needs a direct pin
 * rather than an end-to-end one.
 */
export { assertRealDirUnderRoot as __assertRealDirUnderRootForTest };
