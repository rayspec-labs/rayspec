/**
 * The machine-readable capability manifest (the audio `manifest.ts` pattern):
 * the descriptor an authoring assistant / the Product-YAML parser inspects, declaring the RUNTIME
 * realization of the `record_input` capability. The `record_submitted` event is declared with its
 * canonical contract id `record_input.record_submitted` — the DEFAULT `${capability}.${event}`
 * JOIN (the default-join rule: NEW events add NO alias-table entry; the alias table stays audio-only).
 *
 * ZERO product vocabulary. This is the SOURCE OF TRUTH; the committed `manifest.json` at the
 * package root MUST equal it (asserted by manifest.test.ts) and is what the repo's
 * record-input capability check reads.
 *
 * ── THE PAYLOAD CONTRACT (stated here deliberately — see types.ts for the full rationale) ──────
 * `payload_keys` is the FIXED ENVELOPE (server-derived; the scope contract — an artifact
 * scope must be satisfiable by THESE keys, so only `record` scopes persist). The submitted
 * business fields MERGE TOP-LEVEL ALONGSIDE the envelope (that is how `store_write`
 * `{ event: <field> }` sources reach them — store-nodes resolves top-level scalar keys only), so
 * the envelope keys are RESERVED in a submission body (`payload_contract.reserved_keys`, rejected
 * 422 at the route) and the actual runtime payload may carry MORE keys than `payload_keys` — the
 * envelope is the STABLE contract, the merged fields are per-product data.
 */
import type { TriggerEventDescriptor } from '@rayspec/spec';
import { MAX_CANONICAL_JSON_DEPTH } from './canonical-json.js';
import { DEFAULT_MAX_RECORD_BYTES } from './config.js';
import { RECORD_EVENT_ENVELOPE_KEYS } from './types.js';

/**
 * The record realization of the SHARED per-event descriptor contract (`TriggerEventDescriptor`,
 * `@rayspec/spec` product-events.ts). This extension only NARROWS the dedup-scope label:
 * record-scoped single-flight (a re-submit of one record converges on one durable run). The
 * derived idempotency key uses the GENERIC format `record_id:<id>` (payloadFieldIdempotencyKey
 * — no legacy `:finalized` suffix; that format is audio-only, byte-frozen live run identity).
 */
export interface RecordCapabilityEventDescriptor extends TriggerEventDescriptor {
  /** How downstream consumption is deduped — record-scoped single-flight for a re-submit. */
  readonly idempotency: 'record_scoped';
}

export interface RecordCapabilityRouteDescriptor {
  readonly id: string;
  readonly method: 'POST';
  /** The route path template (relative to the mount base). */
  readonly path: string;
  /** The contract this route realizes. */
  readonly contract: string;
  /** The auth path: the standard bearer chain (this capability has no second auth path). */
  readonly auth: 'bearer';
  /** How the platform mounts it (a normal handler route — no byte streams here). */
  readonly kind: 'handler';
}

export interface RecordCapabilityDescriptor {
  readonly id: 'record_input';
  readonly tier: 'B';
  readonly runtime_status: 'available';
  readonly contracts: readonly string[];
  readonly events: readonly RecordCapabilityEventDescriptor[];
}

/** The submitted-payload contract block (gate-pinned against the runtime constants). */
export interface RecordPayloadContract {
  /** Business fields merge TOP-LEVEL into the trigger payload (never nested — see module header). */
  readonly merged_into_event_payload: true;
  /** The reserved envelope keys a submission body must not carry (== the event `payload_keys`). */
  readonly reserved_keys: readonly string[];
  /** The canonical-JSON byte cap on a submitted record (413 above it). */
  readonly max_record_bytes: number;
  /** The JSON container-nesting cap on a submitted record (422 `record_too_deep` above it). */
  readonly max_record_depth: number;
}

export interface RecordCapabilityManifest {
  /** RUNTIME realization (this package IS the runtime — no contract-only doc stage precedes it). */
  readonly status: 'runtime';
  readonly package: '@rayspec/record-runtime';
  readonly capabilities: readonly RecordCapabilityDescriptor[];
  readonly stores: readonly string[];
  readonly routes: readonly RecordCapabilityRouteDescriptor[];
  readonly payload_contract: RecordPayloadContract;
}

export const RECORD_CAPABILITY_MANIFEST: RecordCapabilityManifest = {
  status: 'runtime',
  package: '@rayspec/record-runtime',
  capabilities: [
    {
      id: 'record_input',
      tier: 'B',
      runtime_status: 'available',
      contracts: ['record_input.record', 'record_input.submit', 'record_input.record_submitted'],
      events: [
        {
          id: 'record_submitted',
          contract: 'record_input.record_submitted',
          idempotency: 'record_scoped',
          payload_keys: [...RECORD_EVENT_ENVELOPE_KEYS],
          idempotency_key_field: 'record_id',
        },
      ],
    },
  ],
  stores: ['record_submissions'],
  routes: [
    {
      id: 'record_submit',
      method: 'POST',
      path: '/{record_id}/submit',
      contract: 'record_input.submit',
      auth: 'bearer',
      kind: 'handler',
    },
  ],
  payload_contract: {
    merged_into_event_payload: true,
    reserved_keys: [...RECORD_EVENT_ENVELOPE_KEYS],
    max_record_bytes: DEFAULT_MAX_RECORD_BYTES,
    max_record_depth: MAX_CANONICAL_JSON_DEPTH,
  },
};
