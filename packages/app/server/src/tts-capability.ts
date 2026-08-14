/**
 * The BACKEND-profile text-to-speech capability — what a route/tool handler receives as `init.tts`.
 *
 * This is the EGRESS twin of `stt-capability.ts`, and deliberately much thinner. The STT port is
 * REFERENCE-keyed (a finalized session/track ref resolved to bytes by an injected resolver), so that
 * module has to bridge a handler's bytes onto a ref. The TTS port is already direct — text in, audio
 * bytes out — so there is nothing to bridge: the capability builds the adapter ONCE here and forwards
 * each call. A handler therefore never selects a provider, reads a credential, or constructs an adapter.
 *
 * PROVIDER SELECTION mirrors the `STT_PROVIDER` contract (`openai | fake`), with the same two
 * deliberate strictnesses:
 *   - the credential is demanded EAGERLY at boot (`TTS_PROVIDER=openai` with no `OPENAI_API_KEY`
 *     refuses the boot). The adapter itself still resolves the key lazily — but on this profile the
 *     alternative is a deployment that boots green and fails every synthesis with a content-free
 *     `provider_unavailable` at request time. Fail-closed at boot is the honest posture, and it is the
 *     same family as the other boot-config refusals.
 *   - `TTS_PROVIDER=fake` is a WORKING deterministic synthesizer, not a boot posture: it answers with
 *     a real fixed-length WAV tone, so a handler exercises the whole path (text in → audio out)
 *     offline, with identical input yielding BYTE-identical output. The boot WARNS loudly that nothing
 *     is being spoken (warn-only — a dev/CI boot needs it).
 *
 * THE OFFLINE PATH REFUSES WHAT THE LIVE PATH REFUSES. The fake is constructed with the OpenAI
 * adapter's OWN request policy, so the text cap, the closed voice list and the speed clamp are
 * IDENTICAL on both paths. Without that, the one request shape the provider rejects would pass in
 * dev/CI and first fail in production — the same principle the STT capability applies to its
 * mutually-exclusive language options.
 *
 * NO NETWORK, NO CREDENTIAL READ HERE: constructing the adapter neither calls out nor reads the
 * environment (the key is passed in from the validated boot config, and the credential never appears
 * in an error message, a result, or a log line).
 */
import { OPENAI_TTS_POLICY, OpenAiTtsAdapter } from '@rayspec/adapter-openai-tts';
import type { TtsCapability, TtsSynthesizeOptions } from '@rayspec/platform';
import {
  FakeTtsAdapter,
  type TtsAdapter,
  type TtsSynthesisResult,
  type TtsSynthesizeRequest,
} from '@rayspec/tts-port';
import { BootConfigError } from './boot-config-error.js';
// The credential this capability demands, from the one module that states the boot's environment
// demands — the record the read-only environment report enumerates for a selected TTS provider. It is
// the SAME variable two extraction backends also want, under a DIFFERENT reason, which is why the
// catalogue keeps them as separate records. See boot-env-demands.ts.
import { OPENAI_API_KEY_FOR_TTS } from './boot-env-demands.js';

/**
 * The loud NON-REAL-PROVIDER boot warning for `TTS_PROVIDER=fake` on this profile. Warn-only (a dev/CI
 * boot legitimately selects it) — never fail-closed, so an offline test boot stays a boot.
 */
export const FAKE_TTS_BOOT_WARNING =
  '\n⚠️  TTS_PROVIDER=fake — THE `init.tts` CAPABILITY DOES NOT SYNTHESIZE SPEECH ⚠️\n' +
  '    Every call answers with the SAME deterministic synthetic tone — no text is spoken and no\n' +
  '    provider is contacted.\n' +
  '    This is a DEV/CI posture — NOT a production configuration. If this is prod, fix the env.\n';

/**
 * The neutral per-call adapter request (the text plus whatever options the caller expressed).
 *
 * EXPRESSED, not truthy: an option the caller named is forwarded even when its value is falsy, and
 * only an option the caller left out is omitted. Dropping a blank `voice` here would hand the adapter
 * an ABSENT voice, which it resolves to its default — the silent fallback the closed voice list
 * exists to prevent (`speed: 0` has the same shape, and is clamped rather than dropped).
 */
function synthesizeRequest(
  text: string,
  opts: TtsSynthesizeOptions | undefined,
): TtsSynthesizeRequest {
  return {
    text,
    ...(opts?.voice !== undefined ? { voice: opts.voice } : {}),
    ...(opts?.speed !== undefined ? { speed: opts.speed } : {}),
    ...(opts?.format ? { format: opts.format } : {}),
  };
}

/**
 * The capability over ANY adapter behind the neutral port — the one forwarding seam both the live and
 * the offline provider run through, so the two cannot drift in how a call is shaped.
 *
 * EXPORTED for its own tests: `buildTtsCapability` hard-wires the concrete adapters, so the
 * options→request mapping is only directly observable when the `adapter` seam is handed a recording
 * stand-in. It is not part of any deployment surface — nothing outside this module and its suite
 * constructs it.
 */
export class AdapterTtsCapability implements TtsCapability {
  readonly #adapter: TtsAdapter;

  constructor(adapter: TtsAdapter) {
    this.#adapter = adapter;
  }

  async synthesize(text: string, opts?: TtsSynthesizeOptions): Promise<TtsSynthesisResult> {
    return this.#adapter.synthesize(synthesizeRequest(text, opts));
  }
}

/** The TTS inputs `loadServerConfig` resolved from the environment (a subset of `ServerConfig`). */
export interface TtsCapabilityConfig {
  /** TTS_PROVIDER — the provider selection (`openai | fake`). Absent ⇒ no capability is built. */
  readonly ttsProvider?: string;
  /** OPENAI_API_KEY — REQUIRED (eagerly) when the provider is `openai`. */
  readonly openaiApiKey?: string;
}

/**
 * Build the deployment's `init.tts` capability from the validated boot config, or `undefined` when no
 * provider is configured (the capability is then ABSENT on every init — a handler that needs it
 * fail-closes loudly). Throws `BootConfigError` on a configured-but-unusable selection: an unsupported
 * provider name, or `openai` without its credential.
 */
export function buildTtsCapability(config: TtsCapabilityConfig): TtsCapability | undefined {
  const provider = config.ttsProvider?.trim();
  if (!provider) return undefined;
  if (provider === 'fake') {
    // The offline synthesizer stands IN for the wired provider, so it is handed that provider's own
    // policy — identical cap, voice list and speed clamp on both paths.
    return new AdapterTtsCapability(new FakeTtsAdapter({ policy: OPENAI_TTS_POLICY }));
  }
  if (provider === 'openai') {
    const apiKey = config.openaiApiKey;
    if (!apiKey) {
      throw new BootConfigError(
        `Boot aborted — ${OPENAI_API_KEY_FOR_TTS.name} is required (${OPENAI_API_KEY_FOR_TTS.what}). ` +
          'Fail-closed. Set the key, select TTS_PROVIDER=fake for an offline dev/CI boot, or unset ' +
          'TTS_PROVIDER to boot without the speech-synthesis capability.',
      );
    }
    return new AdapterTtsCapability(new OpenAiTtsAdapter({ apiKey }));
  }
  throw new BootConfigError(
    `Boot aborted — TTS_PROVIDER '${provider}' is not supported (wired: openai | fake). Fail-closed.`,
  );
}
