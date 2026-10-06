/**
 * regression proof — the product-yaml STT node driving the REAL `DeepgramSttAdapter`
 * (NOT the `FakeSttAdapter`) through a chunk-based media resolver + a STUBBED HTTP transport.
 *
 * WHY this exists: the composed deployment's STT node (`makeSttTranscribeSessionNode`) builds each
 * per-track request as `{ session_id, track }` and NEVER sets `media_artifact_ref`; the production
 * `BlobRemuxSttMediaResolver` resolves audio from the uploaded CHUNKS keyed on `(session_id, track)`
 * and ignores `media_artifact_ref` entirely. A blanket precondition in the real adapter that
 * hard-required `media_artifact_ref` therefore failed EVERY fresh recording with
 * `stt_not_ready: "transcription failed: No finalized media artifact reference to transcribe."`
 * BEFORE the resolver/provider was reached — the exact production STT-resolver bug. The fake STT
 * adapter keys on `(session_id, track)` and never checks the ref, so the fake-only boot-e2e was blind
 * to this node↔real-adapter contract mismatch.
 *
 * This test closes that gap: it drives the node through the REAL adapter + a resolver that reads a
 * couple of fake chunks (no `media_artifact_ref`), stubbing the Deepgram `/v1/listen` call, and proves
 * a FRESH session transcribes to persisted transcript rows. RED-FIRST: on the pre-fix adapter this
 * reproduces the prod `stt_not_ready` failure; after the fix it completes. No live Deepgram key.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DeepgramSttAdapter } from '@rayspec/adapter-deepgram';
import { chunkKey } from '@rayspec/audio-runtime';
import type {
  ArtifactRef,
  CapabilityInvocationContext,
  WorkflowInputEvent,
  WorkflowSpec,
  WorkflowStepSpec,
} from '@rayspec/foundation';
import { InMemoryArtifactStore } from '@rayspec/grounding-runtime';
import type { ProductSpec } from '@rayspec/spec';
import {
  type SttFinalizedTrackRef,
  SttMediaResolutionError,
  type SttMediaResolver,
  type SttMediaSource,
} from '@rayspec/stt-port';
import { describe, expect, it, vi } from 'vitest';
import { sttSpanGranularity } from './capability-stores.js';
import {
  makeArtifactPersistNode,
  makeGroundingPolicyNode,
  makeSttTranscribeSessionNode,
} from './nodes.js';
import { FakeHandlerDb } from './test-support/fake-handler-db.js';
import { NOTETOOL_YAML, parseFixture } from './test-support/fixture.js';

const TENANT = 'tenant-a';
const SESSION = 's1';

/** A canned Deepgram `/v1/listen` JSON body — the shape the real adapter's mapper consumes. */
const CANNED_DEEPGRAM_JSON = JSON.stringify({
  metadata: {
    request_id: '00000000-0000-4000-8000-0000000000d9',
    duration: 1.6,
    channels: 1,
    models: ['nova-2'],
  },
  results: {
    channels: [
      {
        detected_language: 'en',
        alternatives: [
          {
            transcript: 'We shipped the baseline today.',
            confidence: 0.98,
            words: [
              { word: 'we', start: 0.0, end: 0.2, confidence: 0.97, punctuated_word: 'We' },
              {
                word: 'shipped',
                start: 0.2,
                end: 0.6,
                confidence: 0.98,
                punctuated_word: 'shipped',
              },
              { word: 'the', start: 0.6, end: 0.7, confidence: 0.99, punctuated_word: 'the' },
              {
                word: 'baseline',
                start: 0.7,
                end: 1.2,
                confidence: 0.96,
                punctuated_word: 'baseline',
              },
              { word: 'today', start: 1.2, end: 1.6, confidence: 0.97, punctuated_word: 'today.' },
            ],
            paragraphs: {
              transcript: 'We shipped the baseline today.',
              paragraphs: [
                {
                  start: 0.0,
                  end: 1.6,
                  num_words: 5,
                  sentences: [{ text: 'We shipped the baseline today.', start: 0.0, end: 1.6 }],
                },
              ],
            },
          },
        ],
      },
    ],
  },
});

/**
 * A chunk-based media resolver that mirrors the production `BlobRemuxSttMediaResolver` contract:
 * reads a track's contiguous chunks (0,1,2,…) from an in-memory blob store keyed on
 * `(session_id, track)`, IGNORES `media_artifact_ref`, and fail-closes with `SttMediaResolutionError`
 * when there are zero chunks. (The production resolver remuxes via ffmpeg; here the bytes are opaque
 * because the HTTP transport is stubbed — the contract under test is "keyed on the pair, no ref".)
 */
class InMemoryChunkResolver implements SttMediaResolver {
  constructor(private readonly blob: Map<string, Uint8Array>) {}

  async resolve(ref: SttFinalizedTrackRef): Promise<SttMediaSource> {
    const parts: Uint8Array[] = [];
    for (let i = 0; ; i += 1) {
      const chunk = this.blob.get(chunkKey(ref.session_id, ref.track, i));
      if (!chunk) break;
      parts.push(chunk);
    }
    if (parts.length === 0) {
      throw new SttMediaResolutionError(
        `no chunks for ${ref.session_id}/${ref.track} (fail-closed).`,
      );
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      bytes.set(p, offset);
      offset += p.length;
    }
    return { bytes, contentType: 'audio/ogg' };
  }
}

const WORKFLOW: WorkflowSpec = {
  id: 'process_recording',
  tier: 'A',
  status: 'runtime_foundation',
  trigger: { event: 'audio_input.finalized_session' },
  idempotency_key: 'unused',
  steps: [],
};

const STT_STEP: WorkflowStepSpec = {
  id: 'transcribe',
  capability: 'stt',
  operation: 'transcribe_session',
  input_from_event: true,
  output_artifact_refs: ['stt.transcript', 'stt.transcript_span'],
};

function event(): WorkflowInputEvent {
  return {
    id: `${TENANT}:${SESSION}`,
    type: 'audio_input.finalized_session',
    occurred_at: '2026-07-02T00:00:00.000Z',
    payload: { session_id: SESSION },
  };
}

function ctx(
  step: WorkflowStepSpec = STT_STEP,
  artifacts: ArtifactRef[] = [],
): CapabilityInvocationContext {
  const ev = event();
  return {
    workflow: WORKFLOW,
    step,
    input_event: ev,
    input: ev.payload,
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

function sealTrack(db: FakeHandlerDb, track: string): void {
  db.rows('audio_tracks').push({
    session_id: SESSION,
    track,
    status: 'completed',
    track_ref: `${TENANT}:${SESSION}:${track}`,
  });
}

describe('STT node ↔ REAL DeepgramSttAdapter (chunk resolver, stubbed transport)', () => {
  const spec: ProductSpec = parseFixture();

  it('transcribes a FRESH session with NO media_artifact_ref to persisted rows (fake-only boot-e2e missed this)', async () => {
    const db = new FakeHandlerDb();
    sealTrack(db, 'mic');

    // A couple of fake chunks for the mic track — keyed exactly as the production resolver reads them.
    const blob = new Map<string, Uint8Array>([
      [chunkKey(SESSION, 'mic', 0), new Uint8Array([0x4f, 0x67, 0x67, 0x53])], // "OggS"
      [chunkKey(SESSION, 'mic', 1), new Uint8Array([0x01, 0x02, 0x03, 0x04])],
    ]);

    // The REAL adapter + a stubbed Deepgram transport (no live key, no network).
    const fetchImpl = vi.fn(async () => new Response(CANNED_DEEPGRAM_JSON, { status: 200 }));
    const adapter = new DeepgramSttAdapter({
      resolver: new InMemoryChunkResolver(blob),
      apiKey: 'test-key-not-a-real-secret',
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => '2026-07-02T00:00:00.000Z',
    });

    const node = makeSttTranscribeSessionNode({
      spec,
      adapter,
      db,
      tenantId: TENANT,
      transcriptStore: 'track_transcripts',
    });

    const result = await node(ctx());

    // RED-FIRST: pre-fix the real adapter short-circuits on the absent `media_artifact_ref` and the
    // node reports `stt_not_ready: "transcription failed: No finalized media artifact reference to
    // transcribe."` (the prod error). Surface that verbatim so the red run reads like production.
    if (result.status !== 'completed') {
      throw new Error(
        `STT node did not complete: ${result.error?.code} — ${result.error?.message}`,
      );
    }

    // The provider WAS reached (the resolver produced bytes from the chunks; no premature not_ready).
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The fresh recording's transcript row persisted (the read surface the views serve).
    const rows = db.rows('track_transcripts');
    expect(rows.map((r) => [r.track, r.status, r.word_count])).toEqual([['mic', 'completed', 5]]);
    expect(rows[0]?.full_text).toBe('We shipped the baseline today.');
    expect(rows[0]?.track_ref).toBe(`${TENANT}:${SESSION}:mic`);
    const payload = rows[0]?.payload as { words: Array<{ word: string }> };
    // The punctuated-word persist rule survives the real adapter path (punctuated form persisted).
    expect(payload.words.map((w) => w.word)).toEqual([
      'We',
      'shipped',
      'the',
      'baseline',
      'today.',
    ]);

    // The span-set artifact emitted under the declared grounding contract.
    const spanArtifact = result.artifact_refs?.find((a) => a.kind === 'stt.transcript_span');
    expect(spanArtifact).toBeTruthy();
  });

  it('fail-closes to stt_not_ready when the resolver has NO chunks (genuinely unfinalized media)', async () => {
    // The resolver — not a blanket adapter guard — is the fail-closed authority: zero chunks throws
    // SttMediaResolutionError → the adapter maps it to `not_ready` → the node terminal-fails. Proves
    // removing the adapter precondition did NOT weaken the genuine not-ready fail-closed.
    const db = new FakeHandlerDb();
    sealTrack(db, 'mic');
    const fetchImpl = vi.fn(async () => new Response(CANNED_DEEPGRAM_JSON, { status: 200 }));
    const adapter = new DeepgramSttAdapter({
      resolver: new InMemoryChunkResolver(new Map()), // no chunks at all
      apiKey: 'test-key-not-a-real-secret',
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const node = makeSttTranscribeSessionNode({
      spec,
      adapter,
      db,
      tenantId: TENANT,
      transcriptStore: 'track_transcripts',
    });

    const result = await node(ctx());

    expect(result.status).toBe('terminal_failure');
    if (result.status === 'completed' || result.status === 'paused') return;
    expect(result.error?.code).toBe('stt_not_ready');
    expect(fetchImpl).not.toHaveBeenCalled(); // never reached the provider
    expect(db.rows('track_transcripts')).toHaveLength(0); // nothing persisted
  });
});

// ── span granularity, from the document to the stored evidence ───────────────────────────────────

/**
 * A recorded-shape response with two paragraphs of three and two sentences (the provider adapter's
 * own fixture, read as a file — this suite never imports the adapter's source).
 */
const MULTI_SENTENCE_JSON = readFileSync(
  fileURLToPath(
    new URL(
      '../../../adapters/deepgram/src/fixtures/deepgram/multi-sentence-paragraphs.json',
      import.meta.url,
    ),
  ),
  'utf8',
);

const STT_CONTRACTS =
  '    contracts: [stt.transcribe_session, stt.transcript, stt.transcript_span]\n';
const SENTENCE_YAML = NOTETOOL_YAML.replace(
  STT_CONTRACTS,
  `${STT_CONTRACTS}    span_granularity: sentence\n`,
);

const GROUND_STEP: WorkflowStepSpec = {
  id: 'ground',
  capability: 'grounding',
  operation: 'check',
  depends_on: ['extract'],
  input: { notes: 'notetool.notes', spans: 'stt.transcript_span' },
  output_artifact_refs: ['grounding.result', 'notetool.notes'],
};

const PERSIST_STEP: WorkflowStepSpec = {
  id: 'persist',
  capability: 'artifact',
  operation: 'persist',
  depends_on: ['validate'],
  input: { grounded_notes: 'notetool.notes' },
  output_artifact_refs: ['artifact.handle'],
};

/** What an extractor returns when it draws two claims from two sentences of one paragraph. */
function candidate(): ArtifactRef {
  return {
    id: 'agent_artifact:process_recording:extract:notetool.notes',
    kind: 'notetool.notes',
    source_node_id: 'extract',
    value: {
      ref: 'notetool.notes',
      kind: 'notes_candidate',
      schema_ref: 'notetool.notes',
      materialization_target: 'typed_artifact_ref',
      content: {
        headline: 'Rollout',
        body: 'The rollout order.',
        findings: [
          { text: 'The upload service goes first.', evidence: ['mic:s1'] },
          { text: 'Billing follows a week later.', evidence: ['mic:s2'] },
        ],
      },
    },
  };
}

/**
 * Transcribe (real adapter built from the document's setting, stubbed transport) → ground the
 * candidate against the spans the node emitted → persist. Returns what a reader ends up with.
 */
async function runChain(yaml: string) {
  const spec: ProductSpec = parseFixture(yaml);
  const db = new FakeHandlerDb();
  sealTrack(db, 'mic');
  const blob = new Map<string, Uint8Array>([
    [chunkKey(SESSION, 'mic', 0), new Uint8Array([0x4f, 0x67, 0x67, 0x53])],
  ]);
  const fetchImpl = vi.fn(async () => new Response(MULTI_SENTENCE_JSON, { status: 200 }));
  const granularity = sttSpanGranularity(spec);
  const adapter = new DeepgramSttAdapter({
    resolver: new InMemoryChunkResolver(blob),
    apiKey: 'test-key-not-a-real-secret',
    env: {},
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => '2026-07-02T00:00:00.000Z',
    ...(granularity === 'sentence' ? { spanGranularity: granularity } : {}),
  });

  const transcribed = await makeSttTranscribeSessionNode({
    spec,
    adapter,
    db,
    tenantId: TENANT,
    transcriptStore: 'track_transcripts',
  })(ctx());
  if (transcribed.status !== 'completed') {
    throw new Error(`STT node did not complete: ${transcribed.error?.message}`);
  }
  const sttArtifacts = transcribed.artifact_refs ?? [];
  const spans = sttArtifacts.find((a) => a.kind === 'stt.transcript_span')?.value as Array<{
    id: string;
    text: string;
  }>;

  const grounded = await makeGroundingPolicyNode(spec)(
    ctx(GROUND_STEP, [...sttArtifacts, candidate()]),
  );
  if (grounded.status !== 'completed') {
    throw new Error(`grounding did not complete: ${grounded.error?.message}`);
  }
  const groundedDoc = grounded.artifact_refs?.find((a) => a.kind === 'notetool.notes');
  if (!groundedDoc) throw new Error('grounding emitted no grounded document');

  const persisted = await makeArtifactPersistNode({
    spec,
    db,
    tenantId: TENANT,
    collectionStores: new Map([['note_artifacts', { store: 'note_artifacts' }]]),
    artifactStore: new InMemoryArtifactStore(),
  })(ctx(PERSIST_STEP, [groundedDoc]));
  if (persisted.status !== 'completed') {
    throw new Error(`persist did not complete: ${persisted.error?.message}`);
  }

  const transcriptPayload = db.rows('track_transcripts')[0]?.payload as {
    segments: Array<{ start: number; end: number; text: string }>;
    span_granularity?: string;
  };
  const findings = db
    .rows('note_artifacts')
    .filter((r) => String(r.artifact_ref).includes(':finding:'))
    .map((r) => r.payload as { text: string; evidence_span_ids: string[] });
  return {
    spans,
    transcriptPayload,
    findings,
    summary: grounded.output as { pruned_citations: number; dropped_members: number },
  };
}

describe('span granularity, from the document to the stored evidence', () => {
  it('sentence: two claims from one paragraph keep two different citations', async () => {
    const { spans, transcriptPayload, findings, summary } = await runChain(SENTENCE_YAML);

    expect(spans.map((s) => s.id)).toEqual(['mic:s0', 'mic:s1', 'mic:s2', 'mic:s3', 'mic:s4']);
    expect(summary).toMatchObject({ pruned_citations: 0, dropped_members: 0 });
    expect(findings.map((f) => [f.text, f.evidence_span_ids])).toEqual([
      ['The upload service goes first.', ['mic:s1']],
      ['Billing follows a week later.', ['mic:s2']],
    ]);

    // The transcript row a reader resolves a citation against: `mic:s<N>` is `segments[N]`.
    expect(transcriptPayload.segments).toEqual([
      { start: 0.2, end: 2.1, text: 'We agreed on the rollout order.' },
      { start: 2.4, end: 4.3, text: 'The upload service goes first.' },
      { start: 4.6, end: 6.9, text: 'Billing follows a week later.' },
      { start: 8.5, end: 10.0, text: 'Who owns the migration?' },
      { start: 10.4, end: 11.6, text: 'I will take it.' },
    ]);
    for (const finding of findings) {
      const index = Number(finding.evidence_span_ids[0]?.split(':s')[1]);
      expect(transcriptPayload.segments[index]?.text).toBe(finding.text);
      expect(spans[index]?.text).toBe(finding.text);
    }
    expect(transcriptPayload.span_granularity).toBe('sentence');
  });

  it('default: the same response has one span per paragraph, so the second citation is not in the set', async () => {
    const { spans, transcriptPayload, findings, summary } = await runChain(NOTETOOL_YAML);

    expect(spans.map((s) => s.id)).toEqual(['mic:s0', 'mic:s1']);
    // `mic:s1` now names the whole second paragraph and `mic:s2` names nothing.
    expect(summary).toMatchObject({ pruned_citations: 1, dropped_members: 1 });
    expect(findings.map((f) => [f.text, f.evidence_span_ids])).toEqual([
      ['The upload service goes first.', ['mic:s1']],
    ]);
    expect(transcriptPayload.segments).toEqual([
      {
        start: 0.2,
        end: 6.9,
        text: 'We agreed on the rollout order. The upload service goes first. Billing follows a week later.',
      },
      { start: 8.5, end: 11.6, text: 'Who owns the migration? I will take it.' },
    ]);
    expect(Object.keys(transcriptPayload)).toEqual(['confidence', 'duration', 'words', 'segments']);
  });
});
