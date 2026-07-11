/**
 * @rayspec/handler-sdk — the neutral `BlobStore` capability contract.
 *
 * A `BlobStore` is the OTHER tenant-bound capability a handler receives by INJECTION (alongside the
 * name-keyed `HandlerDb`): opaque-key binary object storage. It is the open-core CONTRACT only — the
 * impl (an fs backend today; an S3/object-store backend later) is injected at the composition root,
 * never constructed by a handler. Like `HandlerDb`, the handle is built per run and is TENANT-BOUND
 * BY CONSTRUCTION: the engine binds it to the run's server-derived `tenantId` and a handler can
 * neither supply nor override that tenant.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SECURITY — the tenant prefix + the path jail ARE the ENTIRE tenant isolation for blobs.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Unlike `HandlerDb`, a `BlobStore` does NOT traverse the `TenantDb` chokepoint — it is bytes on a
 * filesystem / object store, with NO SQL and NO tenant predicate. So there is no second line of
 * defense: the on-disk/object key is `${tenantId}/${callerKey}`, the `${tenantId}` prefix is built
 * INSIDE the injected handle (a handler passes only the `callerKey`), and the impl JAILS both the
 * `callerKey` and the final resolved path so a handler can never read/write another tenant's blobs.
 * The impl (e.g. `FsBlobStore`) owns those guarantees; this interface only fixes the SHAPE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SERIALIZABLE REQUEST SHAPE, NOT A CLOSURE (preserve the external-exposure isolate seam — like `HandlerInit`).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every method takes plain, serializable arguments (a string key, bytes/stream, a small opts record)
 * and returns plain data or a stream — never a captured closure over server internals. So the handle
 * is a typed REQUEST surface the in-process call can later become a cross-isolate call against the
 * isolate seam, with no handler change. (`ReadableStream` bodies/returns are the Web-standard streaming
 * shape the `stream` route primitive already exchanges; an isolate marshals them as a byte channel.)
 *
 * TRUSTED-AUTHOR, NOT SANDBOXED (binding posture; see the SDK header). A handler runs
 * IN OUR PROCESS; the tenant-prefix + jail are the DB-capability-equivalent seam for blobs, but real
 * confinement (a handler cannot reach `fs` directly via Node globals) is the external-exposure isolate.
 */

/**
 * The result of a `get`/`stat` for a key that does not exist: a TYPED value, NOT a thrown error —
 * so a caller BRANCHES on it (`if ('notFound' in r) …`) instead of wrapping every read in try/catch.
 * (A genuine I/O fault — a permission error, a corrupt store — DOES throw; only "no such key" is this
 * typed value. The discriminant is a literal `true` so a `notFound in result` / equality check is
 * unambiguous and the type narrows cleanly.)
 */
export interface BlobNotFound {
  readonly notFound: true;
  /** The (tenant-relative) caller key that was not found — DATA, for logging/branching. */
  readonly key: string;
}

/** A successful `get`: the bytes + the metadata a handler / the playback primitive needs. */
export interface BlobReadResult {
  /** The object bytes as a Web-standard `ReadableStream` (the `stream` primitive's exchange shape). */
  readonly body: ReadableStream<Uint8Array>;
  /** The total object length in bytes (Content-Length; lets playback size the response). */
  readonly contentLength: number;
  /** The stored content type, if one was recorded at `put` time (echoed on playback). */
  readonly contentType?: string;
}

/** Metadata for a key (Range / conditional-GET need `len` + a stable `etagSource`). */
export interface BlobStat {
  /** The object length in bytes. */
  readonly len: number;
  /**
   * An OPAQUE, STABLE source string for deriving an HTTP ETag for this exact object content. Opaque
   * keys have no fs mtime a caller should trust, so the impl derives a content-stable value (e.g. a
   * content hash, or `len`+a stored manifest digest) — the contract is only that it CHANGES when the
   * bytes change and is STABLE while they do not. The caller (the S3 playback primitive) hashes/quotes
   * it into an ETag; it must not be parsed for structure.
   */
  readonly etagSource: string;
  /** The stored content type, if recorded at `put` time. */
  readonly contentType?: string;
}

/** Options for `put` — the optional content type to record alongside the bytes. */
export interface BlobPutOpts {
  /** The content type to record (echoed back on `get`/`stat`); free-form, treated as DATA. */
  readonly contentType?: string;
}

/** Options for `createReadStream` — a byte range for HTTP Range (S3 playback). */
export interface BlobRangeOpts {
  /** The 0-based byte offset to start at (default 0). Negative/out-of-range is the impl's concern. */
  readonly offset?: number;
  /** The number of bytes to read from `offset` (default: to end of object). */
  readonly length?: number;
}

/**
 * The composition-root injection shape (mirrors how an agent backend is injected): a factory that
 * mints a `BlobStore` ALREADY BOUND to a given `tenantId`. The deployer injects an `FsBlobStoreFactory`
 * (or an S3 one) at the composition root; the engine calls `factory(tenantId)` per run to build the
 * handle it injects as `HandlerInit.blob`. A handler NEVER calls this — it only ever receives the
 * already-bound handle (it cannot supply or override a tenant).
 */
export type BlobStoreFactory = (tenantId: string) => BlobStore;

/**
 * A tenant-bound binary object store, addressed by an OPAQUE caller key. The handle a handler receives
 * is ALREADY bound to its run's `tenantId`; the on-disk/object key is `${tenantId}/${callerKey}` with
 * the tenant prefix built INSIDE the handle (a handler supplies only `callerKey`).
 *
 * Keys are opaque strings the handler chooses (e.g. `${uploadId}/${index}`). The impl JAILS every key
 * (rejecting `..`, leading `/`, absolute paths, percent-encoded traversal, null bytes, and
 * sibling-tenant-prefix escapes) so a resolved path is ALWAYS strictly under the caller's own tenant
 * root — fail-closed on anything ambiguous.
 */
export interface BlobStore {
  /**
   * Store `body` under `key` (tenant-prefixed by construction). IDEMPOTENT BY KEY: re-putting the
   * same key overwrites the object (or no-ops on identical content) and NEVER errors on a repeat — so
   * a retried chunk upload is safe. `body` is the bytes (a `Uint8Array`) or a Web `ReadableStream`.
   */
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: BlobPutOpts,
  ): Promise<void>;

  /**
   * Read the whole object under `key`. NOT-FOUND is the typed `BlobNotFound` VALUE (NOT a throw), so a
   * caller branches; a real I/O fault still throws. On success: the bytes + `contentLength` (+ the
   * recorded `contentType`).
   */
  get(key: string): Promise<BlobReadResult | BlobNotFound>;

  /**
   * A streaming read for HTTP Range (S3 playback): a `ReadableStream` over `[offset, offset+length)`
   * of the object (whole object if `opts` is omitted). Not-found is the typed `BlobNotFound`.
   */
  createReadStream(
    key: string,
    opts?: BlobRangeOpts,
  ): Promise<ReadableStream<Uint8Array> | BlobNotFound>;

  /** Metadata for `key` (`len` + a stable `etagSource`) — Range/conditional-GET need it. Typed not-found. */
  stat(key: string): Promise<BlobStat | BlobNotFound>;

  /** Delete the object under `key`. Idempotent: deleting an absent key is a no-op (never errors). */
  delete(key: string): Promise<void>;

  /**
   * Remove EVERY blob under a tenant's prefix (the whole `<tenantId>/…` subtree) — the blob half of a
   * tenant data-erasure (GDPR right-to-erasure). IDEMPOTENT: a tenant with no blobs (an absent
   * subtree) is a no-op, never an error; a re-run after a prior erasure removes nothing.
   *
   * SECURITY POSTURE (read this — it is NOT a cross-tenant primitive). A `BlobStore` handle is bound to
   * ONE tenant by construction. An impl MUST pin `deleteTenant` to its OWN bound tenant: passing a
   * `tenantId` that is not the handle's own tenant is fail-closed-REFUSED. So holding this handle grants
   * a (trusted-author, not-sandboxed) handler NO new reach — it could already delete its own keys
   * one-by-one via {@link delete}; this just removes the whole subtree in one call. The erasure flow
   * builds the handle bound to the TARGET tenant (`factory(tenantId)`) and calls `deleteTenant(tenantId)`
   * with the SAME id. The real isolation boundary for untrusted authors remains the external-exposure
   * per-tenant sandbox; the tenant-prefix + path jail are the structural seam (see the fs impl).
   */
  deleteTenant(tenantId: string): Promise<void>;
}
