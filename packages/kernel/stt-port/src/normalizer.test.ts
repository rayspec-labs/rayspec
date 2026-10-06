import { describe, expect, it } from 'vitest';
import { normalizeTranscriptArtifact } from './normalizer.js';

describe('normalizeTranscriptArtifact word_ids consistency', () => {
  it('derives identical word_ids for each segment and its span', () => {
    const transcript = normalizeTranscriptArtifact({
      session_id: 'sess-1',
      track: 'mic',
      provider: 'fake',
      full_text: 'alpha beta gamma delta',
      segments: [
        { start: 0, end: 1, text: 'alpha beta' },
        { start: 1, end: 2, text: 'gamma delta' },
      ],
      words: [
        { text: 'alpha', start: 0, end: 0.5 },
        { text: 'beta', start: 0.5, end: 1 },
        { text: 'gamma', start: 1, end: 1.5 },
        // A word that falls OUTSIDE every segment's [start, end] range. Previously it appeared in
        // the first span (segment_id fallback) but in no segment's word_ids (time-range containment).
        { text: 'delta', start: 5, end: 6 },
      ],
    });

    for (let i = 0; i < transcript.segments.length; i += 1) {
      expect(transcript.spans[i]?.word_ids).toEqual(transcript.segments[i]?.word_ids);
    }

    // Every word is assigned to exactly one segment: the union of segment word_ids covers all words
    // with no duplication.
    const allSegmentWordIds = transcript.segments.flatMap((segment) => segment.word_ids);
    const allWordIds = transcript.words.map((word) => word.id);
    expect([...allSegmentWordIds].sort()).toEqual([...allWordIds].sort());

    // The out-of-range word landed in the first segment (the deterministic fallback), matching its span.
    expect(transcript.segments[0]?.word_ids).toContain('stt.word.sess-1.mic.0003');
    expect(transcript.spans[0]?.word_ids).toContain('stt.word.sess-1.mic.0003');
  });
});

describe('normalizeTranscriptArtifact span_granularity', () => {
  const base = {
    session_id: 'sess-1',
    track: 'mic',
    provider: 'fake',
    full_text: 'alpha beta. gamma delta.',
    segments: [
      { start: 0, end: 1, text: 'alpha beta.' },
      { start: 1, end: 2, text: 'gamma delta.' },
    ],
  };

  it('carries the granularity the segments were cut at to the transcript', () => {
    const transcript = normalizeTranscriptArtifact({ ...base, span_granularity: 'sentence' });
    expect(transcript.span_granularity).toBe('sentence');
    expect(transcript.spans.map((span) => span.id)).toEqual(['mic:s0', 'mic:s1']);
  });

  it('leaves the key off the transcript when the input does not carry it', () => {
    const transcript = normalizeTranscriptArtifact(base);
    expect('span_granularity' in transcript).toBe(false);
    expect(Object.keys(transcript)).toEqual([
      'transcript_id',
      'session_id',
      'track',
      'status',
      'full_text',
      'language',
      'confidence',
      'duration_seconds',
      'model',
      'provider',
      'provider_run_id',
      'segments',
      'words',
      'spans',
      'created_at',
      'updated_at',
    ]);
  });
});
