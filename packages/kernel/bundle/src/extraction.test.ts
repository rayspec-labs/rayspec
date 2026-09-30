/**
 * The extraction directory in isolation: a file is created exclusively and never through a link,
 * a directory that appears under the root is not followed, a directory swapped for a link during
 * extraction is noticed before a byte is written, and discarding removes only what the target
 * created.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ExtractionTarget } from './extraction.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-bundle-target-'));
  dirs.push(dir);
  return dir;
}

async function created(dir: string): Promise<ExtractionTarget> {
  const target = await ExtractionTarget.prepare(join(dir, 'out'));
  await target.create();
  return target;
}

describe('ExtractionTarget', () => {
  it('never opens a file through a symbolic link planted at its path', async () => {
    const dir = workDir();
    const target = await created(dir);
    const victim = join(dir, 'victim');
    symlinkSync(victim, join(target.root, 'ray.json'));
    await expect(target.openFile('ray.json')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(existsSync(victim)).toBe(false);
  });

  it('never overwrites a file that exists', async () => {
    const dir = workDir();
    const target = await created(dir);
    const first = await target.openFile('ray.json');
    await first.close();
    await expect(target.openFile('ray.json')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('does not descend into a directory it did not create', async () => {
    const dir = workDir();
    const target = await created(dir);
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(target.root, 'payload'));
    await expect(target.openFile('payload/x')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses to write into a directory swapped for a link after it was created', async () => {
    const dir = workDir();
    const target = await created(dir);
    await (await target.openFile('payload/app/first')).close();
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    renameSync(join(target.root, 'payload/app'), join(dir, 'moved'));
    symlinkSync(outside, join(target.root, 'payload/app'));
    await expect(target.openFile('payload/app/second')).rejects.toMatchObject({
      error: { code: 'RAY_INTERNAL' },
    });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses when a directory above the file is swapped, however deep', async () => {
    const dir = workDir();
    const target = await created(dir);
    await (await target.openFile('payload/a/b/c/first')).close();
    const outside = join(dir, 'outside');
    mkdirSync(join(outside, 'b', 'c'), { recursive: true });
    renameSync(join(target.root, 'payload/a'), join(dir, 'moved'));
    symlinkSync(outside, join(target.root, 'payload/a'));
    await expect(target.openFile('payload/a/b/c/second')).rejects.toMatchObject({
      error: { code: 'RAY_INTERNAL' },
    });
    expect(readdirSync(join(outside, 'b', 'c'))).toEqual([]);
  });

  it('refuses a name that resolves outside the root', async () => {
    const target = await created(workDir());
    await expect(target.openFile('../x')).rejects.toMatchObject({
      error: { code: 'RAY_INVALID_ARCHIVE' },
    });
  });

  it('discards only a root it created', async () => {
    const dir = workDir();
    const prepared = await ExtractionTarget.prepare(join(dir, 'out'));
    mkdirSync(join(dir, 'out'));
    await prepared.discard();
    expect(existsSync(join(dir, 'out'))).toBe(true);
    await expect(prepared.create()).rejects.toMatchObject({ error: { code: 'RAY_OUTPUT_EXISTS' } });
    await prepared.discard();
    expect(existsSync(join(dir, 'out'))).toBe(true);
  });
});
