/**
 * FsBlobStore tests — FAIL-THE-FIX against a REAL temp-dir fs root.
 *
 * The tenant-prefix-by-construction + the path jail ARE the ENTIRE tenant isolation for blobs (a
 * BlobStore does NOT traverse the TenantDb chokepoint — no SQL, no tenant predicate). So these tests
 * attack exactly that:
 *   - the TENANT-JAIL table: every malicious caller key is rejected OR contained strictly under the
 *     caller's own `<root>/<tenantId>/` (mutating the jail to a no-op turns these RED);
 *   - TENANT ISOLATION BY CONSTRUCTION: a handle bound to tenant A writes/reads ONLY under A's prefix,
 *     and a sibling-prefix key (tenant `a` vs `ab/…`) cannot reach another tenant's bytes;
 *   - the fs ROUND-TRIP: put → get → stat → createReadStream(offset/length) → delete → typed not-found,
 *     + idempotent re-put.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { BlobNotFound } from '@rayspec/handler-sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  __jailKeyForTest,
  BlobJailError,
  BlobStoreConfigError,
  makeFsBlobStoreFactory,
} from './fs-blob-store.js';

// Two real tenants (the prefix MUST be a UUID — the factory enforces it). `TENANT_A` is a substring
// prefix of NOTHING (UUIDs are fixed-format), but we still craft sibling-prefix attacks below.
const TENANT_A = '00000000-0000-0000-0000-0000000000aa';
const TENANT_B = '00000000-0000-0000-0000-0000000000bb';

const root = mkdtempSync(join(tmpdir(), 'rayspec-blob-'));
const factory = makeFsBlobStoreFactory(root);
const a = factory(TENANT_A);
const b = factory(TENANT_B);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const isNotFound = (r: unknown): r is BlobNotFound =>
  typeof r === 'object' && r !== null && (r as BlobNotFound).notFound === true;

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

describe('FsBlobStore — factory + tenant binding', () => {
  it('rejects a non-UUID tenant prefix at the factory (fail-closed)', () => {
    // A non-UUID tenant would weaken the structural "no tenant is a path-prefix of another" guarantee.
    expect(() => factory('not-a-uuid')).toThrow(BlobStoreConfigError);
    expect(() => factory('../evil')).toThrow(BlobStoreConfigError);
    expect(() => factory('')).toThrow(BlobStoreConfigError);
  });

  it('is tenant-bound BY CONSTRUCTION — there is no API to pass a tenant', async () => {
    // The handle takes only a caller key; the on-disk path is ALWAYS under <root>/<tenantId>/.
    await a.put('k1', enc('A-bytes'), { contentType: 'text/plain' });
    // The file lands under the tenant-A prefix on disk (proves the prefix is built inside the handle).
    // It is ONE self-describing file `[u32be headerLen][manifest JSON][raw bytes]` — NO `.meta.json`
    // sidecar — so the raw bytes are at the TAIL and the file ENDS WITH the body (the header prefixes it).
    const onDisk = readFileSync(join(root, TENANT_A, 'k1'));
    expect(onDisk.subarray(onDisk.length - 'A-bytes'.length).toString()).toBe('A-bytes');
    expect(existsSync(join(root, TENANT_A, 'k1.meta.json'))).toBe(false); // single-file: no sidecar.
    // The API round-trips the body (the header is invisible to the caller).
    const got = await a.get('k1');
    if (isNotFound(got)) throw new Error('unexpected not-found');
    expect(new TextDecoder().decode(await drain(got.body))).toBe('A-bytes');
    // Tenant B, the SAME caller key, sees nothing of A's (separate prefix).
    expect(isNotFound(await b.get('k1'))).toBe(true);
  });

  it('a key crafted to land in a SIBLING tenant prefix cannot read another tenant (jail)', async () => {
    await b.put('secret', enc('B-secret'));
    // Tenant A tries to reach B's blob via a traversal — every shape is rejected by the jail, so A can
    // never resolve to `<root>/<TENANT_B>/secret`.
    for (const evil of [
      `../${TENANT_B}/secret`,
      `..${sep}${TENANT_B}${sep}secret`,
      `../../${TENANT_B}/secret`,
    ]) {
      await expect(a.get(evil)).rejects.toThrow(BlobJailError);
    }
  });
});

describe('FsBlobStore — the TENANT-JAIL table (fail-the-fix; no-op jail turns these RED)', () => {
  // Every malicious caller key MUST be rejected (contained under the caller's own tenant root).
  const malicious = [
    '../x',
    '../../etc/passwd',
    '/abs/path',
    '\\abs\\path',
    'a/../../b',
    '%2e%2e/x', // percent-encoded `..`
    '%2e%2e%2fx', // percent-encoded `../`
    'a/%2e%2e/b',
    'foo#frag',
    'foo?query',
    'with\0null',
    '', // empty
    '..',
    `..${sep}${TENANT_B}`,
  ];

  it.each(malicious)('rejects put of malicious key %j', async (key) => {
    await expect(a.put(key, enc('x'))).rejects.toThrow(BlobJailError);
  });

  it.each(malicious)('rejects get of malicious key %j', async (key) => {
    await expect(a.get(key)).rejects.toThrow(BlobJailError);
  });

  it.each(malicious)('rejects stat/createReadStream/delete of malicious key %j', async (key) => {
    await expect(a.stat(key)).rejects.toThrow(BlobJailError);
    await expect(a.createReadStream(key)).rejects.toThrow(BlobJailError);
    await expect(a.delete(key)).rejects.toThrow(BlobJailError);
  });

  it('the jail primitive (__jailKeyForTest) contains a legit nested key UNDER the tenant root', () => {
    const tenantRoot = join(root, TENANT_A);
    // A legitimate nested key resolves strictly under the tenant root.
    const resolved = __jailKeyForTest(tenantRoot, 'uploads/u1/chunks/0');
    expect(resolved.startsWith(tenantRoot + sep)).toBe(true);
    // And every malicious key throws at the primitive level (the EXACT logic the impl runs).
    for (const key of malicious) {
      expect(() => __jailKeyForTest(tenantRoot, key)).toThrow(BlobJailError);
    }
  });
});

describe('FsBlobStore — fs round-trip', () => {
  beforeEach(() => {
    // Clean the tenant subtrees between round-trip tests (keep the jail-table fixtures untouched).
    rmSync(join(root, TENANT_A, 'rt'), { recursive: true, force: true });
  });

  it('put → get returns body + contentLength + contentType', async () => {
    await a.put('rt/k', enc('hello world'), { contentType: 'application/octet-stream' });
    const got = await a.get('rt/k');
    expect(isNotFound(got)).toBe(false);
    if (isNotFound(got)) return;
    expect(got.contentLength).toBe('hello world'.length);
    expect(got.contentType).toBe('application/octet-stream');
    expect(new TextDecoder().decode(await drain(got.body))).toBe('hello world');
  });

  it('stat returns len + a stable etagSource that CHANGES when bytes change', async () => {
    await a.put('rt/s', enc('v1'));
    const s1 = await a.stat('rt/s');
    expect(isNotFound(s1)).toBe(false);
    if (isNotFound(s1)) return;
    expect(s1.len).toBe(2);
    expect(typeof s1.etagSource).toBe('string');
    expect(s1.etagSource.length).toBeGreaterThan(0);
    // Re-put DIFFERENT bytes → etagSource must change (content-derived, not mtime).
    await a.put('rt/s', enc('v2-longer'));
    const s2 = await a.stat('rt/s');
    if (isNotFound(s2)) throw new Error('unexpected not-found');
    expect(s2.etagSource).not.toBe(s1.etagSource);
    expect(s2.len).toBe('v2-longer'.length);
  });

  it('createReadStream honors offset/length (HTTP Range)', async () => {
    await a.put('rt/range', enc('0123456789'));
    // offset 2, length 4 → "2345"
    const stream = await a.createReadStream('rt/range', { offset: 2, length: 4 });
    expect(isNotFound(stream)).toBe(false);
    if (isNotFound(stream)) return;
    expect(new TextDecoder().decode(await drain(stream))).toBe('2345');
    // whole-object (no opts)
    const whole = await a.createReadStream('rt/range');
    if (isNotFound(whole)) throw new Error('unexpected not-found');
    expect(new TextDecoder().decode(await drain(whole))).toBe('0123456789');
  });

  it('delete then get returns the TYPED not-found (not a throw)', async () => {
    await a.put('rt/d', enc('bye'));
    await a.delete('rt/d');
    const got = await a.get('rt/d');
    expect(isNotFound(got)).toBe(true);
    if (isNotFound(got)) expect(got.key).toBe('rt/d');
    // Deleting an absent key is an idempotent no-op (never throws).
    await expect(a.delete('rt/d')).resolves.toBeUndefined();
  });

  it('get/stat/createReadStream of an absent key return the TYPED not-found', async () => {
    expect(isNotFound(await a.get('rt/never'))).toBe(true);
    expect(isNotFound(await a.stat('rt/never'))).toBe(true);
    expect(isNotFound(await a.createReadStream('rt/never'))).toBe(true);
  });

  it('put is idempotent by key (re-put overwrites, never errors)', async () => {
    await a.put('rt/idem', enc('first'));
    await expect(a.put('rt/idem', enc('second'))).resolves.toBeUndefined();
    const got = await a.get('rt/idem');
    if (isNotFound(got)) throw new Error('unexpected not-found');
    expect(new TextDecoder().decode(await drain(got.body))).toBe('second');
  });

  it('accepts a ReadableStream body (the stream-primitive exchange shape)', async () => {
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc('chunk-1;'));
        controller.enqueue(enc('chunk-2'));
        controller.close();
      },
    });
    await a.put('rt/stream', webStream, { contentType: 'audio/ogg' });
    const got = await a.get('rt/stream');
    if (isNotFound(got)) throw new Error('unexpected not-found');
    expect(got.contentType).toBe('audio/ogg');
    expect(new TextDecoder().decode(await drain(got.body))).toBe('chunk-1;chunk-2');
  });

  it('round-trips an EMPTY blob (header present, zero bytes)', async () => {
    // A zero-length body: the file is `[header][]` — get must return an empty body + contentLength 0,
    // NOT a not-found (the header is still a valid manifest).
    await a.put('rt/empty', new Uint8Array(0), { contentType: 'application/octet-stream' });
    const got = await a.get('rt/empty');
    if (isNotFound(got)) throw new Error('unexpected not-found');
    expect(got.contentLength).toBe(0);
    expect((await drain(got.body)).length).toBe(0);
    const s = await a.stat('rt/empty');
    if (isNotFound(s)) throw new Error('unexpected not-found');
    expect(s.len).toBe(0);
  });
});

describe('FsBlobStore — single-file format (closes the sidecar-collision + consistency cluster)', () => {
  beforeEach(() => {
    rmSync(join(root, TENANT_A, 'sf'), { recursive: true, force: true });
  });

  it('a caller key ending in `.meta.json` is just another blob (NO sidecar key-collision)', async () => {
    // Under the OLD two-file layout the sidecar of key `x` was `x.meta.json` — so a caller key literally
    // named `x.meta.json` would collide with another blob's manifest. With the single-file format it is
    // simply a distinct blob with its own self-describing file.
    await a.put('sf/x', enc('the-x-bytes'), { contentType: 'text/plain' });
    await a.put('sf/x.meta.json', enc('{"not":"a manifest"}'), { contentType: 'application/json' });
    const x = await a.get('sf/x');
    const meta = await a.get('sf/x.meta.json');
    if (isNotFound(x) || isNotFound(meta)) throw new Error('unexpected not-found');
    expect(new TextDecoder().decode(await drain(x.body))).toBe('the-x-bytes');
    expect(new TextDecoder().decode(await drain(meta.body))).toBe('{"not":"a manifest"}');
    // The two are independent — `x`'s manifest was NOT clobbered by the `.meta.json` blob's bytes.
    const xStat = await a.stat('sf/x');
    if (isNotFound(xStat)) throw new Error('unexpected not-found');
    expect(xStat.contentType).toBe('text/plain');
  });

  it('get/stat/createReadStream read the header WITHOUT a full read; the header is invisible (Range offset 0 = first logical byte)', async () => {
    await a.put('sf/range', enc('0123456789'), { contentType: 'text/plain' });
    // stat: len is the LOGICAL byte count (header excluded).
    const s = await a.stat('sf/range');
    if (isNotFound(s)) throw new Error('unexpected not-found');
    expect(s.len).toBe(10);
    expect(s.contentType).toBe('text/plain');
    // get: contentLength excludes the header; the body is the logical bytes only.
    const got = await a.get('sf/range');
    if (isNotFound(got)) throw new Error('unexpected not-found');
    expect(got.contentLength).toBe(10);
    expect(new TextDecoder().decode(await drain(got.body))).toBe('0123456789');
    // createReadStream: offset 0 is the FIRST LOGICAL byte (not the header's first byte).
    const fromZero = await a.createReadStream('sf/range', { offset: 0, length: 3 });
    if (isNotFound(fromZero)) throw new Error('unexpected not-found');
    expect(new TextDecoder().decode(await drain(fromZero))).toBe('012');
    // a mid-range Range translates past the header correctly.
    const mid = await a.createReadStream('sf/range', { offset: 4, length: 3 });
    if (isNotFound(mid)) throw new Error('unexpected not-found');
    expect(new TextDecoder().decode(await drain(mid))).toBe('456');
  });

  it('N concurrent same-key puts of identical bytes ALL resolve (no temp-name collision) + the blob round-trips', async () => {
    // FAIL-THE-FIX: the OLD temp name was `${absolute}.tmp-${pid}-${Date.now()}` —
    // two puts in the same millisecond collided on ONE temp path → an EEXIST/torn rename. The new temp
    // name appends `randomUUID()` so each concurrent put renames its OWN unique temp (last wins).
    const N = 8;
    const bytes = enc('concurrent-identical-payload');
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => a.put('sf/concurrent', bytes, { contentType: 'text/plain' })),
    );
    // EVERY put resolved (none rejected on a temp-name collision).
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // The final blob is consistent (a complete manifest+bytes pair).
    const got = await a.get('sf/concurrent');
    if (isNotFound(got)) throw new Error('unexpected not-found');
    expect(new TextDecoder().decode(await drain(got.body))).toBe('concurrent-identical-payload');
    const s = await a.stat('sf/concurrent');
    if (isNotFound(s)) throw new Error('unexpected not-found');
    expect(s.len).toBe('concurrent-identical-payload'.length);
    expect(typeof s.etagSource).toBe('string');
  });
});

describe('FsBlobStore — layer-4 realpath symlink defense (fail-the-fix; removing the realpath assert turns this RED)', () => {
  // The lexical layers 0-3 reject `..`/absolute/URL-significant keys, so layer-4 (the realpath
  // segment-boundary assert) is the ONLY layer that catches a SYMLINK escape: a perfectly-lexical key
  // whose on-disk path component is a symlink pointing OUT of the tenant root. This test plants exactly
  // that and asserts the operation throws `BlobJailError` ('realpath segment-boundary').
  it('rejects a put/get through a symlinked path component that escapes the tenant root', () => {
    // A real OUTSIDE directory (a different tenant's root, or any dir) the symlink will point to.
    const outsideRoot = mkdtempSync(join(tmpdir(), 'rayspec-blob-outside-'));
    try {
      // Tenant A's root must exist so we can plant a symlink dir INSIDE it.
      const tenantARoot = join(root, TENANT_A);
      mkdirSync(tenantARoot, { recursive: true });
      // Plant `<tenantARoot>/escape` → outsideRoot (a directory symlink that climbs out lexically-cleanly).
      const linkPath = join(tenantARoot, 'escape');
      rmSync(linkPath, { recursive: true, force: true });
      symlinkSync(outsideRoot, linkPath, 'dir');
      // The caller key `escape/secret` is lexically clean (no `..`, not absolute) — only the realpath
      // assert (layer 4) catches that `escape` resolves OUTSIDE the tenant root. Must throw.
      expect(() => __jailKeyForTest(tenantARoot, 'escape/secret')).toThrow(BlobJailError);
      expect(() => __jailKeyForTest(tenantARoot, 'escape/secret')).toThrow(/realpath/i);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
      rmSync(join(root, TENANT_A, 'escape'), { recursive: true, force: true });
    }
  });
});

describe('FsBlobStore — deleteTenant (M4 whole-tenant erasure: jail + bound-tenant + idempotent)', () => {
  // Dedicated fresh tenants so this block never touches the state other tests above rely on.
  const E1 = '00000000-0000-0000-0000-0000000000e1';
  const E2 = '00000000-0000-0000-0000-0000000000e2';

  it('rejects a non-UUID / traversal tenant id (fail-closed)', async () => {
    const e1 = factory(E1);
    await expect(e1.deleteTenant('not-a-uuid')).rejects.toThrow(BlobStoreConfigError);
    await expect(e1.deleteTenant('../evil')).rejects.toThrow(BlobStoreConfigError);
    await expect(e1.deleteTenant('')).rejects.toThrow(BlobStoreConfigError);
  });

  it('refuses a cross-tenant erasure — a handle may erase ONLY its own bound tenant', async () => {
    // The handle is bound to E1; asking it to erase E2 is fail-closed-refused (NOT a cross-tenant
    // primitive — a handler holding this handle could already delete only its OWN keys).
    await expect(factory(E1).deleteTenant(E2)).rejects.toThrow(BlobStoreConfigError);
  });

  it('is idempotent — erasing an absent tenant subtree is a no-op', async () => {
    await expect(factory(E2).deleteTenant(E2)).resolves.toBeUndefined();
  });

  it('removes the whole tenant subtree but leaves a sibling tenant INTACT', async () => {
    const e1 = factory(E1);
    const e2 = factory(E2);
    await e1.put('rec/0', enc('E1-a'));
    await e1.put('rec/1', enc('E1-b'));
    await e2.put('rec/0', enc('E2-a'));
    expect(existsSync(join(root, E1))).toBe(true);

    await e1.deleteTenant(E1);

    // E1 GONE (subtree removed; gets are not-found).
    expect(existsSync(join(root, E1))).toBe(false);
    expect(isNotFound(await e1.get('rec/0'))).toBe(true);
    expect(isNotFound(await e1.get('rec/1'))).toBe(true);
    // E2 FULLY INTACT (sibling isolation — the RED-first witness).
    expect(isNotFound(await e2.get('rec/0'))).toBe(false);

    // A 2nd erase is a no-op (idempotent).
    await expect(e1.deleteTenant(E1)).resolves.toBeUndefined();
  });
});
