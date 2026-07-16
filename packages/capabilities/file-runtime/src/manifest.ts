/**
 * The machine-readable capability manifest (the record `manifest.ts` pattern): the descriptor an
 * authoring assistant / the Product-YAML parser inspects, declaring the RUNTIME realization of the
 * `file_input` capability. The `file_submitted` event is declared with its canonical contract id
 * `file_input.file_submitted` — the DEFAULT `${capability}.${event}` JOIN (the default-join rule: NEW
 * events add NO alias-table entry; the alias table stays audio-only).
 *
 * ZERO product vocabulary. This is the SOURCE OF TRUTH; the committed `manifest.json` at the
 * package root MUST equal it (asserted by manifest.test.ts) and is what the file-input
 * capability check reads.
 *
 * ── THE PAYLOAD CONTRACT (stated here deliberately — see types.ts for the full rationale) ──────
 * `payload_keys` is the WHOLE payload: every key is SERVER-DERIVED from the stored pointer row
 * (identity envelope + byte metadata). Unlike the record capability there is NO top-level client
 * merge — the submit body is a closed shape — so `payload_keys` is exact, not a floor. The raw
 * bytes are NEVER in the payload (`bytes_in_event_payload: false`, gate-pinned): they stay behind
 * the tenant-jailed `blob_key`.
 */
import type { TriggerEventDescriptor } from '@rayspec/spec';
import { DEFAULT_ALLOWED_FILE_CONTENT_TYPES, DEFAULT_MAX_FILE_BYTES } from './config.js';
import { FILE_UPLOADS_STORE } from './stores.js';
import { FILE_EVENT_PAYLOAD_KEYS } from './types.js';

/**
 * The file realization of the SHARED per-event descriptor contract (`TriggerEventDescriptor`,
 * `@rayspec/spec` product-events.ts). This extension only NARROWS the dedup-scope label:
 * file-scoped single-flight (a re-submit of one file converges on one durable run). The derived
 * idempotency key uses the GENERIC format `file_id:<id>` (payloadFieldIdempotencyKey — no
 * legacy suffix; the `:finalized` format is audio-only, byte-frozen live run identity).
 */
export interface FileCapabilityEventDescriptor extends TriggerEventDescriptor {
  /** How downstream consumption is deduped — file-scoped single-flight for a re-submit. */
  readonly idempotency: 'file_scoped';
}

export interface FileCapabilityRouteDescriptor {
  readonly id: string;
  readonly method: 'PUT' | 'POST';
  /** The route path template (relative to the mount base). */
  readonly path: string;
  /** The contract this route realizes. */
  readonly contract: string;
  /** The auth path: the standard bearer chain (this capability has no second auth path). */
  readonly auth: 'bearer';
  /** How the platform mounts it (a raw byte-stream ingest route or a normal handler route). */
  readonly kind: 'handler' | 'stream_ingest';
}

export interface FileCapabilityDescriptor {
  readonly id: 'file_input';
  readonly tier: 'B';
  readonly runtime_status: 'available';
  readonly contracts: readonly string[];
  readonly events: readonly FileCapabilityEventDescriptor[];
}

/** The byte-ingest contract block (gate-pinned against the runtime constants). */
export interface FileIngestContract {
  /** The raw bytes NEVER ride the trigger payload — they stay behind the tenant-jailed blob key. */
  readonly bytes_in_event_payload: false;
  /** The raw-byte size cap on one upload (413 above it — pre-checked AND drain-enforced). */
  readonly max_file_bytes: number;
  /** The accepted declared media types (415 outside it — fail-closed; advisory DATA thereafter). */
  readonly allowed_content_types: readonly string[];
}

export interface FileCapabilityManifest {
  /** RUNTIME realization (this package IS the runtime — no contract-only doc stage precedes it). */
  readonly status: 'runtime';
  readonly package: '@rayspec/file-runtime';
  readonly capabilities: readonly FileCapabilityDescriptor[];
  readonly stores: readonly string[];
  readonly routes: readonly FileCapabilityRouteDescriptor[];
  readonly ingest_contract: FileIngestContract;
}

/**
 * The route path templates relative to the mount base — the ONE source both this manifest and
 * `mountFileCapability` consume (the gate pins manifest == mounted surface; shared constants
 * are what keep them from drifting).
 */
export const FILE_UPLOAD_ROUTE_SUBPATH = '/{file_id}';
export const FILE_SUBMIT_ROUTE_SUBPATH = '/{file_id}/submit';

export const FILE_CAPABILITY_MANIFEST: FileCapabilityManifest = {
  status: 'runtime',
  package: '@rayspec/file-runtime',
  capabilities: [
    {
      id: 'file_input',
      tier: 'B',
      runtime_status: 'available',
      contracts: [
        'file_input.file',
        'file_input.upload',
        'file_input.submit',
        'file_input.file_submitted',
      ],
      events: [
        {
          id: 'file_submitted',
          contract: 'file_input.file_submitted',
          idempotency: 'file_scoped',
          payload_keys: [...FILE_EVENT_PAYLOAD_KEYS],
          idempotency_key_field: 'file_id',
        },
      ],
    },
  ],
  stores: [FILE_UPLOADS_STORE],
  routes: [
    {
      id: 'file_upload',
      method: 'PUT',
      path: FILE_UPLOAD_ROUTE_SUBPATH,
      contract: 'file_input.upload',
      auth: 'bearer',
      kind: 'stream_ingest',
    },
    {
      id: 'file_submit',
      method: 'POST',
      path: FILE_SUBMIT_ROUTE_SUBPATH,
      contract: 'file_input.submit',
      auth: 'bearer',
      kind: 'handler',
    },
  ],
  ingest_contract: {
    bytes_in_event_payload: false,
    max_file_bytes: DEFAULT_MAX_FILE_BYTES,
    allowed_content_types: [...DEFAULT_ALLOWED_FILE_CONTENT_TYPES],
  },
};
