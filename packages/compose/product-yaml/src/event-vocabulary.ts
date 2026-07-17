/**
 * The composition-side TRIGGER-EVENT VOCABULARY: the per-event descriptors of
 * the capabilities THIS composition mounts, and the two derivations `composeProductDeploy` builds
 * from them instead of hardcodes:
 *
 *   1. the capability inventory's `events` set (was: a hardcoded `{'audio_input.finalized_session'}`);
 *   2. the persist-scope check — the artifact scope key is validated against the SPECIFIC
 *      triggering workflow's event `payload_keys` (was: the global audio constant). NEVER a union
 *      across events: a union would re-admit a scope the actual triggering event cannot satisfy —
 *      exactly the runtime 'persist_scope_missing' hole this closed;
 *   3. the per-trigger idempotency-key derivation (C10) — every trigger registration passes an
 *      EXPLICIT `idempotencyKeyForEvent` from the descriptor's declared key field (was: the
 *      dispatcher's implicit default, a silent single-flight weakening for any future non-audio
 *      event). For the audio event the derived key stays byte-identical:
 *      `session_id:<id>:finalized` (live deployment run identity — pinned by test).
 *
 * Today exactly ONE capability mounts (the unconditional audio mount), so the vocabulary is the audio
 * manifest's descriptors. Conditional mounting is layered on top; this module is the seam that stays.
 */
import { AUDIO_CAPABILITY_MANIFEST } from '@rayspec/audio-runtime';
import type { WorkflowSpec } from '@rayspec/foundation';
import { normalizeProductTriggerEvent, type TriggerEventDescriptor } from '@rayspec/spec';
import {
  payloadFieldIdempotencyKey,
  type RegisteredWorkflowTrigger,
  sessionScopedIdempotencyKey,
} from '@rayspec/workflow-durable';
import { ProductComposeError } from './errors.js';

/**
 * The canonical event ids whose derived idempotency key keeps the LEGACY `<field>:<value>:finalized`
 * format (`sessionScopedIdempotencyKey`). Exactly ONE entry, like the alias table — the audio
 * event's key feeds LIVE deployment run identity and is byte-stable (a re-key duplicates live
 * runs on redelivery). Every OTHER event derives the clean generic `<field>:<value>` format
 * (`payloadFieldIdempotencyKey`) — new events must NOT join this set.
 */
const LEGACY_SUFFIXED_KEY_EVENTS: ReadonlySet<string> = new Set(['audio_input.finalized_session']);

/**
 * Canonical event id → descriptor, for the capabilities THIS composition mounts (today: exactly the
 * audio mount's manifest). FAIL-CLOSED coherence checks bind the registry to the shared vocabulary —
 * a descriptor the normalization disagrees with, an idempotency key field outside the payload
 * contract, or two capabilities claiming one canonical id is a compose-time rejection, never a
 * silently wrong dispatch table.
 *
 * The `capabilities` parameter is an ADDITIVE test seam: it defaults to the frozen audio
 * manifest, and the production call site (`compose.ts`) stays a zero-arg call — byte-identical
 * behavior. Its only purpose is to make the three coherence guards REACHABLE by unit tests feeding
 * synthetic capability lists (a guard no test can trip is an unproven guard).
 */
export function mountedTriggerEventDescriptors(
  capabilities: ReadonlyArray<{
    readonly id: string;
    readonly events: readonly TriggerEventDescriptor[];
  }> = AUDIO_CAPABILITY_MANIFEST.capabilities,
): ReadonlyMap<string, TriggerEventDescriptor> {
  const byCanonicalId = new Map<string, TriggerEventDescriptor>();
  for (const capability of capabilities) {
    for (const descriptor of capability.events) {
      const canonical = normalizeProductTriggerEvent(capability.id, descriptor.id);
      if (canonical !== descriptor.contract) {
        throw new ProductComposeError(
          'roll out',
          `capability '${capability.id}' declares event '${descriptor.id}' with canonical id ` +
            `'${descriptor.contract}', but the shared normalization (product-events.ts) maps the pair ` +
            `to '${canonical}' — the event registry and normalizeProductTriggerEvent must agree ` +
            '(fix the descriptor or the alias table; never ship a diverged vocabulary).',
        );
      }
      if (!descriptor.payload_keys.includes(descriptor.idempotency_key_field)) {
        throw new ProductComposeError(
          'roll out',
          `capability '${capability.id}' event '${descriptor.id}' declares idempotency key field ` +
            `'${descriptor.idempotency_key_field}', which is not among its payload keys ` +
            `(${descriptor.payload_keys.join(', ')}) — the single-flight key would ALWAYS fall back ` +
            'to per-delivery event ids (a silent C10 weakening); rejected at compose.',
        );
      }
      if (byCanonicalId.has(descriptor.contract)) {
        throw new ProductComposeError(
          'roll out',
          `two mounted capability events claim the canonical event id '${descriptor.contract}' — ` +
            'a trigger event must have exactly one owning descriptor.',
        );
      }
      byCanonicalId.set(descriptor.contract, descriptor);
    }
  }
  return byCanonicalId;
}

/**
 * Build ONE dispatcher trigger registration for a compiled workflow: the workflow + the EXPLICIT
 * per-event idempotency-key derivation from its trigger event's descriptor (C10 by construction —
 * compose never relies on the dispatcher's implicit default, so a future event without a declared
 * key contract cannot silently weaken the single-flight). Fail-closed: a compiled workflow whose
 * trigger event has no mounted descriptor is rejected here (defense-in-depth — the bridge already
 * validates trigger events against the descriptor-built inventory).
 */
export function triggerRegistrationForWorkflow(
  workflow: WorkflowSpec,
  descriptors: ReadonlyMap<string, TriggerEventDescriptor>,
): RegisteredWorkflowTrigger {
  const descriptor = descriptors.get(workflow.trigger.event);
  if (!descriptor) {
    throw new ProductComposeError(
      'unsupported_spec',
      `workflow '${workflow.id}' triggers on event '${workflow.trigger.event}', which no mounted ` +
        'capability declares a descriptor for — a trigger without a declared idempotency contract ' +
        'would silently fall back to per-delivery keys (a C10 single-flight weakening); rejected at ' +
        'compose.',
    );
  }
  // For the audio event (`idempotency_key_field: 'session_id'`) this derives EXACTLY the legacy
  // dispatcher-default format `session_id:<id>:finalized` — byte-identical live run identity
  // (LEGACY_SUFFIXED_KEY_EVENTS above). Every other event uses the generic `<field>:<value>`.
  const keyFn = LEGACY_SUFFIXED_KEY_EVENTS.has(descriptor.contract)
    ? sessionScopedIdempotencyKey(descriptor.idempotency_key_field)
    : payloadFieldIdempotencyKey(descriptor.idempotency_key_field);
  return { workflow, idempotencyKeyForEvent: keyFn };
}

/**
 * Per-event: the artifact-persist node scopes rows by the TRIGGER payload's `<scope>_id`,
 * so the declared scope key must be among the SPECIFIC triggering workflow's event `payload_keys`.
 * Deliberately NOT a union across all mounted events — with a second event in the vocabulary, a
 * union would accept a scope only the OTHER event's payload carries, re-opening the exact
 * every-persist-fails-'persist_scope_missing' hole this closed (pinned fail-the-fix by the
 * two-descriptor union test).
 */
export function requirePersistScopeInTriggerPayload(check: {
  readonly workflowId: string;
  /** The compiled workflow's canonical trigger event id. */
  readonly triggerEvent: string;
  /** The single declared persist scope (the materializer scopes rows by `<scope>_id`). */
  readonly scope: string;
  /** The persisted artifact kinds (for the actionable rejection message). */
  readonly persistingKinds: readonly string[];
  readonly descriptors: ReadonlyMap<string, TriggerEventDescriptor>;
}): void {
  const descriptor = check.descriptors.get(check.triggerEvent);
  if (!descriptor) {
    throw new ProductComposeError(
      'unsupported_spec',
      `workflow '${check.workflowId}' triggers on event '${check.triggerEvent}', which no mounted ` +
        'capability declares a descriptor for — the persist scope cannot be validated against an ' +
        'undeclared payload contract (fail-closed).',
    );
  }
  const scopeColumn = `${check.scope}_id`;
  if (!descriptor.payload_keys.includes(scopeColumn)) {
    throw new ProductComposeError(
      'unsupported_spec',
      `persisted artifact kind(s) ${check.persistingKinds.map((k) => `'${k}'`).join(', ')} declare ` +
        `scope '${check.scope}', but workflow '${check.workflowId}' trigger event ` +
        `'${check.triggerEvent}' payload contract carries no '${scopeColumn}' (payload keys: ` +
        `${descriptor.payload_keys.join(', ')}) — the artifact.persist node scopes rows by the ` +
        "trigger payload's '<scope>_id' and would fail on EVERY run.",
    );
  }
}
