import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProductYamlWorkflow } from './compiler.js';
import { createCapabilityInventoryFromManifests } from './inventory.js';
import { parseProductYaml } from './loader.js';
import { type ProductYamlBridgeInput, ProductYamlWorkflowBridgeError } from './types.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');

// The capability-inventory manifests are neutral, self-contained fixtures co-located with this test:
// they carry only the contract/operation/event ids the inventory projects, and reproduce the exact
// CapabilityInventory the compiler validates the acme-notes reference product against.
function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, '__fixtures__', name), 'utf8')) as T;
}

function acmeProductYaml(): ProductYamlBridgeInput {
  return parseProductYaml(
    readFileSync(resolve(repoRoot, 'examples/acme-notes/acme-notes.product.yaml'), 'utf8'),
  );
}

function inventory() {
  return createCapabilityInventoryFromManifests(
    readFixture('capability-contracts.json'),
    readFixture('stt-contracts.json'),
    readFixture('grounding-artifact-nodes.json'),
  );
}

function expectBridgeError(fn: () => unknown, code: ProductYamlWorkflowBridgeError['code']): void {
  try {
    fn();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProductYamlWorkflowBridgeError);
    expect((error as ProductYamlWorkflowBridgeError).code).toBe(code);
  }
}

describe('Product YAML workflow bridge', () => {
  it('fails closed for invalid YAML structure', () => {
    expectBridgeError(() => parseProductYaml('version: "1.0"\n  : :'), 'invalid_yaml_structure');
  });

  it('compiles acme-notes audio_input.finalized_session to a grounding and artifact WorkflowSpec', () => {
    const spec = compileProductYamlWorkflow(acmeProductYaml(), {
      workflowId: 'process_session',
      capabilityInventory: inventory(),
      idempotencyKey: 'session:acme-dual:finalized',
    });

    expect(spec).toEqual({
      id: 'process_session',
      tier: 'A',
      status: 'foundation_only',
      trigger: { event: 'audio_input.finalized_session' },
      idempotency_key: 'session:acme-dual:finalized',
      steps: [
        {
          id: 'transcribe',
          capability: 'stt',
          operation: 'transcribe_session',
          input: { finalized_session: 'audio_input.finalized_session' },
          input_from_event: true,
          output_artifact_refs: ['stt.transcript', 'stt.transcript_span'],
          retry_policy: { max_attempts: 3 },
          timeout_policy: { timeout_ms: 30_000 },
          acceptance_boundary: 'validation_node',
        },
        {
          id: 'extract',
          capability: 'agent',
          operation: 'note_extractor',
          depends_on: ['transcribe'],
          input: { transcript: 'stt.transcript', spans: 'stt.transcript_span' },
          output_artifact_refs: ['acme.notes'],
          artifact_inputs: [
            {
              name: 'transcript',
              ref: 'stt.transcript',
              kind: 'transcript',
              required: true,
              source_step_id: 'transcribe',
            },
            {
              name: 'spans',
              ref: 'stt.transcript_span',
              kind: 'transcript_span_set',
              required: true,
              source_step_id: 'transcribe',
            },
          ],
          artifact_outputs: [
            {
              name: 'candidate_notes',
              ref: 'acme.notes',
              kind: 'note_candidate',
              schema_ref: 'acme.notes',
              materialization_target: 'typed_artifact_ref',
            },
          ],
          agent_extraction: {
            intent: 'note_extraction',
            required_output_shape: {
              schema_ref: 'acme.notes',
              additional_properties: false,
              required_paths: [
                'headline',
                'detail',
                'output_language',
                'items',
                'pointers',
                'queries',
                'labels',
                'mentions',
              ],
            },
            acceptance_boundary: {
              type: 'validation_node',
              requires: ['grounding.check', 'validation.check'],
              closed_source_artifacts: ['stt.transcript_span'],
            },
            materialization: {
              target: 'typed_artifact_ref',
              persist_via: 'artifact.persist',
              handle_ref: 'artifact.handle',
            },
          },
          retry_policy: { max_attempts: 1 },
          timeout_policy: { timeout_ms: 30_000 },
          acceptance_boundary: 'validation_node',
        },
        {
          id: 'ground',
          capability: 'grounding',
          operation: 'check',
          depends_on: ['extract'],
          input: {
            candidate_notes: 'acme.notes',
            spans: 'stt.transcript_span',
          },
          output_artifact_refs: ['grounding.result', 'acme.notes'],
          retry_policy: { max_attempts: 1 },
          timeout_policy: { timeout_ms: 30_000 },
          acceptance_boundary: 'validation_node',
        },
        {
          id: 'validate',
          capability: 'validation',
          operation: 'check',
          depends_on: ['ground'],
          input: { grounded_notes: 'acme.notes' },
          output_artifact_refs: ['validation.result'],
          retry_policy: { max_attempts: 1 },
          timeout_policy: { timeout_ms: 30_000 },
          acceptance_boundary: 'validation_node',
        },
        {
          id: 'persist',
          capability: 'artifact',
          operation: 'persist',
          depends_on: ['validate'],
          input: { grounded_notes: 'acme.notes' },
          output_artifact_refs: ['artifact.handle'],
          retry_policy: { max_attempts: 1 },
          timeout_policy: { timeout_ms: 30_000 },
          acceptance_boundary: 'validation_node',
        },
      ],
    });
    expect(JSON.stringify(spec).toLowerCase()).not.toContain('deepgram');
  });

  it('preserves dependencies, output artifact refs, and validation boundaries', () => {
    const spec = compileProductYamlWorkflow(acmeProductYaml(), {
      workflowId: 'process_session',
      capabilityInventory: inventory(),
    });

    expect(spec.steps.map((step) => [step.id, step.depends_on])).toEqual([
      ['transcribe', undefined],
      ['extract', ['transcribe']],
      ['ground', ['extract']],
      ['validate', ['ground']],
      ['persist', ['validate']],
    ]);
    expect(spec.steps.find((step) => step.id === 'persist')?.output_artifact_refs).toEqual([
      'artifact.handle',
    ]);
    expect(spec.steps.filter((step) => step.capability === 'validation')).toEqual([
      expect.objectContaining({ id: 'validate', acceptance_boundary: 'validation_node' }),
    ]);
    expect(spec.steps.find((step) => step.id === 'ground')).toEqual(
      expect.objectContaining({ acceptance_boundary: 'validation_node' }),
    );
  });

  it('keeps agent extraction outputs as typed artifact refs through downstream nodes', () => {
    const spec = compileProductYamlWorkflow(acmeProductYaml(), {
      workflowId: 'process_session',
      capabilityInventory: inventory(),
    });
    const extract = spec.steps.find((step) => step.id === 'extract');
    const ground = spec.steps.find((step) => step.id === 'ground');
    const validate = spec.steps.find((step) => step.id === 'validate');
    const persist = spec.steps.find((step) => step.id === 'persist');

    expect(extract?.artifact_inputs?.map((artifact) => artifact.ref)).toEqual([
      'stt.transcript',
      'stt.transcript_span',
    ]);
    expect(extract?.artifact_outputs).toEqual([
      expect.objectContaining({
        name: 'candidate_notes',
        ref: 'acme.notes',
        kind: 'note_candidate',
        materialization_target: 'typed_artifact_ref',
      }),
    ]);
    expect(extract?.agent_extraction).toEqual(
      expect.objectContaining({
        intent: 'note_extraction',
        materialization: {
          target: 'typed_artifact_ref',
          persist_via: 'artifact.persist',
          handle_ref: 'artifact.handle',
        },
      }),
    );
    expect(ground?.input).toEqual({
      candidate_notes: 'acme.notes',
      spans: 'stt.transcript_span',
    });
    expect(validate?.input).toEqual({ grounded_notes: 'acme.notes' });
    expect(persist?.input).toEqual({ grounded_notes: 'acme.notes' });
  });

  it('compiles artifact.read and fails closed for unknown operations', () => {
    const productYaml: ProductYamlBridgeInput = {
      workflows: [
        {
          id: 'read_artifact',
          trigger: { capability: 'artifact', event: 'handle_ready', scope: 'artifact' },
          steps: [
            {
              id: 'read',
              type: 'artifact_read',
              use: 'artifact.read',
              inputs: { handle: 'artifact.handle' },
              outputs: { artifact: 'artifact' },
            },
          ],
        },
      ],
    };

    expect(
      compileProductYamlWorkflow(productYaml, {
        workflowId: 'read_artifact',
        capabilityInventory: inventory(),
      }).steps[0],
    ).toEqual({
      id: 'read',
      capability: 'artifact',
      operation: 'read',
      input: { handle: 'artifact.handle' },
      input_from_event: true,
      output_artifact_refs: ['artifact'],
      retry_policy: { max_attempts: 1 },
      timeout_policy: { timeout_ms: 30_000 },
      acceptance_boundary: 'validation_node',
    });

    const unknownOperationYaml = structuredClone(productYaml);
    const step = unknownOperationYaml.workflows?.[0]?.steps?.[0];
    if (!step) throw new Error('Missing artifact_read test step.');
    step.use = 'artifact.delete';

    expectBridgeError(
      () =>
        compileProductYamlWorkflow(unknownOperationYaml, {
          workflowId: 'read_artifact',
          capabilityInventory: inventory(),
        }),
      'unknown_capability',
    );
  });

  it('fails closed for unknown capability operations', () => {
    const productYaml = acmeProductYaml();
    const step = productYaml.workflows?.[0]?.steps?.[0];
    if (!step) throw new Error('Missing acme-notes workflow step fixture.');
    step.use = 'stt.unknown_operation';

    expectBridgeError(
      () =>
        compileProductYamlWorkflow(productYaml, {
          workflowId: 'process_session',
          capabilityInventory: inventory(),
        }),
      'unknown_capability',
    );
  });

  it('fails closed for unknown agent operations', () => {
    const productYaml = acmeProductYaml();
    const step = productYaml.workflows?.[0]?.steps?.find((candidate) => candidate.id === 'extract');
    if (!step) throw new Error('Missing acme-notes agent workflow step fixture.');
    step.use = 'agent.unknown_extractor';

    expectBridgeError(
      () =>
        compileProductYamlWorkflow(productYaml, {
          workflowId: 'process_session',
          capabilityInventory: inventory(),
        }),
      'unknown_capability',
    );
  });

  it('fails closed for prompt, model, and provider fields in agent declarations', () => {
    for (const [key, code] of [
      ['prompt', 'prompt_execution_claim'],
      ['model_policy', 'provider_native_payload_leak'],
      ['provider', 'provider_native_payload_leak'],
    ] as const) {
      const productYaml = acmeProductYaml();
      const agent = productYaml.extractors?.[0] as Record<string, unknown> | undefined;
      if (!agent) throw new Error('Missing acme-notes extractor fixture.');
      agent[key] = 'forbidden';

      expectBridgeError(
        () =>
          compileProductYamlWorkflow(productYaml, {
            workflowId: 'process_session',
            capabilityInventory: inventory(),
          }),
        code,
      );
    }
  });

  it('fails closed when declarative agent artifact refs do not match workflow refs', () => {
    const productYaml = acmeProductYaml();
    const agent = productYaml.extractors?.[0];
    if (!agent?.extraction?.output_artifacts?.[0]) {
      throw new Error('Missing acme-notes extractor extraction fixture.');
    }
    agent.extraction.output_artifacts[0].ref = 'acme.different_artifact';

    expectBridgeError(
      () =>
        compileProductYamlWorkflow(productYaml, {
          workflowId: 'process_session',
          capabilityInventory: inventory(),
        }),
      'agent_extraction_contract',
    );
  });

  it('fails closed for unknown dependencies', () => {
    const productYaml = acmeProductYaml();
    const step = productYaml.workflows?.[0]?.steps?.[0];
    if (!step) throw new Error('Missing acme-notes workflow step fixture.');
    step.depends_on = ['ghost_step'];

    expectBridgeError(
      () =>
        compileProductYamlWorkflow(productYaml, {
          workflowId: 'process_session',
          capabilityInventory: inventory(),
        }),
      'unknown_dependency',
    );
  });

  it('fails closed for an unknown or typo step type', () => {
    const productYaml = acmeProductYaml();
    const step = productYaml.workflows?.[0]?.steps?.find((candidate) => candidate.id === 'persist');
    if (!step) throw new Error('Missing acme-notes persist step fixture.');
    step.type = 'artifact-persist'; // hyphen typo of artifact_persist — previously silently dropped

    expectBridgeError(
      () =>
        compileProductYamlWorkflow(productYaml, {
          workflowId: 'process_session',
          capabilityInventory: inventory(),
        }),
      'unknown_step_type',
    );
  });

  it('fails closed for an unknown trigger event', () => {
    const productYaml = acmeProductYaml();
    const workflow = productYaml.workflows?.[0];
    if (!workflow?.trigger) throw new Error('Missing acme-notes workflow trigger fixture.');
    workflow.trigger.event = 'sesion_finalized'; // typo -> audio_input.sesion_finalized (undeclared)

    expectBridgeError(
      () =>
        compileProductYamlWorkflow(productYaml, {
          workflowId: 'process_session',
          capabilityInventory: inventory(),
        }),
      'unknown_trigger_event',
    );
  });

  it('rejects provider-native workflow payloads and product-owned module paths', () => {
    const providerLeak = acmeProductYaml();
    const providerStep = providerLeak.workflows?.[0]?.steps?.[0];
    if (!providerStep) throw new Error('Missing acme-notes workflow step fixture.');
    providerStep.inputs = { native_payload: 'deepgram' };

    expectBridgeError(
      () =>
        compileProductYamlWorkflow(providerLeak, {
          workflowId: 'process_session',
          capabilityInventory: inventory(),
        }),
      'provider_native_payload_leak',
    );

    const handlerLeak = acmeProductYaml();
    const handlerStep = handlerLeak.workflows?.[0]?.steps?.[0];
    if (!handlerStep) throw new Error('Missing acme-notes workflow step fixture.');
    (handlerStep as Record<string, unknown>).module_path = 'packs/product/handlers/transcribe.ts';

    expectBridgeError(
      () =>
        compileProductYamlWorkflow(handlerLeak, {
          workflowId: 'process_session',
          capabilityInventory: inventory(),
        }),
      'product_owned_handler_path',
    );
  });
});

// ── the store steps ─────────────────────────────────────────────

/** A minimal store-step bridge input (audio-triggered — a real trigger event). */
function storeBridgeInput(): ProductYamlBridgeInput {
  return {
    version: '1.0',
    product: { id: 'fieldlog', name: 'Fieldlog' },
    workflows: [
      {
        id: 'log_session',
        trigger: { capability: 'audio_input', event: 'session_finalized', scope: 'session' },
        steps: [
          {
            id: 'catalog',
            type: 'store_read',
            use: 'store.read',
            store: 'equipment_catalog',
            filter: { item_code: { const: 'mic_kit' } },
            limit: 10,
            outputs: { catalog: 'fieldlog.catalog_rows' },
          },
          {
            id: 'log',
            type: 'store_write',
            use: 'store.write',
            store: 'session_log',
            depends_on: ['catalog'],
            values: {
              entry_ref: { event: 'session_id' },
              catalog_snapshot: { artifact: 'fieldlog.catalog_rows' },
            },
            outputs: { log_row: 'fieldlog.log_row' },
          },
        ],
      },
    ],
  } as ProductYamlBridgeInput;
}

function storeInventory() {
  return {
    operations: new Set(['store.read', 'store.write']),
    contracts: new Set<string>(),
    events: new Set(['audio_input.finalized_session']),
  };
}

describe('Product YAML workflow bridge — store_read/store_write', () => {
  it('compiles the two store step types onto capability=store nodes; the declaration-only fields do NOT leak into the compiled spec', () => {
    const spec = compileProductYamlWorkflow(storeBridgeInput(), {
      workflowId: 'log_session',
      capabilityInventory: storeInventory(),
      idempotencyKey: 'session:log_session:finalized',
    });
    // EXACT compiled shape: the engine dispatches `${capability}.${operation}` → store.read /
    // store.write; the store/filter/values/limit DECLARATION fields stay in the ProductSpec (the
    // node re-reads them by workflow id + step id) — a leaked field here would be an unreviewed
    // compiled-contract widening (asserted by toEqual, which rejects extra keys).
    expect(spec.steps).toEqual([
      {
        id: 'catalog',
        capability: 'store',
        operation: 'read',
        input_from_event: true,
        output_artifact_refs: ['fieldlog.catalog_rows'],
        retry_policy: { max_attempts: 1 },
        timeout_policy: { timeout_ms: 30_000 },
        acceptance_boundary: 'validation_node',
      },
      {
        id: 'log',
        capability: 'store',
        operation: 'write',
        depends_on: ['catalog'],
        output_artifact_refs: ['fieldlog.log_row', 'fieldlog.catalog_rows'].slice(0, 1),
        retry_policy: { max_attempts: 1 },
        timeout_policy: { timeout_ms: 30_000 },
        acceptance_boundary: 'validation_node',
      },
    ]);
  });

  it('the use discipline is EXACT per type: store_read → store.read, store_write → store.write', () => {
    const wrongRead = storeBridgeInput();
    const readStep = wrongRead.workflows?.[0]?.steps?.[0];
    if (!readStep) throw new Error('missing store_read step fixture');
    readStep.use = 'store.scan';
    expectBridgeError(
      () =>
        compileProductYamlWorkflow(wrongRead, {
          workflowId: 'log_session',
          capabilityInventory: storeInventory(),
        }),
      'unknown_capability',
    );

    const wrongWrite = storeBridgeInput();
    const writeStep = wrongWrite.workflows?.[0]?.steps?.[1];
    if (!writeStep) throw new Error('missing store_write step fixture');
    writeStep.use = 'store.read'; // a real op — but the WRONG one for store_write
    expectBridgeError(
      () =>
        compileProductYamlWorkflow(wrongWrite, {
          workflowId: 'log_session',
          capabilityInventory: storeInventory(),
        }),
      'unknown_capability',
    );
  });

  it('store steps are compilable ONLY when the composition inventories the store ops (fail-closed otherwise)', () => {
    expectBridgeError(
      () =>
        compileProductYamlWorkflow(storeBridgeInput(), {
          workflowId: 'log_session',
          capabilityInventory: {
            operations: new Set<string>(), // a composition that wires NO store runtime
            contracts: new Set<string>(),
            events: new Set(['audio_input.finalized_session']),
          },
        }),
      'unknown_capability',
    );
  });

  it('the neutrality walk covers the NEW declaration fields (a provider name inside values fails closed)', () => {
    const leak = storeBridgeInput();
    const writeStep = leak.workflows?.[0]?.steps?.[1];
    if (!writeStep) throw new Error('missing store_write step fixture');
    (writeStep as Record<string, unknown>).values = { entry_ref: { const: 'deepgram' } };
    expectBridgeError(
      () =>
        compileProductYamlWorkflow(leak, {
          workflowId: 'log_session',
          capabilityInventory: storeInventory(),
        }),
      'provider_native_payload_leak',
    );
  });
});
