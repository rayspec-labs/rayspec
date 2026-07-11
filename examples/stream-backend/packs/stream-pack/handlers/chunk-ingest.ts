/**
 * Escape-hatch STREAM ingest handler for the synthetic stream backend.
 *
 * This is the PACK-SIDE contract logic — the platform-owned SYNTHETIC forcing-function for the
 * `stream` (mode:'ingest') primitive, NOT product code (a real product pack ships from its own
 * repo). It is `route`-kind (a stream handler dispatches through the api chokepoint) but receives a
 * `StreamRouteHandlerInit` (the raw Web `Request` + the tenant-bound `init.blob` + `init.db` + the
 * route `params`) and returns a raw Web `Response`. The platform provides ONLY the raw-stream plumbing
 * + the tenant-bound capabilities; the 200-ack / 409-gap / 200-no-op CONTRACT below is pack logic.
 *
 * Imports `@rayspec/handler-sdk` TYPE-ONLY (erased at runtime); this dir is in no tsconfig, so tsc
 * never compiles it, and the `gate:handler-imports` tripwire confirms it imports nothing else. The
 * new `gate:extension-capability` confirms it self-constructs NO raw DB/blob backend — every
 * capability is the injected, tenant-bound handle (`init.db` / `init.blob`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE IDEMPOTENT CHUNK-INGEST CONTRACT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A client POSTs one chunk's binary bytes to `/uploads/{upload_id}/chunks/{chunk_index}`. Chunks must
 * arrive IN ORDER per upload; the response tells the client which index to send next. Let
 * `next_expected = watermark + 1` where `watermark` = the highest `chunk_index` already stored for
 * this upload (−1 if none). Then:
 *   - index == next_expected → store the bytes (put-by-index) + the pointer row → 200
 *                              `{ next_expected_index: index + 1 }` (the watermark advanced).
 *   - index <  next_expected → 200 no-op `{ next_expected_index: watermark + 1 }` — an idempotent
 *                              re-POST of an already-stored chunk; we do NOT re-insert (so the row's
 *                              UNIQUE is never even contended on the happy path) and the blob
 *                              put-by-index would be a no-op overwrite anyway. Safe to retry.
 *   - index >  next_expected → 409 `{ error:'gap', next_expected_index }` — a missing earlier chunk.
 *
 * IDEMPOTENCY AUTHORITY = the DB UNIQUE on `chunk_ref` (= `${tenantId}:${upload_id}:${chunk_index}`),
 * NOT a durable run (the chunk ingest is a SYNCHRONOUS request, not an off-request job — the
 * non-idempotent-taint quarantine does NOT cover it). Idempotency rests on (1) the pointer-row UNIQUE
 * + (2) the same-`TenantDb.transaction()` atomicity (the engine opened it) + (3) the blob
 * put-by-index being idempotent. A crash BETWEEN the blob put and the pointer insert does NOT
 * double-append on retry: the blob put-by-index overwrites the same key (idempotent), and the pointer
 * insert is caught by the UNIQUE (a second insert of the same index is a no-op, never a double row).
 * A CONCURRENT same-index race (two POSTs both seeing the same watermark) collides on the UNIQUE: one
 * wins, the other catches the unique violation and returns a 200 no-op — never a 500.
 *
 * The request BODY is UNTRUSTED binary DATA — we treat it as opaque bytes (store them, never
 * interpret them). The path params (`upload_id`, `chunk_index`) are server-parsed strings (DATA).
 */
import type { StreamRouteHandler, StreamRouteHandlerInit } from '@rayspec/handler-sdk';

/** The declared pointer store (see rayspec.yaml). The bytes live in the BlobStore; this records WHERE. */
const POINTER_STORE = 'blob_chunks';

/** A small JSON Response helper (the platform returns this raw Response verbatim — no JSON envelope). */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** True if a thrown DB error is a Postgres UNIQUE violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  // postgres-js surfaces the SQLSTATE on `.code`; the facade rethrows it unwrapped. Be defensive
  // (check both the direct error and a possible `.cause`) so a wrapped error is still recognized.
  const code = (err as { code?: unknown })?.code;
  if (code === '23505') return true;
  const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code;
  return causeCode === '23505';
}

/**
 * Compute the tenant-namespaced derived unique key for one (upload_id, chunk_index) within a tenant.
 * The single-column UNIQUE index on this is GLOBAL, so the tenant prefix is what keeps two tenants'
 * same (upload, index) from colliding (see the store comment in rayspec.yaml). The tenant id is
 * SERVER-DERIVED (`init.tenantId`), never client-supplied.
 */
function chunkRef(tenantId: string, uploadId: string, chunkIndex: number): string {
  return `${tenantId}:${uploadId}:${chunkIndex}`;
}

/** The opaque BlobStore key for one chunk's bytes (put-by-index → idempotent overwrite on retry). */
function storageKey(uploadId: string, chunkIndex: number): string {
  return `${uploadId}/${chunkIndex}`;
}

export const chunkIngest: StreamRouteHandler = async (
  init: StreamRouteHandlerInit,
): Promise<Response> => {
  const uploadId = init.params.upload_id;
  const indexRaw = init.params.chunk_index;
  // Validate the path params (DATA). A non-integer / missing index is a 400 (never a 500).
  if (!uploadId || !indexRaw) {
    return json(400, { error: 'bad_request', detail: 'upload_id and chunk_index are required.' });
  }
  const chunkIndex = Number(indexRaw);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return json(400, {
      error: 'bad_request',
      detail: 'chunk_index must be a non-negative integer.',
    });
  }

  // Read the raw binary body (untrusted opaque bytes). We never call .json() on it.
  const bytes = new Uint8Array(await init.request.arrayBuffer());

  // The watermark for this upload (within THIS tenant — init.db is tenant-scoped by construction).
  // We read every stored chunk for the upload and take the max index. (The store facade has
  // equality-only filters + no aggregate/order, so we compute the max in the handler over the
  // tenant-scoped rows.)
  const existing = await init.db.select(POINTER_STORE, { upload_id: uploadId });
  let watermark = -1;
  for (const row of existing) {
    const idx = Number(row.chunk_index);
    if (Number.isInteger(idx) && idx > watermark) watermark = idx;
  }
  const nextExpected = watermark + 1;

  // index < next_expected → idempotent re-POST of an already-stored chunk. No-op 200 (do NOT re-insert,
  // so the happy path never contends the UNIQUE; the blob is already there / a re-put would be a no-op).
  if (chunkIndex < nextExpected) {
    return json(200, { next_expected_index: nextExpected });
  }

  // index > next_expected → a GAP (a missing earlier chunk). 409, telling the client what to send next.
  if (chunkIndex > nextExpected) {
    return json(409, { error: 'gap', next_expected_index: nextExpected });
  }

  // index == next_expected → store this chunk. Put-by-index FIRST (idempotent — a crash before the
  // pointer insert is safe: a retry re-puts the same key, an overwrite no-op), then the pointer row
  // (the UNIQUE on chunk_ref is the authority).
  const key = storageKey(uploadId, chunkIndex);
  // CONTRACT NOTE (idempotent-per-index presumes IDENTICAL bytes for a given (upload, index)): a
  // same-index CONCURRENT POST with DIFFERENT content is last-writer-wins on the blob and MAY leave
  // the on-disk bytes inconsistent with the pointer row's recorded byte_len/content_type. Hardening
  // (content-address the blob key, or verify the manifest sha against the pointer row) is deferred to
  // playback, when the pointer row becomes the served-bytes authority.
  await init.blob.put(key, bytes, {
    ...(init.request.headers.get('content-type')
      ? { contentType: init.request.headers.get('content-type') as string }
      : {}),
  });
  // The insert runs inside a NESTED `init.db.transaction()` — a SAVEPOINT within the engine's outer
  // TenantDb transaction. This is load-bearing for the CONCURRENT same-index race: a Postgres UNIQUE
  // violation (23505) TAINTS its enclosing (sub)transaction, and postgres-js RE-THROWS it on commit —
  // so catching it WITHOUT a savepoint would still abort+poison the OUTER tx (a 500). Wrapping the
  // insert in a savepoint scopes the violation: only the SAVEPOINT rolls back, the outer tx stays
  // clean, and we return the idempotent 200 no-op (the winner already committed the row + bytes). We
  // must NOT swallow a NON-unique error — that rethrows out (a real fault → the engine's 500).
  try {
    await init.db.transaction(async (tx) => {
      await tx.insert(POINTER_STORE, {
        upload_id: uploadId,
        chunk_index: chunkIndex,
        chunk_ref: chunkRef(init.tenantId, uploadId, chunkIndex),
        storage_key: key,
        byte_len: bytes.length,
        content_type: init.request.headers.get('content-type'),
      });
    });
  } catch (err) {
    // A CONCURRENT same-index POST won the UNIQUE first → this insert is the loser. The savepoint
    // rolled back; the observable state is exactly ONE stored chunk (the winner's). Idempotent 200.
    if (isUniqueViolation(err)) {
      return json(200, { next_expected_index: chunkIndex + 1 });
    }
    throw err;
  }
  // Stored. The watermark advanced — tell the client the next index to send.
  return json(200, { next_expected_index: chunkIndex + 1 });
};
