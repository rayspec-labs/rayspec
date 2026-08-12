import type { TtsRequestPolicy } from '@rayspec/tts-port';

export const OPENAI_TTS_ADAPTER_ID = 'openai-tts';

/** The synthesis models this adapter wires. Both take the same request shape. */
export const OPENAI_TTS_MODELS = ['tts-1', 'tts-1-hd'] as const;
export type OpenAiTtsModel = (typeof OPENAI_TTS_MODELS)[number];

export const DEFAULT_OPENAI_TTS_MODEL: OpenAiTtsModel = 'tts-1';

/**
 * THIS ADAPTER'S OWN request policy — a closed list maintained here, so an unknown voice is refused
 * HERE, before a request is billed, instead of reaching the provider and coming back as an opaque 400.
 * That is what makes "the adapter validates membership" real rather than aspirational.
 *
 * The list is MODEL-SCOPED: every entry is a voice the wired models (`tts-1` / `tts-1-hd`) actually
 * accept, each one confirmed against the live endpoint rather than assumed. That confirmation is the
 * whole point of the shared policy: the offline fake is handed THIS object, so a voice the list admits
 * but the wired models reject would pass offline and fail on the wire — exactly the dev/CI-versus-
 * production split the policy exists to prevent.
 *
 * Adding a voice is therefore a deliberate act: confirm the wired models accept it (the live smoke
 * loops this list against the real endpoint and goes red on any that do not), then add it here — the
 * fake inherits the change automatically. Should the two models ever diverge, this becomes a
 * per-model list rather than a widened shared one.
 *
 * The remaining values:
 *   - `maxTextLength` 4096 — the documented input cap. Over it the call is REFUSED, never truncated.
 *   - `minSpeed`/`maxSpeed` 0.25/4.0 — the documented rate range. The wire field is a bare number with
 *     no provider-side clamp, so an out-of-range value is clamped HERE (the port's stated contract).
 *   - `defaultFormat` mp3 — the provider's own default, kept so an unspecified request is unsurprising.
 */
export const OPENAI_TTS_POLICY: TtsRequestPolicy = {
  maxTextLength: 4096,
  voices: [
    'alloy',
    'ash',
    'coral',
    'echo',
    'fable',
    'nova',
    'onyx',
    'sage',
    'shimmer',
  ],
  defaultVoice: 'alloy',
  minSpeed: 0.25,
  maxSpeed: 4,
  defaultFormat: 'mp3',
};
