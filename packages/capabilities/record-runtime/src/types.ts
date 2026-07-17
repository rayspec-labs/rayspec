/**
 * Product-neutral submit-ingress model. A RECORD is one authenticated JSON
 * submission a client keys by its own `record_id`; submitting it emits the `record_submitted`
 * trigger event a declared Product-YAML workflow can run on. ZERO product vocabulary here — a
 * "record" carries arbitrary product business fields as DATA (never instructions; the trust boundary).
 *
 * ── THE PAYLOAD CONTRACT (deliberate, gate-pinned) ────────────────────────────────────────────
 * The event's canonical payload is the FIXED ENVELOPE (`record_id`, `tenant_id`,
 * `source_capability` — the manifest descriptor's `payload_keys`) PLUS the submitted record's own
 * top-level fields MERGED ALONGSIDE it. Merging top-level is what makes the submitted business
 * fields reachable by a `store_write` step's `{ event: <field> }` value sources (store-nodes.ts
 * resolves `{event}` against TOP-LEVEL scalar payload keys only — a nested `record` object would
 * be unreachable). The envelope keys are therefore RESERVED: a submission whose body carries any
 * of them is rejected at the route (422 `reserved_record_key`) so a client can never spoof the
 * server-derived identity fields (the trust boundary), and the seam adapter additionally spreads the envelope
 * LAST (defense-in-depth — the envelope always wins).
 */

/**
 * The FIXED EVENT ENVELOPE — the server-derived keys of every `record_submitted` payload, and
 * therefore (a) the manifest descriptor's `payload_keys` (the persist-scope contract), and
 * (b) the RESERVED keys a submission body must not carry (submit rejects them 422). ONE source —
 * the manifest, the submit validation, and the seam adapter all consume THIS array (gate-pinned).
 */
export const RECORD_EVENT_ENVELOPE_KEYS = ['record_id', 'tenant_id', 'source_capability'] as const;

/** One submitted record row (the capability-owned `record_submissions` store's business shape). */
export interface RecordSubmission {
  /** The client-supplied record id (DATA; validated shape, never a tenant signal). */
  readonly record_id: string;
  /** The submitted business fields (a plain JSON object — DATA, never instructions). */
  readonly record: Readonly<Record<string, unknown>>;
}

/**
 * The `record_input.record_submitted` event — the workflow trigger shape. The `event_id` is the
 * RECORD-scoped idempotency key (= `${tenant_id}:${record_id}`, mirroring the audio capability's
 * session-scoped `finalizedEventId`), so a re-submit of the same record converges on ONE workflow
 * (single-flight downstream). `record` carries the AUTHORITATIVE stored payload (re-read from
 * the capability-owned row after persist — never the raw request body), so a deduped redelivery
 * is byte-consistent with the first delivery.
 */
export interface SubmittedRecordEvent {
  /** Idempotency key for workflow consumption (= `${tenant_id}:${record_id}`). */
  readonly event_id: string;
  /** Server-derived tenant boundary (never client-supplied). */
  readonly tenant_id: string;
  readonly record_id: string;
  /** The authoritative stored business fields (top-level-merged into the workflow payload). */
  readonly record: Readonly<Record<string, unknown>>;
  /** Server timestamp (ISO-8601). */
  readonly occurred_at: string;
  /** The emitting capability id — always `record_input`. */
  readonly source_capability: 'record_input';
}

/** The submit route's success result (the `record_input.submit` contract). */
export interface RecordSubmitResult {
  readonly record_id: string;
  /**
   * The idempotency key of the `record_submitted` event this submit emitted downstream
   * (record-scoped — a re-submit re-emits the SAME id and dedups to one workflow).
   */
  readonly event_id: string;
  /**
   * True when this submit was an IDENTICAL re-submit of an already-stored record (the event was
   * re-emitted for redelivery and dedups downstream — client retry = redelivery, single-flight).
   */
  readonly deduped: boolean;
}

/** A typed error body a capability route returns (mapped to the proper HTTP status by the binding). */
export interface RecordErrorBody {
  readonly error: string;
  readonly detail: string;
}
