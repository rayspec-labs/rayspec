/**
 * The backend-profile `init.tts` capability build — provider selection, both boot refusals, the
 * deterministic offline synthesizer, the option pass-through, and concurrency.
 *
 * NO NETWORK anywhere in this file: the `fake` provider contacts nothing, the `openai` arm is only
 * ever CONSTRUCTED (never called), and the forwarding seam is exercised against a recording stand-in
 * adapter. The live provider's own wire contract is proven in `@rayspec/adapter-openai-tts`.
 */
import { OPENAI_TTS_POLICY } from '@rayspec/adapter-openai-tts';
import type { TtsSynthesisResult, TtsSynthesizeRequest } from '@rayspec/tts-port';
import { TtsAdapterError } from '@rayspec/tts-port';
import { describe, expect, it } from 'vitest';
import { BootConfigError } from './boot-config-error.js';
import {
  AdapterTtsCapability,
  buildTtsCapability,
  FAKE_TTS_BOOT_WARNING,
} from './tts-capability.js';

describe('buildTtsCapability — provider selection', () => {
  it('returns undefined when no provider is configured (the capability is then ABSENT on every init)', () => {
    expect(buildTtsCapability({})).toBeUndefined();
    // A blank/whitespace selection is the same as unset — never a boot error.
    expect(buildTtsCapability({ ttsProvider: '   ' })).toBeUndefined();
  });

  it('builds the deterministic offline synthesizer for `fake` (no credential needed)', async () => {
    const capability = buildTtsCapability({ ttsProvider: 'fake' });
    expect(capability).toBeDefined();
    const result = await capability?.synthesize('Guten Morgen.');
    expect(result?.contentType).toBe('audio/wav');
    expect(result?.bytes.length).toBeGreaterThan(44);
  });

  it('builds the live adapter for `openai` when the credential is present — construction alone makes no call', () => {
    const capability = buildTtsCapability({
      ttsProvider: 'openai',
      openaiApiKey: 'sk-test-key-not-used',
    });
    expect(capability).toBeDefined();
  });

  it('tolerates surrounding whitespace in the provider selection', () => {
    expect(buildTtsCapability({ ttsProvider: ' fake ' })).toBeDefined();
  });
});

describe('buildTtsCapability — fail-closed boot refusals', () => {
  it('REFUSES `openai` without OPENAI_API_KEY, naming the variable and the way out', () => {
    let caught: unknown;
    try {
      buildTtsCapability({ ttsProvider: 'openai' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BootConfigError);
    const message = (caught as BootConfigError).message;
    expect(message).toContain('OPENAI_API_KEY');
    expect(message).toContain('TTS_PROVIDER=openai');
    // The refusal states BOTH escapes: the offline provider, or no capability at all.
    expect(message).toContain('TTS_PROVIDER=fake');
    expect(message).toContain('unset');
  });

  it('REFUSES an unsupported provider name, naming the wired ones', () => {
    let caught: unknown;
    try {
      buildTtsCapability({ ttsProvider: 'elevenlabs' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BootConfigError);
    expect((caught as BootConfigError).message).toContain(
      "TTS_PROVIDER 'elevenlabs' is not supported",
    );
    expect((caught as BootConfigError).message).toContain('wired: openai | fake');
  });

  it('ACCEPT CONTROL: an UNSET provider is never an error (no spec signal says a handler speaks)', () => {
    expect(() => buildTtsCapability({})).not.toThrow();
    expect(() => buildTtsCapability({ openaiApiKey: 'sk-present-but-unused' })).not.toThrow();
  });
});

describe('the offline synthesizer is DETERMINISTIC', () => {
  it('answers identical input with BYTE-identical audio, content type and duration', async () => {
    const capability = buildTtsCapability({ ttsProvider: 'fake' });
    if (!capability) throw new Error('expected a capability');
    const first = await capability.synthesize('Guten Morgen.', { voice: 'onyx', format: 'wav' });
    const second = await capability.synthesize('Guten Morgen.', { voice: 'onyx', format: 'wav' });
    expect([...second.bytes]).toEqual([...first.bytes]);
    expect(second.contentType).toBe(first.contentType);
    expect(second.durationSeconds).toBe(first.durationSeconds);
  });

  it('is deterministic across separately-built capabilities (no per-build seed or clock)', async () => {
    const a = await buildTtsCapability({ ttsProvider: 'fake' })?.synthesize('hallo');
    const b = await buildTtsCapability({ ttsProvider: 'fake' })?.synthesize('hallo');
    expect([...(b?.bytes ?? [])]).toEqual([...(a?.bytes ?? [])]);
  });
});

describe('the offline path REFUSES exactly what the live path refuses', () => {
  it('enforces the SAME text cap as the wired provider (fail-closed, never truncated)', async () => {
    const capability = buildTtsCapability({ ttsProvider: 'fake' });
    if (!capability) throw new Error('expected a capability');
    // The fake is handed the live adapter's OWN policy, so the cap is one number, not two.
    await expect(
      capability.synthesize('x'.repeat(OPENAI_TTS_POLICY.maxTextLength + 1)),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('ACCEPT CONTROL: a text exactly at the cap still synthesizes offline', async () => {
    const capability = buildTtsCapability({ ttsProvider: 'fake' });
    const result = await capability?.synthesize('x'.repeat(OPENAI_TTS_POLICY.maxTextLength));
    expect(result?.bytes.length).toBeGreaterThan(44);
  });

  it('enforces the SAME closed voice list as the wired provider', async () => {
    const capability = buildTtsCapability({ ttsProvider: 'fake' });
    if (!capability) throw new Error('expected a capability');
    await expect(
      capability.synthesize('hallo', { voice: 'nonexistent-voice' }),
    ).rejects.toBeInstanceOf(TtsAdapterError);
    // ACCEPT CONTROL: a voice the live adapter accepts is accepted offline too.
    await expect(
      capability.synthesize('hallo', { voice: OPENAI_TTS_POLICY.voices[0] as string }),
    ).resolves.toBeDefined();
  });

  it('REFUSES a NAMED but blank voice through the capability, not just through the port', async () => {
    const capability = buildTtsCapability({ ttsProvider: 'fake' });
    if (!capability) throw new Error('expected a capability');
    for (const voice of ['', ' ']) {
      await expect(capability.synthesize('hallo', { voice })).rejects.toMatchObject({
        code: 'unsupported_option',
      });
    }
  });

  it('REFUSES a NAMED but blank format through the capability, not just through the port', async () => {
    const capability = buildTtsCapability({ ttsProvider: 'fake' });
    if (!capability) throw new Error('expected a capability');
    // An untyped caller can reach this — dropping it here would resolve the adapter's default
    // container for a caller who did name one, the same silent substitution a blank voice gets.
    await expect(capability.synthesize('hallo', { format: '' as never })).rejects.toMatchObject({
      code: 'unsupported_option',
    });
    // ACCEPT CONTROL: each container the port speaks still synthesizes offline.
    for (const format of ['mp3', 'opus', 'wav'] as const) {
      await expect(capability.synthesize('hallo', { format })).resolves.toBeDefined();
    }
  });
});

describe('AdapterTtsCapability — the option pass-through', () => {
  /** A recording stand-in adapter: it captures the neutral request the capability built. */
  function recordingAdapter(): {
    adapter: { id: string; synthesize(r: TtsSynthesizeRequest): Promise<TtsSynthesisResult> };
    calls: TtsSynthesizeRequest[];
  } {
    const calls: TtsSynthesizeRequest[] = [];
    return {
      calls,
      adapter: {
        id: 'recording',
        async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesisResult> {
          calls.push(request);
          return {
            bytes: new TextEncoder().encode(request.text),
            contentType: 'audio/wav',
            durationSeconds: 1,
          };
        },
      },
    };
  }

  it('carries the text and every expressed option through verbatim', async () => {
    const { adapter, calls } = recordingAdapter();
    const capability = new AdapterTtsCapability(adapter);
    await capability.synthesize('Guten Morgen.', { voice: 'onyx', speed: 1.25, format: 'opus' });
    expect(calls).toEqual([{ text: 'Guten Morgen.', voice: 'onyx', speed: 1.25, format: 'opus' }]);
  });

  it('OMITS an option the caller did not express (the adapter resolves its own default)', async () => {
    const { adapter, calls } = recordingAdapter();
    await new AdapterTtsCapability(adapter).synthesize('hallo');
    // Exactly `{ text }` — not `{ text, voice: undefined, ... }`, which would override an adapter
    // default with an explicit undefined.
    expect(calls[0]).toEqual({ text: 'hallo' });
    expect('voice' in (calls[0] as object)).toBe(false);
    expect('speed' in (calls[0] as object)).toBe(false);
    expect('format' in (calls[0] as object)).toBe(false);
  });

  it('carries a speed of 0 through rather than dropping it as falsy', async () => {
    const { adapter, calls } = recordingAdapter();
    await new AdapterTtsCapability(adapter).synthesize('hallo', { speed: 0 });
    expect(calls[0]?.speed).toBe(0);
  });

  it('carries a blank voice through rather than dropping it as falsy (the adapter refuses it)', async () => {
    const { adapter, calls } = recordingAdapter();
    await new AdapterTtsCapability(adapter).synthesize('hallo', { voice: '' });
    // Dropping it here would turn a named-but-blank voice into an ABSENT one, which the adapter
    // resolves to its default — the silent fallback the closed voice list exists to prevent.
    expect('voice' in (calls[0] as object)).toBe(true);
    expect(calls[0]?.voice).toBe('');
  });

  it('carries a blank format through rather than dropping it as falsy (the adapter refuses it)', async () => {
    const { adapter, calls } = recordingAdapter();
    await new AdapterTtsCapability(adapter).synthesize('hallo', { format: '' as never });
    // Same rule as `voice` and `speed: 0`: what the caller EXPRESSED is forwarded, so the adapter
    // refuses an unspeakable container instead of quietly substituting its default one.
    expect('format' in (calls[0] as object)).toBe(true);
    expect(calls[0]?.format).toBe('');
  });

  it('keeps CONCURRENT calls independent — each result belongs to its own text', async () => {
    const texts = ['eins', 'zwei', 'drei', 'vier', 'fünf'];
    const adapter = {
      id: 'delayed',
      async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesisResult> {
        // Stagger completion so a shared-state bug would cross the results over.
        await new Promise((resolve) =>
          setTimeout(resolve, (texts.length - texts.indexOf(request.text)) * 5),
        );
        return {
          bytes: new TextEncoder().encode(request.text),
          contentType: 'audio/wav',
          durationSeconds: 1,
        };
      },
    };
    const capability = new AdapterTtsCapability(adapter);
    const results = await Promise.all(texts.map((text) => capability.synthesize(text)));
    expect(results.map((r) => new TextDecoder().decode(r.bytes))).toEqual(texts);
  });
});

describe('the non-real-provider boot warning', () => {
  it('names the variable and the capability, and calls itself a dev/CI posture', () => {
    expect(FAKE_TTS_BOOT_WARNING).toContain('TTS_PROVIDER=fake');
    expect(FAKE_TTS_BOOT_WARNING).toContain('init.tts');
    expect(FAKE_TTS_BOOT_WARNING).toContain('DEV/CI posture');
    expect(FAKE_TTS_BOOT_WARNING).toContain('NOT a production configuration');
  });
});
