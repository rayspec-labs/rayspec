/**
 * The submit core — seal + emit over the byte-backed pointer row (the record durability recipe):
 * deterministic tenant-scoped event id; idempotent re-submit that RE-EMITS (redelivery); the event
 * built from the STORED row only (never a request); divergent sha-assertion → loud 409 (with the
 * stored-event heal on a sealed row, best-effort, cross-tenant family preserved); nothing
 * staged → 409 file_not_uploaded (also the non-disclosing foreign-tenant shape).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type ResolvedFileConfig, resolveFileConfig } from './config.js';
import {
  createInMemoryFileSubmittedSink,
  FileEventRejectedError,
  type FileSubmittedSink,
} from './events.js';
import type { FileCoreContext, FileUploadRequest, HandlerDb } from './ports.js';
import { submitFile } from './submit.js';
import { makeFakeBlobStore, SharedBlobBucket } from './test-support/fake-blob.js';
import { makeFakeFileDb, SharedFileTable } from './test-support/fake-db.js';
import { uploadFile } from './upload.js';

const TENANT_A = 'tenant-aaaa';
const TENANT_B = 'tenant-bbbb';

function ctx(
  table: SharedFileTable,
  tenantId = TENANT_A,
  config?: ResolvedFileConfig,
): FileCoreContext {
  return {
    tenantId,
    db: makeFakeFileDb(table, tenantId),
    config: config ?? resolveFileConfig(),
  };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');
}

function seedRow(
  table: SharedFileTable,
  opts: {
    fileId?: string;
    tenantId?: string;
    state: 'uploaded' | 'submitted';
    text?: string;
    originalFilename?: string | null;
  },
): void {
  const fileId = opts.fileId ?? 'f-1';
  const tenantId = opts.tenantId ?? TENANT_A;
  const text = opts.text ?? 'file body v1';
  table.rows.push({
    file_id: fileId,
    file_ref: `${tenantId}:${fileId}`,
    state: opts.state,
    sha256: sha256Hex(text),
    size_bytes: new TextEncoder().encode(text).byteLength,
    content_type: 'text/plain',
    original_filename: opts.originalFilename ?? 'v1.txt',
    blob_key: `files/${fileId}`,
    uploaded_at: '2026-07-04T00:00:00.000Z',
    submitted_at: opts.state === 'submitted' ? '2026-07-04T00:00:01.000Z' : null,
    tenant_id: tenantId,
  });
}

/** A sink whose `emit` ALWAYS throws — models downstream faults per path. */
class ThrowingSink implements FileSubmittedSink {
  emitCount = 0;
  constructor(private readonly toThrow: Error) {}
  async emit(): Promise<void> {
    this.emitCount += 1;
    throw this.toThrow;
  }
}

const sink = () => createInMemoryFileSubmittedSink();

/**
 * Wrap a `HandlerDb` so `hook` runs ONCE, immediately BEFORE the first `update` — the
 * deterministic TOCTOU seam (the fakes are single-threaded, so the race interleaving is staged by
 * running the racing operation between submit's decision read and its seal write).
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

/** A raw upload request over `text` (the racing REAL uploadFile needs transport pieces). */
function rawUploadReq(text: string): FileUploadRequest {
  const bytes = new TextEncoder().encode(text);
  return {
    contentLengthHeader: String(bytes.byteLength),
    contentTypeHeader: 'text/plain',
    fileNameHeader: null,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

describe('submitFile — seal + emit (the durability recipe)', () => {
  it('the FIRST submit seals the staged row and emits the file-scoped event built from the STORED row', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'uploaded', text: 'file body v1', originalFilename: 'report.txt' });
    const s = sink();

    const res = await submitFile(ctx(table), { file_id: 'f-1' }, undefined, s);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value).toEqual({
      file_id: 'f-1',
      event_id: `${TENANT_A}:f-1`,
      deduped: false,
    });
    // The row is SEALED.
    expect(table.rows[0]).toMatchObject({ state: 'submitted' });
    expect(typeof table.rows[0]?.submitted_at).toBe('string');
    // The event carries the STORED metadata — every payload field from the row, bytes NEVER.
    expect(s.emitCount()).toBe(1);
    expect(s.deliveredFor(`${TENANT_A}:f-1`)).toMatchObject({
      event_id: `${TENANT_A}:f-1`,
      tenant_id: TENANT_A,
      file_id: 'f-1',
      sha256: sha256Hex('file body v1'),
      size_bytes: 12,
      content_type: 'text/plain',
      original_filename: 'report.txt',
      blob_key: 'files/f-1',
      source_capability: 'file_input',
    });
    expect(typeof s.deliveredFor(`${TENANT_A}:f-1`)?.occurred_at).toBe('string');
  });

  it('an IDENTICAL re-submit RE-EMITS the deduped event (redelivery) — one delivered event (C10)', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'uploaded' });
    const s = sink();

    const first = await submitFile(ctx(table), { file_id: 'f-1' }, undefined, s);
    const second = await submitFile(ctx(table), { file_id: 'f-1' }, undefined, s);
    expect(first.ok && !first.value.deduped).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.value.deduped).toBe(true);
    expect(second.value.event_id).toBe(`${TENANT_A}:f-1`);
    expect(s.emitCount()).toBe(2); // the re-submit RE-EMITTED …
    expect(s.deliveredCount()).toBe(1); // … and the sink deduped to ONE delivery (C10)
    expect(table.rows).toHaveLength(1);
  });

  it('submit with NOTHING staged is a 409 file_not_uploaded with zero emit', async () => {
    const table = new SharedFileTable();
    const s = sink();
    const res = await submitFile(ctx(table), { file_id: 'f-none' }, undefined, s);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('file_not_uploaded');
    expect(s.emitCount()).toBe(0);
  });

  it("a FOREIGN tenant's file id yields the SAME non-disclosing 409 file_not_uploaded (tenant-scoped reads), zero emit, foreign row untouched", async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'uploaded', tenantId: TENANT_A });
    const s = sink();
    const res = await submitFile(ctx(table, TENANT_B), { file_id: 'f-1' }, undefined, s);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('file_not_uploaded');
    expect(s.emitCount()).toBe(0);
    expect(table.rows[0]).toMatchObject({ state: 'uploaded', tenant_id: TENANT_A });
  });
});

describe('submitFile — the closed body shape (no spoof channel)', () => {
  it('accepts an absent body and an empty object body', async () => {
    for (const body of [undefined, {}]) {
      const table = new SharedFileTable();
      seedRow(table, { state: 'uploaded' });
      const res = await submitFile(ctx(table), { file_id: 'f-1' }, body, sink());
      expect(res.ok, JSON.stringify(body)).toBe(true);
    }
  });

  it('rejects a non-object body (422 invalid_submit_body)', async () => {
    for (const body of [null, 42, 'text', ['a']]) {
      const table = new SharedFileTable();
      seedRow(table, { state: 'uploaded' });
      const res = await submitFile(ctx(table), { file_id: 'f-1' }, body, sink());
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_submit_body');
    }
  });

  it('rejects ANY unknown key (the whole-invariant spoof guard: the payload is server-derived only)', async () => {
    for (const body of [
      { file_id: 'spoof' },
      { tenant_id: 'spoof' },
      { source_capability: 'spoof' },
      { blob_key: 'spoof' },
      { anything: 1 },
    ]) {
      const table = new SharedFileTable();
      seedRow(table, { state: 'uploaded' });
      const res = await submitFile(ctx(table), { file_id: 'f-1' }, body, sink());
      expect(res.ok, JSON.stringify(body)).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_submit_body');
    }
  });

  it('rejects a malformed sha256 assertion (not 64-hex) as 422', async () => {
    for (const bad of ['zzz', '', 42, 'deadbeef']) {
      const table = new SharedFileTable();
      seedRow(table, { state: 'uploaded' });
      const res = await submitFile(ctx(table), { file_id: 'f-1' }, { sha256: bad }, sink());
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_submit_body');
    }
  });

  it('a MATCHING sha256 assertion submits normally (the integrity handshake)', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'uploaded', text: 'file body v1' });
    const s = sink();
    const res = await submitFile(
      ctx(table),
      { file_id: 'f-1' },
      { sha256: sha256Hex('file body v1') },
      s,
    );
    expect(res.ok).toBe(true);
    expect(s.emitCount()).toBe(1);
  });
});

describe('submitFile — the divergence contract (409 file_conflict)', () => {
  it('a DIVERGENT sha256 assertion against a STAGED (unsealed) row is a 409 with ZERO emit and zero state change', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'uploaded', text: 'file body v1' });
    const s = sink();
    const res = await submitFile(
      ctx(table),
      { file_id: 'f-1' },
      { sha256: sha256Hex('DIFFERENT BYTES') },
      s,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('file_conflict');
    expect(s.emitCount()).toBe(0); // nothing sealed → nothing to heal
    expect(table.rows[0]).toMatchObject({ state: 'uploaded' });
  });

  it('a DIVERGENT sha256 assertion against a SEALED row is a 409 AND the STORED event is healed (re-emitted)', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'submitted', text: 'file body v1' });
    const s = sink();
    const res = await submitFile(
      ctx(table),
      { file_id: 'f-1' },
      { sha256: sha256Hex('DIFFERENT BYTES') },
      s,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('file_conflict');
    // The stored-event heal: the STORED authoritative event reaches the sink exactly once.
    expect(s.emitCount()).toBe(1);
    expect(s.deliveredFor(`${TENANT_A}:f-1`)).toMatchObject({
      sha256: sha256Hex('file body v1'),
    });
  });

  it('the sealed-divergent 409 heal is BEST-EFFORT (generic sink fault swallowed; the 409 stands)', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'submitted', text: 'file body v1' });
    const throwing = new ThrowingSink(new Error('DBOS enqueue unavailable (transient)'));
    const res = await submitFile(
      ctx(table),
      { file_id: 'f-1' },
      { sha256: sha256Hex('DIFFERENT BYTES') },
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
    seedRow(table, { state: 'submitted', text: 'file body v1' });
    const rejecting = new ThrowingSink(new FileEventRejectedError('cross_tenant', 'foreign'));
    await expect(
      submitFile(
        ctx(table),
        { file_id: 'f-1' },
        { sha256: sha256Hex('DIFFERENT BYTES') },
        rejecting,
      ),
    ).rejects.toBeInstanceOf(FileEventRejectedError);
  });
});

describe('submitFile — the divergent-upload-racing-submit TOCTOU (arm 2: the re-read consistency guard)', () => {
  it('a divergent upload that replaces the STAGED bytes between submit’s read and its seal yields a 409 with ZERO emit (never an event for bytes the request did not verify)', async () => {
    const table = new SharedFileTable();
    const bucket = new SharedBlobBucket();
    seedRow(table, { state: 'uploaded', text: 'file body v1' }); // shaOld

    // THE RACE: the submit's integrity decision reads shaOld, then a DIVERGENT upload
    // legitimately replaces the still-staged bytes (shaX, no emit) before the seal lands.
    const db = withBeforeFirstUpdate(makeFakeFileDb(table, TENANT_A), async () => {
      const replaced = await uploadFile(
        {
          tenantId: TENANT_A,
          db: makeFakeFileDb(table, TENANT_A),
          blob: makeFakeBlobStore(bucket, TENANT_A),
          config: resolveFileConfig(),
        },
        { file_id: 'f-1' },
        rawUploadReq('RACED replacement bytes (shaX)'),
        sink(),
      );
      expect(replaced.ok).toBe(true); // a pre-seal divergent replace is the NORMAL flow
    });
    const s = sink();
    const res = await submitFile(
      { tenantId: TENANT_A, db, config: resolveFileConfig() },
      { file_id: 'f-1' },
      { sha256: sha256Hex('file body v1') }, // the 409-decision basis was shaOld
      s,
    );

    // ZERO emit: the sealed row now holds shaX — bytes this request's integrity decision NEVER
    // saw. Emitting them would start a workflow on unverified bytes (the re-read-consistency defect).
    expect(s.emitCount()).toBe(0);
    expect(s.deliveredFor(`${TENANT_A}:f-1`)).toBeUndefined();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('file_conflict');
    // Liveness is NOT lost (the donor's no-heal-here rationale): any later submit retry lands on
    // the stable divergent/identical paths, which heal/emit the stored event.
    const retry = await submitFile(
      { tenantId: TENANT_A, db: makeFakeFileDb(table, TENANT_A), config: resolveFileConfig() },
      { file_id: 'f-1' },
      undefined,
      s,
    );
    expect(retry.ok).toBe(true);
    expect(s.deliveredFor(`${TENANT_A}:f-1`)).toMatchObject({
      sha256: sha256Hex('RACED replacement bytes (shaX)'),
    });
  });
});

describe('submitFile — emit faults on the PRIMARY paths surface (the liveness decision, donor-faithful)', () => {
  it('a transient sink fault on the FIRST submit PROPAGATES (the row stays sealed; the retry re-emits)', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'uploaded' });
    const throwing = new ThrowingSink(new Error('DBOS enqueue unavailable (transient)'));
    await expect(submitFile(ctx(table), { file_id: 'f-1' }, undefined, throwing)).rejects.toThrow(
      'DBOS enqueue unavailable',
    );
    // Both postures (deliberately): under THIS unit-fake posture the db auto-commits, so
    // the seal persisted (non-atomic persist-then-emit) and the retry lands on the re-submit
    // path, which re-emits. Under the REAL-PLATFORM posture the route runs inside the engine's
    // tenant transaction, so the surfaced fault rolls the seal back and the retry re-seals from
    // 'uploaded'. No silent zero-run either way — the assertion below pins the unit-fake half.
    expect(table.rows[0]).toMatchObject({ state: 'submitted' });
  });

  it('DECISION (documented): the IDENTICAL re-submit re-emit is DELIBERATELY NOT best-effort — a transient fault SURFACES so the client keeps retrying until the file is enqueued (swallowing it would re-open the silent zero-run)', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'submitted' });
    const throwing = new ThrowingSink(new Error('DBOS enqueue unavailable (transient)'));
    await expect(submitFile(ctx(table), { file_id: 'f-1' }, undefined, throwing)).rejects.toThrow(
      'DBOS enqueue unavailable',
    );
  });

  it('a FileEventRejectedError on the first submit propagates (the binding maps it to the clean 403)', async () => {
    const table = new SharedFileTable();
    seedRow(table, { state: 'uploaded' });
    const rejecting = new ThrowingSink(new FileEventRejectedError('cross_tenant', 'foreign'));
    await expect(
      submitFile(ctx(table), { file_id: 'f-1' }, undefined, rejecting),
    ).rejects.toBeInstanceOf(FileEventRejectedError);
  });
});

describe('submitFile — file-id validation (the construction belt, point of use)', () => {
  it('rejects invalid shapes (422 file_id_invalid) with zero emit', async () => {
    for (const bad of ['', 'has space', 'a:b', 'a/b', '..', '.']) {
      const s = sink();
      const res = await submitFile(ctx(new SharedFileTable()), { file_id: bad }, undefined, s);
      expect(res.ok, `file_id '${bad}'`).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('file_id_invalid');
      expect(s.emitCount()).toBe(0);
    }
  });

  it("the ':' belt holds even for a hand-built (resolver-bypassing) config", async () => {
    const config: ResolvedFileConfig = {
      fileIdPattern: /^[a-z:-]{1,64}$/,
      maxFileBytes: 1024,
      allowedContentTypes: new Set(['text/plain']),
    };
    const res = await submitFile(
      ctx(new SharedFileTable(), TENANT_A, config),
      { file_id: 'a:b' },
      undefined,
      sink(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(422);
    expect(res.error).toBe('file_id_invalid');
  });
});
