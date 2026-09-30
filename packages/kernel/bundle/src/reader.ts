/**
 * The bundle reader: passive inspection and extraction of a `.ray` archive.
 *
 * Both entry points run the structural half of the reader pipeline, in its order, and stop at the
 * first failure: the budget of the operation, the container (end record, central records, name
 * set, layout and local headers), the manifest bytes, schema, kind limit and semantics, and then
 * every entry streamed against the inventory (size, cumulative extracted bytes, CRC-32 and
 * SHA-256). The archive's identity, the SHA-256 of its complete bytes, is computed on the same
 * pass.
 *
 * Nothing from the archive is ever imported, evaluated or executed: the reader reads bytes,
 * compares them and, for extraction, copies them into a fresh private directory. Hostile input is
 * answered with a code from the contract's closed vocabulary and never thrown; a message never
 * repeats a name or any other content taken from the archive.
 */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import {
  type BundleError,
  bundleError,
  type RayManifest,
  type ReaderLimits,
  resolveReaderLimits,
  type ValidationResult,
  validateManifest,
} from '@rayspec/bundle-contract';
import { type ArchiveEntry, expectedLocalHeader, readDirectory } from './archive.js';
import { ExtractionTarget } from './extraction.js';
import { isSecretPath, PrivateKeyScanner, type SecretFinding } from './secrets.js';
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

/** The root document of a bundle, the one entry outside `payload/`. */
export const MANIFEST_NAME = 'ray.json';

/** The wall-time budget of one read unless a caller lowers it. */
export const DEFAULT_TIME_BUDGET_MS = 300_000;

/** How many bytes of an entry are read at a time. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * The operation a read serves. It decides the archive limit of the first step, before the kind is
 * known: the larger of the two kind limits for `inspect` and `verify`, which accept both kinds; the
 * application limit for `deploy` and `prepare`; the migration limit for `import`.
 */
export type ReadOperation = 'inspect' | 'verify' | 'deploy' | 'prepare' | 'import';

export interface ReadOptions {
  /** Reader limits, lowered from the contract defaults; a raised limit is a usage error. */
  limits?: Partial<ReaderLimits>;
  /** The operation the read serves; `inspect` by default. */
  operation?: ReadOperation;
  /** The wall-time budget in milliseconds, lowered from `DEFAULT_TIME_BUDGET_MS`. */
  timeBudgetMs?: number;
  /** The clock the time budget is measured with; a monotonic clock by default. */
  clock?: Clock;
  /**
   * Keep the bytes of the spec the manifest names, once they have matched the inventory, so a
   * caller can parse the spec without extracting the archive. Application bundles only.
   */
  captureSpec?: boolean;
  /**
   * Refuse an archive path whose last component is a symbolic link instead of following it. A
   * runtime reading a path another process placed sets it.
   */
  refuseLinks?: boolean;
}

export interface BundleInspection {
  manifest: RayManifest;
  /** Lowercase hex SHA-256 of the complete archive bytes: the archive's identity. */
  archiveSha256: string;
  /** The size of the archive in bytes. */
  archiveSize: number;
  /**
   * Payload files the secret scan refuses, by path and rule. Inspection reports them without
   * failing; `verify`, `deploy` and `prepare` refuse a bundle that has any
   * (`RAY_SECRET_DETECTED`), after the spec checks. Only an application bundle is scanned; a
   * migration bundle's one file is ciphertext.
   */
  secretFindings: SecretFinding[];
  /**
   * Whether a detached signature file lies next to the archive (`<file>.sig`). `unknown` when the
   * archive was given as bytes.
   */
  signatureFile: 'present' | 'absent' | 'unknown';
  /** The number of archive entries, `ray.json` included. */
  entryCount: number;
  /**
   * The bytes of the spec file, after they matched their inventory size and SHA-256. Present only
   * when `captureSpec` was asked for and the bundle is an application bundle.
   */
  specBytes?: Buffer;
}

export interface BundleExtraction extends BundleInspection {
  /** The absolute path of the directory the archive was extracted into. */
  root: string;
}

/**
 * Inspect an archive, given as a file path or as bytes, without writing anything anywhere.
 */
export async function inspectBundle(
  archive: string | Uint8Array,
  options: ReadOptions = {},
): Promise<ValidationResult<BundleInspection>> {
  return guarded(async () => {
    const settings = resolveSettings(options);
    const deadline = new Deadline(settings.timeBudgetMs, settings.clock);
    const source = await openSource(archive, settings);
    try {
      const inspection = await readBundle(source, settings, deadline, null);
      return {
        ok: true,
        value: { ...inspection, signatureFile: await signaturePresence(archive) },
      };
    } finally {
      await source.close();
    }
  });
}

/**
 * Inspect an archive and copy its entries into `destination`, a directory that must not exist yet
 * and whose parent must. The directory is created with mode 0700 only once the manifest has passed
 * its checks; files are created exclusively (mode 0600) without following links, and nothing is
 * ever overwritten. On any failure the directory is removed, so a refused archive leaves nothing
 * behind.
 */
export async function extractBundle(
  archive: string | Uint8Array,
  destination: string,
  options: ReadOptions = {},
): Promise<ValidationResult<BundleExtraction>> {
  return guarded(async () => {
    const settings = resolveSettings(options);
    const deadline = new Deadline(settings.timeBudgetMs, settings.clock);
    const target = await ExtractionTarget.prepare(destination);
    const source = await openSource(archive, settings);
    try {
      const inspection = await readBundle(source, settings, deadline, target);
      return {
        ok: true,
        value: {
          ...inspection,
          signatureFile: await signaturePresence(archive),
          root: target.root,
        },
      };
    } catch (err) {
      await target.discard();
      throw err;
    } finally {
      await source.close();
    }
  });
}

// ─── settings ──────────────────────────────────────────────────────────────────────────────────

interface Settings {
  limits: ReaderLimits;
  operation: ReadOperation;
  timeBudgetMs: number;
  clock: Clock;
  captureSpec: boolean;
  refuseLinks: boolean;
}

const OPERATIONS: readonly ReadOperation[] = ['inspect', 'verify', 'deploy', 'prepare', 'import'];

function resolveSettings(options: ReadOptions | null | undefined): Settings {
  let limits: ReaderLimits;
  try {
    limits = resolveReaderLimits(options?.limits);
  } catch {
    throw refusal('RAY_USAGE', 'a reader limit is outside 0 to its default');
  }
  const operation = options?.operation ?? 'inspect';
  if (!OPERATIONS.includes(operation)) throw refusal('RAY_USAGE', 'the read operation is unknown');
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
  const captureSpec = options?.captureSpec ?? false;
  if (typeof captureSpec !== 'boolean') throw refusal('RAY_USAGE', 'captureSpec is not a boolean');
  const refuseLinks = options?.refuseLinks ?? false;
  if (typeof refuseLinks !== 'boolean') throw refusal('RAY_USAGE', 'refuseLinks is not a boolean');
  return { limits, operation, timeBudgetMs, clock, captureSpec, refuseLinks };
}

function operationLimit(settings: Settings): number {
  const { limits, operation } = settings;
  if (operation === 'deploy' || operation === 'prepare') return limits.archiveBytes;
  if (operation === 'import') return limits.migrationArchiveBytes;
  return Math.max(limits.archiveBytes, limits.migrationArchiveBytes);
}

async function openSource(archive: unknown, settings: Settings): Promise<ArchiveSource> {
  if (typeof archive === 'string') {
    return openFileSource(archive, { refuseLinks: settings.refuseLinks });
  }
  if (archive instanceof Uint8Array) return bytesSource(archive);
  throw refusal('RAY_USAGE', 'the archive is neither a path nor bytes');
}

async function signaturePresence(
  archive: string | Uint8Array,
): Promise<'present' | 'absent' | 'unknown'> {
  if (typeof archive !== 'string') return 'unknown';
  try {
    return (await lstat(`${archive}.sig`)).isFile() ? 'present' : 'absent';
  } catch {
    return 'absent';
  }
}

// ─── the pipeline ──────────────────────────────────────────────────────────────────────────────

async function readBundle(
  source: ArchiveSource,
  settings: Settings,
  deadline: Deadline,
  target: ExtractionTarget | null,
): Promise<Omit<BundleInspection, 'signatureFile'>> {
  const { limits } = settings;

  if (source.size > operationLimit(settings)) {
    throw refusal('RAY_LIMIT_EXCEEDED', 'the archive is larger than the archive limit', {
      reason: 'archive-size',
    });
  }
  const directory = await readDirectory(source, {
    limits,
    rootDocument: MANIFEST_NAME,
    deadline,
  });

  const root = directory.entries.find((e) => e.name === MANIFEST_NAME)!;
  if (root.size > limits.manifestBytes) {
    throw refusal('RAY_LIMIT_EXCEEDED', `${MANIFEST_NAME} is larger than the manifest byte limit`, {
      reason: 'manifest-size',
    });
  }
  deadline.check();
  const manifestBytes = Buffer.from(await source.read(root.dataOffset, root.size));
  const validated = validateManifest(manifestBytes, { limits, archiveSize: source.size });
  if (!validated.ok) throw new Refusal(validated.errors[0]!);
  const manifest = validated.value;

  await target?.create();
  const streamed = await streamEntries(source, directory.entries, manifest, manifestBytes, {
    limits,
    deadline,
    target,
    captureName: settings.captureSpec && manifest.kind === 'application' ? manifest.spec : null,
  });

  const archiveHash = streamed.archiveHash;
  const directoryHash = createHash('sha256');
  for (let at = directory.directoryOffset; at < source.size; at += CHUNK_BYTES) {
    deadline.check();
    const chunk = await source.read(at, Math.min(CHUNK_BYTES, source.size - at));
    archiveHash.update(chunk);
    directoryHash.update(chunk);
  }
  if (
    directoryHash.digest('hex') !== directory.directorySha256 ||
    (await source.currentSize()) !== source.size
  ) {
    throw changedWhileRead();
  }
  return {
    manifest,
    archiveSha256: archiveHash.digest('hex'),
    archiveSize: source.size,
    secretFindings: streamed.secretFindings,
    entryCount: directory.entries.length,
    ...(streamed.captured === null ? {} : { specBytes: streamed.captured }),
  };
}

interface StreamContext {
  limits: ReaderLimits;
  deadline: Deadline;
  target: ExtractionTarget | null;
  /** The entry whose bytes are kept for the caller, or null. */
  captureName: string | null;
}

/**
 * The archive against the inventory. Every entry other than `ray.json` must be listed and every
 * listed path must be an entry; then each entry is streamed in archive order, which covers the
 * archive from offset 0 to the central directory, feeding the archive digest on the way.
 */
async function streamEntries(
  source: ArchiveSource,
  entries: readonly ArchiveEntry[],
  manifest: RayManifest,
  manifestBytes: Buffer,
  context: StreamContext,
) {
  const listed = new Map(manifest.inventory.map((entry, index) => [entry.path, { entry, index }]));
  for (const e of entries) {
    if (e.name !== MANIFEST_NAME && !listed.has(e.name)) {
      throw refusal(
        'RAY_INVALID_ARCHIVE',
        'the archive holds an entry the inventory does not list',
        {
          reason: 'undeclared-entry',
        },
      );
    }
  }
  const present = new Set(entries.map((e) => e.name));
  for (const [index, entry] of manifest.inventory.entries()) {
    if (!present.has(entry.path)) {
      throw refusal('RAY_INVALID_ARCHIVE', 'an inventory path has no entry in the archive', {
        reason: 'missing-entry',
        path: `/inventory/${index}/path`,
      });
    }
  }

  const migration = manifest.kind === 'migration';
  const extractedLimit = migration
    ? context.limits.migrationExtractedBytes
    : context.limits.extractedBytes;
  const archiveHash = createHash('sha256');
  const secretFindings: SecretFinding[] = [];
  let captured: Buffer | null = null;
  let extracted = 0;

  for (const e of entries) {
    context.deadline.check();
    const header = await source.read(e.offset, e.dataOffset - e.offset);
    if (!header.equals(expectedLocalHeader(e))) throw changedWhileRead();
    archiveHash.update(header);

    if (e.name === MANIFEST_NAME) {
      const data = await copyEntry(source, e, context, archiveHash);
      if (data.crc32 !== e.crc32) throw crcMismatch();
      if (data.sha256 !== createHash('sha256').update(manifestBytes).digest('hex')) {
        throw changedWhileRead();
      }
      continue;
    }

    const { entry, index } = listed.get(e.name)!;
    if (e.size !== entry.size) {
      throw refusal('RAY_DIGEST_MISMATCH', 'an entry is not the size the inventory states', {
        reason: migration ? 'ciphertext-size' : 'entry-size',
        path: `/inventory/${index}/size`,
      });
    }
    extracted += e.size;
    if (extracted > extractedLimit) {
      throw refusal(
        'RAY_LIMIT_EXCEEDED',
        'the entries add up to more than the extracted byte limit',
        { reason: 'extracted-size' },
      );
    }
    const scanner = migration ? null : new PrivateKeyScanner();
    const chunks: Buffer[] | null = e.name === context.captureName ? [] : null;
    const data = await copyEntry(source, e, context, archiveHash, scanner, chunks);
    if (data.crc32 !== e.crc32) throw crcMismatch();
    if (data.sha256 !== entry.sha256) {
      throw refusal(
        'RAY_DIGEST_MISMATCH',
        'an entry does not match the digest the inventory states',
        {
          reason: migration ? 'ciphertext-sha256' : 'entry-sha256',
          path: `/inventory/${index}/sha256`,
        },
      );
    }
    if (chunks !== null) captured = Buffer.concat(chunks);
    if (!migration && isSecretPath(entry.path)) {
      secretFindings.push({ path: entry.path, rule: 'secret-path' });
    } else if (scanner?.found) {
      secretFindings.push({ path: entry.path, rule: 'private-key' });
    }
  }
  return { archiveHash, secretFindings, captured };
}

/**
 * Stream one entry's data: CRC-32, SHA-256, the archive digest, the scanner, the target and, when
 * given, a list that keeps the chunks.
 */
async function copyEntry(
  source: ArchiveSource,
  e: ArchiveEntry,
  context: StreamContext,
  archiveHash: ReturnType<typeof createHash>,
  scanner: PrivateKeyScanner | null = null,
  keep: Buffer[] | null = null,
): Promise<{ crc32: number; sha256: string }> {
  const hash = createHash('sha256');
  const file = context.target === null ? null : await context.target.openFile(e.name);
  try {
    let crc = 0;
    for (let at = 0; at < e.size; at += CHUNK_BYTES) {
      context.deadline.check();
      const chunk = await source.read(e.dataOffset + at, Math.min(CHUNK_BYTES, e.size - at));
      crc = crc32(chunk, crc);
      hash.update(chunk);
      archiveHash.update(chunk);
      scanner?.update(chunk);
      keep?.push(chunk);
      if (file !== null) await file.write(chunk);
    }
    return { crc32: crc >>> 0, sha256: hash.digest('hex') };
  } finally {
    await file?.close();
  }
}

function crcMismatch() {
  return refusal('RAY_INVALID_ARCHIVE', 'an entry does not match its CRC-32', {
    reason: 'crc-mismatch',
  });
}

function changedWhileRead() {
  return refusal('RAY_INVALID_ARCHIVE', 'the archive changed while it was read', {
    reason: 'header-directory-mismatch',
  });
}

/** Run an entry point so that nothing escapes as an exception. */
async function guarded<T>(run: () => Promise<ValidationResult<T>>): Promise<ValidationResult<T>> {
  try {
    return await run();
  } catch (err) {
    const error: BundleError =
      err instanceof Refusal
        ? err.error
        : bundleError('RAY_INTERNAL', 'reading the archive failed unexpectedly');
    return { ok: false, errors: [error] };
  }
}
