import { describe, expect, it } from 'vitest';
import { OpenAiTtsAdapter } from './openai-tts-adapter.js';
import { OPENAI_TTS_MODELS, OPENAI_TTS_POLICY } from './openai-tts-boundary.js';

/**
 * LIVE OpenAI text-to-speech integration smoke test — SELF-SKIPPING when `OPENAI_API_KEY` is absent.
 *
 * This is the one place the real network path runs. It calls the REAL `/v1/audio/speech` endpoint
 * through the adapter (global fetch, key from `process.env`, loaded via `vitest.setup.ts` from the
 * repo-root `.env` exactly as the STT adapter's live smoke does). CI has no key, so it self-skips and
 * the deterministic adapter suite is the CI gate (a live test with no cred MUST self-skip, never
 * silently pass blind).
 *
 * The text is a few words of synthetic copy — no customer content, no PII. The assertion is that a
 * REAL response comes back as non-empty audio with the container we asked for, and that the key never
 * appears in the artifact.
 *
 * The second arm is the one that makes the closed voice list FALSIFIABLE. A deterministic test can
 * only observe which voice the adapter put on the wire, never whether the provider accepts it — so a
 * voice list that drifts past what the wired models take would pass every offline test and fail in
 * production. This arm walks the policy list against BOTH wired models for real and goes red on the
 * first refusal, which is the only place that class of error can be caught.
 */

const apiKey = process.env.OPENAI_API_KEY?.trim();
const hasKey = Boolean(apiKey);
const liveIt = hasKey ? it : it.skip;

// Un-skippable guard: when a caller demands the live suite actually run (CI's opt-in live lane sets
// RAYSPEC_REQUIRE_LIVE_TESTS=true), an absent OPENAI_API_KEY must FAIL LOUDLY rather than let the only
// real-network TTS test self-skip into a false green. Self-skip stays intact when the flag is unset.
if (process.env.RAYSPEC_REQUIRE_LIVE_TESTS === 'true' && !hasKey) {
  throw new Error(
    'packages/adapters/openai-tts/src/openai-tts-adapter.live.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set but OPENAI_API_KEY is absent — refusing to silently skip the live OpenAI TTS test.',
  );
}

describe('OpenAiTtsAdapter live integration', () => {
  if (!hasKey) {
    console.warn(
      'OPENAI_API_KEY absent — skipping the live OpenAI TTS integration test (deterministic suite still runs).',
    );
  }

  liveIt(
    'synthesizes real audio through the live endpoint',
    async () => {
      const adapter = new OpenAiTtsAdapter();
      const result = await adapter.synthesize({
        text: 'Guten Morgen. Dies ist ein kurzer Test.',
        voice: 'alloy',
        format: 'mp3',
      });

      expect(result.bytes.length).toBeGreaterThan(0);
      expect(result.contentType).toBe('audio/mpeg');
      // The endpoint reports no duration — the adapter states that honestly rather than guessing.
      expect(result.durationSeconds).toBeNull();

      // The credential never rides along in the artifact.
      const key = apiKey ?? '';
      expect(JSON.stringify({ ...result, bytes: result.bytes.length })).not.toContain(key);
    },
    60_000,
  );

  liveIt(
    'PARITY: every voice on the adapter policy is accepted by every wired model',
    async () => {
      // One single-character synthesis per (model, voice) — the cheapest request that still proves
      // acceptance. A voice the provider rejects surfaces as an `unsupported_option`/HTTP-400 throw,
      // so the failure names the exact pair that drifted.
      const refused: string[] = [];
      for (const model of OPENAI_TTS_MODELS) {
        const adapter = new OpenAiTtsAdapter({ model });
        for (const voice of OPENAI_TTS_POLICY.voices) {
          try {
            const result = await adapter.synthesize({ text: 'a', voice, format: 'mp3' });
            expect(result.bytes.length).toBeGreaterThan(0);
          } catch (err) {
            // Class + code only — a provider body can quote the submitted text, so it is never read.
            const code = (err as { code?: string }).code ?? 'unknown';
            refused.push(`${model}/${voice} (${code})`);
          }
        }
      }
      // The policy list claims model-scoped truth; this is the assertion that holds it to it.
      expect(refused).toEqual([]);
    },
    180_000,
  );
});
