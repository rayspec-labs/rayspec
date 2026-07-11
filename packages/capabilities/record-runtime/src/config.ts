/**
 * Capability configuration (the audio `config.ts` mirror): the accepted record-id shape and the
 * payload-size bound, with product-neutral defaults a deployment may narrow.
 */

/** The default record-id shape (safe ASCII, up to 128 chars — the audio session-id mirror). */
export const DEFAULT_RECORD_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The default payload-size bound: the CANONICAL-JSON serialization of the submitted business
 * fields is capped at 64 KiB. Rationale (documented, gate-pinned): a `record_submitted` payload is
 * a workflow TRIGGER carrying form-grade business data — it is copied verbatim into the durable
 * journal's `input_event` row on every run, so it must stay journal-friendly. Document/file ingest
 * is DELIBERATELY out of scope for this capability (a future blob-backed capability),
 * so a generous-but-bounded 64 KiB is the honest cap.
 */
export const DEFAULT_MAX_RECORD_BYTES = 65536;

export interface RecordCapabilityConfig {
  /** Override the accepted record-id shape (default `DEFAULT_RECORD_ID_RE`). */
  readonly recordIdPattern?: RegExp;
  /** Override the canonical-JSON payload byte cap (default `DEFAULT_MAX_RECORD_BYTES`). */
  readonly maxRecordBytes?: number;
}

export interface ResolvedRecordConfig {
  readonly recordIdPattern: RegExp;
  readonly maxRecordBytes: number;
}

/**
 * HS-2: probe ids a `recordIdPattern` override must NOT accept — ':' is the STRUCTURAL delimiter
 * of `record_ref` and the event idempotency key (`${tenantId}:${recordId}`, keys.ts), so a pattern
 * admitting it would let two distinct (tenant, record) pairs collide on one ref/key (a re-emit /
 * ref-collision correctness bug). Probe-based (a regex's accepted language can't be cheaply
 * inspected in general): these four shapes catch every realistic character-class override, and
 * submit.ts carries a point-of-use `':'` belt that holds even for a pattern these probes miss.
 */
const DELIMITER_PROBES = [':', 'a:b', ':a', 'a:'] as const;

export function resolveRecordConfig(config?: RecordCapabilityConfig): ResolvedRecordConfig {
  const pattern = config?.recordIdPattern ?? DEFAULT_RECORD_ID_RE;
  if (config?.recordIdPattern !== undefined) {
    // Probe with a flag-stripped copy so a sticky/global override's `lastIndex` state can't skew
    // the check. Fail CLOSED at construction (deploy-time loud) — never a silently corrupt ref.
    const probeSafe = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    for (const probe of DELIMITER_PROBES) {
      if (probeSafe.test(probe)) {
        throw new Error(
          `record capability config: recordIdPattern ${String(pattern)} accepts ':' (probe ` +
            `'${probe}') — ':' is the reserved tenant/record delimiter of record_ref and the ` +
            'event idempotency key, so an override must exclude it (fail-closed at construction).',
        );
      }
    }
  }
  return {
    recordIdPattern: pattern,
    maxRecordBytes: config?.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
  };
}
