/**
 * The table of contents of a custom-format dump, read from its bytes: every field of every entry
 * comes back as written, in archive order, for the three archive versions an import reads, and
 * anything else — another format, another version, an integer width the reader cannot hold, a
 * truncated archive, an implausible count, a table with OIDs — is refused, never guessed at. The
 * listing it renders is the one `pg_restore --list` prints. (That a real `pg_dump` archive reads
 * the same both ways is shown against the server, in the import suite of `@rayspec/cli`.)
 */
import { describe, expect, it } from 'vitest';
import {
  DumpArchiveError,
  type DumpTocEntry,
  readDumpToc,
  SESSION_ENTRIES,
  tocListing,
} from './dump-archive.js';
import { newDump } from './test-support/dump-archive-writer.js';

function entry(
  over: Partial<DumpTocEntry> & Pick<DumpTocEntry, 'dumpId' | 'desc' | 'tag'>,
): DumpTocEntry {
  return {
    hadDumper: false,
    tableoid: '0',
    oid: '0',
    section: 2,
    defn: null,
    dropStmt: null,
    copyStmt: null,
    namespace: null,
    tablespace: null,
    tableam: null,
    owner: null,
    dependencies: [],
    dataState: 3,
    ...over,
  };
}

const ENTRIES: DumpTocEntry[] = [
  entry({
    dumpId: 3001,
    desc: 'ENCODING',
    tag: 'ENCODING',
    defn: "SET client_encoding = 'UTF8';\n",
  }),
  entry({
    dumpId: 6,
    desc: 'SCHEMA',
    tag: 'drizzle',
    tableoid: '2615',
    oid: '18753',
    defn: 'CREATE SCHEMA drizzle;\n',
    owner: 'app_migrator',
    section: 2,
  }),
  entry({
    dumpId: 217,
    desc: 'TABLE',
    tag: 'größe "quoted"',
    namespace: 'public',
    tableoid: '1259',
    oid: '18755',
    defn: 'CREATE TABLE public."größe ""quoted""" (id integer);\n',
    owner: 'app_migrator',
    tableam: 'heap',
    dependencies: [6, 7],
  }),
  entry({
    dumpId: 3500,
    desc: 'TABLE DATA',
    tag: 'line\nbreak',
    namespace: 'public',
    hadDumper: true,
    copyStmt: 'COPY public.t (id) FROM stdin;\n',
    owner: 'app_migrator',
    section: 3,
    dataState: 2,
  }),
];

const reader = (bytes: Buffer) => async (position: number, length: number) =>
  bytes.subarray(position, position + length);

const refusal = async (bytes: Buffer): Promise<string> => {
  try {
    await readDumpToc(reader(bytes), bytes.length);
    return 'read';
  } catch (err) {
    if (err instanceof DumpArchiveError) return err.message;
    throw err;
  }
};

describe('readDumpToc', () => {
  for (const version of [
    [1, 14, 0],
    [1, 15, 0],
    [1, 16, 0],
  ] as [number, number, number][]) {
    it(`reads every field of every entry of a ${version.join('.')} archive, in order`, async () => {
      const data = Buffer.from('data blocks follow');
      const bytes = newDump(ENTRIES, { version, data });
      const toc = await readDumpToc(reader(bytes), bytes.length);
      expect(toc.header).toMatchObject({
        version: version.join('.'),
        intSize: 4,
        offSize: 8,
        serverVersion: '16.4',
        databaseName: 'app',
      });
      // An entry with data loses its offset in the writer: "not set", read in sequence.
      expect(toc.entries).toEqual(
        ENTRIES.map((e) => (e.dataState === 2 ? { ...e, dataState: 1 } : e)),
      );
      expect(bytes.subarray(toc.tocEnd).equals(data)).toBe(true);
      expect(toc.tocStart).toBeLessThan(toc.tocEnd);
    });
  }

  it('reads an archive whose table of contents spans many read windows', async () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      entry({
        dumpId: i + 1,
        desc: 'COMMENT',
        tag: `c${i}`,
        defn: `COMMENT ON TABLE t IS '${'x'.repeat(40)}';\n`,
      }),
    );
    const bytes = newDump(many);
    expect(bytes.length).toBeGreaterThan(3 * 64 * 1024);
    const toc = await readDumpToc(reader(bytes), bytes.length);
    expect(toc.entries.length).toBe(3000);
    expect(toc.entries.at(-1)?.tag).toBe('c2999');
  });

  it('refuses what is not a custom-format archive of 1.14 to 1.16', async () => {
    const good = newDump(ENTRIES);
    expect(await refusal(Buffer.concat([Buffer.from('PGDMQ'), good.subarray(5)]))).toMatch(
      /not a custom-format archive/,
    );
    expect(await refusal(newDump(ENTRIES, { version: [1, 13, 0] }))).toMatch(
      /archive version 1\.13\.0/,
    );
    expect(await refusal(newDump(ENTRIES, { version: [1, 17, 0] }))).toMatch(
      /archive version 1\.17\.0/,
    );
    expect(await refusal(newDump(ENTRIES, { format: 5 }))).toMatch(/not in the custom format/);
    expect(await refusal(newDump(ENTRIES, { intSize: 8 }))).toMatch(/integer width/);
    expect(await refusal(newDump(ENTRIES, { offSize: 9 }))).toMatch(/offset width/);
  });

  it('refuses a truncated archive, wherever it ends inside the table of contents', async () => {
    const bytes = newDump(ENTRIES);
    const toc = await readDumpToc(reader(bytes), bytes.length);
    for (const end of [3, 10, 40, toc.tocStart + 2, toc.tocEnd - 1]) {
      expect(await refusal(bytes.subarray(0, end)), String(end)).toMatch(/ends inside/);
    }
  });

  it('refuses an implausible entry count, an entry id out of range, a table with OIDs, an overlong string, a bad data offset', async () => {
    const bytes = newDump(ENTRIES);
    const toc = await readDumpToc(reader(bytes), bytes.length);
    const count = Buffer.from(bytes);
    count.writeUInt32LE(5_000_000, toc.tocStart + 1);
    expect(await refusal(count)).toMatch(/implausible number of entries/);
    expect(await refusal(newDump([entry({ dumpId: 0, desc: 'X', tag: 'x' })]))).toMatch(
      /out of range/,
    );
    const oids = newDump([entry({ dumpId: 1, desc: 'TABLE', tag: 't' })]);
    const written = Buffer.concat([Buffer.from([0, 5, 0, 0, 0]), Buffer.from('false')]);
    const at = oids.indexOf(written);
    expect(at).toBeGreaterThan(0);
    const withOids = Buffer.concat([
      oids.subarray(0, at),
      Buffer.from([0, 4, 0, 0, 0]),
      Buffer.from('true'),
      oids.subarray(at + written.length),
    ]);
    expect(await refusal(withOids)).toMatch(/OIDs/);
    const long = newDump([entry({ dumpId: 1, desc: 'TABLE', tag: 't' })]);
    const tag = Buffer.concat([Buffer.from([0, 1, 0, 0, 0]), Buffer.from('t')]);
    const tagAt = long.indexOf(tag);
    expect(tagAt).toBeGreaterThan(0);
    const huge = Buffer.from(long);
    // The tag claims 32 MiB: refused before it is read, although the archive ends long before.
    huge.writeUInt32LE(32 * 1024 * 1024, tagAt + 1);
    expect(await refusal(huge)).toMatch(/longer than an import reads/);
    const offset = newDump([entry({ dumpId: 1, desc: 'TABLE', tag: 't' })]);
    const badOffset = Buffer.from(offset);
    badOffset[badOffset.length - 9] = 7;
    expect(await refusal(badOffset)).toMatch(/data offset/);
  });
});

describe('tocListing', () => {
  it('renders the lines pg_restore --list prints, leaving out the session entries', () => {
    expect(SESSION_ENTRIES.has('SEARCHPATH')).toBe(true);
    expect(tocListing(ENTRIES)).toEqual([
      '6; 2615 18753 SCHEMA - drizzle app_migrator',
      '217; 1259 18755 TABLE public größe "quoted" app_migrator',
      '3500; 0 0 TABLE DATA public line break app_migrator',
    ]);
  });
});
