export type WorkflowNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'retryable_failure'
  | 'terminal_failure'
  | 'skipped'
  | 'paused'
  | 'capability_unavailable'
  // Failure semantics: a node whose failure policy DROPPED it (the run
  // continues where the graph allows) or QUARANTINED it (the node + its dependents are parked and the
  // run is marked resumable). Distinct from `terminal_failure`, which stops the whole run.
  | 'dropped'
  | 'quarantined';

export type WorkflowRunStatus =
  | 'running'
  | 'completed'
  | 'retryable_failure'
  | 'terminal_failure'
  | 'paused'
  // At least one node was quarantined (parked + resumable). A run can END quarantined even if
  // other branches completed — it is a distinct, resumable terminal-ish state, not a hard failure.
  | 'quarantined';

/**
 * Failure semantics — the TERMINAL action applied to a node that has
 * EXHAUSTED its `retry_policy` (or failed with no retry). Orthogonal to retry, which is the bounded
 * re-attempt loop. FAIL-CLOSED DEFAULT: an absent/undeclared policy is `fail`.
 *  - `fail`       — terminal_failure; the run stops invoking new work (existing behaviour).
 *  - `drop`       — the node is journaled `dropped` and the run CONTINUES where the graph allows
 *                   (a node depending on a dropped node is still `skipped` — a dropped output is absent).
 *  - `quarantine` — the node + everything transitively depending on it are parked; the run is marked
 *                   `quarantined` + resumable (a durable marker a later worker/operator can resume from).
 *  - `repair`     — invoke the node's DECLARED repair hook. When no repairer is wired, the runtime
 *                   FAILS the node with an explicit "repair not wired" terminal error (never silent).
 */
export type WorkflowFailurePolicy = 'fail' | 'drop' | 'quarantine' | 'repair';

export interface WorkflowRetryPolicy {
  max_attempts: number;
  backoff_ms?: number;
}

export interface WorkflowTimeoutPolicy {
  timeout_ms: number;
}

export interface WorkflowArtifactInputRef {
  name: string;
  ref: string;
  kind: string;
  required: boolean;
  source_step_id?: string;
}

export interface WorkflowArtifactOutputRef {
  name: string;
  ref: string;
  kind: string;
  schema_ref?: string;
  materialization_target?: string;
}

export interface WorkflowArtifactMaterializationTarget {
  target: 'typed_artifact_ref';
  persist_via?: string;
  handle_ref?: string;
}

export interface WorkflowAgentExtractionContract {
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
  materialization: WorkflowArtifactMaterializationTarget;
}

export interface WorkflowStepSpec {
  id: string;
  capability: string;
  operation: string;
  depends_on?: string[];
  input?: Record<string, unknown>;
  input_from_event?: boolean;
  output_artifact_refs?: string[];
  artifact_inputs?: WorkflowArtifactInputRef[];
  artifact_outputs?: WorkflowArtifactOutputRef[];
  agent_extraction?: WorkflowAgentExtractionContract;
  retry_policy?: WorkflowRetryPolicy;
  timeout_policy?: WorkflowTimeoutPolicy;
  idempotency_key?: string;
  acceptance_boundary?: 'none' | 'validation_node';
  /**
   * The TERMINAL action applied once this node has exhausted its retry policy (fail-closed
   * default `fail` when absent). Compiled from the Product-YAML step's `on_error` by the bridge.
   */
  failure_policy?: WorkflowFailurePolicy;
  /**
   * The declared repair-hook reference used when `failure_policy: 'repair'`. The durable
   * runtime resolves it against an injected repairer registry; a declared-but-unwired repairer makes
   * the node fail with an explicit "repair not wired" error (never a silent pass).
   */
  repair?: WorkflowRepairSpec;
}

/** A node's declared repair hook (resolved against an injected repairer registry at run time). */
export interface WorkflowRepairSpec {
  /** The repairer id the durable runtime resolves; unresolved ⇒ explicit "repair not wired" failure. */
  ref: string;
}

export interface WorkflowTriggerSpec {
  event: string;
}

export interface WorkflowSpec {
  id: string;
  tier: 'A';
  status: 'runtime_foundation' | 'foundation_only';
  trigger: WorkflowTriggerSpec;
  idempotency_key: string;
  steps: WorkflowStepSpec[];
}

export interface WorkflowInputEvent {
  id: string;
  type: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface ArtifactRef {
  id: string;
  kind: string;
  source_node_id: string;
  value?: unknown;
}

export interface WorkflowNodeAttempt {
  attempt: number;
  started_at: string;
  completed_at?: string;
  status: WorkflowNodeStatus;
  error?: WorkflowErrorState;
}

export interface WorkflowErrorState {
  code: string;
  message: string;
  retryable: boolean;
}

export interface WorkflowNodeJournal {
  node_id: string;
  capability: string;
  operation: string;
  status: WorkflowNodeStatus;
  attempts: WorkflowNodeAttempt[];
  artifact_refs: ArtifactRef[];
  error?: WorkflowErrorState;
  skipped_reason?: string;
}

export interface ExecutionJournal {
  workflow_run_id: string;
  workflow_id: string;
  idempotency_key: string;
  input_event: WorkflowInputEvent;
  status: WorkflowRunStatus;
  node_states: WorkflowNodeJournal[];
  artifact_refs: ArtifactRef[];
  attempts: number;
  created_at: string;
  updated_at: string;
  error?: WorkflowErrorState;
  replay_of?: string;
}

export interface CapabilityInvocationContext {
  workflow: WorkflowSpec;
  step: WorkflowStepSpec;
  input_event: WorkflowInputEvent;
  input: Record<string, unknown>;
  journal: ExecutionJournal;
  /**
   * Artifact passing: the typed artifacts produced by UPSTREAM completed
   * nodes in this run, so a node (e.g. an extract/validate/store node) can consume its dependencies'
   * outputs. Empty on the in-memory foundation executor (which records artifacts but does not thread
   * them); populated by the durable engine. Optional so existing handlers are unaffected.
   */
  artifacts?: ArtifactRef[];
}

export type CapabilityInvocationResult =
  | {
      status: 'completed';
      artifact_refs?: ArtifactRef[];
      output?: unknown;
    }
  | {
      status: 'retryable_failure' | 'terminal_failure' | 'paused';
      error?: WorkflowErrorState;
      artifact_refs?: ArtifactRef[];
    };

export type CapabilityNodeHandler = (
  context: CapabilityInvocationContext,
) => Promise<CapabilityInvocationResult> | CapabilityInvocationResult;

export interface WorkflowRuntime {
  execute(workflow: WorkflowSpec, input_event: WorkflowInputEvent): Promise<ExecutionJournal>;
  replay(journal: ExecutionJournal): ExecutionJournal;
}
