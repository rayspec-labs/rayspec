/**
 * A ZIP serializer for tests that writes whatever it is told: every header field of every entry
 * can be overridden in the local header, the central record or both, and bytes can be put before
 * the first entry or after the end record. It is written independently of the package's profile
 * module, so a wrong constant there cannot hide behind the same constant here.
 */
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { canonicalJsonFile } from '@rayspec/bundle-contract';
import type { Expectations } from './contract.js';

export interface HeaderFields {
  signature: number;
  madeBy: number;
  needed: number;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  csize: number;
  usize: number;
  nameLength: number;
  extra: Buffer;
  comment: Buffer;
  disk: number;
  internal: number;
  external: number;
  offset: number;
  name: Buffer;
}

export interface RawEntry {
  name: string | Buffer;
  data: string | Buffer;
  central?: Partial<HeaderFields>;
  local?: Partial<HeaderFields>;
}

export interface EndFields {
  disk: number;
  directoryDisk: number;
  onThisDisk: number;
  total: number;
  directorySize: number;
  directoryOffset: number;
  comment: Buffer;
}

export interface RawLayout {
  prefix?: Buffer;
  suffix?: Buffer;
  end?: Partial<EndFields>;
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

export function rawZip(entries: readonly RawEntry[], layout: RawLayout = {}): Buffer {
  const prefix = layout.prefix ?? Buffer.alloc(0);
  const out: Buffer[] = [prefix];
  let size = prefix.length;
  const central: Buffer[] = [];
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf8') : entry.name;
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const common: HeaderFields = {
      signature: 0,
      madeBy: 0x0314,
      needed: 20,
      flags: 0,
      method: 0,
      time: 0,
      date: 0x21,
      crc: crc32(data) >>> 0,
      csize: data.length,
      usize: data.length,
      nameLength: name.length,
      extra: Buffer.alloc(0),
      comment: Buffer.alloc(0),
      disk: 0,
      internal: 0,
      external: 0x81a40000,
      offset: size,
      name,
    };
    const l = { ...common, signature: 0x04034b50, ...entry.local };
    const c = { ...common, signature: 0x02014b50, ...entry.central };
    const local = Buffer.concat([
      u32(l.signature),
      u16(l.needed),
      u16(l.flags),
      u16(l.method),
      u16(l.time),
      u16(l.date),
      u32(l.crc),
      u32(l.csize),
      u32(l.usize),
      u16(l.nameLength),
      u16(l.extra.length),
      l.name,
      l.extra,
      data,
    ]);
    out.push(local);
    size += local.length;
    central.push(
      Buffer.concat([
        u32(c.signature),
        u16(c.madeBy),
        u16(c.needed),
        u16(c.flags),
        u16(c.method),
        u16(c.time),
        u16(c.date),
        u32(c.crc),
        u32(c.csize),
        u32(c.usize),
        u16(c.nameLength),
        u16(c.extra.length),
        u16(c.comment.length),
        u16(c.disk),
        u16(c.internal),
        u32(c.external),
        u32(c.offset),
        c.name,
        c.extra,
        c.comment,
      ]),
    );
  }
  const directory = Buffer.concat(central);
  out.push(directory);
  const end: EndFields = {
    disk: 0,
    directoryDisk: 0,
    onThisDisk: entries.length,
    total: entries.length,
    directorySize: directory.length,
    directoryOffset: size,
    comment: Buffer.alloc(0),
    ...layout.end,
  };
  out.push(
    u32(0x06054b50),
    u16(end.disk),
    u16(end.directoryDisk),
    u16(end.onThisDisk),
    u16(end.total),
    u32(end.directorySize),
    u32(end.directoryOffset),
    u16(end.comment.length),
    end.comment,
    layout.suffix ?? Buffer.alloc(0),
  );
  return Buffer.concat(out);
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** The files of a base as name to bytes. */
export function baseFiles(
  expectations: Expectations,
  kind: 'application' | 'migration' = 'application',
): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const [name, f] of Object.entries(expectations.bases[kind].files)) {
    files.set(name, Buffer.from(f.utf8, 'utf8'));
  }
  return files;
}

/**
 * The entries of a base bundle with `files` in place of the base files and the inventory
 * recomputed from them, sorted by name, `ray.json` last. `manifestPatch` edits the manifest before
 * it is serialized.
 */
export function bundleEntries(
  expectations: Expectations,
  options: {
    kind?: 'application' | 'migration';
    files?: Map<string, Buffer>;
    manifestPatch?: (manifest: Record<string, unknown>) => void;
  } = {},
): RawEntry[] {
  const kind = options.kind ?? 'application';
  const files = options.files ?? baseFiles(expectations, kind);
  const sorted = [...files.entries()].sort(([a], [b]) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const manifest = structuredClone(expectations.bases[kind].manifest);
  manifest.inventory = sorted.map(([path, data]) => ({
    path,
    size: data.length,
    sha256: sha256(data),
  }));
  options.manifestPatch?.(manifest);
  return [
    ...sorted.map(([name, data]) => ({ name, data })),
    { name: 'ray.json', data: canonicalJsonFile(manifest) },
  ];
}
