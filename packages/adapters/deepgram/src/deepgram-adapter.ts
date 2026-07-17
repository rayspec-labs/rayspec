import {
  type SttAdapter,
  type SttAdapterError,
  type SttLanguagePolicy,
  SttMediaResolutionError,
  type SttMediaResolver,
  type SttMediaSource,
  type SttModelPolicy,
  type SttTranscribeSessionRequest,
  type SttTranscribeTrackRequest,
  type SttTranscriptionResult,
} from '@rayspec/stt-port';
import { DEEPGRAM_STT_ADAPTER_ID } from './deepgram-boundary.js';
import { DeepgramMappingError, mapDeepgramResponse } from './deepgram-response.js';

/**
 * The real Deepgram STT adapter — the first live provider behind the neutral `SttAdapter`
 * contract. It is wire-faithful to a proven production STT implementation: ONE REST `POST` to
 * `/v1/listen` with `model` (default `nova-2`), `smart_format`, `punctuate`, and `detect_language`,
 * `Authorization: Token <key>`. No Deepgram SDK — a single global `fetch`, a deliberate choice
 * (avoids an SDK-churn dependency; the wire contract is stable and small).
 *
 * This module is the ONLY file in the package permitted to make a network call or read
 * `DEEPGRAM_API_KEY` (enforced by the confinement scan). Consequences that hold the
 * neutral guardrails:
 *   - The key is resolved LAZILY at call time — importing or constructing the adapter never needs it,
 *     so CI (no key) imports the package and runs every deterministic test network-free.
 *   - Errors are content-free (the untrusted-content boundary): a failure surfaces the HTTP status + provider name
 *     or the error CLASS name ONLY. The response body, request audio, `Authorization` header, and the
 *     API key are NEVER echoed into a message, log, journal, or artifact.
 *   - The response maps into the SAME public transcript artifact the fake adapter produces.
 */

const DEFAULT_DEEPGRAM_MODEL = 'nova-2';
const DEFAULT_DEEPGRAM_BASE_URL = 'https://api.deepgram.com';
/** Default upload content type (the remuxed single-stream Ogg-Opus); overridable per media source. */
const DEFAULT_CONTENT_TYPE = 'audio/ogg';

export interface DeepgramSttAdapterOptions {
  /** Resolves a finalized track reference to its audio bytes (deployment-provided). */
  resolver: SttMediaResolver;
  /** Default Deepgram model; overridable per request via `model_policy.model_label`. */
  model?: string;
  /** API base URL; defaults to `DEEPGRAM_BASE_URL` env then the real host (test seam parity). */
  baseUrl?: string;
  /** Explicit API key; when unset the key is resolved lazily from `env.DEEPGRAM_API_KEY` at call time. */
  apiKey?: string;
  /** Environment source for lazy key/base-url resolution; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable fetch for deterministic tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ISO string) for deterministic tests; defaults to the real clock. */
  now?: () => string;
}

export class DeepgramSttAdapter implements SttAdapter {
  readonly id = DEEPGRAM_STT_ADAPTER_ID;
  readonly kind = 'provider' as const;

  private readonly resolver: SttMediaResolver;
  private readonly model: string;
  private readonly apiKeyOption?: string;
  private readonly baseUrlOption?: string;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;

  constructor(options: DeepgramSttAdapterOptions) {
    this.resolver = options.resolver;
    this.model = options.model?.trim() || DEFAULT_DEEPGRAM_MODEL;
    this.apiKeyOption = options.apiKey;
    this.baseUrlOption = options.baseUrl;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Transcribe one finalized track via a single `POST /v1/listen`.
   *
   * IDEMPOTENCY (accepted-but-not-deduped deferral): `request.idempotency_key` is accepted for
   * forward-compatibility but this adapter does NOT dedupe on it — every call issues a fresh billed
   * Deepgram request, so two identical calls today = two billed requests. Single-flight/dedup is the
   * Tier-A workflow-runtime's job (its `enqueueAgentRun` idempotency-key), NOT the provider adapter's.
   */
  async transcribeTrack(request: SttTranscribeTrackRequest): Promise<SttTranscriptionResult> {
    const optionError = this.validateOptions(request.model_policy, request.language_policy);
    if (optionError) return { status: 'failed', error: optionError };

    // The injected `SttMediaResolver` is the SINGLE media-source authority — the adapter does NOT gate
    // on `request.media_artifact_ref`. That field is an OPTIONAL opaque reference (`types.ts`); the
    // real resolvers key on `(session_id, track)` and never read it — the production `BlobRemux`
    // resolver reads a track's uploaded chunks, the in-memory `Static` resolver maps `(session, track)`.
    // A resolver that genuinely needs `media_artifact_ref` enforces that ITSELF (resolver-level). A
    // blanket adapter precondition here would fail EVERY fresh recording (the STT node never sets the
    // ref) even though the chunks are present — the production bug this contract mismatch caused. The
    // resolver is fail-closed: it throws `SttMediaResolutionError` when it cannot produce bytes (→
    // `not_ready` below), so genuinely-unfinalized media still fails closed WITHOUT a network call.
    let media: SttMediaSource;
    try {
      media = await this.resolver.resolve(request);
    } catch (err) {
      if (err instanceof SttMediaResolutionError) {
        return {
          status: 'failed',
          error: {
            code: 'not_ready',
            message: 'Finalized media artifact is not available for transcription.',
            retryable: false,
          },
        };
      }
      return {
        status: 'failed',
        error: {
          code: 'unknown',
          message: `media resolution failed: ${errorName(err)}`,
          retryable: false,
        },
      };
    }

    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      return {
        status: 'failed',
        error: {
          code: 'provider_unavailable',
          message: 'Deepgram API key is not configured.',
          retryable: false,
        },
      };
    }

    const url = this.buildListenUrl(request.model_policy, request.language_policy);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': media.contentType ?? DEFAULT_CONTENT_TYPE,
        },
        body: media.bytes,
      });
    } catch (err) {
      // Transport failure — class name only, never a message that could echo audio content or the key.
      return {
        status: 'failed',
        error: {
          code: 'provider_unavailable',
          message: `deepgram request failed: ${errorName(err)}`,
          retryable: true,
        },
      };
    }

    if (!(response.status >= 200 && response.status < 300)) {
      return { status: 'failed', error: httpError(response.status) };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        status: 'failed',
        error: {
          code: 'malformed_provider_output',
          message: 'deepgram returned a non-JSON response.',
          retryable: false,
        },
      };
    }

    try {
      const transcript = mapDeepgramResponse(payload, {
        session_id: request.session_id,
        track: request.track,
        model: this.resolveModel(request.model_policy),
        now: this.now(),
      });
      // An empty/silent recording is a VALID completed transcript, not an error.
      return { status: 'completed', transcript };
    } catch (err) {
      if (err instanceof DeepgramMappingError) {
        return {
          status: 'failed',
          error: {
            code: 'malformed_provider_output',
            message: 'deepgram returned an unmappable response shape.',
            retryable: false,
          },
        };
      }
      return {
        status: 'failed',
        error: {
          code: 'unknown',
          message: `deepgram mapping failed: ${errorName(err)}`,
          retryable: false,
        },
      };
    }
  }

  /**
   * Fan out to one `transcribeTrack` per finalized track (session model/language policy applied to
   * each). The session `idempotency_key` is forwarded but, as on `transcribeTrack`, is NOT deduped
   * here — dedup/single-flight belongs to the Tier-A workflow-runtime, not this adapter.
   */
  async transcribeSession(request: SttTranscribeSessionRequest): Promise<SttTranscriptionResult[]> {
    const results: SttTranscriptionResult[] = [];
    for (const track of request.tracks) {
      results.push(
        await this.transcribeTrack({
          ...track,
          language_policy: request.language_policy,
          model_policy: request.model_policy,
          idempotency_key: request.idempotency_key,
        }),
      );
    }
    return results;
  }

  /** Fail-closed on option combinations the proven production path does not support. */
  private validateOptions(
    modelPolicy: SttModelPolicy | undefined,
    languagePolicy: SttLanguagePolicy | undefined,
  ): SttAdapterError | null {
    if (modelPolicy?.diarization === 'provider_neutral') {
      return {
        code: 'unsupported_option',
        message:
          'Deepgram adapter does not support provider_neutral diarization (the proven path does not diarize).',
        retryable: false,
      };
    }
    if (languagePolicy?.language_hint && languagePolicy.detect_language === true) {
      return {
        code: 'unsupported_option',
        message: 'language_hint and detect_language are mutually exclusive.',
        retryable: false,
      };
    }
    return null;
  }

  private resolveModel(modelPolicy: SttModelPolicy | undefined): string {
    return modelPolicy?.model_label?.trim() || this.model;
  }

  private resolveApiKey(): string | undefined {
    const key = (this.apiKeyOption ?? this.env.DEEPGRAM_API_KEY)?.trim();
    return key ? key : undefined;
  }

  private resolveBaseUrl(): string {
    const configured =
      this.baseUrlOption?.trim() || this.env.DEEPGRAM_BASE_URL?.trim() || DEFAULT_DEEPGRAM_BASE_URL;
    // Strip trailing '/' with a linear backward scan (the previous `/\/+$/` is a polynomial-backtracking
    // regex on a long slash run). Byte-identical result for every input.
    let end = configured.length;
    while (end > 0 && configured.charCodeAt(end - 1) === 47 /* '/' */) end--;
    return configured.slice(0, end);
  }

  private buildListenUrl(
    modelPolicy: SttModelPolicy | undefined,
    languagePolicy: SttLanguagePolicy | undefined,
  ): string {
    const params = new URLSearchParams({
      model: this.resolveModel(modelPolicy),
      smart_format: 'true',
      punctuate: 'true',
    });
    const hint = languagePolicy?.language_hint?.trim();
    if (hint) {
      // When a language_hint is set, pin Deepgram to that language with `language=<hint>` — it is
      // mutually exclusive with auto-detection, so this path never also sends `detect_language=true`
      // (the default `else` path below sends `detect_language=true` when no hint is given).
      params.set('language', hint);
    } else if (languagePolicy?.detect_language !== false) {
      // Default: detect the dominant language when no explicit hint is given.
      params.set('detect_language', 'true');
    }
    return `${this.resolveBaseUrl()}/v1/listen?${params.toString()}`;
  }
}

/** Map a non-2xx status to a neutral adapter error — status + provider name ONLY (never the body). */
function httpError(status: number): SttAdapterError {
  const retryable = status === 429 || status >= 500;
  return {
    code: 'provider_unavailable',
    message: `deepgram transcription failed: HTTP ${status}`,
    retryable,
  };
}

/** The error's class name only — never its message (which could echo request content or the key). */
function errorName(err: unknown): string {
  return err instanceof Error && typeof err.name === 'string' ? err.name : 'Error';
}
