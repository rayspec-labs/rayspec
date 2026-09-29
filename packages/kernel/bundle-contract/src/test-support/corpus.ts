/**
 * Builds the golden fixture corpus from `contract/fixtures/EXPECTATIONS.json`.
 *
 * Every byte-level case is built deterministically from one of the two bases by the construction
 * rules the expectations file states: payload file changes, the inventory, RFC 6902 manifest
 * patches, replacement manifest bytes, the strict writer profile, low-level archive operations and
 * raw bytes. Signature cases also get a detached signature file made with a test signer whose seed
 * text is public.
 *
 * Pure: nothing here touches the filesystem. `scripts/gen-corpus.ts` writes the bytes into
 * `corpus/`, and `corpus.test.ts` rebuilds them and compares byte for byte.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonFile,
  compareCodePoints,
} from '../canonical-json.js';
import type {
  ArchiveOperation,
  Construction,
  CorpusCase,
  Expectations,
  PatchOperation,
  SignatureConstruction,
} from './contract-files.js';

export type { CaseExpectation, Construction, CorpusCase, Expectations } from './contract-files.js';

/** The bytes of one case, plus the manifest bytes that went into its `ray.json` entry. */
export interface BuiltCase {
  bytes: Buffer;
  /** The `ray.json` bytes; null for a raw-bytes case, which has no manifest entry. */
  manifestBytes: Buffer | null;
}

const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

// ─── strict writer (the profile of the container section) ─────────────────────────────────────

const DOS_DATE = 0x0021;
const EXTERNAL_ATTRIBUTES = 0x81a40000;
const VERSION_MADE_BY = 0x0314;

interface LocalOverrides {
  name?: Buffer;
  needed?: number;
  flags?: number;
  method?: number;
  time?: number;
  date?: number;
  crc?: number;
  csize?: number;
  usize?: number;
  extra?: Buffer;
}

interface Entry {
  name: Buffer;
  data: Buffer;
  method: number;
  flags: number;
  time: number;
  date: number;
  needed: number;
  madeBy: number;
  ext: number;
  int: number;
  extra: Buffer;
  comment: Buffer;
  disk: number;
  crc: number | null;
  csize: number | null;
  usize: number | null;
  local: LocalOverrides;
  /** The name of another entry whose local header this central record points at. */
  offsetOf: string | null;
}

function entry(name: string | Buffer, data: Buffer): Entry {
  return {
    name: typeof name === 'string' ? Buffer.from(name, 'utf8') : name,
    data,
    method: 0,
    flags: 0,
    time: 0,
    date: DOS_DATE,
    needed: 20,
    madeBy: VERSION_MADE_BY,
    ext: EXTERNAL_ATTRIBUTES,
    int: 0,
    extra: Buffer.alloc(0),
    comment: Buffer.alloc(0),
    disk: 0,
    crc: null,
    csize: null,
    usize: null,
    local: {},
    offsetOf: null,
  };
}

interface EndOverrides {
  disk?: number;
  comment?: Buffer;
}

interface Layout {
  prefix: Buffer;
  suffix: Buffer;
  end: EndOverrides;
  zip64: boolean;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Raw deflate output at level 9 is not the same on every zlib build: the contract corpus was built
 * with zlib 1.2.12, and Node's bundled zlib emits a different (equally valid) stream for the same
 * input. The stream the contract recorded for its one deflated entry (`payload/rayspec.yaml` of
 * the application base) is pinned here by the SHA-256 of its input, so the corpus rebuilds byte
 * for byte on any zlib. `corpus.test.ts` inflates it back and compares it with that input.
 */
export const PINNED_DEFLATE_STREAMS: ReadonlyMap<string, string> = new Map([
  [
    '99ec929c3b1dbb37ecd3406caaec2b74c5ecbdf46094847f79887f36252c90b7',
    '1dca390ec3300c05d15ea7f89d2b7969791b06a200011615905490e37b2967f07e62de86129663dd97d425b870302540b90be133b59c92ebb0ce916bfbc73449d5868668795c868d1937ddee004a33c2bab1bb84bfc7bf4ca87cbaa40b',
  ],
]);

function deflateLevel9(data: Buffer): Buffer {
  const pinned = PINNED_DEFLATE_STREAMS.get(sha256Hex(data));
  return pinned === undefined ? deflateRawSync(data, { level: 9 }) : Buffer.from(pinned, 'hex');
}

function serialize(entries: Entry[], layout: Layout): Buffer {
  const out: Buffer[] = [layout.prefix];
  let size = layout.prefix.length;
  const offsets: number[] = [];
  const sums: [number, number, number][] = [];
  for (const e of entries) {
    const stored = e.method === 8 ? deflateLevel9(e.data) : e.data;
    const crc = e.crc ?? crc32(e.data);
    const csize = e.csize ?? stored.length;
    const usize = e.usize ?? e.data.length;
    const l = {
      name: e.name,
      needed: e.needed,
      flags: e.flags,
      method: e.method,
      time: e.time,
      date: e.date,
      crc,
      csize,
      usize,
      extra: e.extra,
      ...e.local,
    };
    offsets.push(size);
    const parts = [
      u32(0x04034b50),
      u16(l.needed),
      u16(l.flags),
      u16(l.method),
      u16(l.time),
      u16(l.date),
      u32(l.crc),
      u32(l.csize),
      u32(l.usize),
      u16(l.name.length),
      u16(l.extra.length),
      l.name,
      l.extra,
      stored,
    ];
    if (e.flags & 0x8) parts.push(u32(0x08074b50), u32(crc), u32(csize), u32(usize));
    for (const p of parts) {
      out.push(p);
      size += p.length;
    }
    sums.push([crc, csize, usize]);
  }
  const directoryOffset = size;
  const directory: Buffer[] = [];
  entries.forEach((e, i) => {
    const [crc, csize, usize] = sums[i]!;
    const target =
      e.offsetOf === null ? i : entries.findIndex((x) => x.name.equals(Buffer.from(e.offsetOf!)));
    directory.push(
      u32(0x02014b50),
      u16(e.madeBy),
      u16(e.needed),
      u16(e.flags),
      u16(e.method),
      u16(e.time),
      u16(e.date),
      u32(crc),
      u32(csize),
      u32(usize),
      u16(e.name.length),
      u16(e.extra.length),
      u16(e.comment.length),
      u16(e.disk),
      u16(e.int),
      u32(e.ext),
      u32(offsets[target]!),
      e.name,
      e.extra,
      e.comment,
    );
  });
  const directoryBytes = Buffer.concat(directory);
  out.push(directoryBytes);
  size += directoryBytes.length;
  const end = {
    disk: 0,
    cdDisk: 0,
    thisDisk: entries.length,
    total: entries.length,
    cdSize: directoryBytes.length,
    cdOffset: directoryOffset,
    comment: Buffer.alloc(0),
    ...layout.end,
  };
  if (layout.zip64) {
    const zip64At = size;
    const record = Buffer.concat([
      u32(0x06064b50),
      u64(44),
      u16(VERSION_MADE_BY),
      u16(45),
      u32(0),
      u32(0),
      u64(end.thisDisk),
      u64(end.total),
      u64(end.cdSize),
      u64(end.cdOffset),
      u32(0x07064b50),
      u32(0),
      u64(zip64At),
      u32(1),
    ]);
    out.push(record);
    size += record.length;
  }
  out.push(
    u32(0x06054b50),
    u16(end.disk),
    u16(end.cdDisk),
    u16(end.thisDisk),
    u16(end.total),
    u32(end.cdSize),
    u32(end.cdOffset),
    u16(end.comment.length),
    end.comment,
    layout.suffix,
  );
  return Buffer.concat(out);
}

const SECOND_ARCHIVE = serialize([entry('ray.json', Buffer.from('{}\n'))], {
  prefix: Buffer.alloc(0),
  suffix: Buffer.alloc(0),
  end: {},
  zip64: false,
});

// ─── manifest construction ─────────────────────────────────────────────────────────────────────

function inventoryOf(files: Map<string, Buffer>): Record<string, unknown>[] {
  return [...files.entries()]
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([path, data]) => ({ path, size: data.length, sha256: sha256Hex(data) }));
}

function pointerParts(path: string): string[] {
  return path
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function resolveParent(doc: unknown, path: string): [Record<string, unknown> | unknown[], string] {
  const parts = pointerParts(path);
  let cur = doc as Record<string, unknown> | unknown[];
  for (const p of parts.slice(0, -1)) {
    cur = (Array.isArray(cur) ? cur[Number(p)] : cur[p]) as Record<string, unknown> | unknown[];
  }
  return [cur, parts[parts.length - 1]!];
}

function patch(doc: unknown, ops: PatchOperation[]): unknown {
  const out = structuredClone(doc);
  for (const op of ops) {
    const [parent, key] = resolveParent(out, op.path);
    if (op.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
      continue;
    }
    let value: unknown;
    if (op.op === 'copy') {
      const [from, fromKey] = resolveParent(out, op.from);
      value = structuredClone(Array.isArray(from) ? from[Number(fromKey)] : from[fromKey]);
    } else {
      value = structuredClone(op.value);
    }
    if (Array.isArray(parent)) {
      if (key === '-') parent.push(value);
      else if (op.op === 'replace') parent[Number(key)] = value;
      else parent.splice(Number(key), 0, value);
    } else {
      parent[key] = value;
    }
  }
  return out;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort(compareCodePoints)) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * The canonical text of a manifest. A case that plants a value the canonical form refuses (a
 * non-NFC string) is written in the same key order and separators without the refusal, because
 * the reader, not the writer, is what such a case exercises.
 */
function canonicalText(manifest: Record<string, unknown>): string {
  try {
    return canonicalJson(manifest);
  } catch (err) {
    if (!(err instanceof CanonicalJsonError)) throw err;
    return JSON.stringify(sortKeysDeep(manifest));
  }
}

function manifestBytesFor(
  manifest: Record<string, unknown>,
  spec: Record<string, unknown> | undefined,
): Buffer {
  const canonicalFile = Buffer.from(`${canonicalText(manifest)}\n`, 'utf8');
  if (spec === undefined) return canonicalFile;
  if (typeof spec.utf8 === 'string') return Buffer.from(spec.utf8, 'utf8');
  if (typeof spec.hex === 'string') {
    const unit = Buffer.from(spec.hex, 'hex');
    return Buffer.concat(Array.from({ length: Number(spec.repeat ?? 1) }, () => unit));
  }
  if (typeof spec.nestedArrays === 'number') {
    return Buffer.from(`${'['.repeat(spec.nestedArrays)}${']'.repeat(spec.nestedArrays)}\n`);
  }
  if (spec.prettyPrinted)
    return Buffer.from(`${JSON.stringify(sortKeysDeep(manifest), null, 2)}\n`);
  if (spec.unsortedKeys) {
    const { kind, ...rest } = manifest;
    return Buffer.from(`${JSON.stringify({ kind, ...rest })}\n`);
  }
  if (spec.noTrailingLf) return Buffer.from(canonicalText(manifest), 'utf8');
  if (spec.bom) return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonicalFile]);
  if (Array.isArray(spec.replace)) {
    const [from, to] = spec.replace as [string, string | { hex: string }];
    const needle = Buffer.from(from, 'utf8');
    const replacement =
      typeof to === 'string' ? Buffer.from(to, 'utf8') : Buffer.from(to.hex, 'hex');
    const at = canonicalFile.indexOf(needle);
    if (at < 0) throw new Error(`manifestBytes.replace: ${from} not found`);
    return Buffer.concat([
      canonicalFile.subarray(0, at),
      replacement,
      canonicalFile.subarray(at + needle.length),
    ]);
  }
  throw new Error(`unknown manifestBytes rule ${Object.keys(spec).join(',')}`);
}

// ─── case construction ─────────────────────────────────────────────────────────────────────────

export function buildCase(expectations: Expectations, construction: Construction): BuiltCase {
  if (construction.rawBytes) {
    const unit = Buffer.from(construction.rawBytes.hex, 'hex');
    const repeat = construction.rawBytes.repeat ?? 1;
    return {
      bytes: Buffer.concat(Array.from({ length: repeat }, () => unit)),
      manifestBytes: null,
    };
  }
  const base = expectations.bases[construction.base ?? 'application'];
  const files = new Map<string, Buffer>();
  for (const [name, f] of Object.entries(base.files)) files.set(name, Buffer.from(f.utf8, 'utf8'));
  for (const change of construction.files ?? []) {
    if (change.op === 'add') {
      files.set(
        change.name,
        change.utf8 !== undefined
          ? Buffer.from(change.utf8, 'utf8')
          : Buffer.from(change.hex!, 'hex'),
      );
    } else {
      files.delete(change.name);
    }
  }
  let manifest = structuredClone(base.manifest);
  if ((construction.inventory ?? 'recompute') === 'recompute') {
    const undeclared = new Set(construction.undeclared ?? []);
    manifest.inventory = inventoryOf(new Map([...files].filter(([name]) => !undeclared.has(name))));
  }
  manifest = patch(manifest, construction.manifestPatch ?? []) as Record<string, unknown>;
  const manifestBytes = manifestBytesFor(manifest, construction.manifestBytes);

  const data = new Map(files);
  data.set('ray.json', manifestBytes);
  const byName = (a: Entry, b: Entry) => Buffer.compare(a.name, b.name);
  const entries = [...data.keys()]
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((name) => entry(name, data.get(name)!));
  const find = (name: string): Entry => {
    const e = entries.find((x) => x.name.equals(Buffer.from(name)));
    if (!e) throw new Error(`no entry ${name}`);
    return e;
  };
  const layout: Layout = {
    prefix: Buffer.alloc(0),
    suffix: Buffer.alloc(0),
    end: {},
    zip64: false,
  };
  for (const op of construction.archive ?? [])
    applyArchiveOperation(op, entries, find, byName, layout);
  return { bytes: serialize(entries, layout), manifestBytes };
}

function applyArchiveOperation(
  op: ArchiveOperation,
  entries: Entry[],
  find: (name: string) => Entry,
  byName: (a: Entry, b: Entry) => number,
  layout: Layout,
): void {
  switch (op.op) {
    case 'set': {
      const e = find(op.entry as string);
      const value = typeof op.hex === 'string' ? Buffer.from(op.hex, 'hex') : (op.value as number);
      const field = op.field as keyof LocalOverrides & keyof Entry;
      const where = (op.where as string | undefined) ?? 'both';
      if (where === 'both' || where === 'central')
        (e as unknown as Record<string, unknown>)[field] = value;
      if (where === 'both' || where === 'local')
        (e.local as Record<string, unknown>)[field] = value;
      return;
    }
    case 'addRawEntry': {
      const name =
        typeof op.nameHex === 'string'
          ? Buffer.from(op.nameHex, 'hex')
          : Buffer.from(op.name as string, 'utf8');
      entries.push(entry(name, Buffer.from(op.utf8 as string, 'utf8')));
      entries.sort(byName);
      return;
    }
    case 'duplicate': {
      const e = find(op.entry as string);
      entries.splice(entries.indexOf(e) + 1, 0, { ...e, local: {} });
      return;
    }
    case 'move': {
      const e = find(op.entry as string);
      entries.splice(entries.indexOf(e), 1);
      entries.splice(op.to as number, 0, e);
      return;
    }
    case 'centralOffsetOf':
      find(op.entry as string).offsetOf = op.sameAs as string;
      return;
    case 'localName':
      find(op.entry as string).local.name = Buffer.from(op.name as string, 'utf8');
      return;
    case 'prepend':
      layout.prefix = Buffer.from(op.hex as string, 'hex');
      return;
    case 'append':
      layout.suffix = typeof op.hex === 'string' ? Buffer.from(op.hex, 'hex') : SECOND_ARCHIVE;
      return;
    case 'eocd': {
      const fields = op.fields as Record<string, string | number>;
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'comment') layout.end.comment = Buffer.from(String(v), 'utf8');
        else if (k === 'disk') layout.end.disk = Number(v);
        else throw new Error(`unknown end-record field ${k}`);
      }
      return;
    }
    case 'zip64Record':
      layout.zip64 = true;
      return;
    case 'deflate': {
      const e = find(op.entry as string);
      e.method = 8;
      e.needed = 20;
      return;
    }
    case 'emptyFiles':
      for (let i = 0; i < (op.count as number); i++) {
        entries.push(entry(`payload/f/${String(i).padStart(5, '0')}`, Buffer.alloc(0)));
      }
      entries.sort(byName);
      return;
    default:
      throw new Error(`unknown archive operation ${op.op}`);
  }
}

// ─── test signers ──────────────────────────────────────────────────────────────────────────────

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The Ed25519 key of a test signer: its 32-byte seed is SHA-256 of the public seed text. */
export function testSignerKey(seedText: string) {
  const seed = createHash('sha256').update(seedText).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const publicKeySha256 = sha256Hex(publicKey.export({ format: 'der', type: 'spki' }));
  return { privateKey, publicKey, publicKeySha256 };
}

/** The signed message of a `.ray` signature. */
export function raySignatureMessage(archiveSha256: string): Buffer {
  return Buffer.from(`rayspec-ray-v1\nsha256:${archiveSha256}\n`, 'ascii');
}

/** The detached signature document of a signature case, before canonical serialization. */
export function buildSignatureDocument(
  construction: SignatureConstruction,
  archive: Buffer,
  builtById: (id: string) => Buffer,
): Record<string, unknown> {
  const signed = construction.over === 'this-archive' ? archive : builtById(construction.over);
  const archiveSha256 = sha256Hex(signed);
  const signer = testSignerKey(construction.signerSeed);
  const signature = sign(null, raySignatureMessage(archiveSha256), signer.privateKey);
  if (construction.flipFirstByte) signature[0] = signature[0]! ^ 0x01;
  return {
    signatureFormatVersion: 1,
    algorithm: 'ed25519',
    archiveSha256,
    publicKeySha256: signer.publicKeySha256,
    signature: signature.toString('base64'),
  };
}

/** The file name a case's bytes are committed under in `corpus/`. */
export function caseFileName(c: CorpusCase): string {
  return `${c.id}${c.construction.rawBytes ? '.bin' : '.ray'}`;
}

/** Every file of the corpus: name to bytes, cases first and their signature files after. */
export function buildCorpus(expectations: Expectations): Map<string, Buffer> {
  const built = new Map<string, Buffer>();
  for (const c of expectations.cases)
    built.set(c.id, buildCase(expectations, c.construction).bytes);
  const files = new Map<string, Buffer>();
  for (const c of expectations.cases) {
    const bytes = built.get(c.id)!;
    if (c.bytes.committed) files.set(caseFileName(c), bytes);
    if (c.construction.signature) {
      const doc = buildSignatureDocument(c.construction.signature, bytes, (id) => {
        const other = built.get(id);
        if (!other) throw new Error(`signature over unknown case ${id}`);
        return other;
      });
      files.set(`${caseFileName(c)}.sig`, Buffer.from(canonicalJsonFile(doc), 'utf8'));
    }
  }
  return files;
}
