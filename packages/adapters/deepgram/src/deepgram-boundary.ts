import type {
  SttAdapter,
  SttTranscribeSessionRequest,
  SttTranscribeTrackRequest,
  SttTranscriptionResult,
} from '@rayspec/stt-port';

export const DEEPGRAM_STT_ADAPTER_ID = 'deepgram';

export class DeepgramSttBoundaryAdapter implements SttAdapter {
  readonly id = DEEPGRAM_STT_ADAPTER_ID;
  readonly kind = 'provider_boundary' as const;

  async transcribeTrack(_request: SttTranscribeTrackRequest): Promise<SttTranscriptionResult> {
    return unavailableBoundaryResult();
  }

  async transcribeSession(request: SttTranscribeSessionRequest): Promise<SttTranscriptionResult[]> {
    return request.tracks.map(() => unavailableBoundaryResult());
  }
}

function unavailableBoundaryResult(): SttTranscriptionResult {
  return {
    status: 'failed',
    error: {
      code: 'provider_unavailable',
      message:
        'Deepgram is documented as the first real STT adapter boundary, but Stage 5 does not call live providers.',
      retryable: false,
    },
  };
}
