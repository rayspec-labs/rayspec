/**
 * @rayspec/handler-sdk — the neutral `FsSource` capability contract.
 *
 * An `FsSource` is a READ-ONLY, path-jailed local-file reader a handler may receive by INJECTION
 * (alongside the name-keyed `HandlerDb` and the tenant-bound `BlobStore`): it lets a trusted-author
 * handler LIST, READ, and SEARCH files that the DEPLOYER placed under a single configured root — e.g.
 * reference material, templates, or a static content directory shipped with the deployment. It is the
 * open-core CONTRACT only — the impl (an fs backend today) is injected at the composition root, never
 * constructed by a handler.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, BY CONSTRUCTION — there is NO write / delete / move / create surface here.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every method reads. A handler cannot mutate the source tree through this handle — the interface
 * exposes no mutating method at all, so read-only is a STRUCTURAL guarantee, not a runtime check. A
 * handler that needs writable per-tenant storage uses the `BlobStore` capability instead.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PATH JAIL IS THE ENTIRE CONTAINMENT — every path stays STRICTLY under the configured root.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A caller-supplied path is always RELATIVE to the source root and is JAILED fail-closed: a `..`
 * traversal, an absolute / leading-slash path, a null byte, a URL-significant char (`%2e%2e` →
 * `..`), and a SYMLINK whose real target escapes the root are all REFUSED — never a read of foreign
 * bytes. The impl (`makeFsSourceFactory`) owns those guarantees; this interface only fixes the SHAPE.
 * See the fs impl for the layered jail (lexical belt + a `realpath` segment-boundary assert).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NOT TENANT-PARTITIONED — a SHARED, deployment-static read root (v1 is one-deployment-one-tenant).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Unlike `BlobStore` (per-tenant WRITABLE storage, tenant-prefixed by construction because blobs ARE
 * tenant DATA), an `FsSource` reads DEPLOYMENT-static assets the deployer put on the box — the same
 * files for the whole deployment. In the v1 posture (exactly one tenant per deployment) there is no
 * per-tenant partition to make; per-tenant read roots are a later, hardening-adjacent concern (the same
 * class as the per-tenant sandbox). The factory therefore takes NO tenant argument.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SERIALIZABLE REQUEST SHAPE, NOT A CLOSURE (preserve the external-exposure isolate seam).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every method takes plain, serializable arguments (a string path, a small opts record) and returns
 * plain data — never a captured closure over server internals. So the handle is a typed REQUEST surface
 * the in-process call can later become a cross-isolate call against the isolate seam, with no handler
 * change (mirrors `BlobStore` / `HandlerDb`).
 *
 * TRUSTED-AUTHOR, NOT SANDBOXED (binding posture; see the SDK header). A handler runs IN OUR PROCESS
 * and could reach `fs` directly via Node globals; the path jail is the DB-capability-equivalent seam
 * for local files (the sanctioned, contained path), but real confinement is the external-exposure isolate.
 */

/**
 * The result of a `read` for a path that does not exist (or is not a regular file): a TYPED value, NOT
 * a thrown error — so a caller BRANCHES on it (`if ('notFound' in r) …`) instead of wrapping every read
 * in try/catch. A genuine I/O fault (a permission error) DOES throw; a JAIL breach throws
 * (`FsSourceJailError`, fail-closed) — only "no such file" is this typed value. The discriminant is a
 * literal `true` so a `notFound in result` / equality check is unambiguous and the type narrows cleanly.
 */
export interface FsSourceNotFound {
  readonly notFound: true;
  /** The (root-relative) path that was not found — DATA, for logging/branching. */
  readonly path: string;
}

/** One entry a `list` returns — a regular file or a directory directly under the listed dir. */
export interface FsSourceEntry {
  /** The entry's name (its final path segment), e.g. `readme.md`. */
  readonly name: string;
  /**
   * The entry's path RELATIVE to the source root, POSIX-style (forward slashes), e.g.
   * `docs/readme.md`. This is the value a caller passes back to `read` — it is OPAQUE to the platform
   * and always root-relative (never absolute, never a `..`).
   */
  readonly path: string;
  /** Whether the entry is a regular `file` or a `directory`. (Symlinks are NOT enumerated — see `list`.) */
  readonly type: 'file' | 'directory';
  /** The file's byte length (`0` for a directory). */
  readonly size: number;
}

/** Options for `read` — a fail-closed upper bound on the bytes buffered into memory. */
export interface FsSourceReadOptions {
  /**
   * The maximum number of bytes to buffer for this read. A file LARGER than this is refused
   * fail-closed (a thrown `FsSourceError`, NOT a silent truncation — a truncated read would be a subtle
   * correctness bug). Absent ⇒ the impl's default cap. (A read is buffered, not streamed, so the cap
   * bounds the memory a single read can consume.)
   */
  readonly maxBytes?: number;
}

/** A successful `read`: the file's bytes + its length. */
export interface FsSourceReadResult {
  /** The file's raw bytes. The handler decodes text itself (e.g. `new TextDecoder().decode(bytes)`). */
  readonly bytes: Uint8Array;
  /** The file's total byte length (=== `bytes.length`). */
  readonly contentLength: number;
}

/** Options for `search` — scope + case-sensitivity + a result cap. */
export interface FsSourceSearchOptions {
  /**
   * An OPTIONAL root-relative subdirectory to scope the search to (jailed like every other path).
   * Absent ⇒ the whole source root. A path that escapes the root is refused fail-closed.
   */
  readonly dir?: string;
  /** Match case-sensitively (default `true`). `false` lower-cases both the query and each line. */
  readonly caseSensitive?: boolean;
  /**
   * The maximum number of matches to return (the walk STOPS once it is reached — a bounded read).
   * Absent ⇒ the impl's default cap.
   */
  readonly maxResults?: number;
}

/** One `search` hit: the file + the 1-based line number + the matching line's text. */
export interface FsSourceMatch {
  /** The matching file's path RELATIVE to the source root (POSIX-style) — pass it to `read`. */
  readonly path: string;
  /** The 1-based line number of the match within that file. */
  readonly line: number;
  /** The full text of the matching line (its trailing newline stripped). */
  readonly text: string;
}

/**
 * A READ-ONLY, path-jailed reader over a deployment-configured local root. The handle a handler
 * receives is ALREADY bound to that root; a caller supplies only root-relative paths (opaque strings),
 * and the impl JAILS every one so a resolved path is ALWAYS strictly under the root — fail-closed on any
 * `..` / absolute / null-byte / URL-significant / symlink-escape ambiguity.
 *
 * There is NO write/delete/move/create method — read-only is structural.
 */
export interface FsSource {
  /**
   * LIST the entries directly under `dir` (ONE level, non-recursive), root-relative. `dir` omitted /
   * `''` / `'.'` ⇒ the source root itself. Returns only REGULAR FILES and DIRECTORIES, name-sorted;
   * a SYMLINK is NOT enumerated (enumeration never traverses a symlink — the conservative posture; an
   * explicit `read` of a symlink is jailed by its real target instead). A `dir` that does not exist is
   * the typed `FsSourceNotFound`; a `dir` that escapes the root throws `FsSourceJailError` (fail-closed).
   */
  list(dir?: string): Promise<FsSourceEntry[] | FsSourceNotFound>;

  /**
   * READ the whole file at `path` (root-relative), buffered under a byte cap (see
   * `FsSourceReadOptions.maxBytes`). NOT-FOUND (absent path, or the path is a directory / not a regular
   * file) is the typed `FsSourceNotFound` VALUE (NOT a throw), so a caller branches; a JAIL breach
   * throws `FsSourceJailError` (fail-closed — never foreign bytes), and a file over the cap throws
   * `FsSourceError`. On success: the bytes + `contentLength`.
   */
  read(path: string, opts?: FsSourceReadOptions): Promise<FsSourceReadResult | FsSourceNotFound>;

  /**
   * SEARCH file CONTENTS for the LITERAL substring `query` (never a regex — no ReDoS surface),
   * walking recursively under the root (or `opts.dir`). Returns `{ path, line, text }` matches, bounded
   * by `opts.maxResults`; the walk skips symlinks, over-large files, and binary (NUL-containing) files.
   * An empty `query` returns `[]`. A `dir` that escapes the root throws `FsSourceJailError` (fail-closed).
   */
  search(query: string, opts?: FsSourceSearchOptions): Promise<FsSourceMatch[]>;
}

/**
 * The composition-root injection shape (mirrors how a `BlobStore`/agent backend is injected): a factory
 * that mints an `FsSource` bound to the deployer-configured root. The deployer injects an
 * `FsSourceFactory` at the composition root; the engine calls `factory()` per run/request to build the
 * handle it injects as `HandlerInit.fsSource`. A handler NEVER calls this — it only ever receives the
 * already-bound handle.
 *
 * NO tenant argument (unlike `BlobStoreFactory`): the source is a SHARED, deployment-static read root,
 * not per-tenant data (v1 is one-deployment-one-tenant — see the header).
 */
export type FsSourceFactory = () => FsSource;
