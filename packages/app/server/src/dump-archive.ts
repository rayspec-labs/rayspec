/**
 * THE TABLE OF CONTENTS OF A CUSTOM-FORMAT DUMP, read here rather than taken from `pg_restore`.
 *
 * An import decides what reaches the target from the archive's own table of contents: every entry's
 * kind (`desc`), schema, name, owner, and the exact SQL `pg_restore` would run for it (`defn`, and
 * `copyStmt` for a table's data). This module reads those fields from the archive bytes, following
 * the custom format `pg_dump` writes (`pg_backup_archiver.c`: the header, then the entries), so the
 * policy judges the statements themselves and not a rendering of them. The import then asks
 * `pg_restore -l` for its own listing of the same bytes and refuses any difference, so a field this
 * reader got wrong cannot pass unnoticed.
 *
 * Only what the custom format of archive versions 1.14 to 1.16 (PostgreSQL 12 to 17) holds is
 * accepted; anything else — another format, another version, an integer or offset width the reader
 * cannot hold, a length past the end, an implausible count — is refused as `DumpArchiveError`, never
 * guessed at. The data blocks after the table of contents are not read here.
 */

/** The custom format's code in the header. */
const FORMAT_CUSTOM = 1;

/** Archive versions this reader understands: 1.14 (PostgreSQL 12) to 1.16 (PostgreSQL 17). */
const MIN_VERSION = version(1, 14, 0);
const MAX_VERSION = version(1, 16, 0);
const VERSION_1_15 = version(1, 15, 0);
const VERSION_1_16 = version(1, 16, 0);

/** The most entries a table of contents may list; a real dump of a deployment has a few hundred. */
export const MAX_TOC_ENTRIES = 200_000;

/** The most dependencies one entry may list. */
const MAX_DEPENDENCIES = 100_000;

/**
 * The longest single string of a table of contents: a statement, a name. A real one is a few
 * kilobytes at most; a longer one is refused before it is read into memory.
 */
export const MAX_TOC_STRING_BYTES = 16 * 1024 * 1024;

function version(major: number, minor: number, revision: number): number {
  return (major * 256 + minor) * 256 + revision;
}

/** The archive is not a custom-format dump this reader can read. The message names no content. */
export class DumpArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DumpArchiveError';
  }
}

/** The header of a custom-format archive. */
export interface DumpHeader {
  /** `major.minor.revision` of the archive format. */
  version: string;
  intSize: number;
  offSize: number;
  /** The compression algorithm byte (1.15 and later) or level (earlier). */
  compression: number;
  databaseName: string | null;
  /** The server version the dump was taken from, as `pg_dump` recorded it. */
  serverVersion: string | null;
  /** The `pg_dump` version that wrote it. */
  dumpVersion: string | null;
}

/** One entry of the table of contents, as `pg_restore` would act on it. */
export interface DumpTocEntry {
  dumpId: number;
  hadDumper: boolean;
  tableoid: string;
  oid: string;
  tag: string;
  desc: string;
  section: number;
  /** The SQL `pg_restore` runs for the entry; null or empty for a table's data. */
  defn: string | null;
  dropStmt: string | null;
  /** The `COPY … FROM stdin;` statement of a table's data, or null. */
  copyStmt: string | null;
  namespace: string | null;
  tablespace: string | null;
  tableam: string | null;
  owner: string | null;
  dependencies: number[];
  /** The state of the entry's data pointer: 1 not set, 2 set, 3 no data. */
  dataState: number;
}

export interface DumpToc {
  header: DumpHeader;
  entries: DumpTocEntry[];
  /** Where the table of contents begins (its entry count) and where it ends (the data blocks). */
  tocStart: number;
  tocEnd: number;
}

/** Reads `length` bytes at `position` of the archive; fewer only at its end. */
export type DumpByteReader = (position: number, length: number) => Promise<Buffer>;

/** How much of the archive is read ahead at a time. */
const WINDOW_BYTES = 64 * 1024;

/** A sequential cursor over the archive that reads it in windows. */
class Cursor {
  #window: Buffer = Buffer.alloc(0);
  #windowStart = 0;
  position = 0;

  constructor(
    private readonly read: DumpByteReader,
    private readonly size: number,
  ) {}

  async bytes(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.size) {
      throw new DumpArchiveError('the dump ends inside its table of contents');
    }
    const parts: Buffer[] = [];
    let needed = length;
    while (needed > 0) {
      const offset = this.position - this.#windowStart;
      if (offset < 0 || offset >= this.#window.length) {
        this.#windowStart = this.position;
        this.#window = await this.read(
          this.position,
          Math.min(WINDOW_BYTES, this.size - this.position),
        );
        if (this.#window.length === 0) {
          throw new DumpArchiveError('the dump ends inside its table of contents');
        }
        continue;
      }
      const take = Math.min(needed, this.#window.length - offset);
      parts.push(this.#window.subarray(offset, offset + take));
      this.position += take;
      needed -= take;
    }
    return parts.length === 1 ? Buffer.from(parts[0]!) : Buffer.concat(parts);
  }

  async byte(): Promise<number> {
    return (await this.bytes(1))[0]!;
  }
}

/**
 * Read the header and the table of contents of the custom-format archive of `size` bytes that `read`
 * gives access to. Throws `DumpArchiveError` for anything that is not such an archive.
 */
export async function readDumpToc(read: DumpByteReader, size: number): Promise<DumpToc> {
  const c = new Cursor(read, size);
  if ((await c.bytes(5)).toString('latin1') !== 'PGDMP') {
    throw new DumpArchiveError('the dump is not a custom-format archive');
  }
  const vmaj = await c.byte();
  const vmin = await c.byte();
  const vrev = await c.byte();
  const archiveVersion = version(vmaj, vmin, vrev);
  if (archiveVersion < MIN_VERSION || archiveVersion > MAX_VERSION) {
    throw new DumpArchiveError(
      `the dump's archive version ${vmaj}.${vmin}.${vrev} is not one an import reads (1.14 to 1.16)`,
    );
  }
  const intSize = await c.byte();
  const offSize = await c.byte();
  // Integers are read into JavaScript numbers: at most four bytes of magnitude keep them exact.
  if (intSize < 1 || intSize > 4) {
    throw new DumpArchiveError('the dump was written with an integer width an import cannot read');
  }
  if (offSize < 1 || offSize > 8) {
    throw new DumpArchiveError('the dump was written with an offset width an import cannot read');
  }
  if ((await c.byte()) !== FORMAT_CUSTOM) {
    throw new DumpArchiveError('the dump is not in the custom format');
  }

  const readInt = async (): Promise<number> => {
    const sign = await c.byte();
    const bytes = await c.bytes(intSize);
    let value = 0;
    for (let i = intSize - 1; i >= 0; i--) value = value * 256 + bytes[i]!;
    if (sign !== 0 && sign !== 1) throw new DumpArchiveError('the dump holds a malformed integer');
    return sign === 1 ? -value : value;
  };
  const readStr = async (): Promise<string | null> => {
    const length = await readInt();
    if (length < 0) return null;
    if (length > MAX_TOC_STRING_BYTES) {
      throw new DumpArchiveError(
        'the dump holds a table-of-contents string longer than an import reads',
      );
    }
    return (await c.bytes(length)).toString('utf8');
  };
  const readOffset = async (): Promise<number> => {
    const flag = await c.byte();
    if (flag < 1 || flag > 3) throw new DumpArchiveError('the dump holds a malformed data offset');
    await c.bytes(offSize);
    return flag;
  };

  const compression = archiveVersion >= VERSION_1_15 ? await c.byte() : await readInt();
  for (let i = 0; i < 7; i++) await readInt(); // the creation time
  const databaseName = await readStr();
  const serverVersion = await readStr();
  const dumpVersion = await readStr();

  const tocStart = c.position;
  const count = await readInt();
  if (count < 0 || count > MAX_TOC_ENTRIES) {
    throw new DumpArchiveError('the dump lists an implausible number of entries');
  }
  const entries: DumpTocEntry[] = [];
  for (let i = 0; i < count; i++) {
    const dumpId = await readInt();
    if (dumpId <= 0) throw new DumpArchiveError('the dump lists an entry id out of range');
    const hadDumper = (await readInt()) !== 0;
    const tableoid = (await readStr()) ?? '';
    const oid = (await readStr()) ?? '';
    const tag = (await readStr()) ?? '';
    const desc = (await readStr()) ?? '';
    const section = await readInt();
    const defn = await readStr();
    const dropStmt = await readStr();
    const copyStmt = await readStr();
    const namespace = await readStr();
    const tablespace = await readStr();
    const tableam = await readStr();
    if (archiveVersion >= VERSION_1_16) await readInt(); // relkind
    const owner = await readStr();
    if ((await readStr()) === 'true') {
      throw new DumpArchiveError('the dump holds a table with OIDs, which no restore supports');
    }
    const dependencies: number[] = [];
    for (;;) {
      const dependency = await readStr();
      if (dependency === null) break;
      if (!/^[0-9]{1,10}$/.test(dependency) || dependencies.length >= MAX_DEPENDENCIES) {
        throw new DumpArchiveError('the dump lists a malformed dependency');
      }
      dependencies.push(Number(dependency));
    }
    const dataState = await readOffset();
    entries.push({
      dumpId,
      hadDumper,
      tableoid,
      oid,
      tag,
      desc,
      section,
      defn,
      dropStmt,
      copyStmt,
      namespace,
      tablespace,
      tableam,
      owner,
      dependencies,
      dataState,
    });
  }
  return {
    header: {
      version: `${vmaj}.${vmin}.${vrev}`,
      intSize,
      offSize,
      compression,
      databaseName,
      serverVersion,
      dumpVersion,
    },
    entries,
    tocStart,
    tocEnd: c.position,
  };
}

/** The entries `pg_restore -l` lists: every one but the three that set up the session. */
export const SESSION_ENTRIES: ReadonlySet<string> = new Set([
  'ENCODING',
  'STDSTRINGS',
  'SEARCHPATH',
]);

/** A field as `pg_restore -l` prints it: line breaks become spaces, and an empty schema `-`. */
function sanitize(value: string | null, hyphen: boolean): string {
  const line = (value ?? '').replace(/[\r\n]/g, ' ');
  return hyphen && line === '' ? '-' : line;
}

/**
 * The listing `pg_restore -l` prints for these entries, line by line, without its header comments:
 * `<id>; <tableoid> <oid> <desc> <schema> <name> <owner>`. The import compares it with what
 * `pg_restore` itself lists for the same archive.
 */
export function tocListing(entries: readonly DumpTocEntry[]): string[] {
  return entries
    .filter((e) => !SESSION_ENTRIES.has(e.desc))
    .map(
      (e) =>
        `${e.dumpId}; ${e.tableoid} ${e.oid} ${e.desc} ${sanitize(e.namespace, true)} ` +
        `${sanitize(e.tag, false)} ${sanitize(e.owner, false)}`,
    );
}
