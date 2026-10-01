/**
 * The walk of an fs blob root, against a REAL temp-dir root written through the store itself.
 *
 * It must list exactly what the store holds — every tenant, every key, nested or not, with the
 * header's logical length and digest — sorted by tenant and key by byte value, and refuse, rather
 * than skip, everything the store would not have written: a missing root, a stray top-level entry, a
 * link, a special file, the temporary file of an unfinished write, a malformed header and a key no
 * snapshot can carry.
 *
 * The two phases: `live` (before an export's fence) lists the temporary file of an upload as an
 * upload in flight and goes on; `quiesced` (under the fence, after the drain) refuses it. Every other
 * refusal holds in both.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BlobInventoryError,
  type FsBlobWalkPhase,
  listFsBlobs,
  MAX_SNAPSHOT_KEY_LENGTH,
} from './fs-blob-inventory.js';
import { makeFsBlobStoreFactory } from './fs-blob-store.js';

const TENANT_A = '0000000a-0000-4000-8000-000000000000';
const TENANT_B = '0000000b-0000-4000-8000-000000000000';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rayspec-blob-walk-'));
  roots.push(root);
  return root;
}

async function seeded(): Promise<string> {
  const root = newRoot();
  const factory = makeFsBlobStoreFactory(root);
  const a = factory(TENANT_A);
  const b = factory(TENANT_B);
  await a.put('z.txt', new TextEncoder().encode('last by key'), { contentType: 'text/plain' });
  await a.put('A/nested/deep.bin', new Uint8Array([0, 255, 1]));
  await a.put('ä-umlaut.txt', new TextEncoder().encode('größe'));
  await b.put('empty', new Uint8Array(0));
  return root;
}

const PHASES: readonly FsBlobWalkPhase[] = ['live', 'quiesced'];

/** The temporary file name the store gives a write of `key` before renaming it into place. */
const temporaryName = (key: string) =>
  `${key}.tmp-123-1700000000000-${'0123abcd-0000-4000-8000-0000000000ef'}`;

async function refusal(
  root: string,
  phase: FsBlobWalkPhase = 'quiesced',
): Promise<BlobInventoryError> {
  try {
    await listFsBlobs(root, { phase });
  } catch (err) {
    if (err instanceof BlobInventoryError) return err;
    throw err;
  }
  throw new Error('the walk did not refuse');
}

describe('listFsBlobs', () => {
  it('lists every stored object, sorted by tenant and then key by byte value', async () => {
    const root = await seeded();
    const { objects: listed, inFlight } = await listFsBlobs(root, { phase: 'quiesced' });
    expect(inFlight).toEqual([]);
    expect(await listFsBlobs(root, { phase: 'live' })).toEqual({ objects: listed, inFlight: [] });
    expect(listed.map((o) => [o.tenantId, o.key])).toEqual([
      [TENANT_A, 'A/nested/deep.bin'],
      [TENANT_A, 'z.txt'],
      // U+00E4 encodes as 0xC3 0xA4, after every ASCII byte.
      [TENANT_A, 'ä-umlaut.txt'],
      [TENANT_B, 'empty'],
    ]);
    for (const o of listed) {
      const stored = readFileSync(o.file);
      expect(o.storedSize).toBe(stored.length);
      expect(o.storedSize).toBe(statSync(o.file).size);
      const logical = stored.subarray(o.dataStart);
      expect(o.size).toBe(logical.length);
      expect(o.sha256).toBe(sha(logical));
    }
    expect(listed[1]).toMatchObject({ contentType: 'text/plain', size: 11 });
    expect(listed[0]).not.toHaveProperty('contentType');
    expect(listed[3]).toMatchObject({ size: 0, sha256: sha(new Uint8Array(0)) });
  });

  it('lists an empty root as no objects, and refuses a root that does not exist', async () => {
    for (const phase of PHASES) {
      expect(await listFsBlobs(newRoot(), { phase })).toEqual({ objects: [], inFlight: [] });
      expect((await refusal(join(newRoot(), 'missing'), phase)).kind).toBe('root-missing');
      const file = join(newRoot(), 'file');
      writeFileSync(file, 'x');
      expect((await refusal(file, phase)).kind).toBe('root-missing');
    }
  });

  it('refuses a top-level entry that is not a lowercase tenant directory', async () => {
    const stray = await seeded();
    writeFileSync(join(stray, 'notes.txt'), 'x');
    expect(await refusal(stray)).toMatchObject({ kind: 'not-a-tenant', relativePath: 'notes.txt' });
    const upper = await seeded();
    mkdirSync(join(upper, TENANT_A.toUpperCase().replace('0000000A', '0000000C')));
    expect((await refusal(upper)).kind).toBe('not-a-tenant');
  });

  it('refuses a link anywhere and never follows it', async () => {
    const outside = newRoot();
    writeFileSync(join(outside, 'secret'), 'outside the root');
    const top = await seeded();
    symlinkSync(join(outside), join(top, '0000000c-0000-4000-8000-000000000000'));
    expect((await refusal(top)).kind).toBe('link');
    const nested = await seeded();
    symlinkSync(join(outside, 'secret'), join(nested, TENANT_A, 'A', 'link'));
    expect(await refusal(nested)).toMatchObject({
      kind: 'link',
      relativePath: `${TENANT_A}/A/link`,
    });
  });

  it('quiesced: refuses the temporary file of an upload that never finished', async () => {
    const root = await seeded();
    writeFileSync(join(root, TENANT_B, temporaryName('empty')), 'partial');
    expect(await refusal(root, 'quiesced')).toMatchObject({
      kind: 'partial-write',
      relativePath: `${TENANT_B}/${temporaryName('empty')}`,
    });
  });

  it('live: lists the temporary file of an upload as in flight, with its size, and goes on', async () => {
    const root = await seeded();
    const quiet = (await listFsBlobs(root, { phase: 'quiesced' })).objects;
    writeFileSync(join(root, TENANT_B, temporaryName('empty')), 'partial');
    mkdirSync(join(root, TENANT_A, 'uploads'));
    writeFileSync(join(root, TENANT_A, 'uploads', temporaryName('next')), 'twelve bytes');
    const live = await listFsBlobs(root, { phase: 'live' });
    // The stored objects are exactly those of the quiet root: a temporary file is never an object.
    expect(live.objects).toEqual(quiet);
    expect(live.inFlight).toEqual([
      {
        tenantId: TENANT_A,
        relativePath: `${TENANT_A}/uploads/${temporaryName('next')}`,
        size: 12,
      },
      { tenantId: TENANT_B, relativePath: `${TENANT_B}/${temporaryName('empty')}`, size: 7 },
    ]);
    // Once the upload is renamed into place, a quiesced walk lists it as an object.
    rmSync(join(root, TENANT_B, temporaryName('empty')));
    await makeFsBlobStoreFactory(root)(TENANT_A).put('uploads/next', new Uint8Array([1, 2]));
    rmSync(join(root, TENANT_A, 'uploads', temporaryName('next')));
    const after = await listFsBlobs(root, { phase: 'quiesced' });
    expect(after.inFlight).toEqual([]);
    expect(after.objects.map((o) => o.key)).toContain('uploads/next');
  });

  it('live: refuses everything else the store would not have written, as quiesced does', async () => {
    const root = await seeded();
    writeFileSync(join(root, TENANT_B, temporaryName('empty')), 'partial');
    writeFileSync(join(root, TENANT_B, 'broken'), Buffer.from([0, 0]));
    expect(await refusal(root, 'live')).toMatchObject({
      kind: 'malformed',
      relativePath: `${TENANT_B}/broken`,
    });
    const stray = await seeded();
    writeFileSync(join(stray, 'notes.txt'), 'x');
    expect((await refusal(stray, 'live')).kind).toBe('not-a-tenant');
    const nested = await seeded();
    symlinkSync(join(nested, TENANT_B, 'empty'), join(nested, TENANT_A, 'link'));
    expect((await refusal(nested, 'live')).kind).toBe('link');
  });

  it('refuses a call that names no phase', async () => {
    const root = await seeded();
    await expect(
      listFsBlobs(root, {} as unknown as { phase: FsBlobWalkPhase }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('refuses a header that is truncated, unparseable or states another length', async () => {
    const cases: Buffer[] = [
      Buffer.from([0, 0]),
      Buffer.concat([Buffer.from([0, 0, 0, 50]), Buffer.from('{}')]),
      Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{x}')]),
    ];
    const header = Buffer.from(JSON.stringify({ sha256: 'a'.repeat(64), len: 5 }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length, 0);
    cases.push(Buffer.concat([length, header, Buffer.from('four')]));
    for (const bytes of cases) {
      const root = await seeded();
      writeFileSync(join(root, TENANT_B, 'broken'), bytes);
      expect(await refusal(root)).toMatchObject({
        kind: 'malformed',
        relativePath: `${TENANT_B}/broken`,
      });
    }
  });

  it('refuses a key that is not in Unicode NFC', async () => {
    const root = await seeded();
    // "a" followed by a combining diaeresis: the NFD form of "ä".
    await makeFsBlobStoreFactory(root)(TENANT_B).put('a\u0308.txt', new Uint8Array([1]));
    expect((await refusal(root)).kind).toBe('unrepresentable-key');
  });

  // A key over 1024 characters needs a path longer than macOS allows (PATH_MAX 1024), so the store
  // cannot write one there; Linux allows 4096.
  it.skipIf(process.platform === 'darwin')(
    'refuses a key longer than 1024 characters',
    async () => {
      const root = await seeded();
      const segment = 'k'.repeat(200);
      const deep = [...Array.from({ length: 6 }, () => segment), 'tail'].join('/');
      expect(deep.length).toBeGreaterThan(MAX_SNAPSHOT_KEY_LENGTH);
      await makeFsBlobStoreFactory(root)(TENANT_B).put(deep, new Uint8Array([1]));
      expect((await refusal(root)).kind).toBe('unrepresentable-key');
    },
  );
});
