/**
 * S4 — `composeCapabilityStores` conditional-by-declaration for BOTH capabilities.
 * Before S4, audio's stores were spread UNCONDITIONALLY (a doc declaring audio was byte-behavior-identical);
 * S4 makes the audio half conditional on the doc declaring `audio_input`/`media_playback`, alongside the
 * S3 record half (conditional on `record_input`). This pins the predicate directly (the helper had no
 * dedicated unit test before S4 — the "audio unconditional" behavior was only implicit).
 */
import { AUDIO_STORE_NAMES } from '@rayspec/audio-runtime';
import { RECORD_STORE_NAMES } from '@rayspec/record-runtime';
import { describe, expect, it } from 'vitest';
import {
  composeCapabilityStores,
  declaresAudio,
  declaresRecordInput,
} from './capability-stores.js';
import { FIELDLOG_YAML, INTAKE_YAML, NOTETOOL_YAML, parseFixture } from './test-support/fixture.js';

const AUDIO_STORE_LIST = [...AUDIO_STORE_NAMES];
const RECORD_STORE_LIST = [...RECORD_STORE_NAMES];

describe('composeCapabilityStores — conditional-by-declaration (S4)', () => {
  it('a doc declaring audio (NOTETOOL) mounts the audio stores, and declaresAudio is true', () => {
    const spec = parseFixture(NOTETOOL_YAML);
    expect(declaresAudio(spec)).toBe(true);
    expect(declaresRecordInput(spec)).toBe(false);
    const composed = composeCapabilityStores(spec);
    expect(composed.stores.map((s) => s.name)).toEqual(AUDIO_STORE_LIST);
    for (const n of AUDIO_STORE_LIST) expect(composed.names.has(n)).toBe(true);
    for (const n of RECORD_STORE_LIST) expect(composed.names.has(n)).toBe(false);
  });

  it('a doc declaring ONLY audio_input (FIELDLOG) still mounts the audio stores', () => {
    const spec = parseFixture(FIELDLOG_YAML);
    expect(declaresAudio(spec)).toBe(true);
    expect(composeCapabilityStores(spec).stores.map((s) => s.name)).toEqual(AUDIO_STORE_LIST);
  });

  it('a NON-audio doc (INTAKE, record_input only) mounts NO audio stores — RED before S4', () => {
    const spec = parseFixture(INTAKE_YAML);
    expect(declaresAudio(spec)).toBe(false);
    expect(declaresRecordInput(spec)).toBe(true);
    const composed = composeCapabilityStores(spec);
    // The record store is present; NO audio store is.
    expect(composed.stores.map((s) => s.name)).toEqual(RECORD_STORE_LIST);
    for (const n of AUDIO_STORE_LIST) expect(composed.names.has(n)).toBe(false);
    for (const n of RECORD_STORE_LIST) expect(composed.names.has(n)).toBe(true);
  });
});
