import {
  contentTypeForTtsFormat,
  normalizeTtsRequest,
  TtsAdapterError,
  type TtsAdapter,
  type TtsSynthesisResult,
  type TtsSynthesizeRequest,
} from '@rayspec/tts-port';
import {
  DEFAULT_OPENAI_TTS_MODEL,
  OPENAI_TTS_ADAPTER_ID,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_POLICY,
  type OpenAiTtsModel,
} from './openai-tts-boundary.js';

/**
 * The real OpenAI text-to-speech adapter — the first live provider behind the neutral `TtsAdapter`
 * contract. ONE REST `POST` to `/v1/audio/speech` carrying exactly `model`, `input`, `voice`,
 * `response_format` and `speed`, with `Authorization: Bearer <key>`, and the raw response bytes ARE
 * the audio. No provider SDK — a single global `fetch`, a deliberate choice (this package's only
 * runtime dependency is the neutral port, so wiring a second speech provider moves no third-party
 * code into the dependency closure; the wire contract here is stable and small).
 *
 * This module is the ONLY file in the package permitted to make a network call or read
 * `OPENAI_API_KEY` (enforced by the confinement scan). Consequences that hold the neutral guardrails:
 *   - The key is resolved LAZILY at call time — importing or constructing the adapter never needs it,
 *     so CI (no key) imports the package and runs every deterministic test network-free.
 *   - Errors are content-free (the untrusted-content boundary): a failure surfaces the HTTP status +
 *     the provider name or the error CLASS name ONLY. The response body, the text being spoken, the
 *     `Authorization` header, and the API key are NEVER echoed into a message, log, or artifact.
 *   - The request is validated against this adapter's own policy BEFORE the key is read and before any
 *     network call, so an over-long text or an unknown voice is refused without ever being billed —
 *     and the offline fake, handed the SAME policy, refuses exactly the same requests.
 *
 * The two documented options that do NOT work with these models (a per-request instruction string and
 * a streaming response format) are never sent — an adapter that forwarded them would produce requests
 * the wired models reject.
 */

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';

export interface OpenAiTtsAdapterOptions {
  /** Synthesis model; defaults to `tts-1`. Validated against this adapter's wired models. */
  model?: string;
  /** API base URL; defaults to `OPENAI_BASE_URL` env then the real host (test seam parity). */
  baseUrl?: string;
  /** Explicit API key; when unset the key is resolved lazily from `env.OPENAI_API_KEY` at call time. */
  apiKey?: string;
  /** Environment source for lazy key/base-url resolution; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable fetch for deterministic tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class OpenAiTtsAdapter implements TtsAdapter {
  readonly id = OPENAI_TTS_ADAPTER_ID;

  private readonly model: OpenAiTtsModel;
  private readonly apiKeyOption?: string;
  private readonly baseUrlOption?: string;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiTtsAdapterOptions = {}) {
    const model = options.model?.trim() || DEFAULT_OPENAI_TTS_MODEL;
    if (!(OPENAI_TTS_MODELS as readonly string[]).includes(model)) {
      // Fail-closed at CONSTRUCTION (boot), not at the first request: a deployment that named a model
      // this adapter does not wire should never reach a billable call.
      throw new TtsAdapterError(
        'unsupported_option',
        `model '${model}' is not supported by this adapter (wired: ${OPENAI_TTS_MODELS.join(' | ')}).`,
      );
    }
    this.model = model as OpenAiTtsModel;
    this.apiKeyOption = options.apiKey;
    this.baseUrlOption = options.baseUrl;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Synthesize one text via a single `POST /v1/audio/speech`. The response body is the audio itself
   * (not JSON), so the content type is derived from the container WE asked for rather than trusted
   * from the response — the two cannot disagree, because a 2xx that carried JSON instead of audio is
   * mapped to `malformed_provider_output` below.
   *
   * `durationSeconds` is `null`: the endpoint does not report a duration, and deriving one from the
   * text length would be a fabrication dressed as provenance.
   */
  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesisResult> {
    // Refuse an invalid request BEFORE reading the credential and BEFORE any network call.
    const normalized = normalizeTtsRequest(request, OPENAI_TTS_POLICY);

    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new TtsAdapterError('provider_unavailable', 'OpenAI API key is not configured.');
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.resolveBaseUrl()}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: normalized.text,
          voice: normalized.voice,
          response_format: normalized.format,
          speed: normalized.speed,
        }),
      });
    } catch (err) {
      // Transport failure — class name only, never a message that could echo the text or the key.
      throw new TtsAdapterError(
        'provider_unavailable',
        `openai tts request failed: ${errorName(err)}`,
        true,
      );
    }

    if (!(response.status >= 200 && response.status < 300)) {
      // Status + provider name ONLY — never the response body (it can quote the submitted text).
      const retryable = response.status === 429 || response.status >= 500;
      throw new TtsAdapterError(
        'provider_unavailable',
        `openai tts synthesis failed: HTTP ${response.status}`,
        retryable,
      );
    }

    // A 2xx that carries JSON carries an envelope, not audio — never hand a caller a JSON blob
    // labelled `audio/mpeg`. The header is the cheap read (it saves buffering the body); the BYTES
    // are the authority, checked below, because a response with no content-type at all reaches here
    // with the header guard skipped.
    if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      throw new TtsAdapterError(
        'malformed_provider_output',
        'openai tts returned a JSON body where audio was expected.',
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      throw new TtsAdapterError(
        'malformed_provider_output',
        `openai tts response could not be read: ${errorName(err)}`,
      );
    }
    if (bytes.length === 0) {
      throw new TtsAdapterError(
        'malformed_provider_output',
        'openai tts returned an empty audio body.',
      );
    }
    // The same refusal, decided on the BYTES rather than on a header the response need not carry.
    if (startsWithJsonPunctuation(bytes)) {
      throw new TtsAdapterError(
        'malformed_provider_output',
        'openai tts returned a JSON body where audio was expected.',
      );
    }

    return {
      bytes,
      contentType: contentTypeForTtsFormat(normalized.format),
      durationSeconds: null,
    };
  }

  private resolveApiKey(): string | undefined {
    const key = (this.apiKeyOption ?? this.env.OPENAI_API_KEY)?.trim();
    return key ? key : undefined;
  }

  private resolveBaseUrl(): string {
    const configured =
      this.baseUrlOption?.trim() || this.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL;
    // Strip trailing '/' with a linear backward scan (a `/\/+$/` regex backtracks polynomially on a
    // long slash run). Byte-identical result for every input.
    let end = configured.length;
    while (end > 0 && configured.charCodeAt(end - 1) === 47 /* '/' */) end--;
    return configured.slice(0, end);
  }
}

/** The error's class name only — never its message (which could echo the text or the key). */
function errorName(err: unknown): string {
  return err instanceof Error && typeof err.name === 'string' ? err.name : 'Error';
}

/**
 * Does the body OPEN like a JSON document — `{` or `[` after leading ASCII whitespace?
 *
 * A one-way test, deliberately: it decides that these bytes are NOT audio, never that they are. None
 * of the three containers the port speaks can begin this way — `wav` opens with `RIFF` (0x52), `opus`
 * with `OggS` (0x4F), and `mp3` with either `ID3` (0x49) or a frame sync whose first byte is 0xFF —
 * so a leading `{`/`[` rules audio out. Nothing is parsed and nothing is decoded: the bytes are
 * untrusted provider output, and this reads at most a handful of them.
 */
function startsWithJsonPunctuation(bytes: Uint8Array): boolean {
  const LIMIT = Math.min(bytes.length, 16);
  for (let i = 0; i < LIMIT; i++) {
    const byte = bytes[i];
    // Space, tab, LF, CR — the whitespace JSON allows before the opening token.
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b /* '{' */ || byte === 0x5b /* '[' */;
  }
  return false;
}
