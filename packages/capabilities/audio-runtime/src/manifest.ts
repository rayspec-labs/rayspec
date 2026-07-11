/**
 * The machine-readable capability manifest — the descriptor an authoring assistant /
 * the Product YAML parser inspects. It declares the RUNTIME realization of the `audio_input` +
 * `media_playback` contracts. The `session_finalized` event is declared here with its
 * canonical contract id `audio_input.finalized_session` — the id the product lint normalizes a
 * `trigger: { capability: audio_input, event: session_finalized }` to and requires as a declared
 * capability contract.
 *
 * ZERO product vocabulary. This is the SOURCE OF TRUTH;
 * the committed `manifest.json` at the package root MUST equal it (asserted by manifest.test.ts) and is
 * what the repo's capability-manifest gate reads.
 */
import type { TriggerEventDescriptor } from '@rayspec/spec';

/**
 * The audio realization of the SHARED per-event descriptor contract (`TriggerEventDescriptor`,
 * `@rayspec/spec` product-events.ts): the base declares `id` (the event name a workflow trigger
 * references), `contract` (the canonical Tier B contract id the event normalizes to — what the product
 * lint / the bridge validates against), `payload_keys` (the EXACT canonical payload keys, the compose-time
 * scope contract — coupled fail-the-fix to the seam adapter's emitted payload by
 * `@rayspec/audio-workflow-bridge` adapter.test.ts), and `idempotency_key_field` (the payload field
 * the durable run's single-flight key derives from — `session_id`; the derived key format
 * `session_id:<id>:finalized` is byte-frozen live run identity). This extension only NARROWS the
 * dedup-scope label: session-scoped single-flight for a dual-track finalize.
 */
export interface CapabilityEventDescriptor extends TriggerEventDescriptor {
  /** How downstream consumption is deduped — session-scoped single-flight for a dual-track finalize. */
  readonly idempotency: 'session_scoped';
}

export interface CapabilityRouteDescriptor {
  readonly id: string;
  readonly method: 'GET' | 'POST';
  /** The route path template (relative to the mount base). */
  readonly path: string;
  /** The contract this route realizes. */
  readonly contract: string;
  /** The auth path: the standard bearer chain, or the distinct media-token second auth path. */
  readonly auth: 'bearer' | 'media_token';
  /** How the platform mounts it (a normal handler route or a raw byte stream route). */
  readonly kind: 'handler' | 'stream_ingest' | 'stream_playback';
}

export interface CapabilityDescriptor {
  readonly id: 'audio_input' | 'media_playback';
  readonly tier: 'B';
  readonly runtime_status: 'available';
  readonly contracts: readonly string[];
  readonly events: readonly CapabilityEventDescriptor[];
}

export interface AudioCapabilityManifest {
  readonly stage: '3';
  /** RUNTIME realization (distinct from the frozen contract-only doc manifest). */
  readonly status: 'runtime';
  readonly package: '@rayspec/audio-runtime';
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly stores: readonly string[];
  readonly routes: readonly CapabilityRouteDescriptor[];
}

export const AUDIO_CAPABILITY_MANIFEST: AudioCapabilityManifest = {
  stage: '3',
  status: 'runtime',
  package: '@rayspec/audio-runtime',
  capabilities: [
    {
      id: 'audio_input',
      tier: 'B',
      runtime_status: 'available',
      contracts: [
        'audio_input.session',
        'audio_input.track',
        'audio_input.chunk',
        'audio_input.upload_status',
        'audio_input.finalize_track',
        'audio_input.finalized_session',
      ],
      events: [
        {
          id: 'session_finalized',
          contract: 'audio_input.finalized_session',
          idempotency: 'session_scoped',
          payload_keys: ['session_id', 'tenant_id', 'tracks', 'source_capability'],
          idempotency_key_field: 'session_id',
        },
      ],
    },
    {
      id: 'media_playback',
      tier: 'B',
      runtime_status: 'available',
      contracts: ['media_playback.token', 'media_playback.stream'],
      events: [],
    },
  ],
  stores: ['audio_sessions', 'audio_tracks'],
  routes: [
    {
      id: 'chunk_ingest',
      method: 'POST',
      path: '/{session_id}/{track}/chunks/{chunk_index}',
      contract: 'audio_input.chunk',
      auth: 'bearer',
      kind: 'stream_ingest',
    },
    {
      id: 'upload_status',
      method: 'GET',
      path: '/{session_id}/{track}/upload-status',
      contract: 'audio_input.upload_status',
      auth: 'bearer',
      kind: 'handler',
    },
    {
      id: 'finalize_track',
      method: 'POST',
      path: '/{session_id}/{track}/finalize',
      contract: 'audio_input.finalize_track',
      auth: 'bearer',
      kind: 'handler',
    },
    {
      id: 'play_token',
      method: 'POST',
      path: '/{session_id}/{track}/play-token',
      contract: 'media_playback.token',
      auth: 'bearer',
      kind: 'handler',
    },
    {
      id: 'playback',
      method: 'GET',
      path: '/{session_id}/{track}/playback',
      contract: 'media_playback.stream',
      auth: 'media_token',
      kind: 'stream_playback',
    },
  ],
};
