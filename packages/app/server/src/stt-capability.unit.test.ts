/**
 * `buildSttCapability` unit tests — provider selection, the fail-closed credential demand, and the
 * DETERMINISM of the offline (`fake`) transcriber. No DB, no network, no credential read.
 *
 * The `fake` arm is the load-bearing one: `STT_PROVIDER=fake` must be a WORKING transcriber on this
 * profile (a handler exercises the whole bytes-in → neutral-transcript-out path offline), not a boot
 * posture that throws on the first call. FAIL-THE-FIX: hand the `FakeSttAdapter` an empty fixture set
 * (drop the synthesized per-call fixture) and every assertion below that reads a transcript REDs with
 * `No fake STT fixture for …`.
 */
import { describe, expect, it } from 'vitest';
import { BootConfigError } from './boot-config-error.js';
import { buildSttCapability, FAKE_STT_BOOT_WARNING } from './stt-capability.js';

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x7f]);
const OTHER_AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10]);

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
    // call lazily, per request). Nothing is transcribed here — this suite makes no network call.
    const capability = buildSttCapability({
      sttProvider: 'deepgram',
      deepgramApiKey: 'not-a-real-key',
    });
    expect(typeof capability?.transcribe).toBe('function');
  });

  it('the fake boot warning names the env and says no audio is transcribed (warn-only)', () => {
    expect(FAKE_STT_BOOT_WARNING).toContain('STT_PROVIDER=fake');
    expect(FAKE_STT_BOOT_WARNING).toMatch(/DEV\/CI posture/);
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
