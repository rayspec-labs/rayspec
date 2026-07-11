import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_STT_ADAPTER_ID, FakeSttAdapter } from './fake-adapter.js';
import { SttAdapterRegistry } from './registry.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');

function readFixture<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as T;
}

describe('FakeSttAdapter', () => {
  const short = readFixture('examples/acme-notes/fixtures/acme-notes-short-session.json');
  const dual = readFixture('examples/acme-notes/fixtures/acme-notes-dual-track-session.json');

  it('normalizes the short-session fixture into provider-neutral artifacts', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [short, dual] });
    const result = await adapter.transcribeTrack({
      session_id: 'acme-short',
      track: 'mic',
      media_artifact_ref: 'fixture:acme-short/mic',
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected completed result');
    expect(result.transcript.provider).toBe(FAKE_STT_ADAPTER_ID);
    expect(result.transcript.transcript_id).toBe('stt.transcript.acme-short.mic');
    expect(result.transcript.segments[0]?.id).toBe('stt.segment.acme-short.mic.0000');
    expect(result.transcript.words[0]?.id).toBe('stt.word.acme-short.mic.0000');
    expect(result.transcript.spans[0]?.id).toBe('mic:s0');
    expect(JSON.stringify(result.transcript).toLowerCase()).not.toContain('deepgram');
  });

  it('covers both tracks in the dual-track fixture', async () => {
    const adapter = new FakeSttAdapter({ fixtures: [short, dual] });
    const results = await adapter.transcribeSession({
      session_id: 'acme-dual',
      tracks: [
        { session_id: 'acme-dual', track: 'mic' },
        { session_id: 'acme-dual', track: 'system' },
      ],
    });

    expect(results.map((result) => result.status)).toEqual(['completed', 'completed']);
    const completed = results.filter((result) => result.status === 'completed');
    expect(completed.map((result) => result.transcript.spans[0]?.id)).toEqual([
      'mic:s0',
      'system:s0',
    ]);
  });

  it('simulates pending, failed, and malformed-provider-output states', async () => {
    const pending = await new FakeSttAdapter({
      fixtures: [short],
      scenario: 'pending',
    }).transcribeTrack({
      session_id: 'acme-short',
      track: 'mic',
    });
    const failed = await new FakeSttAdapter({
      fixtures: [short],
      scenario: 'failed',
    }).transcribeTrack({
      session_id: 'acme-short',
      track: 'mic',
    });
    const malformed = await new FakeSttAdapter({
      fixtures: [short],
      scenario: 'malformed_provider_output',
    }).transcribeTrack({
      session_id: 'acme-short',
      track: 'mic',
    });

    expect(pending.status).toBe('pending');
    expect(failed.status).toBe('failed');
    expect(malformed.status).toBe('failed');
    if (malformed.status !== 'failed') throw new Error('expected failed result');
    expect(malformed.error.code).toBe('malformed_provider_output');
  });

  it('registers adapters by stable id', () => {
    const registry = new SttAdapterRegistry();
    registry.register(new FakeSttAdapter({ fixtures: [short] }));
    expect(registry.ids()).toEqual([FAKE_STT_ADAPTER_ID]);
    expect(registry.get(FAKE_STT_ADAPTER_ID).id).toBe(FAKE_STT_ADAPTER_ID);
  });
});
