import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIO_CAPABILITY_MANIFEST } from './manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifestJsonPath = join(here, '..', 'manifest.json');

describe('capability manifest', () => {
  it('the committed manifest.json matches the typed source of truth (no drift)', () => {
    const committed = JSON.parse(readFileSync(manifestJsonPath, 'utf8'));
    expect(committed).toEqual(AUDIO_CAPABILITY_MANIFEST);
  });

  it('declares the session_finalized event with its canonical Tier B contract id', () => {
    const audio = AUDIO_CAPABILITY_MANIFEST.capabilities.find((c) => c.id === 'audio_input');
    const event = audio?.events.find((e) => e.id === 'session_finalized');
    expect(event?.contract).toBe('audio_input.finalized_session');
    expect(event?.idempotency).toBe('session_scoped');
  });

  it('declares the descriptor contract: the EXACT payload keys + the idempotency key field', () => {
    // The compose-time scope check and the per-trigger single-flight key derivation consume
    // THESE fields (the shared TriggerEventDescriptor contract). The payload keys are coupled
    // fail-the-fix to the seam adapter's emitted payload in @rayspec/audio-workflow-bridge
    // (adapter.test.ts); the key field feeds the byte-stable live key `session_id:<id>:finalized`.
    const audio = AUDIO_CAPABILITY_MANIFEST.capabilities.find((c) => c.id === 'audio_input');
    const event = audio?.events.find((e) => e.id === 'session_finalized');
    expect(event?.payload_keys).toEqual(['session_id', 'tenant_id', 'tracks', 'source_capability']);
    expect(event?.idempotency_key_field).toBe('session_id');
    // The key field MUST be a payload key (otherwise every run falls back to per-delivery keys).
    expect(event?.payload_keys).toContain(event?.idempotency_key_field);
  });

  it('marks both capabilities runtime-available and lists the neutral stores', () => {
    expect(AUDIO_CAPABILITY_MANIFEST.status).toBe('runtime');
    for (const cap of AUDIO_CAPABILITY_MANIFEST.capabilities) {
      expect(cap.runtime_status).toBe('available');
    }
    expect(AUDIO_CAPABILITY_MANIFEST.stores).toEqual(['audio_sessions', 'audio_tracks']);
  });

  it('contains ZERO product-specific vocabulary (product-neutral Tier B capability)', () => {
    const serialized = JSON.stringify(AUDIO_CAPABILITY_MANIFEST).toLowerCase();
    for (const word of ['meeting', 'recording', 'transcription', 'deepgram']) {
      expect(serialized).not.toContain(word);
    }
  });
});
