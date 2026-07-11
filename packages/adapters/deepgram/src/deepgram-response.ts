import {
  type NormalizeTranscriptInput,
  normalizeTranscriptArtifact,
  type SttTrack,
  type SttTranscript,
} from '@rayspec/stt-port';

/**
 * Pure Deepgram pre-recorded (`/v1/listen`) response -> provider-neutral transcript mapping. This
 * module is the ONLY place that understands Deepgram's native wire shape; it makes NO network call
 * and reads NO credentials (the live call lives in `deepgram-adapter.ts`). It is wire-faithful to a
 * proven production STT response-mapping implementation so a later shadow-run against the frozen
 * baseline can reproduce it, then hands the mapped text/segments/words to the shared
 * `normalizeTranscriptArtifact` for stable neutral ids.
 *
 * Response schema verified against the current Deepgram docs (2026-07, `developers.deepgram.com`):
 *   metadata.request_id / metadata.duration
 *   results.channels[].detected_language
 *   results.channels[].alternatives[].{ transcript, confidence, words[], paragraphs }
 *   words[].{ word, punctuated_word, start, end, confidence, speaker? }
 *   paragraphs.paragraphs[].{ start, end, num_words, speaker?, sentences[].{ text, start, end } }
 *
 * Parsing is defensive (untrusted provider JSON): missing fields degrade honestly rather than invent
 * precision — an absent confidence maps to `null` (per the neutral contract's nullable confidence),
 * not a fabricated `0`. Provider-native field names never leak into the public transcript artifact.
 */

/** Pause (seconds) that starts a new segment when Deepgram returns no paragraphs. */
const SEGMENT_GAP_SECONDS = 1.0;

/** Context the caller supplies (identity + provenance) that is not present in the provider response. */
export interface DeepgramMapContext {
  session_id: string;
  track: SttTrack;
  /** Neutral model label recorded as provenance (the resolved model the adapter used, e.g. `nova-2`). */
  model: string;
  /** Optional deterministic clock for tests; defaults to the normalizer's fixed timestamp. */
  now?: string;
}

/** The response was not a usable Deepgram JSON object (fail-closed, content-free). */
export class DeepgramMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepgramMappingError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Honest nullable confidence: the number when present and finite, otherwise `null` (never a fake 0). */
function optionalConfidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Deepgram speaker labels can be numeric or string; pass through as a neutral string, else `null`. */
function optionalSpeaker(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

interface NeutralSegment {
  start: number;
  end: number;
  text: string;
  confidence: number | null;
}

/**
 * Mean of the PRESENT, finite word confidences in a run; `null` when none are present.
 *
 * DELIBERATE DIVERGENCE from a naive per-run mean (pinned by the `mixed-confidence-words.json` golden fixture):
 *   - the denominator is the count of PRESENT confidences here, vs a naive `run.length` (which would
 *     count absent ones with a coerced `0` in the numerator);
 *   - an all-absent / empty run is `null` here, vs a fabricated `0`.
 * This is a DIRECT consequence of the neutral "absent confidence → null, never a fabricated 0" choice
 * (`optionalConfidence`); making it match the naive form would reintroduce the fabricated 0 the neutral
 * contract deliberately rejects and would make a segment's confidence contradict its words'. On REAL
 * Deepgram data per-word confidence is always present, so this run.length-vs-present divergence CANNOT
 * surface — a shadow-run against real audio reproduces the reference output byte-for-byte.
 */
function meanConfidence(run: Array<Record<string, unknown>>): number | null {
  const values = run
    .map((word) => word.confidence)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

/**
 * Segments from Deepgram paragraphs: each paragraph's text is its
 * sentences joined by a space; words are assigned to the paragraph by a running index while the next
 * word starts before the paragraph end (the final paragraph absorbs the remainder).
 */
function segmentsFromParagraphs(
  paragraphs: Array<Record<string, unknown>>,
  rawWords: Array<Record<string, unknown>>,
): NeutralSegment[] {
  const segments: NeutralSegment[] = [];
  let index = 0;
  const last = paragraphs.length - 1;
  paragraphs.forEach((paragraph, position) => {
    const start = num(paragraph.start);
    const end = num(paragraph.end);
    const run: Array<Record<string, unknown>> = [];
    while (index < rawWords.length && (position === last || num(rawWords[index]?.start) < end)) {
      run.push(asRecord(rawWords[index]));
      index += 1;
    }
    const sentences = asArray(paragraph.sentences).map(asRecord);
    const text = sentences.map((sentence) => str(sentence.text)).join(' ');
    segments.push({ text, start, end, confidence: meanConfidence(run) });
  });
  return segments;
}

/**
 * Segments from raw words when Deepgram returns no paragraphs: a new
 * segment starts whenever the gap between consecutive words exceeds `SEGMENT_GAP_SECONDS`.
 */
function segmentsFromWords(rawWords: Array<Record<string, unknown>>): NeutralSegment[] {
  const segments: NeutralSegment[] = [];
  let run: Array<Record<string, unknown>> = [];
  for (const word of rawWords) {
    const previous = run[run.length - 1];
    if (run.length > 0 && num(word.start) - num(previous?.end) > SEGMENT_GAP_SECONDS) {
      segments.push(segmentFromRun(run));
      run = [];
    }
    run.push(word);
  }
  if (run.length > 0) segments.push(segmentFromRun(run));
  return segments;
}

function segmentFromRun(run: Array<Record<string, unknown>>): NeutralSegment {
  const text = run.map((word) => str(word.punctuated_word) || str(word.word)).join(' ');
  return {
    text,
    start: num(run[0]?.start),
    end: num(run[run.length - 1]?.end),
    confidence: meanConfidence(run),
  };
}

/**
 * Map a Deepgram response object to the shared normalizer input. Fails closed (throws
 * `DeepgramMappingError`, which the adapter maps to `malformed_provider_output`) when the payload is
 * not a structurally-valid Deepgram success — i.e. not a JSON object, a JSON array, or an object that
 * lacks a `results.channels` array (e.g. an error body or a truncated response). This is the FCO-4
 * fail-closed guard: a 200 with a non-transcript body must NEVER map to a silent empty "completed".
 *
 * A GENUINE silent recording is distinct: Deepgram still returns `results.channels` with an empty
 * alternative, so it passes the structural check and maps to a VALID empty completed transcript
 * (silence is not an error).
 */
export function mapDeepgramResponseToNeutralInput(
  payload: unknown,
  ctx: DeepgramMapContext,
): NormalizeTranscriptInput {
  if (!isRecord(payload)) {
    throw new DeepgramMappingError('deepgram returned a non-object response');
  }

  const results = asRecord(payload.results);
  if (!Array.isArray(results.channels)) {
    // Structural fail-closed (FCO-4): a valid `/v1/listen` success always carries a
    // `results.channels` array (even for silence). Its absence means an error/malformed body.
    throw new DeepgramMappingError('deepgram response is missing results.channels');
  }

  const metadata = asRecord(payload.metadata);
  const duration = num(metadata.duration);
  const requestId = typeof metadata.request_id === 'string' ? metadata.request_id : null;

  const channels = results.channels;
  // The single-stream remuxed audio yields one channel; take channels[0] only.
  const channel = asRecord(channels[0]);
  const detectedLanguage =
    typeof channel.detected_language === 'string' ? channel.detected_language : null;
  const alternatives = asArray(channel.alternatives);
  const alt = asRecord(alternatives[0]);

  const fullText = str(alt.transcript);
  const confidence = optionalConfidence(alt.confidence);
  const rawWords = asArray(alt.words).map(asRecord);

  const words = rawWords.map((word) => ({
    // Neutral keeps BOTH forms Deepgram returns (a naive mapping folds them into one); `text` is the raw
    // token, `punctuated_text` the smart-formatted display token.
    text: str(word.word),
    punctuated_text: str(word.punctuated_word) || str(word.word),
    start: num(word.start),
    end: num(word.end),
    confidence: optionalConfidence(word.confidence),
    speaker: optionalSpeaker(word.speaker),
  }));

  const paragraphs = asArray(asRecord(alt.paragraphs).paragraphs).map(asRecord);
  const segments =
    paragraphs.length > 0
      ? segmentsFromParagraphs(paragraphs, rawWords)
      : segmentsFromWords(rawWords);

  return {
    session_id: ctx.session_id,
    track: ctx.track,
    full_text: fullText,
    language: detectedLanguage,
    confidence,
    // Deepgram's billed/processed duration (seconds); kept as provenance even when 0.
    duration_seconds: duration,
    model: ctx.model,
    provider: 'deepgram',
    // The opaque provider run id for audit only — never Product YAML logic.
    provider_run_id: requestId,
    words,
    segments,
    now: ctx.now,
  };
}

/** Map a Deepgram response object straight to the neutral transcript artifact (with stable ids). */
export function mapDeepgramResponse(payload: unknown, ctx: DeepgramMapContext): SttTranscript {
  return normalizeTranscriptArtifact(mapDeepgramResponseToNeutralInput(payload, ctx));
}
