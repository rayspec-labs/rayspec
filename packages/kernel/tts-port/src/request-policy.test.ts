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

  it('measures UTF-16 code units — at least the code points, not the UTF-8 bytes', () => {
    // Astral: 2 code units per code point, so the cap bites at HALF the code points — the
    // conservative direction against a code-point-counting provider.
    const astral = '𝄞'.repeat(POLICY.maxTextLength / 2);
    expect(astral.length).toBe(POLICY.maxTextLength);
    expect(normalizeTtsRequest({ text: astral }, POLICY).text).toBe(astral);
    expect(() =>
      normalizeTtsRequest({ text: '𝄞'.repeat(POLICY.maxTextLength / 2 + 1) }, POLICY),
    ).toThrow(TtsAdapterError);

    // Non-ASCII BMP: 1 code unit but 2 UTF-8 bytes, so a byte-counting provider counts DOUBLE what
    // this guard admits. The guard is not the provider's limit and does not claim to be.
    const bmp = 'ä'.repeat(POLICY.maxTextLength);
    expect(bmp.length).toBe(POLICY.maxTextLength);
    expect(Buffer.byteLength(bmp, 'utf8')).toBe(POLICY.maxTextLength * 2);
    expect(normalizeTtsRequest({ text: bmp }, POLICY).text).toBe(bmp);
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

  it('ACCEPT CONTROL: an ABSENT voice resolves to the policy default, surrounding space is trimmed', () => {
    expect(normalizeTtsRequest({ text: 'hallo' }, POLICY).voice).toBe(POLICY.defaultVoice);
    expect(normalizeTtsRequest({ text: 'hallo', voice: undefined }, POLICY).voice).toBe(
      POLICY.defaultVoice,
    );
    expect(normalizeTtsRequest({ text: 'hallo', voice: '  beta  ' }, POLICY).voice).toBe('beta');
  });

  it('reads a `null` voice as absent — the ONE named value that still reaches the default', () => {
    // Only an untyped caller can send it (`voice?: string`). Reading it as absent is deliberate:
    // an `=== undefined` test would drop it into `.trim()` and raise a raw TypeError instead of a
    // structured TtsAdapterError. It is the exception to "a named voice is membership-checked",
    // which is why the docstrings that state that rule name it.
    expect(normalizeTtsRequest({ text: 'hallo', voice: null as never }, POLICY).voice).toBe(
      POLICY.defaultVoice,
    );
  });

  it('REFUSES a NAMED but blank voice rather than quietly substituting the default', () => {
    for (const voice of ['', ' ', '\t\n']) {
      let caught: unknown;
      try {
        normalizeTtsRequest({ text: 'hallo', voice }, POLICY);
      } catch (err) {
        caught = err;
      }
      // A blank string is a value the caller passed, not an absent option — resolving it to the
      // default is precisely the silent fallback the closed list exists to prevent.
      expect(caught).toBeInstanceOf(TtsAdapterError);
      expect((caught as TtsAdapterError).code).toBe('unsupported_option');
      expect((caught as TtsAdapterError).message).toContain('alpha | beta');
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
