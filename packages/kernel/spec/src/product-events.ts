/**
 * The SHARED Product-YAML trigger-event vocabulary.
 *
 * Before S1 the trigger normalization lived as TWO byte-identical KEEP-IN-SYNC copies
 * (`product-lint.ts` `compileProductTriggerEvent` + the workflow bridge's `compileTriggerEvent`) plus a
 * THIRD hardcode in `@rayspec/product-yaml`'s capability inventory. This module is now the ONE
 * source both the parser lint and the bridge compiler import, and the descriptor contract the deploy
 * composition consumes — the cross-package parity test in `@rayspec/product-yaml-workflow-bridge`
 * (`product-bridge-parity.test.ts`) pins the single-source invariant structurally (identity +
 * behavior), so a re-introduced local copy or a behavioral divergence fails CI.
 *
 * This is a PRODUCT-side module: it must never import a runtime package (the Tier-B runtimes import
 * @rayspec/spec, not the reverse), and it is NOT `grammar.ts` (kill-set, byte-frozen).
 */

/**
 * One alias row: a doc-level `(capability, event)` trigger pair whose canonical Tier-B event id is NOT
 * the default `${capability}.${event}` join. Declarative on purpose — the audio special-case is DATA
 * here, not a branch scattered across packages. New capabilities should use the default join and add
 * NO alias; an alias exists only to honor an already-shipped canonical id.
 */
export interface ProductTriggerEventAlias {
  readonly capability: string;
  readonly event: string;
  /** The canonical Tier-B event/contract id the pair normalizes to. */
  readonly canonical: string;
}

/**
 * The closed alias table. Exactly ONE entry today: the audio capability's `session_finalized` event,
 * whose canonical id `audio_input.finalized_session` predates the default-join convention and feeds
 * a deployed product's LIVE run identity — it can never be renamed (a re-key duplicates live runs on
 * redelivery).
 */
export const PRODUCT_TRIGGER_EVENT_ALIASES: readonly ProductTriggerEventAlias[] = Object.freeze([
  {
    capability: 'audio_input',
    event: 'session_finalized',
    canonical: 'audio_input.finalized_session',
  },
]);

/**
 * THE canonical trigger-event normalization: a workflow trigger's `{ capability, event }` pair → the
 * canonical Tier-B event id. Aliased pairs (the table above) map to their shipped canonical id; every
 * other pair is the default `${capability}.${event}` join. This is the SINGLE source — the parser lint
 * (`lintProductSpec`), the workflow bridge compiler, and the deploy composition all consume THIS
 * function (parity-pinned; never re-copy it locally).
 */
export function normalizeProductTriggerEvent(capability: string, event: string): string {
  for (const alias of PRODUCT_TRIGGER_EVENT_ALIASES) {
    if (alias.capability === capability && alias.event === event) return alias.canonical;
  }
  return `${capability}.${event}`;
}

/**
 * The per-event DESCRIPTOR contract (the vocabulary entry a deploy composition consumes). A Tier-B
 * capability declares one per emitted trigger event (e.g. `@rayspec/audio-runtime`'s
 * `CapabilityEventDescriptor` extends this); `composeProductDeploy` builds its capability inventory,
 * its persist-scope (CC-1) check, and its per-trigger idempotency-key derivation from these — never
 * from hardcodes.
 */
export interface TriggerEventDescriptor {
  /** The event name a workflow trigger references (`trigger.event`). */
  readonly id: string;
  /**
   * The canonical Tier-B contract id the event normalizes to — REQUIRED to equal
   * `normalizeProductTriggerEvent(<capability id>, id)` (the composition verifies this coherence
   * fail-closed). This is the id the dispatcher matches on and the bridge validates against.
   */
  readonly contract: string;
  /** The dedup-scope label (documentation-grade; e.g. `session_scoped`). */
  readonly idempotency: string;
  /**
   * The EXACT keys of the event's canonical payload (DATA only, never instructions). The compose-time
   * persist-scope check (CC-1) validates a declared artifact scope against THIS event's keys — never a
   * union across events (a union would re-admit scopes the triggering event cannot satisfy).
   */
  readonly payload_keys: readonly string[];
  /**
   * The payload field the durable run's single-flight idempotency key derives from (C10). MUST be one
   * of `payload_keys`. For the audio event this is `session_id`, and the derived key format
   * `session_id:<id>:finalized` is byte-frozen (live run identity).
   */
  readonly idempotency_key_field: string;
}
