/**
 * The bundle writer: a manifest and a list of prepared payload files in, one `.ray` archive out.
 *
 * The output is deterministic. Entries are sorted by name bytes and written in the strict profile
 * with fixed header values, no timestamps, no extra fields and no comments, and the manifest is
 * canonical JSON, so the same manifest and the same file bytes always give the same archive bytes,
 * wherever and whenever they are written.
 *
 * The archive is written to a temporary file next to the destination, read back through the
 * reader, and only then moved into place: renamed over the destination when overwriting is asked
 * for, and otherwise linked to it, which fails if the destination exists. A detached signature is
 * written the same way. A failure leaves neither a partial archive nor a temporary file behind.
 */
import { createHash, type KeyObject, randomBytes } from 'node:crypto';
import { constants, type promises as fsp } from 'node:fs';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  type BundleError,
  bundleError,
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonFile,
  type InventoryEntry,
  type RayManifest,
  type ReaderLimits,
  resolveReaderLimits,
  type ValidationResult,
  validateManifest,
} from '@rayspec/bundle-contract';
import { checkEntryName, checkNameSet, compareBytes } from './names.js';
import {
  CENTRAL_RECORD_SIZE,
  centralRecord,
  END_RECORD_SIZE,
  endRecord,
  LOCAL_HEADER_SIZE,
  localHeader,
} from './profile.js';
import { inspectBundle, MANIFEST_NAME } from './reader.js';
import { createSignatureFile } from './signature.js';
import { Refusal, refusal } from './source.js';

/** One prepared payload file. Exactly one of `bytes` and `file` is given. */
export interface BundleFile {
  /** The archive path: ASCII, under `payload/`. */
  path: string;
  /** The content. */
  bytes?: Uint8Array;
  /** A regular file holding the content. A symbolic link is refused, never followed. */
  file?: string;
}

/**
 * A manifest to write, of either kind. The writer computes the inventory; one given must equal it.
 * The omission distributes over the two kinds, so each keeps its own members.
 */
export type BundleManifestInput = RayManifest extends infer M
  ? M extends RayManifest
    ? Omit<M, 'inventory'> & { inventory?: InventoryEntry[] }
    : never
  : never;

export interface WriteOptions {
  /** Replace an existing archive (and signature file) at the destination. Off by default. */
  overwrite?: boolean;
  /** Sign the archive with this Ed25519 private key into `<destination>.sig`. */
  signingKey?: KeyObject;
  /** Reader limits, lowered from the defaults, that the archive must stay within. */
  limits?: Partial<ReaderLimits>;
}

export interface WrittenBundle {
  /** The absolute path of the archive. */
  path: string;
  archiveSha256: string;
  archiveSize: number;
  manifest: RayManifest;
  /** The absolute path of the detached signature file, when one was written. */
  signaturePath?: string;
}

const CHUNK_BYTES = 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

interface PreparedFile {
  path: string;
  name: Buffer;
  size: number;
  sha256: string;
  crc32: number;
  bytes?: Uint8Array;
  file?: string;
}

/** Write a bundle archive to `destination`. */
export async function writeBundle(
  destination: string,
  input: { manifest: BundleManifestInput; files: readonly BundleFile[] },
  options: WriteOptions = {},
): Promise<ValidationResult<WrittenBundle>> {
  const temporary: string[] = [];
  try {
    const limits = resolveLimits(options?.limits);
    const overwrite = options?.overwrite === true;
    const signingKey = options?.signingKey;
    if (signingKey !== undefined && !isEd25519PrivateKey(signingKey)) {
      throw refusal('RAY_USAGE', 'the signing key is not an Ed25519 private key');
    }
    if (typeof destination !== 'string' || destination === '') {
      throw refusal('RAY_USAGE', 'the destination is not a path');
    }
    const path = resolve(destination);
    const signaturePath = signingKey === undefined ? undefined : `${path}.sig`;
    await checkDestination(path, signaturePath, overwrite);

    const files = await prepareFiles(input?.files, limits);
    const inventory: InventoryEntry[] = files.map((f) => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
    }));
    const manifestBytes = manifestFor(input?.manifest, inventory);
    const validated = validateManifest(manifestBytes, { limits });
    if (!validated.ok) throw new Refusal(validated.errors[0]!);
    const manifest = validated.value;

    if (files.length + 1 > limits.entryCount) {
      throw refusal(
        'RAY_LIMIT_EXCEEDED',
        'the bundle would hold more entries than the entry limit',
        {
          reason: 'entry-count',
        },
      );
    }
    const manifestEntry = prepared(MANIFEST_NAME, manifestBytes);
    const entries = [...files, manifestEntry];
    const archiveSize = sizeOf(entries);
    const kindLimit =
      manifest.kind === 'migration' ? limits.migrationArchiveBytes : limits.archiveBytes;
    if (archiveSize > kindLimit) {
      throw refusal(
        'RAY_LIMIT_EXCEEDED',
        `the bundle would be larger than the ${manifest.kind} archive limit`,
        { reason: manifest.kind === 'migration' ? 'migration-size' : 'archive-size' },
      );
    }
    const payloadBytes = files.reduce((sum, f) => sum + f.size, 0);
    const extractedLimit =
      manifest.kind === 'migration' ? limits.migrationExtractedBytes : limits.extractedBytes;
    if (payloadBytes > extractedLimit) {
      throw refusal(
        'RAY_LIMIT_EXCEEDED',
        'the payload files add up to more than the extracted byte limit',
        { reason: 'extracted-size' },
      );
    }

    const archiveTemp = temporaryPath(path);
    temporary.push(archiveTemp);
    await writeArchive(archiveTemp, entries);

    const readBack = await inspectBundle(archiveTemp, { limits });
    if (!readBack.ok) {
      // A limit the read-back reaches (its time budget, say) is reported as that limit; any other
      // refusal means the writer produced an archive its own reader refuses.
      const first = readBack.errors[0];
      if (first?.code === 'RAY_LIMIT_EXCEEDED') throw new Refusal(first);
      throw refusal('RAY_INTERNAL', 'the written archive does not pass the reader');
    }
    const { archiveSha256 } = readBack.value;

    let signatureTemp: string | undefined;
    if (signingKey !== undefined) {
      const signature = createSignatureFile(archiveSha256, signingKey);
      if (!signature.ok) throw new Refusal(signature.errors[0]!);
      signatureTemp = temporaryPath(signaturePath!);
      temporary.push(signatureTemp);
      await writeWhole(signatureTemp, signature.value);
    }

    await place(archiveTemp, path, overwrite);
    if (signatureTemp !== undefined) {
      try {
        await place(signatureTemp, signaturePath!, overwrite);
      } catch (err) {
        // The archive was placed by this call; without its signature it is withdrawn again.
        if (!overwrite) await unlink(path).catch(() => {});
        throw err;
      }
    }
    const written: WrittenBundle = { path, archiveSha256, archiveSize, manifest };
    if (signaturePath !== undefined) written.signaturePath = signaturePath;
    return { ok: true, value: written };
  } catch (err) {
    const error: BundleError =
      err instanceof Refusal
        ? err.error
        : bundleError('RAY_INTERNAL', 'writing the bundle failed unexpectedly');
    return { ok: false, errors: [error] };
  } finally {
    for (const file of temporary) await unlink(file).catch(() => {});
  }
}

function resolveLimits(limits: Partial<ReaderLimits> | undefined): ReaderLimits {
  try {
    return resolveReaderLimits(limits);
  } catch {
    throw refusal('RAY_USAGE', 'a reader limit is outside 0 to its default');
  }
}

function isEd25519PrivateKey(key: unknown): key is KeyObject {
  return (
    typeof key === 'object' &&
    key !== null &&
    (key as KeyObject).type === 'private' &&
    (key as KeyObject).asymmetricKeyType === 'ed25519'
  );
}

async function checkDestination(
  path: string,
  signaturePath: string | undefined,
  overwrite: boolean,
): Promise<void> {
  let parent: Awaited<ReturnType<typeof lstat>>;
  try {
    parent = await lstat(dirname(path));
  } catch {
    throw refusal('RAY_USAGE', 'the directory of the destination does not exist');
  }
  if (!parent.isDirectory()) {
    throw refusal('RAY_USAGE', 'the directory of the destination is not a directory');
  }
  if (overwrite) return;
  for (const target of [path, signaturePath]) {
    if (target !== undefined && (await lstat(target).catch(() => null)) !== null) {
      throw refusal('RAY_OUTPUT_EXISTS', 'the destination already exists');
    }
  }
}

// ─── files and manifest ────────────────────────────────────────────────────────────────────────

async function prepareFiles(
  files: readonly BundleFile[] | undefined,
  limits: ReaderLimits,
): Promise<PreparedFile[]> {
  if (!Array.isArray(files)) throw refusal('RAY_USAGE', 'the files are not a list');
  const out: PreparedFile[] = [];
  for (const file of files as readonly BundleFile[]) {
    if (typeof file?.path !== 'string') throw refusal('RAY_USAGE', 'a file has no path');
    const checked = checkEntryName(Buffer.from(file.path, 'utf8'), limits.pathBytes, '');
    if (!checked.ok) {
      throw refusal('RAY_USAGE', `a file path is refused (${checked.refusal.reason})`);
    }
    const hasBytes = file.bytes instanceof Uint8Array;
    const hasFile = typeof file.file === 'string';
    if (hasBytes === hasFile) {
      throw refusal('RAY_USAGE', 'a file gives neither or both of bytes and a source file');
    }
    if (hasBytes) {
      out.push(prepared(file.path, file.bytes!));
    } else {
      const digest = await digestFile(file.file!);
      out.push({
        path: file.path,
        name: Buffer.from(file.path, 'ascii'),
        ...digest,
        file: file.file!,
      });
    }
  }
  out.sort((a, b) => compareBytes(a.path, b.path));
  const clash = checkNameSet([...out.map((f) => f.path), MANIFEST_NAME]);
  if (clash !== null) throw refusal('RAY_USAGE', `the file paths clash (${clash})`);
  return out;
}

function prepared(path: string, bytes: Uint8Array): PreparedFile {
  return {
    path,
    name: Buffer.from(path, 'ascii'),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    crc32: crc32(bytes) >>> 0,
    bytes,
  };
}

async function openSourceFile(file: string): Promise<fsp.FileHandle> {
  let handle: fsp.FileHandle;
  try {
    handle = await open(file, READ_FLAGS);
  } catch {
    throw refusal('RAY_USAGE', 'a source file cannot be opened, or is a symbolic link');
  }
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw refusal('RAY_USAGE', 'a source file is not a regular file');
  }
  return handle;
}

async function digestFile(file: string): Promise<{ size: number; sha256: string; crc32: number }> {
  const handle = await openSourceFile(file);
  try {
    const hash = createHash('sha256');
    let crc = 0;
    let size = 0;
    for await (const chunk of streamHandle(handle)) {
      hash.update(chunk);
      crc = crc32(chunk, crc);
      size += chunk.length;
    }
    return { size, sha256: hash.digest('hex'), crc32: crc >>> 0 };
  } finally {
    await handle.close();
  }
}

async function* streamHandle(handle: fsp.FileHandle): AsyncGenerator<Buffer> {
  let position = 0;
  for (;;) {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

function manifestFor(input: BundleManifestInput | undefined, inventory: InventoryEntry[]): Buffer {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw refusal('RAY_USAGE', 'the manifest is not an object');
  }
  try {
    if (
      input.inventory !== undefined &&
      canonicalJson(input.inventory) !== canonicalJson(inventory)
    ) {
      throw refusal('RAY_USAGE', 'the manifest inventory does not match the files');
    }
    return Buffer.from(canonicalJsonFile({ ...input, inventory }), 'utf8');
  } catch (err) {
    if (err instanceof CanonicalJsonError) {
      throw refusal('RAY_USAGE', 'the manifest has no canonical JSON form');
    }
    throw err;
  }
}

// ─── the archive ───────────────────────────────────────────────────────────────────────────────

function sizeOf(entries: readonly PreparedFile[]): number {
  let size = END_RECORD_SIZE;
  for (const e of entries)
    size += LOCAL_HEADER_SIZE + CENTRAL_RECORD_SIZE + 2 * e.name.length + e.size;
  return size;
}

async function writeArchive(path: string, entries: readonly PreparedFile[]): Promise<void> {
  const out = await open(path, 'wx', 0o644);
  try {
    const directory: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
      const header = localHeader({ name: e.name, flags: 0, crc32: e.crc32, size: e.size });
      await out.write(header);
      directory.push(centralRecord({ name: e.name, crc32: e.crc32, size: e.size, offset }));
      offset += header.length;
      if (e.bytes !== undefined) {
        await out.write(e.bytes);
        offset += e.bytes.length;
      } else {
        offset += await copySourceFile(e, out);
      }
    }
    const central = Buffer.concat(directory);
    await out.write(central);
    await out.write(endRecord(entries.length, central.length, offset));
    await out.sync();
  } finally {
    await out.close();
  }
}

/** Copy a source file into the archive, refusing it if it changed since it was measured. */
async function copySourceFile(entry: PreparedFile, out: fsp.FileHandle): Promise<number> {
  const handle = await openSourceFile(entry.file!);
  try {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of streamHandle(handle)) {
      size += chunk.length;
      if (size > entry.size) break;
      hash.update(chunk);
      await out.write(chunk);
    }
    if (size !== entry.size || hash.digest('hex') !== entry.sha256) {
      throw refusal('RAY_USAGE', 'a source file changed while the bundle was written');
    }
    return size;
  } finally {
    await handle.close();
  }
}

function temporaryPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.${randomBytes(8).toString('hex')}.tmp`);
}

async function writeWhole(path: string, bytes: Uint8Array): Promise<void> {
  const out = await open(path, 'wx', 0o644);
  try {
    await out.write(bytes);
    await out.sync();
  } finally {
    await out.close();
  }
}

/** Move a finished temporary file into place, atomically, never over an existing file unless asked. */
async function place(from: string, to: string, overwrite: boolean): Promise<void> {
  if (overwrite) {
    await rename(from, to);
    return;
  }
  try {
    await link(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw refusal('RAY_OUTPUT_EXISTS', 'the destination already exists');
    }
    throw err;
  }
  await unlink(from);
}
