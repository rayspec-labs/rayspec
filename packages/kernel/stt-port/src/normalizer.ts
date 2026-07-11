import type { SttSegment, SttTrack, SttTranscript, SttTranscriptSpan, SttWord } from './types.js';

export interface NormalizeTranscriptInput {
  session_id: string;
  track: SttTrack;
  full_text: string;
  language?: string | null;
  confidence?: number | null;
  duration_seconds?: number | null;
  model?: string | null;
  provider: string;
  provider_run_id?: string | null;
  segments?: Array<{
    id?: string;
    span_id?: string;
    start?: number;
    end?: number;
    text: string;
    confidence?: number | null;
    speaker?: string | null;
  }>;
  words?: Array<{
    text: string;
    punctuated_text?: string;
    start?: number;
    end?: number;
    confidence?: number | null;
    speaker?: string | null;
  }>;
  now?: string;
}

interface NormalizedWordInput {
  text: string;
  punctuated_text?: string;
  start?: number;
  end?: number;
  confidence?: number | null;
  speaker?: string | null;
}

function slugPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function roleForTrack(track: SttTrack): 'local' | 'remote' | 'unknown' {
  if (track === 'mic') return 'local';
  if (track === 'system') return 'remote';
  return 'unknown';
}

function splitWords(text: string): string[] {
  const words = text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)?/gu);
  return words ?? [];
}

function stableId(prefix: string, sessionId: string, track: SttTrack, index?: number): string {
  const base = `${prefix}.${slugPart(sessionId)}.${slugPart(track)}`;
  return index === undefined ? base : `${base}.${String(index).padStart(4, '0')}`;
}

export function normalizeTranscriptArtifact(input: NormalizeTranscriptInput): SttTranscript {
  const now = input.now ?? '2026-07-01T00:00:00.000Z';
  const transcriptId = stableId('stt.transcript', input.session_id, input.track);
  const duration = input.duration_seconds ?? inferDuration(input);
  const segmentInputs =
    input.segments && input.segments.length > 0
      ? input.segments
      : [{ start: 0, end: duration ?? 0, text: input.full_text, confidence: input.confidence }];

  const words = normalizeWords({
    transcriptId,
    sessionId: input.session_id,
    track: input.track,
    fullText: input.full_text,
    duration,
    providedWords: input.words,
  });

  const segmentBounds = segmentInputs.map((segment, index) => ({
    id: segment.id ?? stableId('stt.segment', input.session_id, input.track, index),
    start: segment.start ?? (index === 0 ? 0 : (duration ?? 0)),
    end: segment.end ?? duration ?? segment.start ?? (index === 0 ? 0 : (duration ?? 0)),
    text: segment.text,
    confidence: segment.confidence ?? input.confidence ?? null,
    speaker: segment.speaker ?? null,
  }));

  // Assign each word to exactly ONE segment, then derive BOTH segment.word_ids and span.word_ids
  // from that single assignment. Previously segment.word_ids used raw time-range containment while
  // span.word_ids used the segment_id assignment (which falls back to the first segment), so a word
  // outside every segment's [start, end] appeared in a span but in no segment. One helper, one truth.
  const wordsWithSegments = words.map((word) => ({
    ...word,
    segment_id: segmentIdForWord(word, segmentBounds),
  }));
  const wordIdsBySegment = new Map<string, string[]>();
  for (const word of wordsWithSegments) {
    if (word.segment_id === null) continue;
    const ids = wordIdsBySegment.get(word.segment_id) ?? [];
    ids.push(word.id);
    wordIdsBySegment.set(word.segment_id, ids);
  }

  const segments: SttSegment[] = segmentBounds.map((segment) => ({
    id: segment.id,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    confidence: segment.confidence,
    speaker: segment.speaker,
    word_ids: wordIdsBySegment.get(segment.id) ?? [],
  }));

  const spans: SttTranscriptSpan[] = segmentBounds.map((segment, index) => {
    const source = segmentInputs[index];
    return {
      id: source?.span_id ?? `${input.track}:s${index}`,
      transcript_id: transcriptId,
      session_id: input.session_id,
      track: input.track,
      speaker_role: roleForTrack(input.track),
      start: segment.start,
      end: segment.end,
      text: segment.text,
      segment_ids: [segment.id],
      word_ids: wordIdsBySegment.get(segment.id) ?? [],
    };
  });

  return {
    transcript_id: transcriptId,
    session_id: input.session_id,
    track: input.track,
    status: 'completed',
    full_text: input.full_text,
    language: input.language ?? null,
    confidence: input.confidence ?? null,
    duration_seconds: duration,
    model: input.model ?? null,
    provider: input.provider,
    provider_run_id: input.provider_run_id ?? null,
    segments,
    words: wordsWithSegments,
    spans,
    created_at: now,
    updated_at: now,
  };
}

function segmentIdForWord(
  word: { start: number; end: number },
  segments: Array<{ id: string; start: number; end: number }>,
): string | null {
  return (
    segments.find((segment) => word.start >= segment.start && word.end <= segment.end)?.id ??
    segments[0]?.id ??
    null
  );
}

function inferDuration(input: NormalizeTranscriptInput): number | null {
  const segmentEnd = input.segments?.reduce((max, segment) => Math.max(max, segment.end ?? 0), 0);
  const wordEnd = input.words?.reduce((max, word) => Math.max(max, word.end ?? 0), 0);
  return Math.max(segmentEnd ?? 0, wordEnd ?? 0) || null;
}

function normalizeWords(input: {
  transcriptId: string;
  sessionId: string;
  track: SttTrack;
  fullText: string;
  duration: number | null;
  providedWords?: NormalizedWordInput[];
}): SttWord[] {
  const sourceWords: NormalizedWordInput[] =
    input.providedWords && input.providedWords.length > 0
      ? input.providedWords
      : splitWords(input.fullText).map((text) => ({ text, punctuated_text: text }));
  const step =
    sourceWords.length > 0 ? (input.duration ?? sourceWords.length) / sourceWords.length : 0;

  return sourceWords.map((word, index) => {
    const start = word.start ?? roundSeconds(step * index);
    const end = word.end ?? roundSeconds(step * (index + 1));
    return {
      id: stableId('stt.word', input.sessionId, input.track, index),
      text: word.text,
      punctuated_text: word.punctuated_text ?? word.text,
      start,
      end,
      confidence: word.confidence ?? null,
      speaker: word.speaker ?? null,
      segment_id: null,
    };
  });
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
