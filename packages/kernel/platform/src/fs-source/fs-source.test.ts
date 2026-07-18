/**
 * FsSource tests — FAIL-THE-FIX against a REAL temp-dir source root.
 *
 * The path jail IS the ENTIRE containment for this READ-ONLY capability (it reads real host files), so
 * these tests attack exactly that:
 *   - the JAIL table: every malicious path is rejected (mutating the jail to a no-op turns these RED);
 *   - the layer-5 realpath SYMLINK defense: a symlink inside the root pointing OUT is refused — a read
 *     through it NEVER returns the foreign bytes (removing the realpath assert turns this RED);
 *   - READ-ONLY BY CONSTRUCTION: the handle exposes NO write/delete/move/create method;
 *   - the fs behavior: list (files+dirs, sorted, symlinks skipped) → read (bytes / typed not-found /
 *     over-cap refusal) → search (literal matches, case-insensitivity, dir-scope, binary/oversize skip).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { FsSource, FsSourceNotFound } from '@rayspec/handler-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  __jailPathForTest,
  DEFAULT_MAX_READ_BYTES,
  FsSourceConfigError,
  FsSourceError,
  FsSourceJailError,
  makeFsSourceFactory,
} from './fs-source.js';

const root = mkdtempSync(join(tmpdir(), 'rayspec-fs-source-'));
// The directory OUTSIDE the root a symlink-escape attack tries to reach.
const outside = mkdtempSync(join(tmpdir(), 'rayspec-fs-outside-'));

let src: FsSource;

beforeAll(() => {
  // A small jailed tree the read/list/search tests exercise.
  writeFileSync(join(root, 'top.txt'), 'top level\nSECRET marker here\n');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'readme.md'), '# Readme\nhello WORLD line\n');
  writeFileSync(join(root, 'docs', 'guide.md'), 'guide line one\nguide line two\n');
  mkdirSync(join(root, 'docs', 'nested'), { recursive: true });
  writeFileSync(join(root, 'docs', 'nested', 'deep.txt'), 'a deep needle lives here\n');
  // A binary file search must skip (contains a NUL byte).
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02, 0x6e, 0x65, 0x65]));
  // The outside file a jail escape would leak.
  writeFileSync(join(outside, 'secret'), 'OUTSIDE-SECRET-should-never-be-read');
  src = makeFsSourceFactory(root)();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const isNotFound = (r: unknown): r is FsSourceNotFound =>
  typeof r === 'object' && r !== null && (r as FsSourceNotFound).notFound === true;
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('makeFsSourceFactory — fail-closed config', () => {
  it('rejects a root that does not exist (FsSourceConfigError)', () => {
    expect(() => makeFsSourceFactory(join(root, 'no-such-dir'))).toThrow(FsSourceConfigError);
  });

  it('rejects a root that is a FILE, not a directory (FsSourceConfigError)', () => {
    expect(() => makeFsSourceFactory(join(root, 'top.txt'))).toThrow(FsSourceConfigError);
  });

  it('the factory is a no-tenant-arg factory (a shared read root) — factory() yields a handle', () => {
    const factory = makeFsSourceFactory(root);
    expect(typeof factory).toBe('function');
    expect(factory.length).toBe(0); // no tenantId parameter (unlike a BlobStoreFactory)
    expect(typeof factory().read).toBe('function');
  });
});

describe('FsSource — READ-ONLY by construction (no write surface exists)', () => {
  it('exposes ONLY list/read/search — no put/write/delete/move/create/rmdir method', () => {
    const handle = src as unknown as Record<string, unknown>;
    for (const method of ['list', 'read', 'search']) {
      expect(typeof handle[method]).toBe('function');
    }
    // A mutating method would make this a read-WRITE capability — assert every write verb is ABSENT.
    for (const forbidden of [
      'put',
      'write',
      'writeFile',
      'delete',
      'rm',
      'unlink',
      'move',
      'rename',
      'mkdir',
      'create',
      'append',
      'rmdir',
      'deleteTenant',
    ]) {
      expect(handle[forbidden]).toBeUndefined();
    }
  });
});

describe('FsSource — the PATH-JAIL table (fail-the-fix; a no-op jail turns these RED)', () => {
  // Every malicious path MUST be rejected fail-closed (never resolved outside the source root).
  const malicious = [
    '../x',
    '../../etc/passwd',
    `..${sep}secret`,
    '/abs/path',
    '\\abs\\path',
    'a/../../b',
    'docs/../../escape',
    '%2e%2e/x', // percent-encoded `..`
    '%2e%2e%2fx', // percent-encoded `../`
    'a/%2e%2e/b',
    'foo#frag',
    'foo?query',
    'with\0null',
  ];

  it.each(malicious)('read() rejects malicious path %j with FsSourceJailError', async (p) => {
    await expect(src.read(p)).rejects.toThrow(FsSourceJailError);
  });

  it.each(malicious)('list() rejects malicious dir %j with FsSourceJailError', async (p) => {
    await expect(src.list(p)).rejects.toThrow(FsSourceJailError);
  });

  it('search() rejects an escaping opts.dir with FsSourceJailError', async () => {
    await expect(src.search('x', { dir: '../..' })).rejects.toThrow(FsSourceJailError);
  });

  it('an EMPTY path to read() is refused (a file path is required)', async () => {
    await expect(src.read('')).rejects.toThrow(FsSourceJailError);
  });

  it('the jail primitive contains a legit nested path UNDER the root', () => {
    const resolved = __jailPathForTest(root, 'docs/nested/deep.txt');
    expect(resolved.startsWith(root + sep)).toBe(true);
  });

  it.each(malicious)('the jail primitive throws on %j', (p) => {
    expect(() => __jailPathForTest(root, p)).toThrow(FsSourceJailError);
  });
});

describe('FsSource — layer-5 realpath SYMLINK defense (fail-the-fix; drop the realpath assert → RED)', () => {
  // The lexical layers reject `..`/absolute/URL keys, so layer 5 (the realpath segment-boundary assert)
  // is what defends a LEXICALLY-CLEAN key whose on-disk component is a symlink pointing OUT of the root.
  beforeAll(() => {
    // Plant `<root>/escape` → the OUTSIDE dir (a directory symlink that climbs out lexically-cleanly).
    symlinkSync(outside, join(root, 'escape'), 'dir');
  });

  it('the jail primitive throws (realpath segment-boundary) for a symlinked escaping component', () => {
    expect(() => __jailPathForTest(root, 'escape/secret')).toThrow(FsSourceJailError);
    expect(() => __jailPathForTest(root, 'escape/secret')).toThrow(/realpath/i);
  });

  it('read() through an escaping symlink REFUSES — it never returns the outside bytes', async () => {
    // The killer assertion: a working escape would return 'OUTSIDE-SECRET…'. The jail must THROW.
    await expect(src.read('escape/secret')).rejects.toThrow(FsSourceJailError);
  });

  it('list() does NOT enumerate the escaping symlink (enumeration never traverses a symlink)', async () => {
    const entries = await src.list();
    if (isNotFound(entries)) throw new Error('unexpected not-found');
    expect(entries.some((e) => e.name === 'escape')).toBe(false);
  });
});

describe('FsSource — list()', () => {
  it('lists the ROOT (no arg) — files + dirs, name-sorted, symlinks skipped', async () => {
    const entries = await src.list();
    if (isNotFound(entries)) throw new Error('unexpected not-found');
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName.docs?.type).toBe('directory');
    expect(byName['top.txt']?.type).toBe('file');
    expect(byName['top.txt']?.path).toBe('top.txt');
    expect((byName['top.txt']?.size ?? 0) > 0).toBe(true);
    // name-sorted
    const names = entries.map((e) => e.name);
    expect([...names].sort()).toEqual(names);
  });

  it('lists a nested dir with root-relative POSIX paths', async () => {
    const entries = await src.list('docs');
    if (isNotFound(entries)) throw new Error('unexpected not-found');
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toContain('docs/readme.md');
    expect(paths).toContain('docs/guide.md');
    expect(paths).toContain('docs/nested');
  });

  it('a non-existent dir is the typed not-found (never a throw)', async () => {
    expect(isNotFound(await src.list('does/not/exist'))).toBe(true);
  });
});

describe('FsSource — read()', () => {
  it('reads a jailed file back byte-for-byte', async () => {
    const r = await src.read('docs/readme.md');
    if (isNotFound(r)) throw new Error('unexpected not-found');
    expect(dec(r.bytes)).toBe('# Readme\nhello WORLD line\n');
    expect(r.contentLength).toBe(r.bytes.length);
  });

  it('an absent file is the typed not-found', async () => {
    expect(isNotFound(await src.read('docs/missing.md'))).toBe(true);
  });

  it('reading a DIRECTORY is the typed not-found (not a throw)', async () => {
    expect(isNotFound(await src.read('docs'))).toBe(true);
  });

  it('refuses a file OVER the byte cap fail-closed (FsSourceError, never a silent truncation)', async () => {
    await expect(src.read('docs/readme.md', { maxBytes: 3 })).rejects.toThrow(FsSourceError);
  });

  it('the default cap is a sane non-trivial bound', () => {
    expect(DEFAULT_MAX_READ_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe('FsSource — search()', () => {
  it('finds literal matches with path + 1-based line + line text', async () => {
    const hits = await src.search('needle');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('docs/nested/deep.txt');
    expect(hits[0]?.line).toBe(1);
    expect(hits[0]?.text).toContain('needle');
  });

  it('is case-SENSITIVE by default, case-insensitive on request', async () => {
    expect(await src.search('world')).toHaveLength(0); // the file has "WORLD"
    const ci = await src.search('world', { caseSensitive: false });
    expect(ci).toHaveLength(1);
    expect(ci[0]?.path).toBe('docs/readme.md');
  });

  it('scopes to opts.dir', async () => {
    // "line" appears in docs/guide.md (x2) + docs/nested/deep.txt has none; scope to docs.
    const scoped = await src.search('guide line', { dir: 'docs' });
    expect(scoped.every((m) => m.path.startsWith('docs/'))).toBe(true);
    expect(scoped.length).toBeGreaterThanOrEqual(2);
  });

  it('SKIPS a binary (NUL-containing) file', async () => {
    // 'nee' is the ASCII tail of blob.bin, but the NUL byte marks it binary → skipped.
    const hits = await src.search('nee');
    expect(hits.every((m) => m.path !== 'blob.bin')).toBe(true);
  });

  it('an empty query returns [] (never "everything")', async () => {
    expect(await src.search('')).toEqual([]);
  });

  it('honors maxResults (a bounded read)', async () => {
    const capped = await src.search('line', { maxResults: 1 });
    expect(capped).toHaveLength(1);
  });
});
