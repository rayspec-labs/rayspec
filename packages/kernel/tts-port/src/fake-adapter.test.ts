/**
 * The deterministic offline synthesizer: BYTE-identical output for identical input, a fixed length
 * that is NOT derived from the text, an honest WAV envelope — and the SAME refusals the adapter it
 * stands in for makes (the property that keeps an offline green from becoming a production failure).
 */
import { describe, expect, it } from 'vitest';
import { FAKE_TTS_ADAPTER_ID, FakeTtsAdapter } from './fake-adapter.js';
import type { TtsRequestPolicy } from './request-policy.js';
import { TtsAdapterError } from './types.js';

/** A synthetic policy — the port names no provider, so neither do its tests. */
const POLICY: TtsRequestPolicy = {
  maxTextLength: 4096,
  voices: ['alpha', 'beta'],
  defaultVoice: 'alpha',
  minSpeed: 0.25,
  maxSpeed: 4,
  defaultFormat: 'mp3',
};

const fake = (overrides: Partial<{ seconds: number }> = {}) =>
  new FakeTtsAdapter({ policy: POLICY, ...overrides });

describe('FakeTtsAdapter — determinism', () => {
  it('answers identical input with BYTE-identical audio, content type and duration', async () => {
    const adapter = fake();
    const first = await adapter.synthesize({ text: 'Guten Morgen.' });
    const second = await adapter.synthesize({ text: 'Guten Morgen.' });

    expect([...second.bytes]).toEqual([...first.bytes]);
    expect(second.contentType).toBe(first.contentType);
    expect(second.durationSeconds).toBe(first.durationSeconds);
  });

  it('is deterministic ACROSS instances (no per-instance seed or clock)', async () => {
    const a = await fake().synthesize({ text: 'hallo' });
    const b = await fake().synthesize({ text: 'hallo' });
    expect([...b.bytes]).toEqual([...a.bytes]);
  });

  it('produces a FIXED length that is NOT derived from the text', async () => {
    const adapter = fake();
    const short = await adapter.synthesize({ text: 'hi' });
    const long = await adapter.synthesize({ text: 'x'.repeat(2000) });
    // Nothing here speaks, so a text-derived length would be a number with no meaning.
    expect(long.bytes.length).toBe(short.bytes.length);
    expect([...long.bytes]).toEqual([...short.bytes]);
  });

  it('reports the tone real length: 44-byte header + seconds * rate * 2, and a matching duration', async () => {
    const result = await new FakeTtsAdapter({ policy: POLICY, seconds: 2 }).synthesize({
      text: 'hallo',
    });
    expect(result.bytes.length).toBe(44 + 2 * 16000 * 2);
    expect(result.durationSeconds).toBe(2);
  });

  it('emits a real RIFF/WAVE envelope with the honest content type', async () => {
    const result = await fake().synthesize({ text: 'hallo' });
    expect(new TextDecoder().decode(result.bytes.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(result.bytes.slice(8, 12))).toBe('WAVE');
    expect(result.contentType).toBe('audio/wav');
  });

  it('exposes a stable adapter id', () => {
    expect(fake().id).toBe(FAKE_TTS_ADAPTER_ID);
  });
});

describe('FakeTtsAdapter — it refuses what the wired adapter refuses', () => {
  it('REFUSES a text over the policy cap (fail-closed, never truncated)', async () => {
    await expect(
      fake().synthesize({ text: 'x'.repeat(POLICY.maxTextLength + 1) }),
    ).rejects.toBeInstanceOf(TtsAdapterError);
    await expect(
      fake().synthesize({ text: 'x'.repeat(POLICY.maxTextLength + 1) }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('ACCEPT CONTROL: a text exactly at the cap still synthesizes', async () => {
    const result = await fake().synthesize({ text: 'x'.repeat(POLICY.maxTextLength) });
    expect(result.bytes.length).toBeGreaterThan(44);
  });

  it('REFUSES an unknown voice (unsupported_option)', async () => {
    await expect(
      fake().synthesize({ text: 'hallo', voice: 'nonexistent-voice' }),
    ).rejects.toMatchObject({ code: 'unsupported_option' });
  });

  it('ACCEPT CONTROL: a listed voice synthesizes', async () => {
    const result = await fake().synthesize({ text: 'hallo', voice: 'beta' });
    expect(result.contentType).toBe('audio/wav');
  });

  it('clamps speed instead of refusing it (both ends), and still returns the same audio', async () => {
    const adapter = fake();
    const base = await adapter.synthesize({ text: 'hallo' });
    for (const speed of [0.01, 9]) {
      const result = await adapter.synthesize({ text: 'hallo', speed });
      // The clamp is a normalization, not a refusal — and the fake plays no rate, so the tone is equal.
      expect([...result.bytes]).toEqual([...base.bytes]);
    }
  });

  it('VALIDATES a requested container but always emits WAV — it does not encode, and does not lie', async () => {
    for (const format of ['mp3', 'opus', 'wav'] as const) {
      const result = await fake().synthesize({ text: 'hallo', format });
      expect(result.contentType).toBe('audio/wav');
      expect(new TextDecoder().decode(result.bytes.slice(0, 4))).toBe('RIFF');
    }
    await expect(
      fake().synthesize({ text: 'hallo', format: 'flac' as never }),
    ).rejects.toMatchObject({ code: 'unsupported_option' });
  });
});
