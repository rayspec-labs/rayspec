import type {
  CapabilityInvocationContext,
  CapabilityInvocationResult,
  WorkflowErrorState,
} from '@rayspec/foundation';
import { detectExecutionInputLeak, detectOutputArtifactLeak } from './neutrality.js';
import type {
  AgentRuntimeAgentExtraction,
  AgentRuntimeArtifactOutputRef,
  AgentRuntimeExecutionInput,
  AgentRuntimeNodeOptions,
  AgentRuntimeOutputArtifact,
  AgentRuntimeStepContract,
  FakeAgentHandler,
} from './types.js';

export const AGENT_EXTRACTION_OPERATION = 'agent.extraction';

export function createAgentRuntimeHandler(options: AgentRuntimeNodeOptions) {
  return async (context: CapabilityInvocationContext): Promise<CapabilityInvocationResult> => {
    const step = agentStep(context);
    const operation = `${step.capability}.${step.operation}`;
    const handler = options.handlers.get(operation);
    if (!handler) {
      return fail(
        'agent_handler_not_registered',
        `Agent handler '${operation}' is not registered.`,
      );
    }

    const input = buildExecutionInput(context);
    if ('error' in input) return input.error;

    const leak = detectExecutionInputLeak(input.value);
    if (leak) {
      return fail(
        leak,
        `Agent node '${context.step.id}' declaration surface leaks a forbidden provider-native, prompt/model, or product-owned reference.`,
      );
    }

    const outputArtifacts = await invokeFakeHandler(handler, input.value, context);
    if ('error' in outputArtifacts) return outputArtifacts.error;

    const outputLeak = detectOutputArtifactLeak(outputArtifacts.value);
    if (outputLeak) {
      return fail(
        outputLeak,
        `Agent handler '${operation}' output declaration leaks a forbidden provider-native, prompt/model, or product-owned reference.`,
      );
    }

    const mismatch = validateOutputs(
      step.artifact_outputs ?? [],
      outputArtifacts.value,
      input.value.required_output_shape,
    );
    if (mismatch) return mismatch;

    const artifact_refs = outputArtifacts.value.map((artifact) => ({
      id: deterministicArtifactId(context.workflow.id, step.id, artifact.ref),
      kind: artifact.ref,
      source_node_id: step.id,
      value: {
        ref: artifact.ref,
        kind: artifact.kind,
        schema_ref: artifact.schema_ref,
        materialization_target: artifact.materialization_target,
        content: artifact.value,
      },
    }));

    return {
      status: 'completed',
      artifact_refs,
      output: {
        status: 'completed',
        artifact_refs,
        output_artifacts: outputArtifacts.value,
        deterministic_key: deterministicKey(context.workflow.id, step.id),
      },
    };
  };
}

function buildExecutionInput(
  context: CapabilityInvocationContext,
):
  | { value: AgentRuntimeExecutionInput }
  | { error: CapabilityInvocationResult & { status: 'terminal_failure' } } {
  const step = agentStep(context);
  const extraction = step.agent_extraction;
  if (!extraction) {
    return {
      error: fail(
        'agent_extraction_missing',
        `Agent node '${step.id}' is missing agent_extraction metadata.`,
      ),
    };
  }

  const available = availableArtifactRefs(context);
  const artifact_inputs = [];
  for (const artifact of step.artifact_inputs ?? []) {
    const value = available.get(artifact.ref);
    if (artifact.required && value === undefined) {
      return {
        error: fail(
          'agent_input_artifact_missing',
          `Agent node '${step.id}' is missing required artifact '${artifact.ref}'.`,
        ),
      };
    }
    artifact_inputs.push({ ...artifact, value });
  }

  if (artifact_inputs.length === 0) {
    return {
      error: fail(
        'agent_input_artifact_missing',
        `Agent node '${step.id}' must receive typed artifact inputs.`,
      ),
    };
  }

  return {
    value: {
      operation: `${step.capability}.${step.operation}`,
      intent: extraction.intent,
      artifact_inputs,
      artifact_outputs: step.artifact_outputs ?? [],
      required_output_shape: extraction.required_output_shape,
      acceptance_boundary: extraction.acceptance_boundary,
    },
  };
}

function availableArtifactRefs(context: CapabilityInvocationContext): Map<string, unknown> {
  const refs = new Map<string, unknown>();
  for (const artifact of context.journal.artifact_refs) {
    refs.set(artifact.kind, artifact.value ?? artifact.id);
  }
  for (const artifact of context.journal.node_states.flatMap((node) => node.artifact_refs)) {
    refs.set(artifact.kind, artifact.value ?? artifact.id);
  }
  return refs;
}

async function invokeFakeHandler(
  handler: FakeAgentHandler,
  input: AgentRuntimeExecutionInput,
  context: CapabilityInvocationContext,
): Promise<
  | { value: AgentRuntimeOutputArtifact[] }
  | { error: CapabilityInvocationResult & { status: 'terminal_failure' } }
> {
  try {
    return { value: await handler(input, context) };
  } catch (error) {
    return {
      error: fail('agent_output_shape_mismatch', errorMessage(error)),
    };
  }
}

function validateOutputs(
  expectedOutputs: AgentRuntimeArtifactOutputRef[],
  actualOutputs: AgentRuntimeOutputArtifact[],
  requiredOutputShape: AgentRuntimeAgentExtraction['required_output_shape'],
): CapabilityInvocationResult | undefined {
  if (expectedOutputs.length === 0 || actualOutputs.length !== expectedOutputs.length) {
    return fail(
      'agent_output_shape_mismatch',
      'Agent output count does not match the step contract.',
    );
  }

  for (const expected of expectedOutputs) {
    const actual = actualOutputs.find((candidate) => candidate.ref === expected.ref);
    if (!actual) {
      return fail(
        'agent_output_shape_mismatch',
        `Agent output '${expected.ref}' is missing from the fake handler result.`,
      );
    }
    if (actual.kind !== expected.kind) {
      return fail(
        'agent_output_shape_mismatch',
        `Agent output '${expected.ref}' kind '${actual.kind}' does not match '${expected.kind}'.`,
      );
    }
    if (expected.schema_ref && actual.schema_ref !== expected.schema_ref) {
      return fail(
        'agent_output_shape_mismatch',
        `Agent output '${expected.ref}' schema '${actual.schema_ref}' does not match '${expected.schema_ref}'.`,
      );
    }
  }

  return validateRequiredOutputShape(requiredOutputShape, actualOutputs);
}

/**
 * Enforce the DECLARED required_output_shape (product-neutral): the shape is a first-class
 * contract on the compiled step, not a hardcoded product surface. It applies to the output
 * artifact whose schema_ref matches the declared schema_ref; every declared required_path must
 * resolve (dotted-path aware) and, when additional_properties is false, no undeclared top-level
 * key may appear. This lets ANY product declare its own output shape.
 */
function validateRequiredOutputShape(
  requiredOutputShape: AgentRuntimeAgentExtraction['required_output_shape'],
  actualOutputs: AgentRuntimeOutputArtifact[],
): CapabilityInvocationResult | undefined {
  const constrained = actualOutputs.find(
    (artifact) => artifact.schema_ref === requiredOutputShape.schema_ref,
  );
  if (!constrained) {
    return fail(
      'agent_output_shape_mismatch',
      `Agent output for schema '${requiredOutputShape.schema_ref}' is missing from the handler result.`,
    );
  }

  const value = constrained.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'agent_output_shape_mismatch',
      `Agent output '${constrained.ref}' must be an object to satisfy '${requiredOutputShape.schema_ref}'.`,
    );
  }
  const candidate = value as Record<string, unknown>;

  for (const path of requiredOutputShape.required_paths ?? []) {
    if (!hasPath(candidate, path)) {
      return fail(
        'agent_output_shape_mismatch',
        `Agent output '${constrained.ref}' is missing required path '${path}'.`,
      );
    }
  }

  if (requiredOutputShape.additional_properties === false) {
    const declaredTopLevel = new Set(
      (requiredOutputShape.required_paths ?? []).map((path) => path.split('.')[0]),
    );
    for (const key of Object.keys(candidate)) {
      if (!declaredTopLevel.has(key)) {
        return fail(
          'agent_output_shape_mismatch',
          `Agent output '${constrained.ref}' has undeclared top-level property '${key}' (additional_properties:false).`,
        );
      }
    }
  }

  return undefined;
}

function hasPath(root: Record<string, unknown>, path: string): boolean {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return false;
    const obj = current as Record<string, unknown>;
    if (!(segment in obj)) return false;
    current = obj[segment];
    if (current === undefined) return false;
  }
  return true;
}

function agentStep(context: CapabilityInvocationContext): AgentRuntimeStepContract {
  return context.step as AgentRuntimeStepContract;
}

function fail(
  code: WorkflowErrorState['code'],
  message: string,
): CapabilityInvocationResult & { status: 'terminal_failure' } {
  return {
    status: 'terminal_failure',
    error: {
      code,
      message,
      retryable: false,
    },
  };
}

function deterministicArtifactId(workflowId: string, stepId: string, ref: string): string {
  return `agent_artifact:${workflowId}:${stepId}:${ref}`;
}

function deterministicKey(workflowId: string, stepId: string): string {
  return `agent_runtime:${workflowId}:${stepId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
