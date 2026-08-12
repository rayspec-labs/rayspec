/**
 * The shared request-normalization rules — the ONE definition both the live adapter and the offline
 * fake apply, so a request that passes in CI cannot first fail in production.
 *
 * Pinned here: the text cap REFUSES (never truncates), voice membership is closed, an unknown format
 * is refused, the speed clamp is pinned at BOTH ends with an in-range control, and every message is
 * content-free (the text never appears in a refusal).
 */
import { describe, expect, it } from 'vitest';
import {
  contentTypeForTtsFormat,
  normalizeTtsRequest,
  type TtsRequestPolicy,
} from './request-policy.js';
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

describe('normalizeTtsRequest — defaults', () => {
  it('resolves the absent options from the policy', () => {
    expect(normalizeTtsRequest({ text: 'hallo' }, POLICY)).toEqual({
      text: 'hallo',
      voice: 'alpha',
      speed: 1,
      format: 'mp3',
    });
  });

  it('carries the caller-named voice, speed and format through verbatim', () => {
    expect(
      normalizeTtsRequest({ text: 'hallo', voice: 'beta', speed: 1.5, format: 'wav' }, POLICY),
    ).toEqual({ text: 'hallo', voice: 'beta', speed: 1.5, format: 'wav' });
  });
});

describe('normalizeTtsRequest — the text cap is FAIL-CLOSED, never a truncation', () => {
  it('ACCEPT CONTROL: a text exactly AT the cap is accepted whole', () => {
    const text = 'x'.repeat(POLICY.maxTextLength);
    const normalized = normalizeTtsRequest({ text }, POLICY);
    // The whole text survives — nothing is trimmed off the accepted edge case.
    expect(normalized.text).toHaveLength(POLICY.maxTextLength);
    expect(normalized.text).toBe(text);
  });

  it('REFUSES one character over the cap (invalid_request) — and does NOT truncate', () => {
    const text = 'x'.repeat(POLICY.maxTextLength + 1);
    let caught: unknown;
    try {
      normalizeTtsRequest({ text }, POLICY);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TtsAdapterError);
    expect((caught as TtsAdapterError).code).toBe('invalid_request');
    expect((caught as TtsAdapterError).retryable).toBe(false);
    // The message states the LENGTH against the CAP — numbers, never the text itself.
    expect((caught as TtsAdapterError).message).toContain(String(POLICY.maxTextLength + 1));
    expect((caught as TtsAdapterError).message).toContain(String(POLICY.maxTextLength));
  });

  it('refuses an empty or blank text', () => {
    for (const text of ['', '   ', '\n\t']) {
      expect(() => normalizeTtsRequest({ text }, POLICY)).toThrow(/empty/);
    }
  });

  it('never echoes the text into a refusal message (content-free)', () => {
    const secretish = 'CONFIDENTIAL-PATIENT-NAME';
    const text = `${secretish}${'x'.repeat(POLICY.maxTextLength)}`;
    try {
      normalizeTtsRequest({ text }, POLICY);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(TtsAdapterError);
      expect((err as TtsAdapterError).message).not.toContain(secretish);
    }
  });
});

describe('normalizeTtsRequest — closed voice membership', () => {
  it('ACCEPT CONTROL: every listed voice is accepted', () => {
    for (const voice of POLICY.voices) {
      expect(normalizeTtsRequest({ text: 'hallo', voice }, POLICY).voice).toBe(voice);
    }
  });

  it('REFUSES an unknown voice (unsupported_option) rather than falling back to the default', () => {
    let caught: unknown;
    try {
      normalizeTtsRequest({ text: 'hallo', voice: 'nonexistent-voice' }, POLICY);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TtsAdapterError);
    expect((caught as TtsAdapterError).code).toBe('unsupported_option');
    // It names the wired voices so a caller can fix the call.
    expect((caught as TtsAdapterError).message).toContain('alpha | beta');
  });
});

describe('normalizeTtsRequest — the speed clamp', () => {
  it('clamps BELOW the range to the minimum (pinned value)', () => {
    expect(normalizeTtsRequest({ text: 'hallo', speed: 0.01 }, POLICY).speed).toBe(0.25);
    expect(normalizeTtsRequest({ text: 'hallo', speed: -3 }, POLICY).speed).toBe(0.25);
  });

  it('clamps ABOVE the range to the maximum (pinned value)', () => {
    expect(normalizeTtsRequest({ text: 'hallo', speed: 9 }, POLICY).speed).toBe(4);
  });

  it('ACCEPT CONTROL: an in-range speed passes through unchanged, bounds included', () => {
    expect(normalizeTtsRequest({ text: 'hallo', speed: 0.25 }, POLICY).speed).toBe(0.25);
    expect(normalizeTtsRequest({ text: 'hallo', speed: 2.75 }, POLICY).speed).toBe(2.75);
    expect(normalizeTtsRequest({ text: 'hallo', speed: 4 }, POLICY).speed).toBe(4);
  });

  it('refuses a non-finite speed rather than clamping a NaN into the range', () => {
    for (const speed of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let caught: unknown;
      try {
        normalizeTtsRequest({ text: 'hallo', speed }, POLICY);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TtsAdapterError);
      expect((caught as TtsAdapterError).code).toBe('invalid_request');
    }
  });
});

describe('normalizeTtsRequest — format membership', () => {
  it('ACCEPT CONTROL: each container the port speaks is accepted', () => {
    for (const format of ['mp3', 'opus', 'wav'] as const) {
      expect(normalizeTtsRequest({ text: 'hallo', format }, POLICY).format).toBe(format);
    }
  });

  it('refuses a container the port does not speak', () => {
    let caught: unknown;
    try {
      // An untyped caller can reach this — the runtime guard is what refuses it.
      normalizeTtsRequest({ text: 'hallo', format: 'flac' as never }, POLICY);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TtsAdapterError);
    expect((caught as TtsAdapterError).code).toBe('unsupported_option');
  });
});

describe('contentTypeForTtsFormat', () => {
  it('describes each container honestly', () => {
    expect(contentTypeForTtsFormat('mp3')).toBe('audio/mpeg');
    // `opus` is Ogg-encapsulated Opus — the container is Ogg.
    expect(contentTypeForTtsFormat('opus')).toBe('audio/ogg');
    expect(contentTypeForTtsFormat('wav')).toBe('audio/wav');
  });
});
