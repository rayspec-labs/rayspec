/**
 * The `file_input.upload` core operation — the BOUNDED single-shot raw-byte ingest. DESIGNED, not
 * mirrored: the audio path's unbounded
 * `await request.arrayBuffer()` is exactly what this must never do — an authenticated caller must
 * not be able to buffer an unbounded body into memory.
 *
 * ── THE BYTE BOUND (two independent layers, both fail-closed) ─────────────────────────────────
 *  1. THE CONTENT-LENGTH PRE-CHECK (the api-auth OIDC-cap pattern): a body-bearing upload MUST
 *     declare a finite, in-budget Content-Length. Absent / non-numeric / negative (or chunked
 *     transfer, which arrives length-less) → 413 `file_length_required` BEFORE a single body byte
 *     is read; a declared length above the cap → 413 `file_too_large`, likewise pre-read.
 *  2. DRAIN-TIME ENFORCEMENT: the body is read CHUNK-WISE with a running byte count; the moment
 *     the count exceeds the cap the read is CANCELLED and the upload is the same 413
 *     `file_too_large` — so a LYING Content-Length buys an attacker at most `cap + one chunk`
 *     bytes of memory, never an unbounded buffer. sha256 is computed over the raw bytes WHILE
 *     draining (one pass).
 *
 * ── THE STATE MACHINE (every arm pinned in upload.test.ts) ────────────────────────────────────
 *  - NEW file_id            → blob put (content-addressed key) + pointer row (state `uploaded`).
 *  - identical re-upload    → idempotent no-op (`deduped: true`; no duplicate blob write) — a
 *    (pre- OR post-seal)      client retry is always safe. Identity is sha-ONLY (deliberate):
 *                             a re-upload of identical bytes with a CHANGED content_type /
 *                             original_filename is dropped as `deduped: true` — the stored
 *                             metadata is FROZEN with the bytes; the correction path is a
 *                             divergent upload (pre-seal) or a new file_id.
 *  - divergent re-upload    → LAST-WRITE-WINS replace (deliberate: the file is not sealed yet, so
 *    pre-seal                 the client correcting its staged bytes is the normal flow; the old
 *                             bytes orphan under their content key — the stated no-GC cut). The
 *                             row write is STATE-GUARDED (`state = 'uploaded'` in the update
 *                             filter): a submit that SEALS the row between this request's
 *                             read and its write makes the write match ZERO rows, and the request
 *                             re-reads + lands on the post-seal arms below — a sealed row is
 *                             never silently overwritten by a stale-read replace.
 *  - divergent re-upload    → LOUD 409 `file_conflict`, row untouched, no blob under the row's
 *    post-seal                key (a race-detected arrival may have already orphaned ITS bytes
 *                             under their own content key — harmless, the stated cut) — a SEALED
 *                             file is never silently replaced. The STORED authoritative event is
 *                             RE-EMITTED best-effort first (the record heal: a
 *                             sealed-but-never-enqueued file is healed by any SUBMIT retry or a
 *                             DIVERGENT upload retry; an IDENTICAL post-seal upload is a pure
 *                             no-op that does NOT re-emit — deliberate, the idempotent read-like
 *                             arm carries no workflow trigger. A generic transient sink fault is
 *                             swallowed — the deterministic 409 stands — while the fail-closed
 *                             `FileEventRejectedError` family propagates so the binding maps it
 *                             to the clean 403).
 *  - KNOWN CAVEAT — first-upload TOCTOU: a concurrent FIRST upload
 *    that read "no row" and lands its upsert AFTER another client created+sealed the same
 *    file_ref RESETS the sealed row to `uploaded` (the conflict arm repoints sha/blob_key). The
 *    enqueued run + the sealed bytes stay consistent (content-addressed blob + emitted event);
 *    only the row pointer diverges. Structural close = a conditional-upsert seam in the platform
 *    store facade.
 *
 * ── CONSISTENCY (why the blob key carries the sha) ────────────────────────────────────────────
 * The pointer row and the blob share no transaction. With a content-addressed key
 * (`files/${fileId}/${sha256}`, keys.ts) a key immutably names its bytes, so the row's `blob_key`
 * always resolves to bytes matching its `sha256` under any put/upsert interleaving of concurrent
 * uploads. The put runs FIRST, the row write second: a crash between them leaves an orphaned
 * blob (the stated cut), never a row pointing at missing/mismatched bytes.
 *
 * TRUST BOUNDARY: the body/headers are UNTRUSTED CALLER DATA — bounded, hashed, and stored as bytes/DATA
 * columns; no model call, no instruction interpretation, no tenant signal (the tenant is
 * server-derived). The declared content type is allowlist-CHECKED (fail-closed 415) but stored as
 * ADVISORY data — the parser sniffs magic bytes and never trusts it.
 */
import { createHash } from 'node:crypto';
import type { StoreRow } from '@rayspec/handler-sdk';
import { err, type FileCapabilityResult, ok } from './errors.js';
import { FileEventRejectedError, type FileSubmittedSink } from './events.js';
import { fileBlobKey, fileRef } from './keys.js';
import type { FileBlobContext, FileParams, FileUploadRequest } from './ports.js';
import { submittedFileEventFromRow } from './row-event.js';
import { FILE_UPLOADS_STORE } from './stores.js';
import type { FileUploadResult } from './types.js';
import { validateFileId } from './validate.js';

/** A strict digit-run Content-Length (rejects '', '-5', '12abc', '1e3' — the OIDC-cap posture). */
const CONTENT_LENGTH_RE = /^\d{1,15}$/;

/** The filename DATA-shape bound: printable, ≤ 255 chars (a data column, never a key). */
const FILE_NAME_MAX_CHARS = 255;

/**
 * True if `value` carries a control or invisible char — rejected in a filename (DATA shape):
 * C0 controls + DEL, C1 controls (0x80–0x9F), bidi controls (U+202A–U+202E embeddings/overrides,
 * U+2066–U+2069 isolates — the RLO extension-spoof class: 'report\u202Efdp.exe' RENDERS as
 * 'reportexe.pdf'), and zero-width chars (U+200B–U+200D, U+FEFF). Legitimate unicode (umlauts,
 * CJK, emoji) stays accepted — this is a shape bound, not an ASCII allowlist.
 */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true; // C0 + DEL
    if (code >= 0x80 && code <= 0x9f) return true; // C1
    if (code >= 0x202a && code <= 0x202e) return true; // bidi embeddings/overrides
    if (code >= 0x2066 && code <= 0x2069) return true; // bidi isolates
    if ((code >= 0x200b && code <= 0x200d) || code === 0xfeff) return true; // zero-width + BOM
  }
  return false;
}

interface DrainedBody {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/**
 * Drain `body` chunk-wise under `cap`, hashing while reading. Returns 'over_cap' the moment the
 * running count exceeds the cap (the read is cancelled — a lying Content-Length never buys an
 * unbounded buffer). A null body is an empty file.
 */
async function drainBounded(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<DrainedBody | 'over_cap'> {
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (body !== null) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > cap) {
        try {
          await reader.cancel('file byte cap exceeded (drain-time enforcement)');
        } catch {
          // A throwing cancel is a transport-teardown fault — the cap decision is already
          // made and the deterministic 413 must stand; there is nothing to recover here.
        }
        return 'over_cap';
      }
      hash.update(value);
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * The SEALED-row outcomes — ONE implementation shared by the pre-checked sealed path and the
 * state-guarded write's zero-match re-read, so the race-detected path is
 * behavior-identical to the pre-checked one: identical bytes → the idempotent no-op; divergent
 * bytes → the stored-event heal + the LOUD 409 (the module header's state machine).
 */
async function sealedRowOutcome(
  tenantId: string,
  sink: FileSubmittedSink,
  fileId: string,
  sha256: string,
  sizeBytes: number,
  row: StoreRow,
): Promise<FileCapabilityResult<FileUploadResult>> {
  if (row.sha256 === sha256) {
    // A post-seal retry of the same bytes — idempotent no-op (the upload already succeeded).
    return ok({
      file_id: fileId,
      state: 'submitted',
      sha256,
      size_bytes: sizeBytes,
      replaced: false,
      deduped: true,
    });
  }
  // THE STORED-EVENT HEAL (best-effort — the record heal rationale): before the loud 409, re-emit
  // the STORED authoritative event. If a prior submit crashed between its seal and its emit,
  // a corrected-bytes retry lands HERE — without the re-emit the sealed file would silently
  // never get its workflow run. The emit is idempotent downstream (file-scoped event_id →
  // `file_id:<id>` → the same durable run) — zero double-run. A TRANSIENT sink fault must
  // not turn the deterministic, PERMANENT 409 into a 500 (a retrying client → a 500 storm),
  // so it is SWALLOWED; the fail-closed `FileEventRejectedError` family (the bridge's
  // cross-tenant assertion) is LAW, not a fault — it propagates to the binding's clean 403.
  try {
    await sink.emit(submittedFileEventFromRow(tenantId, row));
  } catch (e) {
    if (e instanceof FileEventRejectedError) throw e; // fail-closed cross-tenant → 403
    // Best-effort: swallow a transient sink/DBOS fault; the deterministic 409 stands.
  }
  return err(
    409,
    'file_conflict',
    `file '${fileId}' was already submitted with DIFFERENT bytes — a sealed file is never ` +
      'replaced (the stored bytes are authoritative and were NOT changed). Upload new data ' +
      'under a new file_id.',
  );
}

/**
 * Ingest one file's raw bytes for (tenant, file_id). Returns a typed result the binding maps to a
 * raw Response. See the module header for the byte bound + the state machine. A sink's deliberate
 * fail-closed rejection (`FileEventRejectedError`, reachable via the sealed-divergent heal)
 * propagates — the route binding owns the 403 mapping.
 */
export async function uploadFile(
  ctx: FileBlobContext,
  params: FileParams,
  request: FileUploadRequest,
  sink: FileSubmittedSink,
): Promise<FileCapabilityResult<FileUploadResult>> {
  const idResult = validateFileId(ctx.config, params);
  if (!idResult.ok) return idResult;
  const fileId = idResult.value;

  // (1) THE CONTENT-LENGTH PRE-CHECK — before ANY body byte (see the module header).
  const lenHeader = request.contentLengthHeader?.trim();
  if (lenHeader === undefined || lenHeader === null || !CONTENT_LENGTH_RE.test(lenHeader)) {
    return err(
      413,
      'file_length_required',
      'the upload must declare a finite numeric Content-Length (absent, non-numeric, and ' +
        'chunked/unbounded bodies are rejected before any byte is read — fail-closed).',
    );
  }
  const declaredLength = Number(lenHeader);
  if (declaredLength > ctx.config.maxFileBytes) {
    return err(
      413,
      'file_too_large',
      `the declared Content-Length exceeds the ${ctx.config.maxFileBytes}-byte bound for one file.`,
    );
  }

  // (2) THE CONTENT-TYPE ALLOWLIST — fail-closed 415 BEFORE any read/store. The media type is
  // normalized (parameters stripped, lowercased) for the CHECK and stored in that normalized form
  // as ADVISORY data (never trusted — the parser sniffs magic bytes).
  const rawType = request.contentTypeHeader;
  const mediaType =
    rawType === undefined || rawType === null
      ? ''
      : (rawType.split(';')[0] ?? '').trim().toLowerCase();
  if (mediaType === '' || !ctx.config.allowedContentTypes.has(mediaType)) {
    return err(
      415,
      'file_type_unsupported',
      `the declared content type is not accepted — allowed: ${[...ctx.config.allowedContentTypes]
        .sort()
        .join(', ')} (fail-closed; declare the media type of the uploaded document).`,
    );
  }

  // (3) The optional client filename — DATA ONLY: shape-bounded here, stored as an
  // escaped column, NEVER a key/path/id component.
  const rawName = request.fileNameHeader;
  let originalFilename: string | null = null;
  if (rawName !== undefined && rawName !== null && rawName !== '') {
    if (rawName.length > FILE_NAME_MAX_CHARS || hasControlChars(rawName)) {
      return err(
        422,
        'file_name_invalid',
        `the x-file-name header must be printable and at most ${FILE_NAME_MAX_CHARS} characters ` +
          '(it is stored as data alongside the file, never used as a path).',
      );
    }
    originalFilename = rawName;
  }

  // (4) DRAIN under the cap, hashing in the same pass (layer 2 of the byte bound).
  const drained = await drainBounded(request.body, ctx.config.maxFileBytes);
  if (drained === 'over_cap') {
    return err(
      413,
      'file_too_large',
      `the request body exceeds the ${ctx.config.maxFileBytes}-byte bound (the declared ` +
        'Content-Length was not honored — the read was aborted at the cap).',
    );
  }
  const { bytes, sha256 } = drained;

  // (5) THE STATE MACHINE (tenant-scoped by construction: the facade is tenant-bound AND the ref
  // embeds the server-derived tenant).
  const ref = fileRef(ctx.tenantId, fileId);
  const blobKey = fileBlobKey(fileId, sha256);
  const existing = await ctx.db.select(FILE_UPLOADS_STORE, { file_ref: ref }, { limit: 1 });
  const found = existing[0];
  const nowIso = new Date().toISOString();

  if (found !== undefined) {
    if (found.state === 'submitted') {
      return sealedRowOutcome(ctx.tenantId, sink, fileId, sha256, bytes.byteLength, found);
    }
    if (found.sha256 === sha256) {
      // Identical staged re-upload — idempotent no-op (the content-addressed blob already holds
      // these exact bytes; no duplicate write needed).
      return ok({
        file_id: fileId,
        state: 'uploaded',
        sha256,
        size_bytes: bytes.byteLength,
        replaced: false,
        deduped: true,
      });
    }
    // Divergent re-upload while STILL staged — LAST-WRITE-WINS (deliberate; see module header).
    // Put the new bytes under their OWN content key first, then repoint the row; the old bytes
    // orphan under their old key (the stated no-GC cut). The repoint is STATE-GUARDED:
    // `state = 'uploaded'` in the update FILTER means it may only land on a row that is STILL
    // staged — a submit that sealed the row between our read above and this write matches ZERO
    // rows instead of silently overwriting the sealed row (the facade's update ANDs the filter
    // columns and returns the affected rows; the fake reproduces exactly that).
    await ctx.blob.put(blobKey, bytes, { contentType: mediaType });
    const repointed = await ctx.db.update(
      FILE_UPLOADS_STORE,
      { file_ref: ref, state: 'uploaded' },
      {
        sha256,
        size_bytes: bytes.byteLength,
        content_type: mediaType,
        original_filename: originalFilename,
        blob_key: blobKey,
        uploaded_at: nowIso,
      },
    );
    if (repointed.length === 0) {
      // The race detected: the row is no longer STAGED. Re-read and dispatch on the row as it
      // NOW stands (our bytes above stay orphaned under their own content key — the stated cut).
      const reread = await ctx.db.select(FILE_UPLOADS_STORE, { file_ref: ref }, { limit: 1 });
      const current = reread[0];
      if (current === undefined) {
        // The same fail-closed posture submit's vanished-row arm takes.
        throw new Error('file-runtime upload: pointer row vanished mid-upload (fail-closed).');
      }
      if (current.state === 'submitted') {
        return sealedRowOutcome(ctx.tenantId, sink, fileId, sha256, bytes.byteLength, current);
      }
      // Still staged yet zero rows matched — REACHABLE via the select-then-upsert TOCTOU of a
      // concurrent FIRST upload: the NEW-file arm's upsert conflict arm resets a just-sealed row
      // to 'uploaded' (and repoints sha/blob_key) — the module header's KNOWN CAVEAT (structural
      // close = a conditional-upsert seam in the platform
      // store facade). The enqueued run + the sealed bytes stay consistent (content-addressed
      // blob + emitted event); only the row pointer diverges. Fail closed here rather than guess.
      throw new Error('file-runtime upload: pointer row changed shape mid-upload (fail-closed).');
    }
    return ok({
      file_id: fileId,
      state: 'uploaded',
      sha256,
      size_bytes: bytes.byteLength,
      replaced: true,
      deduped: false,
    });
  }

  // NEW file: blob put FIRST (idempotent by content key — a crash before the row write leaves an
  // orphaned blob, never a dangling row), then the ATOMIC upsert on the tenant-prefixed unique
  // ref (db.upsert ONLY — never insert-and-recover; the C10 25P02 law). A concurrent first-upload
  // converges here (last write wins pre-seal, and every row always names ITS OWN bytes — the
  // content-key consistency law).
  await ctx.blob.put(blobKey, bytes, { contentType: mediaType });
  await ctx.db.upsert(FILE_UPLOADS_STORE, ['file_ref'], {
    file_id: fileId,
    file_ref: ref,
    state: 'uploaded',
    sha256,
    size_bytes: bytes.byteLength,
    content_type: mediaType,
    original_filename: originalFilename,
    blob_key: blobKey,
    uploaded_at: nowIso,
    submitted_at: null,
  });
  return ok({
    file_id: fileId,
    state: 'uploaded',
    sha256,
    size_bytes: bytes.byteLength,
    replaced: false,
    deduped: false,
  });
}
