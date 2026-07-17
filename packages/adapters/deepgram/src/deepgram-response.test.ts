import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DeepgramMappingError,
  mapDeepgramResponse,
  mapDeepgramResponseToNeutralInput,
} from './deepgram-response.js';

const fixturesDir = join(import.meta.dirname, 'fixtures', 'deepgram');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
}

const ctx = {
  session_id: 'dg-sess',
  track: 'mic' as const,
  model: 'nova-2',
  now: '2026-07-02T00:00:00.000Z',
};

describe('mapDeepgramResponse — paragraphs path', () => {
  const transcript = mapDeepgramResponse(loadFixture('normal-paragraphs.json'), ctx);

  it('produces a completed provider-neutral transcript with stable ids and provenance', () => {
    expect(transcript.status).toBe('completed');
    expect(transcript.full_text).toBe('Hello there. We shipped the baseline today.');
    expect(transcript.provider).toBe('deepgram');
    expect(transcript.model).toBe('nova-2');
    expect(transcript.language).toBe('en');
    expect(transcript.confidence).toBeCloseTo(0.981, 5);
    expect(transcript.duration_seconds).toBeCloseTo(6.42, 5);
    // request_id is carried as the opaque audit provider_run_id only.
    expect(transcript.provider_run_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(transcript.transcript_id).toBe('stt.transcript.dg-sess.mic');
  });

  it('derives one segment per Deepgram paragraph from sentence text', () => {
    expect(transcript.segments.map((segment) => segment.text)).toEqual([
      'Hello there.',
      'We shipped the baseline today.',
    ]);
    expect(transcript.segments[0]?.start).toBeCloseTo(0.1, 5);
    expect(transcript.segments[0]?.end).toBeCloseTo(0.8, 5);
    expect(transcript.segments[1]?.start).toBeCloseTo(2.0, 5);
    expect(transcript.segments[1]?.end).toBeCloseTo(3.6, 5);
    // Segment confidence is the mean of that paragraph's word confidences.
    expect(transcript.segments[0]?.confidence).toBeCloseTo((0.99 + 0.98) / 2, 5);
  });

  it('keeps BOTH the raw and punctuated word forms Deepgram returns', () => {
    expect(transcript.words).toHaveLength(7);
    expect(transcript.words[0]?.text).toBe('hello');
    expect(transcript.words[0]?.punctuated_text).toBe('Hello');
    expect(transcript.words[1]?.punctuated_text).toBe('there.');
    expect(transcript.words[0]?.confidence).toBeCloseTo(0.99, 5);
  });

  it('never leaks a Deepgram-native field name into the public artifact', () => {
    const serialized = JSON.stringify(transcript);
    expect(serialized).not.toContain('punctuated_word');
    expect(serialized).not.toContain('detected_language');
    expect(serialized).not.toContain('alternatives');
    expect(serialized).not.toContain('channels');
  });
});

describe('mapDeepgramResponse — word-gap fallback (no paragraphs)', () => {
  const transcript = mapDeepgramResponse(loadFixture('word-gap-no-paragraphs.json'), ctx);

  it('splits into segments where the inter-word gap exceeds one second', () => {
    expect(transcript.segments.map((segment) => segment.text)).toEqual([
      'hello there',
      'we shipped',
    ]);
    expect(transcript.segments[0]?.start).toBeCloseTo(0.1, 5);
    expect(transcript.segments[0]?.end).toBeCloseTo(0.8, 5);
    expect(transcript.segments[1]?.start).toBeCloseTo(2.0, 5);
    expect(transcript.segments[1]?.end).toBeCloseTo(2.6, 5);
  });
});

describe('mapDeepgramResponse — empty/silent recording', () => {
  const transcript = mapDeepgramResponse(loadFixture('empty-silent.json'), ctx);

  it('is a valid completed transcript with empty text and no words', () => {
    expect(transcript.status).toBe('completed');
    expect(transcript.full_text).toBe('');
    expect(transcript.words).toHaveLength(0);
    expect(transcript.duration_seconds).toBeCloseTo(1.0, 5);
    expect(transcript.provider_run_id).toBe('00000000-0000-4000-8000-000000000003');
  });
});

describe('mapDeepgramResponse — honest degradation on missing fields', () => {
  const input = mapDeepgramResponseToNeutralInput(
    loadFixture('missing-confidence-words.json'),
    ctx,
  );
  const transcript = mapDeepgramResponse(loadFixture('missing-confidence-words.json'), ctx);

  it('maps absent alternative/word confidence and language to null rather than a fabricated 0', () => {
    expect(input.confidence).toBeNull();
    expect(input.language).toBeNull();
    expect(input.words?.every((word) => word.confidence === null)).toBe(true);
    expect(transcript.confidence).toBeNull();
    expect(transcript.language).toBeNull();
    expect(transcript.words.every((word) => word.confidence === null)).toBe(true);
    // A single segment (gap 0.1s < 1.0s) whose confidence is null because no word confidences exist.
    expect(transcript.segments).toHaveLength(1);
    expect(transcript.segments[0]?.confidence).toBeNull();
  });
});

describe('mapDeepgramResponse — mixed present/absent word confidence (flagged divergence)', () => {
  const transcript = mapDeepgramResponse(loadFixture('mixed-confidence-words.json'), ctx);

  it('averages ONLY the present word confidences (present-count denominator), not a naive run.length', () => {
    // Run = [0.9, absent, 0.6]. Neutral present-only mean = (0.9 + 0.6) / 2 = 0.75.
    // A naive mapping (`run.length` denominator + 0-coercion) would produce (0.9 + 0 + 0.6) / 3 = 0.5.
    // This divergence is DELIBERATE (honest null/absent-confidence contract) and CANNOT surface on
    // real Deepgram data where per-word confidence is always present. Pinned so it can never drift.
    expect(transcript.segments).toHaveLength(1);
    expect(transcript.segments[0]?.confidence).toBeCloseTo(0.75, 5);
    expect(transcript.segments[0]?.confidence).not.toBeCloseTo(0.5, 5);
    // The middle word's absent confidence stays null (never a fabricated 0).
    expect(transcript.words[1]?.confidence).toBeNull();
    expect(transcript.words[0]?.confidence).toBeCloseTo(0.9, 5);
    expect(transcript.words[2]?.confidence).toBeCloseTo(0.6, 5);
  });
});

describe('mapDeepgramResponse — multichannel', () => {
  const transcript = mapDeepgramResponse(loadFixture('multichannel.json'), ctx);

  it('maps only channels[0] and ignores the second channel', () => {
    expect(transcript.full_text).toBe('first channel only');
    expect(transcript.language).toBe('en');
    expect(transcript.words.map((word) => word.text)).toEqual(['first', 'channel', 'only']);
    expect(JSON.stringify(transcript)).not.toContain('segundo');
  });
});

describe('mapDeepgramResponse — malformed input (fail-closed)', () => {
  it('throws DeepgramMappingError for a non-object payload', () => {
    expect(() => mapDeepgramResponse(null, ctx)).toThrow(DeepgramMappingError);
    expect(() => mapDeepgramResponse(undefined, ctx)).toThrow(DeepgramMappingError);
    expect(() => mapDeepgramResponse(42, ctx)).toThrow(DeepgramMappingError);
    expect(() => mapDeepgramResponse('not json', ctx)).toThrow(DeepgramMappingError);
  });

  it('throws DeepgramMappingError for a JSON array body (not a channels-bearing object)', () => {
    // A 200 whose body is a JSON array is structurally NOT a Deepgram transcript — it must fail
    // closed, never a silent empty "success". Arrays are typeof "object", so the old
    // isRecord-only guard let them through to an empty completed transcript.
    expect(() => mapDeepgramResponse([], ctx)).toThrow(DeepgramMappingError);
    expect(() => mapDeepgramResponse([{ results: {} }], ctx)).toThrow(DeepgramMappingError);
  });

  it('throws DeepgramMappingError for an object body lacking results.channels (e.g. an error body)', () => {
    // A Deepgram-shaped error body (or any object without results.channels) is NOT a valid success.
    expect(() => mapDeepgramResponse({}, ctx)).toThrow(DeepgramMappingError);
    expect(() => mapDeepgramResponse({ err_code: 'INVALID_AUTH', err_msg: 'nope' }, ctx)).toThrow(
      DeepgramMappingError,
    );
    expect(() => mapDeepgramResponse({ results: {} }, ctx)).toThrow(DeepgramMappingError);
    expect(() => mapDeepgramResponse({ results: { channels: {} } }, ctx)).toThrow(
      DeepgramMappingError,
    );
  });

  it('accepts a genuine silent recording (results.channels present, empty transcript)', () => {
    // A REAL silent recording still returns results.channels with an empty alternative — that is a
    // VALID completed transcript, distinct from the malformed bodies above.
    const transcript = mapDeepgramResponse(
      { results: { channels: [{ alternatives: [{ transcript: '', words: [] }] }] } },
      ctx,
    );
    expect(transcript.status).toBe('completed');
    expect(transcript.full_text).toBe('');
    expect(transcript.words).toHaveLength(0);
  });
});
