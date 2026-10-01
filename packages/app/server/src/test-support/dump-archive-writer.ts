/**
 * Test-support: rewrite the table of contents of a custom-format dump, keeping its header and its
 * data blocks byte for byte, so a suite can hand an import a dump `pg_dump` would never write — an
 * extension, a role, a definer function, `COPY … FROM PROGRAM`. Entries that carry data lose their
 * data offsets (they are read in sequence, as from a pipe), so inserting an entry is safe.
 */
import type { DumpToc, DumpTocEntry } from '../dump-archive.js';

function int(value: number, intSize: number): Buffer {
  const out = Buffer.alloc(1 + intSize);
  out[0] = value < 0 ? 1 : 0;
  let magnitude = Math.abs(value);
  for (let i = 0; i < intSize; i++) {
    out[1 + i] = magnitude % 256;
    magnitude = Math.floor(magnitude / 256);
  }
  return out;
}

function str(value: string | null, intSize: number): Buffer {
  if (value === null) return int(-1, intSize);
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([int(bytes.length, intSize), bytes]);
}

/** One entry in the archive's encoding. */
function entryBytes(e: DumpTocEntry, toc: DumpToc): Buffer {
  const { intSize, offSize } = toc.header;
  const v16 = toc.header.version.startsWith('1.16');
  const offset = Buffer.alloc(1 + offSize);
  offset[0] = e.dataState === 2 ? 1 : e.dataState;
  return Buffer.concat([
    int(e.dumpId, intSize),
    int(e.hadDumper ? 1 : 0, intSize),
    str(e.tableoid, intSize),
    str(e.oid, intSize),
    str(e.tag, intSize),
    str(e.desc, intSize),
    int(e.section, intSize),
    str(e.defn, intSize),
    str(e.dropStmt, intSize),
    str(e.copyStmt, intSize),
    str(e.namespace, intSize),
    str(e.tablespace, intSize),
    str(e.tableam, intSize),
    ...(v16 ? [int(0, intSize)] : []),
    str(e.owner, intSize),
    str('false', intSize),
    ...e.dependencies.map((d) => str(String(d), intSize)),
    str(null, intSize),
    offset,
  ]);
}

/** The dump `original` with its table of contents replaced by `entries`. */
export function rewriteDumpToc(
  original: Buffer,
  toc: DumpToc,
  entries: readonly DumpTocEntry[],
): Buffer {
  return Buffer.concat([
    original.subarray(0, toc.tocStart),
    int(entries.length, toc.header.intSize),
    ...entries.map((e) => entryBytes(e, toc)),
    original.subarray(toc.tocEnd),
  ]);
}

export interface NewDumpOptions {
  /** `major.minor.revision` of the archive format; 1.15.0 (PostgreSQL 16) by default. */
  version?: [number, number, number];
  intSize?: number;
  offSize?: number;
  format?: number;
  serverVersion?: string;
  /** Bytes after the table of contents, where data blocks would be. */
  data?: Buffer;
}

/** A custom-format archive of `entries` and nothing else, as `pg_dump` lays one out. */
export function newDump(entries: readonly DumpTocEntry[], options: NewDumpOptions = {}): Buffer {
  const [vmaj, vmin, vrev] = options.version ?? [1, 15, 0];
  const intSize = options.intSize ?? 4;
  const offSize = options.offSize ?? 8;
  const header = Buffer.concat([
    Buffer.from('PGDMP', 'latin1'),
    Buffer.from([vmaj, vmin, vrev, intSize, offSize, options.format ?? 1]),
    vmin >= 15 ? Buffer.from([0]) : int(0, intSize),
    ...[0, 0, 12, 1, 9, 126, 0].map((n) => int(n, intSize)),
    str('app', intSize),
    str(options.serverVersion ?? '16.4', intSize),
    str('16.4', intSize),
  ]);
  const toc: DumpToc = {
    header: {
      version: `${vmaj}.${vmin}.${vrev}`,
      intSize,
      offSize,
      compression: 0,
      databaseName: 'app',
      serverVersion: options.serverVersion ?? '16.4',
      dumpVersion: '16.4',
    },
    entries: [],
    tocStart: header.length,
    tocEnd: header.length,
  };
  return rewriteDumpToc(Buffer.concat([header, options.data ?? Buffer.alloc(0)]), toc, entries);
}
