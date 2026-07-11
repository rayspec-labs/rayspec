import { StaticSttMediaResolver } from '@rayspec/stt-port';
import { describe, expect, it } from 'vitest';
import { DeepgramSttAdapter } from './deepgram-adapter.js';

/**
 * LIVE Deepgram integration smoke test — SELF-SKIPPING when `DEEPGRAM_API_KEY` is absent.
 *
 * This is the one place the real network path runs. It calls the REAL Deepgram `/v1/listen` endpoint
 * through the adapter (global fetch, key from `process.env`, loaded via `vitest.setup.ts` from the
 * repo-root `.env` exactly as the parity live-smoke does). CI has no key, so it self-skips and the
 * deterministic mapper/adapter suites are the CI gate (a live test with no cred MUST self-skip,
 * never silently pass blind).
 *
 * The audio is a tiny synthetic 1s tone generated in-memory — no committed binary, no real customer
 * audio, no PII (the golden-fixture rule). A tone yields little/no speech; the assertion is that a
 * REAL Deepgram response maps into a valid completed neutral transcript with provenance (provider id,
 * opaque run id, billed duration), and that the key never appears in the artifact.
 */

const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
const hasKey = Boolean(apiKey);
const liveIt = hasKey ? it : it.skip;

// Un-skippable guard: when a caller demands the live suite actually run (CI's opt-in live lane sets
// RAYSPEC_REQUIRE_LIVE_TESTS=true), an absent DEEPGRAM_API_KEY must FAIL LOUDLY rather than let the
// only real-network STT test self-skip into a false green. Self-skip stays intact when the flag is unset.
if (process.env.RAYSPEC_REQUIRE_LIVE_TESTS === 'true' && !hasKey) {
  throw new Error(
    'packages/adapters/deepgram/src/deepgram-adapter.live.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set but DEEPGRAM_API_KEY is absent — refusing to silently skip the live Deepgram STT test.',
  );
}

/** Minimal 16-bit PCM mono WAV containing a sine tone — Deepgram accepts raw WAV bytes. */
function makeToneWav(
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

describe('DeepgramSttAdapter live integration', () => {
  if (!hasKey) {
    console.warn(
      '[stt-runtime] LIVE Deepgram integration test SKIPPED: DEEPGRAM_API_KEY absent (deterministic path).',
    );
  }

  liveIt(
    'transcribes a tiny synthetic WAV through the real Deepgram API into a neutral transcript',
    async () => {
      const resolver = new StaticSttMediaResolver().set('live-smoke', 'mic', {
        bytes: makeToneWav({ seconds: 1 }),
        contentType: 'audio/wav',
      });
      const adapter = new DeepgramSttAdapter({ resolver });

      const result = await adapter.transcribeTrack({
        session_id: 'live-smoke',
        track: 'mic',
        media_artifact_ref: 'live:smoke/mic',
      });

      if (result.status === 'failed') {
        throw new Error(
          `live Deepgram call failed: ${result.error.code} (${result.error.message})`,
        );
      }
      expect(result.status).toBe('completed');
      if (result.status !== 'completed') throw new Error('expected completed');
      expect(result.transcript.provider).toBe('deepgram');
      expect(typeof result.transcript.provider_run_id).toBe('string');
      expect((result.transcript.provider_run_id ?? '').length).toBeGreaterThan(0);
      expect(result.transcript.duration_seconds ?? 0).toBeGreaterThan(0);
      // Secret hygiene on the real artifact.
      expect(JSON.stringify(result.transcript)).not.toContain(apiKey);
    },
    60_000,
  );
});
