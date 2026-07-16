/**
 * The shared, product-neutral BOUNDED request-body reader — generalized from the file-runtime
 * `file_input.upload` byte bound so every JSON / binary ingress path can cap the bytes it buffers into
 * memory instead of `await request.json()` / `request.arrayBuffer()`-ing an unbounded body.
 *
 * A stateless, dependency-free function (like the harvested tokenizer): it constructs no capability and
 * holds no state, so it lives in `@rayspec/core` and is re-exported through `@rayspec/handler-sdk` for
 * the capability packages, and imported directly by the api-auth route interpreters.
 *
 * ── TWO INDEPENDENT FAIL-CLOSED LAYERS ────────────────────────────────────────────────────────────
 *  1. THE CONTENT-LENGTH PRE-CHECK: a DECLARED length above the cap is rejected BEFORE a single body
 *     byte is read (`too_large`, body stream untouched). In the strict posture (`requireContentLength`,
 *     the file/OAuth stance) an absent / non-numeric / chunked (length-less) body is also rejected
 *     pre-read (`length_required`). The default JSON posture is LENIENT on an absent length — the DoS
 *     is already closed by layer 2, and requiring a length would break a legitimate empty/chunked body.
 *  2. DRAIN-TIME ENFORCEMENT: the body is read CHUNK-WISE with a running byte count; the moment the
 *     count exceeds the cap the read is CANCELLED and the outcome is `too_large`. So a LYING (or
 *     absent) Content-Length buys an attacker at most `cap + one chunk` of memory, never an unbounded
 *     buffer.
 *
 * The reader returns the raw bytes (or a typed rejection). Decoding / JSON-parsing — and the mapping of
 * a rejection to the caller's transport error (an api-auth `ApiError`, a capability 413) — belong to
 * the call site, so this stays a pure byte primitive with no transport or framework coupling.
 */

/** A strict digit-run Content-Length (rejects '', '-5', '12abc', '1e3' — the OIDC/file-cap posture). */
const CONTENT_LENGTH_RE = /^\d{1,15}$/;

/** The outcome of a bounded read: the drained bytes, or a fail-closed rejection reason. */
export type BoundedBodyOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'length_required' | 'too_large' };

/** The transport-neutral view of a request the reader needs: its declared length + its raw body stream. */
export interface BoundedBodySource {
  /** The declared `Content-Length` header value (absent ⇒ `null`/`undefined`). */
  readonly contentLength: string | null | undefined;
  /** The raw request body stream (`null` for an empty/absent body). */
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface BoundedBodyOptions {
  /** The inclusive byte cap for the body. A read at exactly `maxBytes` is accepted; one byte over is not. */
  readonly maxBytes: number;
  /**
   * When true (the file/OAuth strict posture) a body-bearing request MUST declare a finite, in-budget
   * Content-Length: an absent / non-numeric / chunked (length-less) length is rejected pre-read
   * (`length_required`). Default `false` (the JSON posture): an absent/non-numeric length is permitted
   * and the body is bounded by drain-time enforcement alone. A DECLARED over-cap length is ALWAYS
   * rejected pre-read regardless of this flag.
   */
  readonly requireContentLength?: boolean;
}

/**
 * Drain `body` chunk-wise under `cap`. Returns the concatenated bytes, or the sentinel `'over_cap'` the
 * MOMENT the running count exceeds the cap — at which point the read is CANCELLED (a lying/absent
 * Content-Length never buys an unbounded buffer). A `null` body reads as zero bytes.
 */
export async function drainBounded(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array | 'over_cap'> {
  if (body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > cap) {
      try {
        await reader.cancel('request body byte cap exceeded (drain-time enforcement)');
      } catch {
        // A throwing cancel is a transport-teardown fault — the cap decision is already made and the
        // deterministic rejection must stand; there is nothing to recover here.
      }
      return 'over_cap';
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Read `source`'s body under `options.maxBytes`, applying the Content-Length pre-check then drain-time
 * enforcement (see the module header). Never throws for an over-cap body — it returns a typed
 * `too_large` / `length_required` rejection the caller maps to its own transport error.
 */
export async function readBoundedBody(
  source: BoundedBodySource,
  options: BoundedBodyOptions,
): Promise<BoundedBodyOutcome> {
  const { maxBytes, requireContentLength = false } = options;
  const declared = source.contentLength?.trim();
  const hasNumericLength =
    declared !== undefined && declared !== '' && CONTENT_LENGTH_RE.test(declared);

  // (1) THE CONTENT-LENGTH PRE-CHECK — before ANY body byte is read.
  if (hasNumericLength) {
    if (Number(declared) > maxBytes) return { ok: false, reason: 'too_large' };
  } else if (requireContentLength) {
    // Strict posture: an absent / non-numeric / chunked (length-less) body is rejected pre-read.
    return { ok: false, reason: 'length_required' };
  }

  // (2) DRAIN-TIME ENFORCEMENT — bound the actual bytes regardless of the declared length.
  const drained = await drainBounded(source.body, maxBytes);
  if (drained === 'over_cap') return { ok: false, reason: 'too_large' };
  return { ok: true, bytes: drained };
}
