/**
 * @rayspec/handler-sdk — the neutral `FsSink` capability contract.
 *
 * An `FsSink` is a WRITE-ONLY, path-jailed, byte-bounded local-file writer a handler may receive by
 * INJECTION (alongside the name-keyed `HandlerDb`, the tenant-bound `BlobStore` and the READ-ONLY
 * `FsSource`): it lets a trusted-author handler produce files that the DEPLOYER asked for, under a
 * single configured OUTPUT root. It is the open-core CONTRACT only — the impl (an fs backend today) is
 * injected at the composition root, never constructed by a handler.
 *
 * It is the WRITE twin of `FsSource`, and deliberately NOT its mirror image: the read side is wider on
 * purpose (it lists, searches, and will follow an in-root symlink), the write side is as narrow as the
 * job allows.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — extending authority by exactly one capability.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The runtime's founding invariant is that MODEL OUTPUT IS NOT AUTHORITY: a seat never acts, it emits
 * a typed intent that trusted code validates and applies through one chokepoint. A seat could always
 * SAY a file should exist; nothing could create it. This capability is the one place that changes, and
 * it changes it in the narrowest shape that does the job:
 *
 *   the seat PROPOSES a root-relative path and some bytes; TRUSTED CODE decides where that lands,
 *   whether it is allowed at all, and whether the budget still permits it.
 *
 * The seat can never name the root, never reach outside it, never exceed the declared bounds, and
 * never bypass the dispatch chokepoint that validates, opaque-wraps and journals the call.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHOLE-FILE WRITE ONLY — there is NO append / delete / move / create-dir surface here.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `write(path, bytes)` REPLACES the file's contents entirely. That is not a simplification, it is
 * forced: a workforce turn RE-EXECUTES on recovery, and the composition refuses outright to offer a
 * seat any declared tool whose `idempotent` flag is `false` (a turn "would re-fire its side effect.
 * Fail-closed."). A whole-file write with the same arguments leaves the same end state, so it is
 * honestly `idempotent: true`; an APPEND is not, and would be refused at the turn rather than quietly
 * doubling a file on every recovery. The narrow surface is what makes the capability usable at all.
 *
 * There is likewise no delete and no move: removing files is a strictly larger authority than adding
 * them (it destroys a record rather than creating one), and nothing this capability is for needs it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PATH JAIL IS THE ENTIRE CONTAINMENT — every path stays STRICTLY under the configured root.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A caller-supplied path is always RELATIVE to the output root and is JAILED fail-closed: a `..`
 * traversal, an absolute / leading-slash path, a null byte, a URL-significant char (`%2e%2e` → `..`),
 * a SYMLINK leaf, and — the one that is easy to miss — a path that is INSIDE after normalization but
 * whose PARENT DIRECTORY is a symlink out of the root, are all REFUSED. The jail RESOLVES AND VERIFIES
 * (a `realpath` segment-boundary assert); it does not merely reject suspicious-looking strings. The
 * impl (`makeFsSinkFactory`) owns those guarantees; this interface only fixes the SHAPE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * BOUNDED — a model can emit gigabytes; three declared limits say how much of that reaches disk.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Per-file bytes, total bytes, and file count are all capped by the DEPLOYER's configuration. Exceeding
 * any of them is a TYPED REFUSAL, thrown fail-closed BEFORE the file is opened — so a refused write
 * leaves nothing behind, not even a truncated file. Accounting is PER DISTINCT PATH (re-writing the
 * same path replaces its contribution rather than adding to it), which is what keeps a recovered,
 * re-executed turn from exhausting a budget it already paid.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NOT TENANT-PARTITIONED — a SHARED, deployment-static output root (v1 is one-deployment-one-tenant).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Exactly like `FsSource`, and for the same reason: the root is something the DEPLOYER put on the box,
 * not per-tenant data. In the v1 posture (one tenant per deployment) there is no partition to make;
 * per-tenant output roots are a later, hardening-adjacent concern (the same class as the per-tenant
 * sandbox). The factory therefore takes NO tenant argument. A handler that needs per-tenant WRITABLE
 * storage uses the `BlobStore` capability, which IS tenant-prefixed by construction.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SERIALIZABLE REQUEST SHAPE, NOT A CLOSURE (preserve the external-exposure isolate seam).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every method takes plain, serializable arguments (a string path, a byte array) and returns plain
 * data — never a captured closure over server internals. So the handle is a typed REQUEST surface the
 * in-process call can later become a cross-isolate call against the isolate seam, with no handler
 * change (mirrors `BlobStore` / `FsSource` / `HandlerDb`).
 *
 * TRUSTED-AUTHOR, NOT SANDBOXED (binding posture; see the SDK header, and stated here because a WRITE
 * capability invites the stronger reading). A handler runs IN OUR PROCESS and could reach `fs` directly
 * via Node globals; this jail is the DB-capability-equivalent seam for local files (the sanctioned,
 * contained path), and real confinement is the external-exposure isolate. What this capability
 * guarantees is that a MODEL-SUPPLIED path and MODEL-SUPPLIED bytes cannot escape the root or exceed
 * the budget — which is precisely the untrusted input it exists to contain. It does not, and does not
 * claim to, constrain the trusted author of the handler itself.
 */

/** The bounds a sink enforces, and how much of each has been consumed. Plain data — safe to log. */
export interface FsSinkQuota {
  /** The maximum bytes ONE `write` may carry. A larger write is refused before the file is opened. */
  readonly maxBytesPerFile: number;
  /** The maximum TOTAL bytes this sink will hold across every distinct path it has written. */
  readonly maxTotalBytes: number;
  /** The maximum number of DISTINCT paths this sink will create. */
  readonly maxFiles: number;
  /**
   * Bytes currently accounted for: the SUM of the current size of every distinct path written through
   * this sink. Re-writing a path REPLACES its contribution (it does not add), so a re-executed turn
   * re-writing the same file with the same bytes leaves this unchanged.
   */
  readonly bytesWritten: number;
  /** How many DISTINCT paths have been written through this sink. */
  readonly filesWritten: number;
}

/** A successful `write`: where it landed, how much it carried, and whether it was new. */
export interface FsSinkWriteResult {
  /**
   * The path RELATIVE to the output root, POSIX-style (forward slashes), e.g. `reports/summary.md`.
   * This is the path the write ACTUALLY landed on after jailing — it is what an auditor reads, and it
   * is journaled verbatim as part of the tool step's output. Always root-relative; never absolute,
   * never a `..`.
   */
  readonly path: string;
  /** The number of bytes written (=== the input's `byteLength`). */
  readonly bytesWritten: number;
  /** `true` when this path did not exist before this write; `false` when it replaced existing content. */
  readonly created: boolean;
}

/**
 * A WRITE-ONLY, path-jailed, byte-bounded writer over a deployment-configured output root. The handle a
 * handler receives is ALREADY bound to that root; a caller supplies only root-relative paths (opaque
 * strings), and the impl JAILS every one so a resolved path is ALWAYS strictly under the root —
 * fail-closed on any `..` / absolute / null-byte / URL-significant / symlink-leaf / symlinked-parent
 * ambiguity.
 *
 * There is NO read/list/search method (use `FsSource`), and NO delete/move/append method at all.
 */
export interface FsSink {
  /**
   * WRITE `bytes` to `path` (root-relative), REPLACING any existing content at that path. Missing
   * parent directories are created under the root.
   *
   * Refuses fail-closed, by THROWING a named error, in every one of these cases — always BEFORE the
   * file is opened, so a refusal never leaves a partial or truncated file behind:
   *  - the path could escape the root (`FsSinkJailError`) — `..`, absolute, null byte, a
   *    URL-significant char, a symlink leaf, or a parent directory that is a symlink out of the root;
   *  - the write exceeds `maxBytesPerFile`, `maxTotalBytes`, or `maxFiles` (`FsSinkQuotaError`).
   *
   * The error's `name` is the machine-readable code and its message names both what was refused and
   * what the legitimate move is — the convention every refusal in this runtime follows, and the reason
   * a seat can READ a refusal rather than merely failing on it.
   */
  write(path: string, bytes: Uint8Array): Promise<FsSinkWriteResult>;

  /**
   * The sink's declared bounds and current consumption — a plain snapshot, so a handler can tell a seat
   * how much room is left INSTEAD of discovering the limit by hitting it. Never throws.
   */
  quota(): FsSinkQuota;
}

/**
 * The composition-root injection shape (mirrors `FsSourceFactory` exactly): a factory that mints an
 * `FsSink` bound to the deployer-configured output root and its declared bounds. The deployer injects
 * an `FsSinkFactory` at the composition root; the engine calls `factory()` per run to build the handle
 * it injects as `HandlerInit.fsSink`. A handler NEVER calls this — it only ever receives the
 * already-bound handle.
 *
 * NO tenant argument (unlike `BlobStoreFactory`): the output root is a SHARED, deployment-static
 * directory, not per-tenant data (v1 is one-deployment-one-tenant — see the header).
 *
 * ONE SINK PER RUN, and that is the unit the bounds are scoped to: the engine calls `factory()` when it
 * builds a run's tools, so a run's budget is its own and cannot be spent by another run.
 */
export type FsSinkFactory = () => FsSink;
