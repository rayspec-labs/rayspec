import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ArtifactRef,
  CapabilityInvocationContext,
  WorkflowInputEvent,
  WorkflowSpec,
} from '@rayspec/foundation';
import { CapabilityRegistry, InMemoryWorkflowRuntime } from '@rayspec/foundation';
import {
  compileProductYamlWorkflow,
  createCapabilityInventoryFromManifests,
  parseProductYaml,
} from '@rayspec/product-yaml-workflow-bridge';
import { describe, expect, it } from 'vitest';
import { createAgentRuntimeHandler } from './agent-node.js';
import { InMemoryAgentHandlerRegistry } from './fake-handler-registry.js';
import { fakeAgentExtractionHandler } from './fakes.js';
import type { AgentRuntimeOutputArtifact, FakeAgentHandler } from './types.js';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const fixedNow = '2026-07-02T00:00:00.000Z';
// This suite compiles the neutral acme-notes reference product to exercise the agent-runtime
// contract surface with a real compiled agent step.
const AGENT_OPERATION = 'agent.note_extractor';

// Neutral, self-contained capability-inventory manifests co-located with this test (only the
// contract/operation/event ids the inventory projects) — they reproduce the exact CapabilityInventory
// the acme-notes reference product compiles against.
function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, '__fixtures__', name), 'utf8')) as T;
}

function acmeWorkflow(): WorkflowSpec {
  const inventory = createCapabilityInventoryFromManifests(
    readFixture('capability-contracts.json'),
    readFixture('stt-contracts.json'),
    readFixture('grounding-artifact-nodes.json'),
  );
  return compileProductYamlWorkflow(
    parseProductYaml(
      readFileSync(resolve(repoRoot, 'examples/acme-notes/acme-notes.product.yaml'), 'utf8'),
    ),
    {
      workflowId: 'process_session',
      capabilityInventory: inventory,
      idempotencyKey: 'session:acme-dual:finalized',
    },
  );
}

function agentWorkflow(overrides: Partial<WorkflowSpec['steps'][number]> = {}): WorkflowSpec {
  const spec = acmeWorkflow();
  const extract = spec.steps.find((step) => step.id === 'extract');
  if (!extract) throw new Error('Missing extract step.');
  return {
    ...spec,
    id: 'agent-runtime-contracts',
    trigger: { event: 'agent_runtime.test' },
    steps: [
      {
        id: 'seed_artifacts',
        capability: 'test',
        operation: 'seed_artifacts',
        input_from_event: true,
      },
      {
        ...extract,
        depends_on: ['seed_artifacts'],
        ...overrides,
      },
    ],
  };
}

function event(): WorkflowInputEvent {
  return {
    id: 'evt-agent-runtime',
    type: 'agent_runtime.test',
    occurred_at: fixedNow,
    payload: {
      transcript: { full_text: 'Use deterministic fake handlers.' },
      spans: [{ id: 'span-1' }, { id: 'span-2' }],
    },
  };
}

function registry(handler: FakeAgentHandler = fakeAgentExtractionHandler): CapabilityRegistry {
  const fakeHandlers = new InMemoryAgentHandlerRegistry();
  fakeHandlers.register(AGENT_OPERATION, handler);
  const capabilityRegistry = new CapabilityRegistry();
  capabilityRegistry.register('test.seed_artifacts', seedArtifactHandler);
  capabilityRegistry.register(
    AGENT_OPERATION,
    createAgentRuntimeHandler({ handlers: fakeHandlers }),
  );
  return capabilityRegistry;
}

function seedArtifactHandler({ input, step }: CapabilityInvocationContext) {
  return {
    status: 'completed' as const,
    artifact_refs: [
      {
        id: 'stt.transcript.seeded',
        kind: 'stt.transcript',
        source_node_id: step.id,
        value: input.transcript,
      },
      {
        id: 'stt.transcript_span.seeded',
        kind: 'stt.transcript_span',
        source_node_id: step.id,
        value: input.spans,
      },
    ] satisfies ArtifactRef[],
  };
}

function validOutput(input: Parameters<FakeAgentHandler>[0]): AgentRuntimeOutputArtifact {
  const output = input.artifact_outputs[0];
  if (!output) throw new Error('Missing output contract.');
  return {
    ...output,
    value: {
      headline: 'Deterministic digest',
      detail: 'Fake extraction from typed inputs.',
      output_language: 'en',
      items: [],
      pointers: [],
      queries: [],
      labels: [],
      mentions: [],
    },
  };
}

async function run(
  workflow: WorkflowSpec,
  capabilityRegistry = registry(),
): Promise<Awaited<ReturnType<InMemoryWorkflowRuntime['execute']>>> {
  const runtime = new InMemoryWorkflowRuntime({
    registry: capabilityRegistry,
    clock: () => fixedNow,
  });
  return runtime.execute(workflow, event());
}

describe('@rayspec/agent-runtime', () => {
  it('materializes a typed artifact output through a deterministic fake handler', async () => {
    const journal = await run(agentWorkflow());

    expect(journal.status).toBe('completed');
    expect(journal.artifact_refs.map((artifact) => artifact.kind)).toContain('acme.notes');
    expect(journal.artifact_refs.find((artifact) => artifact.kind === 'acme.notes')).toMatchObject({
      id: 'agent_artifact:agent-runtime-contracts:extract:acme.notes',
      source_node_id: 'extract',
      value: {
        ref: 'acme.notes',
        schema_ref: 'acme.notes',
        materialization_target: 'typed_artifact_ref',
      },
    });
    expect(JSON.stringify(journal).toLowerCase()).not.toMatch(/deepgram|openai|anthropic|prompt/);
  });

  it('fails closed when agent_extraction metadata is missing', async () => {
    const journal = await run(agentWorkflow({ agent_extraction: undefined }));

    expect(journal.status).toBe('terminal_failure');
    expect(journal.node_states[1]?.error?.code).toBe('agent_extraction_missing');
  });

  it('fails closed when a required input artifact is missing', async () => {
    const workflow = agentWorkflow({
      artifact_inputs: [
        {
          name: 'transcript',
          ref: 'stt.missing_transcript',
          kind: 'transcript',
          required: true,
          source_step_id: 'seed_artifacts',
        },
      ],
    });

    const journal = await run(workflow);

    expect(journal.status).toBe('terminal_failure');
    expect(journal.node_states[1]?.error?.code).toBe('agent_input_artifact_missing');
  });

  it('fails closed when a fake handler is not registered', async () => {
    const fakeHandlers = new InMemoryAgentHandlerRegistry();
    const capabilityRegistry = new CapabilityRegistry();
    capabilityRegistry.register('test.seed_artifacts', seedArtifactHandler);
    capabilityRegistry.register(
      AGENT_OPERATION,
      createAgentRuntimeHandler({ handlers: fakeHandlers }),
    );

    const journal = await run(agentWorkflow(), capabilityRegistry);

    expect(journal.status).toBe('terminal_failure');
    expect(journal.node_states[1]?.error?.code).toBe('agent_handler_not_registered');
  });

  it('fails closed when output shape does not match the contract', async () => {
    const journal = await run(
      agentWorkflow(),
      registry((input) => [
        {
          ...(input.artifact_outputs[0] as AgentRuntimeOutputArtifact),
          value: { summary: 'missing required shape' },
        },
      ]),
    );

    expect(journal.status).toBe('terminal_failure');
    expect(journal.node_states[1]?.error?.code).toBe('agent_output_shape_mismatch');
  });

  // FIX-RT1 (test-honesty correction): the previous version of this test smuggled the leak
  // tokens into the artifact `value` (the runtime DATA payload) and asserted they were
  // rejected. That encoded a data-content filter, which re-breaks product neutrality (a real
  // transcript may name a provider; a product may declare a field named `body`). The guard is
  // a tripwire for the artifact DECLARATION surface, so the leak is now placed on the artifact
  // envelope (a provider-native/prompt sibling of `value`, or a product path in a declared
  // field) — never inside the data payload.
  it('rejects provider-native, prompt/model, and product-owned leaks on the OUTPUT declaration surface', async () => {
    for (const [patch, code] of [
      [{ backend: 'openai' }, 'agent_provider_native_leak'],
      [{ system_prompt: 'you are a summarizer' }, 'agent_prompt_or_model_leak'],
      [
        { materialization_target: 'packs/product/handlers/extract.ts' },
        'agent_product_owned_path_leak',
      ],
    ] as const) {
      const journal = await run(
        agentWorkflow(),
        registry((input) => [{ ...validOutput(input), ...patch }]),
      );

      expect(journal.status).toBe('terminal_failure');
      expect(journal.node_states[1]?.error?.code).toBe(code);
    }
  });

  it('deduplicates deterministic replay by workflow id and idempotency key', async () => {
    let invocations = 0;
    const runtime = new InMemoryWorkflowRuntime({
      registry: registry((input, context) => {
        invocations += 1;
        return fakeAgentExtractionHandler(input, context);
      }),
      clock: () => fixedNow,
    });
    const workflow = agentWorkflow();

    const first = await runtime.execute(workflow, event());
    const second = await runtime.execute(workflow, event());

    expect(first).toEqual(second);
    expect(invocations).toBe(1);
  });
});

// Product neutrality: the runtime must enforce the DECLARED
// required_output_shape, never a hardcoded product shape. These tests drive a support
// case classifier agent whose declared shape is fully product-agnostic.
describe('@rayspec/agent-runtime declared output contract (product-neutral)', () => {
  function supportEvent(): WorkflowInputEvent {
    return {
      id: 'evt-support',
      type: 'agent_runtime.test',
      occurred_at: fixedNow,
      payload: { ticket: { id: 'T-1', text: 'Charged twice.' } },
    };
  }

  function supportSeedHandler({ input, step }: CapabilityInvocationContext) {
    return {
      status: 'completed' as const,
      artifact_refs: [
        {
          id: 'support.ticket.seed',
          kind: 'support.ticket',
          source_node_id: step.id,
          value: input.ticket,
        },
      ] satisfies ArtifactRef[],
    };
  }

  function supportWorkflow(overrides: Partial<WorkflowSpec['steps'][number]> = {}): WorkflowSpec {
    return {
      id: 'support-case-classifier',
      tier: 'A',
      status: 'runtime_foundation',
      trigger: { event: 'agent_runtime.test' },
      idempotency_key: 'support:case:classify',
      steps: [
        {
          id: 'seed_artifacts',
          capability: 'test',
          operation: 'seed_artifacts',
          input_from_event: true,
        },
        {
          id: 'classify',
          capability: 'agent',
          operation: 'support_case_classifier',
          depends_on: ['seed_artifacts'],
          artifact_inputs: [
            {
              name: 'ticket',
              ref: 'support.ticket',
              kind: 'ticket',
              required: true,
              source_step_id: 'seed_artifacts',
            },
          ],
          artifact_outputs: [
            {
              name: 'classification',
              ref: 'support.case_classification',
              kind: 'case_classification',
              schema_ref: 'support.case_classification',
              materialization_target: 'typed_artifact_ref',
            },
          ],
          agent_extraction: {
            intent: 'support_case_classification',
            required_output_shape: {
              schema_ref: 'support.case_classification',
              additional_properties: false,
              required_paths: ['case_id', 'category', 'priority'],
            },
            acceptance_boundary: {
              type: 'validation_node',
              requires: ['validation.check'],
            },
            materialization: { target: 'typed_artifact_ref' },
          },
          ...overrides,
        },
      ],
    };
  }

  function supportRegistry(handler: FakeAgentHandler): CapabilityRegistry {
    const fakeHandlers = new InMemoryAgentHandlerRegistry();
    fakeHandlers.register('agent.support_case_classifier', handler);
    const capabilityRegistry = new CapabilityRegistry();
    capabilityRegistry.register('test.seed_artifacts', supportSeedHandler);
    capabilityRegistry.register(
      'agent.support_case_classifier',
      createAgentRuntimeHandler({ handlers: fakeHandlers }),
    );
    return capabilityRegistry;
  }

  async function runSupport(
    workflow: WorkflowSpec,
    handler: FakeAgentHandler,
  ): Promise<Awaited<ReturnType<InMemoryWorkflowRuntime['execute']>>> {
    const runtime = new InMemoryWorkflowRuntime({
      registry: supportRegistry(handler),
      clock: () => fixedNow,
    });
    return runtime.execute(workflow, supportEvent());
  }

  function classification(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { case_id: 'C-1', category: 'billing', priority: 'high', ...extra };
  }

  function emit(value: Record<string, unknown>): FakeAgentHandler {
    return (input) => {
      const output = input.artifact_outputs[0];
      if (!output) throw new Error('Missing output contract.');
      return [{ ...output, value }];
    };
  }

  it('accepts an agent output that satisfies its declared required_output_shape', async () => {
    const journal = await runSupport(supportWorkflow(), emit(classification()));

    expect(journal.status).toBe('completed');
    expect(journal.artifact_refs.map((artifact) => artifact.kind)).toContain(
      'support.case_classification',
    );
    expect(
      journal.artifact_refs.find((artifact) => artifact.kind === 'support.case_classification'),
    ).toMatchObject({
      source_node_id: 'classify',
      value: { schema_ref: 'support.case_classification', content: classification() },
    });
  });

  it('fails closed when a declared required path is missing', async () => {
    const { priority: _priority, ...withoutPriority } = classification();
    const journal = await runSupport(supportWorkflow(), emit(withoutPriority));

    expect(journal.status).toBe('terminal_failure');
    expect(journal.node_states[1]?.error?.code).toBe('agent_output_shape_mismatch');
  });

  it('fails closed on an undeclared top-level key when additional_properties is false', async () => {
    const journal = await runSupport(
      supportWorkflow(),
      emit(classification({ sentiment: 'angry' })),
    );

    expect(journal.status).toBe('terminal_failure');
    expect(journal.node_states[1]?.error?.code).toBe('agent_output_shape_mismatch');
  });
});

// FIX-RT1 (product neutrality): the neutrality guard is a tripwire for the CONTRACT/declaration
// surface (operation, intent, artifact refs/kinds/schema_refs, required_output_shape,
// acceptance_boundary, and the artifact envelope), NOT a content filter over runtime artifact
// data. Real transcript/document content may name a provider, and a product may legitimately
// declare a field named `body`/`code`/`model`. Scanning data payloads re-broke the very
// neutrality the declared-shape check established. These tests pin the correct scope.
describe('@rayspec/agent-runtime data-content neutrality (FIX-RT1)', () => {
  const triageEvent: WorkflowInputEvent = {
    id: 'evt-triage',
    type: 'agent_runtime.test',
    occurred_at: fixedNow,
    // DATA content that legitimately names a provider — must NOT trip the neutrality guard.
    payload: { email: { id: 'E-1', body: 'Audio was transcribed via Deepgram before triage.' } },
  };

  function triageSeed({ input, step }: CapabilityInvocationContext) {
    return {
      status: 'completed' as const,
      artifact_refs: [
        {
          id: 'support.email.seed',
          kind: 'support.email',
          source_node_id: step.id,
          value: input.email, // value payload mentions "Deepgram"
        },
      ] satisfies ArtifactRef[],
    };
  }

  function triageWorkflow(): WorkflowSpec {
    return {
      id: 'email-triage',
      tier: 'A',
      status: 'runtime_foundation',
      trigger: { event: 'agent_runtime.test' },
      idempotency_key: 'email:triage',
      steps: [
        {
          id: 'seed_artifacts',
          capability: 'test',
          operation: 'seed_artifacts',
          input_from_event: true,
        },
        {
          id: 'triage',
          capability: 'agent',
          operation: 'email_triage',
          depends_on: ['seed_artifacts'],
          artifact_inputs: [
            {
              name: 'email',
              ref: 'support.email',
              kind: 'email',
              required: true,
              source_step_id: 'seed_artifacts',
            },
          ],
          artifact_outputs: [
            {
              name: 'triage',
              ref: 'support.triage',
              kind: 'triage',
              schema_ref: 'support.triage',
              materialization_target: 'typed_artifact_ref',
            },
          ],
          agent_extraction: {
            intent: 'email_triage',
            required_output_shape: {
              schema_ref: 'support.triage',
              additional_properties: false,
              required_paths: ['category', 'body'],
            },
            acceptance_boundary: { type: 'validation_node', requires: ['validation.check'] },
            materialization: { target: 'typed_artifact_ref' },
          },
        },
      ],
    };
  }

  function triageRegistry(handler: FakeAgentHandler): CapabilityRegistry {
    const fakeHandlers = new InMemoryAgentHandlerRegistry();
    fakeHandlers.register('agent.email_triage', handler);
    const capabilityRegistry = new CapabilityRegistry();
    capabilityRegistry.register('test.seed_artifacts', triageSeed);
    capabilityRegistry.register(
      'agent.email_triage',
      createAgentRuntimeHandler({ handlers: fakeHandlers }),
    );
    return capabilityRegistry;
  }

  async function runTriage(
    handler: FakeAgentHandler,
    workflow: WorkflowSpec = triageWorkflow(),
  ): Promise<Awaited<ReturnType<InMemoryWorkflowRuntime['execute']>>> {
    const runtime = new InMemoryWorkflowRuntime({
      registry: triageRegistry(handler),
      clock: () => fixedNow,
    });
    return runtime.execute(workflow, triageEvent);
  }

  function emitTriage(value: Record<string, unknown>): FakeAgentHandler {
    return (input) => {
      const output = input.artifact_outputs[0];
      if (!output) throw new Error('Missing output contract.');
      return [{ ...output, value }];
    };
  }

  it('accepts an OUTPUT whose data content names providers and uses a field named `body`', async () => {
    const journal = await runTriage(
      emitTriage({
        category: 'billing',
        // Real product data: names providers, and a field literally named `body`.
        body: 'We compared OpenAI, Anthropic, and Gemini for extraction quality.',
      }),
    );

    expect(journal.status).toBe('completed');
    expect(journal.artifact_refs.map((artifact) => artifact.kind)).toContain('support.triage');
  });

  it('accepts an INPUT whose data content mentions a provider name', async () => {
    // The seeded input artifact value contains "Deepgram" (see triageEvent); a neutral output
    // is emitted. The run must complete — input DATA is not scanned.
    const journal = await runTriage(emitTriage({ category: 'billing', body: 'Neutral summary.' }));

    expect(journal.status).toBe('completed');
  });

  it('still fails closed on a provider-native token in the INPUT declaration surface (intent)', async () => {
    const workflow = triageWorkflow();
    const triageStep = workflow.steps[1] as { agent_extraction: { intent: string } };
    // Smuggle a provider name into the declared extraction intent (a contract field, not data).
    triageStep.agent_extraction.intent = 'deepgram email triage';

    const journal = await runTriage(
      emitTriage({ category: 'billing', body: 'Neutral summary.' }),
      workflow,
    );

    expect(journal.status).toBe('terminal_failure');
    expect(journal.node_states[1]?.error?.code).toBe('agent_provider_native_leak');
  });
});
