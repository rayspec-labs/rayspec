/**
 * THE WALK OF AN FS BLOB ROOT — every stored object the fs blob store holds, across tenants, for the
 * operator's snapshot. The `BlobStore` port has no list operation, and a tenant-bound handle must not
 * gain one; this walk is a separate, read-only entry point that takes the blob ROOT, which only the
 * deployment's operator holds, and never a handle.
 *
 * WHAT IT RETURNS. One entry per stored file `<root>/<tenantId>/<key>`: the tenant, the key (the path
 * under the tenant directory, `/`-separated), the absolute file, and what the file's header states —
 * the logical byte length, the SHA-256 of the logical bytes and the content type — plus the stored
 * file's own size. Entries are sorted by tenant, then key, by byte value. The bytes themselves are
 * not read here: the caller that copies a file hashes it on the way and compares it with the header.
 *
 * FAIL CLOSED. Anything the store would not have written is refused with a typed error rather than
 * skipped, because a snapshot that silently left a file out would not be complete:
 *   - the root is missing or not a directory (a mistyped root would otherwise look empty);
 *   - an entry at the top level that is not a directory named by a lowercase UUID;
 *   - a symbolic link or a special file anywhere (the walk never follows a link);
 *   - a temporary file of a write that never finished (`<key>.tmp-<pid>-<ms>-<uuid>`);
 *   - a file whose header is truncated, unparseable, or states a length other than the bytes behind
 *     it;
 *   - a key a snapshot cannot carry: longer than 1024 characters or not in Unicode NFC.
 * Errors carry the path relative to the root in `relativePath`, never in the message.
 */
import { open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** One stored object of an fs blob root. */
export interface FsStoredBlob {
  tenantId: string;
  key: string;
  /** The absolute path of the stored file. */
  file: string;
  contentType?: string;
  /** The logical byte length, as the header states it. */
  size: number;
  /** SHA-256 of the logical bytes, as the header states it. */
  sha256: string;
  /** The size of the stored file: the length prefix, the header and the logical bytes. */
  storedSize: number;
  /** Where the logical bytes start in the stored file. */
  dataStart: number;
}

export type BlobInventoryErrorKind =
  | 'root-missing'
  | 'not-a-tenant'
  | 'link'
  | 'special-file'
  | 'partial-write'
  | 'malformed'
  | 'unrepresentable-key';

/** A blob root the walk cannot account for completely. */
export class BlobInventoryError extends Error {
  readonly kind: BlobInventoryErrorKind;
  /** The offending path relative to the root, when there is one. */
  readonly relativePath: string | undefined;
  constructor(kind: BlobInventoryErrorKind, message: string, relativePath?: string) {
    super(message);
    this.name = 'BlobInventoryError';
    this.kind = kind;
    this.relativePath = relativePath;
  }
}

/** A tenant directory: a lowercase UUID, the form the platform's tenant ids take. */
const TENANT_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The suffix the store gives the temporary file of a write before renaming it into place. */
const PARTIAL_WRITE = /\.tmp-\d+-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The longest key a snapshot's object index can carry. */
export const MAX_SNAPSHOT_KEY_LENGTH = 1024;

const HEADER_LENGTH_BYTES = 4;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Compare two strings by code point, which is the order of their UTF-8 bytes. */
function byCodePoint(a: string, b: string): number {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return Buffer.compare(x, y);
}

/** Walk the blob root and list every stored object, sorted by tenant and then key. */
export async function listFsBlobs(root: string): Promise<FsStoredBlob[]> {
  const absoluteRoot = resolve(root);
  let top: Awaited<ReturnType<typeof readdir>>;
  try {
    top = await readdir(absoluteRoot, { withFileTypes: true });
  } catch {
    throw new BlobInventoryError(
      'root-missing',
      'the blob root does not exist or is not a readable directory',
    );
  }
  const out: FsStoredBlob[] = [];
  for (const entry of top) {
    if (entry.isSymbolicLink()) {
      throw new BlobInventoryError('link', 'the blob root holds a symbolic link', entry.name);
    }
    if (!entry.isDirectory() || !TENANT_DIRECTORY.test(entry.name)) {
      throw new BlobInventoryError(
        'not-a-tenant',
        'the blob root holds an entry that is not a tenant directory',
        entry.name,
      );
    }
    await walkTenant(absoluteRoot, entry.name, '', out);
  }
  return out.sort((a, b) => byCodePoint(a.tenantId, b.tenantId) || byCodePoint(a.key, b.key));
}

async function walkTenant(
  root: string,
  tenantId: string,
  prefix: string,
  out: FsStoredBlob[],
): Promise<void> {
  const directory = join(root, tenantId, prefix);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const relativePath = `${tenantId}/${key}`;
    if (entry.isSymbolicLink()) {
      throw new BlobInventoryError('link', 'the blob root holds a symbolic link', relativePath);
    }
    if (entry.isDirectory()) {
      await walkTenant(root, tenantId, key, out);
      continue;
    }
    if (!entry.isFile()) {
      throw new BlobInventoryError(
        'special-file',
        'the blob root holds a file that is neither a regular file nor a directory',
        relativePath,
      );
    }
    if (PARTIAL_WRITE.test(entry.name)) {
      throw new BlobInventoryError(
        'partial-write',
        'the blob root holds the temporary file of an upload that never finished; remove it once ' +
          'no upload is running',
        relativePath,
      );
    }
    if (key.length > MAX_SNAPSHOT_KEY_LENGTH || key.normalize('NFC') !== key) {
      throw new BlobInventoryError(
        'unrepresentable-key',
        'a blob key is longer than 1024 characters or not in Unicode NFC, so no snapshot can carry it',
        relativePath,
      );
    }
    out.push(await readStoredHeader(join(directory, entry.name), tenantId, key, relativePath));
  }
}

async function readStoredHeader(
  file: string,
  tenantId: string,
  key: string,
  relativePath: string,
): Promise<FsStoredBlob> {
  const malformed = () =>
    new BlobInventoryError(
      'malformed',
      'a stored blob file has a header that is truncated, unreadable or states another length',
      relativePath,
    );
  const handle = await open(file, 'r');
  try {
    const storedSize = (await handle.stat()).size;
    if (storedSize < HEADER_LENGTH_BYTES) throw malformed();
    const prefix = Buffer.alloc(HEADER_LENGTH_BYTES);
    await handle.read(prefix, 0, HEADER_LENGTH_BYTES, 0);
    const headerLength = prefix.readUInt32BE(0);
    const dataStart = HEADER_LENGTH_BYTES + headerLength;
    if (dataStart > storedSize) throw malformed();
    const headerBytes = Buffer.alloc(headerLength);
    await handle.read(headerBytes, 0, headerLength, HEADER_LENGTH_BYTES);
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(headerBytes.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw malformed();
    }
    const { sha256, len, contentType } = header ?? {};
    if (
      typeof sha256 !== 'string' ||
      !SHA256_HEX.test(sha256) ||
      typeof len !== 'number' ||
      !Number.isSafeInteger(len) ||
      len !== storedSize - dataStart ||
      (contentType !== undefined && typeof contentType !== 'string')
    ) {
      throw malformed();
    }
    return {
      tenantId,
      key,
      file,
      ...(typeof contentType === 'string' ? { contentType } : {}),
      size: len,
      sha256,
      storedSize,
      dataStart,
    };
  } finally {
    await handle.close();
  }
}
