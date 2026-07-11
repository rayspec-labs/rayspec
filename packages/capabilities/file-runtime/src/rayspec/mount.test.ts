/**
 * The mount fragment: the `MountedAudioCapability`-shaped fragments compose consumes — the
 * capability-owned store, TWO routes as WHOLE tuples (the PUT `{kind:'stream', mode:'ingest'}`
 * upload + the POST `{kind:'handler'}` submit), the resolved handler map — plus the HTTP-facing
 * behavior of the bound handlers driven through a REAL `Request` (raw JSON responses, status
 * mapping incl. the sink-rejection 403 on BOTH transports).
 */
import { createHash } from 'node:crypto';
import type { httpResponse, StreamRouteHandler } from '@rayspec/handler-sdk';
import { describe, expect, it } from 'vitest';
import type { FileSubmittedSink } from '../events.js';
import { createInMemoryFileSubmittedSink, FileEventRejectedError } from '../events.js';
import { fileCapabilityStores } from '../stores.js';
import { makeFakeBlobStore, SharedBlobBucket } from '../test-support/fake-blob.js';
import { makeFakeFileDb, SharedFileTable } from '../test-support/fake-db.js';
import {
  DEFAULT_FILE_BASE_PATH,
  DEFAULT_FILE_HANDLER_IDS,
  type MountedFileCapability,
  mountFileCapability,
} from './mount.js';

const TENANT = 'tenant-aaaa';

interface Harness {
  table: SharedFileTable;
  bucket: SharedBlobBucket;
  mounted: MountedFileCapability;
}

function harness(sink: FileSubmittedSink): Harness {
  return {
    table: new SharedFileTable(),
    bucket: new SharedBlobBucket(),
    mounted: mountFileCapability({ fileSubmittedSink: sink }),
  };
}

/** Drive the UPLOAD handler exactly like the stream interpreter does: a raw Web `Request`. */
async function drivePut(
  h: Harness,
  fileId: string,
  body: Uint8Array | null,
  headers: Record<string, string>,
): Promise<Response> {
  const fn = h.mounted.handlers.get(DEFAULT_FILE_HANDLER_IDS.fileUpload)?.fn;
  if (!fn) throw new Error('upload handler missing');
  const request = new Request(`http://localhost/files/${fileId}`, {
    method: 'PUT',
    headers,
    ...(body ? { body } : {}),
  });
  const init = {
    tenantId: TENANT,
    db: makeFakeFileDb(h.table, TENANT),
    blob: makeFakeBlobStore(h.bucket, TENANT),
    params: { file_id: fileId },
    request,
  };
  return (fn as unknown as StreamRouteHandler)(init as never) as Promise<Response>;
}

async function driveSubmit(h: Harness, fileId: string, body?: unknown): Promise<unknown> {
  const fn = h.mounted.handlers.get(DEFAULT_FILE_HANDLER_IDS.fileSubmit)?.fn;
  if (!fn) throw new Error('submit handler missing');
  const init = {
    tenantId: TENANT,
    db: makeFakeFileDb(h.table, TENANT),
    params: { file_id: fileId },
    ...(body !== undefined ? { body } : {}),
  };
  return fn(init as never);
}

describe('mountFileCapability — the composable fragments', () => {
  it('returns the store, BOTH routes as whole tuples, and the route-kind handler map', () => {
    const mounted = mountFileCapability({
      fileSubmittedSink: createInMemoryFileSubmittedSink(),
    });
    expect(mounted.basePath).toBe(DEFAULT_FILE_BASE_PATH);
    // The mount's stores equal the store-schema function (single source).
    expect(mounted.stores).toEqual(fileCapabilityStores());
    // WHOLE-TUPLE route assertions (the S2 gate law: never just "a route exists").
    expect(mounted.api).toEqual([
      {
        method: 'PUT',
        path: '/files/{file_id}',
        action: { kind: 'stream', handler: 'file_input_upload', mode: 'ingest' },
      },
      {
        method: 'POST',
        path: '/files/{file_id}/submit',
        action: { kind: 'handler', handler: 'file_input_submit' },
      },
    ]);
    expect([...mounted.handlers.keys()].sort()).toEqual(
      ['file_input_submit', 'file_input_upload'].sort(),
    );
    expect(mounted.handlers.get('file_input_upload')?.kind).toBe('route');
    expect(mounted.handlers.get('file_input_submit')?.kind).toBe('route');
  });

  it('honors a basePath override in BOTH mounted routes', () => {
    const mounted = mountFileCapability({
      fileSubmittedSink: createInMemoryFileSubmittedSink(),
      basePath: '/inbox/',
    });
    expect(mounted.api[0]?.path).toBe('/inbox/{file_id}');
    expect(mounted.api[1]?.path).toBe('/inbox/{file_id}/submit');
  });
});

describe('mountFileCapability — the bound handlers over a REAL Request (upload → submit end-to-end)', () => {
  it('uploads bytes then submits: 200 JSON ack, pointer row, blob under the server key, ONE delivered event', async () => {
    const sink = createInMemoryFileSubmittedSink();
    const h = harness(sink);
    const bytes = new TextEncoder().encode('invoice-ish text content');

    const uploadRes = await drivePut(h, 'f-1', bytes, {
      'content-length': String(bytes.byteLength),
      'content-type': 'text/plain',
      'x-file-name': 'q3.txt',
    });
    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as Record<string, unknown>;
    expect(uploadBody).toMatchObject({ file_id: 'f-1', state: 'uploaded', size_bytes: 24 });
    const contentKey = `files/f-1/${createHash('sha256').update(bytes).digest('hex')}`;
    expect(h.bucket.keys()).toEqual([`${TENANT}/${contentKey}`]);

    const submitReturn = await driveSubmit(h, 'f-1');
    expect(submitReturn).toEqual({
      file_id: 'f-1',
      event_id: `${TENANT}:f-1`,
      deduped: false,
    });
    expect(sink.deliveredCount()).toBe(1);
    expect(sink.deliveredFor(`${TENANT}:f-1`)).toMatchObject({
      file_id: 'f-1',
      original_filename: 'q3.txt',
      blob_key: contentKey,
    });
  });

  it('maps an oversize upload to a 413 raw Response through the binding (no body stored)', async () => {
    const h = harness(createInMemoryFileSubmittedSink());
    // The default cap is 25 MiB — declare more WITHOUT sending it (the pre-check rejects on the header).
    const res = await drivePut(h, 'f-1', new TextEncoder().encode('tiny'), {
      'content-length': String(26 * 1024 * 1024),
      'content-type': 'text/plain',
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('file_too_large');
    expect(h.bucket.puts).toHaveLength(0);
  });

  it('maps a disallowed content type to a 415 raw Response through the binding', async () => {
    const h = harness(createInMemoryFileSubmittedSink());
    const bytes = new TextEncoder().encode('PK...zipbytes');
    const res = await drivePut(h, 'f-1', bytes, {
      'content-length': String(bytes.byteLength),
      'content-type': 'application/zip',
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('file_type_unsupported');
  });

  it('maps the submit-route typed errors via httpResponse (409 conflict shape)', async () => {
    const h = harness(createInMemoryFileSubmittedSink());
    const conflict = (await driveSubmit(h, 'f-none')) as ReturnType<typeof httpResponse>;
    expect(conflict).toMatchObject({ status: 409, body: { error: 'file_not_uploaded' } });
  });

  it('maps a sink FileEventRejectedError to the clean deliberate 403 on the SUBMIT transport (never a 500)', async () => {
    const rejecting = {
      emit: async () => {
        throw new FileEventRejectedError('cross_tenant', 'rejected fail-closed (test)');
      },
    };
    const h = harness(rejecting);
    const bytes = new TextEncoder().encode('content');
    await drivePut(h, 'f-1', bytes, {
      'content-length': String(bytes.byteLength),
      'content-type': 'text/plain',
    });
    const res = (await driveSubmit(h, 'f-1')) as ReturnType<typeof httpResponse>;
    expect(res).toMatchObject({ status: 403, body: { error: 'file_event_rejected' } });
    expect(JSON.stringify(res)).toContain('cross_tenant');
  });

  it('maps a sink FileEventRejectedError to a 403 raw Response on the UPLOAD transport (the sealed-divergent heal path)', async () => {
    const rejecting = {
      emit: async () => {
        throw new FileEventRejectedError('cross_tenant', 'rejected fail-closed (test)');
      },
    };
    const h = harness(rejecting);
    // Seed a SEALED row so a divergent re-upload reaches the heal (whose rejection maps to 403).
    h.table.rows.push({
      file_id: 'f-1',
      file_ref: `${TENANT}:f-1`,
      state: 'submitted',
      sha256: '0'.repeat(64),
      size_bytes: 9,
      content_type: 'text/plain',
      original_filename: null,
      blob_key: 'files/f-1',
      uploaded_at: '2026-07-04T00:00:00.000Z',
      submitted_at: '2026-07-04T00:00:01.000Z',
      tenant_id: TENANT,
    });
    const bytes = new TextEncoder().encode('divergent');
    const res = await drivePut(h, 'f-1', bytes, {
      'content-length': String(bytes.byteLength),
      'content-type': 'text/plain',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).error).toBe('file_event_rejected');
  });

  it('a GENUINE sink fault still surfaces (rethrow → the platform 500), not a mapped 403', async () => {
    const faulty = {
      emit: async () => {
        throw new Error('genuine fault');
      },
    };
    const h = harness(faulty);
    const bytes = new TextEncoder().encode('content');
    await drivePut(h, 'f-1', bytes, {
      'content-length': String(bytes.byteLength),
      'content-type': 'text/plain',
    });
    await expect(driveSubmit(h, 'f-1')).rejects.toThrow('genuine fault');
  });
});
