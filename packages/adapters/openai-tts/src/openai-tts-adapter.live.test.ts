import { describe, expect, it } from 'vitest';
import { OpenAiTtsAdapter } from './openai-tts-adapter.js';

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
});
