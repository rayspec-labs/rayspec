/**
 * The BACKEND-profile speech-to-text capability — what a route/tool handler receives as `init.stt`.
 *
 * The neutral `SttAdapter` port is REFERENCE-keyed: `transcribeTrack` takes a finalized session/track
 * ref and the adapter asks its injected `SttMediaResolver` for the bytes (the product profile resolves
 * those out of the blob store, where its audio pipeline finalized them). A backend-profile handler has
 * no finalized session — it has BYTES it already read (a raw-body upload, a blob, an fs source). This
 * module bridges the two WITHOUT touching the port: the adapter is built ONCE here, wired to a
 * CALL-SCOPED resolver, and each `transcribe(bytes, opts)` registers its bytes under a ref derived
 * from those bytes, drives the adapter, then releases the registration. A handler therefore never
 * selects a provider, reads a credential, or constructs an adapter.
 *
 * PROVIDER SELECTION mirrors the product profile's `STT_PROVIDER` contract (`deepgram | fake`), with
 * two deliberate differences, both in the stricter/more-useful direction:
 *   - the credential is demanded EAGERLY at boot (`STT_PROVIDER=deepgram` with no `DEEPGRAM_API_KEY`
 *     refuses the boot). The adapter itself still resolves the key lazily — but on this profile the
 *     alternative is a deployment that boots green and answers every transcription with a content-free
 *     `provider_unavailable` at request time. Fail-closed at boot is the honest posture, and it is the
 *     same family as the other boot-config refusals.
 *   - `STT_PROVIDER=fake` is a WORKING deterministic transcriber, not a boot posture: it synthesizes a
 *     per-call fixture for the deterministic `FakeSttAdapter`, so a handler exercises the whole path
 *     (bytes in → neutral transcript out) offline, with identical input yielding identical output.
 *     The boot WARNS loudly that no audio is being transcribed (warn-only — a dev/CI boot needs it).
 *
 * NO NETWORK, NO CREDENTIAL READ HERE: constructing the Deepgram adapter neither calls out nor reads
 * the environment (the key is passed in from the validated boot config, and the credential never
 * appears in an error message, a transcript, or a log line).
 */
import { createHash } from 'node:crypto';
import { DeepgramSttAdapter } from '@rayspec/adapter-deepgram';
import type { SttCapability, SttTranscribeOptions } from '@rayspec/platform';
import {
  FakeSttAdapter,
  type SttAdapter,
  type SttAdapterError,
  type SttFinalizedTrackRef,
  type SttLanguagePolicy,
  SttMediaResolutionError,
  type SttMediaResolver,
  type SttMediaSource,
  type SttShortFixture,
  type SttTranscribeTrackRequest,
  type SttTranscriptionResult,
} from '@rayspec/stt-port';
import { BootConfigError } from './boot-config-error.js';

/**
 * The synthetic track every capability call transcribes under. The port keys media by
 * `session_id`/`track`; a handler supplies neither, so the engine derives BOTH from the call (below)
 * — the track is a fixed, product-neutral name (it is not `mic`/`system`: there is no session here).
 */
const CAPABILITY_TRACK = 'audio';

/**
 * The loud NON-REAL-PROVIDER boot warning for `STT_PROVIDER=fake` on this profile. Warn-only (a dev/CI
 * boot legitimately selects it) — never fail-closed, so an offline test boot stays a boot.
 */
export const FAKE_STT_BOOT_WARNING =
  '\n⚠️  STT_PROVIDER=fake — THE `init.stt` CAPABILITY DOES NOT TRANSCRIBE ⚠️\n' +
  '    Every call answers with a DETERMINISTIC SYNTHETIC transcript derived from the bytes it was\n' +
  '    given — no audio is read and no provider is contacted.\n' +
  '    This is a DEV/CI posture — NOT a production configuration. If this is prod, fix the env.\n';

/** The media key the port resolves by (`${session_id}/${track}`). */
function mediaKey(ref: Pick<SttFinalizedTrackRef, 'session_id' | 'track'>): string {
  return `${ref.session_id}/${ref.track}`;
}

/**
 * The CONTENT-DERIVED call ref. Deriving the session id from the bytes + the options (rather than a
 * random per-call id) is what makes the whole artifact DETERMINISTIC: the neutral transcript's ids are
 * `stableId`-derived from `session_id`/`track`, so identical input yields an identical transcript —
 * the property the fake path is asserted on. A REAL provider inherits the stableId-derived IDS only,
 * not an identical artifact: its transcript stamps `created_at`/`updated_at` from the wall clock, so
 * two identical calls differ in those fields.
 */
function callRef(digest: string): SttFinalizedTrackRef {
  return { session_id: `handler-stt.${digest}`, track: CAPABILITY_TRACK };
}

function callDigest(bytes: Uint8Array, opts: SttTranscribeOptions | undefined): string {
  return createHash('sha256')
    .update(bytes)
    .update(
      `\0${opts?.contentType ?? ''}\0${opts?.languageHint ?? ''}\0${
        opts?.detectLanguage === undefined ? '' : String(opts.detectLanguage)
      }`,
    )
    .digest('hex')
    .slice(0, 32);
}

/**
 * The one option refusal the capability layer states in its own right: `languageHint` PINS a language
 * and `detectLanguage: true` asks the provider to discover one, so the pair is contradictory. A real
 * provider adapter refuses it at the port boundary (the Deepgram adapter answers `unsupported_option`
 * without a wire call); the offline transcriber exists to STAND IN for such an adapter, so it refuses
 * the same pair with the same structured error. Without that, the one option combination the SDK
 * documents as illegal would pass in dev/CI and first fail in production.
 */
function mutuallyExclusiveLanguageError(
  opts: SttTranscribeOptions | undefined,
): SttAdapterError | null {
  if (opts?.languageHint && opts.detectLanguage === true) {
    return {
      code: 'unsupported_option',
      message: 'language_hint and detect_language are mutually exclusive.',
      retryable: false,
    };
  }
  return null;
}

/** The neutral language policy for a call (absent when the caller expressed no language preference). */
function languagePolicy(opts: SttTranscribeOptions | undefined): SttLanguagePolicy | undefined {
  const policy: SttLanguagePolicy = {
    ...(opts?.languageHint ? { language_hint: opts.languageHint } : {}),
    ...(opts?.detectLanguage !== undefined ? { detect_language: opts.detectLanguage } : {}),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/** The neutral per-call adapter request (the ref + the language policy the caller expressed). */
function trackRequest(
  ref: SttFinalizedTrackRef,
  opts: SttTranscribeOptions | undefined,
): SttTranscribeTrackRequest {
  const policy = languagePolicy(opts);
  return { ...ref, ...(policy ? { language_policy: policy } : {}) };
}

/**
 * The CALL-SCOPED media resolver — the whole bytes→ref bridge. Bytes are registered under the call's
 * derived ref for exactly the duration of the adapter call and released afterwards, so the resolver
 * holds no audio between calls. Concurrent calls each register their OWN entry (two calls with the
 * same content register two equal entries and each releases its own), so a completing call can never
 * pull the bytes out from under an in-flight one. An unregistered ref is refused with the resolver's
 * declared error — the adapter maps it to the honest neutral `not_ready`, never a network fallback.
 */
class CallScopedSttMediaResolver implements SttMediaResolver {
  readonly #open: Array<{ key: string; source: SttMediaSource }> = [];

  open(ref: SttFinalizedTrackRef, source: SttMediaSource): { key: string; source: SttMediaSource } {
    const entry = { key: mediaKey(ref), source };
    this.#open.push(entry);
    return entry;
  }

  close(entry: { key: string; source: SttMediaSource }): void {
    const index = this.#open.indexOf(entry);
    if (index >= 0) this.#open.splice(index, 1);
  }

  async resolve(ref: SttFinalizedTrackRef): Promise<SttMediaSource> {
    const key = mediaKey(ref);
    const entry = this.#open.find((candidate) => candidate.key === key);
    if (!entry) {
      throw new SttMediaResolutionError(
        `STT capability resolve: no in-flight call registered bytes for ${key} (fail-closed).`,
      );
    }
    return entry.source;
  }
}

/**
 * The capability over a REAL provider adapter. The adapter is constructed ONCE (here) against the
 * call-scoped resolver; every call registers its bytes, drives `transcribeTrack`, and releases.
 *
 * EXPORTED for its own tests: `buildSttCapability` hard-wires the Deepgram adapter, so the bytes→ref
 * bridge is only directly observable when the `buildAdapter` seam is handed a stand-in adapter that
 * inspects the resolver it was given (registration contents, release, concurrent isolation, and the
 * refusal of an unregistered ref). It is not part of any deployment surface — nothing outside this
 * module and its suite constructs it.
 */
export class AdapterSttCapability implements SttCapability {
  readonly #resolver = new CallScopedSttMediaResolver();
  readonly #adapter: SttAdapter;

  constructor(buildAdapter: (resolver: SttMediaResolver) => SttAdapter) {
    this.#adapter = buildAdapter(this.#resolver);
  }

  async transcribe(
    bytes: Uint8Array,
    opts?: SttTranscribeOptions,
  ): Promise<SttTranscriptionResult> {
    const ref = callRef(callDigest(bytes, opts));
    const entry = this.#resolver.open(ref, {
      bytes,
      ...(opts?.contentType ? { contentType: opts.contentType } : {}),
    });
    try {
      return await this.#adapter.transcribeTrack(trackRequest(ref, opts));
    } finally {
      this.#resolver.close(entry);
    }
  }
}

/**
 * The DETERMINISTIC offline capability (`STT_PROVIDER=fake`). The `FakeSttAdapter` transcribes from
 * FIXTURES, and a backend-profile handler ships none — so the capability SYNTHESIZES the call's
 * fixture from the bytes it was handed (a placeholder text that names the byte count + the content
 * digest, so the output is obviously synthetic and provably content-derived) and registers it for the
 * duration of the call, exactly as the real path registers its bytes. Everything else — the normalized
 * artifact, the `stableId` ids, the fixed clock — is the fake adapter's own house behaviour.
 */
class FakeSttCapability implements SttCapability {
  readonly #fixtures: SttShortFixture[] = [];
  readonly #adapter = new FakeSttAdapter({ fixtures: this.#fixtures });

  async transcribe(
    bytes: Uint8Array,
    opts?: SttTranscribeOptions,
  ): Promise<SttTranscriptionResult> {
    // Refuse the contradictory language pair exactly as a real adapter does, BEFORE synthesizing a
    // fixture — the offline transcriber must not accept what the wired provider rejects.
    const optionError = mutuallyExclusiveLanguageError(opts);
    if (optionError) return { status: 'failed', error: optionError };
    const digest = callDigest(bytes, opts);
    const ref = callRef(digest);
    const fixture: SttShortFixture = {
      fixture_id: ref.session_id,
      transcript: {
        session_id: ref.session_id,
        track: ref.track,
        status: 'completed',
        full_text: `fake transcript of ${bytes.length} audio bytes (sha256 ${digest.slice(0, 12)})`,
        confidence: 0.99,
        // The hint is ECHOED when the caller pinned one; the fake never INVENTS a detection (a
        // `detectLanguage` call therefore reports a null language — honest, not a fabricated guess).
        ...(opts?.languageHint ? { detected_language: opts.languageHint } : {}),
      },
    };
    this.#fixtures.push(fixture);
    try {
      return await this.#adapter.transcribeTrack(trackRequest(ref, opts));
    } finally {
      const index = this.#fixtures.indexOf(fixture);
      if (index >= 0) this.#fixtures.splice(index, 1);
    }
  }
}

/** The STT inputs `loadServerConfig` resolved from the environment (a subset of `ServerConfig`). */
export interface SttCapabilityConfig {
  /** STT_PROVIDER — the provider selection (`deepgram | fake`). Absent ⇒ no capability is built. */
  readonly sttProvider?: string;
  /** DEEPGRAM_API_KEY — REQUIRED (eagerly) when the provider is `deepgram`. */
  readonly deepgramApiKey?: string;
}

/**
 * Build the deployment's `init.stt` capability from the validated boot config, or `undefined` when no
 * provider is configured (the capability is then ABSENT on every init — a handler that needs it
 * fail-closes loudly). Throws `BootConfigError` on a configured-but-unusable selection: an unsupported
 * provider name, or `deepgram` without its credential.
 */
export function buildSttCapability(config: SttCapabilityConfig): SttCapability | undefined {
  const provider = config.sttProvider?.trim();
  if (!provider) return undefined;
  if (provider === 'fake') return new FakeSttCapability();
  if (provider === 'deepgram') {
    const apiKey = config.deepgramApiKey;
    if (!apiKey) {
      throw new BootConfigError(
        'Boot aborted — DEEPGRAM_API_KEY is required (the Deepgram API key (STT_PROVIDER=deepgram)). ' +
          'Fail-closed. Set the key, select STT_PROVIDER=fake for an offline dev/CI boot, or unset ' +
          'STT_PROVIDER to boot without the transcription capability.',
      );
    }
    return new AdapterSttCapability((resolver) => new DeepgramSttAdapter({ apiKey, resolver }));
  }
  throw new BootConfigError(
    `Boot aborted — STT_PROVIDER '${provider}' is not supported (wired: deepgram | fake). Fail-closed.`,
  );
}
