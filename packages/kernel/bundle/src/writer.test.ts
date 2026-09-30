/**
 * The writer: identical input gives identical bytes wherever it is written, no path or time leaks
 * into the archive, the reader accepts what the writer writes, and the output appears atomically
 * and never over an existing file unless that is asked for.
 */
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BundleError, canonicalJsonFile, type RayManifest } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type BundleFile,
  type BundleManifestInput,
  inspectBundle,
  verifySignatureFile,
  writeBundle,
} from './index.js';
import { CONTRACT_PACKAGE_ROOT, loadExpectations } from './test-support/contract.js';
import { baseFiles, bundleEntries } from './test-support/raw-zip.js';

const expectations = loadExpectations();
const baseManifest = expectations.bases.application.manifest as unknown as RayManifest;
const manifestInput = (): BundleManifestInput => {
  const { inventory: _drop, ...rest } = structuredClone(baseManifest);
  return rest;
};
const byteFiles = (): BundleFile[] =>
  [...baseFiles(expectations)].map(([path, bytes]) => ({ path, bytes }));

const outcome = (r: { ok: true } | { ok: false; errors: BundleError[] }) =>
  r.ok ? 'ok' : `${r.errors[0]!.code}/${r.errors[0]!.reason ?? ''}`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-bundle-writer-'));
  dirs.push(dir);
  return dir;
}

describe('determinism', () => {
  it('the same input written twice in different directories gives the same bytes', async () => {
    const a = join(workDir(), 'app.ray');
    const b = join(workDir(), 'nested', 'deeper', 'other-name.ray');
    mkdirSync(join(b, '..'), { recursive: true });
    const first = await writeBundle(a, { manifest: manifestInput(), files: byteFiles() });
    // Reversed input order, and the second copy read from files on disk.
    const src = workDir();
    const fromDisk: BundleFile[] = [...baseFiles(expectations)].reverse().map(([path, bytes]) => {
      const file = join(src, path.replaceAll('/', '_'));
      writeFileSync(file, bytes);
      return { path, file };
    });
    const second = await writeBundle(b, { manifest: manifestInput(), files: fromDisk });
    expect(outcome(first)).toBe('ok');
    expect(outcome(second)).toBe('ok');
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
    if (first.ok && second.ok) expect(first.value.archiveSha256).toBe(second.value.archiveSha256);
  });

  it('reproduces the contract fixture byte for byte from its files and manifest', async () => {
    const out = join(workDir(), 'app.ray');
    const r = await writeBundle(out, { manifest: manifestInput(), files: byteFiles() });
    expect(outcome(r)).toBe('ok');
    const fixture = join(CONTRACT_PACKAGE_ROOT, 'contract', 'fixtures', 'inspect-only.ray');
    expect(readFileSync(out).equals(readFileSync(fixture))).toBe(true);
  });

  it('no absolute path, directory name or timestamp reaches the archive', async () => {
    const dir = workDir();
    const out = join(dir, 'app.ray');
    await writeBundle(out, { manifest: manifestInput(), files: byteFiles() });
    const bytes = readFileSync(out);
    for (const leak of [dir, tmpdir(), 'rayspec-bundle-writer', process.cwd()]) {
      expect(bytes.includes(Buffer.from(leak))).toBe(false);
    }
    // Every header carries DOS time 0 and date 1980-01-01, whatever the clock says.
    let local = 0;
    for (let i = bytes.indexOf(0x50); i >= 0; i = bytes.indexOf(0x50, i + 1)) {
      if (bytes.readUInt32LE(i) === 0x04034b50) {
        expect([bytes.readUInt16LE(i + 10), bytes.readUInt16LE(i + 12)]).toEqual([0, 0x21]);
        local++;
      }
    }
    expect(local).toBe(bundleEntries(expectations).length);
  });
});

describe('round trip', () => {
  it('the reader accepts what the writer writes, with the manifest and identity it reports', async () => {
    const out = join(workDir(), 'app.ray');
    const w = await writeBundle(out, { manifest: manifestInput(), files: byteFiles() });
    const r = await inspectBundle(out);
    expect(outcome(w)).toBe('ok');
    expect(outcome(r)).toBe('ok');
    if (w.ok && r.ok) {
      expect(r.value.archiveSha256).toBe(w.value.archiveSha256);
      expect(r.value.archiveSize).toBe(w.value.archiveSize);
      expect(canonicalJsonFile(r.value.manifest)).toBe(canonicalJsonFile(w.value.manifest));
    }
  });

  it('writes a migration bundle the reader accepts', async () => {
    const { inventory: _drop, ...manifest } = structuredClone(
      expectations.bases.migration.manifest,
    ) as unknown as RayManifest;
    const files = [...baseFiles(expectations, 'migration')].map(([path, bytes]) => ({
      path,
      bytes,
    }));
    const out = join(workDir(), 'm.ray');
    expect(outcome(await writeBundle(out, { manifest, files }))).toBe('ok');
    expect(outcome(await inspectBundle(out))).toBe('ok');
  });

  it('accepts a given inventory equal to the computed one, and refuses a different one', async () => {
    const dir = workDir();
    const good = await writeBundle(join(dir, 'a.ray'), {
      manifest: structuredClone(baseManifest),
      files: byteFiles(),
    });
    expect(outcome(good)).toBe('ok');
    const forged = structuredClone(baseManifest);
    forged.inventory[0]!.size += 1;
    const bad = await writeBundle(join(dir, 'b.ray'), { manifest: forged, files: byteFiles() });
    expect(outcome(bad)).toBe('RAY_USAGE/');
    expect(readdirSync(dir)).toEqual(['a.ray']);
  });
});

describe('refusals', () => {
  it('refuses an invalid manifest with its validator code and writes nothing', async () => {
    const dir = workDir();
    const manifest = { ...manifestInput(), requires: ['Not A Capability'] } as BundleManifestInput;
    const r = await writeBundle(join(dir, 'app.ray'), { manifest, files: byteFiles() });
    expect(outcome(r)).toBe('RAY_MANIFEST_INVALID/schema');
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['ray.json', 'outside-payload'],
    ['payload/../x', 'dot-segment'],
    ['/payload/x', 'absolute-path'],
    ['payload\\x', 'backslash'],
    ['payload/é', 'non-ascii-name'],
    ['payload//x', 'empty-segment'],
  ])('refuses the file path %s (%s)', async (path, reason) => {
    const dir = workDir();
    const files = [...byteFiles(), { path, bytes: Buffer.from('x') }];
    const r = await writeBundle(join(dir, 'app.ray'), { manifest: manifestInput(), files });
    expect(outcome(r)).toBe('RAY_USAGE/');
    if (!r.ok) expect(r.errors[0]!.message).toContain(reason);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses paths that clash by case or as file and directory', async () => {
    for (const extra of ['payload/RAYSPEC.yaml', 'payload/rayspec.yaml/x']) {
      const files = [...byteFiles(), { path: extra, bytes: Buffer.from('x') }];
      const r = await writeBundle(join(workDir(), 'app.ray'), { manifest: manifestInput(), files });
      expect(outcome(r)).toBe('RAY_USAGE/');
    }
  });

  it('refuses a source file that is a symbolic link, and never follows it', async () => {
    const dir = workDir();
    const target = join(dir, 'target');
    writeFileSync(target, 'secret');
    symlinkSync(target, join(dir, 'link'));
    const files = [...byteFiles(), { path: 'payload/x', file: join(dir, 'link') }];
    const r = await writeBundle(join(dir, 'app.ray'), { manifest: manifestInput(), files });
    expect(outcome(r)).toBe('RAY_USAGE/');
    expect(readdirSync(dir).sort()).toEqual(['link', 'target']);
  });

  it('refuses when the archive would exceed the kind limit, before writing', async () => {
    const dir = workDir();
    const r = await writeBundle(
      join(dir, 'app.ray'),
      { manifest: manifestInput(), files: byteFiles() },
      { limits: { archiveBytes: 100 } },
    );
    expect(outcome(r)).toBe('RAY_LIMIT_EXCEEDED/archive-size');
    const { inventory: _drop, ...migration } = structuredClone(
      expectations.bases.migration.manifest,
    ) as unknown as RayManifest;
    const m = await writeBundle(
      join(dir, 'm.ray'),
      {
        manifest: migration,
        files: [...baseFiles(expectations, 'migration')].map(([path, bytes]) => ({ path, bytes })),
      },
      { limits: { migrationArchiveBytes: 100 } },
    );
    expect(outcome(m)).toBe('RAY_LIMIT_EXCEEDED/migration-size');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses payload files that add up past the extracted byte limit, before writing', async () => {
    const dir = workDir();
    const r = await writeBundle(
      join(dir, 'app.ray'),
      { manifest: manifestInput(), files: byteFiles() },
      { limits: { extractedBytes: 100 } },
    );
    expect(outcome(r)).toBe('RAY_LIMIT_EXCEEDED/extracted-size');
    const { inventory: _drop, ...migration } = structuredClone(
      expectations.bases.migration.manifest,
    ) as unknown as RayManifest;
    const m = await writeBundle(
      join(dir, 'm.ray'),
      {
        manifest: migration,
        files: [...baseFiles(expectations, 'migration')].map(([path, bytes]) => ({ path, bytes })),
      },
      { limits: { migrationExtractedBytes: 1 } },
    );
    expect(outcome(m)).toBe('RAY_LIMIT_EXCEEDED/extracted-size');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a raised limit and a key that is not an Ed25519 private key', async () => {
    const out = join(workDir(), 'app.ray');
    const input = { manifest: manifestInput(), files: byteFiles() };
    expect(outcome(await writeBundle(out, input, { limits: { entryCount: 10_001 } }))).toBe(
      'RAY_USAGE/',
    );
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    expect(outcome(await writeBundle(out, input, { signingKey: rsa }))).toBe('RAY_USAGE/');
    const ed = generateKeyPairSync('ed25519').publicKey;
    expect(outcome(await writeBundle(out, input, { signingKey: ed }))).toBe('RAY_USAGE/');
  });

  it('answers hostile arguments without throwing', async () => {
    const out = join(workDir(), 'app.ray');
    for (const input of [null, {}, { manifest: null, files: [] }, { manifest: {}, files: 'x' }]) {
      const r = await writeBundle(out, input as never);
      expect(r.ok).toBe(false);
    }
    expect(outcome(await writeBundle('' as never, { manifest: manifestInput(), files: [] }))).toBe(
      'RAY_USAGE/',
    );
  });
});

describe('placement', () => {
  it('refuses to overwrite unless told to, and overwrites atomically when told', async () => {
    const dir = workDir();
    const out = join(dir, 'app.ray');
    writeFileSync(out, 'existing');
    const input = { manifest: manifestInput(), files: byteFiles() };
    expect(outcome(await writeBundle(out, input))).toBe('RAY_OUTPUT_EXISTS/');
    expect(readFileSync(out, 'utf8')).toBe('existing');
    expect(outcome(await writeBundle(out, input, { overwrite: true }))).toBe('ok');
    expect(outcome(await inspectBundle(out))).toBe('ok');
    expect(readdirSync(dir)).toEqual(['app.ray']);
  });

  it('refuses a destination whose directory does not exist', async () => {
    const r = await writeBundle(join(workDir(), 'missing', 'app.ray'), {
      manifest: manifestInput(),
      files: byteFiles(),
    });
    expect(outcome(r)).toBe('RAY_USAGE/');
  });

  it('leaves no temporary file behind when placing fails', async () => {
    const dir = workDir();
    const out = join(dir, 'app.ray');
    chmodSync(dir, 0o500);
    try {
      const r = await writeBundle(out, { manifest: manifestInput(), files: byteFiles() });
      expect(r.ok).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('signing', () => {
  it('writes a detached signature that verifies with the signer key', async () => {
    const dir = workDir();
    const out = join(dir, 'app.ray');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const w = await writeBundle(
      out,
      { manifest: manifestInput(), files: byteFiles() },
      { signingKey: privateKey },
    );
    expect(outcome(w)).toBe('ok');
    if (!w.ok) return;
    expect(w.value.signaturePath).toBe(`${out}.sig`);
    expect(readdirSync(dir).sort()).toEqual(['app.ray', 'app.ray.sig']);
    const signature = readFileSync(`${out}.sig`);
    expect(outcome(verifySignatureFile(w.value.archiveSha256, signature, [publicKey]))).toBe('ok');
    const r = await inspectBundle(out);
    expect(r.ok && r.value.signatureFile).toBe('present');
  });

  it('refuses when a signature file already exists, and writes neither file', async () => {
    const dir = workDir();
    const out = join(dir, 'app.ray');
    writeFileSync(`${out}.sig`, 'existing');
    const { privateKey } = generateKeyPairSync('ed25519');
    const r = await writeBundle(
      out,
      { manifest: manifestInput(), files: byteFiles() },
      { signingKey: privateKey },
    );
    expect(outcome(r)).toBe('RAY_OUTPUT_EXISTS/');
    expect(readdirSync(dir)).toEqual(['app.ray.sig']);
  });
});
