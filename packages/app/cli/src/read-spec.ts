/**
 * Fail-closed spec-file reading shared by `doctor` and `plan`.
 *
 * The CLI takes ONE filesystem path argument and reads a `rayspec.yaml`. Reading attacker- or
 * mistake-supplied paths is the only filesystem surface either command touches, so it is hardened
 * up front (defence-in-depth — these CLIs are internal/local, but the floor is fail-closed):
 *
 *  - require EXACTLY one path arg (a missing/extra arg is a clean error, not a crash);
 *  - resolve against the CWD and reject a path that ESCAPES the CWD via `..` (no reading arbitrary
 *    files outside the project the operator is in — a structural jail, not a string blocklist);
 *  - the path must exist AND be a regular file (a directory / device / symlink-to-dir is rejected);
 *  - cap the read at `MAX_SPEC_BYTES` (a spec is small YAML — a multi-MiB file is a mistake/DoS, not
 *    a spec; we never slurp an unbounded file into memory).
 *
 * Every failure is a `ReadSpecError` carrying a stable `kind` + a human message — the caller turns it
 * into the command's JSON error envelope + exit 1. NO secrets ever appear in these messages (only the
 * operator-supplied path, which the operator already knows).
 */
import { realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

/** A spec file larger than this is rejected (a spec is small YAML; the cap bounds the read). */
export const MAX_SPEC_BYTES = 1024 * 1024; // 1 MiB

/** The closed set of fail-closed reasons reading the spec path can fail. */
export type ReadSpecErrorKind =
  | 'missing_arg'
  | 'too_many_args'
  | 'path_escape'
  | 'not_found'
  | 'not_a_file'
  | 'too_large'
  | 'read_failed';

/** A fail-closed spec-read failure (closed kind + a path-only, secret-free message). */
export class ReadSpecError extends Error {
  constructor(
    readonly kind: ReadSpecErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ReadSpecError';
  }
}

/**
 * Resolve EXACTLY one spec path from the positional args, fail-closed. Returns the resolved absolute
 * path. THROWS `ReadSpecError` on a missing/extra arg or a `..`-escape past the CWD.
 *
 * The escape check is structural: we resolve the arg against the CWD and require the result to stay
 * inside the CWD (a `relative(cwd, resolved)` that starts with `..` or is itself absolute escaped).
 */
export function resolveSpecPath(positionals: readonly string[]): string {
  if (positionals.length === 0) {
    throw new ReadSpecError('missing_arg', 'expected exactly one spec path argument (got none)');
  }
  if (positionals.length > 1) {
    throw new ReadSpecError(
      'too_many_args',
      `expected exactly one spec path argument (got ${positionals.length}: ${positionals
        .map((p) => JSON.stringify(p))
        .join(', ')})`,
    );
  }
  const arg = positionals[0] as string;
  const cwd = process.cwd();
  const resolved = resolve(cwd, arg);
  const rel = relative(cwd, resolved);
  // A path that climbs above the CWD (`..`-prefixed) or resolves to an unrelated absolute root is an
  // escape — reject it. (`rel === ''` means the arg IS the cwd, caught later as not_a_file.)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ReadSpecError(
      'path_escape',
      `spec path ${JSON.stringify(arg)} escapes the working directory — run rayspec from the directory ` +
        `that contains the spec, or move the spec inside the current working directory (${cwd})`,
    );
  }
  return resolved;
}

/**
 * Read the spec file fail-closed: it must exist, be a REGULAR file (after symlink resolution — a
 * symlink to a directory/device is rejected), and be within the size cap. Returns the UTF-8 text.
 * THROWS `ReadSpecError` on any failure.
 *
 * The size cap is enforced by reading at most `MAX_SPEC_BYTES + 1` bytes and rejecting if the file is
 * longer (we never buffer an unbounded file), AND cross-checked against the stat size up front.
 */
export async function readSpecFile(absPath: string): Promise<string> {
  // Resolve symlinks then stat the real target: a symlink to a directory must be rejected as
  // not_a_file, and stating the real path avoids a symlink-to-elsewhere surprise.
  let realPath: string;
  try {
    realPath = realpathSync(absPath);
  } catch {
    throw new ReadSpecError('not_found', `spec file not found: ${absPath}`);
  }
  // RE-APPLY the CWD jail to the symlink-RESOLVED target: the lexical pre-check in resolveSpecPath
  // jails the path the operator typed, but a symlink INSIDE the CWD can still point at a real file
  // OUTSIDE it. Re-jailing `realPath` closes that escape (a structural jail on the real target, not
  // just on the typed string). A `..`-climb or an unrelated-absolute-root is an escape. (`relReal === ''`
  // — the real target IS the cwd itself — is NOT an escape; it is a directory, left to the not_a_file
  // check below, preserving resolveSpecPath's documented "cwd ⇒ caught later as not_a_file" contract.)
  // HARDLINK limitation: this jail is PATH-based — it resolves symlinks but CANNOT defend against
  // a HARDLINK inside the CWD to an outside inode (a hardlink has no path to resolve; `realpathSync`
  // returns the in-CWD path). The real isolation boundary for untrusted filesystem content is the
  // per-tenant / filesystem sandbox, not this lexical jail; these CLIs are internal/local
  // — so the path jail is the defence-in-depth floor, not the guarantee.
  const relReal = relative(process.cwd(), realPath);
  if (relReal.startsWith('..') || isAbsolute(relReal)) {
    throw new ReadSpecError(
      'path_escape',
      `spec file ${absPath} resolves to a target outside the working directory — run rayspec from the ` +
        `directory that contains the spec, or move the spec inside the current working directory (${process.cwd()})`,
    );
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(realPath);
  } catch {
    throw new ReadSpecError('not_found', `spec file not found: ${absPath}`);
  }
  if (!st.isFile()) {
    throw new ReadSpecError('not_a_file', `spec path is not a regular file: ${absPath}`);
  }
  if (st.size > MAX_SPEC_BYTES) {
    throw new ReadSpecError(
      'too_large',
      `spec file is ${st.size} bytes — exceeds the ${MAX_SPEC_BYTES}-byte cap`,
    );
  }

  // Bounded read: pull at most MAX_SPEC_BYTES + 1 bytes; if we got more than the cap, the file grew
  // between stat and read (TOCTOU) — reject rather than trust the stale stat.
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(realPath, 'r');
    const buf = Buffer.alloc(MAX_SPEC_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_SPEC_BYTES) {
      throw new ReadSpecError(
        'too_large',
        `spec file exceeds the ${MAX_SPEC_BYTES}-byte cap (grew during read)`,
      );
    }
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch (e) {
    if (e instanceof ReadSpecError) throw e;
    throw new ReadSpecError('read_failed', `failed to read spec file: ${absPath}`);
  } finally {
    await handle?.close();
  }
}
