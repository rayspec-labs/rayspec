/**
 * The writer's guards against the file system changing under it: a source file that changes
 * between its digest and its copy, a destination or signature file that appears while the archive
 * is written, and a written archive its own read-back refuses. Each change is made at the moment
 * the writer opens the file concerned, through a wrapper around `open`.
 */
import { generateKeyPairSync } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BundleError, RayManifest } from '@rayspec/bundle-contract';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { type BundleFile, type BundleManifestInput, writeBundle } from './index.js';
import { loadExpectations } from './test-support/contract.js';
import { baseFiles } from './test-support/raw-zip.js';

/** Called with the path and flags of every `open` from `node:fs/promises`, before it runs. */
const hook = vi.hoisted(() => ({
  onOpen: null as ((path: string, flags: unknown) => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (path: string, flags?: string | number, mode?: number) => {
      hook.onOpen?.(String(path), flags);
      return actual.open(path, flags, mode);
    },
  };
});

const expectations = loadExpectations();
const manifestInput = (): BundleManifestInput => {
  const { inventory: _drop, ...rest } = structuredClone(
    expectations.bases.application.manifest,
  ) as unknown as RayManifest;
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
afterEach(() => {
  hook.onOpen = null;
});
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-bundle-writer-race-'));
  dirs.push(dir);
  return dir;
}

/** Whether `path` is the writer's temporary file for `target`, opened for writing. */
const isTemporaryFor = (target: string, path: string, flags: unknown) =>
  flags === 'wx' &&
  new RegExp(`^\\.${basename(target).replace('.', '\\.')}\\.[0-9a-f]{16}\\.tmp$`).test(
    basename(path),
  );

describe('a source file that changes while the bundle is written', () => {
  it.each([
    ['grows', (file: string) => appendFileSync(file, 'more')],
    [
      'changes in place',
      (file: string) => {
        const fd = openSync(file, 'r+');
        writeSync(fd, Buffer.from('X'), 0, 1, 0);
        closeSync(fd);
      },
    ],
  ])('is refused when it %s between its digest and its copy', async (_label, change) => {
    const sources = workDir();
    const source = join(sources, 'data.bin');
    writeFileSync(source, 'the bytes that were measured');
    let opens = 0;
    hook.onOpen = (path) => {
      if (path === source && ++opens === 2) change(source);
    };
    const dir = workDir();
    const r = await writeBundle(join(dir, 'app.ray'), {
      manifest: manifestInput(),
      files: [...byteFiles(), { path: 'payload/data.bin', file: source }],
    });
    expect(opens).toBe(2);
    expect(outcome(r)).toBe('RAY_USAGE/');
    expect(!r.ok && r.errors[0]!.message).toBe(
      'a source file changed while the bundle was written',
    );
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('limits the writer checks before it writes', () => {
  it('payload files past the extracted byte limit are refused before any file is created', async () => {
    const dir = workDir();
    let created = 0;
    hook.onOpen = (_path, flags) => {
      if (flags === 'wx') created++;
    };
    const r = await writeBundle(
      join(dir, 'app.ray'),
      { manifest: manifestInput(), files: byteFiles() },
      { limits: { extractedBytes: 100 } },
    );
    expect(outcome(r)).toBe('RAY_LIMIT_EXCEEDED/extracted-size');
    expect(created).toBe(0);
  });
});

describe('placement races', () => {
  it('never replaces a destination that appears while the archive is written', async () => {
    const dir = workDir();
    const out = join(dir, 'app.ray');
    hook.onOpen = (path, flags) => {
      if (isTemporaryFor(out, path, flags)) writeFileSync(out, 'theirs');
    };
    const r = await writeBundle(out, { manifest: manifestInput(), files: byteFiles() });
    expect(outcome(r)).toBe('RAY_OUTPUT_EXISTS/');
    expect(readFileSync(out, 'utf8')).toBe('theirs');
    expect(readdirSync(dir)).toEqual(['app.ray']);
  });

  it('withdraws the archive when its signature file cannot be placed', async () => {
    const dir = workDir();
    const out = join(dir, 'app.ray');
    hook.onOpen = (path, flags) => {
      if (isTemporaryFor(`${out}.sig`, path, flags)) writeFileSync(`${out}.sig`, 'theirs');
    };
    const { privateKey } = generateKeyPairSync('ed25519');
    const r = await writeBundle(
      out,
      { manifest: manifestInput(), files: byteFiles() },
      { signingKey: privateKey },
    );
    expect(outcome(r)).toBe('RAY_OUTPUT_EXISTS/');
    expect(readdirSync(dir)).toEqual(['app.ray.sig']);
    expect(readFileSync(`${out}.sig`, 'utf8')).toBe('theirs');
  });
});

describe('the read-back', () => {
  /** Change the temporary archive when the reader opens it (the writer opens it with 'wx'). */
  const onReadBack = (out: string, change: (temporary: string) => void) => {
    hook.onOpen = (path, flags) => {
      if (typeof flags === 'number' && isTemporaryFor(out, path, 'wx')) change(path);
    };
  };

  it('an archive its own reader refuses is never placed', async () => {
    const dir = workDir();
    const out = join(dir, 'app.ray');
    onReadBack(out, (temporary) => {
      // The first data byte of the first entry: the reader finds a CRC mismatch.
      const fd = openSync(temporary, 'r+');
      const at = 30 + Buffer.byteLength([...baseFiles(expectations).keys()].sort()[0]!);
      const byte = Buffer.alloc(1);
      readSync(fd, byte, 0, 1, at);
      writeSync(fd, Buffer.from([byte[0]! ^ 0xff]), 0, 1, at);
      closeSync(fd);
    });
    const r = await writeBundle(out, { manifest: manifestInput(), files: byteFiles() });
    expect(outcome(r)).toBe('RAY_INTERNAL/');
    expect(!r.ok && r.errors[0]!.message).toBe('the written archive does not pass the reader');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a limit the read-back reaches is reported as that limit', async () => {
    const dir = workDir();
    const out = join(dir, 'app.ray');
    const first = await writeBundle(join(workDir(), 'app.ray'), {
      manifest: manifestInput(),
      files: byteFiles(),
    });
    if (!first.ok) throw new Error('the base bundle does not write');
    const size = first.value.archiveSize;
    onReadBack(out, (temporary) => appendFileSync(temporary, Buffer.alloc(64)));
    const r = await writeBundle(
      out,
      { manifest: manifestInput(), files: byteFiles() },
      { limits: { archiveBytes: size + 32, migrationArchiveBytes: size + 32 } },
    );
    expect(outcome(r)).toBe('RAY_LIMIT_EXCEEDED/archive-size');
    expect(readdirSync(dir)).toEqual([]);
  });
});
