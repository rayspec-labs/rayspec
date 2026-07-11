/**
 * Capability configuration (the record `config.ts` mirror, extended for bytes): the accepted
 * file-id shape, the raw-byte size bound, and the content-type allowlist, with product-neutral
 * defaults a deployment may narrow.
 */

/** The default file-id shape (safe ASCII, up to 128 chars — the record/audio safe-id mirror). */
export const DEFAULT_FILE_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The default raw-byte size bound: 25 MiB. Rationale (documented, gate-pinned in S2): the upload
 * route drains the body into memory to enforce the cap + hash it, and the fs `BlobStore` impl
 * buffers the body again on `put` — so the per-concurrent-upload peak memory is ≈ 2× the file
 * size. 25 MiB keeps that peak ≈ 50 MiB per in-flight upload (bounded, single-node-friendly under
 * the trusted single-deployment-tenant beta posture) while comfortably covering the v1 document
 * scope (text/markdown/CSV/JSON and text-layer PDFs — real-world PDFs of hundreds of pages sit
 * well under 25 MiB). A deployment may narrow OR widen it via `maxFileBytes`, consciously trading
 * memory headroom.
 */
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The v1 content-type ALLOWLIST (text + PDF-text-layer): pass-through text formats
 * plus PDF. Fail-closed: an upload declaring any OTHER type is a 415 `file_type_unsupported`
 * BEFORE a body byte is stored. The declared type is advisory DATA (the parser sniffs magic
 * bytes and never trusts it); the allowlist bounds what the deployment ACCEPTS, not what it
 * believes. A deployment overrides via `allowedContentTypes` (gate-pinned constants).
 */
export const DEFAULT_ALLOWED_FILE_CONTENT_TYPES: readonly string[] = Object.freeze([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
]);

/** A bare `type/subtype` media-type shape (no parameters, no wildcards) — allowlist entries only. */
const MEDIA_TYPE_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/**
 * HS-2, WIDENED FOR BYTES: probe strings a `fileIdPattern` override must NOT accept. ':' is the
 * STRUCTURAL delimiter of `file_ref` and the event idempotency key (`${tenantId}:${fileId}`,
 * keys.ts) — a pattern admitting it would let two distinct (tenant, file) pairs collide on one
 * ref/key. '/'/'\\' and the bare dot-segments ('.', '..') are PATH-significant in the blob key
 * (`files/${fileId}`, keys.ts) — a pattern admitting them would let a client steer the blob path
 * (the jail would fail-closed 500 on '..', but a typed 422 at construction/point-of-use is the
 * contract). Probe-based (a regex's accepted language can't be cheaply inspected in general):
 * these shapes catch every realistic character-class override, and upload/submit carry a
 * point-of-use belt that holds even for a pattern these probes miss. The bare dot-segments
 * ('.', '..') are NOT probed at construction — the DEFAULT pattern legitimately admits dots
 * INSIDE ids (e.g. 'v1.2'), so an explicit re-pass of the default must not throw; dot-segment
 * rejection lives ONLY in the point-of-use belt (a bare '.'/'..' id is a typed 422 regardless
 * of pattern).
 */
const DELIMITER_PROBES = [':', 'a:b', ':a', 'a:'] as const;
const PATH_PROBES = ['/', 'a/b', '/a', 'a/', '\\', 'a\\b'] as const;

export interface FileCapabilityConfig {
  /** Override the accepted file-id shape (default `DEFAULT_FILE_ID_RE`). */
  readonly fileIdPattern?: RegExp;
  /** Override the raw-byte size cap (default `DEFAULT_MAX_FILE_BYTES`; positive integer only). */
  readonly maxFileBytes?: number;
  /** Override the accepted content types (default `DEFAULT_ALLOWED_FILE_CONTENT_TYPES`). */
  readonly allowedContentTypes?: readonly string[];
}

export interface ResolvedFileConfig {
  readonly fileIdPattern: RegExp;
  readonly maxFileBytes: number;
  /** Normalized (lowercased) allowed media types — membership-checked fail-closed. */
  readonly allowedContentTypes: ReadonlySet<string>;
}

export function resolveFileConfig(config?: FileCapabilityConfig): ResolvedFileConfig {
  const pattern = config?.fileIdPattern ?? DEFAULT_FILE_ID_RE;
  if (config?.fileIdPattern !== undefined) {
    // Probe with a flag-stripped copy so a sticky/global override's `lastIndex` state can't skew
    // the check. Fail CLOSED at construction (deploy-time loud) — never a silently corrupt
    // ref/blob path.
    const probeSafe = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    for (const probe of DELIMITER_PROBES) {
      if (probeSafe.test(probe)) {
        throw new Error(
          `file capability config: fileIdPattern ${String(pattern)} accepts ':' (probe ` +
            `'${probe}') — ':' is the reserved tenant/file delimiter of file_ref and the event ` +
            'idempotency key, so an override must exclude it (fail-closed at construction).',
        );
      }
    }
    for (const probe of PATH_PROBES) {
      if (probeSafe.test(probe)) {
        throw new Error(
          `file capability config: fileIdPattern ${String(pattern)} accepts the path-significant ` +
            `shape '${probe}' — the blob key embeds the file id as a path component ` +
            '(files/<file_id>), so an override must exclude path chars and bare dot-segments ' +
            '(fail-closed at construction).',
        );
      }
    }
  }

  const maxFileBytes = config?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  // A malformed cap would break the drain bound OPEN (`total > NaN` is never true) — the one
  // override this capability can never accept silently. Fail closed at construction.
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error(
      `file capability config: maxFileBytes must be a positive integer (got ${String(maxFileBytes)}) ` +
        '— a malformed cap would disable the upload byte bound (fail-closed at construction).',
    );
  }

  const allowed = config?.allowedContentTypes ?? DEFAULT_ALLOWED_FILE_CONTENT_TYPES;
  const normalized = new Set<string>();
  for (const entry of allowed) {
    const mediaType = entry.trim().toLowerCase();
    if (!MEDIA_TYPE_RE.test(mediaType)) {
      throw new Error(
        `file capability config: allowedContentTypes entry '${entry}' is not a bare type/subtype ` +
          'media type (no parameters, no wildcards) — fail-closed at construction.',
      );
    }
    normalized.add(mediaType);
  }
  if (normalized.size === 0) {
    throw new Error(
      'file capability config: allowedContentTypes must not be empty — an empty allowlist would ' +
        'reject every upload (declare the intended types explicitly).',
    );
  }

  return {
    fileIdPattern: pattern,
    maxFileBytes,
    allowedContentTypes: normalized,
  };
}
