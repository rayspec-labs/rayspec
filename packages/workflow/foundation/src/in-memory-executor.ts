import { type CapabilityRegistry, CapabilityUnavailableError } from './capability-registry.js';
import { SingleFlight, workflowIdempotencyScope, workflowRunId } from './idempotency.js';
import type {
  CapabilityInvocationResult,
  CapabilityNodeHandler,
  ExecutionJournal,
  WorkflowErrorState,
  WorkflowInputEvent,
  WorkflowNodeAttempt,
  WorkflowNodeJournal,
  WorkflowRunStatus,
  WorkflowRuntime,
  WorkflowSpec,
  WorkflowStepSpec,
} from './types.js';

export interface InMemoryWorkflowRuntimeOptions {
  registry: CapabilityRegistry;
  clock?: () => string;
}

export class InMemoryWorkflowRuntime implements WorkflowRuntime {
  private readonly registry: CapabilityRegistry;
  private readonly singleFlight = new SingleFlight<ExecutionJournal>();
  private readonly journals = new Map<string, ExecutionJournal>();
  private readonly clock: () => string;

  constructor(options: InMemoryWorkflowRuntimeOptions) {
    this.registry = options.registry;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async execute(
    workflow: WorkflowSpec,
    input_event: WorkflowInputEvent,
  ): Promise<ExecutionJournal> {
    validateWorkflow(workflow, input_event);
    const scope = workflowIdempotencyScope(workflow.id, workflow.idempotency_key);
    const existing = this.journals.get(scope);
    if (existing) return cloneJournal(existing);

    return this.singleFlight.run(scope, async () => {
      const racedExisting = this.journals.get(scope);
      if (racedExisting) return cloneJournal(racedExisting);

      const journal = this.createJournal(workflow, input_event);
      for (const step of workflow.steps) {
        const node = nodeForStep(step);
        journal.node_states.push(node);

        if (journal.status !== 'running') {
          node.status = 'skipped';
          node.skipped_reason = hasFailedDependency(step, journal)
            ? 'dependency_failure'
            : 'workflow_already_stopped';
          journal.updated_at = this.clock();
          continue;
        }

        if (hasFailedDependency(step, journal)) {
          node.status = 'skipped';
          node.skipped_reason = 'dependency_failure';
          journal.updated_at = this.clock();
          continue;
        }

        await this.executeStep(workflow, input_event, journal, step, node);
        journal.artifact_refs.push(...node.artifact_refs);
        journal.status = nextWorkflowStatus(journal.status, node.status);
        journal.updated_at = this.clock();
      }

      if (journal.status === 'running') journal.status = 'completed';
      journal.attempts = journal.node_states.reduce((sum, node) => sum + node.attempts.length, 0);
      journal.error = journal.node_states.find((node) => node.error)?.error;
      journal.updated_at = this.clock();
      this.journals.set(scope, cloneJournal(journal));
      return cloneJournal(journal);
    });
  }

  replay(journal: ExecutionJournal): ExecutionJournal {
    return {
      ...cloneJournal(journal),
      replay_of: journal.workflow_run_id,
    };
  }

  private createJournal(workflow: WorkflowSpec, input_event: WorkflowInputEvent): ExecutionJournal {
    const now = this.clock();
    return {
      workflow_run_id: workflowRunId(workflow.id, workflow.idempotency_key),
      workflow_id: workflow.id,
      idempotency_key: workflow.idempotency_key,
      input_event,
      status: 'running',
      node_states: [],
      artifact_refs: [],
      attempts: 0,
      created_at: now,
      updated_at: now,
    };
  }

  private async executeStep(
    workflow: WorkflowSpec,
    input_event: WorkflowInputEvent,
    journal: ExecutionJournal,
    step: WorkflowStepSpec,
    node: WorkflowNodeJournal,
  ): Promise<void> {
    const operation = `${step.capability}.${step.operation}`;
    let handler: CapabilityNodeHandler;
    try {
      handler = this.registry.get(operation);
    } catch (error) {
      if (!(error instanceof CapabilityUnavailableError)) throw error;
      const now = this.clock();
      const errorState = workflowError('capability_unavailable', error.message, false);
      node.status = 'capability_unavailable';
      node.error = errorState;
      node.attempts.push({
        attempt: 1,
        started_at: now,
        completed_at: now,
        status: 'capability_unavailable',
        error: errorState,
      });
      return;
    }

    const maxAttempts = Math.max(step.retry_policy?.max_attempts ?? 1, 1);
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const attempt: WorkflowNodeAttempt = {
        attempt: attemptNumber,
        started_at: this.clock(),
        status: 'running',
      };
      node.status = 'running';
      node.attempts.push(attempt);

      const result = await invokeHandler(handler, {
        workflow,
        step,
        input_event,
        input: step.input_from_event ? input_event.payload : (step.input ?? {}),
        journal,
      });
      applyResult(node, attempt, result, this.clock());
      if (result.status !== 'retryable_failure' || attemptNumber === maxAttempts) return;
    }
  }
}

function validateWorkflow(workflow: WorkflowSpec, input_event: WorkflowInputEvent): void {
  if (workflow.tier !== 'A') throw new Error('Workflow runtime only accepts backend specs.');
  if (workflow.trigger.event !== input_event.type) {
    throw new Error(
      `Workflow '${workflow.id}' expects event '${workflow.trigger.event}', got '${input_event.type}'.`,
    );
  }
  validateStepDependencies(workflow);
}

/**
 * Static graph validation, BEFORE any node runs (fail-closed). Without it a `depends_on` typo or a
 * forward reference resolved to `undefined` in hasFailedDependency, which the runtime silently
 * `skipped` while still reporting the run `completed`. The runtime executes steps in declaration
 * order (workflow-spec-contract.md: "Ordered capability nodes"; depends_on = "node ids that must
 * complete first"), so a dependency declared later can never be satisfied. We reject both an unknown
 * reference and a forward/self reference rather than build a topological scheduler here.
 *
 * EXPORTED: the DURABLE workflow engine reuses this exact check so both executors reject
 * unknown/forward/self (and therefore cyclic) `depends_on` at RUN time — the parser front-stops them
 * and the bridge validator checks membership only, so this run-time gate is the last,
 * shared fail-closed line for a code-built spec that bypassed both. Rejecting forward references
 * makes a cycle unrepresentable (a cycle requires a back-edge that is a forward reference here).
 */
export function validateStepDependencies(workflow: WorkflowSpec): void {
  const declaredIds = new Set(workflow.steps.map((step) => step.id));
  const seenBefore = new Set<string>();
  for (const step of workflow.steps) {
    for (const dependency of step.depends_on ?? []) {
      if (!declaredIds.has(dependency)) {
        throw new Error(
          `Workflow '${workflow.id}' step '${step.id}' depends on unknown step '${dependency}'.`,
        );
      }
      if (!seenBefore.has(dependency)) {
        throw new Error(
          `Workflow '${workflow.id}' step '${step.id}' depends on '${dependency}', which is not ` +
            `declared before it; forward references are not supported by the ordered runtime.`,
        );
      }
    }
    seenBefore.add(step.id);
  }
}

function nodeForStep(step: WorkflowStepSpec): WorkflowNodeJournal {
  return {
    node_id: step.id,
    capability: step.capability,
    operation: step.operation,
    status: 'pending',
    attempts: [],
    artifact_refs: [],
  };
}

function hasFailedDependency(step: WorkflowStepSpec, journal: ExecutionJournal): boolean {
  const dependencies = step.depends_on ?? [];
  return dependencies.some((dependency) => {
    const node = journal.node_states.find((candidate) => candidate.node_id === dependency);
    return node?.status !== 'completed';
  });
}

function nextWorkflowStatus(
  current: WorkflowRunStatus,
  nodeStatus: WorkflowNodeJournal['status'],
): WorkflowRunStatus {
  if (current !== 'running') return current;
  if (nodeStatus === 'paused') return 'paused';
  if (nodeStatus === 'retryable_failure') return 'retryable_failure';
  if (nodeStatus === 'terminal_failure' || nodeStatus === 'capability_unavailable') {
    return 'terminal_failure';
  }
  return 'running';
}

async function invokeHandler(
  handler: Parameters<CapabilityRegistry['register']>[1],
  context: Parameters<Parameters<CapabilityRegistry['register']>[1]>[0],
): Promise<CapabilityInvocationResult> {
  try {
    return await handler(context);
  } catch (error) {
    return {
      status: 'terminal_failure',
      error: workflowError('capability_exception', errorMessage(error), false),
    };
  }
}

function applyResult(
  node: WorkflowNodeJournal,
  attempt: WorkflowNodeAttempt,
  result: CapabilityInvocationResult,
  completedAt: string,
): void {
  attempt.completed_at = completedAt;
  attempt.status = result.status;
  if (result.artifact_refs) node.artifact_refs.push(...result.artifact_refs);
  if (result.status === 'completed') {
    node.status = 'completed';
    return;
  }

  // `paused` is a resumable wait-state, not a failure (failure-semantics.md). A wait-state with no
  // error must NOT fabricate one — the run pauses cleanly and node/attempt/run errors stay unset.
  if (result.status === 'paused' && !result.error) {
    node.status = 'paused';
    return;
  }

  const error =
    result.error ??
    workflowError(
      result.status,
      `Capability node '${node.node_id}' returned ${result.status}.`,
      false,
    );
  node.status = result.status;
  node.error = error;
  attempt.error = error;
}

function workflowError(code: string, message: string, retryable: boolean): WorkflowErrorState {
  return { code, message, retryable };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneJournal(journal: ExecutionJournal): ExecutionJournal {
  return structuredClone(journal);
}
