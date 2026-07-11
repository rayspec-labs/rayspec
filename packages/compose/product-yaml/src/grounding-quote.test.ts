/**
 * OPT-IN quote-text grounding — the NON-BLIND, fail-the-fix proof over the REAL acme-notes product.
 *
 * acme-notes now declares one quote-checked kind (`excerpt`, `provenance.quote_field: quote`) alongside
 * four id-only kinds and `grounding.on_unquoted_claim: prune`. This drives the REAL grounding node
 * (`makeGroundingPolicyNode`) + the REAL materializer over the REAL parsed spec with a candidate that
 * plants three probes:
 *   1. a `excerpt` whose `quote` IS a verbatim token-run subset of its cited span  → PERSISTS (grounded);
 *   2. a `excerpt` citing a REAL span id but with FABRICATED wording               → CAUGHT (pruned→dropped);
 *   3. an `item` (NO quote_field) whose text merely paraphrases the source          → PERSISTS (default-off).
 *
 * Fail-the-fix (the whole point): the invented excerpt must NOT survive. Reverting the quote check in
 * grounding.ts/materialize.ts turns probe 2 GREEN (it persists) — the assertion below then fails. The
 * default-off control at the end strips the quote_field declaration and shows probe 2 survives, proving
 * the DECLARATION is what arms the check (a product that does not opt in is unaffected).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ArtifactRef,
  CapabilityInvocationContext,
  WorkflowInputEvent,
  WorkflowSpec,
  WorkflowStepSpec,
} from '@rayspec/foundation';
import { type ProductSpec, parseProductSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { applyGroundingPolicy, buildCollectionRows } from './materialize.js';
import { makeGroundingPolicyNode } from './nodes.js';

const here = dirname(fileURLToPath(import.meta.url));
const ACME_YAML = resolve(here, '../../../../examples/acme-notes/acme-notes.product.yaml');
const QUOTE_FIXTURE = resolve(
  here,
  '../../../../examples/acme-notes/fixtures/acme-notes-quote-session.json',
);

interface QuoteFixture {
  session_id: string;
  closed_spans: Array<{ id: string; text: string }>;
  candidate_notes: Record<string, unknown>;
  expected: {
    excerpt_verbatim_quote: string;
    excerpt_invented_quote: string;
    item_paraphrase_text: string;
  };
}

function acmeSpec(): ProductSpec {
  const parsed = parseProductSpec(readFileSync(ACME_YAML, 'utf8'));
  if (!parsed.ok) throw new Error(`acme-notes must parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}
const FIXTURE = JSON.parse(readFileSync(QUOTE_FIXTURE, 'utf8')) as QuoteFixture;

const closedMap = (): Map<string, string> =>
  new Map(FIXTURE.closed_spans.map((s) => [s.id, s.text]));

const WORKFLOW: WorkflowSpec = {
  id: 'process_session',
  tier: 'A',
  status: 'runtime_foundation',
  trigger: { event: 'audio_input.finalized_session' },
  idempotency_key: 'unused',
  steps: [],
};

const GROUND_STEP: WorkflowStepSpec = {
  id: 'ground',
  capability: 'grounding',
  operation: 'check',
  depends_on: ['extract'],
  input: { notes: 'acme.notes', spans: 'stt.transcript_span' },
  output_artifact_refs: ['grounding.result', 'acme.notes'],
};

function upstreamArtifacts(candidate = FIXTURE.candidate_notes): ArtifactRef[] {
  return [
    {
      id: 'a:spans',
      kind: 'stt.transcript_span',
      source_node_id: 'transcribe',
      value: FIXTURE.closed_spans.map((s, i) => ({
        id: s.id,
        track: 'mic',
        speaker_role: 'local',
        start: i * 5,
        end: (i + 1) * 5,
        text: s.text,
      })),
    },
    {
      // The agent node emits an ENVELOPE ({ ref, kind, schema_ref, content }) — reproduce it faithfully.
      id: 'agent_artifact:process_session:extract:acme.notes',
      kind: 'acme.notes',
      source_node_id: 'extract',
      value: {
        ref: 'acme.notes',
        kind: 'note_candidate',
        schema_ref: 'acme.notes',
        materialization_target: 'typed_artifact_ref',
        content: candidate,
      },
    },
  ];
}

function ctx(artifacts: ArtifactRef[]): CapabilityInvocationContext {
  const ev: WorkflowInputEvent = {
    id: 'tenant-a:acme-quote-sess-1',
    type: 'audio_input.finalized_session',
    occurred_at: '2026-07-10T00:00:00.000Z',
    payload: { session_id: FIXTURE.session_id },
  };
  return {
    workflow: WORKFLOW,
    step: GROUND_STEP,
    input_event: ev,
    input: GROUND_STEP.input ?? {},
    journal: {
      workflow_run_id: 'run-1',
      workflow_id: WORKFLOW.id,
      idempotency_key: 'k',
      input_event: ev,
      status: 'running',
      node_states: [],
      artifact_refs: [],
      attempts: 0,
      created_at: '2026-07-10T00:00:00.000Z',
      updated_at: '2026-07-10T00:00:00.000Z',
    },
    artifacts,
  };
}

describe('opt-in quote-text grounding over the REAL acme-notes product', () => {
  it('the grounding NODE persists a verbatim excerpt, DROPS a fabricated one, keeps a no-quote_field paraphrase', async () => {
    const result = await makeGroundingPolicyNode(acmeSpec())(ctx(upstreamArtifacts()));
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;

    const grounded = result.artifact_refs?.find((a) => a.kind === 'acme.notes')?.value as {
      excerpts: Array<{ quote: string }>;
      items: Array<{ text: string }>;
    };
    // Probe 1 kept (verbatim), probe 2 gone (fabricated) — the quote text is the discriminator.
    expect(grounded.excerpts.map((e) => e.quote)).toEqual([
      FIXTURE.expected.excerpt_verbatim_quote,
    ]);
    // Probe 3 kept — the item declares NO quote_field, so its paraphrase is never quote-checked.
    expect(grounded.items.map((i) => i.text)).toEqual([FIXTURE.expected.item_paraphrase_text]);

    const summary = result.output as { unsupported_claims: number; dropped_members: number };
    expect(summary.unsupported_claims).toBe(1); // exactly the invented excerpt
    expect(summary.dropped_members).toBe(1); // it was pruned to empty evidence → dropped
  });

  it('the persistence bridge: the fabricated excerpt yields NO collection row; the verbatim one does', () => {
    const spec = acmeSpec();
    const app = applyGroundingPolicy(spec, FIXTURE.candidate_notes, 'acme.notes', closedMap());
    expect(app.unsupportedClaims).toBe(1);

    const rows = buildCollectionRows(app.kinds, {
      tenantId: 'tenant-a',
      scopeColumn: 'session_id',
      scopeId: FIXTURE.session_id,
      collectionStores: new Map([['note_artifacts', { store: 'note_artifacts' }]]),
    });
    const excerptRows = rows.filter((r) => r.kind === 'excerpt');
    // Only the verbatim excerpt reaches a persisted row; the fabricated one never does.
    expect(excerptRows).toHaveLength(1);
    expect((excerptRows[0]?.row.payload as { quote: string }).quote).toBe(
      FIXTURE.expected.excerpt_verbatim_quote,
    );
    // The no-quote_field item still persists (default-off).
    expect(rows.some((r) => r.kind === 'item')).toBe(true);
  });

  it('FAIL-CLOSED: a span-set WITHOUT text, under a declared quote_field, halts the node (never silent id-only)', async () => {
    // Same closed ids, but the spans carry no `text`. Because acme declares a quote_field, the node
    // MUST refuse rather than silently degrade the quote check to id-only.
    const textlessSpans: ArtifactRef[] = [
      {
        id: 'a:spans',
        kind: 'stt.transcript_span',
        source_node_id: 'transcribe',
        value: FIXTURE.closed_spans.map((s) => ({ id: s.id, track: 'mic' })), // no `text`
      },
      upstreamArtifacts()[1] as ArtifactRef, // the candidate envelope, unchanged
    ];
    const result = await makeGroundingPolicyNode(acmeSpec())(ctx(textlessSpans));
    expect(result.status).not.toBe('completed');
    expect(result.error?.code).toBe('grounding_span_text_missing');
  });

  it('DEFAULT-OFF control: with quote_field STRIPPED, the SAME fabricated excerpt survives (the declaration arms the check)', () => {
    const spec = acmeSpec();
    // Remove the excerpt kind's quote_field — the product no longer opts in.
    const noQuote: ProductSpec = {
      ...spec,
      artifacts: spec.artifacts.map((a) =>
        a.kind === 'excerpt' && a.provenance
          ? { ...a, provenance: { ...a.provenance, quote_field: undefined } }
          : a,
      ),
    };
    const app = applyGroundingPolicy(noQuote, FIXTURE.candidate_notes, 'acme.notes', closedMap());
    expect(app.unsupportedClaims).toBe(0); // no quote check ran
    const excerpts = app.kinds.find((k) => k.artifact.kind === 'excerpt');
    // Both excerpts survive (id-only grounding) — including the one the armed check would have dropped.
    expect(excerpts?.members.map((m) => (m.payload as { quote: string }).quote)).toEqual([
      FIXTURE.expected.excerpt_verbatim_quote,
      FIXTURE.expected.excerpt_invented_quote,
    ]);
  });
});
