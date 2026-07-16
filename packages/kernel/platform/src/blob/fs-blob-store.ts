/**
 * The fs-backed `BlobStore` impl — the deployer-injected blob backend.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SECURITY — the tenant prefix + the path jail ARE the ENTIRE tenant isolation for blobs.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A `BlobStore` does NOT traverse the `TenantDb` chokepoint (it is bytes on disk — no SQL, no tenant
 * predicate). So this impl is the ONLY line of defense for blob tenant isolation, and it enforces it
 * STRUCTURALLY, in two independent layers (defense-in-depth; these are the security-critical
 * guarantees):
 *
 *   1. TENANT-BOUND BY CONSTRUCTION. `makeFsBlobStore` is given a `tenantId` and closes over a
 *      per-tenant root `<root>/<tenantId>/`. A handler receives the already-bound handle and supplies
 *      ONLY a `callerKey` — there is NO API to pass/override a tenant. The `tenantId` is VALIDATED to
 *      be a UUID (the same shape rule `TenantDb` uses), so the prefix segment itself carries no
 *      path-significant character and a sibling-prefix substring escape (tenant `a` vs `ab/…`) is
 *      impossible by construction (UUIDs are fixed-format, none is a prefix of another's path segment).
 *
 *   2. THE PATH JAIL. Every `callerKey` is rejected fail-closed if it could escape its tenant root:
 *      empty, a null byte, a URL-significant char (`% # ?` — `%2e%2e` URL-decodes to `..`), a leading
 *      `/` / absolute path, OR a `..` traversal segment. THEN the resolved on-disk path is realpath'd
 *      and asserted to be STRICTLY under the realpath of the tenant root (`realTarget.startsWith(
 *      realTenantRoot + sep)`) — the segment-boundary assert that catches any symlink / normalization
 *      escape the lexical checks missed. Both must pass or the operation throws (`BlobJailError`).
 *
 * The on-disk key is `<root>/<tenantId>/<callerKey>` — ONE self-describing file per blob (NO sidecar):
 *   [ 4 bytes: manifest length, big-endian uint32 ][ manifest JSON (utf8) ][ raw bytes ]
 * The manifest (content type + a content hash + the byte length) is committed TOGETHER with the bytes
 * by a SINGLE atomic `rename` — so a reader never sees bytes without a manifest, a concurrent same-key
 * `put` always lands a consistent manifest+bytes pair (each renames its OWN temp, last wins), and a
 * caller key like `x.meta.json` is just another blob (no sidecar key-collision). `stat`/`get` read only
 * the small header via an FD (NOT a full-file read — media files can be large) and stream the bytes from
 * the byte offset just past the header. The content hash gives a STABLE `etagSource` for an opaque key
 * (opaque keys have no fs mtime a caller should trust — see `etagSource`).
 *
 * TRUSTED-AUTHOR, NOT SANDBOXED: a handler runs in-process and could reach `fs`
 * directly via Node globals; this impl is the DB-capability-equivalent seam for blobs, real
 * confinement is the per-tenant isolate. The tenant-prefix + jail still hold for any handler that uses
 * the injected handle (the sanctioned path), which the new `gate:extension-capability` enforces.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream as fsCreateReadStream, realpathSync } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type {
  BlobNotFound,
  BlobPutOpts,
  BlobRangeOpts,
  BlobReadResult,
  BlobStat,
  BlobStore,
  BlobStoreFactory,
} from '@rayspec/handler-sdk';

/** The same UUID shape rule `TenantDb` uses — a tenant prefix MUST be a UUID (no path-significant chars). */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** URL-significant chars that are a URL-decode / fragment jail-bypass vector (`%2e%2e` → `..`). */
const URL_SIGNIFICANT = /[%#?]/;

/** A blob-jail violation — a caller key that could escape its tenant root. Fail-closed (never an I/O op). */
export class BlobJailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobJailError';
  }
}

/** A blob-store misconfiguration (e.g. a non-UUID tenant id reached the factory). Fail-closed. */
export class BlobStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobStoreConfigError';
  }
}

/** The manifest stored in the HEADER of each blob file — records the content type + a content hash. */
interface BlobManifest {
  readonly contentType?: string;
  /** sha256 hex of the bytes — the stable `etagSource` source (changes iff the bytes change). */
  readonly sha256: string;
  /** The byte length (so `stat` does not need to re-hash; cross-checked against the file size). */
  readonly len: number;
}

/**
 * Validate + resolve a tenant-relative `callerKey` to its absolute on-disk path UNDER the tenant root,
 * fail-closed on any escape. Pure-ish (lexical checks + a realpath assert); throws `BlobJailError`.
 *
 * `tenantRoot` is `<root>/<tenantId>` (already resolved + UUID-validated by the factory). Returns the
 * absolute path of the blob file. Layered:
 *   (0) reject empty / null-byte / URL-significant (`% # ?`) keys at the SOURCE;
 *   (1) reject an absolute / leading-`/` key;
 *   (2) reject a `..` traversal segment in the RAW key (before normalize collapses it);
 *   (3) resolve under the tenant root + assert the relative result does not climb out (lexical belt);
 *   (4) realpath the tenant root + the deepest existing ancestor of the target and assert the target
 *       is STRICTLY under the real tenant root (`realTarget.startsWith(realTenantRoot + sep)`) — the
 *       segment-boundary assert that defeats a symlink / normalization escape AND any sibling-prefix
 *       confusion. (The tenant prefix being a UUID already makes a sibling-prefix substring impossible,
 *       but the realpath assert is the independent second proof.)
 */
function jailKey(tenantRoot: string, callerKey: string): string {
  if (typeof callerKey !== 'string' || callerKey.length === 0) {
    throw new BlobJailError('blob key is empty (fail-closed) — a caller key is required.');
  }
  // (0) null byte — truncates a path at the C-string boundary in some syscalls; reject outright.
  if (callerKey.includes('\0')) {
    throw new BlobJailError('blob key contains a null byte (fail-closed).');
  }
  // (0) URL-significant chars — `%2e%2e` URL-decodes to `..`; `#`/`?` start a URL fragment/query.
  if (URL_SIGNIFICANT.test(callerKey)) {
    throw new BlobJailError(
      `blob key '${callerKey}' contains a URL-significant char (% # ?) — a URL-decode/fragment ` +
        'jail-bypass vector (e.g. %2e%2e → ..). Rejected at the source (fail-closed).',
    );
  }
  // (1) absolute / leading-slash — a key is always RELATIVE to the tenant root.
  if (isAbsolute(callerKey) || callerKey.startsWith('/') || callerKey.startsWith('\\')) {
    throw new BlobJailError(
      `blob key '${callerKey}' is absolute / leading-slash — keys are relative to the tenant root ` +
        '(fail-closed).',
    );
  }
  // (2) a `..` traversal segment ANYWHERE in the raw key — checked BEFORE normalize (which would
  // collapse an inward `a/../b` and slip past a normalized check). Forbid the segment outright.
  const rawSegments = callerKey.split(/[/\\]/);
  if (rawSegments.includes('..')) {
    throw new BlobJailError(
      `blob key '${callerKey}' contains a '..' traversal segment — a key may not climb out of the ` +
        'tenant root (fail-closed).',
    );
  }
  // (3) lexical containment belt: resolve under the tenant root, confirm the relative result stays in.
  const absolute = resolve(tenantRoot, normalize(callerKey));
  const rel = relative(tenantRoot, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new BlobJailError(
      `blob key '${callerKey}' resolves OUTSIDE the tenant root — refusing (fail-closed).`,
    );
  }
  if (!absolute.startsWith(tenantRoot + sep)) {
    throw new BlobJailError(
      `blob key '${callerKey}' does not resolve to a file UNDER the tenant root — refusing ` +
        '(fail-closed).',
    );
  }
  // (4) realpath segment-boundary assert (defense-in-depth — catches a symlink/normalization escape):
  // realpath the tenant root + the deepest EXISTING ancestor of the target, and assert the target is
  // strictly under the real tenant root. Best-effort on a not-yet-existing target (the deepest
  // existing ancestor is checked; a brand-new file under a real, contained dir is fine).
  const realTenantRoot = realpathSafe(tenantRoot);
  const realTarget = realpathSafe(absolute) ?? realpathSafe(deepestExisting(absolute));
  if (
    realTenantRoot &&
    realTarget &&
    realTarget !== realTenantRoot &&
    !realTarget.startsWith(realTenantRoot + sep)
  ) {
    throw new BlobJailError(
      `blob key '${callerKey}' resolves (after following symlinks) to '${realTarget}', OUTSIDE the ` +
        `tenant root '${realTenantRoot}' — refusing (fail-closed, realpath segment-boundary).`,
    );
  }
  return absolute;
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

/** Walk up from `p` to the first ancestor that exists on disk (for the realpath assert on a new file). */
function deepestExisting(p: string): string {
  let cur = p;
  for (;;) {
    const parent = resolve(cur, '..');
    if (parent === cur) return cur; // reached the fs root
    if (realpathSafe(parent)) return parent;
    cur = parent;
  }
}

/** The fixed-width header prefix: a big-endian uint32 holding the manifest-JSON byte length. */
const HEADER_LEN_BYTES = 4;

/** Serialize a manifest into the on-disk header: `[u32be manifestLen][manifest JSON]`. */
function encodeHeader(manifest: BlobManifest): Buffer {
  const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
  const lenPrefix = Buffer.alloc(HEADER_LEN_BYTES);
  lenPrefix.writeUInt32BE(manifestJson.length, 0);
  return Buffer.concat([lenPrefix, manifestJson]);
}

/**
 * The parsed header of a blob file: the manifest + `dataStart` (the byte offset at which the raw bytes
 * begin = `HEADER_LEN_BYTES + manifestJson.length`) + the on-disk file size. `undefined` if the file is
 * absent OR malformed (a too-short/truncated header) — the caller treats that as not-found, fail-closed.
 */
interface BlobHeader {
  readonly manifest: BlobManifest;
  readonly dataStart: number;
  readonly fileSize: number;
}

/**
 * Read ONLY the header of a blob file via an FD (NOT a full-file read — a media blob can be large): open,
 * read the 4-byte length prefix → `manifestLen`, then read `manifestLen` bytes → parse the manifest JSON.
 * Returns `undefined` on any failure (absent, too-short, truncated, or unparseable) — fail-closed, the
 * caller maps that to the typed not-found.
 */
async function readHeader(absolute: string): Promise<BlobHeader | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(absolute, 'r');
    const fileSize = (await fh.stat()).size;
    if (fileSize < HEADER_LEN_BYTES) return undefined; // not even a length prefix → malformed.
    const lenBuf = Buffer.alloc(HEADER_LEN_BYTES);
    await fh.read(lenBuf, 0, HEADER_LEN_BYTES, 0);
    const manifestLen = lenBuf.readUInt32BE(0);
    const dataStart = HEADER_LEN_BYTES + manifestLen;
    if (dataStart > fileSize) return undefined; // header claims more than the file holds → truncated.
    const manifestBuf = Buffer.alloc(manifestLen);
    await fh.read(manifestBuf, 0, manifestLen, HEADER_LEN_BYTES);
    const manifest = JSON.parse(manifestBuf.toString('utf8')) as BlobManifest;
    return { manifest, dataStart, fileSize };
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

/** Collect a `Uint8Array | ReadableStream` body into one buffer (chunks are small, in-memory is fine). */
async function collectBody(body: Uint8Array | ReadableStream<Uint8Array>): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  // A Web ReadableStream — drain it via the Node interop (Readable.fromWeb), then concat.
  const nodeStream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  for await (const chunk of nodeStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Build a tenant-bound `BlobStore` over the fs root, for ONE tenant. `tenantId` MUST be a UUID (the
 * factory throws otherwise — a non-UUID tenant prefix would weaken the structural sibling-prefix
 * guarantee). The returned handle prefixes every key with `<root>/<tenantId>/` and jails it.
 */
function makeFsBlobStore(root: string, tenantId: string): BlobStore {
  if (typeof tenantId !== 'string' || !UUID_SHAPE.test(tenantId)) {
    throw new BlobStoreConfigError(
      `FsBlobStore: tenantId '${tenantId}' is not a UUID — the tenant prefix must be a UUID so it ` +
        'carries no path-significant char and no tenant is a path-prefix of another (fail-closed).',
    );
  }
  // The per-tenant root: `<root>/<tenantId>`. Resolved once; every key jails UNDER this exact dir.
  const tenantRoot = resolve(root, tenantId);

  return {
    async put(
      key: string,
      body: Uint8Array | ReadableStream<Uint8Array>,
      opts?: BlobPutOpts,
    ): Promise<void> {
      const absolute = jailKey(tenantRoot, key);
      const buf = await collectBody(body);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const manifest: BlobManifest = {
        ...(opts?.contentType ? { contentType: opts.contentType } : {}),
        sha256,
        len: buf.length,
      };
      await mkdir(resolve(absolute, '..'), { recursive: true });
      // SINGLE self-describing file, committed by ONE atomic rename: write `[header][bytes]` to a
      // UNIQUE temp then `rename(tmp, absolute)`. rename(2) REPLACES a destination symlink (it does
      // not follow it → symlink-safe) and is atomic, so:
      //   - a reader never sees bytes without a manifest (the header+bytes land together);
      //   - re-putting the same key simply overwrites (idempotent, never errors);
      //   - concurrent same-key puts each rename their OWN temp (last wins) — always a consistent pair.
      // The temp name is jailed by construction (it is `absolute` + a suffix, same dir) and UNIQUE per
      // call (`pid + Date.now() + randomUUID`) so two concurrent puts never collide on one temp path.
      const tmp = `${absolute}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
      await writeFile(tmp, Buffer.concat([encodeHeader(manifest), buf]));
      await rename(tmp, absolute);
    },

    async get(key: string): Promise<BlobReadResult | BlobNotFound> {
      const absolute = jailKey(tenantRoot, key);
      const header = await readHeader(absolute);
      if (!header) return { notFound: true, key };
      // Stream the raw bytes ONLY (from just past the header to EOF) — the header is invisible to the
      // caller. node `createReadStream` `start` is the physical byte offset.
      const nodeStream = fsCreateReadStream(absolute, { start: header.dataStart });
      const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      return {
        body: webStream,
        contentLength: header.fileSize - header.dataStart,
        ...(header.manifest.contentType ? { contentType: header.manifest.contentType } : {}),
      };
    },

    async createReadStream(
      key: string,
      opts?: BlobRangeOpts,
    ): Promise<ReadableStream<Uint8Array> | BlobNotFound> {
      const absolute = jailKey(tenantRoot, key);
      const header = await readHeader(absolute);
      if (!header) return { notFound: true, key };
      // The Range is into the LOGICAL bytes (offset 0 = the first byte AFTER the header); translate to
      // the physical file by shifting past the header. node `createReadStream` `end` is INCLUSIVE.
      // offset/length VALIDATION (negative / beyond-EOF → 416) lives in the playback arm — not here.
      const dataStart = header.dataStart;
      const streamOpts: { start?: number; end?: number } = {};
      if (opts?.offset !== undefined || opts?.length !== undefined) {
        const start = dataStart + (opts?.offset ?? 0);
        streamOpts.start = start;
        if (opts?.length !== undefined) streamOpts.end = start + opts.length - 1;
      } else {
        streamOpts.start = dataStart;
      }
      const nodeStream = fsCreateReadStream(absolute, streamOpts);
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },

    async stat(key: string): Promise<BlobStat | BlobNotFound> {
      const absolute = jailKey(tenantRoot, key);
      const header = await readHeader(absolute);
      if (!header) return { notFound: true, key };
      // Defense: the manifest's recorded len must match the physical bytes (file size minus header). A
      // mismatch means a corrupt/torn file → fail-closed not-found.
      if (header.manifest.len !== header.fileSize - header.dataStart)
        return { notFound: true, key };
      return {
        len: header.manifest.len,
        // etagSource: the content hash + length. STABLE while the bytes are unchanged, CHANGES when
        // they change (opaque keys have no trustworthy fs mtime; we derive from content). Opaque to
        // the caller — the playback primitive quotes/hashes it into an ETag, never parses it.
        etagSource: `${header.manifest.sha256}:${header.manifest.len}`,
        ...(header.manifest.contentType ? { contentType: header.manifest.contentType } : {}),
      };
    },

    async delete(key: string): Promise<void> {
      const absolute = jailKey(tenantRoot, key);
      // Idempotent: ONE file, no sidecar. rm with force never errors on an absent path.
      await rm(absolute, { force: true });
    },

    async deleteTenant(requestedTenantId: string): Promise<void> {
      // The whole-tenant erasure (M4): remove the `<root>/<tenantId>/` subtree. Same path-jail
      // safety posture as delete(key), layered (defense-in-depth) before any recursive delete:
      //
      // (1) UUID SHAPE — the requested tenant must be a UUID (the same rule the factory enforces on
      //     the bound tenant). Validated INDEPENDENTLY on the argument so a bad value can never gate a
      //     recursive `rm -rf` (a `..`/traversal/non-uuid id is rejected here, fail-closed).
      if (typeof requestedTenantId !== 'string' || !UUID_SHAPE.test(requestedTenantId)) {
        throw new BlobStoreConfigError(
          `FsBlobStore.deleteTenant: tenantId '${requestedTenantId}' is not a UUID — refusing ` +
            '(fail-closed).',
        );
      }
      // (2) BOUND-TENANT EQUALITY — this handle is bound to ONE tenant and may erase ONLY its own
      //     subtree, NEVER another tenant's. So deleteTenant is not a cross-tenant primitive (the
      //     handle could already delete its own keys one-by-one). A mismatch is fail-closed-refused.
      if (requestedTenantId !== tenantId) {
        throw new BlobStoreConfigError(
          `FsBlobStore.deleteTenant: handle is bound to tenant '${tenantId}' but was asked to erase ` +
            `'${requestedTenantId}' — refusing a cross-tenant erasure (fail-closed).`,
        );
      }
      // (3) REALPATH SEGMENT-BOUNDARY ASSERT (defense-in-depth) — the per-tenant root must resolve
      //     STRICTLY under the configured blob root before any recursive delete, so a symlinked tenant
      //     dir cannot redirect `rm -rf` outside the root. Best-effort: an absent subtree (realpath
      //     undefined) has nothing to delete, so the rm below simply no-ops (idempotent).
      const realRoot = realpathSafe(root);
      const realTenantRoot = realpathSafe(tenantRoot);
      if (
        realTenantRoot &&
        realRoot &&
        realTenantRoot !== realRoot &&
        !realTenantRoot.startsWith(realRoot + sep)
      ) {
        throw new BlobJailError(
          `FsBlobStore.deleteTenant: tenant root '${tenantRoot}' resolves (after following symlinks) ` +
            `to '${realTenantRoot}', OUTSIDE the blob root '${realRoot}' — refusing (fail-closed).`,
        );
      }
      // Idempotent recursive removal of the whole `<root>/<tenantId>/` subtree. `force:true` never
      // errors on an absent path (a tenant that never wrote a blob).
      await rm(tenantRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Build the composition-root `BlobStoreFactory` over a deployer-configured fs `root`. The engine calls
 * `factory(tenantId)` per run; this returns a handle bound to `<root>/<tenantId>/`. The `root` is the
 * deployer's blob directory (LOCAL/self-host — before external-exposure hardening; not internet-facing).
 *
 * `root` is resolved to an absolute path once. The per-tenant subdir is created lazily on first `put`.
 */
export function makeFsBlobStoreFactory(root: string): BlobStoreFactory {
  const absRoot = resolve(root);
  // Internal export for the jail unit test: the path-jail is the load-bearing security primitive.
  return (tenantId: string): BlobStore => makeFsBlobStore(absRoot, tenantId);
}

/**
 * The path-jail primitive, exported for the fail-the-fix jail unit test (it asserts the EXACT logic
 * the impl runs WITHOUT touching the filesystem for the lexical cases). `tenantRoot` is the resolved
 * `<root>/<tenantId>` dir; returns the jailed absolute path or throws `BlobJailError`.
 */
export { jailKey as __jailKeyForTest };
