/**
 * The CAPABILITY-OWNED store composition for one Product-YAML doc (S3/S4) — the ONE
 * helper the deploy composition, the server boot, and the CLI's product-profile derivation all consume, so the
 * three call sites can never drift on WHICH capability stores a doc mounts (the boot↔compose
 * lockstep hazard, killed structurally). ALL capabilities are CONDITIONAL-BY-DECLARATION: the
 * audio half joins iff the doc declares `audio_input`/`media_playback` (S4), the record half iff it
 * declares `record_input` (S3), the file half iff it declares `file_input` (S2), the
 * conversation half iff it declares `conversation_input` (S2). A doc declaring audio has its
 * capability store set byte-identical to the pre-S4 unconditional prepend — the compose
 * golden pins that.
 *
 * Content identity: `mountAudioCapability().stores` / `mountRecordCapability().stores` /
 * `mountFileCapability().stores` / `mountConversationCapability().stores` return exactly
 * `audioCapabilityStores()` / `recordCapabilityStores()` / `fileCapabilityStores()` /
 * `conversationCapabilityStores()` (each pinned by its capability's neutrality gate + mount
 * tests), so a composition consuming the MOUNT fragments and a boot consuming THIS helper
 * materialize the same store set — under the SAME declaration predicate.
 */
import {
  AUDIO_CAPABILITY_MANIFEST,
  AUDIO_STORE_NAMES,
  audioCapabilityStores,
} from '@rayspec/audio-runtime';
import {
  CONVERSATION_CAPABILITY_MANIFEST,
  CONVERSATION_STORE_NAMES,
  conversationCapabilityStores,
} from '@rayspec/conversation-runtime';
import {
  FILE_CAPABILITY_MANIFEST,
  FILE_STORE_NAMES,
  fileCapabilityStores,
} from '@rayspec/file-runtime';
import {
  RECORD_INPUT_CAPABILITY_ID,
  RECORD_STORE_NAMES,
  recordCapabilityStores,
} from '@rayspec/record-runtime';
import type { ProductSpec, StoreSpec } from '@rayspec/spec';

/**
 * The capability ids the audio runtime owns (`audio_input`, `media_playback`) — sourced from the audio
 * manifest so the predicate can never drift from the mounted surface. Declaring EITHER mounts the audio
 * capability (a doc may declare both; the compose mount, boot env demands, and store set all key off this).
 */
const AUDIO_CAPABILITY_IDS: ReadonlySet<string> = new Set(
  AUDIO_CAPABILITY_MANIFEST.capabilities.map((c) => c.id),
);

/** Does the doc declare the audio capability (the S4 conditional-mount predicate)? */
export function declaresAudio(spec: ProductSpec): boolean {
  return spec.capabilities.some((c) => AUDIO_CAPABILITY_IDS.has(c.id));
}

/** Does the doc declare the record_input capability (the S3 conditional-mount predicate)? */
export function declaresRecordInput(spec: ProductSpec): boolean {
  return spec.capabilities.some((c) => c.id === RECORD_INPUT_CAPABILITY_ID);
}

/**
 * The capability ids the file runtime owns (`file_input`) — sourced from the file manifest so the
 * predicate can never drift from the mounted surface (the declaresAudio-from-manifest pattern; the
 * id is deliberately NOT a string literal duplicated here).
 */
const FILE_CAPABILITY_IDS: ReadonlySet<string> = new Set(
  FILE_CAPABILITY_MANIFEST.capabilities.map((c) => c.id),
);

/** Does the doc declare the file_input capability (the S2 conditional-mount predicate)? */
export function declaresFileInput(spec: ProductSpec): boolean {
  return spec.capabilities.some((c) => FILE_CAPABILITY_IDS.has(c.id));
}

/**
 * The capability ids the conversation runtime owns (`conversation_input`) — sourced from the
 * conversation manifest so the predicate can never drift from the mounted surface (the
 * declaresAudio/declaresFileInput-from-manifest pattern; the id is deliberately NOT a string
 * literal duplicated here).
 */
const CONVERSATION_CAPABILITY_IDS: ReadonlySet<string> = new Set(
  CONVERSATION_CAPABILITY_MANIFEST.capabilities.map((c) => c.id),
);

/** Does the doc declare the conversation_input capability (the S2 conditional-mount predicate)? */
export function declaresConversationInput(spec: ProductSpec): boolean {
  return spec.capabilities.some((c) => CONVERSATION_CAPABILITY_IDS.has(c.id));
}

export interface CapabilityStoreComposition {
  /**
   * The capability-owned stores this doc mounts (audio iff declared — S4; record — S3; file —
   * S2; conversation — S2).
   */
  readonly stores: StoreSpec[];
  /**
   * Their name set — what `deriveProductStores` / `checkProductStores` take to tell capability
   * stores apart from a product's own (the LAYER-DRY-1 pattern, now spec-aware).
   */
  readonly names: ReadonlySet<string>;
}

/** The capability-owned store composition for `spec` (see the module header). */
export function composeCapabilityStores(spec: ProductSpec): CapabilityStoreComposition {
  const withAudio = declaresAudio(spec);
  const withRecord = declaresRecordInput(spec);
  const withFile = declaresFileInput(spec);
  const withConversation = declaresConversationInput(spec);
  return {
    // ORDER: audio (when declared) then record then file then conversation (each when declared) —
    // the pre-S4 prepend order for a doc declaring audio only, so its set is byte-identical
    // (the compose golden).
    stores: [
      ...(withAudio ? audioCapabilityStores() : []),
      ...(withRecord ? recordCapabilityStores() : []),
      ...(withFile ? fileCapabilityStores() : []),
      ...(withConversation ? conversationCapabilityStores() : []),
    ],
    names: new Set<string>([
      ...(withAudio ? AUDIO_STORE_NAMES : []),
      ...(withRecord ? RECORD_STORE_NAMES : []),
      ...(withFile ? FILE_STORE_NAMES : []),
      ...(withConversation ? CONVERSATION_STORE_NAMES : []),
    ]),
  };
}
