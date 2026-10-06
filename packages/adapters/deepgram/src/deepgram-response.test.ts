import { readdirSync, readFileSync } from 'node:fs';
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

describe('mapDeepgramResponse — the default mapping of every recorded fixture', () => {
  // `default-transcripts/<name>` holds the transcript each fixture mapped to before span granularity
  // existed. With no granularity in the context, and with `paragraph` named explicitly, the mapping
  // has to reproduce it key for key.
  const names = readdirSync(fixturesDir).filter((name) => name.endsWith('.json'));

  it('covers every fixture in the directory', () => {
    expect(names.sort()).toEqual(readdirSync(join(fixturesDir, 'default-transcripts')).sort());
    expect(names).toHaveLength(7);
  });

  it.each(names)('%s maps to its recorded transcript with no granularity given', (name) => {
    const expected = readFileSync(join(fixturesDir, 'default-transcripts', name), 'utf8');
    const transcript = mapDeepgramResponse(loadFixture(name), ctx);
    expect(JSON.stringify(transcript)).toBe(JSON.stringify(JSON.parse(expected)));
  });

  it.each(names)('%s maps to its recorded transcript under paragraph granularity', (name) => {
    const expected = readFileSync(join(fixturesDir, 'default-transcripts', name), 'utf8');
    const transcript = mapDeepgramResponse(loadFixture(name), {
      ...ctx,
      span_granularity: 'paragraph',
    });
    expect(JSON.stringify(transcript)).toBe(JSON.stringify(JSON.parse(expected)));
  });
});

describe('mapDeepgramResponse — sentence granularity', () => {
  const sentenceCtx = { ...ctx, span_granularity: 'sentence' as const };
  const fixture = () => loadFixture('multi-sentence-paragraphs.json');
  const byDefault = mapDeepgramResponse(fixture(), ctx);
  const transcript = mapDeepgramResponse(fixture(), sentenceCtx);

  /** The fixture with its first alternative handed to `edit` — a response the provider could send. */
  function edited(edit: (alternative: Record<string, any>) => void): unknown {
    const payload = fixture() as Record<string, any>;
    edit(payload.results.channels[0].alternatives[0]);
    return payload;
  }

  it('keeps one span per paragraph when no granularity is given', () => {
    expect(byDefault.spans.map((span) => span.id)).toEqual(['mic:s0', 'mic:s1']);
    expect(byDefault.segments.map((segment) => segment.text)).toEqual([
      'We agreed on the rollout order. The upload service goes first. Billing follows a week later.',
      'Who owns the migration? I will take it.',
    ]);
    expect('span_granularity' in byDefault).toBe(false);
  });

  it('emits one segment and one span per sentence, in order across paragraphs', () => {
    expect(
      transcript.spans.map((span) => [span.id, span.start, span.end, span.text, span.segment_ids]),
    ).toEqual([
      ['mic:s0', 0.2, 2.1, 'We agreed on the rollout order.', ['stt.segment.dg-sess.mic.0000']],
      ['mic:s1', 2.4, 4.3, 'The upload service goes first.', ['stt.segment.dg-sess.mic.0001']],
      ['mic:s2', 4.6, 6.9, 'Billing follows a week later.', ['stt.segment.dg-sess.mic.0002']],
      ['mic:s3', 8.5, 10.0, 'Who owns the migration?', ['stt.segment.dg-sess.mic.0003']],
      ['mic:s4', 10.4, 11.6, 'I will take it.', ['stt.segment.dg-sess.mic.0004']],
    ]);
    expect(
      transcript.segments.map((segment) => [segment.start, segment.end, segment.text]),
    ).toEqual(transcript.spans.map((span) => [span.start, span.end, span.text]));
  });

  it('assigns each sentence exactly its own words', () => {
    const textOf = new Map(transcript.words.map((word) => [word.id, word.punctuated_text]));
    const wordsOf = (ids: string[]) => ids.map((id) => textOf.get(id)).join(' ');
    for (const [index, span] of transcript.spans.entries()) {
      expect(wordsOf(span.word_ids)).toBe(span.text);
      expect(transcript.segments[index]?.word_ids).toEqual(span.word_ids);
    }
    // Every word belongs to one sentence: none is left to the first-segment fallback.
    expect(transcript.spans.flatMap((span) => span.word_ids)).toEqual(
      transcript.words.map((word) => word.id),
    );
    expect(transcript.words.map((word) => word.segment_id)).toEqual([
      ...Array(6).fill('stt.segment.dg-sess.mic.0000'),
      ...Array(5).fill('stt.segment.dg-sess.mic.0001'),
      ...Array(5).fill('stt.segment.dg-sess.mic.0002'),
      ...Array(4).fill('stt.segment.dg-sess.mic.0003'),
      ...Array(4).fill('stt.segment.dg-sess.mic.0004'),
    ]);
  });

  it('gives each segment the mean confidence of its sentence, not of its paragraph', () => {
    const expected = [
      (0.99 + 0.98 + 0.97 + 0.99 + 0.96 + 0.95) / 6,
      (0.99 + 0.94 + 0.93 + 0.92 + 0.97) / 5,
      (0.91 + 0.9 + 0.99 + 0.98 + 0.97) / 5,
      (0.99 + 0.98 + 0.99 + 0.9) / 4,
      (0.97 + 0.96 + 0.95 + 0.94) / 4,
    ];
    for (const [index, value] of expected.entries()) {
      expect(transcript.segments[index]?.confidence).toBeCloseTo(value, 10);
    }
  });

  it('carries the speaker exactly as the paragraph mapping does: none on a segment', () => {
    // The request never asks for diarization, so neither mapping puts a speaker on a segment; who
    // spoke is the track, which every span carries.
    expect(transcript.segments.map((segment) => segment.speaker)).toEqual(Array(5).fill(null));
    expect(byDefault.segments.map((segment) => segment.speaker)).toEqual([null, null]);
    expect(transcript.spans.map((span) => [span.track, span.speaker_role])).toEqual(
      Array(5).fill(['mic', 'local']),
    );
    // A response that does carry speaker labels keeps them where the paragraph mapping keeps them:
    // on the words.
    const labelled = edited((alternative) => {
      for (const paragraph of alternative.paragraphs.paragraphs) paragraph.speaker = 1;
      for (const word of alternative.words) word.speaker = 1;
    });
    const labelledSentences = mapDeepgramResponse(labelled, sentenceCtx);
    expect(labelledSentences.segments.map((segment) => segment.speaker)).toEqual(
      Array(5).fill(null),
    );
    expect(mapDeepgramResponse(labelled, ctx).segments.map((segment) => segment.speaker)).toEqual([
      null,
      null,
    ]);
    expect(labelledSentences.words.map((word) => word.speaker)).toEqual(Array(24).fill('1'));
  });

  it('changes nothing but the segments, the spans and the word-to-segment assignment', () => {
    const strip = (value: typeof transcript) => ({
      ...value,
      segments: undefined,
      spans: undefined,
      span_granularity: undefined,
      words: value.words.map((word) => ({ ...word, segment_id: undefined })),
    });
    expect(strip(transcript)).toEqual(strip(byDefault));
    expect(transcript.full_text).toBe(byDefault.full_text);
    expect(transcript.transcript_id).toBe('stt.transcript.dg-sess.mic');
    expect(transcript.words.map((word) => word.id)).toEqual(byDefault.words.map((word) => word.id));
  });

  it('records the granularity on the transcript', () => {
    expect(transcript.span_granularity).toBe('sentence');
    expect(mapDeepgramResponseToNeutralInput(fixture(), sentenceCtx).span_granularity).toBe(
      'sentence',
    );
    expect('span_granularity' in mapDeepgramResponseToNeutralInput(fixture(), ctx)).toBe(false);
  });

  it('falls back to pause-based segments when the response has no paragraphs', () => {
    const noParagraphs = loadFixture('word-gap-no-paragraphs.json');
    const fallback = mapDeepgramResponse(noParagraphs, sentenceCtx);
    expect(fallback).toEqual(mapDeepgramResponse(noParagraphs, ctx));
    expect(fallback.segments.map((segment) => segment.text)).toEqual(['hello there', 'we shipped']);
    // No sentence was read, so the transcript does not claim sentence-sized spans.
    expect('span_granularity' in fallback).toBe(false);
    // The same holds for a paragraphs block that is present but empty.
    const emptyBlock = edited((alternative) => {
      alternative.paragraphs.paragraphs = [];
    });
    expect(mapDeepgramResponse(emptyBlock, sentenceCtx)).toEqual(
      mapDeepgramResponse(emptyBlock, ctx),
    );
  });

  it('maps a silent recording to the same empty transcript under both granularities', () => {
    const silent = loadFixture('empty-silent.json');
    expect(mapDeepgramResponse(silent, sentenceCtx)).toEqual(mapDeepgramResponse(silent, ctx));
  });

  it('keeps a paragraph that lists no sentences as one segment', () => {
    for (const sentences of [undefined, [], 'not-a-list']) {
      const payload = edited((alternative) => {
        alternative.paragraphs.paragraphs[0].sentences = sentences;
      });
      const mapped = mapDeepgramResponse(payload, sentenceCtx);
      const paragraphMapped = mapDeepgramResponse(payload, ctx);
      expect(mapped.spans.map((span) => [span.id, span.start, span.end, span.text])).toEqual([
        ['mic:s0', 0.2, 6.9, ''],
        ['mic:s1', 8.5, 10.0, 'Who owns the migration?'],
        ['mic:s2', 10.4, 11.6, 'I will take it.'],
      ]);
      // That segment is the one the paragraph mapping builds, words and confidence included.
      expect(mapped.segments[0]).toEqual(paragraphMapped.segments[0]);
      expect(mapped.segments[0]?.word_ids).toHaveLength(16);
      expect(mapped.span_granularity).toBe('sentence');
    }
  });

  it('skips a sentence without text and leaves the others their own bounds', () => {
    for (const text of ['', '   ', undefined, 42]) {
      const payload = edited((alternative) => {
        alternative.paragraphs.paragraphs[0].sentences[1].text = text;
      });
      const mapped = mapDeepgramResponse(payload, sentenceCtx);
      expect(mapped.spans.map((span) => [span.id, span.start, span.end, span.text])).toEqual([
        ['mic:s0', 0.2, 2.1, 'We agreed on the rollout order.'],
        ['mic:s1', 4.6, 6.9, 'Billing follows a week later.'],
        ['mic:s2', 8.5, 10.0, 'Who owns the migration?'],
        ['mic:s3', 10.4, 11.6, 'I will take it.'],
      ]);
      // No word is lost: the five words of the skipped sentence take the first-segment fallback
      // the normalizer applies to any word outside every segment.
      expect(mapped.words).toHaveLength(24);
      expect(mapped.words.every((word) => word.segment_id !== null)).toBe(true);
      expect(mapped.segments[0]?.word_ids).toHaveLength(11);
      expect(mapped.segments[1]?.word_ids).toHaveLength(5);
    }
  });

  it('keeps a paragraph whose sentences all lack text as the paragraph segment', () => {
    const payload = edited((alternative) => {
      alternative.paragraphs.paragraphs[1].sentences = [{ text: '' }, { start: 10.4, end: 11.6 }];
    });
    const mapped = mapDeepgramResponse(payload, sentenceCtx);
    expect(mapped.spans.map((span) => [span.id, span.start, span.end])).toEqual([
      ['mic:s0', 0.2, 2.1],
      ['mic:s1', 2.4, 4.3],
      ['mic:s2', 4.6, 6.9],
      ['mic:s3', 8.5, 11.6],
    ]);
    expect(mapped.segments[3]).toEqual({
      ...mapDeepgramResponse(payload, ctx).segments[1],
      id: 'stt.segment.dg-sess.mic.0003',
    });
  });

  it("uses the paragraph's bounds for a sentence that carries no usable start or end", () => {
    const payload = edited((alternative) => {
      const sentences = alternative.paragraphs.paragraphs[0].sentences;
      delete sentences[0].start;
      sentences[1].end = null;
      sentences[2].start = 'soon';
      sentences[2].end = Number.NaN;
    });
    const mapped = mapDeepgramResponse(payload, sentenceCtx);
    expect(mapped.spans.slice(0, 3).map((span) => [span.start, span.end, span.text])).toEqual([
      [0.2, 2.1, 'We agreed on the rollout order.'],
      [2.4, 6.9, 'The upload service goes first.'],
      [0.2, 6.9, 'Billing follows a week later.'],
    ]);
  });

  it('reads the sentences of the first channel only', () => {
    const payload = fixture() as Record<string, any>;
    payload.results.channels.push({
      detected_language: 'es',
      alternatives: [
        {
          transcript: 'Segundo canal. Ignorado.',
          words: [{ word: 'segundo', start: 0, end: 0.5, punctuated_word: 'Segundo' }],
          paragraphs: {
            paragraphs: [
              {
                start: 0,
                end: 1,
                sentences: [
                  { text: 'Segundo canal.', start: 0, end: 0.5 },
                  { text: 'Ignorado.', start: 0.5, end: 1 },
                ],
              },
            ],
          },
        },
      ],
    });
    const mapped = mapDeepgramResponse(payload, sentenceCtx);
    expect(mapped).toEqual(transcript);
    expect(JSON.stringify(mapped)).not.toContain('Segundo');
    // A response whose channels carry no paragraphs keeps its pause-based segments.
    const multichannel = loadFixture('multichannel.json');
    expect(mapDeepgramResponse(multichannel, sentenceCtx)).toEqual(
      mapDeepgramResponse(multichannel, ctx),
    );
  });

  it('never leaks a provider-native field name into the public artifact', () => {
    const serialized = JSON.stringify(transcript);
    expect(serialized).not.toContain('sentences');
    expect(serialized).not.toContain('paragraphs');
    expect(serialized).not.toContain('punctuated_word');
  });
});
