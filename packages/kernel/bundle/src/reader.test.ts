/**
 * Reader behavior the corpus does not reach on its own: container forms beyond the corpus cases,
 * an archive that changes while it is read, the extraction directory rules, secret findings,
 * signature presence, and hostile arguments.
 */

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
import type { BundleError } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { extractBundle, inspectBundle } from './index.js';
import { checkNameSet } from './names.js';
import { loadExpectations } from './test-support/contract.js';
import { baseFiles, bundleEntries, type RawEntry, rawZip } from './test-support/raw-zip.js';

const expectations = loadExpectations();
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
    // Swapped offsets: a local header does sit at 0, so this is not leading data.
    expect(outcome(await inspectBundle(rawZip(f)))).toBe(
      'RAY_INVALID_ARCHIVE/header-directory-mismatch',
    );
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
  async function readWhileChanging(change: (fd: number) => void) {
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
    const at = readings - 1;
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
      Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n'),
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
