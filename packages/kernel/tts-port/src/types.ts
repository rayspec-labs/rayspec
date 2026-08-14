/** The audio containers the neutral port speaks. A provider that offers more encodes into one of these. */
export type TtsAudioFormat = 'mp3' | 'opus' | 'wav';

/**
 * One synthesis request. Every field but `text` is OPTIONAL and a plain value; an adapter resolves the
 * absent ones from its OWN policy (see `TtsRequestPolicy`) rather than the port picking a default —
 * the port names no provider, so it holds no provider's voice list, cap, or speed range.
 */
export interface TtsSynthesizeRequest {
  /** The text to speak. Provider caps (e.g. a maximum character count) are enforced FAIL-CLOSED —
   *  an over-long text is REFUSED, never silently truncated into a partial recording. */
  text: string;
  /** The provider voice id. The adapter validates MEMBERSHIP against its own closed list — an unknown
   *  voice is refused rather than quietly falling back to a default the caller did not ask for. That
   *  includes a BLANK one: `''` and `'   '` are named voices and are refused. The adapter's default
   *  is reached by an ABSENT `voice` — and by a `null` one, which only an untyped caller can send and
   *  which is read as absent (`request-policy.test.ts` pins both). */
  voice?: string;
  /** Speaking rate; CLAMPED into the provider's supported range (out-of-range is not an error). */
  speed?: number;
  /** The audio container to return. Absent ⇒ the adapter's default. */
  format?: 'mp3' | 'opus' | 'wav';
}

/** The synthesized audio: the bytes, the content type that describes them, and the duration if known. */
export interface TtsSynthesisResult {
  bytes: Uint8Array;
  contentType: string;
  /** Playback length when the adapter can state it honestly; `null`/absent when the provider does not
   *  report one (never a guess derived from the text). */
  durationSeconds?: number | null;
}

/**
 * The provider-NEUTRAL text-to-speech contract. One method: text (plus plain options) in, audio bytes
 * out. Nothing here names or imports a provider — a concrete adapter depends on this port, never the
 * reverse, so a second provider is added WITHOUT a port change.
 */
export interface TtsAdapter {
  readonly id: string;
  synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesisResult>;
}

/**
 * The failure classes a synthesis can end in. `synthesize` returns the AUDIO (not a result union — the
 * happy path is bytes, and a caller that must branch on every call to reach them is worse), so a
 * failure is a THROW of `TtsAdapterError` carrying one of these codes.
 *
 *   - `invalid_request`           the request violates a stated limit (empty text, over the cap, a
 *                                 non-finite speed) — the adapter refuses it WITHOUT a provider call.
 *   - `unsupported_option`        a well-formed option this adapter does not offer (an unknown voice
 *                                 or format) — also refused without a provider call.
 *   - `provider_unavailable`      no credential, a transport failure, or an upstream non-2xx.
 *   - `malformed_provider_output` a 2xx that did not carry usable audio.
 *   - `unknown`                   anything else, reported by class name only.
 */
export type TtsErrorCode =
  | 'invalid_request'
  | 'unsupported_option'
  | 'provider_unavailable'
  | 'malformed_provider_output'
  | 'unknown';

/**
 * The structured, CONTENT-FREE synthesis failure. A message names the failing CONDITION (a code, an
 * HTTP status, an error class name, a numeric length against a numeric cap) and NEVER the text being
 * spoken, the response body, or the credential — an adapter that echoed any of those would turn a log
 * line into an exfiltration channel.
 */
export class TtsAdapterError extends Error {
  readonly code: TtsErrorCode;
  readonly retryable: boolean;

  constructor(code: TtsErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'TtsAdapterError';
    this.code = code;
    this.retryable = retryable;
  }
}
