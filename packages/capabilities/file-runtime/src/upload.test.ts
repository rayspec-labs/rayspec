/**
 * The bounded upload core — every state-machine arm + every byte-bound arm pinned, proven against
 * fakes that ENFORCE the real constraints (shared table with a global unique on `file_ref`;
 * a tenant-namespaced, path-jailed blob bucket — see test-support/).
 *
 * The load-bearing arms (each its own test):
 *  - the Content-Length PRE-CHECK rejects absent/non-numeric/oversize BEFORE any body byte is read
 *    (proven with a poisoned stream that throws on first read);
 *  - the DRAIN-TIME cap defeats a LYING Content-Length (proven with a pull-counting stream — the
 *    read stops at the cap boundary, never a full drain);
 *  - 415 fail-closed content-type allowlist BEFORE any read/store;
 *  - the client filename NEVER appears in any blob key / ref / id;
 *  - the divergence contract: idempotent identical re-upload, last-write-wins pre-seal,
 *    409 + stored-event heal post-seal (best-effort, cross-tenant family rethrows).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type ResolvedFileConfig, resolveFileConfig } from './config.js';
import {
  createInMemoryFileSubmittedSink,
  FileEventRejectedError,
  type FileSubmittedSink,
} from './events.js';
import type { FileBlobContext, FileUploadRequest, HandlerDb } from './ports.js';
import { submitFile } from './submit.js';
import { makeFakeBlobStore, SharedBlobBucket } from './test-support/fake-blob.js';
import { makeFakeFileDb, SharedFileTable } from './test-support/fake-db.js';
import { uploadFile } from './upload.js';

const TENANT_A = 'tenant-aaaa';
const TENANT_B = 'tenant-bbbb';

function ctx(
  table: SharedFileTable,
  bucket: SharedBlobBucket,
  tenantId = TENANT_A,
  config?: ResolvedFileConfig,
): FileBlobContext {
  return {
    tenantId,
    db: makeFakeFileDb(table, tenantId),
    blob: makeFakeBlobStore(bucket, tenantId),
    config: config ?? resolveFileConfig(),
  };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A body whose FIRST read throws — proves a pre-check arm never touched the body. */
function poisonedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      throw new Error('BODY WAS READ — the pre-body checks must reject first');
    },
  });
}

/**
 * A LYING body: many more bytes than the declared Content-Length, delivered in small chunks, with
 * every pull counted — the drain-cap arm asserts the reader STOPPED near the cap (an implementation
 * that drains fully before checking would show ~`chunks` pulls and fail).
 */
function lyingStream(
  chunkSize: number,
  chunks: number,
): {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
} {
  let pulls = 0;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkSize).fill(120));
    },
  });
  return { stream, pulls: () => pulls };
}

function req(overrides: Partial<FileUploadRequest> & { bytes?: Uint8Array }): FileUploadRequest {
  const bytes = overrides.bytes;
  return {
    contentLengthHeader:
      overrides.contentLengthHeader !== undefined
        ? overrides.contentLengthHeader
        : bytes
          ? String(bytes.byteLength)
          : '0',
    contentTypeHeader:
      overrides.contentTypeHeader !== undefined ? overrides.contentTypeHeader : 'text/plain',
    fileNameHeader: overrides.fileNameHeader ?? null,
    body: overrides.body !== undefined ? overrides.body : bytes ? streamOf(bytes) : null,
  };
}

/** A sink whose `emit` ALWAYS throws — models downstream faults on the sealed-divergent heal. */
class ThrowingSink implements FileSubmittedSink {
  emitCount = 0;
  constructor(private readonly toThrow: Error) {}
  async emit(): Promise<void> {
    this.emitCount += 1;
    throw this.toThrow;
  }
}

/** Seed a stored pointer row directly (the unit-test way to reach the sealed/staged arms). */
function seedRow(
  table: SharedFileTable,
  opts: {
    fileId?: string;
    tenantId?: string;
    state: 'uploaded' | 'submitted';
    bytes: Uint8Array;
    contentType?: string;
    originalFilename?: string | null;
  },
): void {
  const fileId = opts.fileId ?? 'f-1';
  const tenantId = opts.tenantId ?? TENANT_A;
  table.rows.push({
    file_id: fileId,
    file_ref: `${tenantId}:${fileId}`,
    state: opts.state,
    sha256: sha256Hex(opts.bytes),
    size_bytes: opts.bytes.byteLength,
    content_type: opts.contentType ?? 'text/plain',
    original_filename: opts.originalFilename ?? null,
    blob_key: `files/${fileId}/${sha256Hex(opts.bytes)}`,
    uploaded_at: '2026-07-04T00:00:00.000Z',
    submitted_at: opts.state === 'submitted' ? '2026-07-04T00:00:01.000Z' : null,
    tenant_id: tenantId,
  });
}

const sink = () => createInMemoryFileSubmittedSink();

/**
 * Wrap a `HandlerDb` so `hook` runs ONCE, immediately BEFORE the first `update` — the
 * deterministic TOCTOU seam (the fakes are single-threaded, so the race interleaving is staged by
 * running the racing operation between the stale read and the guarded write).
 */
function withBeforeFirstUpdate(inner: HandlerDb, hook: () => Promise<void>): HandlerDb {
  let fired = false;
  return {
    ...inner,
    async update(store, filter, patch) {
      if (!fired) {
        fired = true;
        await hook();
      }
      return inner.update(store, filter, patch);
    },
  };
}

describe('uploadFile — the Content-Length PRE-CHECK (before ANY body byte)', () => {
  it('an ABSENT Content-Length is a 413 file_length_required with the body NEVER read, zero puts, zero rows', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const res = await uploadFile(
      ctx(table, bucket),
      { file_id: 'f-1' },
      req({ contentLengthHeader: null, body: poisonedStream() }),
      sink(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(413);
    expect(res.error).toBe('file_length_required');
    expect(bucket.puts).toHaveLength(0);
    expect(table.rows).toHaveLength(0);
  });

  it('a NON-NUMERIC Content-Length is a 413 file_length_required with the body NEVER read', async () => {
    for (const bad of ['abc', '12abc', '-5', '']) {
      const res = await uploadFile(
        ctx(new SharedFileTable(), new SharedBlobBucket()),
        { file_id: 'f-1' },
        req({ contentLengthHeader: bad, body: poisonedStream() }),
        sink(),
      );
      expect(res.ok, `content-length '${bad}'`).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(413);
      expect(res.error).toBe('file_length_required');
    }
  });

  it('a DECLARED length above the cap is a 413 file_too_large with the body NEVER read, zero puts, zero rows', async () => {
    const config = resolveFileConfig({ maxFileBytes: 64 });
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const res = await uploadFile(
      ctx(table, bucket, TENANT_A, config),
      { file_id: 'f-1' },
      req({ contentLengthHeader: '65', body: poisonedStream() }),
      sink(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(413);
    expect(res.error).toBe('file_too_large');
    expect(bucket.puts).toHaveLength(0);
    expect(table.rows).toHaveLength(0);
  });

  it('a declared length EXACTLY at the cap is accepted (the cap is the max allowed)', async () => {
    const config = resolveFileConfig({ maxFileBytes: 64 });
    const bytes = new Uint8Array(64).fill(97);
    const res = await uploadFile(
      ctx(new SharedFileTable(), new SharedBlobBucket(), TENANT_A, config),
      { file_id: 'f-1' },
      req({ bytes }),
      sink(),
    );
    expect(res.ok).toBe(true);
  });
});

describe('uploadFile — the DRAIN-TIME cap (a lying Content-Length must not bypass it)', () => {
  it('a body that EXCEEDS its declared length is aborted AT the cap: 413 file_too_large, zero puts, zero rows, read STOPPED', async () => {
    const config = resolveFileConfig({ maxFileBytes: 64 });
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    // Declares 32 bytes (passes the pre-check) but streams 1000 × 16 B = 16 000 B.
    const lying = lyingStream(16, 1000);
    const res = await uploadFile(
      ctx(table, bucket, TENANT_A, config),
      { file_id: 'f-1' },
      req({ contentLengthHeader: '32', body: lying.stream }),
      sink(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(413);
    expect(res.error).toBe('file_too_large');
    expect(bucket.puts).toHaveLength(0);
    expect(table.rows).toHaveLength(0);
    // The reader stopped at the cap boundary (≈ 64/16 = 4 chunks + slack) — NOT a full drain.
    expect(lying.pulls()).toBeLessThanOrEqual(8);
  });

  it('a body whose cancel() THROWS still yields the deterministic 413 file_too_large (the cancel fault is swallowed)', async () => {
    const config = resolveFileConfig({ maxFileBytes: 64 });
    // An over-cap body whose underlying source's cancel() throws — `reader.cancel()` rejects.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(32).fill(120));
      },
      cancel() {
        throw new Error('transport teardown fault — cancel exploded');
      },
    });
    const res = await uploadFile(
      ctx(new SharedFileTable(), new SharedBlobBucket(), TENANT_A, config),
      { file_id: 'f-1' },
      req({ contentLengthHeader: '32', body: stream }),
      sink(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(413);
    expect(res.error).toBe('file_too_large');
  });

  it('a body SMALLER than its declared Content-Length stores the ACTUAL drained size + sha (never the declared length)', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const bytes = bytesOf('12345'); // 5 real bytes, declared as 1000
    const res = await uploadFile(
      ctx(table, bucket),
      { file_id: 'f-1' },
      req({ contentLengthHeader: '1000', body: streamOf(bytes) }),
      sink(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value).toMatchObject({ size_bytes: 5, sha256: sha256Hex(bytes) });
    expect(table.rows[0]).toMatchObject({ size_bytes: 5, sha256: sha256Hex(bytes) });
  });
});

describe('uploadFile — the content-type allowlist (415 fail-closed, before store)', () => {
  it('a disallowed declared type is a 415 file_type_unsupported with the body NEVER read, zero puts, zero rows', async () => {
    for (const bad of ['application/zip', 'image/png', 'application/octet-stream']) {
      const table = new SharedFileTable();
      const bucket = new SharedBlobBucket();
      const res = await uploadFile(
        ctx(table, bucket),
        { file_id: 'f-1' },
        req({ contentTypeHeader: bad, contentLengthHeader: '4', body: poisonedStream() }),
        sink(),
      );
      expect(res.ok, bad).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(415);
      expect(res.error).toBe('file_type_unsupported');
      expect(bucket.puts, bad).toHaveLength(0);
      expect(table.rows, bad).toHaveLength(0);
    }
  });

  it('an ABSENT content type is a 415 (fail-closed — the deployment accepts only declared, allowlisted types), zero puts, zero rows', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const res = await uploadFile(
      ctx(table, bucket),
      { file_id: 'f-1' },
      req({ contentTypeHeader: null, contentLengthHeader: '4', body: poisonedStream() }),
      sink(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(415);
    expect(res.error).toBe('file_type_unsupported');
    expect(bucket.puts).toHaveLength(0);
    expect(table.rows).toHaveLength(0);
  });

  it('a parameterized/odd-cased declared type normalizes to its media type (accepted + stored normalized)', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const bytes = bytesOf('a,b\n1,2\n');
    const res = await uploadFile(
      ctx(table, bucket),
      { file_id: 'f-1' },
      req({ bytes, contentTypeHeader: 'Text/CSV; charset=UTF-8' }),
      sink(),
    );
    expect(res.ok).toBe(true);
    expect(table.rows[0]).toMatchObject({ content_type: 'text/csv' });
  });
});

describe('uploadFile — file-id validation (422, the record delimiter belt widened for paths)', () => {
  it('rejects invalid shapes incl. path/delimiter ids (422 file_id_invalid), zero puts', async () => {
    const bucket = new SharedBlobBucket();
    for (const bad of ['', 'has space', 'a/b', 'a:b', 'a\\b', '.', '..', 'x'.repeat(129)]) {
      const res = await uploadFile(
        ctx(new SharedFileTable(), bucket),
        { file_id: bad },
        req({ bytes: bytesOf('x') }),
        sink(),
      );
      expect(res.ok, `file_id '${bad}'`).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('file_id_invalid');
    }
    expect(bucket.puts).toHaveLength(0);
  });

  it("the ':' / dot-segment belt holds at the point of use even for a hand-built (resolver-bypassing) config", async () => {
    const config: ResolvedFileConfig = {
      fileIdPattern: /^[a-z:./\\-]{1,64}$/,
      maxFileBytes: 1024,
      allowedContentTypes: new Set(['text/plain']),
    };
    const bucket = new SharedBlobBucket();
    for (const bad of ['a:b', 'a/b', 'a\\b', '..', '.']) {
      const res = await uploadFile(
        ctx(new SharedFileTable(), bucket, TENANT_A, config),
        { file_id: bad },
        req({ bytes: bytesOf('x') }),
        sink(),
      );
      expect(res.ok, `file_id '${bad}'`).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('file_id_invalid');
    }
    expect(bucket.puts).toHaveLength(0);
  });
});

describe('uploadFile — the filename is DATA only', () => {
  it('stores the client filename as a data column; it NEVER appears in any blob key, ref, or id', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const res = await uploadFile(
      ctx(table, bucket),
      { file_id: 'f-1' },
      req({ bytes: bytesOf('hello'), fileNameHeader: 'secret-plans.pdf' }),
      sink(),
    );
    expect(res.ok).toBe(true);
    const contentKey = `files/f-1/${sha256Hex(bytesOf('hello'))}`;
    expect(table.rows[0]).toMatchObject({
      original_filename: 'secret-plans.pdf',
      blob_key: contentKey,
      file_ref: `${TENANT_A}:f-1`,
    });
    // The whole-invariant check: EVERY key the blob store ever saw is the server-derived shape
    // (validated file id + content hash — NEVER a filename fragment).
    expect(bucket.puts).toEqual([`${TENANT_A}/${contentKey}`]);
    for (const key of bucket.keys()) {
      expect(key.includes('secret'), key).toBe(false);
      expect(key).toBe(`${TENANT_A}/${contentKey}`);
    }
  });

  it('an absent filename stores null; a control-char or over-long filename is a 422 file_name_invalid', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const okRes = await uploadFile(
      ctx(table, bucket),
      { file_id: 'f-1' },
      req({ bytes: bytesOf('x'), fileNameHeader: null }),
      sink(),
    );
    expect(okRes.ok).toBe(true);
    expect(table.rows[0]?.original_filename).toBeNull();

    for (const bad of ['evil\u0000name', 'evil\u0001name', 'x'.repeat(256)]) {
      const res = await uploadFile(
        ctx(new SharedFileTable(), new SharedBlobBucket()),
        { file_id: 'f-2' },
        req({ bytes: bytesOf('x'), fileNameHeader: bad }),
        sink(),
      );
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('file_name_invalid');
    }
  });

  it('C1 controls, bidi controls, and zero-width chars in the filename are a 422 file_name_invalid (extension-spoof defense)', async () => {
    const spoofs = [
      'report\u202Efdp.exe', // U+202E RLO bidi override — renders as 'reportexe.pdf'
      'invoice\u202A.pdf', // U+202A LRE bidi embedding
      'inv\u2066oice.pdf', // U+2066 LRI bidi isolate
      'inv\u2069oice.pdf', // U+2069 PDI bidi isolate terminator
      'state\u200Bment.pdf', // U+200B zero-width space
      'join\u200Der.pdf', // U+200D zero-width joiner
      'notes\uFEFF.txt', // U+FEFF zero-width no-break space / BOM
      'evil\u0085name.txt', // U+0085 C1 control (NEL)
      'evil\u009Fname.txt', // U+009F C1 control (APC)
    ];
    for (const bad of spoofs) {
      const table = new SharedFileTable();
      const bucket = new SharedBlobBucket();
      const res = await uploadFile(
        ctx(table, bucket),
        { file_id: 'f-1' },
        req({ bytes: bytesOf('x'), fileNameHeader: bad }),
        sink(),
      );
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('file_name_invalid');
      expect(bucket.puts, JSON.stringify(bad)).toHaveLength(0);
      expect(table.rows, JSON.stringify(bad)).toHaveLength(0);
    }
  });

  it('legitimate unicode filenames (umlauts, CJK, emoji) stay accepted and stored verbatim', async () => {
    const table = new SharedFileTable();
    const name = 'Prüfbericht-会議メモ-📄.txt';
    const res = await uploadFile(
      ctx(table, new SharedBlobBucket()),
      { file_id: 'f-1' },
      req({ bytes: bytesOf('x'), fileNameHeader: name }),
      sink(),
    );
    expect(res.ok).toBe(true);
    expect(table.rows[0]?.original_filename).toBe(name);
  });
});

describe('uploadFile — the state machine (every arm pinned)', () => {
  it('a NEW file_id stores the blob under the server-derived key and writes the pointer row (state uploaded)', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const bytes = bytesOf('hello world');
    const res = await uploadFile(
      ctx(table, bucket),
      { file_id: 'f-1' },
      req({ bytes, fileNameHeader: 'notes.txt' }),
      sink(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value).toEqual({
      file_id: 'f-1',
      state: 'uploaded',
      sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      size_bytes: 11,
      replaced: false,
      deduped: false,
    });
    expect(table.rows).toHaveLength(1);
    const contentKey = `files/f-1/${sha256Hex(bytes)}`;
    expect(table.rows[0]).toMatchObject({
      file_id: 'f-1',
      file_ref: `${TENANT_A}:f-1`,
      state: 'uploaded',
      sha256: sha256Hex(bytes),
      size_bytes: 11,
      content_type: 'text/plain',
      original_filename: 'notes.txt',
      blob_key: contentKey,
      tenant_id: TENANT_A,
    });
    expect(typeof table.rows[0]?.uploaded_at).toBe('string');
    // The bytes landed under the tenant-jailed, server-derived content key with the declared type.
    expect(bucket.puts).toEqual([`${TENANT_A}/${contentKey}`]);
    expect(bucket.objects.get(`${TENANT_A}/${contentKey}`)?.contentType).toBe('text/plain');
  });

  it('an IDENTICAL re-upload while uploaded is an idempotent no-op: same row, NO second blob write, deduped:true', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const bytes = bytesOf('same bytes');
    const c = ctx(table, bucket);
    const first = await uploadFile(c, { file_id: 'f-1' }, req({ bytes }), sink());
    const second = await uploadFile(c, { file_id: 'f-1' }, req({ bytes }), sink());
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.value).toMatchObject({ state: 'uploaded', deduped: true, replaced: false });
    expect(table.rows).toHaveLength(1);
    expect(bucket.puts).toHaveLength(1); // the idempotent arm needs no duplicate write
  });

  it('a DIVERGENT re-upload while STILL uploaded (not sealed) is last-write-wins: blob replaced, row updated', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const c = ctx(table, bucket);
    await uploadFile(c, { file_id: 'f-1' }, req({ bytes: bytesOf('v1') }), sink());
    const second = await uploadFile(
      c,
      { file_id: 'f-1' },
      req({ bytes: bytesOf('v2 — corrected'), fileNameHeader: 'v2.txt' }),
      sink(),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.value).toMatchObject({ state: 'uploaded', replaced: true, deduped: false });
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      sha256: sha256Hex(bytesOf('v2 — corrected')),
      size_bytes: bytesOf('v2 — corrected').byteLength,
      original_filename: 'v2.txt',
      // The row points at the NEW content key — a key always names its own bytes.
      blob_key: `files/f-1/${sha256Hex(bytesOf('v2 — corrected'))}`,
    });
    expect(bucket.puts).toHaveLength(2); // the replace wrote the new content key
    // Both content keys exist (the replaced v1 bytes orphan under their old key — the stated
    // no-GC cut); the ROW is what points at the live one.
    expect(new Set(bucket.keys())).toEqual(
      new Set([
        `${TENANT_A}/files/f-1/${sha256Hex(bytesOf('v1'))}`,
        `${TENANT_A}/files/f-1/${sha256Hex(bytesOf('v2 — corrected'))}`,
      ]),
    );
  });

  it('an IDENTICAL re-upload AFTER seal is an idempotent no-op (state submitted, WHOLE row untouched, zero puts)', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const bytes = bytesOf('sealed bytes');
    seedRow(table, { state: 'submitted', bytes });
    // Pin the FULL row unchanged (whole-row snapshot), not a partial column match — the
    // no-op arm must not touch ANY column (incl. metadata; sha-only dedup freezes it).
    const before = JSON.parse(JSON.stringify(table.rows));
    const res = await uploadFile(ctx(table, bucket), { file_id: 'f-1' }, req({ bytes }), sink());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value).toMatchObject({ state: 'submitted', deduped: true, replaced: false });
    expect(JSON.parse(JSON.stringify(table.rows))).toEqual(before);
    expect(bucket.puts).toHaveLength(0);
  });

  it('a DIVERGENT re-upload AFTER seal is a LOUD 409 file_conflict: zero blob writes, row untouched, stored event healed', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const sealed = bytesOf('sealed v1');
    seedRow(table, { state: 'submitted', bytes: sealed, originalFilename: 'v1.txt' });
    const before = JSON.parse(JSON.stringify(table.rows));
    const s = sink();

    const res = await uploadFile(
      ctx(table, bucket),
      { file_id: 'f-1' },
      req({ bytes: bytesOf('divergent v2') }),
      s,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('file_conflict');
    expect(bucket.puts).toHaveLength(0); // a sealed file is NEVER silently replaced
    expect(JSON.parse(JSON.stringify(table.rows))).toEqual(before);
    // The heal: the STORED authoritative event was re-emitted (a sealed-but-never-enqueued
    // file is healed by any SUBMIT retry or a DIVERGENT upload retry like this one; an IDENTICAL
    // post-seal upload is a pure no-op that does not re-emit) — the divergent request's
    // bytes are NEVER in it.
    expect(s.emitCount()).toBe(1);
    expect(s.deliveredFor(`${TENANT_A}:f-1`)).toMatchObject({
      file_id: 'f-1',
      sha256: sha256Hex(sealed),
      original_filename: 'v1.txt',
      source_capability: 'file_input',
    });
  });

  it('the sealed-divergent 409 heal is BEST-EFFORT: a generic transient sink fault is swallowed (the 409 stands)', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'submitted', bytes: bytesOf('sealed v1') });
    const throwing = new ThrowingSink(new Error('DBOS enqueue unavailable (transient)'));
    const res = await uploadFile(
      ctx(table, new SharedBlobBucket()),
      { file_id: 'f-1' },
      req({ bytes: bytesOf('divergent v2') }),
      throwing,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('file_conflict');
    expect(throwing.emitCount).toBe(1); // the heal WAS attempted (then swallowed best-effort)
  });

  it('the sealed-divergent 409 heal PRESERVES fail-closed: the FileEventRejectedError family propagates (→ 403)', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'submitted', bytes: bytesOf('sealed v1') });
    const rejecting = new ThrowingSink(new FileEventRejectedError('cross_tenant', 'foreign'));
    await expect(
      uploadFile(
        ctx(table, new SharedBlobBucket()),
        { file_id: 'f-1' },
        req({ bytes: bytesOf('divergent v2') }),
        rejecting,
      ),
    ).rejects.toBeInstanceOf(FileEventRejectedError);
  });

  it('accepts an EMPTY file (Content-Length 0, no body) — the neutral layer imposes no non-empty policy', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const res = await uploadFile(
      ctx(table, bucket),
      { file_id: 'f-empty' },
      req({ contentLengthHeader: '0', body: null }),
      sink(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value).toMatchObject({
      size_bytes: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });
});

describe('uploadFile — the upload-racing-submit TOCTOU (arm 1: the state-guarded pre-seal write)', () => {
  it('a submit that SEALS between the upload’s stale read and its row write is NEVER silently overwritten: 409, row keeps the sealed bytes, heal re-emitted', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    const sealedBytes = bytesOf('staged v1 (shaOld)');
    seedRow(table, { state: 'uploaded', bytes: sealedBytes, originalFilename: 'v1.txt' });

    // THE RACE: the upload reads the row while it is still STAGED (divergent → the replace arm),
    // then a concurrent submit SEALS it (and emits on the OLD bytes) before the upload's write.
    const racerSink = sink();
    const db = withBeforeFirstUpdate(makeFakeFileDb(table, TENANT_A), async () => {
      const sealRes = await submitFile(
        { tenantId: TENANT_A, db: makeFakeFileDb(table, TENANT_A), config: resolveFileConfig() },
        { file_id: 'f-1' },
        undefined,
        racerSink,
      );
      expect(sealRes.ok).toBe(true);
    });
    const uploadSink = sink();
    const res = await uploadFile(
      {
        tenantId: TENANT_A,
        db,
        blob: makeFakeBlobStore(bucket, TENANT_A),
        config: resolveFileConfig(),
      },
      { file_id: 'f-1' },
      req({ bytes: bytesOf('divergent v2 (shaX)') }),
      uploadSink,
    );

    // The ROW is untouched: still the SEALED old bytes (the unguarded write would have silently
    // replaced sha/blob_key on the sealed row — exactly the unguarded-write defect).
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      state: 'submitted',
      sha256: sha256Hex(sealedBytes),
      blob_key: `files/f-1/${sha256Hex(sealedBytes)}`,
      original_filename: 'v1.txt',
    });
    // The upload lands on the post-seal divergent path: the LOUD 409 + the heal.
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('file_conflict');
    expect(uploadSink.emitCount()).toBe(1); // the heal re-emitted the STORED event …
    expect(uploadSink.deliveredFor(`${TENANT_A}:f-1`)).toMatchObject({
      sha256: sha256Hex(sealedBytes), // … carrying the SEALED bytes, never the request's shaX
    });
    // The racer's own emit went to ITS sink (one delivery — single-flight downstream).
    expect(racerSink.deliveredCount()).toBe(1);
    // The shaX bytes MAY exist as an orphan under their own content key (the stated no-GC cut) —
    // content-addressed keys keep the sealed row's blob_key pointing at the sealed bytes.
  });
});

describe('uploadFile — tenant isolation by construction (shared table + shared bucket)', () => {
  it('two tenants upload the SAME file_id and both succeed with disjoint refs + disjoint blob keys', async () => {
    const table = new SharedFileTable(); // ONE shared table = the real global unique
    const bucket = new SharedBlobBucket(); // ONE shared bucket = the real shared disk
    const a = await uploadFile(
      ctx(table, bucket, TENANT_A),
      { file_id: 'f-1' },
      req({ bytes: bytesOf('tenant a bytes') }),
      sink(),
    );
    const b = await uploadFile(
      ctx(table, bucket, TENANT_B),
      { file_id: 'f-1' },
      req({ bytes: bytesOf('tenant b bytes') }),
      sink(),
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true); // NO cross-tenant collision (the prefix isolates — the audio pattern)
    expect(table.rows).toHaveLength(2);
    expect(new Set(table.rows.map((r) => r.file_ref))).toEqual(
      new Set([`${TENANT_A}:f-1`, `${TENANT_B}:f-1`]),
    );
    expect(new Set(bucket.keys())).toEqual(
      new Set([
        `${TENANT_A}/files/f-1/${sha256Hex(bytesOf('tenant a bytes'))}`,
        `${TENANT_B}/files/f-1/${sha256Hex(bytesOf('tenant b bytes'))}`,
      ]),
    );
  });
});
