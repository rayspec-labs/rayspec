/**
 * The container half of the reader: the end record, the central records, the name set, and the
 * layout with every local header, in the order the reader pipeline fixes. It knows nothing of the
 * manifest; `rootDocument` names the one entry allowed outside `payload/` (`ray.json` for a bundle,
 * `snapshot.json` for the inner snapshot archive).
 *
 * Every field is checked against the strict profile before it is used, so a hostile offset, size
 * or count can only make the reader refuse, never read outside the archive or allocate by it.
 */
import { createHash } from 'node:crypto';
import type { ErrorReason, ReaderLimits } from '@rayspec/bundle-contract';
import { checkEntryName, checkNameSet } from './names.js';
import {
  CENTRAL_RECORD_SIGNATURE,
  CENTRAL_RECORD_SIZE,
  DOS_DATE,
  DOS_TIME,
  END_RECORD_SEARCH_WINDOW,
  END_RECORD_SIGNATURE,
  END_RECORD_SIZE,
  EXTERNAL_ATTRIBUTES,
  FLAG_DATA_DESCRIPTOR,
  FLAG_ENCRYPTED,
  FLAG_UTF8_NAMES,
  INTERNAL_ATTRIBUTES,
  LOCAL_HEADER_SIZE,
  localHeader,
  METHOD_STORED,
  SENTINEL_16,
  SENTINEL_32,
  UNIX_TYPE_DIRECTORY,
  UNIX_TYPE_MASK,
  UNIX_TYPE_REGULAR,
  UNIX_TYPE_SYMLINK,
  VERSION_MADE_BY,
  VERSION_NEEDED,
  ZIP64_LOCATOR_SIGNATURE,
  ZIP64_LOCATOR_SIZE,
} from './profile.js';
import { type ArchiveSource, type Deadline, refusal, SequentialReader } from './source.js';

/** One entry that passed the container checks. */
export interface ArchiveEntry {
  name: string;
  nameBytes: Buffer;
  flags: number;
  crc32: number;
  size: number;
  /** Offset of the local header. */
  offset: number;
  /** Offset of the first data byte. */
  dataOffset: number;
}

export interface ArchiveDirectory {
  /** The entries in archive order, which is strictly increasing name order. */
  entries: ArchiveEntry[];
  directoryOffset: number;
  /** SHA-256 of the central directory and the end record, as the reader first read them. */
  directorySha256: string;
}

export interface DirectoryOptions {
  limits: ReaderLimits;
  rootDocument: string;
  deadline: Deadline;
}

/** Read and check the end record, the central records, the name set and the layout. */
export async function readDirectory(
  source: ArchiveSource,
  options: DirectoryOptions,
): Promise<ArchiveDirectory> {
  const end = await readEndRecord(source, options);
  const records = await readCentralRecords(source, end, options);
  const reason = checkNameSet(
    records.entries.map((e) => e.name),
    () => options.deadline.check(),
  );
  if (reason !== null) throw invalid(reason, NAME_SET_MESSAGES[reason] ?? 'the entry names clash');
  await checkLayout(source, records.entries, end.directoryOffset, options);
  if (!records.entries.some((e) => e.name === options.rootDocument)) {
    throw invalid('manifest-missing', `the archive has no ${options.rootDocument}`);
  }
  return {
    entries: records.entries,
    directoryOffset: end.directoryOffset,
    directorySha256: records.directorySha256,
  };
}

// ─── end record ────────────────────────────────────────────────────────────────────────────────

interface EndRecord {
  position: number;
  total: number;
  directorySize: number;
  directoryOffset: number;
  bytes: Buffer;
}

async function readEndRecord(source: ArchiveSource, options: DirectoryOptions): Promise<EndRecord> {
  if (source.size < END_RECORD_SIZE) throw invalid('not-a-zip', 'the file is not a ZIP archive');
  options.deadline.check();
  const windowStart = source.size - Math.min(source.size, END_RECORD_SEARCH_WINDOW);
  const tail = await source.read(windowStart, source.size - windowStart);
  let at = -1;
  for (let i = tail.length - END_RECORD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === END_RECORD_SIGNATURE) {
      at = i;
      break;
    }
  }
  if (at < 0) throw invalid('not-a-zip', 'the file is not a ZIP archive');
  const bytes = Buffer.from(tail.subarray(at, at + END_RECORD_SIZE));
  const position = windowStart + at;
  const disk = bytes.readUInt16LE(4);
  const directoryDisk = bytes.readUInt16LE(6);
  const onThisDisk = bytes.readUInt16LE(8);
  const total = bytes.readUInt16LE(10);
  const directorySize = bytes.readUInt32LE(12);
  const directoryOffset = bytes.readUInt32LE(16);
  const commentLength = bytes.readUInt16LE(20);

  if (commentLength > 0) throw invalid('archive-comment', 'the archive carries a comment');
  if (position + END_RECORD_SIZE !== source.size) {
    throw invalid('trailing-data', 'bytes follow the end record');
  }
  if (disk !== 0 || directoryDisk !== 0 || onThisDisk !== total) {
    throw invalid('multi-disk', 'the archive spans more than one disk');
  }
  const locator =
    position >= ZIP64_LOCATOR_SIZE &&
    (await source.read(position - ZIP64_LOCATOR_SIZE, 4)).readUInt32LE(0) ===
      ZIP64_LOCATOR_SIGNATURE;
  if (
    locator ||
    total === SENTINEL_16 ||
    directorySize === SENTINEL_32 ||
    directoryOffset === SENTINEL_32
  ) {
    throw invalid('zip64', 'the archive uses ZIP64 records');
  }
  if (total > options.limits.entryCount) {
    throw refusal('RAY_LIMIT_EXCEEDED', 'the archive holds more entries than the entry limit', {
      reason: 'entry-count',
    });
  }
  if (directoryOffset + directorySize !== position) {
    throw invalid(
      'header-directory-mismatch',
      'the central directory does not end where the end record starts',
    );
  }
  return { position, total, directorySize, directoryOffset, bytes };
}

// ─── central records ───────────────────────────────────────────────────────────────────────────

async function readCentralRecords(
  source: ArchiveSource,
  end: EndRecord,
  options: DirectoryOptions,
): Promise<{ entries: ArchiveEntry[]; directorySha256: string }> {
  const reader = new SequentialReader(source, end.directoryOffset, end.position, options.deadline);
  const hash = createHash('sha256');
  const entries: ArchiveEntry[] = [];
  for (let i = 0; i < end.total; i++) {
    if (!reader.has(CENTRAL_RECORD_SIZE)) throw directoryShort();
    const header = await reader.take(CENTRAL_RECORD_SIZE);
    hash.update(header);
    if (header.readUInt32LE(0) !== CENTRAL_RECORD_SIGNATURE) {
      throw invalid('header-directory-mismatch', 'a central record has no record signature');
    }
    const record = {
      madeBy: header.readUInt16LE(4),
      needed: header.readUInt16LE(6),
      flags: header.readUInt16LE(8),
      method: header.readUInt16LE(10),
      time: header.readUInt16LE(12),
      date: header.readUInt16LE(14),
      crc32: header.readUInt32LE(16),
      compressedSize: header.readUInt32LE(20),
      size: header.readUInt32LE(24),
      nameLength: header.readUInt16LE(28),
      extraLength: header.readUInt16LE(30),
      commentLength: header.readUInt16LE(32),
      diskStart: header.readUInt16LE(34),
      internal: header.readUInt16LE(36),
      external: header.readUInt32LE(38),
      offset: header.readUInt32LE(42),
    };
    checkRecordFields(record);
    // A name the record announces but the directory cannot hold is a malformed directory. The
    // limit check follows so the order of the pipeline holds for a name that fits.
    if (!reader.has(record.nameLength)) throw directoryShort();
    const nameBytes = Buffer.from(await reader.take(record.nameLength));
    hash.update(nameBytes);
    if (endsWithSlash(nameBytes)) {
      throw invalid('directory-entry', 'the archive holds a directory entry');
    }
    checkRecordModeAndSize(record);
    const checked = checkEntryName(nameBytes, options.limits.pathBytes, options.rootDocument);
    if (!checked.ok) {
      const { code, reason } = checked.refusal;
      throw code === 'RAY_LIMIT_EXCEEDED'
        ? refusal(code, 'an entry name is longer than the path limit', { reason })
        : invalid(reason, NAME_MESSAGES[reason] ?? 'an entry name is refused');
    }
    entries.push({
      name: checked.name,
      nameBytes,
      flags: record.flags,
      crc32: record.crc32,
      size: record.size,
      offset: record.offset,
      dataOffset: record.offset + LOCAL_HEADER_SIZE + record.nameLength,
    });
  }
  if (reader.position !== end.position) {
    throw invalid(
      'header-directory-mismatch',
      'the central directory holds more than the records it announces',
    );
  }
  hash.update(end.bytes);
  return { entries, directorySha256: hash.digest('hex') };
}

interface RecordFields {
  madeBy: number;
  needed: number;
  flags: number;
  method: number;
  time: number;
  date: number;
  compressedSize: number;
  size: number;
  extraLength: number;
  commentLength: number;
  diskStart: number;
  internal: number;
  external: number;
  offset: number;
}

/** The checks of one central record that come before its name, in pipeline order. */
function checkRecordFields(r: RecordFields): void {
  if (r.compressedSize === SENTINEL_32 || r.size === SENTINEL_32 || r.offset === SENTINEL_32) {
    throw invalid('zip64', 'an entry uses ZIP64 sizes or offsets');
  }
  if (r.flags & FLAG_ENCRYPTED) throw invalid('encrypted-entry', 'an entry is encrypted');
  if (r.flags & FLAG_DATA_DESCRIPTOR) {
    throw invalid('data-descriptor', 'an entry uses a data descriptor');
  }
  if (r.flags & ~FLAG_UTF8_NAMES) {
    throw invalid('general-purpose-flag', 'an entry sets a general-purpose flag bit');
  }
  if (r.method !== METHOD_STORED) {
    throw invalid(
      'unsupported-compression',
      'an entry is compressed; only stored entries are read',
    );
  }
  if (r.needed !== VERSION_NEEDED) {
    throw invalid('unsupported-version-needed', 'an entry needs a version other than 2.0');
  }
  if (r.time !== DOS_TIME || r.date !== DOS_DATE) {
    throw invalid('non-canonical-timestamp', 'an entry carries a timestamp');
  }
  if (r.extraLength > 0) throw invalid('extra-field', 'an entry carries an extra field');
  if (r.commentLength > 0) throw invalid('entry-comment', 'an entry carries a comment');
  if (r.diskStart !== 0) throw invalid('multi-disk', 'an entry starts on another disk');
  const type = (r.external >>> 16) & UNIX_TYPE_MASK;
  if (type === UNIX_TYPE_SYMLINK) throw invalid('symlink', 'the archive holds a symbolic link');
  if (type === UNIX_TYPE_DIRECTORY) {
    throw invalid('directory-entry', 'the archive holds a directory entry');
  }
}

/**
 * The checks between the directory test on the name and the name rules: any other non-regular
 * type, the fixed attributes, and equal sizes.
 */
function checkRecordModeAndSize(r: RecordFields): void {
  const type = (r.external >>> 16) & UNIX_TYPE_MASK;
  if (type !== UNIX_TYPE_REGULAR) throw invalid('special-file', 'the archive holds a special file');
  if (
    r.madeBy !== VERSION_MADE_BY ||
    r.external !== EXTERNAL_ATTRIBUTES ||
    r.internal !== INTERNAL_ATTRIBUTES
  ) {
    throw invalid('non-canonical-mode', 'an entry carries attributes other than a 0644 file');
  }
  if (r.compressedSize !== r.size) {
    throw invalid('header-directory-mismatch', 'a stored entry states two different sizes');
  }
}

function endsWithSlash(name: Buffer): boolean {
  return name.length > 0 && name[name.length - 1] === 0x2f;
}

function directoryShort() {
  return invalid('header-directory-mismatch', 'the central directory ends inside a record');
}

// ─── layout and local headers ──────────────────────────────────────────────────────────────────

/**
 * The offsets of every entry first (leading data, overlap, gaps, where the central directory
 * starts), then every local header against its central record, so the reason reported for an
 * archive with both kinds of fault is the offset one.
 */
async function checkLayout(
  source: ArchiveSource,
  entries: readonly ArchiveEntry[],
  directoryOffset: number,
  options: DirectoryOptions,
): Promise<void> {
  options.deadline.check();
  if (entries.length > 0 && entries[0]!.offset > 0) {
    throw invalid('leading-data', 'bytes precede the first local header');
  }
  let expected = 0;
  for (const entry of entries) {
    if (entry.offset < expected) {
      throw invalid('overlapping-entries', 'two entries share bytes of the archive');
    }
    if (entry.offset > expected) {
      throw invalid('header-directory-mismatch', 'the archive has a gap between two entries');
    }
    expected = entry.dataOffset + entry.size;
  }
  if (expected !== directoryOffset) {
    throw invalid(
      'header-directory-mismatch',
      'the central directory does not start where the last entry ends',
    );
  }
  for (const entry of entries) {
    options.deadline.check();
    const actual = await source.read(entry.offset, entry.dataOffset - entry.offset);
    if (!actual.equals(expectedLocalHeader(entry))) {
      throw invalid(
        'header-directory-mismatch',
        'a local header does not match its central record',
      );
    }
  }
}

/** The local header the profile fixes for an entry, from its central record. */
export function expectedLocalHeader(entry: ArchiveEntry): Buffer {
  return localHeader({
    name: entry.nameBytes,
    flags: entry.flags,
    crc32: entry.crc32,
    size: entry.size,
  });
}

// ─── messages ──────────────────────────────────────────────────────────────────────────────────

const NAME_MESSAGES: Record<string, string> = {
  'invalid-name-encoding': 'an entry name is not UTF-8',
  'nul-in-name': 'an entry name contains a NUL byte',
  backslash: 'an entry name contains a backslash',
  'drive-or-unc-path': 'an entry name starts with a drive letter or a UNC prefix',
  'absolute-path': 'an entry name is an absolute path',
  'non-ascii-name': 'an entry name is not ASCII',
  'empty-segment': 'an entry name has an empty segment',
  'dot-segment': 'an entry name has a . or .. segment',
  'outside-payload': 'an entry lies outside payload/',
};

const NAME_SET_MESSAGES: Record<string, string> = {
  'duplicate-name': 'two entries have the same name',
  'case-fold-collision': 'two entry names differ only in letter case',
  'normalization-collision': 'two entry names differ only in Unicode normalization',
  'path-prefix-collision': 'an entry name is also the directory of another entry',
  'entry-order': 'the entries are not sorted by name',
};

function invalid(reason: ErrorReason<'RAY_INVALID_ARCHIVE'>, message: string) {
  return refusal('RAY_INVALID_ARCHIVE', message, { reason });
}
