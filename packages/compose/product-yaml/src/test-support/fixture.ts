/**
 * A product-NEUTRAL Product-YAML fixture for the composition tests — proves the
 * composition is declaration-driven, not product-shaped. Parsed through the REAL `parseProductSpec`
 * so every test document is exactly what the production parser admits.
 */

import type { WorkflowInputEvent, WorkflowSpec } from '@rayspec/foundation';
import type { ProductSpec, StoreSpec } from '@rayspec/spec';
import { parseProductSpec } from '@rayspec/spec';
import type { WorkflowEnqueuer } from '@rayspec/workflow-durable';

export const NOTETOOL_YAML = `
version: "1.0"
product:
  id: notetool
  name: Notetool
  description: A neutral note-taking product used to test the Product-YAML composition.
requires:
  capabilities: [audio_input, media_playback, stt, grounding, validation, artifact]
capabilities:
  - id: audio_input
    tier: B
    status: available
    contracts: [audio_input.finalized_session]
  - id: media_playback
    tier: B
    status: available
    contracts: [media_playback.token]
  - id: stt
    tier: B
    status: available
    contracts: [stt.transcribe_session, stt.transcript, stt.transcript_span]
  - id: grounding
    tier: B
    status: available
    contracts: [grounding.check, grounding.result]
  - id: validation
    tier: B
    status: available
    contracts: [validation.check, validation.result]
  - id: artifact
    tier: B
    status: available
    contracts: [artifact.persist, artifact.read, artifact.handle]
artifacts:
  - kind: digest
    contract: notetool.digest
    scope: session
    collection: note_artifacts
    provenance:
      source: stt.transcript_span
      evidence_field: evidence_span_ids
      required: false
    lifecycle:
      persist: true
      preserve_human_edits: true
      reconcile_stale_rows: true
  - kind: finding
    contract: notetool.finding
    scope: session
    collection: note_artifacts
    provenance:
      source: stt.transcript_span
      evidence_field: evidence
      required: true
    lifecycle:
      persist: true
      preserve_human_edits: true
      reconcile_stale_rows: true
contracts:
  stt.transcript_span:
    type: object
    properties:
      id: { type: string }
      track: { type: string }
      text: { type: string }
    required: [id, track, text]
  notetool.finding:
    type: object
    properties:
      text: { type: string }
      evidence: { type: array, items: { type: string } }
    required: [text, evidence]
  notetool.digest:
    type: object
    properties:
      headline: { type: string }
      body: { type: string }
    required: [headline, body]
  notetool.notes:
    type: object
    additional_properties: false
    properties:
      headline: { type: string }
      body: { type: string }
      findings:
        type: array
        items: { ref: notetool.finding }
    required: [headline, body, findings]
  notetool.token_response:
    type: object
    properties:
      url: { type: string }
    required: [url]
extractors:
  - id: note_extractor
    purpose: Extract grounded findings from transcript spans.
    extraction:
      intent: note_extraction
      input_artifacts:
        - name: transcript
          ref: stt.transcript
          kind: transcript
          required: true
          source_step_id: transcribe
        - name: spans
          ref: stt.transcript_span
          kind: span_set
          required: true
          source_step_id: transcribe
      output_artifacts:
        - name: notes
          ref: notetool.notes
          kind: notes_candidate
          schema_ref: notetool.notes
          materialization_target: typed_artifact_ref
      required_output_shape:
        schema_ref: notetool.notes
        additional_properties: false
        required_paths: [headline, body, findings]
      acceptance_boundary:
        type: validation_node
        requires: [grounding.check, validation.check]
        closed_source_artifacts: [stt.transcript_span]
      materialization:
        target: typed_artifact_ref
        persist_via: artifact.persist
        handle_ref: artifact.handle
workflows:
  - id: process_recording
    trigger:
      capability: audio_input
      event: session_finalized
      scope: session
    steps:
      - id: transcribe
        type: capability
        use: stt.transcribe_session
        inputs:
          finalized_session: audio_input.finalized_session
        outputs:
          transcript: stt.transcript
          spans: stt.transcript_span
      - id: extract
        type: agent
        use: agent.note_extractor
        depends_on: [transcribe]
        inputs:
          transcript: stt.transcript
          spans: stt.transcript_span
        outputs:
          notes: notetool.notes
      - id: ground
        type: validation
        use: grounding.check
        depends_on: [extract]
        inputs:
          notes: notetool.notes
          spans: stt.transcript_span
        outputs:
          grounding_result: grounding.result
          grounded_notes: notetool.notes
      - id: validate
        type: validation
        use: validation.check
        depends_on: [ground]
        inputs:
          grounded_notes: notetool.notes
        outputs:
          validation_result: validation.result
      - id: persist
        type: artifact_persist
        use: artifact.persist
        depends_on: [validate]
        inputs:
          grounded_notes: notetool.notes
        outputs:
          artifact_handle: artifact.handle
grounding:
  require_source_spans: true
  source_span_contract: stt.transcript_span
  on_invalid_citation: prune
  on_empty_evidence: drop
  attribution_policy:
    tracks:
      mic: local
      system: remote
views:
  - id: session_playback_token
    route:
      method: POST
      path: "/sessions/{session_id}/{track}/play-token"
    auth: bearer_tenant
    source:
      kind: capability
      ref: media_playback.token
    absent_state: not_ready_409
    response_contract: notetool.token_response
`;

/**
 * The DECLARED-STORES fixture: a neutral, audio-triggered product whose
 * workflow is store_read → store_write over two DECLARED 0.2 stores, plus a store-sourced view over
 * the written store. Exercises the whole new vocabulary through the REAL parser; mountable by
 * `composeProductDeploy` (audio trigger — a real trigger event).
 */
export const FIELDLOG_YAML = `
version: "1.0"
product:
  id: fieldlog
  name: Fieldlog
  description: A neutral field-recording log product used to test the declared-store composition.
requires:
  capabilities: [audio_input]
capabilities:
  - id: audio_input
    tier: B
    status: available
    contracts: [audio_input.finalized_session]
contracts:
  fieldlog.catalog_rows:
    type: array
    items: { type: object }
  fieldlog.log_row:
    type: object
  fieldlog.log_response:
    type: object
    additional_properties: false
    properties:
      session_id: { type: string }
      status: { type: [string, "null"] }
    required: [session_id, status]
stores:
  - name: equipment_catalog
    description: Reference data the workflow reads (seeded by the deployment).
    columns:
      - { name: item_code, type: text }
      - { name: label, type: text, nullable: true }
    key: [item_code]
  - name: session_log
    columns:
      - { name: entry_ref, type: text }
      - { name: session_id, type: text }
      - { name: status, type: text }
      - { name: catalog_snapshot, type: jsonb, nullable: true }
    key: [entry_ref]
workflows:
  - id: log_session
    trigger:
      capability: audio_input
      event: session_finalized
      scope: session
    steps:
      - id: catalog
        type: store_read
        use: store.read
        store: equipment_catalog
        filter:
          item_code: { const: mic_kit }
        limit: 10
        outputs:
          catalog: fieldlog.catalog_rows
      - id: log
        type: store_write
        use: store.write
        store: session_log
        depends_on: [catalog]
        values:
          entry_ref: { event: session_id }
          session_id: { event: session_id }
          status: { const: processed }
          catalog_snapshot: { artifact: fieldlog.catalog_rows }
        outputs:
          log_row: fieldlog.log_row
views:
  - id: session_log_view
    route:
      method: GET
      path: "/field-sessions/{session_id}/log"
    auth: bearer_tenant
    params:
      session_id: { in: path, shape: safe_id }
    source: { kind: store, ref: session_log }
    read:
      mode: single
      filter:
        session_id: { param: session_id }
      shape:
        fields:
          session_id: { kind: param, param: session_id }
          status: { kind: column, column: status, type: string }
      absent:
        fields:
          session_id: { kind: param, param: session_id }
          status: { kind: const, value: null }
    absent_state: empty_200
    response_contract: fieldlog.log_response
`;

/**
 * The SUBMIT-INGRESS fixture: a neutral product whose workflow triggers on
 * the record_input capability's `record_submitted` event (the DEFAULT join — no alias) and
 * whose ONLY business step is a store_write sourcing BOTH an envelope key (`record_id`) AND a
 * MERGED top-level business field (`title`) from the trigger payload — the payload contract,
 * exercised through the REAL parser. Mountable by `composeProductDeploy` iff the record capability
 * is declared (the conditional mount).
 */
export const INTAKE_YAML = `
version: "1.0"
product:
  id: intake
  name: Intake
  description: A neutral submit-ingress product used to test the record_input composition.
requires:
  capabilities: [record_input]
capabilities:
  - id: record_input
    tier: B
    status: available
    contracts: [record_input.record_submitted]
contracts:
  intake.request_row:
    type: object
  intake.status_response:
    type: object
    additional_properties: false
    properties:
      record_id: { type: string }
      title: { type: [string, "null"] }
      status: { type: [string, "null"] }
    required: [record_id, title, status]
stores:
  - name: intake_requests
    columns:
      - { name: request_ref, type: text }
      - { name: record_id, type: text }
      - { name: title, type: text }
      - { name: status, type: text }
    key: [request_ref]
workflows:
  - id: log_request
    trigger:
      capability: record_input
      event: record_submitted
      scope: record
    steps:
      - id: log
        type: store_write
        use: store.write
        store: intake_requests
        values:
          request_ref: { event: record_id }
          record_id: { event: record_id }
          title: { event: title }
          status: { const: received }
        outputs:
          row: intake.request_row
views:
  - id: request_status_view
    route:
      method: GET
      path: "/intake/{record_id}/status"
    auth: bearer_tenant
    params:
      record_id: { in: path, shape: safe_id }
    source: { kind: store, ref: intake_requests }
    read:
      mode: single
      filter:
        record_id: { param: record_id }
      shape:
        fields:
          record_id: { kind: param, param: record_id }
          title: { kind: column, column: title, type: string }
          status: { kind: column, column: status, type: string }
      absent:
        fields:
          record_id: { kind: param, param: record_id }
          title: { kind: const, value: null }
          status: { kind: const, value: null }
    absent_state: empty_200
    response_contract: intake.status_response
`;

/**
 * A neutral submit-ingress product that ALSO declares an OPTIONAL input-normalize step on its
 * record_input capability: a submitted record is transformed by the declared `field_normalizer` agent
 * (conforming to the `intake.normalized_record` output contract) BEFORE persist. Exercises the
 * conditional normalize wiring through the REAL parser + composition.
 */
export const NORMALIZE_INTAKE_YAML = `
version: "1.0"
product:
  id: intake_norm
  name: Intake Normalize
  description: A neutral submit-ingress product with a declared input-normalize step.
requires:
  capabilities: [record_input]
capabilities:
  - id: record_input
    tier: B
    status: available
    contracts: [record_input.record_submitted]
    input_normalize:
      agent: field_normalizer
      output_contract: intake.normalized_record
contracts:
  intake.request_row:
    type: object
  intake.normalized_record:
    type: object
stores:
  - name: intake_requests
    columns:
      - { name: request_ref, type: text }
      - { name: record_id, type: text }
      - { name: title, type: text }
    key: [request_ref]
workflows:
  - id: log_request
    trigger:
      capability: record_input
      event: record_submitted
      scope: record
    steps:
      - id: log
        type: store_write
        use: store.write
        store: intake_requests
        values:
          request_ref: { event: record_id }
          record_id: { event: record_id }
          title: { event: title }
        outputs:
          row: intake.request_row
`;

/**
 * A doc declaring `media_playback` ONLY (no `audio_input`). `declaresAudio` returns true for
 * EITHER audio capability id, so this pins the PARTIAL-audio decision: the audio capability is a COHESIVE
 * PAIR — declaring either half mounts the WHOLE audio surface (both `audio_sessions`/`audio_tracks`
 * stores + all five audio_input/media_playback routes/handlers). This mirrors `FIELDLOG_YAML`
 * (audio_input-only), which likewise mounts the media_playback routes it did not name; rejecting a
 * partial declaration would ALSO break that legitimate record-without-playback shape, so mount-both is
 * the sound, product-free choice (the runtime realizes the two ids as ONE `mountAudioCapability`).
 */
export const MEDIA_PLAYBACK_ONLY_YAML = `
version: "1.0"
product:
  id: playbackonly
  name: PlaybackOnly
  description: A doc declaring media_playback ONLY (no audio_input) — pins the S4 partial-audio mount as all-or-nothing.
requires:
  capabilities: [media_playback]
capabilities:
  - id: media_playback
    tier: B
    status: available
    contracts: [media_playback.token]
contracts:
  playbackonly.row:
    type: object
stores:
  - name: clips
    columns:
      - { name: clip_ref, type: text }
      - { name: label, type: text, nullable: true }
    key: [clip_ref]
`;

/**
 * A neutral FILE-ingest product (file_input only — no audio, no record, no stt, no agents): the
 * conditional-mount fixture. One declared store fed by a deterministic store_write off the
 * `file_submitted` trigger — the minimal doc that proves the file capability mounts (stores +
 * BOTH routes + trigger vocabulary) and NOTHING else rides in.
 */
export const FILE_INTAKE_YAML = `
version: "1.0"
product:
  id: fileintake
  name: FileIntake
  description: A neutral file-ingest product used to test the file_input composition.
requires:
  capabilities: [file_input]
capabilities:
  - id: file_input
    tier: B
    status: available
    contracts: [file_input.file_submitted]
contracts:
  fileintake.row:
    type: object
stores:
  - name: ingested_files
    columns:
      - { name: ingest_ref, type: text }
      - { name: file_id, type: text }
      - { name: sha256, type: text }
      - { name: size_bytes, type: integer }
      - { name: status, type: text }
    key: [ingest_ref]
workflows:
  - id: log_file
    trigger:
      capability: file_input
      event: file_submitted
      scope: file
    steps:
      - id: log
        type: store_write
        use: store.write
        store: ingested_files
        values:
          ingest_ref: { event: file_id }
          file_id: { event: file_id }
          sha256: { event: sha256 }
          size_bytes: { event: size_bytes }
          status: { const: stored }
        outputs:
          row: fileintake.row
`;

/**
 * The PARSE fixture: `FILE_INTAKE_YAML` extended with the `file_input.parse_text`
 * capability step feeding the extracted text into the declared store via an `{artifact}` value —
 * the minimal upload→parse→store pipeline (still no audio/record/stt/agents).
 */
export const FILE_PARSE_YAML = `
version: "1.0"
product:
  id: fileintake
  name: FileIntake
  description: A neutral file-ingest product used to test the file_input parse composition.
requires:
  capabilities: [file_input]
capabilities:
  - id: file_input
    tier: B
    status: available
    contracts: [file_input.file_submitted]
contracts:
  fileintake.row:
    type: object
  fileintake.extracted_text:
    type: string
stores:
  - name: ingested_files
    columns:
      - { name: ingest_ref, type: text }
      - { name: file_id, type: text }
      - { name: extracted_text, type: text }
      - { name: status, type: text }
    key: [ingest_ref]
workflows:
  - id: log_file
    trigger:
      capability: file_input
      event: file_submitted
      scope: file
    steps:
      - id: parse
        type: capability
        use: file_input.parse_text
        outputs:
          text: fileintake.extracted_text
      - id: log
        type: store_write
        use: store.write
        store: ingested_files
        depends_on: [parse]
        values:
          ingest_ref: { event: file_id }
          file_id: { event: file_id }
          extracted_text: { artifact: fileintake.extracted_text }
          status: { const: parsed }
        outputs:
          row: fileintake.row
`;

/**
 * A neutral CONVERSATION-ingress product (conversation_input only — no audio/record/file/stt/
 * agents): the conditional-mount fixture. One declared store fed by a deterministic
 * store_write off the `turn_submitted` trigger — the minimal doc that proves the conversation
 * capability mounts (BOTH capability-owned stores + BOTH routes + the trigger vocabulary) and
 * NOTHING else rides in. The store_write sources the whole payload class: envelope keys
 * (`turn_ref`, ids), a NUMERIC payload field (`turn_seq` — integer column), and the bounded
 * message TEXT (the message-in-payload contract consumed through the existing
 * `{ event: <field> }` path).
 */
export const CONVERSATION_INTAKE_YAML = `
version: "1.0"
product:
  id: convintake
  name: ConvIntake
  description: A neutral conversational-ingress product used to test the conversation_input composition.
requires:
  capabilities: [conversation_input]
capabilities:
  - id: conversation_input
    tier: B
    status: available
    contracts: [conversation_input.turn_submitted]
contracts:
  convintake.row:
    type: object
stores:
  - name: turn_log
    columns:
      - { name: log_ref, type: text }
      - { name: conversation_id, type: text }
      - { name: message_id, type: text }
      - { name: turn_seq, type: integer }
      - { name: message, type: text }
      - { name: status, type: text }
    key: [log_ref]
workflows:
  - id: log_turn
    trigger:
      capability: conversation_input
      event: turn_submitted
      scope: conversation
    steps:
      - id: log
        type: store_write
        use: store.write
        store: turn_log
        values:
          log_ref: { event: turn_ref }
          conversation_id: { event: conversation_id }
          message_id: { event: message_id }
          turn_seq: { event: turn_seq }
          message: { event: message }
          status: { const: received }
        outputs:
          row: convintake.row
`;

/** Parse a (possibly mutated) fixture through the REAL parser; throws on invalidity. */
export function parseFixture(yaml: string = NOTETOOL_YAML): ProductSpec {
  const res = parseProductSpec(yaml);
  if (!res.ok) {
    throw new Error(`fixture must parse:\n${JSON.stringify(res.errors, null, 2)}`);
  }
  return res.value;
}

/** The deployment's Tier-A product stores (transcript sink + artifact collection). */
export function fixtureStores(): StoreSpec[] {
  return [
    {
      name: 'track_transcripts',
      columns: [
        { name: 'session_id', type: 'text', nullable: false, unique: false },
        { name: 'track', type: 'text', nullable: false, unique: false },
        { name: 'track_ref', type: 'text', nullable: false, unique: true },
        { name: 'status', type: 'text', nullable: false, unique: false },
        { name: 'model', type: 'text', nullable: true, unique: false },
        { name: 'detected_language', type: 'text', nullable: true, unique: false },
        { name: 'full_text', type: 'text', nullable: true, unique: false },
        { name: 'word_count', type: 'integer', nullable: true, unique: false },
        { name: 'payload', type: 'jsonb', nullable: true, unique: false },
      ],
      foreignKeys: [],
    },
    {
      name: 'note_artifacts',
      columns: [
        { name: 'session_id', type: 'text', nullable: false, unique: false },
        { name: 'artifact_kind', type: 'text', nullable: false, unique: false },
        { name: 'payload', type: 'jsonb', nullable: false, unique: false },
        { name: 'human_edited', type: 'boolean', nullable: false, unique: false },
        { name: 'dismissed', type: 'boolean', nullable: false, unique: false },
        { name: 'artifact_ref', type: 'text', nullable: false, unique: true },
      ],
      foreignKeys: [],
    },
  ];
}

/** A recording `WorkflowEnqueuer` stub (compose never executes; it only wires). */
export class RecordingEnqueuer implements WorkflowEnqueuer {
  readonly calls: Array<{
    tenantId: string;
    workflow: WorkflowSpec;
    event: WorkflowInputEvent;
    idempotencyKey: string;
  }> = [];

  async enqueueWorkflowRun(input: {
    tenantId: string;
    workflow: WorkflowSpec;
    event: WorkflowInputEvent;
    idempotencyKey: string;
  }): Promise<{ workflowRunId: string; deduped: boolean }> {
    this.calls.push(input);
    return { workflowRunId: `run:${input.idempotencyKey}`, deduped: false };
  }
}
