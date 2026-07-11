import type {
  ArtifactRef,
  CapabilityInvocationContext,
  CapabilityInvocationResult,
  CapabilityNodeHandler,
  WorkflowErrorState,
} from '@rayspec/foundation';

export const AGENT_CAPABILITY = 'agent';
export const AGENT_RUNTIME_OPERATION_PREFIX = `${AGENT_CAPABILITY}.`;

export type AgentRuntimeFailureCode =
  | 'agent_extraction_missing'
  | 'agent_input_artifact_missing'
  | 'agent_handler_not_registered'
  | 'agent_output_shape_mismatch'
  | 'agent_provider_native_leak'
  | 'agent_prompt_or_model_leak'
  | 'agent_product_owned_path_leak';

export interface AgentRuntimeArtifactInputRef {
  name: string;
  ref: string;
  kind: string;
  required: boolean;
  source_step_id?: string;
}

export interface AgentRuntimeArtifactOutputRef {
  name: string;
  ref: string;
  kind: string;
  schema_ref?: string;
  materialization_target?: string;
}

export interface AgentRuntimeAgentExtraction {
  intent: string;
  required_output_shape: {
    schema_ref: string;
    required_paths?: string[];
    additional_properties?: boolean;
  };
  acceptance_boundary: {
    type: 'validation_node';
    requires: string[];
    closed_source_artifacts?: string[];
  };
  materialization: {
    target: 'typed_artifact_ref';
    persist_via?: string;
    handle_ref?: string;
  };
}

export interface AgentRuntimeStepContract {
  id: string;
  capability: string;
  operation: string;
  artifact_inputs?: AgentRuntimeArtifactInputRef[];
  artifact_outputs?: AgentRuntimeArtifactOutputRef[];
  agent_extraction?: AgentRuntimeAgentExtraction;
}

export interface AgentRuntimeInputArtifact extends AgentRuntimeArtifactInputRef {
  value: unknown;
}

export interface AgentRuntimeOutputArtifact extends AgentRuntimeArtifactOutputRef {
  value: unknown;
}

export interface AgentRuntimeExecutionInput {
  operation: string;
  intent: string;
  artifact_inputs: AgentRuntimeInputArtifact[];
  artifact_outputs: AgentRuntimeArtifactOutputRef[];
  required_output_shape: {
    schema_ref: string;
    required_paths?: string[];
    additional_properties?: boolean;
  };
  acceptance_boundary: {
    type: 'validation_node';
    requires: string[];
    closed_source_artifacts?: string[];
  };
}

export interface AgentRuntimeExecutionResult {
  status: 'completed';
  artifact_refs: ArtifactRef[];
  output_artifacts: AgentRuntimeOutputArtifact[];
  deterministic_key: string;
}

export interface AgentRuntimeFailureResult {
  status: 'terminal_failure';
  error: WorkflowErrorState & { code: AgentRuntimeFailureCode };
}

export type AgentRuntimeResult = AgentRuntimeExecutionResult | AgentRuntimeFailureResult;

export type FakeAgentHandler = (
  input: AgentRuntimeExecutionInput,
  context: CapabilityInvocationContext,
) => AgentRuntimeOutputArtifact[] | Promise<AgentRuntimeOutputArtifact[]>;

export interface AgentRuntimeRegistry {
  register(operation: string, handler: FakeAgentHandler): void;
  get(operation: string): FakeAgentHandler | undefined;
  has(operation: string): boolean;
  ids(): string[];
}

export interface AgentRuntimeNodeOptions {
  handlers: AgentRuntimeRegistry;
}

export type AgentRuntimeCapabilityNodeHandler = CapabilityNodeHandler;
export type AgentRuntimeCapabilityResult = CapabilityInvocationResult;
