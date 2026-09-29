/**
 * The strict ZIP profile every `.ray` archive is written in and the only one a reader accepts:
 * stored entries, fixed header values, no extra fields, comments, data descriptors, ZIP64 records
 * or multi-disk fields, and a contiguous layout from the first local header at offset 0 to the end
 * record at the end of the file.
 *
 * The values restate the writer profile of the contract (`writerProfile` in
 * `contract/fixtures/EXPECTATIONS.json`); `profile.test.ts` holds them equal.
 */

export const LOCAL_HEADER_SIGNATURE = 0x04034b50;
export const CENTRAL_RECORD_SIGNATURE = 0x02014b50;
export const END_RECORD_SIGNATURE = 0x06054b50;
export const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

export const LOCAL_HEADER_SIZE = 30;
export const CENTRAL_RECORD_SIZE = 46;
export const END_RECORD_SIZE = 22;
export const ZIP64_LOCATOR_SIZE = 20;

/** The end record is searched for in this many bytes at the end: its size plus a 65,535-byte comment. */
export const END_RECORD_SEARCH_WINDOW = END_RECORD_SIZE + 0xffff;

/** Version needed to extract, in the local header and the central record. */
export const VERSION_NEEDED = 20;
/** Version made by: Unix, ZIP 2.0. */
export const VERSION_MADE_BY = 0x0314;
/** DOS time 00:00:00. */
export const DOS_TIME = 0x0000;
/** DOS date 1980-01-01. */
export const DOS_DATE = 0x0021;
/** Regular file, mode 0644. */
export const EXTERNAL_ATTRIBUTES = 0x81a40000;
export const INTERNAL_ATTRIBUTES = 0;
/** Stored, no compression. */
export const METHOD_STORED = 0;

/** General-purpose flag bits. */
export const FLAG_ENCRYPTED = 0x0001;
export const FLAG_DATA_DESCRIPTOR = 0x0008;
/** Names are UTF-8. A reader accepts it; the writer never sets it (names are ASCII). */
export const FLAG_UTF8_NAMES = 0x0800;

/** File-type bits of the Unix mode in the high half of the external attributes. */
export const UNIX_TYPE_MASK = 0o170000;
export const UNIX_TYPE_REGULAR = 0o100000;
export const UNIX_TYPE_DIRECTORY = 0o040000;
export const UNIX_TYPE_SYMLINK = 0o120000;

/** ZIP64 sentinels: a 16-bit or 32-bit field holding its maximum points at a ZIP64 record. */
export const SENTINEL_16 = 0xffff;
export const SENTINEL_32 = 0xffffffff;

/** The name every archive entry other than the root document starts with. */
export const PAYLOAD_PREFIX = 'payload/';

/**
 * The local header the profile fixes for an entry: every field follows from the central record,
 * so a reader compares the whole header byte for byte and a writer emits exactly these bytes.
 */
export function localHeader(entry: {
  name: Uint8Array;
  flags: number;
  crc32: number;
  size: number;
}): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE + entry.name.length);
  header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(METHOD_STORED, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc32 >>> 0, 14);
  header.writeUInt32LE(entry.size, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28);
  header.set(entry.name, LOCAL_HEADER_SIZE);
  return header;
}

/** The central record the profile fixes for an entry whose local header is at `offset`. */
export function centralRecord(entry: {
  name: Uint8Array;
  crc32: number;
  size: number;
  offset: number;
}): Buffer {
  const record = Buffer.alloc(CENTRAL_RECORD_SIZE + entry.name.length);
  record.writeUInt32LE(CENTRAL_RECORD_SIGNATURE, 0);
  record.writeUInt16LE(VERSION_MADE_BY, 4);
  record.writeUInt16LE(VERSION_NEEDED, 6);
  record.writeUInt16LE(0, 8);
  record.writeUInt16LE(METHOD_STORED, 10);
  record.writeUInt16LE(DOS_TIME, 12);
  record.writeUInt16LE(DOS_DATE, 14);
  record.writeUInt32LE(entry.crc32 >>> 0, 16);
  record.writeUInt32LE(entry.size, 20);
  record.writeUInt32LE(entry.size, 24);
  record.writeUInt16LE(entry.name.length, 28);
  record.writeUInt16LE(0, 30);
  record.writeUInt16LE(0, 32);
  record.writeUInt16LE(0, 34);
  record.writeUInt16LE(INTERNAL_ATTRIBUTES, 36);
  record.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
  record.writeUInt32LE(entry.offset, 42);
  record.set(entry.name, CENTRAL_RECORD_SIZE);
  return record;
}

/** The end record of an archive with `count` entries and the given central directory. */
export function endRecord(count: number, directorySize: number, directoryOffset: number): Buffer {
  const record = Buffer.alloc(END_RECORD_SIZE);
  record.writeUInt32LE(END_RECORD_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(directorySize, 12);
  record.writeUInt32LE(directoryOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}
