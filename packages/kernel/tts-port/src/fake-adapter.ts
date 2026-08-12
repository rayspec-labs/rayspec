/**
 * The DETERMINISTIC offline synthesizer — the CI/dev stand-in behind the neutral `TtsAdapter`
 * contract. It contacts nothing and speaks nothing: every accepted call returns THE SAME fixed-length
 * PCM tone, generated in pure TypeScript (a 44-byte RIFF header plus int16 samples, no encoder and no
 * external binary), so a suite can exercise the whole path — request in, audio bytes out — network-free
 * and byte-reproducible.
 *
 * FIXED LENGTH, NOT DERIVED FROM THE TEXT. A length that scaled with the text would invite a suite to
 * assert on it as if it meant something; it would not (nothing here speaks). The bytes are the same for
 * every accepted request, `durationSeconds` states exactly the tone's real length, and identical input
 * yields BYTE-identical output.
 *
 * IT REFUSES WHAT THE REAL ADAPTER REFUSES. The `policy` option is REQUIRED, and every call runs
 * through the SAME `normalizeTtsRequest` a live adapter uses. Hand it the policy of the adapter it
 * stands in for and the text cap, the voice membership and the speed clamp are identical on both paths
 * — without that, the one request shape a provider rejects would pass in CI and first fail in
 * production, which is precisely the failure an offline stand-in exists to prevent.
 *
 * IT ALWAYS EMITS WAV. The tone generator writes PCM; the fake does not encode. A caller that asks for
 * `mp3`/`opus` still has its format VALIDATED (membership), but gets WAV bytes with the honest
 * `audio/wav` content type — a lied-about content type would be a worse fake than an obvious one.
 */
import {
  contentTypeForTtsFormat,
  normalizeTtsRequest,
  type TtsRequestPolicy,
} from './request-policy.js';
import type { TtsAdapter, TtsSynthesisResult, TtsSynthesizeRequest } from './types.js';

export const FAKE_TTS_ADAPTER_ID = 'fake-tts-ci';

export interface FakeTtsAdapterOptions {
  /**
   * The limits this fake enforces — REQUIRED, and normally the policy of the adapter it stands in for.
   * There is no default on purpose: a fake that silently accepted more than the wired provider would
   * turn a green CI run into a production refusal.
   */
  policy: TtsRequestPolicy;
  /** The tone's fixed length in seconds (default 1) — also what `durationSeconds` reports. */
  seconds?: number;
  /** PCM sample rate (default 16000) and tone frequency in Hz (default 440). */
  sampleRate?: number;
  freq?: number;
}

export class FakeTtsAdapter implements TtsAdapter {
  readonly id = FAKE_TTS_ADAPTER_ID;

  readonly #policy: TtsRequestPolicy;
  readonly #seconds: number;
  readonly #sampleRate: number;
  readonly #freq: number;

  constructor(options: FakeTtsAdapterOptions) {
    this.#policy = options.policy;
    this.#seconds = options.seconds ?? 1;
    this.#sampleRate = options.sampleRate ?? 16000;
    this.#freq = options.freq ?? 440;
  }

  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesisResult> {
    // Refuse exactly what the wired provider refuses, BEFORE producing anything.
    normalizeTtsRequest(request, this.#policy);
    return {
      bytes: makeToneWav({
        seconds: this.#seconds,
        sampleRate: this.#sampleRate,
        freq: this.#freq,
      }),
      // Honest: these bytes ARE WAV, whatever container the caller asked for.
      contentType: contentTypeForTtsFormat('wav'),
      durationSeconds: this.#seconds,
    };
  }
}

/**
 * A minimal 16-bit PCM mono WAV holding a sine tone — a 44-byte RIFF header followed by
 * `seconds * sampleRate` int16 samples, so the total length is exactly `44 + seconds * sampleRate * 2`.
 * Pure arithmetic: the same arguments always produce the same bytes.
 */
export function makeToneWav(
  options: { seconds?: number; sampleRate?: number; freq?: number } = {},
): Uint8Array {
  const seconds = options.seconds ?? 1;
  const sampleRate = options.sampleRate ?? 16000;
  const freq = options.freq ?? 440;
  const bytesPerSample = 2;
  const numSamples = Math.floor(seconds * sampleRate);
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i += 1) {
    const sample = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    view.setInt16(44 + i * bytesPerSample, Math.round(sample * 0x7fff), true);
  }
  return new Uint8Array(buffer);
}
