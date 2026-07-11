/**
 * The ref-resolving node handlers — unit proofs over the REAL parsed fixture + the constraint-
 * enforcing fake HandlerDb. Load-bearing behaviors:
 *  - stt node: authoritative-track re-read (the event is the trigger, not the inventory), transcript
 *    row persistence (the row contract the views read), DECLARED attribution applied to span roles,
 *    fail-closed on no sealed tracks / adapter failure;
 *  - agent node: ctx.artifacts threading into the agent-runtime resolver + the declared
 *    required_output_shape ENFORCED through the wrapper (a wrong-shaped extractor is terminal);
 *  - grounding node: the declared prune/drop executed from ctx (grounded doc emitted under the
 *    candidate's ref — last-producer-wins for downstream consumers);
 *  - validation node: required paths from the DECLARED shape; the LAST '<ref>' producer wins (the
 *    grounded doc is validated, not the raw candidate);
 *  - persist node: collection rows + typed-artifact handle; fail-closed on a missing scope id.
 */

import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import type {
  ArtifactRef,
  CapabilityInvocationContext,
  WorkflowInputEvent,
  WorkflowSpec,
  WorkflowStepSpec,
} from '@rayspec/foundation';
import { InMemoryArtifactStore } from '@rayspec/grounding-runtime';
import type { ProductSpec } from '@rayspec/spec';
import { FakeSttAdapter, type SttDualTrackFixture } from '@rayspec/stt-port';
import { describe, expect, it } from 'vitest';
import {
  makeArtifactPersistNode,
  makeDeclaredAgentNode,
  makeGroundingPolicyNode,
  makeShapeValidationNode,
  makeSttTranscribeSessionNode,
} from './nodes.js';
import { FakeHandlerDb } from './test-support/fake-handler-db.js';
import { parseFixture } from './test-support/fixture.js';

const TENANT = 'tenant-a';
const SESSION = 's1';

const WORKFLOW: WorkflowSpec = {
  id: 'process_recording',
  tier: 'A',
  status: 'runtime_foundation',
  trigger: { event: 'audio_input.finalized_session' },
  idempotency_key: 'unused',
  steps: [],
};

function event(payload: Record<string, unknown> = { session_id: SESSION }): WorkflowInputEvent {
  return {
    id: `${TENANT}:${SESSION}`,
    type: 'audio_input.finalized_session',
    occurred_at: '2026-07-02T00:00:00.000Z',
    payload,
  };
}

function ctx(
  step: WorkflowStepSpec,
  artifacts: ArtifactRef[] = [],
  ev: WorkflowInputEvent = event(),
): CapabilityInvocationContext {
  return {
    workflow: WORKFLOW,
    step,
    input_event: ev,
    input: step.input_from_event ? ev.payload : (step.input ?? {}),
    journal: {
      workflow_run_id: 'run-1',
      workflow_id: WORKFLOW.id,
      idempotency_key: 'k',
      input_event: ev,
      status: 'running',
      node_states: [],
      artifact_refs: [],
      attempts: 0,
      created_at: '2026-07-02T00:00:00.000Z',
      updated_at: '2026-07-02T00:00:00.000Z',
    },
    artifacts,
  };
}

function dualTrackFixture(): SttDualTrackFixture {
  return {
    fixture_id: 'fx-1',
    session_id: SESSION,
    tracks: [
      {
        track: 'mic',
        status: 'completed',
        segments: [
          { span_id: 'mic:s0', text: 'We decided to ship the baseline.' },
          { span_id: 'mic:s1', text: 'Alice will draft the notes.' },
        ],
      },
      {
        track: 'system',
        status: 'completed',
        segments: [{ span_id: 'system:s0', text: 'Sounds good to me.' }],
      },
    ],
  };
}

function sealTracks(db: FakeHandlerDb, tracks: string[] = ['mic', 'system']): void {
  for (const track of tracks) {
    db.rows('audio_tracks').push({
      session_id: SESSION,
      track,
      status: 'completed',
      track_ref: `${TENANT}:${SESSION}:${track}`,
    });
  }
}

const STT_STEP: WorkflowStepSpec = {
  id: 'transcribe',
  capability: 'stt',
  operation: 'transcribe_session',
  input_from_event: true,
  output_artifact_refs: ['stt.transcript', 'stt.transcript_span'],
};

function sttNode(spec: ProductSpec, db: FakeHandlerDb, adapter?: FakeSttAdapter) {
  return makeSttTranscribeSessionNode({
    spec,
    adapter: adapter ?? new FakeSttAdapter({ fixtures: [dualTrackFixture()] }),
    db,
    tenantId: TENANT,
    transcriptStore: 'track_transcripts',
  });
}

describe('stt.transcribe_session node', () => {
  const spec = parseFixture();

  it('re-reads sealed tracks, persists transcript rows, emits attributed spans', async () => {
    const db = new FakeHandlerDb();
    sealTracks(db);
    const result = await sttNode(spec, db)(ctx(STT_STEP));
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;

    // Transcript rows persisted with the row contract the views read (upsert by track_ref).
    const rows = db.rows('track_transcripts');
    expect(rows.map((r) => [r.track, r.status, r.word_count])).toEqual([
      ['mic', 'completed', 11],
      ['system', 'completed', 4],
    ]);
    expect(rows[0]?.track_ref).toBe('tenant-a:s1:mic');
    const payload = rows[0]?.payload as Record<string, unknown>;
    expect(Array.isArray(payload.segments)).toBe(true);
    expect(Array.isArray(payload.words)).toBe(true);

    // Artifacts: the transcript envelope + the ATTRIBUTED span set (mic→local, system→remote —
    // the DECLARED policy, not a hardcoded mapping).
    const spanArtifact = result.artifact_refs?.find((a) => a.kind === 'stt.transcript_span');
    const spans = spanArtifact?.value as Array<{ id: string; track: string; speaker_role: string }>;
    expect(spans.map((s) => s.id)).toEqual(['mic:s0', 'mic:s1', 'system:s0']);
    expect(new Set(spans.map((s) => `${s.track}:${s.speaker_role}`))).toEqual(
      new Set(['mic:local', 'mic:local', 'system:remote']),
    );
  });

  it('media-prep is FAIL-SOFT but LOUD: a throwing hook is caught + LOGGED; transcripts persist + node completes (MP-1)', async () => {
    const db = new FakeHandlerDb();
    sealTracks(db);
    const prepped: string[] = [];
    const logged: string[] = [];
    const node = makeSttTranscribeSessionNode({
      spec,
      adapter: new FakeSttAdapter({ fixtures: [dualTrackFixture()] }),
      db,
      tenantId: TENANT,
      transcriptStore: 'track_transcripts',
      // A media-prep hook that throws for EVERY track — must NOT fail the STT/extraction path.
      mediaPrep: async ({ track }) => {
        prepped.push(track);
        throw new Error(`ffmpeg blew up for ${track}`);
      },
      logger: { error: (m) => logged.push(m) },
    });
    const result = await node(ctx(STT_STEP));
    expect(result.status).toBe('completed'); // the throw did NOT poison the node
    expect(prepped).toEqual(['mic', 'system']); // called best-effort per sealed track
    // the transcripts persisted regardless (play-token separately stays not_ready_409).
    expect(db.rows('track_transcripts').map((r) => r.track)).toEqual(['mic', 'system']);
    // MP-1: the swallow is NEVER silent — a loud structured line fires PER failed track.
    expect(logged).toHaveLength(2);
    const first = JSON.parse(logged[0] as string) as Record<string, unknown>;
    expect(first).toMatchObject({
      event: 'media_prep_failed',
      scope: 'stt.transcribe_session',
      tenant_id: TENANT,
      session_id: SESSION,
      track: 'mic',
    });
    expect(String(first.error)).toContain('ffmpeg blew up for mic');
  });

  it('persists the PUNCTUATED word form (the punctuated-word persist rule)', async () => {
    // The neutral word carries `text` (raw token) + `punctuated_text` (smart-formatted). The persist
    // rule stores `punctuated_word || word` into payload.words[].word, and the client renders that
    // value — persisting the raw token would strip punctuation from the transcript panel on real
    // provider data. Pinned here at the package level (words[7].word 'baseline.' vs 'baseline').
    const db = new FakeHandlerDb();
    sealTracks(db, ['mic']);
    const adapter = new FakeSttAdapter({
      fixtures: [
        {
          fixture_id: 'punctuated-pin',
          transcript: {
            session_id: SESSION,
            track: 'mic',
            status: 'completed',
            full_text: 'Ship the baseline.',
            words: [
              { word: 'Ship', punctuated_word: 'Ship', start: 0, end: 0.5, confidence: 0.9 },
              { word: 'the', punctuated_word: 'the', start: 0.5, end: 1, confidence: 0.9 },
              {
                word: 'baseline',
                punctuated_word: 'baseline.',
                start: 1,
                end: 1.5,
                confidence: 0.9,
              },
            ],
            segments: [{ start: 0, end: 1.5, text: 'Ship the baseline.' }],
          },
        },
      ],
    });
    const result = await sttNode(spec, db, adapter)(ctx(STT_STEP));
    expect(result.status).toBe('completed');
    const payload = db.rows('track_transcripts')[0]?.payload as {
      words: Array<{ word: string }>;
    };
    expect(payload.words.map((w) => w.word)).toEqual(['Ship', 'the', 'baseline.']);
  });

  it('the DECLARED attribution policy overrides the adapter default', async () => {
    const mutated = {
      ...parseFixture(),
      grounding: {
        ...(parseFixture().grounding ?? {}),
        source_span_contract: 'stt.transcript_span',
        attribution_policy: { tracks: { mic: 'remote', system: 'local' } },
      },
    } as ProductSpec;
    const db = new FakeHandlerDb();
    sealTracks(db);
    const result = await sttNode(mutated, db)(ctx(STT_STEP));
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const spans = result.artifact_refs?.find((a) => a.kind === 'stt.transcript_span')
      ?.value as Array<{ track: string; speaker_role: string }>;
    expect(spans.find((s) => s.track === 'mic')?.speaker_role).toBe('remote');
    expect(spans.find((s) => s.track === 'system')?.speaker_role).toBe('local');
  });

  it('fails closed when the session has no sealed tracks', async () => {
    const db = new FakeHandlerDb(); // no audio_tracks rows
    const result = await sttNode(spec, db)(ctx(STT_STEP));
    expect(result.status).toBe('terminal_failure');
    if (result.status === 'completed' || result.status === 'paused') return;
    expect(result.error?.code).toBe('stt_no_sealed_tracks');
  });

  it('maps an adapter failure onto the node failure vocabulary', async () => {
    const db = new FakeHandlerDb();
    sealTracks(db);
    const failing = new FakeSttAdapter({
      fixtures: [dualTrackFixture()],
      scenario: 'malformed_provider_output',
    });
    const result = await sttNode(spec, db, failing)(ctx(STT_STEP));
    expect(result.status).toBe('terminal_failure');
  });
});

// ── the composed chain fixtures (agent → grounding → validation → persist) ──────────────────────

const AGENT_STEP: WorkflowStepSpec = {
  id: 'extract',
  capability: 'agent',
  operation: 'note_extractor',
  depends_on: ['transcribe'],
  input: { transcript: 'stt.transcript', spans: 'stt.transcript_span' },
  artifact_inputs: [
    { name: 'transcript', ref: 'stt.transcript', kind: 'transcript', required: true },
    { name: 'spans', ref: 'stt.transcript_span', kind: 'span_set', required: true },
  ],
  artifact_outputs: [
    {
      name: 'notes',
      ref: 'notetool.notes',
      kind: 'notes_candidate',
      schema_ref: 'notetool.notes',
      materialization_target: 'typed_artifact_ref',
    },
  ],
  agent_extraction: {
    intent: 'note_extraction',
    required_output_shape: {
      schema_ref: 'notetool.notes',
      required_paths: ['headline', 'body', 'findings'],
      additional_properties: false,
    },
    acceptance_boundary: {
      type: 'validation_node',
      requires: ['grounding.check', 'validation.check'],
    },
    materialization: { target: 'typed_artifact_ref', persist_via: 'artifact.persist' },
  },
};

function upstreamSttArtifacts(): ArtifactRef[] {
  return [
    {
      id: 'a:transcript',
      kind: 'stt.transcript',
      source_node_id: 'transcribe',
      value: { session_id: SESSION, tracks: [] },
    },
    {
      id: 'a:spans',
      kind: 'stt.transcript_span',
      source_node_id: 'transcribe',
      value: [
        { id: 'sp-1', track: 'mic', text: 'span one' },
        { id: 'sp-2', track: 'system', text: 'span two' },
      ],
    },
  ];
}

function goodNotes() {
  return {
    headline: 'Sync',
    body: 'Body.',
    findings: [
      { text: 'grounded', evidence: ['sp-1'] },
      { text: 'ungrounded', evidence: ['sp-GHOST'] },
    ],
  };
}

describe('agent node (through the durable artifact threading)', () => {
  it('threads ctx.artifacts into the extractor and enforces the declared shape', async () => {
    const registry = new InMemoryAgentHandlerRegistry();
    let sawSpans: unknown;
    registry.register('agent.note_extractor', (input) => {
      sawSpans = input.artifact_inputs.find((a) => a.ref === 'stt.transcript_span')?.value;
      const output = input.artifact_outputs[0];
      if (!output) throw new Error('no declared output');
      return [{ ...output, value: goodNotes() }];
    });
    const result = await makeDeclaredAgentNode(registry)(ctx(AGENT_STEP, upstreamSttArtifacts()));
    expect(result.status).toBe('completed');
    expect(Array.isArray(sawSpans)).toBe(true); // the upstream artifact REACHED the extractor
  });

  it('a wrong-shaped extractor output is TERMINAL (required_output_shape enforced)', async () => {
    const registry = new InMemoryAgentHandlerRegistry();
    registry.register('agent.note_extractor', (input) => {
      const output = input.artifact_outputs[0];
      if (!output) throw new Error('no declared output');
      return [{ ...output, value: { headline: 'only headline' } }]; // body/findings missing
    });
    const result = await makeDeclaredAgentNode(registry)(ctx(AGENT_STEP, upstreamSttArtifacts()));
    expect(result.status).toBe('terminal_failure');
    if (result.status === 'completed' || result.status === 'paused') return;
    expect(result.error?.code).toBe('agent_output_shape_mismatch');
  });
});

const GROUND_STEP: WorkflowStepSpec = {
  id: 'ground',
  capability: 'grounding',
  operation: 'check',
  depends_on: ['extract'],
  input: { notes: 'notetool.notes', spans: 'stt.transcript_span' },
  output_artifact_refs: ['grounding.result', 'notetool.notes'],
};

function candidateArtifact(value: unknown): ArtifactRef {
  // The agent node emits an ENVELOPE ({ref, kind, schema_ref, content}) — reproduce it faithfully.
  return {
    id: 'agent_artifact:process_recording:extract:notetool.notes',
    kind: 'notetool.notes',
    source_node_id: 'extract',
    value: {
      ref: 'notetool.notes',
      kind: 'notes_candidate',
      schema_ref: 'notetool.notes',
      materialization_target: 'typed_artifact_ref',
      content: value,
    },
  };
}

describe('grounding node (the declared policy from ctx)', () => {
  const spec = parseFixture();

  it('prunes/drops per the declared policy and emits the GROUNDED doc under the candidate ref', async () => {
    const artifacts = [...upstreamSttArtifacts(), candidateArtifact(goodNotes())];
    const result = await makeGroundingPolicyNode(spec)(ctx(GROUND_STEP, artifacts));
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const grounded = result.artifact_refs?.find((a) => a.kind === 'notetool.notes')?.value as {
      findings: Array<{ text: string }>;
    };
    expect(grounded.findings.map((f) => f.text)).toEqual(['grounded']); // 'ungrounded' dropped
    const summary = result.output as { pruned_citations: number; dropped_members: number };
    expect(summary.pruned_citations).toBe(1);
    expect(summary.dropped_members).toBe(1);
  });

  it('fails closed when the span-set artifact is missing upstream', async () => {
    const result = await makeGroundingPolicyNode(spec)(
      ctx(GROUND_STEP, [candidateArtifact(goodNotes())]),
    );
    expect(result.status).toBe('terminal_failure');
    if (result.status === 'completed' || result.status === 'paused') return;
    expect(result.error?.code).toBe('grounding_spans_missing');
  });
});

const VALIDATE_STEP: WorkflowStepSpec = {
  id: 'validate',
  capability: 'validation',
  operation: 'check',
  depends_on: ['ground'],
  input: { grounded_notes: 'notetool.notes' },
  output_artifact_refs: ['validation.result'],
};

describe('validation node (declared required paths; last producer wins)', () => {
  const spec = parseFixture();

  it('validates the LAST notetool.notes producer (the grounded doc, not the raw candidate)', async () => {
    const badCandidate = candidateArtifact({ headline: 'x' }); // would FAIL validation
    const groundedDoc: ArtifactRef = {
      id: 'ground:notetool.notes:grounded',
      kind: 'notetool.notes',
      source_node_id: 'ground',
      value: { headline: 'Sync', body: 'Body.', findings: [] },
    };
    const result = await makeShapeValidationNode(spec)(
      ctx(VALIDATE_STEP, [badCandidate, groundedDoc]),
    );
    expect(result.status).toBe('completed'); // proves the GROUNDED (later) doc was validated
  });

  it('a missing declared required path is TERMINAL (validation_failed)', async () => {
    const doc: ArtifactRef = {
      id: 'ground:notetool.notes:grounded',
      kind: 'notetool.notes',
      source_node_id: 'ground',
      value: { headline: 'Sync', findings: [] }, // body missing
    };
    const result = await makeShapeValidationNode(spec)(ctx(VALIDATE_STEP, [doc]));
    expect(result.status).toBe('terminal_failure');
    if (result.status === 'completed' || result.status === 'paused') return;
    expect(result.error?.code).toBe('validation_failed');
    expect(result.error?.message).toMatch(/body/);
  });
});

const PERSIST_STEP: WorkflowStepSpec = {
  id: 'persist',
  capability: 'artifact',
  operation: 'persist',
  depends_on: ['validate'],
  input: { grounded_notes: 'notetool.notes' },
  output_artifact_refs: ['artifact.handle'],
};

describe('persist node (collection rows + typed handle)', () => {
  const spec = parseFixture();

  function groundedArtifact(): ArtifactRef {
    return {
      id: 'ground:notetool.notes:grounded',
      kind: 'notetool.notes',
      source_node_id: 'ground',
      value: {
        headline: 'Sync',
        body: 'Body.',
        findings: [{ text: 'grounded', evidence: ['sp-1'], evidence_span_ids: ['sp-1'] }],
      },
    };
  }

  function persistNode(db: FakeHandlerDb, store = new InMemoryArtifactStore()) {
    return makeArtifactPersistNode({
      spec,
      db,
      tenantId: TENANT,
      collectionStores: new Map([['note_artifacts', { store: 'note_artifacts' }]]),
      artifactStore: store,
    });
  }

  it('persists the collection rows AND the typed artifact handle', async () => {
    const db = new FakeHandlerDb();
    const store = new InMemoryArtifactStore();
    const result = await persistNode(db, store)(ctx(PERSIST_STEP, [groundedArtifact()]));
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;

    const rows = db.rows('note_artifacts');
    expect(rows.map((r) => r.artifact_ref).sort()).toEqual([
      'tenant-a:s1:digest:0',
      'tenant-a:s1:finding:0',
    ]);
    const handleArtifact = result.artifact_refs?.find((a) => a.kind === 'artifact.handle');
    const handle = handleArtifact?.value as { id: string; kind: string; namespace: string };
    expect(handle.kind).toBe('notetool.notes');
    expect(handle.namespace).toBe('notetool'); // the product id, from the declaration
    expect(await store.read(handle.id)).toBeTruthy(); // the typed artifact actually resolves
  });

  it('fails closed when the trigger event carries no scope id', async () => {
    const db = new FakeHandlerDb();
    const result = await persistNode(db)(
      ctx(PERSIST_STEP, [groundedArtifact()], event({ not_the_scope: 'x' })),
    );
    expect(result.status).toBe('terminal_failure');
    if (result.status === 'completed' || result.status === 'paused') return;
    expect(result.error?.code).toBe('persist_scope_missing');
    expect(db.rows('note_artifacts')).toHaveLength(0); // nothing persisted
  });
});
