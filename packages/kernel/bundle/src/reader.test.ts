/**
 * Reader behavior the corpus does not reach on its own: container forms beyond the corpus cases,
 * an archive that changes while it is read, the extraction directory rules, secret findings,
 * signature presence, and hostile arguments.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import type { BundleError } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { extractBundle, inspectBundle } from './index.js';
import { checkNameSet } from './names.js';
import { loadExpectations } from './test-support/contract.js';
import { baseFiles, bundleEntries, type RawEntry, rawZip } from './test-support/raw-zip.js';

const expectations = loadExpectations();
/** Five dashes for a PEM header built at run time, so this file holds no header the secret scan reports. */
const D = '-'.repeat(5);
const entries = () => bundleEntries(expectations);
const base = rawZip(entries());

const outcome = (r: { ok: true } | { ok: false; errors: BundleError[] }) =>
  r.ok ? 'ok' : `${r.errors[0]!.code}/${r.errors[0]!.reason ?? ''}`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-bundle-reader-'));
  dirs.push(dir);
  return dir;
}

/** Offsets of the local headers of `raw`, in order. */
function localOffsets(bytes: Buffer): number[] {
  const out: number[] = [];
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    out.push(at);
    at += 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt32LE(at + 18);
  }
  return out;
}

describe('container forms', () => {
  it('a ZIP64 sentinel in a central record is zip64', async () => {
    const e = entries();
    e[0]!.central = { csize: 0xffffffff, usize: 0xffffffff };
    expect(outcome(await inspectBundle(rawZip(e)))).toBe('RAY_INVALID_ARCHIVE/zip64');
  });

  it('a 0xFFFF entry total in the end record is zip64', async () => {
    const e = entries();
    expect(
      outcome(await inspectBundle(rawZip(e, { end: { onThisDisk: 0xffff, total: 0xffff } }))),
    ).toBe('RAY_INVALID_ARCHIVE/zip64');
  });

  it('entries on this disk different from the total is multi-disk', async () => {
    expect(outcome(await inspectBundle(rawZip(entries(), { end: { onThisDisk: 1 } })))).toBe(
      'RAY_INVALID_ARCHIVE/multi-disk',
    );
  });

  it('a directory type in the attributes is a directory entry, whatever the name', async () => {
    const e = entries();
    e[0]!.central = { external: 0x41ed0000 };
    expect(outcome(await inspectBundle(rawZip(e)))).toBe('RAY_INVALID_ARCHIVE/directory-entry');
  });

  it('an attribute word without a Unix file type is a special file', async () => {
    const e = entries();
    e[0]!.central = { external: 0x00000020 };
    expect(outcome(await inspectBundle(rawZip(e)))).toBe('RAY_INVALID_ARCHIVE/special-file');
  });

  it('a version-made-by other than Unix 2.0, or internal attributes, are non-canonical', async () => {
    const e = entries();
    e[1]!.central = { madeBy: 0x0014 };
    expect(outcome(await inspectBundle(rawZip(e)))).toBe('RAY_INVALID_ARCHIVE/non-canonical-mode');
    const f = entries();
    f[1]!.central = { internal: 1 };
    expect(outcome(await inspectBundle(rawZip(f)))).toBe('RAY_INVALID_ARCHIVE/non-canonical-mode');
  });

  it('a record signature that is wrong, or a directory with bytes after its records, is a mismatch', async () => {
    const e = entries();
    e[2]!.central = { signature: 0x02014b51 };
    expect(outcome(await inspectBundle(rawZip(e)))).toBe(
      'RAY_INVALID_ARCHIVE/header-directory-mismatch',
    );
    // One record fewer announced than present: the directory holds more than it announces.
    const n = entries().length;
    expect(
      outcome(await inspectBundle(rawZip(entries(), { end: { onThisDisk: n - 1, total: n - 1 } }))),
    ).toBe('RAY_INVALID_ARCHIVE/header-directory-mismatch');
  });

  it('a gap between entries is a mismatch, and bytes before the first header are leading data', async () => {
    const e = entries();
    const offsets = localOffsets(base);
    // The second record points one byte past where the first entry ends.
    e[1]!.central = { offset: offsets[1]! + 1 };
    expect(outcome(await inspectBundle(rawZip(e)))).toBe(
      'RAY_INVALID_ARCHIVE/header-directory-mismatch',
    );
    const f = entries();
    f[0]!.central = { offset: 1 };
    f[1]!.central = { offset: 0 };
    // The first central record decides: another entry's header at 0 does not make up for it.
    expect(outcome(await inspectBundle(rawZip(f)))).toBe('RAY_INVALID_ARCHIVE/leading-data');
  });

  it('the offsets of every entry are checked before any local header', async () => {
    const e = entries();
    const offsets = localOffsets(base);
    // The first local header differs from its record, and the second entry overlaps the first.
    e[0]!.local = { time: 1 };
    e[1]!.central = { offset: offsets[1]! - 1 };
    expect(outcome(await inspectBundle(rawZip(e)))).toBe('RAY_INVALID_ARCHIVE/overlapping-entries');
  });

  it('a ray.json whose CRC-32 is wrong in both headers is a CRC mismatch', async () => {
    // Stricter than the letter of the inventory step, which lists CRC-32 for inventory entries:
    // a manifest whose stored CRC-32 is wrong is refused like any other entry.
    const e = entries();
    const manifest = e.at(-1)!;
    const wrong = (crc32(Buffer.from(manifest.data as string)) ^ 1) >>> 0;
    manifest.central = { crc: wrong };
    manifest.local = { crc: wrong };
    expect(outcome(await inspectBundle(rawZip(e)))).toBe('RAY_INVALID_ARCHIVE/crc-mismatch');
  });

  it('a local header whose flags differ from its central record is a mismatch', async () => {
    const e = entries();
    e[0]!.local = { flags: 0x800 };
    expect(outcome(await inspectBundle(rawZip(e)))).toBe(
      'RAY_INVALID_ARCHIVE/header-directory-mismatch',
    );
  });

  it('the local headers are compared before the manifest is read', async () => {
    const e = entries();
    e[0]!.local = { time: 1 };
    e[e.length - 1]!.data = 'not json';
    expect(outcome(await inspectBundle(rawZip(e)))).toBe(
      'RAY_INVALID_ARCHIVE/header-directory-mismatch',
    );
  });

  it('an end-record signature inside the last 21 bytes is not taken for the end record', async () => {
    const tail = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
    expect(outcome(await inspectBundle(Buffer.concat([base, tail])))).toBe(
      'RAY_INVALID_ARCHIVE/trailing-data',
    );
  });

  it('names equal after NFC are a normalization collision', () => {
    // Unreachable through an archive, where the ASCII rule fires first; the set rule stands alone.
    expect(checkNameSet(['payload/café', 'payload/café'])).toBe('normalization-collision');
  });

  it('an entry size larger than the whole file is refused without reading past it', async () => {
    const huge = { csize: 0x7fffffff, usize: 0x7fffffff };
    const e = entries();
    e[0]!.central = huge;
    e[0]!.local = huge;
    // The next local header starts inside the bytes the first entry claims.
    expect(outcome(await inspectBundle(rawZip(e)))).toBe('RAY_INVALID_ARCHIVE/overlapping-entries');
    const f = entries();
    f[f.length - 1]!.central = huge;
    f[f.length - 1]!.local = huge;
    // The last entry claims bytes past the start of the central directory.
    expect(outcome(await inspectBundle(rawZip(f)))).toBe(
      'RAY_INVALID_ARCHIVE/header-directory-mismatch',
    );
  });
});

describe('an archive that changes while it is read', () => {
  /**
   * Write the base archive to a file and change it from inside the clock, at the reading the read
   * reaches once the directory and the manifest have been checked.
   */
  async function readWhileChanging(change: (fd: number) => void, fromEnd = 1) {
    const dir = workDir();
    const path = join(dir, 'app.ray');
    writeFileSync(path, base);
    let readings = 0;
    await inspectBundle(path, {
      clock: () => {
        readings++;
        return 0;
      },
    });
    const at = readings - fromEnd;
    let n = 0;
    return inspectBundle(path, {
      clock: () => {
        if (n++ === at) {
          const fd = openSync(path, 'r+');
          try {
            change(fd);
          } finally {
            closeSync(fd);
          }
        }
        return 0;
      },
    });
  }

  it('a changed central directory is refused', async () => {
    const directoryAt = base.readUInt32LE(base.length - 6);
    const r = await readWhileChanging((fd) =>
      writeSync(fd, Buffer.from([0x15]), 0, 1, directoryAt + 4),
    );
    expect(outcome(r)).toBe('RAY_INVALID_ARCHIVE/header-directory-mismatch');
    expect(!r.ok && r.errors[0]!.message).toBe('the archive changed while it was read');
  });

  it('a manifest changed after it was parsed is refused, even with the same CRC-32', async () => {
    const manifest = entries().at(-1)!.data as string;
    const manifestBytes = Buffer.from(manifest, 'utf8');
    const variant = sameCrcVariant(manifestBytes);
    expect(variant.equals(manifestBytes)).toBe(false);
    expect(crc32(variant)).toBe(crc32(manifestBytes));
    const manifestAt = base.readUInt32LE(base.length - 6) - manifestBytes.length;
    // The second reading from the end is the one before the manifest entry is streamed.
    const r = await readWhileChanging(
      (fd) => writeSync(fd, variant, 0, variant.length, manifestAt),
      2,
    );
    expect(outcome(r)).toBe('RAY_INVALID_ARCHIVE/header-directory-mismatch');
    expect(!r.ok && r.errors[0]!.message).toBe('the archive changed while it was read');
  });

  it('bytes given to the reader are copied, so changing them during the read changes nothing', async () => {
    const bytes = Buffer.from(base);
    const baseSha256 = createHash('sha256').update(base).digest('hex');
    const reading = inspectBundle(bytes);
    // The first byte of the first entry's data: the reader would see a CRC mismatch.
    bytes[localOffsets(base)[0]! + 30 + Buffer.byteLength(entries()[0]!.name as string)]! ^= 0xff;
    const r = await reading;
    expect(outcome(r)).toBe('ok');
    expect(r.ok && r.value.archiveSha256).toBe(baseSha256);
  });

  it('bytes appended while reading are refused', async () => {
    const r = await readWhileChanging((fd) =>
      writeSync(fd, Buffer.from('tail'), 0, 4, base.length),
    );
    expect(outcome(r)).toBe('RAY_INVALID_ARCHIVE/header-directory-mismatch');
    expect(!r.ok && r.errors[0]!.message).toBe('the archive changed while it was read');
  });
});

describe('a change at any point of the read', () => {
  /** Offsets to change: a local header, payload data, the manifest data, the central directory. */
  const firstHeader = 6;
  const payloadData = 30 + Buffer.byteLength(entries()[0]!.name as string);
  const manifestData = base.length - 22 - 1;
  const directory = base.readUInt32LE(base.length - 6);

  const baseSha256 = createHash('sha256').update(base).digest('hex');

  // A byte changed after the reader has consumed it cannot be seen without reading it again; the
  // property is that an accepted read reports the identity of exactly the bytes it validated.
  it.each([
    ['a local header', firstHeader],
    ['payload data', payloadData],
    ['the central directory', directory + 8],
    ['the end record', manifestData + 10],
  ])('a change to %s at any reading is refused or never reaches the result', async (_l, offset) => {
    const dir = workDir();
    const path = join(dir, 'app.ray');
    writeFileSync(path, base);
    let readings = 0;
    await inspectBundle(path, {
      clock: () => {
        readings++;
        return 0;
      },
    });
    for (let at = 0; at < readings; at++) {
      writeFileSync(path, base);
      let n = 0;
      const r = await inspectBundle(path, {
        clock: () => {
          if (n++ === at) {
            const fd = openSync(path, 'r+');
            writeSync(fd, Buffer.from([base[offset]! ^ 0x01]), 0, 1, offset);
            closeSync(fd);
          }
          return 0;
        },
      });
      if (r.ok) expect(r.value.archiveSha256, `changed at reading ${at}`).toBe(baseSha256);
    }
  });
});

/**
 * `data` with its first four bytes changed and the next four chosen so the CRC-32 stays the same.
 * CRC-32 is affine over XOR: flipping a set of bits changes the CRC by the XOR of what flipping each
 * bit alone does, so the bits to flip in bytes 4 to 7 are the solution of a 32 by 32 system over
 * GF(2).
 */
function sameCrcVariant(data: Buffer): Buffer {
  const target = crc32(data);
  const out = Buffer.from(data);
  for (let i = 0; i < 4; i++) out[i]! ^= 0x20;
  const start = crc32(out);
  const pivots = new Map<number, { vector: number; bits: number }>();
  for (let bit = 0; bit < 32; bit++) {
    const flipped = Buffer.from(out);
    flipped[4 + (bit >> 3)]! ^= 1 << (bit & 7);
    let vector = (crc32(flipped) ^ start) >>> 0;
    let bits = (1 << bit) >>> 0;
    while (vector !== 0) {
      const top = 31 - Math.clz32(vector);
      const pivot = pivots.get(top);
      if (pivot === undefined) {
        pivots.set(top, { vector, bits });
        break;
      }
      vector = (vector ^ pivot.vector) >>> 0;
      bits = (bits ^ pivot.bits) >>> 0;
    }
  }
  let want = (start ^ target) >>> 0;
  let bits = 0;
  while (want !== 0) {
    const pivot = pivots.get(31 - Math.clz32(want))!;
    want = (want ^ pivot.vector) >>> 0;
    bits = (bits ^ pivot.bits) >>> 0;
  }
  for (let bit = 0; bit < 32; bit++) {
    if ((bits >>> bit) & 1) out[4 + (bit >> 3)]! ^= 1 << (bit & 7);
  }
  return out;
}

describe('the archive path', () => {
  it('refuses a FIFO at once instead of waiting for a writer', { timeout: 5000 }, async () => {
    const fifo = join(workDir(), 'pipe.ray');
    execFileSync('mkfifo', [fifo]);
    const r = await inspectBundle(fifo);
    expect(outcome(r)).toBe('RAY_USAGE/');
    expect(!r.ok && r.errors[0]!.message).toBe('the archive is not a regular file');
  });

  it('refuses a directory', async () => {
    expect(outcome(await inspectBundle(workDir()))).toBe('RAY_USAGE/');
  });
});

describe('extraction directory', () => {
  it('refuses a destination that exists, and leaves it as it was', async () => {
    const dir = workDir();
    const root = join(dir, 'out');
    mkdirSync(root);
    writeFileSync(join(root, 'keep'), 'mine');
    expect(outcome(await extractBundle(base, root))).toBe('RAY_OUTPUT_EXISTS/');
    expect(readdirSync(root)).toEqual(['keep']);
  });

  it('refuses a destination that is a symbolic link, and never writes through it', async () => {
    const dir = workDir();
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, 'out'));
    expect(outcome(await extractBundle(base, join(dir, 'out')))).toBe('RAY_OUTPUT_EXISTS/');
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a destination whose parent does not exist', async () => {
    expect(outcome(await extractBundle(base, join(workDir(), 'no', 'out')))).toBe('RAY_USAGE/');
  });

  it('creates nothing when the archive fails before its entries are read', async () => {
    const dir = workDir();
    const r = await extractBundle(
      Buffer.from('not a zip at all, not even close'),
      join(dir, 'out'),
    );
    expect(outcome(r)).toBe('RAY_INVALID_ARCHIVE/not-a-zip');
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('findings and presence', () => {
  it('reports secret paths and private-key content without failing inspection', async () => {
    const files = baseFiles(expectations);
    files.set('payload/config/.env.production', Buffer.from('A=1\n'));
    files.set(
      'payload/keys/deploy.pem',
      Buffer.from(`${D}BEGIN OPENSSH PRIVATE KEY${D}\nAAAA\n${D}END OPENSSH PRIVATE KEY${D}\n`),
    );
    const r = await inspectBundle(rawZip(bundleEntries(expectations, { files })));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.secretFindings).toEqual([
        { path: 'payload/config/.env.production', rule: 'secret-path' },
        { path: 'payload/keys/deploy.pem', rule: 'private-key' },
      ]);
      expect(JSON.stringify(r.value.secretFindings)).not.toContain('AAAA');
    }
  });

  it('a secret file name that also holds a private key is one finding, by its name', async () => {
    const files = baseFiles(expectations);
    files.set('payload/.env', Buffer.from(`${D}BEGIN RSA PRIVATE KEY${D}\nAAAA\n`));
    const r = await inspectBundle(rawZip(bundleEntries(expectations, { files })));
    expect(r.ok && r.value.secretFindings).toEqual([{ path: 'payload/.env', rule: 'secret-path' }]);
  });

  it('keeps the spec bytes only when asked, and counts the entries', async () => {
    const spec = Buffer.from(expectations.bases.application.files['payload/rayspec.yaml']!.utf8);
    const asked = await inspectBundle(base, { captureSpec: true });
    const plain = await inspectBundle(base);
    expect(asked.ok && asked.value.specBytes?.equals(spec)).toBe(true);
    expect(plain.ok && 'specBytes' in plain.value).toBe(false);
    expect(asked.ok && asked.value.entryCount).toBe(entries().length);
  });

  it('keeps nothing of a migration bundle, whose one file is ciphertext', async () => {
    const migration = rawZip(bundleEntries(expectations, { kind: 'migration' }));
    const r = await inspectBundle(migration, { captureSpec: true });
    expect(r.ok).toBe(true);
    expect(r.ok && 'specBytes' in r.value).toBe(false);
  });

  it('refuses a spec whose bytes do not match the inventory instead of handing them over', async () => {
    const files = baseFiles(expectations);
    const forged = rawZip(
      bundleEntries(expectations, { files }).map((e) =>
        e.name === 'payload/rayspec.yaml' ? { ...e, data: Buffer.from(e.data).fill(0x20) } : e,
      ),
    );
    const r = await inspectBundle(forged, { captureSpec: true });
    expect(outcome(r)).toBe('RAY_DIGEST_MISMATCH/entry-sha256');
  });

  it('refuses a captureSpec that is not a boolean', async () => {
    const r = await inspectBundle(base, { captureSpec: 'yes' as never });
    expect(outcome(r)).toBe('RAY_USAGE/');
  });

  it('reports whether a signature file lies next to the archive', async () => {
    const dir = workDir();
    const path = join(dir, 'app.ray');
    writeFileSync(path, base);
    const absent = await inspectBundle(path);
    writeFileSync(`${path}.sig`, '{}');
    const present = await inspectBundle(path);
    const bytes = await inspectBundle(base);
    expect([absent, present, bytes].map((r) => r.ok && r.value.signatureFile)).toEqual([
      'absent',
      'present',
      'unknown',
    ]);
  });
});

describe('hostile arguments', () => {
  it('answers anything it is given without throwing', async () => {
    const dir = workDir();
    const cases: [string, unknown, unknown, string][] = [
      ['a number', 123, {}, 'RAY_USAGE/'],
      ['null', null, {}, 'RAY_USAGE/'],
      ['null options', base, null, 'ok'],
      ['null limits', base, { limits: null }, 'RAY_USAGE/'],
      ['a text limit', base, { limits: { archiveBytes: '1' } }, 'RAY_USAGE/'],
      ['a text clock', base, { clock: 'now' }, 'RAY_USAGE/'],
      ['a missing file', join(dir, 'missing.ray'), {}, 'RAY_USAGE/'],
      ['a directory', dir, {}, 'RAY_USAGE/'],
    ];
    for (const [label, archive, options, want] of cases) {
      expect(outcome(await inspectBundle(archive as never, options as never)), label).toBe(want);
    }
    expect(outcome(await extractBundle(base, 42 as never))).toBe('RAY_USAGE/');
  });

  it('keeps a hostile name out of every field of the answer', async () => {
    const e: RawEntry[] = [...entries(), { name: 'payload/\x1b]0;owned\x07‮SECRET', data: 'x' }];
    e.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const r = await inspectBundle(rawZip(e));
    expect(outcome(r)).toBe('RAY_INVALID_ARCHIVE/non-ascii-name');
    expect(JSON.stringify(r)).not.toMatch(/SECRET|owned/);
  });
});
