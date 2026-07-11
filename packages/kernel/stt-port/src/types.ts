export type SttTrack = 'mic' | 'system' | (string & {});

export type SttTranscriptStatus = 'absent' | 'pending' | 'processing' | 'completed' | 'failed';

export type SttAdapterScenario = 'completed' | 'pending' | 'failed' | 'malformed_provider_output';

export interface SttLanguagePolicy {
  language_hint?: string;
  detect_language?: boolean;
}

export interface SttModelPolicy {
  adapter_id?: string;
  model_label?: string;
  diarization?: 'off' | 'provider_neutral';
}

export interface SttFinalizedTrackRef {
  session_id: string;
  track: SttTrack;
  media_artifact_ref?: string;
  duration_seconds?: number | null;
}

export interface SttTranscribeTrackRequest extends SttFinalizedTrackRef {
  language_policy?: SttLanguagePolicy;
  model_policy?: SttModelPolicy;
  idempotency_key?: string;
}

export interface SttTranscribeSessionRequest {
  session_id: string;
  tracks: SttFinalizedTrackRef[];
  language_policy?: SttLanguagePolicy;
  model_policy?: SttModelPolicy;
  idempotency_key?: string;
}

export interface SttWord {
  id: string;
  text: string;
  punctuated_text?: string;
  start: number;
  end: number;
  confidence: number | null;
  speaker?: string | null;
  segment_id: string | null;
}

export interface SttSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  confidence: number | null;
  speaker?: string | null;
  word_ids: string[];
}

export interface SttTranscriptSpan {
  id: string;
  transcript_id: string;
  session_id: string;
  track: SttTrack;
  speaker_role: 'local' | 'remote' | 'unknown';
  start: number;
  end: number;
  text: string;
  segment_ids: string[];
  word_ids: string[];
}

export interface SttTranscript {
  transcript_id: string;
  session_id: string;
  track: SttTrack;
  status: SttTranscriptStatus;
  full_text: string;
  language: string | null;
  confidence: number | null;
  duration_seconds: number | null;
  model: string | null;
  provider: string | null;
  provider_run_id?: string | null;
  segments: SttSegment[];
  words: SttWord[];
  spans: SttTranscriptSpan[];
  created_at: string;
  updated_at: string;
}

export interface SttAdapterError {
  code:
    | 'provider_unavailable'
    | 'unsupported_option'
    | 'malformed_provider_output'
    | 'not_ready'
    | 'unknown';
  message: string;
  retryable: boolean;
}

export type SttTranscriptionResult =
  | {
      status: 'completed';
      transcript: SttTranscript;
      error?: undefined;
    }
  | {
      status: 'pending';
      transcript: SttTranscript;
      error?: undefined;
    }
  | {
      status: 'failed';
      transcript?: SttTranscript;
      error: SttAdapterError;
    };

export interface SttAdapter {
  readonly id: string;
  readonly kind: 'fake' | 'provider_boundary' | 'provider';
  transcribeTrack(request: SttTranscribeTrackRequest): Promise<SttTranscriptionResult>;
  transcribeSession(request: SttTranscribeSessionRequest): Promise<SttTranscriptionResult[]>;
}
