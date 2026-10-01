/**
 * The inner snapshot archive: the plaintext a migration bundle encrypts, rooted at `snapshot.json`
 * plus `payload/`, in the same strict container profile as a `.ray` bundle and under the migration
 * limits.
 *
 * WRITING. `writeSnapshotArchive` takes the snapshot document without its inventory and the payload
 * files, computes the inventory, validates `snapshot.json` and the object index, writes the archive
 * to a temporary file beside the destination (mode 0600: it is plaintext), reads it back through
 * `inspectSnapshotArchive` and only then links it into place. The same document and the same bytes
 * always give the same archive.
 *
 * READING. `inspectSnapshotArchive` runs the container checks with `snapshot.json` as the root
 * document, then `snapshot.json` (size, canonical form, schema, inventory order), the archive
 * against the inventory, every entry streamed (size, cumulative bytes, CRC-32, SHA-256), the
 * application digest, the object index (schema, order, the stored ranges covering `objects.bin`
 * exactly) and, for every object, the SHA-256 of its stored range and of the logical bytes behind
 * the stored blob header, which must state the same length and digest as the index. Nothing in the
 * archive is executed; hostile input is answered with a contract code, never thrown.
 */
import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  type BundleError,
  bundleError,
  CanonicalJsonError,
  canonicalJsonFile,
  type ObjectIndex,
  type ReaderLimits,
  SNAPSHOT_PATHS,
  SNAPSHOT_ROOT_NAME,
  type Snapshot,
  type SnapshotInventoryPath,
  type ValidationResult,
  validateObjectIndex,
  validateSnapshot,
} from '@rayspec/bundle-contract';
import { type ArchiveEntry, expectedLocalHeader, readDirectory } from './archive.js';
import { DEFAULT_TIME_BUDGET_MS } from './reader.js';
import {
  type ArchiveSource,
  bytesSource,
  type Clock,
  Deadline,
  monotonicClock,
  openFileSource,
  Refusal,
  refusal,
} from './source.js';
import {
  type BundleFile,
  checkDestination,
  type PreparedFile,
  place,
  prepared,
  prepareFiles,
  resolveLimits,
  sizeOf,
  temporaryPath,
  writeArchive,
} from './writer.js';

const CHUNK_BYTES = 1024 * 1024;

/** The bytes of a stored blob file before its header JSON: a big-endian length. */
const BLOB_HEADER_LENGTH_BYTES = 4;

/** `snapshot.json` as the writer takes it: the inventory is computed from the files. */
export type SnapshotDocumentInput = Omit<Snapshot, 'inventory'>;

export interface SnapshotArchiveOptions {
  /** Reader limits, lowered from the contract defaults. */
  limits?: Partial<ReaderLimits>;
  /** The wall-time budget of the read, lowered from `DEFAULT_TIME_BUDGET_MS`. */
  timeBudgetMs?: number;
  /** The clock the time budget is measured with; a monotonic clock by default. */
  clock?: Clock;
}

export interface SnapshotInspection {
  snapshot: Snapshot;
  objectIndex: ObjectIndex;
  /** Lowercase hex SHA-256 of the complete archive bytes. */
  archiveSha256: string;
  archiveSize: number;
}

export interface WrittenSnapshotArchive extends SnapshotInspection {
  /** The absolute path of the archive. */
  path: string;
}

/**
 * Write an inner snapshot archive to `destination`, which must not exist. The files are the payload
 * entries of the fixed inventory, each once; `payload/object-index.json` among them is validated
 * against `payload/objects.bin` before anything is written.
 */
export async function writeSnapshotArchive(
  destination: string,
  input: { snapshot: SnapshotDocumentInput; files: readonly BundleFile[] },
  options: SnapshotArchiveOptions = {},
): Promise<ValidationResult<WrittenSnapshotArchive>> {
  let temporary: string | undefined;
  try {
    const limits = resolveLimits(options?.limits);
    if (typeof destination !== 'string' || destination === '') {
      throw refusal('RAY_USAGE', 'the destination is not a path');
    }
    const path = resolve(destination);
    await checkDestination(path, undefined, false);
    const files = await prepareFiles(input?.files, limits, SNAPSHOT_ROOT_NAME);
    const snapshotBytes = snapshotFor(input?.snapshot, files);
    const validated = validateSnapshot(snapshotBytes, { limits });
    if (!validated.ok) throw new Refusal(validated.errors[0]!);

    const entries = [...files, prepared(SNAPSHOT_ROOT_NAME, snapshotBytes)];
    if (sizeOf(entries) > limits.migrationExtractedBytes) {
      throw refusal(
        'RAY_LIMIT_EXCEEDED',
        'the snapshot would be larger than the migration archive limit',
        { reason: 'migration-size' },
      );
    }
    temporary = temporaryPath(path);
    await writeArchive(temporary, entries, 0o600);
    const readBack = await inspectSnapshotArchive(temporary, options);
    if (!readBack.ok) {
      const first = readBack.errors[0];
      // A refusal of the content (a digest, a range, a limit) is the input's fault and is reported
      // as such; a container refusal means the writer produced an archive its reader refuses.
      if (first !== undefined && first.code !== 'RAY_INVALID_ARCHIVE') throw new Refusal(first);
      throw refusal('RAY_INTERNAL', 'the written snapshot does not pass the reader');
    }
    await place(temporary, path, false);
    temporary = undefined;
    return { ok: true, value: { ...readBack.value, path } };
  } catch (err) {
    const error: BundleError =
      err instanceof Refusal
        ? err.error
        : bundleError('RAY_INTERNAL', 'writing the snapshot failed unexpectedly');
    return { ok: false, errors: [error] };
  } finally {
    if (temporary !== undefined) await unlink(temporary).catch(() => {});
  }
}

function snapshotFor(input: SnapshotDocumentInput | undefined, files: PreparedFile[]): Buffer {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw refusal('RAY_USAGE', 'the snapshot document is not an object');
  }
  if ('inventory' in input) {
    throw refusal('RAY_USAGE', 'the snapshot inventory is computed from the files, not given');
  }
  const inventory = files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
  try {
    return Buffer.from(canonicalJsonFile({ ...input, inventory }), 'utf8');
  } catch (err) {
    if (err instanceof CanonicalJsonError) {
      throw refusal('RAY_USAGE', 'the snapshot document has no canonical JSON form');
    }
    throw err;
  }
}

/** Inspect an inner snapshot archive, given as a path or as bytes. Writes nothing. */
export async function inspectSnapshotArchive(
  archive: string | Uint8Array,
  options: SnapshotArchiveOptions = {},
): Promise<ValidationResult<SnapshotInspection>> {
  try {
    const limits = resolveLimits(options?.limits);
    const timeBudgetMs = options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
    if (
      !Number.isSafeInteger(timeBudgetMs) ||
      timeBudgetMs < 0 ||
      timeBudgetMs > DEFAULT_TIME_BUDGET_MS
    ) {
      throw refusal('RAY_USAGE', 'the time budget is outside 0 to its default');
    }
    const clock = options?.clock ?? monotonicClock;
    if (typeof clock !== 'function') throw refusal('RAY_USAGE', 'the clock is not a function');
    const deadline = new Deadline(timeBudgetMs, clock);
    let source: ArchiveSource;
    if (typeof archive === 'string') source = await openFileSource(archive, { refuseLinks: true });
    else if (archive instanceof Uint8Array) source = bytesSource(archive);
    else throw refusal('RAY_USAGE', 'the snapshot is neither a path nor bytes');
    try {
      return { ok: true, value: await readSnapshot(source, limits, deadline) };
    } finally {
      await source.close();
    }
  } catch (err) {
    const error: BundleError =
      err instanceof Refusal
        ? err.error
        : bundleError('RAY_INTERNAL', 'reading the snapshot failed unexpectedly');
    return { ok: false, errors: [error] };
  }
}

async function readSnapshot(
  source: ArchiveSource,
  limits: ReaderLimits,
  deadline: Deadline,
): Promise<SnapshotInspection> {
  if (source.size > limits.migrationExtractedBytes) {
    throw refusal('RAY_LIMIT_EXCEEDED', 'the snapshot is larger than the extracted byte limit', {
      reason: 'extracted-size',
    });
  }
  const directory = await readDirectory(source, {
    limits,
    rootDocument: SNAPSHOT_ROOT_NAME,
    deadline,
  });
  const root = directory.entries.find((e) => e.name === SNAPSHOT_ROOT_NAME)!;
  if (root.size > limits.snapshotBytes) {
    throw refusal('RAY_LIMIT_EXCEEDED', 'snapshot.json is larger than its byte limit', {
      reason: 'snapshot-size',
    });
  }
  deadline.check();
  const snapshotBytes = Buffer.from(await source.read(root.dataOffset, root.size));
  const validated = validateSnapshot(snapshotBytes, { limits });
  if (!validated.ok) throw new Refusal(validated.errors[0]!);
  const snapshot = validated.value;

  const listed = new Map(snapshot.inventory.map((entry, index) => [entry.path, { entry, index }]));
  for (const e of directory.entries) {
    if (e.name !== SNAPSHOT_ROOT_NAME && !listed.has(e.name as SnapshotInventoryPath)) {
      throw refusal(
        'RAY_INVALID_ARCHIVE',
        'the snapshot holds an entry its inventory does not list',
        {
          reason: 'undeclared-entry',
        },
      );
    }
  }
  const present = new Map(directory.entries.map((e) => [e.name, e]));
  for (const [index, entry] of snapshot.inventory.entries()) {
    if (!present.has(entry.path)) {
      throw refusal('RAY_INVALID_ARCHIVE', 'an inventory path has no entry in the snapshot', {
        reason: 'missing-entry',
        path: `/inventory/${index}/path`,
      });
    }
  }

  // Every entry in archive order: the archive digest covers it from offset 0 to the directory.
  const archiveHash = createHash('sha256');
  let extracted = 0;
  let objectIndexBytes: Buffer | undefined;
  for (const e of directory.entries) {
    deadline.check();
    const header = await source.read(e.offset, e.dataOffset - e.offset);
    if (!header.equals(expectedLocalHeader(e))) throw changedWhileRead();
    archiveHash.update(header);
    const keep: Buffer[] | null = e.name === SNAPSHOT_PATHS.objectIndex ? [] : null;
    if (e.name === SNAPSHOT_ROOT_NAME) {
      const data = await streamEntry(source, e, deadline, archiveHash, null);
      if (data.crc32 !== e.crc32) throw crcMismatch();
      if (data.sha256 !== createHash('sha256').update(snapshotBytes).digest('hex')) {
        throw changedWhileRead();
      }
      continue;
    }
    const { entry, index } = listed.get(e.name as SnapshotInventoryPath)!;
    if (e.size !== entry.size) {
      throw refusal('RAY_DIGEST_MISMATCH', 'an entry is not the size the inventory states', {
        reason: 'entry-size',
        path: `/inventory/${index}/size`,
      });
    }
    extracted += e.size;
    if (extracted > limits.migrationExtractedBytes) {
      throw refusal(
        'RAY_LIMIT_EXCEEDED',
        'the entries add up to more than the extracted byte limit',
        {
          reason: 'extracted-size',
        },
      );
    }
    const data = await streamEntry(source, e, deadline, archiveHash, keep);
    if (data.crc32 !== e.crc32) throw crcMismatch();
    if (data.sha256 !== entry.sha256) {
      throw refusal(
        'RAY_DIGEST_MISMATCH',
        'an entry does not match the digest the inventory states',
        {
          reason: 'entry-sha256',
          path: `/inventory/${index}/sha256`,
        },
      );
    }
    if (keep !== null) objectIndexBytes = Buffer.concat(keep);
  }
  for (let at = directory.directoryOffset; at < source.size; at += CHUNK_BYTES) {
    deadline.check();
    archiveHash.update(await source.read(at, Math.min(CHUNK_BYTES, source.size - at)));
  }
  if ((await source.currentSize()) !== source.size) throw changedWhileRead();

  const application = listed.get(SNAPSHOT_PATHS.application)!.entry;
  if (application.sha256 !== snapshot.applicationDigest) {
    throw refusal(
      'RAY_DIGEST_MISMATCH',
      'applicationDigest is not the SHA-256 of the embedded application bundle',
      { reason: 'application-digest', path: '/applicationDigest' },
    );
  }

  const objectsEntry = present.get(SNAPSHOT_PATHS.objects)!;
  const index = validateObjectIndex(objectIndexBytes ?? Buffer.alloc(0), {
    limits,
    objectsSize: objectsEntry.size,
  });
  if (!index.ok) throw new Refusal(index.errors[0]!);
  if (index.value.objects.length !== snapshot.objectCount) {
    throw refusal('RAY_DIGEST_MISMATCH', 'objectCount is not the number of indexed objects', {
      reason: 'object-range',
      path: '/objectCount',
    });
  }
  await checkObjects(source, objectsEntry, index.value, deadline);

  return {
    snapshot,
    objectIndex: index.value,
    archiveSha256: archiveHash.digest('hex'),
    archiveSize: source.size,
  };
}

/** Stream one entry's data into the archive digest; returns its CRC-32 and SHA-256. */
async function streamEntry(
  source: ArchiveSource,
  e: ArchiveEntry,
  deadline: Deadline,
  archiveHash: ReturnType<typeof createHash>,
  keep: Buffer[] | null,
): Promise<{ crc32: number; sha256: string }> {
  const hash = createHash('sha256');
  let crc = 0;
  for (let at = 0; at < e.size; at += CHUNK_BYTES) {
    deadline.check();
    const chunk = await source.read(e.dataOffset + at, Math.min(CHUNK_BYTES, e.size - at));
    crc = crc32(chunk, crc);
    hash.update(chunk);
    archiveHash.update(chunk);
    keep?.push(chunk);
  }
  return { crc32: crc >>> 0, sha256: hash.digest('hex') };
}

/**
 * Every object's stored range against its two digests. A stored blob is a 4-byte big-endian header
 * length, the header JSON (`sha256` and `len` of the logical bytes, an optional content type) and
 * the logical bytes; the header must state what the index states.
 */
async function checkObjects(
  source: ArchiveSource,
  objects: ArchiveEntry,
  index: ObjectIndex,
  deadline: Deadline,
): Promise<void> {
  for (const [i, object] of index.objects.entries()) {
    deadline.check();
    const start = objects.dataOffset + object.storedOffset;
    const digestRefusal = () =>
      refusal('RAY_DIGEST_MISMATCH', 'an object does not match the digests the index states', {
        reason: 'object-sha256',
        path: `/objects/${i}`,
      });
    if (object.storedSize < BLOB_HEADER_LENGTH_BYTES) throw digestRefusal();
    const headerLength = (await source.read(start, BLOB_HEADER_LENGTH_BYTES)).readUInt32BE(0);
    const dataStart = BLOB_HEADER_LENGTH_BYTES + headerLength;
    if (dataStart > object.storedSize) throw digestRefusal();
    const headerBytes = await source.read(start + BLOB_HEADER_LENGTH_BYTES, headerLength);
    let header: { sha256?: unknown; len?: unknown };
    try {
      header = JSON.parse(headerBytes.toString('utf8')) as typeof header;
    } catch {
      throw digestRefusal();
    }
    if (
      typeof header !== 'object' ||
      header === null ||
      header.sha256 !== object.sha256 ||
      header.len !== object.size ||
      object.storedSize - dataStart !== object.size
    ) {
      throw digestRefusal();
    }
    const stored = createHash('sha256');
    const logical = createHash('sha256');
    for (let at = 0; at < object.storedSize; at += CHUNK_BYTES) {
      deadline.check();
      const chunk = await source.read(start + at, Math.min(CHUNK_BYTES, object.storedSize - at));
      stored.update(chunk);
      // The logical bytes are the part of this chunk at or after the header's end.
      if (at + chunk.length > dataStart)
        logical.update(chunk.subarray(Math.max(0, dataStart - at)));
    }
    if (stored.digest('hex') !== object.storedSha256 || logical.digest('hex') !== object.sha256) {
      throw digestRefusal();
    }
  }
}

function crcMismatch() {
  return refusal('RAY_INVALID_ARCHIVE', 'an entry does not match its CRC-32', {
    reason: 'crc-mismatch',
  });
}

function changedWhileRead() {
  return refusal('RAY_INVALID_ARCHIVE', 'the snapshot changed while it was read', {
    reason: 'header-directory-mismatch',
  });
}
