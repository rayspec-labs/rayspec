/**
 * The machine-readable capability manifest (the record/file `manifest.ts` pattern): the descriptor
 * an authoring assistant / the Product-YAML parser inspects, declaring the RUNTIME realization of
 * the `conversation_input` capability. The `turn_submitted` event is declared with its canonical
 * contract id `conversation_input.turn_submitted` — the DEFAULT `${capability}.${event}` JOIN (the
 * default-join rule: NEW events add NO alias-table entry; the alias table stays audio-only).
 *
 * ZERO product vocabulary. This is the SOURCE OF TRUTH; the committed `manifest.json` at the
 * package root MUST equal it (asserted by manifest.test.ts) and is what the
 * conversation-input capability check reads.
 *
 * ── THE PAYLOAD CONTRACT (stated here deliberately — see types.ts for the full rationale) ──────
 * `payload_keys` is the WHOLE payload: every key is SERVER-DERIVED from the stored ledger row
 * (identity envelope + turn facts + the bounded message TEXT). Like the file capability there is
 * NO top-level client merge — the turn body is a closed shape — so `payload_keys` is exact, not a
 * floor. UNLIKE the file capability the business content (the message text) IS in the payload
 * (`message_in_event_payload: true`, gate-pinned): a chat turn is form-grade text under the byte
 * cap, and riding the payload is what lets a declared async workflow consume it through the
 * existing `input_context.payload_fields` path.
 *
 * ── THE PER-TURN IDEMPOTENCY LAW (single-flight — pinned by manifest.test.ts + the bridge tests) ─────────
 * `idempotency_key_field` is the composed per-TURN `turn_ref` (`<conversation_id>:<message_id>`,
 * the `artifact_ref` single-field idiom) — NEVER `conversation_id`: a conversation-scoped key
 * would dedupe EVERY later turn of a conversation into its FIRST durable run (silent turn loss).
 */
import type { TriggerEventDescriptor } from '@rayspec/spec';
import {
  DEFAULT_MAX_HISTORY_CHARS,
  DEFAULT_MAX_HISTORY_TURNS,
  DEFAULT_MAX_MESSAGE_BYTES,
} from './config.js';
import { CONVERSATION_TURNS_STORE, CONVERSATIONS_STORE } from './stores.js';
import { CONVERSATION_EVENT_PAYLOAD_KEYS } from './types.js';

/**
 * The conversation realization of the SHARED per-event descriptor contract
 * (`TriggerEventDescriptor`, `@rayspec/spec` product-events.ts). This extension only NARROWS the
 * dedup-scope label: TURN-scoped single-flight (a re-POST of one message converges on one durable
 * run; every new turn gets its own). The derived idempotency key uses the GENERIC format
 * `turn_ref:<conversation_id>:<message_id>` (payloadFieldIdempotencyKey — no legacy suffix; the
 * `:finalized` format is audio-only, byte-stable live run identity).
 */
export interface ConversationCapabilityEventDescriptor extends TriggerEventDescriptor {
  /** How downstream consumption is deduped — turn-scoped single-flight for a re-POST. */
  readonly idempotency: 'turn_scoped';
}

export interface ConversationCapabilityRouteDescriptor {
  readonly id: string;
  readonly method: 'PUT' | 'POST';
  /** The route path template (relative to the mount base). */
  readonly path: string;
  /** The contract this route realizes. */
  readonly contract: string;
  /** The auth path: the standard bearer chain (this capability has no second auth path). */
  readonly auth: 'bearer';
  /** How the platform mounts it (both are normal JSON handler routes — no byte streams here). */
  readonly kind: 'handler';
}

export interface ConversationCapabilityDescriptor {
  readonly id: 'conversation_input';
  readonly tier: 'B';
  readonly runtime_status: 'available';
  readonly contracts: readonly string[];
  readonly events: readonly ConversationCapabilityEventDescriptor[];
}

/** The turn-intake contract block (gate-pinned against the runtime constants). */
export interface ConversationTurnContract {
  /** The message TEXT rides the trigger payload (bounded by the byte cap — the module header). */
  readonly message_in_event_payload: true;
  /** The UTF-8 byte cap on one message (413 above it). */
  readonly max_message_bytes: number;
  /** The history read-window in turns (the bounded-history law; never unbounded). */
  readonly max_history_turns: number;
  /** The history read-window in chars (the second axis of the bound). */
  readonly max_history_chars: number;
}

export interface ConversationCapabilityManifest {
  /** RUNTIME realization (this package IS the runtime — no contract-only doc stage precedes it). */
  readonly status: 'runtime';
  readonly package: '@rayspec/conversation-runtime';
  readonly capabilities: readonly ConversationCapabilityDescriptor[];
  readonly stores: readonly string[];
  readonly routes: readonly ConversationCapabilityRouteDescriptor[];
  readonly turn_contract: ConversationTurnContract;
}

/**
 * The route path templates relative to the mount base — the ONE source both this manifest and
 * `mountConversationCapability` consume (the gate pins manifest == mounted surface; shared
 * constants are what keep them from drifting).
 */
export const CONVERSATION_CREATE_ROUTE_SUBPATH = '/{conversation_id}';
export const TURN_SUBMIT_ROUTE_SUBPATH = '/{conversation_id}/turns';

export const CONVERSATION_CAPABILITY_MANIFEST: ConversationCapabilityManifest = {
  status: 'runtime',
  package: '@rayspec/conversation-runtime',
  capabilities: [
    {
      id: 'conversation_input',
      tier: 'B',
      runtime_status: 'available',
      contracts: [
        'conversation_input.conversation',
        'conversation_input.create',
        'conversation_input.submit_turn',
        'conversation_input.turn_submitted',
      ],
      events: [
        {
          id: 'turn_submitted',
          contract: 'conversation_input.turn_submitted',
          idempotency: 'turn_scoped',
          payload_keys: [...CONVERSATION_EVENT_PAYLOAD_KEYS],
          idempotency_key_field: 'turn_ref',
        },
      ],
    },
  ],
  stores: [CONVERSATIONS_STORE, CONVERSATION_TURNS_STORE],
  routes: [
    {
      id: 'conversation_create',
      method: 'PUT',
      path: CONVERSATION_CREATE_ROUTE_SUBPATH,
      contract: 'conversation_input.create',
      auth: 'bearer',
      kind: 'handler',
    },
    {
      id: 'conversation_turn_submit',
      method: 'POST',
      path: TURN_SUBMIT_ROUTE_SUBPATH,
      contract: 'conversation_input.submit_turn',
      auth: 'bearer',
      kind: 'handler',
    },
  ],
  turn_contract: {
    message_in_event_payload: true,
    max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
    max_history_turns: DEFAULT_MAX_HISTORY_TURNS,
    max_history_chars: DEFAULT_MAX_HISTORY_CHARS,
  },
};
