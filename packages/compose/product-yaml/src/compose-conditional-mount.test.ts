/**
 * Conditional audio mounting, proven two ways:
 *
 *   1. THE COMPOSE GUARDRAIL (byte-identity golden): the neutral `acme-notes.product.yaml`
 *      composition — engineSpec (version · metadata · stores SET+ORDER+column shapes · api SET+ORDER),
 *      handler ids, triggerEvents, viewRoutes — is pinned byte-for-byte against a committed golden.
 *      Any change to the composed output flips `classifyProductSchema` to 'drifted'; this test is the
 *      forcing function that keeps the conditional-mount refactor behavior-identical for the audio path.
 *
 *   2. THE CONDITIONAL (RED-first): a NON-audio doc (the record_input `INTAKE_YAML` — no audio, no stt,
 *      no agents) mounts NO audio surface at all (no audio stores, routes, handlers, or trigger event).
 *      A prior UNCONDITIONAL audio mount made this arm RED (audio_sessions/audio_tracks +
 *      the five audio routes/handlers rode into every composition).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import { parseProductSpec } from '@rayspec/spec';
import { FakeSttAdapter } from '@rayspec/stt-port';
import { describe, expect, it } from 'vitest';
import { composeCapabilityStores } from './capability-stores.js';
import { composeProductDeploy, type ProductYamlRollout } from './compose.js';
import { deriveProductStores } from './derive-stores.js';
import {
  INTAKE_YAML,
  MEDIA_PLAYBACK_ONLY_YAML,
  parseFixture,
  RecordingEnqueuer,
} from './test-support/fixture.js';

const TENANT = '00000000-0000-0000-0000-0000000000d5';

/** The committed byte-identity golden captured from the compose of acme-notes.product.yaml. */
const GOLDEN = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/acme-notes-compose-golden.json'), 'utf8'),
) as {
  engineSpec: unknown;
  handlerIds: string[];
  triggerEvents: string[];
  viewRoutes: string[];
};

/** Compose the neutral acme-notes product exactly as the boot path wires it (fakes for stt/agent). */
function composeRealAcme() {
  const yaml = readFileSync(
    resolve(__dirname, '../../../../examples/acme-notes/acme-notes.product.yaml'),
    'utf8',
  );
  const parsed = parseProductSpec(yaml);
  if (!parsed.ok)
    throw new Error(`acme-notes.product.yaml must parse:\n${JSON.stringify(parsed.errors)}`);
  const spec = parsed.value;
  const caps = composeCapabilityStores(spec);
  const derived = deriveProductStores(spec, caps.names);
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.note_extractor', () => []);
  const rollout: ProductYamlRollout = {
    tenantId: TENANT,
    enqueuer: new RecordingEnqueuer(),
    stores: derived.stores,
    artifactCollections: derived.artifactCollections,
    ...(derived.transcripts ? { transcripts: derived.transcripts } : {}),
    stt: { adapter: new FakeSttAdapter({ fixtures: [] }) },
    agents: registry,
  };
  return composeProductDeploy(spec, rollout);
}

/** The record_input rollout for INTAKE_YAML (no audio/stt/agents — only the declared store). */
function intakeRollout(): ProductYamlRollout {
  const spec = parseFixture(INTAKE_YAML);
  const derived = deriveProductStores(spec, composeCapabilityStores(spec).names);
  return {
    tenantId: TENANT,
    enqueuer: new RecordingEnqueuer(),
    stores: derived.stores,
    artifactCollections: derived.artifactCollections,
  };
}

describe('compose-acme-notes byte-identity golden (compose guardrail — must stay green with ZERO edits)', () => {
  it('composes acme-notes.product.yaml to the exact engineSpec / handlers / triggers / views', () => {
    const composed = composeRealAcme();

    // ── the WHOLE engineSpec, byte-for-byte (version · metadata · stores set+order+column shapes ·
    //    api set+order · the empty 0.1 skeleton arrays). A single deep-equal pins the store ORDER and
    //    every column's name/type/nullable/unique + the FK — a drift here is a live reboot brick.
    expect(composed.engineSpec).toEqual(GOLDEN.engineSpec);

    // ── the readable facets (blind-regen-resistant): the KNOWN-correct composed shape.
    expect([...composed.handlers.keys()].sort()).toEqual(GOLDEN.handlerIds);
    expect(composed.triggerEvents).toEqual(GOLDEN.triggerEvents);
    expect(composed.triggerEvents).toEqual(['audio_input.finalized_session']);
    expect(composed.viewRoutes).toEqual(GOLDEN.viewRoutes);

    // ── the store SET AND ORDER, called out explicitly (the named freeze surface).
    expect(
      (composed.engineSpec as { stores: { name: string }[] }).stores.map((s) => s.name),
    ).toEqual(['audio_sessions', 'audio_tracks', 'note_artifacts', 'track_transcripts']);
  });
});

describe('conditional audio mount — a NON-audio doc mounts NO audio surface (S4, RED-first)', () => {
  it('INTAKE (record_input, no audio) composes with ZERO audio stores / routes / handlers / trigger', () => {
    const composed = composeProductDeploy(parseFixture(INTAKE_YAML), intakeRollout());
    const storeNames = composed.engineSpec.stores.map((s) => s.name);
    const routes = composed.engineSpec.api.map((r) => `${r.method} ${r.path}`);
    const handlerIds = [...composed.handlers.keys()];

    // NO audio capability stores.
    expect(storeNames).not.toContain('audio_sessions');
    expect(storeNames).not.toContain('audio_tracks');
    // The record surface IS present (the doc declares record_input).
    expect(storeNames).toContain('record_submissions');

    // NO audio routes (the five audio/media routes are gone).
    for (const audioRoute of [
      'POST /sessions/{session_id}/{track}/chunks/{chunk_index}',
      'GET /sessions/{session_id}/{track}/upload-status',
      'POST /sessions/{session_id}/{track}/finalize',
      'POST /sessions/{session_id}/{track}/play-token',
      'GET /sessions/{session_id}/{track}/playback',
    ]) {
      expect(routes).not.toContain(audioRoute);
    }

    // NO audio handlers.
    for (const audioHandler of [
      'audio_input_chunk_ingest',
      'audio_input_upload_status',
      'audio_input_finalize_track',
      'media_playback_token',
      'media_playback_stream',
    ]) {
      expect(handlerIds).not.toContain(audioHandler);
    }

    // The composed trigger vocabulary carries ONLY the record event — no audio finalized-session.
    expect(composed.triggerEvents).not.toContain('audio_input.finalized_session');
    expect(composed.triggerEvents).toEqual(['record_input.record_submitted']);
  });
});

// ── F3: the PARTIAL-audio edge — media_playback-ONLY mounts the WHOLE audio surface ────────────
// DECISION: audio is a COHESIVE all-or-nothing PAIR. `declaresAudio` returns true for EITHER
// `audio_input` OR `media_playback`, and `mountAudioCapability` realizes both ids as ONE runtime
// capability, so declaring media_playback-only mounts the FULL audio surface — INCLUDING the three
// audio_input routes the doc never named. This is SOUND and product-free: (1) it mirrors the existing
// FIELDLOG (audio_input-only) shape, which likewise mounts the media_playback routes it never named —
// rejecting a partial declaration would ALSO break that legitimate record-without-playback product;
// (2) the extra auth-gated routes are harmless when unused, whereas a reject-partial gate would need an
// asymmetric, product-opinionated rule to tell "playback-only (reject)" from "input-only (accept)". We
// PIN mount-both so a future refactor that silently mounted only the declared half goes RED here.
describe('conditional audio mount — media_playback-ONLY mounts the FULL audio surface (F3, all-or-nothing pair)', () => {
  it('a media_playback-only doc (no audio_input) mounts BOTH audio stores + all five audio routes/handlers', () => {
    const spec = parseFixture(MEDIA_PLAYBACK_ONLY_YAML);
    const derived = deriveProductStores(spec, composeCapabilityStores(spec).names);
    const rollout: ProductYamlRollout = {
      tenantId: TENANT,
      enqueuer: new RecordingEnqueuer(),
      stores: derived.stores,
      artifactCollections: derived.artifactCollections,
    };
    const composed = composeProductDeploy(spec, rollout);
    const storeNames = composed.engineSpec.stores.map((s) => s.name);
    const routes = composed.engineSpec.api.map((r) => `${r.method} ${r.path}`);
    const handlerIds = [...composed.handlers.keys()];

    // BOTH audio capability stores mount (not a media_playback-only subset).
    expect(storeNames).toContain('audio_sessions');
    expect(storeNames).toContain('audio_tracks');

    // ALL FIVE audio routes mount — INCLUDING the three audio_input routes the doc never declared.
    for (const audioRoute of [
      'POST /sessions/{session_id}/{track}/chunks/{chunk_index}',
      'GET /sessions/{session_id}/{track}/upload-status',
      'POST /sessions/{session_id}/{track}/finalize',
      'POST /sessions/{session_id}/{track}/play-token',
      'GET /sessions/{session_id}/{track}/playback',
    ]) {
      expect(routes).toContain(audioRoute);
    }
    for (const audioHandler of [
      'audio_input_chunk_ingest',
      'audio_input_upload_status',
      'audio_input_finalize_track',
      'media_playback_token',
      'media_playback_stream',
    ]) {
      expect(handlerIds).toContain(audioHandler);
    }
  });
});

// ── F1 (compose half): a NON-audio doc that DECLARES an agent composes with NO audio/stt surface ─
// The env-demand COUPLING (this doc demands ONLY RAYSPEC_EXTRACTION_MODE) is proven at the boot layer
// in packages/server/src/product-boot-conditional-env.db.test.ts; a SECOND full DBOS launch there is
// unsafe (DBOS is a process-global singleton and the boot path never sets deregisterOnShutdown), so the
// POSITIVE "this agent doc composes/would-boot fine with blob/media/stt unset" half is pinned HERE, at
// the compose layer (no launch). Reads the SAME committed server fixture the boot test demands against,
// so the two layers share ONE source of truth.
describe('conditional mount — a NON-audio doc that DECLARES an agent composes with NO audio/stt surface (F1)', () => {
  it('the non-audio-agent fixture composes the record + declared-store surface, ZERO audio, ZERO stt', () => {
    const yaml = readFileSync(
      resolve(__dirname, '../../../app/server/src/__fixtures__/non-audio-agent.product.yaml'),
      'utf8',
    );
    const parsed = parseProductSpec(yaml);
    if (!parsed.ok)
      throw new Error(`non-audio-agent fixture must parse:\n${JSON.stringify(parsed.errors)}`);
    const spec = parsed.value;
    const derived = deriveProductStores(spec, composeCapabilityStores(spec).names);
    const registry = new InMemoryAgentHandlerRegistry();
    registry.register('agent.doc_intelligence_extractor', () => []);
    const rollout: ProductYamlRollout = {
      tenantId: TENANT,
      enqueuer: new RecordingEnqueuer(),
      stores: derived.stores,
      artifactCollections: derived.artifactCollections,
      agents: registry,
    };
    const composed = composeProductDeploy(spec, rollout);
    const storeNames = composed.engineSpec.stores.map((s) => s.name);

    // NO audio surface, NO stt trigger — the agent rides WITHOUT the audio/stt capabilities.
    expect(storeNames).not.toContain('audio_sessions');
    expect(storeNames).not.toContain('audio_tracks');
    expect(composed.triggerEvents).not.toContain('audio_input.finalized_session');

    // The record ingress + the declared product store ARE present.
    expect(storeNames).toContain('record_submissions');
    expect(storeNames).toContain('extracted_artifacts');
    expect(composed.triggerEvents).toEqual(['record_input.record_submitted']);
  });
});
