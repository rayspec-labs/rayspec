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

export interface SttDualTrackFixture {
  fixture_id: string;
  session_id: string;
  tracks: Array<{
    track: string;
    status: string;
    segments: Array<{
      span_id: string;
      text: string;
    }>;
  }>;
}

export interface FakeSttAdapterOptions {
  fixtures: Array<SttShortFixture | SttDualTrackFixture>;
  scenario?: SttAdapterScenario;
  now?: string;
}

export class FakeSttAdapter implements SttAdapter {
  readonly id = FAKE_STT_ADAPTER_ID;
  readonly kind = 'fake' as const;

  private readonly fixtures: Array<SttShortFixture | SttDualTrackFixture>;
  private readonly scenario: SttAdapterScenario;
  private readonly now: string;

  constructor(options: FakeSttAdapterOptions) {
    this.fixtures = options.fixtures;
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

  private transcriptForTrack(request: SttFinalizedTrackRef) {
    const fixture = this.fixtures.find((candidate) => fixtureMatches(candidate, request));
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
      throw new Error(`No fake STT track '${request.track}' in fixture '${fixture.fixture_id}'.`);
    }
    const fullText = track.segments.map((segment) => segment.text).join(' ');

    return normalizeTranscriptArtifact({
      session_id: fixture.session_id,
      track: track.track,
      full_text: fullText,
      language: null,
      confidence: 0.99,
      duration_seconds: request.duration_seconds ?? Math.max(track.segments.length, 1) * 5,
      model: 'fake-model',
      provider: this.id,
      provider_run_id: `fake-run:${fixture.fixture_id}:${track.track}`,
      segments: track.segments.map((segment, index) => ({
        span_id: segment.span_id,
        start: index * 5,
        end: (index + 1) * 5,
        text: segment.text,
        confidence: 0.99,
      })),
      now: this.now,
    });
  }
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

function isShortFixture(
  fixture: SttShortFixture | SttDualTrackFixture,
): fixture is SttShortFixture {
  return 'transcript' in fixture;
}
