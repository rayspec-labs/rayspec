/**
 * Canonical (deterministic) JSON serialization + the record payload hash. The DIFFERENT-PAYLOAD
 * detector (409 `record_conflict`) compares hashes of the CANONICAL form, so two submissions that
 * differ only in object key ORDER are the same payload (JSON objects are unordered), while any
 * value/structure difference changes the hash. Arrays keep their order (order IS data there).
 *
 * ── THE NESTING-DEPTH BOUND (the trust boundary) ─────────────────────────────────────────────────────
 * The serializer recurses per container level, so an UNBOUNDED body is a stack-overflow vector: a
 * ~6KB body of ~3000 nested arrays — far under the 64KiB byte cap — would blow the call stack
 * (`RangeError`) INSIDE the size bound's own computation, turning the advertised 413 into a 500.
 * Canonicalization therefore FAILS CLOSED with the TYPED `CanonicalJsonDepthError` beyond
 * `MAX_CANONICAL_JSON_DEPTH` container levels — thrown before the stack is anywhere near its
 * limit, and mapped by submit.ts to a clean 422 `record_too_deep`. The cap is enforced HERE, at
 * the primitive, so EVERY canonicalization path (`canonicalJsonByteLength` and
 * `recordPayloadHash` alike) is protected — no caller can forget the guard.
 */
import { createHash } from 'node:crypto';

/**
 * The maximum JSON container nesting a record may carry (64 levels, gate-pinned via the manifest's
 * `payload_contract.max_record_depth`). WHY 64: this capability ingests FORM-GRADE business
 * records (documents are out of scope), which in practice stay under ~20 levels; 64
 * is generous for any real record while sitting >15x below the ~1000+ levels where the serializer's
 * recursion (≈3 stack frames per level) approaches Node's call-stack limit. DELIBERATELY not
 * deployment-configurable: unlike `maxRecordBytes` there is no legitimate need for deeper nesting,
 * and a config override could silently re-open the DoS.
 */
export const MAX_CANONICAL_JSON_DEPTH = 64;

/**
 * The TYPED fail-closed rejection for a body nested beyond `MAX_CANONICAL_JSON_DEPTH` — the
 * client-caused condition submit.ts maps to its 422 `record_too_deep` (never a RangeError 500).
 */
export class CanonicalJsonDepthError extends Error {
  constructor() {
    super(
      `JSON nesting exceeds the ${MAX_CANONICAL_JSON_DEPTH}-level canonicalization bound ` +
        '(form-grade business records need nothing deeper; the bound is what keeps the size/hash ' +
        'computation itself from overflowing the stack).',
    );
    this.name = 'CanonicalJsonDepthError';
  }
}

/**
 * Serialize a JSON value deterministically: object keys sorted (recursively), arrays in order.
 * Throws the typed `CanonicalJsonDepthError` beyond `MAX_CANONICAL_JSON_DEPTH` container levels
 * (see the module header) — a scalar/`null` never throws.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, 0);
}

/** The depth-tracked worker: `depth` = the number of container levels already entered. */
function canonicalize(value: unknown, depth: number): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (depth >= MAX_CANONICAL_JSON_DEPTH) throw new CanonicalJsonDepthError();
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v, depth + 1)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v, depth + 1)}`).join(',')}}`;
}

/** The UTF-8 byte length of the canonical serialization (the payload-size bound's measure). */
export function canonicalJsonByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

/** The sha256 hex hash of the canonical serialization (the stored `payload_hash` column). */
export function recordPayloadHash(record: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');
}
