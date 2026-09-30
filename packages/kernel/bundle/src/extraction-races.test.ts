/**
 * The extraction directory against a swap timed around the open itself: a directory above the file
 * is replaced by a link just before the file is created, and put back, with a decoy file at the
 * path, just after. The file that was opened is then not the file at its path, and extraction is
 * refused before a byte is written. The swap is made through a wrapper around `open`.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ExtractionTarget } from './extraction.js';

/** Called around every `open` from `node:fs/promises`. */
const hook = vi.hoisted(() => ({
  before: null as ((path: string) => void) | null,
  after: null as ((path: string) => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (path: string, flags?: string | number, mode?: number) => {
      hook.before?.(String(path));
      const handle = await actual.open(path, flags, mode);
      hook.after?.(String(path));
      return handle;
    },
  };
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  hook.before = null;
  hook.after = null;
});

describe('a directory swapped around the open of a file', () => {
  it('is refused, and nothing is written where the link pointed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rayspec-bundle-target-race-'));
    dirs.push(dir);
    const target = await ExtractionTarget.prepare(join(dir, 'out'));
    await target.create();
    await (await target.openFile('payload/app/first')).close();
    const app = join(target.root, 'payload/app');
    const moved = join(dir, 'moved');
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    const file = join(app, 'second');
    hook.before = (path) => {
      if (path !== file) return;
      renameSync(app, moved);
      symlinkSync(outside, app);
    };
    hook.after = (path) => {
      if (path !== file) return;
      unlinkSync(app);
      renameSync(moved, app);
      writeFileSync(file, 'decoy');
    };
    await expect(target.openFile('payload/app/second')).rejects.toMatchObject({
      error: { code: 'RAY_INTERNAL' },
    });
    // The swap happened: the file was created where the link pointed, and stays empty.
    expect(readdirSync(outside)).toEqual(['second']);
  });
});
