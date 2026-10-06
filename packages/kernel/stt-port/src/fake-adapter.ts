import { normalizeTranscriptArtifact } from './normalizer.js';
import type {
  SttAdapter,
  SttAdapterScenario,
  SttFinalizedTrackRef,
  SttTranscribeSessionRequest,
  SttTranscribeTrackRequest,
  SttTranscriptionResult,
} from './types.js';

export const FAKE_STT_ADAPTER_ID = 'fake-stt-ci';

export interface SttShortFixture {
  fixture_id: string;
  transcript: {
    session_id: string;
    track: string;
    status: string;
    model?: string;
    detected_language?: string;
    full_text: string;
    confidence?: number;
    billed_duration_seconds?: number;
    words?: Array<{
      word: string;
      punctuated_word?: string;
      start?: number;
      end?: number;
      confidence?: number;
      speaker?: string | null;
    }>;
    segments?: Array<{
      start?: number;
      end?: number;
      text: string;
    }>;
  };
}

/**
 * The `session_id` of a session fixture that answers ANY session. `*` is outside the id pattern the
 * audio capability accepts for a session, so it never collides with a real one.
 */
export const FAKE_STT_ANY_SESSION = '*';

/**
 * The segments of the fixed transcript, the answer for a recording no fixture matches when the
 * adapter is built with `fallback: 'fixed'`. They carry no product meaning.
 */
export const FAKE_STT_FIXED_SEGMENTS: readonly string[] = [
  'This is the fixed transcript of the fake speech-to-text adapter.',
  'No audio was read and no provider was called.',
];

/**
 * A session fixture: the transcript of each track of one session, or of any session when
 * `session_id` is `FAKE_STT_ANY_SESSION`. A segment becomes one span. What a hand-written fixture
 * leaves out is filled in: `fixture_id` by the session id, a span id by `<track>:s<index>`, and
 * `start`/`end` by five-second slots (`index × 5` to `(index + 1) × 5`).
 */
export interface SttDualTrackFixture {
  fixture_id?: string;
  session_id: string;
  tracks: Array<{
    track: string;
    status?: string;
    segments: Array<{
      span_id?: string;
      text: string;
      start?: number;
      end?: number;
    }>;
  }>;
}

export interface FakeSttAdapterOptions {
  fixtures: Array<SttShortFixture | SttDualTrackFixture>;
  /**
   * What answers a recording no fixture matches. `fixed` ⇒ the fixed transcript
   * (`FAKE_STT_FIXED_SEGMENTS`); absent ⇒ the recording is refused.
   */
  fallback?: 'fixed';
  scenario?: SttAdapterScenario;
  now?: string;
}

/** The seconds one segment of a session fixture spans when it gives no times of its own. */
const FIXTURE_SEGMENT_SECONDS = 5;

export class FakeSttAdapter implements SttAdapter {
  readonly id = FAKE_STT_ADAPTER_ID;
  readonly kind = 'fake' as const;

  private readonly fixtures: Array<SttShortFixture | SttDualTrackFixture>;
  private readonly fallback: 'fixed' | undefined;
  private readonly scenario: SttAdapterScenario;
  private readonly now: string;

  constructor(options: FakeSttAdapterOptions) {
    this.fixtures = options.fixtures;
    this.fallback = options.fallback;
    this.scenario = options.scenario ?? 'completed';
    this.now = options.now ?? '2026-07-01T00:00:00.000Z';
  }

  async transcribeTrack(request: SttTranscribeTrackRequest): Promise<SttTranscriptionResult> {
    return this.resultForTrack(request);
  }

  async transcribeSession(request: SttTranscribeSessionRequest): Promise<SttTranscriptionResult[]> {
    return request.tracks.map((track) => this.resultForTrack(track));
  }

  private resultForTrack(request: SttFinalizedTrackRef): SttTranscriptionResult {
    if (this.scenario === 'malformed_provider_output') {
      return {
        status: 'failed',
        error: {
          code: 'malformed_provider_output',
          message: 'Fake STT adapter simulated malformed provider output.',
          retryable: false,
        },
      };
    }

    const transcript = this.transcriptForTrack(request);
    if (this.scenario === 'pending') {
      return {
        status: 'pending',
        transcript: {
          ...transcript,
          status: 'pending',
          full_text: '',
          confidence: null,
          segments: [],
          words: [],
          spans: [],
        },
      };
    }

    if (this.scenario === 'failed') {
      return {
        status: 'failed',
        transcript: {
          ...transcript,
          status: 'failed',
        },
        error: {
          code: 'unknown',
          message: 'Fake STT adapter simulated a failed transcription.',
          retryable: false,
        },
      };
    }

    return {
      status: 'completed',
      transcript,
    };
  }

  /**
   * The transcript of one track. A fixture for the recording's own session answers first, then a
   * fixture for any session, then the fixed transcript when the adapter has that fallback. The
   * session and track ids are only compared with what the fixtures declare.
   */
  private transcriptForTrack(request: SttFinalizedTrackRef) {
    const fixture =
      this.fixtures.find((candidate) => fixtureMatches(candidate, request)) ??
      this.fixtures.find((candidate) => anySessionFixtureMatches(candidate, request)) ??
      (this.fallback === 'fixed' ? fixedFixture(request.track) : undefined);
    if (!fixture) {
      throw new Error(`No fake STT fixture for ${request.session_id}/${request.track}.`);
    }

    if (isShortFixture(fixture)) {
      return normalizeTranscriptArtifact({
        session_id: fixture.transcript.session_id,
        track: fixture.transcript.track,
        full_text: fixture.transcript.full_text,
        language: fixture.transcript.detected_language ?? null,
        confidence: fixture.transcript.confidence ?? null,
        duration_seconds:
          fixture.transcript.billed_duration_seconds ?? request.duration_seconds ?? null,
        model: fixture.transcript.model ?? 'fake-model',
        provider: this.id,
        provider_run_id: `fake-run:${fixture.fixture_id}:${fixture.transcript.track}`,
        words: fixture.transcript.words?.map((word) => ({
          text: word.word,
          punctuated_text: word.punctuated_word ?? word.word,
          start: word.start,
          end: word.end,
          confidence: word.confidence,
          speaker: word.speaker,
        })),
        segments: fixture.transcript.segments?.map((segment, index) => ({
          span_id: `${fixture.transcript.track}:s${index}`,
          start: segment.start,
          end: segment.end,
          text: segment.text,
          confidence: fixture.transcript.confidence ?? null,
        })),
        now: this.now,
      });
    }

    const track = fixture.tracks.find((candidate) => candidate.track === request.track);
    if (!track) {
      throw new Error(`No fake STT fixture for ${request.session_id}/${request.track}.`);
    }
    const fullText = track.segments.map((segment) => segment.text).join(' ');
    const segments = track.segments.map((segment, index) => ({
      span_id: segment.span_id ?? `${track.track}:s${index}`,
      start: segment.start ?? index * FIXTURE_SEGMENT_SECONDS,
      end: segment.end ?? (index + 1) * FIXTURE_SEGMENT_SECONDS,
      text: segment.text,
      confidence: 0.99,
    }));

    return normalizeTranscriptArtifact({
      // The request's session, which is the fixture's own unless the fixture answers any session.
      session_id: request.session_id,
      track: track.track,
      full_text: fullText,
      language: null,
      confidence: 0.99,
      duration_seconds:
        request.duration_seconds ??
        Math.max(FIXTURE_SEGMENT_SECONDS, ...segments.map((segment) => segment.end)),
      model: 'fake-model',
      provider: this.id,
      provider_run_id: `fake-run:${fixture.fixture_id ?? fixture.session_id}:${track.track}`,
      segments,
      now: this.now,
    });
  }
}

/** The fixed transcript as a session fixture for `track`. */
function fixedFixture(track: string): SttDualTrackFixture {
  return {
    fixture_id: 'fixed',
    session_id: FAKE_STT_ANY_SESSION,
    tracks: [{ track, segments: FAKE_STT_FIXED_SEGMENTS.map((text) => ({ text })) }],
  };
}

function fixtureMatches(
  fixture: SttShortFixture | SttDualTrackFixture,
  request: SttFinalizedTrackRef,
): boolean {
  if (isShortFixture(fixture)) {
    return (
      fixture.transcript.session_id === request.session_id &&
      fixture.transcript.track === request.track
    );
  }
  return (
    fixture.session_id === request.session_id &&
    fixture.tracks.some((track) => track.track === request.track)
  );
}

/**
 * Whether `fixture` is a session fixture for any session that holds the requested track. A request
 * whose own session id is the any-session marker is not a session, and matches nothing here.
 */
function anySessionFixtureMatches(
  fixture: SttShortFixture | SttDualTrackFixture,
  request: SttFinalizedTrackRef,
): boolean {
  return (
    !isShortFixture(fixture) &&
    fixture.session_id === FAKE_STT_ANY_SESSION &&
    request.session_id !== FAKE_STT_ANY_SESSION &&
    fixture.tracks.some((track) => track.track === request.track)
  );
}

function isShortFixture(
  fixture: SttShortFixture | SttDualTrackFixture,
): fixture is SttShortFixture {
  return 'transcript' in fixture;
}

/** Why a value is not a session fixture; `message` names the file and the reason. */
export class FakeSttFixtureError extends Error {
  readonly fileName: string;
  constructor(fileName: string, why: string) {
    super(`fake STT fixture ${fileName}: ${why}`);
    this.name = 'FakeSttFixtureError';
    this.fileName = fileName;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** A time in seconds a segment may start or end at: a finite number from 0. */
function isSecond(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Check that `value` — the parsed content of the fixture file `fileName` — is a session fixture,
 * and return it with only the keys the adapter reads. `session_id`, `tracks`, each track's `track`
 * and `segments` and each segment's `text` are required; `fixture_id` defaults to the file name
 * without `.json`; a track's `status`, when present, must be `completed`; a segment's `span_id`,
 * `start` and `end` are optional. Any other key is ignored. Fail-closed: the first rule a file
 * breaks is thrown as a `FakeSttFixtureError`. The port reads no file; the caller does.
 */
export function parseFakeSttFixture(value: unknown, fileName: string): SttDualTrackFixture {
  const refuse = (why: string): never => {
    throw new FakeSttFixtureError(fileName, why);
  };
  if (!isRecord(value)) return refuse('it is not a JSON object');
  if (!isNonEmptyString(value.session_id)) return refuse('session_id is not a non-empty string');
  if (value.fixture_id !== undefined && !isNonEmptyString(value.fixture_id)) {
    return refuse('fixture_id is not a non-empty string');
  }
  if (!Array.isArray(value.tracks) || value.tracks.length === 0) {
    return refuse('tracks is not a non-empty array');
  }

  const tracks: SttDualTrackFixture['tracks'] = [];
  const trackNames = new Set<string>();
  const rawTracks: unknown[] = value.tracks;
  for (const [i, rawTrack] of rawTracks.entries()) {
    if (!isRecord(rawTrack) || !isNonEmptyString(rawTrack.track)) {
      return refuse(`tracks[${i}].track is not a non-empty string`);
    }
    const name = rawTrack.track;
    if (trackNames.has(name)) return refuse(`track '${name}' appears twice`);
    trackNames.add(name);
    if (rawTrack.status !== undefined && rawTrack.status !== 'completed') {
      return refuse(`tracks[${i}].status is '${String(rawTrack.status)}', not 'completed'`);
    }
    if (!Array.isArray(rawTrack.segments) || rawTrack.segments.length === 0) {
      return refuse(`tracks[${i}].segments is not a non-empty array`);
    }

    const segments: SttDualTrackFixture['tracks'][number]['segments'] = [];
    const rawSegments: unknown[] = rawTrack.segments;
    for (const [j, rawSegment] of rawSegments.entries()) {
      const at = `tracks[${i}].segments[${j}]`;
      if (!isRecord(rawSegment) || !isNonEmptyString(rawSegment.text)) {
        return refuse(`${at}.text is not a non-empty string`);
      }
      if (rawSegment.span_id !== undefined && !isNonEmptyString(rawSegment.span_id)) {
        return refuse(`${at}.span_id is not a non-empty string`);
      }
      // The times are checked as the adapter will use them: a written one, else the slot default.
      const start = rawSegment.start === undefined ? j * FIXTURE_SEGMENT_SECONDS : rawSegment.start;
      const end = rawSegment.end === undefined ? (j + 1) * FIXTURE_SEGMENT_SECONDS : rawSegment.end;
      if (!isSecond(start) || !isSecond(end) || end < start) {
        return refuse(
          `${at} has a start or end that is not a number from 0 with end at or after start`,
        );
      }
      segments.push({
        ...(rawSegment.span_id === undefined ? {} : { span_id: rawSegment.span_id }),
        text: rawSegment.text,
        ...(rawSegment.start === undefined ? {} : { start }),
        ...(rawSegment.end === undefined ? {} : { end }),
      });
    }

    // Uniqueness is over the ids the adapter will emit, so a written id that equals another
    // segment's default id is caught too.
    const spanIds = new Set<string>();
    for (const [j, segment] of segments.entries()) {
      const id = segment.span_id ?? `${name}:s${j}`;
      if (spanIds.has(id)) return refuse(`span id '${id}' appears twice in track '${name}'`);
      spanIds.add(id);
    }

    tracks.push({
      track: name,
      ...(rawTrack.status === undefined ? {} : { status: 'completed' }),
      segments,
    });
  }

  return {
    fixture_id: isNonEmptyString(value.fixture_id)
      ? value.fixture_id
      : fileName.replace(/\.json$/, ''),
    session_id: value.session_id,
    tracks,
  };
}
