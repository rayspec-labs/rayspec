import type { TtsRequestPolicy } from '@rayspec/tts-port';

export const OPENAI_TTS_ADAPTER_ID = 'openai-tts';

/** The synthesis models this adapter wires. Both take the same request shape. */
export const OPENAI_TTS_MODELS = ['tts-1', 'tts-1-hd'] as const;
export type OpenAiTtsModel = (typeof OPENAI_TTS_MODELS)[number];

export const DEFAULT_OPENAI_TTS_MODEL: OpenAiTtsModel = 'tts-1';

/**
 * THIS ADAPTER'S OWN request policy — deliberately a closed list maintained here, not a mirror of a
 * provider SDK's type (which is an OPEN `string` union and so constrains nothing, and whose prose and
 * type do not agree about which voices exist). A closed list is what makes the issue's "adapter
 * validates membership" real: an unknown voice is refused HERE, before a request is billed, instead of
 * reaching the provider and coming back as an opaque 400.
 *
 * Reviewing an addition is therefore a deliberate act: add a voice only after confirming the provider
 * documents it, and the offline fake inherits the change automatically (it is handed THIS policy).
 *
 * The values:
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
    'ballad',
    'cedar',
    'coral',
    'echo',
    'fable',
    'marin',
    'nova',
    'onyx',
    'sage',
    'shimmer',
    'verse',
  ],
  defaultVoice: 'alloy',
  minSpeed: 0.25,
  maxSpeed: 4,
  defaultFormat: 'mp3',
};
