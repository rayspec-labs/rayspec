/**
 * `buildSttCapability` unit tests — provider selection, the fail-closed credential demand, the
 * bytes→ref bridge the ADAPTER-backed capability wraps around a real provider adapter, and the
 * DETERMINISM of the offline (`fake`) transcriber. No DB, no network, no credential read: the one
 * suite that drives the real Deepgram adapter stubs `fetch` and asserts the request never leaves.
 *
 * Two arms are load-bearing.
 *   - The BRIDGE arm: the port is REFERENCE-keyed, so the capability registers the caller's bytes
 *     under a call-derived ref for the duration of the adapter call. Nothing else in the tree
 *     exercises it, so it is proven here on ground truth — the bytes the adapter's resolver produces
 *     are the caller's, the registration is released afterwards, concurrent calls never cross, and an
 *     unregistered ref is refused (→ the neutral `not_ready`, never a network fallback).
 *     FAIL-THE-FIX: drop the `open`/`close` pair in `AdapterSttCapability.transcribe` and every
 *     assertion in that arm REDs (the deepgram path answers `not_ready` and issues NO request).
 *   - The FAKE arm: `STT_PROVIDER=fake` must be a WORKING transcriber on this profile (a handler
 *     exercises the whole bytes-in → neutral-transcript-out path offline), not a boot posture that
 *     throws on the first call. FAIL-THE-FIX: hand the `FakeSttAdapter` an empty fixture set (drop
 *     the synthesized per-call fixture) and every assertion that reads a transcript REDs with
 *     `No fake STT fixture for …`.
 */
import { DeepgramSttAdapter } from '@rayspec/adapter-deepgram';
import {
  normalizeTranscriptArtifact,
  type SttAdapter,
  type SttFinalizedTrackRef,
  SttMediaResolutionError,
  type SttMediaResolver,
  type SttMediaSource,
  type SttTranscribeTrackRequest,
  type SttTranscriptionResult,
} from '@rayspec/stt-port';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BootConfigError } from './boot-config-error.js';
import {
  AdapterSttCapability,
  buildSttCapability,
  FAKE_STT_BOOT_WARNING,
} from './stt-capability.js';

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x7f]);
const OTHER_AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10]);
/** A key-shaped placeholder. It is never a real credential and never asserted on. */
const TEST_KEY = 'not-a-real-key';

/** The smallest structurally-valid Deepgram `/v1/listen` success (one channel, one alternative). */
const DEEPGRAM_OK = JSON.stringify({
  metadata: { request_id: 'req-test', duration: 0.8 },
  results: {
    channels: [
      {
        detected_language: 'en',
        alternatives: [
          {
            transcript: 'hello there',
            confidence: 0.91,
            words: [
              { word: 'hello', punctuated_word: 'Hello', start: 0, end: 0.4, confidence: 0.9 },
              { word: 'there', punctuated_word: 'there.', start: 0.4, end: 0.8, confidence: 0.92 },
            ],
          },
        ],
      },
    ],
  },
});

/** Stub the global `fetch` and record every (url, init) it was handed. Nothing leaves the process. */
function stubFetch(): Array<{ url: string; init: RequestInit | undefined }> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(DEEPGRAM_OK, { status: 200 });
    }),
  );
  return calls;
}

/**
 * A stand-in `SttAdapter` that keeps the call-scoped resolver it was constructed with, so a test can
 * observe WHAT the bridge registered (during the call) and that it is gone (after it).
 */
class ProbeAdapter implements SttAdapter {
  readonly id = 'probe';
  readonly kind = 'fake' as const;
  readonly resolved: SttMediaSource[] = [];
  readonly refs: SttFinalizedTrackRef[] = [];

  constructor(
    readonly resolver: SttMediaResolver,
    /** Optional hook run INSIDE the adapter call, while the registration is still open. */
    private readonly during?: (resolver: SttMediaResolver) => Promise<void>,
  ) {}

  async transcribeTrack(request: SttTranscribeTrackRequest): Promise<SttTranscriptionResult> {
    const source = await this.resolver.resolve(request);
    this.resolved.push(source);
    this.refs.push({ session_id: request.session_id, track: request.track });
    await this.during?.(this.resolver);
    return {
      status: 'completed',
      transcript: normalizeTranscriptArtifact({
        session_id: request.session_id,
        track: request.track,
        full_text: 'probe',
        provider: 'probe',
      }),
    };
  }

  async transcribeSession(): Promise<SttTranscriptionResult[]> {
    throw new Error('the capability never drives transcribeSession');
  }
}

describe('buildSttCapability — provider selection', () => {
  it('returns undefined when no provider is configured (the capability is simply ABSENT)', () => {
    expect(buildSttCapability({})).toBeUndefined();
    expect(buildSttCapability({ sttProvider: '   ' })).toBeUndefined();
  });

  it('FAILS CLOSED on STT_PROVIDER=deepgram with no credential (the eager boot demand)', () => {
    expect(() => buildSttCapability({ sttProvider: 'deepgram' })).toThrow(BootConfigError);
    expect(() => buildSttCapability({ sttProvider: 'deepgram' })).toThrow(/DEEPGRAM_API_KEY/);
  });

  it('FAILS CLOSED on an unsupported provider, naming the wired ones', () => {
    expect(() => buildSttCapability({ sttProvider: 'whisper' })).toThrow(BootConfigError);
    expect(() => buildSttCapability({ sttProvider: 'whisper' })).toThrow(
      /is not supported \(wired: deepgram \| fake\)/,
    );
  });

  it('builds the deepgram capability from a configured credential WITHOUT touching the network', () => {
    // Construction alone must not call out or read the environment (the adapter resolves its wire
    // call lazily, per request). What that capability DOES when driven is the next describe block.
    const capability = buildSttCapability({
      sttProvider: 'deepgram',
      deepgramApiKey: TEST_KEY,
    });
    expect(typeof capability?.transcribe).toBe('function');
  });

  it('the fake boot warning names the env and says no audio is transcribed (warn-only)', () => {
    expect(FAKE_STT_BOOT_WARNING).toContain('STT_PROVIDER=fake');
    expect(FAKE_STT_BOOT_WARNING).toMatch(/DEV\/CI posture/);
  });
});

describe('the bytes→ref bridge (the adapter-backed capability)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads the CALLER’S EXACT bytes to the provider (a real deepgram capability, stubbed fetch)', async () => {
    const calls = stubFetch();
    const stt = buildSttCapability({ sttProvider: 'deepgram', deepgramApiKey: TEST_KEY });
    if (!stt) throw new Error('deepgram + a credential must yield a capability');

    const result = await stt.transcribe(AUDIO, { contentType: 'audio/ogg' });

    // The bridge fed the adapter's resolver, so the adapter reached the provider at all …
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('expected one provider request');
    expect(new URL(call.url).pathname).toBe('/v1/listen');
    // … with the bytes the HANDLER passed in (identity, not a copy of some other clip) …
    expect(call.init?.body).toBe(AUDIO);
    expect((call.init?.headers as Record<string, string>)['Content-Type']).toBe('audio/ogg');
    // … and the mapped provider response came back as the neutral artifact.
    expect(result.status).toBe('completed');
    expect(result.transcript?.full_text).toBe('hello there');
  });

  it('does NOT let concurrent calls cross bytes (each call owns its registration)', async () => {
    const calls = stubFetch();
    const stt = buildSttCapability({ sttProvider: 'deepgram', deepgramApiKey: TEST_KEY });
    if (!stt) throw new Error('deepgram + a credential must yield a capability');

    await Promise.all([stt.transcribe(AUDIO), stt.transcribe(OTHER_AUDIO)]);

    expect(calls).toHaveLength(2);
    const bodies = calls.map((call) => call.init?.body);
    expect(bodies).toContain(AUDIO);
    expect(bodies).toContain(OTHER_AUDIO);
  });

  it('registers the bytes + contentType for the call and RELEASES them afterwards', async () => {
    let probe: ProbeAdapter | undefined;
    const capability = new AdapterSttCapability((resolver) => {
      probe = new ProbeAdapter(resolver);
      return probe;
    });

    await capability.transcribe(AUDIO, { contentType: 'audio/wav' });
    if (!probe) throw new Error('the capability must build its adapter eagerly');

    // DURING the call the adapter's resolver produced exactly what the handler handed in.
    expect(probe.resolved).toHaveLength(1);
    expect(probe.resolved[0]?.bytes).toBe(AUDIO);
    expect(probe.resolved[0]?.contentType).toBe('audio/wav');

    // AFTER it, the registration is gone — the resolver holds no audio between calls.
    const ref = probe.refs[0];
    if (!ref) throw new Error('expected a driven ref');
    await expect(probe.resolver.resolve(ref)).rejects.toBeInstanceOf(SttMediaResolutionError);
  });

  it('keeps two IN-FLIGHT registrations apart (each open call resolves to its OWN clip)', async () => {
    let probe: ProbeAdapter | undefined;
    let arrived = 0;
    let bothArrived: () => void = () => {};
    const bothOpen = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    const crossReads: Array<{ ref: SttFinalizedTrackRef; source: SttMediaSource }> = [];

    const capability = new AdapterSttCapability((resolver) => {
      probe = new ProbeAdapter(resolver, async (open) => {
        arrived += 1;
        if (arrived === 2) bothArrived();
        await bothOpen; // hold BOTH registrations open at the same time
        for (const ref of probe?.refs ?? []) {
          crossReads.push({ ref, source: await open.resolve(ref) });
        }
      });
      return probe;
    });

    await Promise.all([capability.transcribe(AUDIO), capability.transcribe(OTHER_AUDIO)]);
    if (!probe) throw new Error('the capability must build its adapter eagerly');

    // What each call registered, keyed by the ref the bridge derived for it.
    const expected = new Map(
      probe.refs.map((ref, i) => [ref.session_id, probe?.resolved[i]?.bytes]),
    );
    expect(expected.size).toBe(2); // two distinct registrations were open at once
    expect([...expected.values()]).toEqual(expect.arrayContaining([AUDIO, OTHER_AUDIO]));
    // Every cross-read taken while BOTH were open returned that ref's own bytes — never the other's.
    expect(crossReads).toHaveLength(4);
    for (const read of crossReads) {
      expect(read.source.bytes).toBe(expected.get(read.ref.session_id));
    }
  });

  it('refuses an UNREGISTERED ref, and the adapter maps that to the neutral not_ready', async () => {
    const calls = stubFetch();
    let held: SttMediaResolver | undefined;
    let adapter: DeepgramSttAdapter | undefined;
    // The REAL provider adapter over the capability's OWN resolver — the same wiring
    // `buildSttCapability` produces. Driving the adapter DIRECTLY with a ref no call registered is
    // the "the bridge never registered the bytes" mutation, observed end to end.
    const capability = new AdapterSttCapability((resolver) => {
      held = resolver;
      adapter = new DeepgramSttAdapter({ apiKey: TEST_KEY, env: {}, resolver });
      return adapter;
    });
    expect(typeof capability.transcribe).toBe('function');
    if (!held || !adapter) throw new Error('the capability must build its adapter eagerly');

    await expect(
      held.resolve({ session_id: 'handler-stt.never-registered', track: 'audio' }),
    ).rejects.toBeInstanceOf(SttMediaResolutionError);

    const result = await adapter.transcribeTrack({
      session_id: 'handler-stt.never-registered',
      track: 'audio',
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('not_ready');
    expect(calls).toHaveLength(0); // fail-closed BEFORE the provider is reached — never a fallback
  });

  it('refuses the mutually-exclusive language pair without a request (with an accept control)', async () => {
    const calls = stubFetch();
    const stt = buildSttCapability({ sttProvider: 'deepgram', deepgramApiKey: TEST_KEY });
    if (!stt) throw new Error('deepgram + a credential must yield a capability');

    const refused = await stt.transcribe(AUDIO, { languageHint: 'de', detectLanguage: true });
    expect(refused.status).toBe('failed');
    expect(refused.error?.code).toBe('unsupported_option');
    expect(calls).toHaveLength(0); // refused at the boundary — nothing is billed

    // ACCEPT CONTROL: the hint ALONE is a normal call, so the refusal above is the option pair and
    // not a fixture that rejects everything.
    const accepted = await stt.transcribe(AUDIO, { languageHint: 'de' });
    expect(accepted.status).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('language')).toBe('de');
  });
});

describe('buildSttCapability — the offline (fake) transcriber', () => {
  it('transcribes bytes into a completed neutral transcript (a WORKING transcriber, not a posture)', async () => {
    const stt = buildSttCapability({ sttProvider: 'fake' });
    if (!stt) throw new Error('fake provider must yield a capability');
    const result = await stt.transcribe(AUDIO, { contentType: 'audio/ogg' });
    expect(result.status).toBe('completed');
    const transcript = result.transcript;
    if (!transcript) throw new Error('a completed result carries a transcript');
    expect(transcript.status).toBe('completed');
    // The synthetic text is content-derived and obviously synthetic (it names the byte count).
    expect(transcript.full_text).toContain('fake transcript of 7 audio bytes');
    expect(transcript.words.length).toBeGreaterThan(0);
    expect(transcript.segments.length).toBeGreaterThan(0);
    // The fake adapter's fixed clock — never the wall clock (deterministic artifacts).
    expect(transcript.created_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('is DETERMINISTIC: identical input yields a byte-identical artifact', async () => {
    const stt = buildSttCapability({ sttProvider: 'fake' });
    if (!stt) throw new Error('fake provider must yield a capability');
    const first = await stt.transcribe(AUDIO, { contentType: 'audio/ogg' });
    const second = await stt.transcribe(AUDIO, { contentType: 'audio/ogg' });
    expect(second).toEqual(first);
    // A SECOND capability instance (a second boot) agrees — nothing is per-instance state.
    const rebuilt = buildSttCapability({ sttProvider: 'fake' });
    expect(await rebuilt?.transcribe(AUDIO, { contentType: 'audio/ogg' })).toEqual(first);
  });

  it('different bytes yield a different transcript (the artifact is content-derived, not a constant)', async () => {
    const stt = buildSttCapability({ sttProvider: 'fake' });
    if (!stt) throw new Error('fake provider must yield a capability');
    const a = await stt.transcribe(AUDIO);
    const b = await stt.transcribe(OTHER_AUDIO);
    expect(b.transcript?.full_text).not.toBe(a.transcript?.full_text);
    expect(b.transcript?.transcript_id).not.toBe(a.transcript?.transcript_id);
  });

  it('REFUSES the mutually-exclusive language pair exactly as a real provider does', async () => {
    // The offline transcriber stands in for a provider adapter, so it must not ACCEPT what the wired
    // provider refuses — otherwise the one illegal option pair passes in dev/CI and first fails in
    // production. Same neutral code, same message as the deepgram refusal above.
    const stt = buildSttCapability({ sttProvider: 'fake' });
    if (!stt) throw new Error('fake provider must yield a capability');
    const result = await stt.transcribe(AUDIO, { languageHint: 'de', detectLanguage: true });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('unsupported_option');
    expect(result.transcript).toBeUndefined(); // no synthesized transcript for a refused call
  });

  it('ECHOES a language hint and never INVENTS a detection', async () => {
    const stt = buildSttCapability({ sttProvider: 'fake' });
    if (!stt) throw new Error('fake provider must yield a capability');
    const hinted = await stt.transcribe(AUDIO, { languageHint: 'de' });
    expect(hinted.transcript?.language).toBe('de');
    // Asking for detection offline reports NO language rather than a fabricated guess.
    const detected = await stt.transcribe(AUDIO, { detectLanguage: true });
    expect(detected.transcript?.language).toBeNull();
  });

  it('serves CONCURRENT calls independently (each call owns its registration)', async () => {
    const stt = buildSttCapability({ sttProvider: 'fake' });
    if (!stt) throw new Error('fake provider must yield a capability');
    const [a, b, sameAsA] = await Promise.all([
      stt.transcribe(AUDIO),
      stt.transcribe(OTHER_AUDIO),
      stt.transcribe(AUDIO),
    ]);
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    expect(sameAsA).toEqual(a);
    expect(b.transcript?.full_text).not.toBe(a.transcript?.full_text);
  });
});
