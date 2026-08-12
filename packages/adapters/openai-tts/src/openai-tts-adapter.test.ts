/**
 * The deterministic OpenAI TTS adapter suite — NO network in any test here: every case injects its own
 * `fetchImpl` and an EMPTY `env`, so the suite runs identically in CI (which has no credential).
 *
 * What it pins: the wire-faithful request (URL, method, headers, EXACT body param set — no extras),
 * fail-closed request validation BEFORE any call is made, content-free error mapping per status class,
 * transport and malformed-output mapping, base-URL normalization, and secret hygiene (the key never
 * appears in a successful artifact or in ANY error path).
 */
import { TtsAdapterError } from '@rayspec/tts-port';
import { describe, expect, it, vi } from 'vitest';
import { OpenAiTtsAdapter } from './openai-tts-adapter.js';
import { OPENAI_TTS_POLICY } from './openai-tts-boundary.js';

const SECRET_KEY = 'sk-super-secret-key-should-never-leak';
/** Opaque "audio" bytes the stubbed provider returns (the adapter never decodes them). */
const AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00]);

/** A fetch spy that returns a fixed Response and records the (url, init) it was called with. */
function fetchReturning(
  body: BodyInit | null,
  status = 200,
  headers: Record<string, string> = {},
): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch that must never be called (the fail-closed cases assert on this). */
function fetchNeverCalled(): { fetchImpl: typeof fetch; calls: unknown[] } {
  const calls: unknown[] = [];
  const fetchImpl = vi.fn(async () => {
    calls.push('called');
    return new Response(AUDIO, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('OpenAiTtsAdapter — happy path (wire-faithful)', () => {
  it('POSTs /v1/audio/speech and returns the raw bytes with the container content type', async () => {
    const { fetchImpl, calls } = fetchReturning(AUDIO);
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });

    const result = await adapter.synthesize({ text: 'Guten Morgen.', voice: 'onyx', format: 'mp3' });

    expect([...result.bytes]).toEqual([...AUDIO]);
    expect(result.contentType).toBe('audio/mpeg');
    // The endpoint reports no duration, and inventing one from the text would be a fabrication.
    expect(result.durationSeconds).toBeNull();

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('expected a fetch call');
    expect(call.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(call.init?.method).toBe('POST');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('pins the EXACT request body param set — no extras, ever', async () => {
    const { fetchImpl, calls } = fetchReturning(AUDIO);
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
    await adapter.synthesize({ text: 'Guten Morgen.', voice: 'onyx', speed: 1.25, format: 'wav' });

    // Exact object equality: any added/removed/renamed field breaks this pin. In particular the two
    // options the wired models do NOT accept (a per-request instruction string, a streaming response
    // format) must never appear.
    expect(bodyOf(calls[0]?.init)).toEqual({
      model: 'tts-1',
      input: 'Guten Morgen.',
      voice: 'onyx',
      response_format: 'wav',
      speed: 1.25,
    });
  });

  it('defaults the model, voice, format and speed from the adapter policy', async () => {
    const { fetchImpl, calls } = fetchReturning(AUDIO);
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
    await adapter.synthesize({ text: 'hallo' });
    expect(bodyOf(calls[0]?.init)).toEqual({
      model: 'tts-1',
      input: 'hallo',
      voice: OPENAI_TTS_POLICY.defaultVoice,
      response_format: OPENAI_TTS_POLICY.defaultFormat,
      speed: 1,
    });
  });

  it('honors the tts-1-hd model option', async () => {
    const { fetchImpl, calls } = fetchReturning(AUDIO);
    const adapter = new OpenAiTtsAdapter({
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
      model: 'tts-1-hd',
    });
    await adapter.synthesize({ text: 'hallo' });
    expect(bodyOf(calls[0]?.init).model).toBe('tts-1-hd');
  });

  it('maps each container to its correct content type', async () => {
    for (const [format, contentType] of [
      ['mp3', 'audio/mpeg'],
      ['opus', 'audio/ogg'],
      ['wav', 'audio/wav'],
    ] as const) {
      const { fetchImpl, calls } = fetchReturning(AUDIO);
      const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
      const result = await adapter.synthesize({ text: 'hallo', format });
      expect(result.contentType).toBe(contentType);
      expect(bodyOf(calls[0]?.init).response_format).toBe(format);
    }
  });

  it('refuses an unwired model at CONSTRUCTION, before any request can be billed', () => {
    expect(() => new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, model: 'tts-3' })).toThrow(
      TtsAdapterError,
    );
  });
});

describe('OpenAiTtsAdapter — fail-closed request validation (NO network call)', () => {
  it('REFUSES a text over the 4096-character cap without calling fetch — and never truncates', async () => {
    const { fetchImpl, calls } = fetchNeverCalled();
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });

    await expect(
      adapter.synthesize({ text: 'x'.repeat(OPENAI_TTS_POLICY.maxTextLength + 1) }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    // The whole point of the cap being fail-closed: nothing was sent, so nothing was billed.
    expect(calls).toHaveLength(0);
  });

  it('ACCEPT CONTROL: a text exactly AT the cap is sent whole', async () => {
    const { fetchImpl, calls } = fetchReturning(AUDIO);
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
    const text = 'x'.repeat(OPENAI_TTS_POLICY.maxTextLength);
    await adapter.synthesize({ text });
    expect(String(bodyOf(calls[0]?.init).input)).toHaveLength(OPENAI_TTS_POLICY.maxTextLength);
  });

  it('REFUSES an unknown voice without contacting the provider — membership is validated here', async () => {
    const { fetchImpl, calls } = fetchNeverCalled();
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
    await expect(
      adapter.synthesize({ text: 'hallo', voice: 'nonexistent-voice' }),
    ).rejects.toMatchObject({ code: 'unsupported_option' });
    expect(calls).toHaveLength(0);
  });

  // ACCEPT CONTROL for the refusal above: the membership check passes every listed voice through to
  // the wire UNCHANGED (no silent substitution). Scope, deliberately stated: a stubbed fetch cannot
  // observe whether the PROVIDER accepts a voice — that claim belongs to the live parity arm in
  // openai-tts-adapter.live.test.ts, which walks this same list against the real endpoint.
  it('ACCEPT CONTROL: every voice on the adapter list reaches the wire unchanged', async () => {
    for (const voice of OPENAI_TTS_POLICY.voices) {
      const { fetchImpl, calls } = fetchReturning(AUDIO);
      const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
      await adapter.synthesize({ text: 'hallo', voice });
      expect(bodyOf(calls[0]?.init).voice).toBe(voice);
    }
  });

  it('CLAMPS speed into [0.25, 4] at both ends, with an in-range control — pinned on the wire', async () => {
    for (const [requested, sent] of [
      [0.01, 0.25],
      [-2, 0.25],
      [9, 4],
      [0.25, 0.25],
      [2.5, 2.5],
      [4, 4],
    ] as const) {
      const { fetchImpl, calls } = fetchReturning(AUDIO);
      const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
      await adapter.synthesize({ text: 'hallo', speed: requested });
      expect(bodyOf(calls[0]?.init).speed).toBe(sent);
    }
  });

  it('refuses an empty text without calling fetch', async () => {
    const { fetchImpl, calls } = fetchNeverCalled();
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
    await expect(adapter.synthesize({ text: '   ' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(calls).toHaveLength(0);
  });

  it('throws provider_unavailable when no API key is configured (env empty, no option)', async () => {
    const { fetchImpl, calls } = fetchNeverCalled();
    const adapter = new OpenAiTtsAdapter({ env: {}, fetchImpl });
    await expect(adapter.synthesize({ text: 'hallo' })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('OpenAiTtsAdapter — HTTP + transport error mapping (content-free)', () => {
  for (const [status, retryable] of [
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [429, true],
    [500, true],
    [503, true],
  ] as const) {
    it(`maps HTTP ${status} to provider_unavailable (retryable=${retryable}) without echoing the body`, async () => {
      const leak = 'THE-SUBMITTED-TEXT-AND-A-PROVIDER-MESSAGE';
      const { fetchImpl } = fetchReturning(JSON.stringify({ error: { message: leak } }), status, {
        'content-type': 'application/json',
      });
      const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
      let caught: unknown;
      try {
        await adapter.synthesize({ text: 'hallo' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TtsAdapterError);
      expect((caught as TtsAdapterError).code).toBe('provider_unavailable');
      expect((caught as TtsAdapterError).retryable).toBe(retryable);
      expect((caught as TtsAdapterError).message).toContain(`HTTP ${status}`);
      expect((caught as TtsAdapterError).message).not.toContain(leak);
    });
  }

  it('maps a transport throw to a retryable provider_unavailable with the class name only', async () => {
    const thrown = new TypeError('connect ECONNREFUSED 10.1.2.3:443 while sending "secret text"');
    const fetchImpl = vi.fn(async () => {
      throw thrown;
    }) as unknown as typeof fetch;
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });

    let caught: unknown;
    try {
      await adapter.synthesize({ text: 'hallo' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TtsAdapterError);
    expect((caught as TtsAdapterError).code).toBe('provider_unavailable');
    expect((caught as TtsAdapterError).retryable).toBe(true);
    // The CLASS name only — the thrown message could carry the request content.
    expect((caught as TtsAdapterError).message).toContain('TypeError');
    expect((caught as TtsAdapterError).message).not.toContain('ECONNREFUSED');
    expect((caught as TtsAdapterError).message).not.toContain('secret text');
  });

  it('maps a JSON 2xx to malformed_provider_output (an envelope is not audio)', async () => {
    const { fetchImpl } = fetchReturning(JSON.stringify({ error: 'nope' }), 200, {
      'content-type': 'application/json',
    });
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
    await expect(adapter.synthesize({ text: 'hallo' })).rejects.toMatchObject({
      code: 'malformed_provider_output',
    });
  });

  it('maps an EMPTY 2xx body to malformed_provider_output (never a silent zero-byte success)', async () => {
    const { fetchImpl } = fetchReturning(new Uint8Array([]), 200);
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
    await expect(adapter.synthesize({ text: 'hallo' })).rejects.toMatchObject({
      code: 'malformed_provider_output',
    });
  });

  it('ACCEPT CONTROL: a 2xx carrying an audio content type still succeeds', async () => {
    const { fetchImpl } = fetchReturning(AUDIO, 200, { 'content-type': 'audio/mpeg' });
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
    const result = await adapter.synthesize({ text: 'hallo' });
    expect([...result.bytes]).toEqual([...AUDIO]);
  });
});

describe('OpenAiTtsAdapter — secret hygiene', () => {
  it('never surfaces the API key in a SUCCESSFUL result artifact', async () => {
    const { fetchImpl } = fetchReturning(AUDIO);
    const adapter = new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl });
    const result = await adapter.synthesize({ text: 'hallo' });
    expect(JSON.stringify({ ...result, bytes: [...result.bytes] })).not.toContain(SECRET_KEY);
  });

  it('never surfaces the API key in ANY error path', async () => {
    const paths: Array<() => Promise<unknown>> = [
      // HTTP error
      () => {
        const { fetchImpl } = fetchReturning('nope', 401);
        return new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl }).synthesize({
          text: 'hallo',
        });
      },
      // transport throw carrying the key in its own message
      () => {
        const fetchImpl = vi.fn(async () => {
          throw new Error(`request failed with Authorization: Bearer ${SECRET_KEY}`);
        }) as unknown as typeof fetch;
        return new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl }).synthesize({
          text: 'hallo',
        });
      },
      // malformed output
      () => {
        const { fetchImpl } = fetchReturning(new Uint8Array([]), 200);
        return new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl }).synthesize({
          text: 'hallo',
        });
      },
      // request refused before the call
      () => {
        const { fetchImpl } = fetchNeverCalled();
        return new OpenAiTtsAdapter({ apiKey: SECRET_KEY, env: {}, fetchImpl }).synthesize({
          text: 'hallo',
          voice: 'nonexistent-voice',
        });
      },
    ];
    for (const path of paths) {
      let caught: unknown;
      try {
        await path();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain(SECRET_KEY);
      expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(SECRET_KEY);
    }
  });
});

describe('OpenAiTtsAdapter — base URL normalization', () => {
  for (const configured of [
    'https://proxy.example.test',
    'https://proxy.example.test/',
    'https://proxy.example.test///',
    '  https://proxy.example.test/  ',
  ]) {
    it(`strips trailing slashes from ${JSON.stringify(configured)}`, async () => {
      const { fetchImpl, calls } = fetchReturning(AUDIO);
      const adapter = new OpenAiTtsAdapter({
        apiKey: SECRET_KEY,
        env: {},
        fetchImpl,
        baseUrl: configured,
      });
      await adapter.synthesize({ text: 'hallo' });
      expect(calls[0]?.url).toBe('https://proxy.example.test/v1/audio/speech');
    });
  }

  it('normalizes a pathological trailing-slash run in linear time (ReDoS regression)', async () => {
    const { fetchImpl, calls } = fetchReturning(AUDIO);
    const adapter = new OpenAiTtsAdapter({
      apiKey: SECRET_KEY,
      env: {},
      fetchImpl,
      baseUrl: `https://proxy.example.test${'/'.repeat(50_000)}`,
    });
    const started = Date.now();
    await adapter.synthesize({ text: 'hallo' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls[0]?.url).toBe('https://proxy.example.test/v1/audio/speech');
  });
});
