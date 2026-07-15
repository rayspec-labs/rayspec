import type {
  WorkflowAgentExtractionContract,
  WorkflowArtifactInputRef,
  WorkflowArtifactOutputRef,
  WorkflowSpec,
  WorkflowStepSpec,
} from '@rayspec/foundation';
import { normalizeProductTriggerEvent } from '@rayspec/spec';
import {
  type CompileProductYamlWorkflowOptions,
  type ProductYamlAgentDeclaration,
  type ProductYamlAgentExtractionDeclaration,
  type ProductYamlBridgeInput,
  ProductYamlWorkflowBridgeError,
  type ProductYamlWorkflowDeclaration,
  type ProductYamlWorkflowStep,
} from './types.js';

// The three banned-KEY sets below are `export`ed for the cross-package parser↔bridge KEY-SET parity test
// (`product-bridge-parity.test.ts`), which asserts `@rayspec/spec`'s parser bans a SUPERSET of these.
// Export-only — no runtime behavior change.
export const providerNativeKeys = new Set([
  'adapter_visibility',
  'api_key',
  'api_key_env',
  'backend',
  'body',
  'credential_env',
  'deepgram_request',
  'default_backend',
  'default_model',
  'default_provider',
  'headers',
  'model',
  'model_policy',
  'native_payload',
  'provider',
  'provider_payload',
  'raw_provider_payload',
]);

export const promptExecutionKeys = new Set([
  'prompt',
  'prompt_template',
  'system_prompt',
  'user_prompt',
]);
export const handlerKeys = new Set([
  'code',
  'handler',
  'handler_path',
  'handlers',
  'implementation',
  'module',
  'module_path',
  'route_handler',
]);

const productOwnedPathPattern = /(?:\/handlers\/|handlers\/|\.tsx?\b|\.mjs\b|\.cjs\b|\.js\b)/i;
const productionClaimPattern = /\b(production_ready|prod(?:uction)?\s+execution|prod\s+runtime)\b/i;
const promptExecutionPattern = /\b(prompt\s+execution|execute\s+prompt|llm\s+call|agent\s+call)\b/i;
const validationOperations = new Set(['grounding.check', 'validation.check']);
const artifactPersistOperations = new Set(['artifact.persist']);
const artifactReadOperations = new Set(['artifact.read']);
// S2: the EXACT per-type ops for the store step types. The declaration-only
// fields (store/filter/values/limit) are deliberately NOT compiled into the WorkflowStepSpec — the
// Tier-A store nodes re-read them from the validated ProductSpec by (workflow id, step id); the
// compiled step carries only the neutral capability/operation dispatch shape.
const storeReadOperations = new Set(['store.read']);
const storeWriteOperations = new Set(['store.write']);

export function compileProductYamlWorkflow(
  input: ProductYamlBridgeInput,
  options: CompileProductYamlWorkflowOptions,
): WorkflowSpec {
  validateProductYamlWorkflowBridgeInput(input);

  const workflow = selectWorkflow(input.workflows, options.workflowId);
  if (!workflow.id) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'missing_workflow_id',
      path: '$.workflows[].id',
      message: 'Product YAML workflow is missing an id.',
    });
  }
  if (!workflow.trigger?.capability || !workflow.trigger.event) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'invalid_yaml_structure',
      path: `$.workflows.${workflow.id}.trigger`,
      message: `Workflow '${workflow.id}' must declare trigger.capability and trigger.event.`,
    });
  }
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'invalid_yaml_structure',
      path: `$.workflows.${workflow.id}.steps`,
      message: `Workflow '${workflow.id}' must declare at least one step.`,
    });
  }

  // Every declared step must be a known, compilable type. An unknown/typo type was previously
  // silently dropped by a filter here, which also let a compilable step depend_on a step the bridge
  // never emitted (a dangling dependency). Reject it fail-closed instead.
  for (const step of workflow.steps) {
    if (!isCompilableStep(step)) {
      throw new ProductYamlWorkflowBridgeError({
        code: 'unknown_step_type',
        path: `$.workflows.${workflow.id}.steps.${step.id ?? '(unnamed)'}.type`,
        message: `Workflow '${workflow.id}' step '${step.id ?? '(unnamed)'}' has unknown type '${step.type ?? '(none)'}'. Allowed types: capability, agent, validation, artifact_persist, artifact_read, store_read, store_write.`,
      });
    }
  }

  // depends_on is validated against the COMPILED step ids (every step is compiled now that unknown
  // types fail closed), so a dependency can never dangle to a step the bridge did not compile.
  const compiledStepIds = new Set(workflow.steps.map((step) => step.id).filter(isString));
  const agentDeclarations = declaredAgentOperations(input);
  const compiledSteps = workflow.steps.map((step) =>
    compileWorkflowStep(workflow, step, compiledStepIds, agentDeclarations, options),
  );

  const triggerEvent = compileTriggerEvent(workflow.trigger.capability, workflow.trigger.event);
  if (!options.capabilityInventory.events.has(triggerEvent)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'unknown_trigger_event',
      path: `$.workflows.${workflow.id}.trigger`,
      message: `Workflow '${workflow.id}' trigger event '${triggerEvent}' is not a declared capability event contract.`,
    });
  }

  const spec: WorkflowSpec = {
    id: workflow.id,
    tier: 'A',
    status: options.status ?? 'foundation_only',
    trigger: {
      event: triggerEvent,
    },
    idempotency_key:
      options.idempotencyKey ?? `${workflow.trigger.scope ?? 'workflow'}:${workflow.id}:event`,
    steps: compiledSteps,
  };

  validateCompiledSpecNeutrality(spec);
  return spec;
}

export function validateProductYamlWorkflowBridgeInput(input: ProductYamlBridgeInput): void {
  if (!Array.isArray(input.workflows)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'invalid_yaml_structure',
      path: '$.workflows',
      message: 'Product YAML must declare workflows as an array.',
    });
  }

  walkWorkflowDeclarations(input.workflows);
  walkAgentDeclarations(input.extractors);
}

function selectWorkflow(
  workflows: ProductYamlWorkflowDeclaration[] | undefined,
  workflowId: string | undefined,
): ProductYamlWorkflowDeclaration {
  if (!Array.isArray(workflows)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'invalid_yaml_structure',
      path: '$.workflows',
      message: 'Product YAML must declare workflows as an array.',
    });
  }

  const workflow = workflowId
    ? workflows.find((candidate) => candidate.id === workflowId)
    : workflows[0];
  if (!workflow) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'missing_workflow_id',
      path: '$.workflows',
      message: workflowId
        ? `Product YAML does not declare workflow '${workflowId}'.`
        : 'Product YAML does not declare a workflow.',
    });
  }
  return workflow;
}

function compileWorkflowStep(
  workflow: ProductYamlWorkflowDeclaration,
  step: ProductYamlWorkflowStep,
  stepIds: Set<string>,
  agentDeclarations: Map<string, ProductYamlAgentDeclaration>,
  options: CompileProductYamlWorkflowOptions,
): WorkflowStepSpec {
  if (!step.id) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'invalid_yaml_structure',
      path: `$.workflows.${workflow.id}.steps[].id`,
      message: `Workflow '${workflow.id}' has a step without an id.`,
    });
  }
  if (!step.use) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'unknown_capability',
      path: `$.workflows.${workflow.id}.steps.${step.id}.use`,
      message: `Capability step '${step.id}' does not declare a capability operation.`,
    });
  }
  validateStepOperation(workflow, step, agentDeclarations, options);

  for (const dependency of step.depends_on ?? []) {
    if (!stepIds.has(dependency)) {
      throw new ProductYamlWorkflowBridgeError({
        code: 'unknown_dependency',
        path: `$.workflows.${workflow.id}.steps.${step.id}.depends_on`,
        message: `Step '${step.id}' depends on unknown step '${dependency}'.`,
      });
    }
  }

  const [capability, operation] = splitCapabilityOperation(step.use);
  const outputRefs = Object.values(step.outputs ?? {}).filter(isString);
  const input = normalizeStepInput(step.inputs);
  const agentExtraction =
    step.type === 'agent'
      ? compileAgentExtraction(workflow, step, agentDeclarations.get(step.use))
      : undefined;

  return {
    id: step.id,
    capability,
    operation,
    ...(step.depends_on?.length ? { depends_on: step.depends_on } : {}),
    ...(input ? { input } : {}),
    ...(!step.depends_on?.length ? { input_from_event: true } : {}),
    ...(outputRefs.length ? { output_artifact_refs: [...new Set(outputRefs)] } : {}),
    ...(agentExtraction
      ? {
          artifact_inputs: agentExtraction.artifactInputs,
          artifact_outputs: agentExtraction.artifactOutputs,
          agent_extraction: agentExtraction.contract,
        }
      : {}),
    retry_policy: { max_attempts: step.retry?.max_attempts ?? (step.on_error === 'retry' ? 2 : 1) },
    timeout_policy: { timeout_ms: 30_000 },
    acceptance_boundary: 'validation_node',
    // carry the Product-YAML `on_error` through as the compiled TERMINAL failure policy so the
    // durable runtime applies drop/quarantine (not just retry-then-fail). `fail`/`retry`/absent stay
    // the fail-closed default (omitted ⇒ `fail`); `retry` is a bounded re-attempt (above), whose
    // exhaustion still falls to `fail`. (Repair is declared on the compiled spec directly for now — it
    // is not in the Product-YAML `on_error` enum, so it never enters here.)
    ...(failurePolicyForOnError(step.on_error)
      ? { failure_policy: failurePolicyForOnError(step.on_error) }
      : {}),
  };
}

/**
 * map a Product-YAML step `on_error` to the compiled TERMINAL `failure_policy`. Only `drop`
 * and `quarantine` change the terminal action; `fail`/`retry`/absent keep the fail-closed default
 * (`fail`), so we omit the field for them (a redundant `failure_policy:'fail'` adds no meaning).
 */
function failurePolicyForOnError(
  onError: ProductYamlWorkflowStep['on_error'],
): 'drop' | 'quarantine' | undefined {
  if (onError === 'drop') return 'drop';
  if (onError === 'quarantine') return 'quarantine';
  return undefined;
}

function validateStepOperation(
  workflow: ProductYamlWorkflowDeclaration,
  step: ProductYamlWorkflowStep,
  agentDeclarations: Map<string, ProductYamlAgentDeclaration>,
  options: CompileProductYamlWorkflowOptions,
): void {
  if (!step.use) return;

  if (step.type === 'agent') {
    if (!agentDeclarations.has(step.use)) {
      throw new ProductYamlWorkflowBridgeError({
        code: 'unknown_capability',
        path: `$.workflows.${workflow.id}.steps.${step.id}.use`,
        message: `Unknown declarative agent operation '${step.use}'.`,
      });
    }
    return;
  }

  const allowedOperations =
    step.type === 'validation'
      ? validationOperations
      : step.type === 'artifact_persist'
        ? artifactPersistOperations
        : step.type === 'artifact_read'
          ? artifactReadOperations
          : step.type === 'store_read'
            ? storeReadOperations
            : step.type === 'store_write'
              ? storeWriteOperations
              : undefined;

  if (allowedOperations && !allowedOperations.has(step.use)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'unknown_capability',
      path: `$.workflows.${workflow.id}.steps.${step.id}.use`,
      message: `Workflow step '${step.id}' cannot use unsupported operation '${step.use}'.`,
    });
  }

  if (!options.capabilityInventory.operations.has(step.use)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'unknown_capability',
      path: `$.workflows.${workflow.id}.steps.${step.id}.use`,
      message: `Unknown capability operation '${step.use}'.`,
    });
  }
}

function isCompilableStep(step: ProductYamlWorkflowStep): boolean {
  return (
    step.type === 'capability' ||
    step.type === 'agent' ||
    step.type === 'validation' ||
    step.type === 'artifact_persist' ||
    step.type === 'artifact_read' ||
    // S2: the store step types compile onto the Tier-A store.read/store.write
    // nodes (the inventory check above still fail-closes a composition that wires no store runtime).
    step.type === 'store_read' ||
    step.type === 'store_write'
  );
}

function normalizeStepInput(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  return { ...input };
}

function declaredAgentOperations(
  input: ProductYamlBridgeInput,
): Map<string, ProductYamlAgentDeclaration> {
  const operations = new Map<string, ProductYamlAgentDeclaration>();
  for (const agent of input.extractors ?? []) {
    if (typeof agent.id === 'string' && agent.id.length > 0) {
      operations.set(`agent.${agent.id}`, agent);
    }
  }
  return operations;
}

function compileAgentExtraction(
  workflow: ProductYamlWorkflowDeclaration,
  step: ProductYamlWorkflowStep,
  agent: ProductYamlAgentDeclaration | undefined,
):
  | {
      artifactInputs: WorkflowArtifactInputRef[];
      artifactOutputs: WorkflowArtifactOutputRef[];
      contract: WorkflowAgentExtractionContract;
    }
  | undefined {
  const extraction = agent?.extraction;
  if (!agent || !extraction) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'agent_extraction_contract',
      path: `$.extractors.${agent?.id ?? step.use}.extraction`,
      message: `Agent step '${step.id}' must reference an agent with declarative extraction metadata.`,
    });
  }

  const artifactInputs = compileArtifactInputs(workflow, step, extraction);
  const artifactOutputs = compileArtifactOutputs(workflow, step, extraction);
  const contract = compileAgentExtractionContract(workflow, step, extraction);
  validateStepArtifactRefs(workflow, step, artifactInputs, artifactOutputs);

  return { artifactInputs, artifactOutputs, contract };
}

function compileArtifactInputs(
  workflow: ProductYamlWorkflowDeclaration,
  step: ProductYamlWorkflowStep,
  extraction: ProductYamlAgentExtractionDeclaration,
): WorkflowArtifactInputRef[] {
  const refs: WorkflowArtifactInputRef[] = [];
  for (const artifact of extraction.input_artifacts ?? []) {
    if (!artifact.name || !artifact.ref || !artifact.kind) {
      throw new ProductYamlWorkflowBridgeError({
        code: 'agent_extraction_contract',
        path: `$.workflows.${workflow.id}.steps.${step.id}.agent_extraction.input_artifacts`,
        message: `Agent step '${step.id}' has an incomplete declarative input artifact ref.`,
      });
    }
    refs.push({
      name: artifact.name,
      ref: artifact.ref,
      kind: artifact.kind,
      required: artifact.required ?? true,
      ...(artifact.source_step_id ? { source_step_id: artifact.source_step_id } : {}),
    });
  }
  if (refs.length === 0) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'agent_extraction_contract',
      path: `$.workflows.${workflow.id}.steps.${step.id}.inputs`,
      message: `Agent step '${step.id}' must declare at least one typed input artifact.`,
    });
  }
  return refs;
}

function compileArtifactOutputs(
  workflow: ProductYamlWorkflowDeclaration,
  step: ProductYamlWorkflowStep,
  extraction: ProductYamlAgentExtractionDeclaration,
): WorkflowArtifactOutputRef[] {
  const refs: WorkflowArtifactOutputRef[] = [];
  for (const artifact of extraction.output_artifacts ?? []) {
    if (!artifact.name || !artifact.ref || !artifact.kind) {
      throw new ProductYamlWorkflowBridgeError({
        code: 'agent_extraction_contract',
        path: `$.workflows.${workflow.id}.steps.${step.id}.agent_extraction.output_artifacts`,
        message: `Agent step '${step.id}' has an incomplete declarative output artifact ref.`,
      });
    }
    refs.push({
      name: artifact.name,
      ref: artifact.ref,
      kind: artifact.kind,
      ...(artifact.schema_ref ? { schema_ref: artifact.schema_ref } : {}),
      ...(artifact.materialization_target
        ? { materialization_target: artifact.materialization_target }
        : {}),
    });
  }
  if (refs.length === 0) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'agent_extraction_contract',
      path: `$.workflows.${workflow.id}.steps.${step.id}.outputs`,
      message: `Agent step '${step.id}' must declare at least one typed output artifact.`,
    });
  }
  return refs;
}

function compileAgentExtractionContract(
  workflow: ProductYamlWorkflowDeclaration,
  step: ProductYamlWorkflowStep,
  extraction: ProductYamlAgentExtractionDeclaration,
): WorkflowAgentExtractionContract {
  if (!extraction.intent || !extraction.required_output_shape?.schema_ref) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'agent_extraction_contract',
      path: `$.workflows.${workflow.id}.steps.${step.id}.agent_extraction`,
      message: `Agent step '${step.id}' must declare extraction intent and output schema ref.`,
    });
  }
  if (
    extraction.acceptance_boundary?.type !== 'validation_node' ||
    !Array.isArray(extraction.acceptance_boundary.requires) ||
    extraction.acceptance_boundary.requires.length === 0
  ) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'agent_extraction_contract',
      path: `$.workflows.${workflow.id}.steps.${step.id}.agent_extraction.acceptance_boundary`,
      message: `Agent step '${step.id}' must declare a validation-node acceptance boundary.`,
    });
  }
  if (extraction.materialization?.target !== 'typed_artifact_ref') {
    throw new ProductYamlWorkflowBridgeError({
      code: 'agent_extraction_contract',
      path: `$.workflows.${workflow.id}.steps.${step.id}.agent_extraction.materialization`,
      message: `Agent step '${step.id}' must materialize as a typed artifact ref.`,
    });
  }

  return {
    intent: extraction.intent,
    required_output_shape: {
      schema_ref: extraction.required_output_shape.schema_ref,
      ...(extraction.required_output_shape.required_paths
        ? { required_paths: extraction.required_output_shape.required_paths }
        : {}),
      ...(typeof extraction.required_output_shape.additional_properties === 'boolean'
        ? { additional_properties: extraction.required_output_shape.additional_properties }
        : {}),
    },
    acceptance_boundary: {
      type: 'validation_node',
      requires: extraction.acceptance_boundary.requires,
      ...(extraction.acceptance_boundary.closed_source_artifacts
        ? { closed_source_artifacts: extraction.acceptance_boundary.closed_source_artifacts }
        : {}),
    },
    materialization: {
      target: 'typed_artifact_ref',
      ...(extraction.materialization.persist_via
        ? { persist_via: extraction.materialization.persist_via }
        : {}),
      ...(extraction.materialization.handle_ref
        ? { handle_ref: extraction.materialization.handle_ref }
        : {}),
    },
  };
}

function validateStepArtifactRefs(
  workflow: ProductYamlWorkflowDeclaration,
  step: ProductYamlWorkflowStep,
  artifactInputs: WorkflowArtifactInputRef[],
  artifactOutputs: WorkflowArtifactOutputRef[],
): void {
  const inputRefs = new Set(Object.values(step.inputs ?? {}).filter(isString));
  for (const artifact of artifactInputs) {
    if (!inputRefs.has(artifact.ref)) {
      throw new ProductYamlWorkflowBridgeError({
        code: 'agent_extraction_contract',
        path: `$.workflows.${workflow.id}.steps.${step.id}.inputs`,
        message: `Agent step '${step.id}' input artifacts must match declarative extraction inputs.`,
      });
    }
  }

  const outputRefs = new Set(Object.values(step.outputs ?? {}).filter(isString));
  for (const artifact of artifactOutputs) {
    if (!outputRefs.has(artifact.ref)) {
      throw new ProductYamlWorkflowBridgeError({
        code: 'agent_extraction_contract',
        path: `$.workflows.${workflow.id}.steps.${step.id}.outputs`,
        message: `Agent step '${step.id}' output artifacts must match declarative extraction outputs.`,
      });
    }
  }
}

function splitCapabilityOperation(use: string): [string, string] {
  const [capability, ...rest] = use.split('.');
  const operation = rest.join('.');
  if (!capability || !operation) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'unknown_capability',
      path: '$.workflows[].steps[].use',
      message: `Capability operation '${use}' must use namespace.operation form.`,
    });
  }
  return [capability, operation];
}

/**
 * The trigger-event normalization is the SHARED `normalizeProductTriggerEvent` from `@rayspec/spec`
 * the ONE source the parser lint also uses (the old KEEP-IN-SYNC local copy is gone). Exported
 * under the historical bridge name so the cross-package parity test can pin the single source by
 * IDENTITY (`compileTriggerEvent === normalizeProductTriggerEvent`): re-introducing a local copy here
 * breaks that pin (or collides with this binding at compile time).
 */
export const compileTriggerEvent = normalizeProductTriggerEvent;

function walkWorkflowDeclarations(value: unknown, path = '$.workflows'): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkWorkflowDeclarations(item, `${path}[${index}]`);
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (handlerKeys.has(key)) {
        throw new ProductYamlWorkflowBridgeError({
          code: 'product_owned_handler_path',
          path: `${path}.${key}`,
          message: `Product-owned implementation key '${key}' cannot enter the workflow bridge.`,
        });
      }
      if (promptExecutionKeys.has(key)) {
        throw new ProductYamlWorkflowBridgeError({
          code: 'prompt_execution_claim',
          path: `${path}.${key}`,
          message: `Prompt execution key '${key}' cannot enter the workflow bridge.`,
        });
      }
      if (providerNativeKeys.has(key)) {
        throw new ProductYamlWorkflowBridgeError({
          code: 'provider_native_payload_leak',
          path: `${path}.${key}`,
          message: `Provider-native key '${key}' cannot enter the workflow bridge.`,
        });
      }
      walkWorkflowDeclarations(child, `${path}.${key}`);
    }
    return;
  }

  if (typeof value !== 'string') return;

  if (productOwnedPathPattern.test(value)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'product_owned_handler_path',
      path,
      message: `Product-owned handler/module path '${value}' cannot enter the workflow bridge.`,
    });
  }
  if (/\b(?:deepgram|openai|anthropic|gemini|pi)\b|provider_native|native_payload/i.test(value)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'provider_native_payload_leak',
      path,
      message: `Provider-native value '${value}' cannot enter the workflow bridge.`,
    });
  }
  if (productionClaimPattern.test(value)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'production_execution_claim',
      path,
      message: `Production execution claim '${value}' is forbidden.`,
    });
  }
  if (promptExecutionPattern.test(value)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'prompt_execution_claim',
      path,
      message: `Prompt or live agent execution claim '${value}' is forbidden.`,
    });
  }
}

function walkAgentDeclarations(value: unknown, path = '$.extractors'): void {
  if (value === undefined) return;
  walkWorkflowDeclarations(value, path);
}

function validateCompiledSpecNeutrality(spec: WorkflowSpec): void {
  const json = JSON.stringify(spec).toLowerCase();
  if (
    /deepgram|openai|anthropic|gemini|credential_env|provider_policy|deployment_overrides/.test(
      json,
    )
  ) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'provider_native_payload_leak',
      path: '$.compiled_workflow_spec',
      message: 'Compiled WorkflowSpec contains provider-native or policy fields.',
    });
  }
  if (productOwnedPathPattern.test(json)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'product_owned_handler_path',
      path: '$.compiled_workflow_spec',
      message: 'Compiled WorkflowSpec contains product-owned handler/module paths.',
    });
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
