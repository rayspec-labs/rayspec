import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  StaticSttMediaResolver,
  SttMediaResolutionError,
  type SttMediaResolver,
} from '@rayspec/stt-port';
import { describe, expect, it, vi } from 'vitest';
import { DeepgramSttAdapter } from './deepgram-adapter.js';

const fixturesDir = join(import.meta.dirname, 'fixtures', 'deepgram');

function loadFixtureText(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // "OggS" — opaque test bytes.
const SECRET_KEY = 'dg-super-secret-key-should-never-leak';

function resolverFor(bytes = AUDIO, contentType = 'audio/ogg'): SttMediaResolver {
  return new StaticSttMediaResolver().set('sess', 'mic', { bytes, contentType });
}

/** A fetch spy that returns a fixed Response and records the (url, init) it was called with. */
function fetchReturning(
  body: string,
  status = 200,
): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function trackRequest(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess',
    track: 'mic' as const,
    media_artifact_ref: 'blob:sess/mic',
    ...overrides,
  };
}

describe('DeepgramSttAdapter — happy path', () => {
  it('POSTs the donor-faithful /v1/listen request and returns a completed neutral transcript', async () => {
    const { fetchImpl, calls } = fetchReturning(loadFixtureText('normal-paragraphs.json'));
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
      now: () => '2026-07-02T00:00:00.000Z',
    });

    const result = await adapter.transcribeTrack(trackRequest());

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed');
    expect(result.transcript.provider).toBe('deepgram');
    expect(result.transcript.full_text).toBe('Hello there. We shipped the baseline today.');
    expect(result.transcript.segments).toHaveLength(2);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('expected a fetch call');
    const url = new URL(call.url);
    expect(url.pathname).toBe('/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-2');
    expect(url.searchParams.get('smart_format')).toBe('true');
    expect(url.searchParams.get('punctuate')).toBe('true');
    expect(url.searchParams.get('detect_language')).toBe('true');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Token ${SECRET_KEY}`);
    expect(headers['Content-Type']).toBe('audio/ogg');
    expect(call.init?.body).toBe(AUDIO);
    expect(call.init?.method).toBe('POST');
  });

  it('pins the WHOLE Deepgram request URL — host + exact param set, no extras (TH-2)', async () => {
    const { fetchImpl, calls } = fetchReturning(loadFixtureText('normal-paragraphs.json'));
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    await adapter.transcribeTrack(trackRequest());
    // Full-string equality: the real host, the /v1/listen path, and EXACTLY these four params in this
    // order — any added/removed/renamed query param breaks this pin (byte-faithful to the proven prior path).
    expect(calls[0]?.url).toBe(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&detect_language=true',
    );
  });

  it('honors model_policy.model_label as the Deepgram model', async () => {
    const { fetchImpl, calls } = fetchReturning(loadFixtureText('normal-paragraphs.json'));
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    const result = await adapter.transcribeTrack(
      trackRequest({ model_policy: { model_label: 'nova-3' } }),
    );
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed');
    expect(result.transcript.model).toBe('nova-3');
    expect(new URL(calls[0]!.url).searchParams.get('model')).toBe('nova-3');
  });

  it('maps a language_hint to language= and omits detect_language', async () => {
    const { fetchImpl, calls } = fetchReturning(loadFixtureText('normal-paragraphs.json'));
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    await adapter.transcribeTrack(trackRequest({ language_policy: { language_hint: 'de' } }));
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('language')).toBe('de');
    expect(url.searchParams.has('detect_language')).toBe(false);
  });

  it('passes the media content type through to the upload header', async () => {
    const { fetchImpl, calls } = fetchReturning(loadFixtureText('empty-silent.json'));
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(AUDIO, 'audio/wav'),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    await adapter.transcribeTrack(trackRequest());
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('audio/wav');
  });

  it('treats a silent response as a completed transcript, not a failure', async () => {
    const { fetchImpl } = fetchReturning(loadFixtureText('empty-silent.json'));
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    const result = await adapter.transcribeTrack(trackRequest());
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed');
    expect(result.transcript.full_text).toBe('');
  });
});

describe('DeepgramSttAdapter — fail-closed options (no network call)', () => {
  it('rejects provider_neutral diarization as unsupported without calling fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    const result = await adapter.transcribeTrack(
      trackRequest({ model_policy: { diarization: 'provider_neutral' } }),
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.error.code).toBe('unsupported_option');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a contradictory language_hint + detect_language combination', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    const result = await adapter.transcribeTrack(
      trackRequest({ language_policy: { language_hint: 'de', detect_language: true } }),
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.error.code).toBe('unsupported_option');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('DeepgramSttAdapter — media + credential fail-closed', () => {
  it('transcribes a FRESH track with NO media_artifact_ref — the resolver is the media authority (PY-D9b regression pin)', async () => {
    // The real resolvers key on `(session_id, track)` and ignore `media_artifact_ref` (the production
    // BlobRemux resolver reads uploaded chunks; the Static resolver maps the pair). The STT node never
    // sets `media_artifact_ref`, so a blanket adapter precondition on it failed EVERY fresh recording
    // with `not_ready` before the provider was even reached — a real production bug. With the resolver
    // able to produce bytes, a ref-less request MUST proceed to the provider and complete.
    const { fetchImpl, calls } = fetchReturning(loadFixtureText('normal-paragraphs.json'));
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
      now: () => '2026-07-02T00:00:00.000Z',
    });
    const result = await adapter.transcribeTrack(trackRequest({ media_artifact_ref: undefined }));
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed');
    expect(result.transcript.provider).toBe('deepgram');
    expect(result.transcript.full_text).toBe('Hello there. We shipped the baseline today.');
    expect(calls).toHaveLength(1); // the provider WAS reached — no premature not_ready short-circuit
  });

  it('returns not_ready when the resolver cannot produce bytes', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const failing: SttMediaResolver = {
      async resolve() {
        throw new SttMediaResolutionError('no bytes');
      },
    };
    const adapter = new DeepgramSttAdapter({
      resolver: failing,
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    const result = await adapter.transcribeTrack(trackRequest());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.error.code).toBe('not_ready');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns provider_unavailable when no API key is configured (env empty, no option)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = new DeepgramSttAdapter({ resolver: resolverFor(), env: {}, fetchImpl });
    const result = await adapter.transcribeTrack(trackRequest());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.error.code).toBe('provider_unavailable');
    expect(result.error.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('DeepgramSttAdapter — HTTP + transport error mapping (content-free)', () => {
  const cases: Array<{ status: number; retryable: boolean }> = [
    { status: 400, retryable: false },
    { status: 401, retryable: false },
    { status: 403, retryable: false },
    { status: 429, retryable: true },
    { status: 500, retryable: true },
    { status: 503, retryable: true },
  ];

  for (const { status, retryable } of cases) {
    it(`maps HTTP ${status} to provider_unavailable (retryable=${retryable}) without echoing the body`, async () => {
      const leakyBody = JSON.stringify({
        err: 'super-secret-body-should-not-leak',
        echoedAudio: 'xyz',
      });
      const { fetchImpl } = fetchReturning(leakyBody, status);
      const adapter = new DeepgramSttAdapter({
        resolver: resolverFor(),
        apiKey: SECRET_KEY,
        env: {},
        fetchImpl,
      });
      const result = await adapter.transcribeTrack(trackRequest());
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') throw new Error('expected failed');
      expect(result.error.code).toBe('provider_unavailable');
      expect(result.error.retryable).toBe(retryable);
      expect(result.error.message).toBe(`deepgram transcription failed: HTTP ${status}`);
      expect(result.error.message).not.toContain('super-secret-body');
    });
  }

  it('maps a transport throw to a retryable provider_unavailable with the class name only', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.1:443 super-secret');
    }) as unknown as typeof fetch;
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    const result = await adapter.transcribeTrack(trackRequest());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.error.code).toBe('provider_unavailable');
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toBe('deepgram request failed: TypeError');
    expect(result.error.message).not.toContain('ECONNREFUSED');
    expect(result.error.message).not.toContain('super-secret');
  });

  it('maps a non-JSON 2xx body to malformed_provider_output', async () => {
    const { fetchImpl } = fetchReturning('<<not json at all>>', 200);
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    const result = await adapter.transcribeTrack(trackRequest());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.error.code).toBe('malformed_provider_output');
  });

  // FCO-4: a structurally-invalid 200 body must FAIL CLOSED, never a silent empty "completed".
  const structurallyInvalid200Bodies: Array<{ label: string; body: string }> = [
    { label: 'a JSON array', body: '[]' },
    { label: 'a JSON array of objects', body: '[{"results":{}}]' },
    { label: 'an empty object', body: '{}' },
    { label: 'a Deepgram-shaped error object', body: '{"err_code":"INVALID_AUTH","err_msg":"x"}' },
    { label: 'an object missing results.channels', body: '{"results":{}}' },
  ];
  for (const { label, body } of structurallyInvalid200Bodies) {
    it(`maps a 200 with ${label} to malformed_provider_output (never a silent empty success)`, async () => {
      const { fetchImpl } = fetchReturning(body, 200);
      const adapter = new DeepgramSttAdapter({
        resolver: resolverFor(),
        apiKey: SECRET_KEY,
        env: {},
        fetchImpl,
      });
      const result = await adapter.transcribeTrack(trackRequest());
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') throw new Error('expected failed');
      expect(result.error.code).toBe('malformed_provider_output');
    });
  }

  it('still treats a genuine silent 200 (results.channels present) as a completed transcript', async () => {
    const body = JSON.stringify({
      results: { channels: [{ alternatives: [{ transcript: '', words: [] }] }] },
    });
    const { fetchImpl } = fetchReturning(body, 200);
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    const result = await adapter.transcribeTrack(trackRequest());
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed');
    expect(result.transcript.full_text).toBe('');
  });
});

describe('DeepgramSttAdapter — secret hygiene', () => {
  it('never surfaces the API key in a SUCCESSFUL completed transcript artifact (TH-3)', async () => {
    // A deterministic CI-run guard: the key is used to authorize the call but must never end up
    // serialized into the neutral artifact a consumer persists/logs. Serialize the WHOLE result.
    const { fetchImpl } = fetchReturning(loadFixtureText('normal-paragraphs.json'));
    const adapter = new DeepgramSttAdapter({
      resolver: resolverFor(),
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
    });
    const result = await adapter.transcribeTrack(trackRequest());
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized.toLowerCase()).not.toContain('authorization');
    expect(serialized).not.toContain('Token ');
  });

  it('never surfaces the API key in any error path', async () => {
    const scenarios: Array<() => Promise<{ status: string; error?: { message: string } }>> = [];
    // HTTP error path.
    scenarios.push(async () => {
      const { fetchImpl } = fetchReturning('body', 500);
      const adapter = new DeepgramSttAdapter({
        resolver: resolverFor(),
        apiKey: SECRET_KEY,
        env: {},
        fetchImpl,
      });
      return adapter.transcribeTrack(trackRequest());
    });
    // Transport error path.
    scenarios.push(async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error(`boom with ${SECRET_KEY}`);
      }) as unknown as typeof fetch;
      const adapter = new DeepgramSttAdapter({
        resolver: resolverFor(),
        apiKey: SECRET_KEY,
        env: {},
        fetchImpl,
      });
      return adapter.transcribeTrack(trackRequest());
    });
    for (const run of scenarios) {
      const result = await run();
      expect(result.status).toBe('failed');
      expect(result.error?.message).not.toContain(SECRET_KEY);
    }
  });
});

describe('DeepgramSttAdapter — session fan-out', () => {
  it('transcribes each finalized track in the session', async () => {
    const resolver = new StaticSttMediaResolver()
      .set('sess', 'mic', { bytes: AUDIO, contentType: 'audio/ogg' })
      .set('sess', 'system', { bytes: AUDIO, contentType: 'audio/ogg' });
    const { fetchImpl } = fetchReturning(loadFixtureText('normal-paragraphs.json'));
    const adapter = new DeepgramSttAdapter({ resolver, apiKey: SECRET_KEY, env: {}, fetchImpl });
    const results = await adapter.transcribeSession({
      session_id: 'sess',
      tracks: [
        { session_id: 'sess', track: 'mic', media_artifact_ref: 'blob:sess/mic' },
        { session_id: 'sess', track: 'system', media_artifact_ref: 'blob:sess/system' },
      ],
    });
    expect(results.map((result) => result.status)).toEqual(['completed', 'completed']);
  });

  // TH-1: assert the WHOLE invariant — the session-level model + language policy must reach EVERY
  // per-track Deepgram request, not just that the fan-out completes. Removing the policy spread in
  // transcribeSession makes this test red (each track would fall back to the default model + detect).
  it('propagates the session model + language policy to every per-track request', async () => {
    const resolver = new StaticSttMediaResolver()
      .set('sess', 'mic', { bytes: AUDIO, contentType: 'audio/ogg' })
      .set('sess', 'system', { bytes: AUDIO, contentType: 'audio/ogg' });
    const { fetchImpl, calls } = fetchReturning(loadFixtureText('normal-paragraphs.json'));
    const adapter = new DeepgramSttAdapter({ resolver, apiKey: SECRET_KEY, env: {}, fetchImpl });

    const results = await adapter.transcribeSession({
      session_id: 'sess',
      tracks: [
        { session_id: 'sess', track: 'mic', media_artifact_ref: 'blob:sess/mic' },
        { session_id: 'sess', track: 'system', media_artifact_ref: 'blob:sess/system' },
      ],
      model_policy: { model_label: 'nova-3' },
      language_policy: { language_hint: 'de' },
    });

    expect(results.map((result) => result.status)).toEqual(['completed', 'completed']);
    expect(calls).toHaveLength(2);
    // EVERY track's request must carry the session's model + language and MUST NOT fall back to
    // detect_language (the language_hint overrides detection).
    for (const call of calls) {
      const url = new URL(call.url);
      expect(url.searchParams.get('model')).toBe('nova-3');
      expect(url.searchParams.get('language')).toBe('de');
      expect(url.searchParams.has('detect_language')).toBe(false);
    }
    // The neutral transcripts also record the session model on every track.
    for (const result of results) {
      if (result.status !== 'completed') throw new Error('expected completed');
      expect(result.transcript.model).toBe('nova-3');
    }
  });
});
