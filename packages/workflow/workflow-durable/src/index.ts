// @rayspec/workflow-durable — the Tier A DURABLE workflow execution engine. Wires the reviewed
// @rayspec/foundation foundation onto the real platform primitives (TenantDb journal, DBOS
// durable path, failure semantics, real agent/capability/validate/store nodes). Product-free.

export type { DurableWorkflowEngineDeps, WorkflowExecutionInput } from './engine.js';
export { computeRunStatus, DurableWorkflowEngine, WORKFLOW_DURABLE_PRODUCED_BY } from './engine.js';
export { durableWorkflowRunId } from './ids.js';
export { TenantDbWorkflowJournalStore } from './journal-store.js';
export type { AgentNodeDeps, ResolvedAgentNode } from './nodes/agent-node.js';
export { makeAgentNodeHandler } from './nodes/agent-node.js';
export { TenantDbArtifactStore } from './nodes/store.js';
export {
  getWorkflowRunObservability,
  listWorkflowRuns,
  type WorkflowRunObservability,
  type WorkflowRunSummary,
} from './observability.js';
export {
  payloadFieldIdempotencyKey,
  type RegisteredWorkflowTrigger,
  sessionScopedIdempotencyKey,
  type WorkflowDispatchEnqueued,
  type WorkflowDispatchResult,
  type WorkflowEmitOptions,
  type WorkflowEnqueuer,
  WorkflowEventDispatcher,
  type WorkflowEventIngress,
} from './trigger-dispatcher.js';
export type {
  DurableNodeState,
  DurableWorkflowRun,
  RepairHandler,
  WorkflowJournalStore,
  WorkflowRunFinalizePatch,
  WorkflowRunHeaderInput,
  WorkflowRunView,
} from './types.js';
