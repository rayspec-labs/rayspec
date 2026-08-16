/**
 * Escape-hatch STREAM playback handler for the synthetic stream backend.
 *
 * This is the PACK-SIDE contract logic — the platform-owned SYNTHETIC forcing-function for the
 * `stream` (mode:'playback') primitive, NOT product code (a real product pack ships from its own
 * repo). It is `route`-kind (a stream handler dispatches through the api chokepoint) but receives a
 * `StreamRouteHandlerInit` (the raw Web `Request` + the tenant-bound `init.blob`/`init.db` + the route
 * `params` + the verified-but-NOT-trusted media `resource` claim) and returns a raw Web `Response`.
 * The platform provides ONLY the tenant-bound capabilities + the media-JWT verification (at the route's
 * middleware tuple); the Range/206 + conditional-GET + 416 CONTRACT and the DB ownership re-validation
 * below are pack logic. Zero media/audio vocabulary enters the platform.
 *
 * Imports `@rayspec/handler-sdk` TYPE-ONLY (erased at runtime); the `gate:handler-imports` +
 * `gate:extension-capability` tripwires confirm it imports nothing else + self-constructs no raw
 * capability (it serves bytes ONLY through the injected, tenant-bound `init.blob`/`init.db`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE SECURITY CONTRACT — never serve bytes off a self-asserted tenant claim.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The media-JWT verifier already set the run's SERVER-DERIVED `init.tenantId` from the token's claim
 * and surfaced the token's OPAQUE `init.mediaResource`. This handler MUST still:
 *   1. BIND the token to the requested route resource — the token's `resource` claim MUST equal the
 *      storage key the route addresses (`${upload_id}/${chunk_index}`). A token minted for resource A
 *      cannot be replayed against route B (even within the same tenant) — a mismatch is 403.
 *   2. RE-VALIDATE OWNERSHIP IN THE DB — look up the pointer row for `(upload_id, chunk_index)` through
 *      the tenant-bound `init.db` (auto-scoped to `init.tenantId`). A resource NOT owned by the token's
 *      tenant is INVISIBLE (the tenant-scoped read returns no row) → 404. This is what makes a
 *      tenant-A token against tenant-B's blob FAIL: B's pointer rows are not visible under A's tenant
 *      scope, so the lookup finds nothing and we 404 — we never reach the blob. The `storage_key` we
 *      stream is the one RECORDED IN THE DB row (the authority), not one the caller supplied.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE UPLOADED CONTENT-TYPE IS DATA — never a served document type (#442).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The ingest handler records the uploader's declared `Content-Type` on the pointer row. Serving that
 * back verbatim would make this route a stored-XSS primitive: upload a body declaring `text/html`,
 * request it back, and a `<script>` inside it runs as a live document on the deployment's OWN origin.
 * So playback NEVER reflects it. The recorded type is only a LOOKUP KEY into a small allowlist of
 * inert media containers (`servedContentType` below serves the allowlist's own canonical string —
 * never the recorded one); everything else collapses to `application/octet-stream`. Every byte
 * response additionally carries `Content-Disposition: attachment`, so it can only ever be a download,
 * never a document. `X-Content-Type-Options: nosniff` is already on every response (the platform's
 * own security-header chain), so the fallback type cannot be sniffed back into markup either.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * RANGE / CONDITIONAL-GET (the media-streaming read contract).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  - A full GET (no Range) → 200 + Content-Length + a strong ETag + Accept-Ranges: bytes.
 *  - `Range: bytes=start-end` → 206 Partial Content + Content-Range + the exact Content-Length, the
 *    bytes streamed via `init.blob.createReadStream(key, {offset, length})` (the LOGICAL byte range —
 *    the blob impl shifts past its internal header). An unsatisfiable range (negative / start≥len /
 *    beyond-EOF / inverted) → 416 + Content-Range: bytes star/len.
 *  - Conditional-GET: a strong ETag is derived from `stat().etagSource` (quoted/hashed — never the raw
 *    source). `If-None-Match` match → 304. `If-Range` (etag) MISMATCH → serve the full 200 (NOT 206;
 *    the client's cached representation is stale, so a partial would corrupt it).
 */
import type { StreamRouteHandler, StreamRouteHandlerInit } from '@rayspec/handler-sdk';

/** The declared pointer store (rayspec.yaml) — records WHERE a chunk's bytes live + its metadata. */
const POINTER_STORE = 'blob_chunks';

/** The opaque BlobStore key for one chunk's bytes (mirrors the ingest handler's storageKey). */
function storageKey(uploadId: string, chunkIndex: number): string {
  return `${uploadId}/${chunkIndex}`;
}

/**
 * The media types this example is willing to serve back AS THEMSELVES — inert container formats a
 * browser can decode but never execute. Entries are bare `type/subtype`, lower-case, no parameters.
 */
const SERVABLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
]);

/** The inert type served for every recorded type NOT on the allowlist above. */
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * The Content-Type to SERVE for one chunk, derived from — never equal to — the uploader's recorded
 * type. The recorded value is untrusted DATA, so it is used only to look up an allowlist entry, and
 * the ALLOWLIST's string is what goes on the wire (any `; codecs=…` parameter the uploader attached
 * is dropped rather than echoed). An unrecognized type — `text/html` included — is
 * `application/octet-stream`.
 */
function servedContentType(recorded: unknown): string {
  if (typeof recorded !== 'string') return FALLBACK_CONTENT_TYPE;
  const essence = (recorded.split(';')[0] ?? '').trim().toLowerCase();
  return SERVABLE_CONTENT_TYPES.has(essence) ? essence : FALLBACK_CONTENT_TYPE;
}

/** A small JSON error Response (returned verbatim by the platform — no JSON envelope). */
function jsonError(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ error: code, detail }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A strong ETag derived from the blob's opaque `etagSource`. We HASH it (never expose the raw source —
 * it is a content hash:len internally, but the contract is to treat it as opaque) into a short quoted
 * token. A simple FNV-1a over the source is sufficient for a stable, opaque, collision-resilient tag.
 */
function strongEtag(etagSource: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < etagSource.length; i++) {
    h ^= etagSource.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `"${h.toString(16).padStart(8, '0')}"`;
}

/** Parse a single `bytes=start-end` Range header. Returns the requested [start,end] or null (ignore/malformed). */
function parseRange(
  header: string | null,
  len: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  // Only the single-range `bytes=` form is supported (multi-range is out of scope for the synthetic).
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // a malformed/unsupported Range is IGNORED (RFC 7233 → serve the full 200).
  const startRaw = m[1];
  const endRaw = m[2];
  if (startRaw === '' && endRaw === '') return 'unsatisfiable'; // `bytes=-` is malformed.
  let start: number;
  let end: number;
  if (startRaw === '') {
    // Suffix range `bytes=-N` → the last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, len - suffix);
    end = len - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? len - 1 : Number(endRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return 'unsatisfiable';
  }
  // Unsatisfiable: negative, start past EOF, or inverted (start>end).
  if (start < 0 || start >= len || end < start) return 'unsatisfiable';
  // Clamp end to the last byte (a range that runs past EOF is satisfiable, clamped).
  if (end > len - 1) end = len - 1;
  return { start, end };
}

export const chunkPlayback: StreamRouteHandler = async (
  init: StreamRouteHandlerInit,
): Promise<Response> => {
  const uploadId = init.params.upload_id;
  const indexRaw = init.params.chunk_index;
  if (!uploadId || !indexRaw) {
    return jsonError(400, 'bad_request', 'upload_id and chunk_index are required.');
  }
  const chunkIndex = Number(indexRaw);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return jsonError(400, 'bad_request', 'chunk_index must be a non-negative integer.');
  }
  const key = storageKey(uploadId, chunkIndex);

  // (1) BIND the token to the requested resource: the verified media `resource` claim MUST equal the
  // storage key this route addresses. A token minted for a different resource is rejected (no replay).
  // The platform always provides `mediaResource` on a playback request (the verifier ran); a missing
  // one is a fail-closed 403 (never serve without the binding).
  if (init.mediaResource !== key) {
    return jsonError(403, 'forbidden', 'the media token does not authorize this resource.');
  }

  // (2) RE-VALIDATE OWNERSHIP IN THE DB through the tenant-bound init.db (auto-scoped to init.tenantId).
  // A resource not owned by the token's tenant is INVISIBLE here → no row → 404. The storage_key we
  // serve is the DB row's recorded value (the authority), not the caller-derived `key` (defense-in-depth).
  const rows = await init.db.select(POINTER_STORE, {
    upload_id: uploadId,
    chunk_index: chunkIndex,
  });
  const row = rows[0];
  if (!row) {
    // Not owned by this tenant (or never ingested) — uniform 404 (no cross-tenant existence leak).
    return jsonError(404, 'not_found', 'no such resource.');
  }
  const dbStorageKey = typeof row.storage_key === 'string' ? row.storage_key : key;
  // NOT the recorded type — an allowlisted inert type or the octet-stream fallback (see the header).
  const contentType = servedContentType(row.content_type);

  // The blob metadata (len + a stable etagSource). Tenant-bound init.blob — the key resolves under the
  // token tenant's blob root by construction.
  const stat = await init.blob.stat(dbStorageKey);
  if ('notFound' in stat) {
    // The pointer row exists but the bytes are gone (a torn/cleaned blob) → 404 (fail-closed).
    return jsonError(404, 'not_found', 'no such resource.');
  }
  const len = stat.len;
  const etag = strongEtag(stat.etagSource);

  // Conditional-GET: If-None-Match → 304 (the client already has this exact representation).
  const ifNoneMatch = init.request.headers.get('if-none-match');
  if (ifNoneMatch?.split(',').some((t) => t.trim() === etag)) {
    return new Response(null, {
      status: 304,
      headers: { etag, 'accept-ranges': 'bytes' },
    });
  }

  // If-Range: if present AND it does NOT match our etag, the client's cached copy is stale → serve the
  // FULL 200 (ignore the Range), never a 206 against a different representation.
  const ifRange = init.request.headers.get('if-range');
  const ifRangeMismatch = ifRange !== null && ifRange.trim() !== etag;

  const rangeHeader = ifRangeMismatch ? null : init.request.headers.get('range');
  const range = parseRange(rangeHeader, len);

  if (range === 'unsatisfiable') {
    // 416 Range Not Satisfiable + Content-Range: bytes */len (RFC 7233).
    return new Response(JSON.stringify({ error: 'range_not_satisfiable' }), {
      status: 416,
      headers: {
        'content-type': 'application/json',
        'content-range': `bytes */${len}`,
        'accept-ranges': 'bytes',
      },
    });
  }

  if (range) {
    // 206 Partial Content. createReadStream takes the LOGICAL offset/length (the impl shifts past its
    // internal header). length = end - start + 1 (end is INCLUSIVE).
    const length = range.end - range.start + 1;
    const stream = await init.blob.createReadStream(dbStorageKey, { offset: range.start, length });
    if ('notFound' in stream) return jsonError(404, 'not_found', 'no such resource.');
    return new Response(stream, {
      status: 206,
      headers: {
        'content-type': contentType,
        'content-disposition': 'attachment',
        'content-length': String(length),
        'content-range': `bytes ${range.start}-${range.end}/${len}`,
        'accept-ranges': 'bytes',
        etag,
      },
    });
  }

  // Full 200 (no Range / ignored Range / If-Range mismatch).
  const stream = await init.blob.createReadStream(dbStorageKey);
  if ('notFound' in stream) return jsonError(404, 'not_found', 'no such resource.');
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': 'attachment',
      'content-length': String(len),
      'accept-ranges': 'bytes',
      etag,
    },
  });
};
