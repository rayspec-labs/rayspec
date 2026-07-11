export type ProductYamlWorkflowBridgeErrorCode =
  | 'agent_extraction_contract'
  | 'invalid_yaml_structure'
  | 'missing_workflow_id'
  | 'unknown_capability'
  | 'unknown_dependency'
  | 'unknown_step_type'
  | 'unknown_trigger_event'
  | 'provider_native_payload_leak'
  | 'product_owned_handler_path'
  | 'prompt_execution_claim'
  | 'production_execution_claim';

export interface ProductYamlWorkflowBridgeIssue {
  code: ProductYamlWorkflowBridgeErrorCode;
  message: string;
  path: string;
}

export class ProductYamlWorkflowBridgeError extends Error {
  readonly code: ProductYamlWorkflowBridgeErrorCode;
  readonly path: string;

  constructor(issue: ProductYamlWorkflowBridgeIssue) {
    super(issue.message);
    this.name = 'ProductYamlWorkflowBridgeError';
    this.code = issue.code;
    this.path = issue.path;
  }
}

export interface ProductYamlWorkflowStep {
  id?: string;
  type?: string;
  use?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  depends_on?: string[];
  on_error?: 'fail' | 'retry' | 'drop' | 'quarantine';
  retry?: {
    max_attempts?: number;
  };
  // ── the S2 store-step DECLARATION fields — additive, loose (the parser is the
  // strict gate). The bridge walks them for neutrality and validates the type/use discipline; it
  // deliberately does NOT compile them into the WorkflowStepSpec (the store nodes re-read the
  // validated ProductSpec by workflow id + step id).
  store?: string;
  filter?: Record<string, unknown>;
  limit?: number;
  values?: Record<string, unknown>;
}

export interface ProductYamlWorkflowDeclaration {
  id?: string;
  trigger?: {
    capability?: string;
    event?: string;
    scope?: string;
  };
  steps?: ProductYamlWorkflowStep[];
}

export interface ProductYamlAgentArtifactInput {
  name?: string;
  ref?: string;
  kind?: string;
  required?: boolean;
  source_step_id?: string;
}

export interface ProductYamlAgentArtifactOutput {
  name?: string;
  ref?: string;
  kind?: string;
  schema_ref?: string;
  materialization_target?: string;
}

export interface ProductYamlAgentExtractionDeclaration {
  intent?: string;
  input_artifacts?: ProductYamlAgentArtifactInput[];
  output_artifacts?: ProductYamlAgentArtifactOutput[];
  required_output_shape?: {
    schema_ref?: string;
    required_paths?: string[];
    additional_properties?: boolean;
  };
  acceptance_boundary?: {
    type?: 'validation_node';
    requires?: string[];
    closed_source_artifacts?: string[];
  };
  materialization?: {
    target?: 'typed_artifact_ref';
    persist_via?: string;
    handle_ref?: string;
  };
}

export interface ProductYamlAgentDeclaration {
  id?: string;
  purpose?: string;
  extraction?: ProductYamlAgentExtractionDeclaration;
  extraction_constraints?: string[];
}

export interface ProductYamlBridgeInput {
  // The language version ('1.0'); the bridge does not read it (pass-through for shape parity
  // with the product profile).
  version?: string;
  product?: {
    id?: string;
    name?: string;
  };
  requires?: {
    capabilities?: string[];
  };
  capabilities?: Array<{
    id?: string;
    tier?: string;
    status?: string;
    contracts?: string[];
    provider_policy?: unknown;
  }>;
  // The product profile's `extractors` section (renamed from `agents`). Each declaration compiles to a
  // runtime `agent.<id>` operation — the element type stays `ProductYamlAgentDeclaration` (it IS the
  // declaration of an agent operation); only the SECTION KEY is `extractors`.
  extractors?: ProductYamlAgentDeclaration[];
  workflows?: ProductYamlWorkflowDeclaration[];
  deployment_overrides?: unknown;
  [key: string]: unknown;
}

export interface CapabilityInventory {
  operations: Set<string>;
  contracts: Set<string>;
  events: Set<string>;
}

export interface CompileProductYamlWorkflowOptions {
  workflowId?: string;
  capabilityInventory: CapabilityInventory;
  idempotencyKey?: string;
  status?: 'runtime_foundation' | 'foundation_only';
}
