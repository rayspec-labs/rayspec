/**
 * The ONE request-normalization definition every adapter behind this port shares — the reason a
 * request that passes offline cannot first fail in production.
 *
 * A provider states its own limits (a character cap, a closed voice list, a speed range, a default
 * container) as a `TtsRequestPolicy`; `normalizeTtsRequest` then applies THE SAME rules to THE SAME
 * request whichever adapter is wired. The deterministic fake takes a policy too (a REQUIRED
 * constructor option — it stands IN for a real adapter, so it must refuse exactly what that adapter
 * refuses), which is what keeps a CI green honest: the cap, the voice membership and the speed clamp
 * are one implementation, not two that drift.
 *
 * The port holds no provider's VALUES — only the shape they take and the rules applied to them.
 */
import { TtsAdapterError, type TtsAudioFormat, type TtsSynthesizeRequest } from './types.js';

/** The audio containers the neutral port speaks (the runtime twin of `TtsAudioFormat`). */
export const TTS_AUDIO_FORMATS: readonly TtsAudioFormat[] = ['mp3', 'opus', 'wav'];

/** The limits ONE adapter enforces. Provider-specific VALUES; provider-neutral SHAPE. */
export interface TtsRequestPolicy {
  /** Maximum accepted text length. Over it the request is REFUSED (never truncated). */
  readonly maxTextLength: number;
  /** The adapter's closed voice list — an unlisted voice is refused. */
  readonly voices: readonly string[];
  /** The voice used when the caller names none. Must itself be a member of `voices`. */
  readonly defaultVoice: string;
  /** Lower/upper bound of the supported speaking rate; a caller's `speed` is CLAMPED into it. */
  readonly minSpeed: number;
  readonly maxSpeed: number;
  /** The container returned when the caller names none. */
  readonly defaultFormat: TtsAudioFormat;
}

/** A request with every option resolved — what an adapter actually sends. */
export interface NormalizedTtsRequest {
  readonly text: string;
  readonly voice: string;
  readonly speed: number;
  readonly format: TtsAudioFormat;
}

/** The content type that honestly describes bytes in the given container. */
export function contentTypeForTtsFormat(format: TtsAudioFormat): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    // `opus` is Ogg-encapsulated Opus — the container is Ogg, so that is what the type must say.
    case 'opus':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
  }
}

/**
 * Validate + resolve one request against an adapter's policy, or THROW a structured, content-free
 * `TtsAdapterError`. Called BEFORE any credential is read and before any provider call, so a refused
 * request never bills and never leaves the process.
 *
 * The rules, in the order they are applied:
 *   1. `text` must be non-blank — an empty synthesis is a caller bug, not a silent zero-length file.
 *   2. `text` must be within `maxTextLength`. FAIL-CLOSED: over the cap the call is REFUSED. Truncating
 *      would hand back a recording that stops mid-sentence and looks successful. The length is measured
 *      in UTF-16 code units, so a text of astral characters is measured conservatively (the refusal can
 *      only ever be stricter than the provider's own count, never laxer).
 *   3. `voice`, when named, must be a MEMBER of the adapter's list — never a silent fallback.
 *   4. `format`, when named, must be one the port speaks.
 *   5. `speed`, when named, must be finite, and is then CLAMPED into [minSpeed, maxSpeed] — a rate
 *      outside the range is a clamp, not a refusal (the documented contract for this field).
 * The text itself is never echoed into a message; only its LENGTH is (a number is not content).
 */
export function normalizeTtsRequest(
  request: TtsSynthesizeRequest,
  policy: TtsRequestPolicy,
): NormalizedTtsRequest {
  const text = request.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TtsAdapterError(
      'invalid_request',
      'synthesis text is empty (nothing to synthesize).',
    );
  }
  if (text.length > policy.maxTextLength) {
    throw new TtsAdapterError(
      'invalid_request',
      `synthesis text is ${text.length} characters, over this adapter's cap of ` +
        `${policy.maxTextLength} (fail-closed — the text is never truncated).`,
    );
  }

  const voice = request.voice?.trim() || policy.defaultVoice;
  if (!policy.voices.includes(voice)) {
    throw new TtsAdapterError(
      'unsupported_option',
      `voice '${voice}' is not supported by this adapter (wired: ${policy.voices.join(' | ')}).`,
    );
  }

  const format = request.format ?? policy.defaultFormat;
  if (!TTS_AUDIO_FORMATS.includes(format)) {
    throw new TtsAdapterError(
      'unsupported_option',
      `format '${format}' is not supported (wired: ${TTS_AUDIO_FORMATS.join(' | ')}).`,
    );
  }

  const requestedSpeed = request.speed;
  let speed = 1;
  if (requestedSpeed !== undefined) {
    if (typeof requestedSpeed !== 'number' || !Number.isFinite(requestedSpeed)) {
      throw new TtsAdapterError('invalid_request', 'speed must be a finite number.');
    }
    speed = Math.min(policy.maxSpeed, Math.max(policy.minSpeed, requestedSpeed));
  }

  return { text, voice, speed, format };
}
