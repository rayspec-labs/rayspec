/**
 * `composeCapabilityStores` conditional-by-declaration for BOTH capabilities.
 * The audio half is conditional on the doc declaring `audio_input`/`media_playback`, alongside the
 * record half (conditional on `record_input`). This pins the predicate directly.
 */
import { AUDIO_STORE_NAMES } from '@rayspec/audio-runtime';
import { RECORD_STORE_NAMES } from '@rayspec/record-runtime';
import { describe, expect, it } from 'vitest';
import {
  composeCapabilityStores,
  declaresAudio,
  declaresRecordInput,
  sttSpanGranularity,
} from './capability-stores.js';
import { FIELDLOG_YAML, INTAKE_YAML, NOTETOOL_YAML, parseFixture } from './test-support/fixture.js';

const AUDIO_STORE_LIST = [...AUDIO_STORE_NAMES];
const RECORD_STORE_LIST = [...RECORD_STORE_NAMES];

describe('composeCapabilityStores — conditional-by-declaration', () => {
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

  it('a NON-audio doc (INTAKE, record_input only) mounts NO audio stores — RED-first', () => {
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

describe('sttSpanGranularity — the transcript span size the document declares', () => {
  const STT_CONTRACTS =
    '    contracts: [stt.transcribe_session, stt.transcript, stt.transcript_span]\n';
  const withGranularity = (value: string) =>
    parseFixture(
      NOTETOOL_YAML.replace(STT_CONTRACTS, `${STT_CONTRACTS}    span_granularity: ${value}\n`),
    );

  it('is paragraph when the stt capability does not declare it', () => {
    expect(sttSpanGranularity(parseFixture(NOTETOOL_YAML))).toBe('paragraph');
  });

  it('is the declared value', () => {
    expect(sttSpanGranularity(withGranularity('sentence'))).toBe('sentence');
    expect(sttSpanGranularity(withGranularity('paragraph'))).toBe('paragraph');
  });

  it('is paragraph for a document without an stt capability', () => {
    expect(sttSpanGranularity(parseFixture(INTAKE_YAML))).toBe('paragraph');
    expect(sttSpanGranularity(parseFixture(FIELDLOG_YAML))).toBe('paragraph');
  });
});
