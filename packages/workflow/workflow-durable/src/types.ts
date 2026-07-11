import type {
  ArtifactRef,
  CapabilityInvocationContext,
  CapabilityInvocationResult,
  WorkflowErrorState,
  WorkflowInputEvent,
  WorkflowNodeAttempt,
  WorkflowNodeStatus,
  WorkflowRunStatus,
} from '@rayspec/foundation';

/**
 * The durable per-node record — a superset of the in-memory `WorkflowNodeJournal` with the fields a
 * persisted, resumable, cost-attributed runtime needs (position for stable ordering, `output` as the
 * memoized resume value, `producedBy` provenance, `costUsd`). One of these persists per (run, node).
 */
export interface DurableNodeState {
  nodeId: string;
  /** Declaration-order index (stable observability ordering). */
  position: number;
  capability: string;
  operation: string;
  status: WorkflowNodeStatus;
  attempts: WorkflowNodeAttempt[];
  /** attempts.length — persisted so a read model needs no array scan. */
  attemptCount: number;
  artifactRefs: ArtifactRef[];
  /** The node's memoized output — the value re-used when a completed node is replayed on resume. */
  output: unknown;
  error?: WorkflowErrorState;
  skippedReason?: string;
  producedBy?: string;
  costUsd: number;
}

/** The durable workflow-run header (one row per run, tenant-scoped). */
export interface DurableWorkflowRun {
  workflowRunId: string;
  tenantId: string;
  workflowId: string;
  idempotencyKey: string;
  triggerEvent: string;
  inputEvent: WorkflowInputEvent;
  status: WorkflowRunStatus;
  /** True for a paused/quarantined run a later worker/operator may resume from the node journal. */
  resumable: boolean;
  error?: WorkflowErrorState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/** The full observable view of a workflow run — its header + every node's journal. */
export interface WorkflowRunView {
  run: DurableWorkflowRun;
  nodes: DurableNodeState[];
}

/** The header fields a caller supplies to create-or-get a run (the rest are runtime-derived). */
export interface WorkflowRunHeaderInput {
  workflowRunId: string;
  workflowId: string;
  idempotencyKey: string;
  triggerEvent: string;
  inputEvent: WorkflowInputEvent;
}

/** The patch `finalizeRun` applies to a run header at the end (or a pause/quarantine) of a pass. */
export interface WorkflowRunFinalizePatch {
  status: WorkflowRunStatus;
  resumable: boolean;
  error?: WorkflowErrorState;
  attempts: number;
}

/**
 * The durable journal persistence seam. Two implementations: `TenantDbWorkflowJournalStore` (the real
 * Postgres/TenantDb store) and `FakeWorkflowJournalStore` (an in-memory store that reproduces the SAME
 * UNIQUE (tenant, run, node) constraint — a fake must enforce the real constraint, or it proves nothing).
 */
export interface WorkflowJournalStore {
  /**
   * Create the run header IDEMPOTENTLY. Returns the persisted run + whether THIS call created it. The
   * single-flight winner is whoever created it: a redelivery / concurrent start of the same
   * `(tenant, workflow, idempotency)` gets `created:false` + the existing header (never a second run).
   */
  ensureRun(header: WorkflowRunHeaderInput): Promise<{ run: DurableWorkflowRun; created: boolean }>;
  /** Load the full run view (header + node states) for resume/observability. undefined if absent. */
  loadRun(workflowRunId: string): Promise<WorkflowRunView | undefined>;
  /** Idempotent upsert of one node state (keyed by the UNIQUE (tenant, run, node)). */
  upsertNodeState(workflowRunId: string, node: DurableNodeState): Promise<void>;
  /** Persist the terminal/paused run-header patch. */
  finalizeRun(workflowRunId: string, patch: WorkflowRunFinalizePatch): Promise<void>;
}

/**
 * A declared repair hook (failure semantics — `failure_policy: 'repair'`). Given the failed
 * node's invocation context + the terminal failure result, it returns a FRESH result: `completed`
 * (the node was repaired — its output is used) or a failure (the repair itself failed — fail-closed,
 * no further repair loop). Repairers are INJECTED into the engine by id; a node declaring
 * `repair.ref` with NO matching repairer makes the node fail with an explicit "repair not wired"
 * error (the inert-stub contract — never a silent pass).
 */
export type RepairHandler = (
  context: CapabilityInvocationContext,
  failure: CapabilityInvocationResult,
) => Promise<CapabilityInvocationResult> | CapabilityInvocationResult;

export type { ArtifactRef, WorkflowErrorState, WorkflowNodeStatus, WorkflowRunStatus };
