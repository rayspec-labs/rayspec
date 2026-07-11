/**
 * `DurableWorkflowEngine` — the Tier A DURABLE workflow execution spine.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It wires the reviewed in-memory `@rayspec/foundation` semantics (ordered nodes, capability
 * registry, failure-state classification, forward/cyclic depends_on rejection) onto the REAL platform
 * primitives: it JOURNALS every run + node to Postgres via a `WorkflowJournalStore` (tenant-scoped
 * through the TenantDb chokepoint), threads typed artifacts between nodes, applies the full failure
 * semantics (retry / repair / drop / quarantine / fail — fail-closed default `fail`), and RESUMES from
 * its own journal (a completed node is NEVER re-run). The DURABILITY + SINGLE-FLIGHT come from wrapping
 * one `execute()` call in a DBOS durable workflow (see `@rayspec/durable-dbos`
 * `DbosWorkflowExecutor`): the DBOS `workflowID` is the tenant-namespaced `durableWorkflowRunId`, so a
 * redelivered/concurrent start is deduped to one run, and a crash re-invokes `execute()`, which
 * journal-resumes at the first non-completed node.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HONEST DURABILITY CONTRACT (do not oversell).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  - A COMPLETED node is never re-run: its state + memoized `output` are read from the journal and its
 *    artifacts are re-threaded to downstream nodes (deterministic resume).
 *  - A crash mid-run re-invokes `execute()` (DBOS recovery) which resumes at the first non-completed
 *    node — REAL node-granularity resume (better than the whole-run re-execution of the agent path).
 *  - A node interrupted MID-EXECUTION (process dies after its side effect fired but before its journal
 *    row commits) is RE-RUN on resume (at-least-once for that one node). So node handlers must be
 *    idempotent or self-guard: capability nodes carry an idempotency key, store_write is a
 *    content-addressed get-or-create (idempotent), and the AGENT node self-guards EXPLICITLY — before
 *    (re-)invoking `runAgent` it ATTACHES to a prior COMPLETED sub-run (never
 *    re-running) and QUARANTINES a sub-run that fired a non-idempotent tool but did not complete (the
 *    `run_taint` marker, `agent_rerun_hazard`). `runAgent` does NOT self-dedup a fresh sub-run id, so the
 *    guard lives in the agent node, and the engine parks the hazard REGARDLESS of the node's
 *    failure_policy (see `#applyFailurePolicy`).
 *  - The journal `ensureRun` single-flight dedups REDELIVERY / sequential re-entry; true CONCURRENCY
 *    control is the DBOS `workflowID` law (one workflow per run id). A non-DBOS caller that invokes
 *    `execute()` concurrently for the same run id is out of contract (the durable path never does).
 */
import {
  type ArtifactRef,
  type CapabilityInvocationContext,
  type CapabilityInvocationResult,
  type CapabilityNodeHandler,
  type CapabilityRegistry,
  CapabilityUnavailableError,
  type ExecutionJournal,
  validateStepDependencies,
  type WorkflowErrorState,
  type WorkflowInputEvent,
  type WorkflowNodeAttempt,
  type WorkflowNodeStatus,
  type WorkflowRunStatus,
  type WorkflowSpec,
  type WorkflowStepSpec,
} from '@rayspec/foundation';
import { durableWorkflowRunId } from './ids.js';
import type {
  DurableNodeState,
  RepairHandler,
  WorkflowJournalStore,
  WorkflowRunView,
} from './types.js';

/** The provenance tag recorded on a node the durable engine produced. */
export const WORKFLOW_DURABLE_PRODUCED_BY = 'workflow-durable';

/**
 * The error code an agent node returns when a resume would RE-FIRE a non-idempotent tool
 * (a prior sub-run fired one but did not complete). The engine treats it as a HARD quarantine that
 * OVERRIDES the node's declared `failure_policy` (a side effect already fired — dropping/repairing/
 * failing it would hide the hazard). Shared between the agent node (producer) and the engine (consumer).
 */
export const AGENT_RERUN_HAZARD_CODE = 'agent_rerun_hazard';

/**
 * The `skippedReason` the engine records when a node is skipped because the run had already HALTED
 * (a `fail`-policy upstream failed). Unlike a `dependency_failure`/`quarantined_upstream` skip, this one
 * is TRANSIENT: on resume the halting upstream may re-run and complete, so the node must be re-evaluated
 * rather than reused. Shared between the producer (the run-halt skip) and the resume consumer
 * (`isTransientRunHaltSkip`) so the two can never drift.
 */
export const WORKFLOW_ALREADY_STOPPED_REASON = 'workflow_already_stopped';

export interface DurableWorkflowEngineDeps {
  /** The durable journal store (TenantDb-backed in production; a fake enforcing the same UNIQUE in tests). */
  readonly journal: WorkflowJournalStore;
  /** The composed capability registry: operation id → handler (capability/agent/validate/store nodes). */
  readonly registry: CapabilityRegistry;
  /** The server-derived tenant the run executes under (for the tenant-namespaced run id). */
  readonly tenantId: string;
  /** Declared repair hooks by `repair.ref`. A `failure_policy:'repair'` node with no repairer fails loud. */
  readonly repairers?: ReadonlyMap<string, RepairHandler>;
  /** Injectable clock for deterministic tests (ISO string). */
  readonly clock?: () => string;
}

export interface WorkflowExecutionInput {
  readonly workflow: WorkflowSpec;
  readonly event: WorkflowInputEvent;
  /** Overrides `workflow.idempotency_key` (the single-flight scope). Defaults to it. */
  readonly idempotencyKey?: string;
}

/** The per-node outcome the engine computes before persisting the node journal row. */
interface NodeOutcome {
  status: WorkflowNodeStatus;
  attempts: WorkflowNodeAttempt[];
  artifactRefs: ArtifactRef[];
  output: unknown;
  error?: WorkflowErrorState;
  skippedReason?: string;
}

export class DurableWorkflowEngine {
  readonly #deps: DurableWorkflowEngineDeps;
  readonly #clock: () => string;

  constructor(deps: DurableWorkflowEngineDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => new Date().toISOString());
  }

  /**
   * Execute (or RESUME) a workflow run durably. Idempotent by the tenant-namespaced run id: a terminal
   * run is returned as-is (dedup/replay), a crashed 'running' run resumes at the first non-completed
   * node. Returns the full run view (header + node journal).
   */
  async execute(input: WorkflowExecutionInput): Promise<WorkflowRunView> {
    const { workflow, event } = input;

    // ── Fail-closed graph validation BEFORE the run exists ────────────────────────────────────────
    // Reject an unknown / forward / self (⇒ cyclic) depends_on at RUN time via the SAME check the
    // in-memory foundation executor uses — the parser front-stops these and the bridge
    // validator checks membership only, so this is the last shared fail-closed line for a code-built
    // spec that bypassed both. Also reject a trigger/event mismatch. Throwing here means an invalid
    // spec NEVER creates a run header.
    if (workflow.tier !== 'A')
      throw new Error('DurableWorkflowEngine: only backend specs are accepted.');
    if (workflow.trigger.event !== event.type) {
      throw new Error(
        `DurableWorkflowEngine: workflow '${workflow.id}' expects event '${workflow.trigger.event}', ` +
          `got '${event.type}'.`,
      );
    }
    validateStepDependencies(workflow);

    const idempotencyKey = input.idempotencyKey ?? workflow.idempotency_key;
    const workflowRunId = durableWorkflowRunId(this.#deps.tenantId, workflow.id, idempotencyKey);

    // ── Single-flight create-or-get the run header ────────────────────────────────────────────────
    const { run, created } = await this.#deps.journal.ensureRun({
      workflowRunId,
      workflowId: workflow.id,
      idempotencyKey,
      triggerEvent: workflow.trigger.event,
      inputEvent: event,
    });

    // A pre-existing run that is NOT mid-crash ('running') is TERMINAL for automatic re-entry — dedup:
    // completed / terminal_failure / retryable_failure / paused / quarantined are all returned as-is
    // (a paused/quarantined run resumes only via an explicit operator action, not auto re-execute).
    if (!created && run.status !== 'running') {
      const view = await this.#deps.journal.loadRun(workflowRunId);
      if (view) return view;
    }

    // ── Load persisted node states for RESUME (a completed node is never re-run) ───────────────────
    const existingView = await this.#deps.journal.loadRun(workflowRunId);
    const priorNodes = new Map<string, DurableNodeState>(
      (existingView?.nodes ?? []).map((n) => [n.nodeId, n]),
    );

    // The running artifact context threaded to downstream nodes. Pre-load artifacts of already-completed
    // nodes so a resumed run sees the same upstream outputs it would have on the first pass.
    const artifacts: ArtifactRef[] = [];
    for (const node of existingView?.nodes ?? []) {
      if (node.status === 'completed') artifacts.push(...node.artifactRefs);
    }

    // A lightweight in-progress journal handed to handlers (some handlers read the run id / step).
    const runningJournal = this.#emptyJournal(workflowRunId, workflow, idempotencyKey, event);

    const nodeStatuses = new Map<string, WorkflowNodeStatus>();
    for (const [id, n] of priorNodes) nodeStatuses.set(id, n.status);

    let runStopped = false; // a 'fail' terminal / capability_unavailable stops new work (existing behaviour)
    let position = 0;

    for (const step of workflow.steps) {
      const pos = position++;
      const prior = priorNodes.get(step.id);

      // RESUME: a settled node (completed/dropped/skipped/quarantined) is NOT re-run — reuse it.
      // A completed node's artifacts were pre-loaded into `artifacts` above (no double-add here); a
      // quarantined node does NOT stop the whole run — only its dependents are skipped via the
      // dependency gate below (quarantined != completed). EXCEPTION: a `workflow_already_stopped`
      // skip is a TRANSIENT run-halt mark, NOT a terminal outcome — the run had stopped invoking new work
      // in the pass that skipped it, but a later pass may un-stop (a `fail`-policy upstream re-runs and
      // COMPLETES on resume). Such a node is treated as NEVER-STARTED here so it flows back through the
      // run-halt check + dependency gate THIS pass; only a skip that survives to the terminal finalization
      // is final. (A `dependency_failure`/`quarantined_upstream` skip stays settled — its upstream is a
      // settled drop/quarantine that never re-runs, so that skip is genuinely final.)
      if (prior && isSettledForResume(prior.status) && !isTransientRunHaltSkip(prior)) {
        nodeStatuses.set(step.id, prior.status);
        continue;
      }

      // If the run already stopped (a 'fail' terminal upstream), everything after is skipped.
      if (runStopped) {
        const outcome = skippedOutcome(pos, WORKFLOW_ALREADY_STOPPED_REASON);
        await this.#persistNode(workflowRunId, step, pos, outcome);
        nodeStatuses.set(step.id, 'skipped');
        continue;
      }

      // Dependency gate: a node runs only if every dependency COMPLETED. A dependency that dropped /
      // quarantined / failed / skipped means this node is SKIPPED (fail-closed — a missing upstream
      // output can never satisfy a dependent). A quarantined upstream parks its dependents too.
      const depSkip = dependencySkipReason(step, nodeStatuses);
      if (depSkip) {
        const outcome = skippedOutcome(pos, depSkip);
        await this.#persistNode(workflowRunId, step, pos, outcome);
        nodeStatuses.set(step.id, 'skipped');
        continue;
      }

      // Mark the node running (crash-observability: a crash mid-node leaves a 'running' row).
      await this.#persistNode(workflowRunId, step, pos, {
        status: 'running',
        attempts: [],
        artifactRefs: [],
        output: null,
      });

      const outcome = await this.#runNode(workflow, step, pos, runningJournal, event, artifacts);
      await this.#persistNode(workflowRunId, step, pos, outcome);
      nodeStatuses.set(step.id, outcome.status);
      if (outcome.status === 'completed') artifacts.push(...outcome.artifactRefs);

      // A 'fail' terminal stops NEW work — INCLUDING an INDEPENDENT not-yet-started node. The
      // `fail` policy (fail-closed default) means "the run stops invoking new work", so ANY of its failed
      // outcomes halts scheduling: terminal_failure, capability_unavailable, AND a retry-EXHAUSTED
      // `retryable_failure` (which ONLY arises from the `fail` policy — drop→dropped, quarantine→
      // quarantined, repair→completed/terminal — so treating it as a stop can never mis-halt a drop/
      // quarantine branch). drop/quarantine do NOT stop the run (the graph decides via the dependency
      // gate); a downstream node after a halt is journaled `skipped` with `workflow_already_stopped`.
      if (
        outcome.status === 'terminal_failure' ||
        outcome.status === 'capability_unavailable' ||
        outcome.status === 'retryable_failure'
      ) {
        runStopped = true;
      }
    }

    // ── Compute + persist the final run status ────────────────────────────────────────────────────
    const finalView = await this.#deps.journal.loadRun(workflowRunId);
    const nodes = finalView?.nodes ?? [];
    const status = computeRunStatus(nodes.map((n) => n.status));
    const attempts = nodes.reduce((sum, n) => sum + n.attemptCount, 0);
    const firstError = nodes.find((n) => n.error)?.error;
    const resumable = status === 'paused' || status === 'quarantined';
    await this.#deps.journal.finalizeRun(workflowRunId, {
      status,
      resumable,
      ...(firstError ? { error: firstError } : {}),
      attempts,
    });

    const view = await this.#deps.journal.loadRun(workflowRunId);
    if (!view) throw new Error('workflow-durable: run view vanished after finalize');
    return view;
  }

  /** Run one node: resolve handler → retry loop → failure policy (drop/quarantine/repair/fail). */
  async #runNode(
    workflow: WorkflowSpec,
    step: WorkflowStepSpec,
    position: number,
    journal: ExecutionJournal,
    event: WorkflowInputEvent,
    artifacts: ArtifactRef[],
  ): Promise<NodeOutcome> {
    const operation = `${step.capability}.${step.operation}`;
    let handler: CapabilityNodeHandler;
    try {
      handler = this.#deps.registry.get(operation);
    } catch (error) {
      if (!(error instanceof CapabilityUnavailableError)) throw error;
      // A missing capability is a DEPLOY error — terminal-unavailable, NOT rescued by failure_policy.
      const now = this.#clock();
      const errorState = workflowError('capability_unavailable', error.message, false);
      return {
        status: 'capability_unavailable',
        attempts: [
          {
            attempt: 1,
            started_at: now,
            completed_at: now,
            status: 'capability_unavailable',
            error: errorState,
          },
        ],
        artifactRefs: [],
        output: null,
        error: errorState,
      };
    }

    const context: CapabilityInvocationContext = {
      workflow,
      step,
      input_event: event,
      input: step.input_from_event ? event.payload : (step.input ?? {}),
      journal,
      // A SNAPSHOT of the upstream artifacts at invocation time — NOT the live array run-core keeps
      // pushing into. A handler that stashes `ctx.artifacts` must see a stable view of its
      // dependencies' outputs, not this node's (or a later node's) artifacts appended afterwards.
      artifacts: [...artifacts],
    };

    const maxAttempts = Math.max(step.retry_policy?.max_attempts ?? 1, 1);
    const attempts: WorkflowNodeAttempt[] = [];
    let lastResult: CapabilityInvocationResult | undefined;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const startedAt = this.#clock();
      const attempt: WorkflowNodeAttempt = {
        attempt: attemptNumber,
        started_at: startedAt,
        status: 'running',
      };
      attempts.push(attempt);
      lastResult = await invokeHandler(handler, context);
      attempt.completed_at = this.#clock();
      attempt.status = lastResult.status;
      if (lastResult.status !== 'completed' && lastResult.status !== 'paused' && lastResult.error) {
        attempt.error = lastResult.error;
      }

      if (lastResult.status === 'completed') {
        return {
          status: 'completed',
          attempts,
          artifactRefs: lastResult.artifact_refs ?? [],
          output: lastResult.output ?? null,
        };
      }
      if (lastResult.status === 'paused') {
        return {
          status: 'paused',
          attempts,
          artifactRefs: lastResult.artifact_refs ?? [],
          output: null,
        };
      }
      // retryable_failure: retry within the policy; terminal_failure: break to the failure policy.
      if (lastResult.status === 'retryable_failure' && attemptNumber < maxAttempts) {
        const backoff = step.retry_policy?.backoff_ms;
        if (backoff && backoff > 0) await sleep(backoff);
        continue;
      }
      break; // terminal_failure, or a retryable_failure that exhausted its attempts
    }

    // The node ultimately FAILED. Apply the terminal failure policy (fail-closed default `fail`).
    return this.#applyFailurePolicy(step, position, context, attempts, lastResult);
  }

  /** Apply a failed node's terminal failure_policy: fail | drop | quarantine | repair (default fail). */
  async #applyFailurePolicy(
    step: WorkflowStepSpec,
    _position: number,
    context: CapabilityInvocationContext,
    attempts: WorkflowNodeAttempt[],
    lastResult: CapabilityInvocationResult | undefined,
  ): Promise<NodeOutcome> {
    const policy = step.failure_policy ?? 'fail';
    const lastFailureStatus: WorkflowNodeStatus =
      lastResult?.status === 'retryable_failure' ? 'retryable_failure' : 'terminal_failure';
    const error =
      lastResult && lastResult.status !== 'completed' && lastResult.status !== 'paused'
        ? (lastResult.error ??
          workflowError(
            lastFailureStatus,
            `node '${step.id}' returned ${lastResult.status}.`,
            false,
          ))
        : workflowError('terminal_failure', `node '${step.id}' failed with no result.`, false);

    // An agent-rerun hazard is a HARD safety quarantine that OVERRIDES the declared
    // failure_policy. A side effect already fired on a prior sub-run; letting `drop`/`repair`/`fail`
    // handle it would HIDE the hazard (drop = silently continue; fail = re-runnable). Park it always
    // (+ resumable) so it surfaces for manual review, regardless of what the node declared.
    if (error.code === AGENT_RERUN_HAZARD_CODE) {
      return { status: 'quarantined', attempts, artifactRefs: [], output: null, error };
    }

    if (policy === 'drop') {
      // DROP: journal the node dropped; the run CONTINUES where the graph allows. A dropped node's
      // output is ABSENT, so a dependent is still skipped via the dependency gate (fail-closed).
      return { status: 'dropped', attempts, artifactRefs: [], output: null, error };
    }
    if (policy === 'quarantine') {
      // QUARANTINE: park the node (+ its dependents via the dependency gate); the run is marked
      // quarantined + resumable (a durable marker a later worker/operator resumes from).
      return { status: 'quarantined', attempts, artifactRefs: [], output: null, error };
    }
    if (policy === 'repair') {
      return this.#applyRepair(step, context, attempts, lastResult, error);
    }
    // FAIL (default): the node's status is the last failure status (terminal_failure or, if the
    // handler kept returning retryable_failure until exhaustion, retryable_failure — a worker may retry).
    return { status: lastFailureStatus, attempts, artifactRefs: [], output: null, error };
  }

  /** `failure_policy: 'repair'` — invoke the declared repairer, or fail loud if none is wired. */
  async #applyRepair(
    step: WorkflowStepSpec,
    context: CapabilityInvocationContext,
    attempts: WorkflowNodeAttempt[],
    lastResult: CapabilityInvocationResult | undefined,
    failureError: WorkflowErrorState,
  ): Promise<NodeOutcome> {
    const ref = step.repair?.ref;
    const repairer = ref ? this.#deps.repairers?.get(ref) : undefined;
    if (!repairer) {
      // The declared-but-inert repair hook: an explicit, LOUD "repair not wired" terminal failure —
      // never a silent pass. A node with failure_policy:'repair' and no resolvable repairer fails.
      const error = workflowError(
        'repair_not_wired',
        ref
          ? `node '${step.id}' declares failure_policy:'repair' with repair.ref '${ref}', but no repairer ` +
              'is registered for that id (the repair hook is declared-but-inert). Fail-closed.'
          : `node '${step.id}' declares failure_policy:'repair' but no repair.ref — no repairer to invoke. Fail-closed.`,
        false,
      );
      return { status: 'terminal_failure', attempts, artifactRefs: [], output: null, error };
    }
    const failure = lastResult ?? { status: 'terminal_failure', error: failureError };
    let repaired: CapabilityInvocationResult;
    try {
      repaired = await repairer(context, failure);
    } catch (e) {
      const error = workflowError(
        'repair_failed',
        `repair hook '${ref}' threw: ${errMsg(e)}`,
        false,
      );
      return { status: 'terminal_failure', attempts, artifactRefs: [], output: null, error };
    }
    if (repaired.status === 'completed') {
      return {
        status: 'completed',
        attempts,
        artifactRefs: repaired.artifact_refs ?? [],
        output: repaired.output ?? null,
      };
    }
    // The repair itself failed — fail-closed (no repair loop). The node is terminal.
    const error =
      repaired.status !== 'paused'
        ? (repaired.error ??
          workflowError('repair_failed', `repair hook '${ref}' did not repair the node.`, false))
        : workflowError(
            'repair_failed',
            `repair hook '${ref}' returned paused — not a repair outcome.`,
            false,
          );
    return { status: 'terminal_failure', attempts, artifactRefs: [], output: null, error };
  }

  async #persistNode(
    workflowRunId: string,
    step: WorkflowStepSpec,
    position: number,
    outcome: NodeOutcome,
  ): Promise<void> {
    await this.#deps.journal.upsertNodeState(workflowRunId, {
      nodeId: step.id,
      position,
      capability: step.capability,
      operation: step.operation,
      status: outcome.status,
      attempts: outcome.attempts,
      attemptCount: outcome.attempts.length,
      artifactRefs: outcome.artifactRefs,
      output: outcome.output,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.skippedReason ? { skippedReason: outcome.skippedReason } : {}),
      producedBy: WORKFLOW_DURABLE_PRODUCED_BY,
      costUsd: 0,
    });
  }

  #emptyJournal(
    workflowRunId: string,
    workflow: WorkflowSpec,
    idempotencyKey: string,
    event: WorkflowInputEvent,
  ): ExecutionJournal {
    const now = this.#clock();
    return {
      workflow_run_id: workflowRunId,
      workflow_id: workflow.id,
      idempotency_key: idempotencyKey,
      input_event: event,
      status: 'running',
      node_states: [],
      artifact_refs: [],
      attempts: 0,
      created_at: now,
      updated_at: now,
    };
  }
}

// ── pure helpers ────────────────────────────────────────────────────────────────────────────────

/** Node statuses that are SETTLED for resume — never re-run (their output/artifacts are reused). */
function isSettledForResume(status: WorkflowNodeStatus): boolean {
  return (
    status === 'completed' ||
    status === 'dropped' ||
    status === 'skipped' ||
    status === 'quarantined'
  );
}

/**
 * A node that was skipped ONLY because the run had already HALTED (`workflow_already_stopped`) — a
 * TRANSIENT mark, not a terminal outcome. On resume the halting `fail`-policy upstream may re-run and
 * complete, un-stopping the run, so such a node must be RE-EVALUATED (treated as never-started) this pass
 * rather than reused as a settled skip. A `dependency_failure`/`quarantined_upstream` skip is NOT
 * transient: its upstream is a settled drop/quarantine that never re-runs (see `dependencySkipReason`).
 */
function isTransientRunHaltSkip(node: DurableNodeState): boolean {
  return node.status === 'skipped' && node.skippedReason === WORKFLOW_ALREADY_STOPPED_REASON;
}

/**
 * A node is SKIPPED unless every dependency COMPLETED. Returns the skip reason (or undefined if the
 * node may run). A quarantined upstream yields `quarantined_upstream`; any other non-completed upstream
 * yields `dependency_failure` (fail-closed — a missing upstream output can never satisfy a dependent).
 */
function dependencySkipReason(
  step: WorkflowStepSpec,
  statuses: Map<string, WorkflowNodeStatus>,
): string | undefined {
  for (const dep of step.depends_on ?? []) {
    const s = statuses.get(dep);
    if (s === 'completed') continue;
    if (s === 'quarantined') return 'quarantined_upstream';
    return 'dependency_failure';
  }
  return undefined;
}

function skippedOutcome(_position: number, reason: string): NodeOutcome {
  return { status: 'skipped', attempts: [], artifactRefs: [], output: null, skippedReason: reason };
}

/**
 * The run's status from its node statuses (precedence): a terminal_failure / capability_unavailable →
 * terminal_failure; else a quarantined node → quarantined; else a paused node → paused; else a
 * retryable_failure → retryable_failure; else completed. A dropped/skipped node does NOT by itself
 * fail the run (drop = continue; skip = a downstream gap). An empty run is completed.
 */
export function computeRunStatus(nodeStatuses: WorkflowNodeStatus[]): WorkflowRunStatus {
  if (nodeStatuses.some((s) => s === 'terminal_failure' || s === 'capability_unavailable')) {
    return 'terminal_failure';
  }
  if (nodeStatuses.some((s) => s === 'quarantined')) return 'quarantined';
  if (nodeStatuses.some((s) => s === 'paused')) return 'paused';
  if (nodeStatuses.some((s) => s === 'retryable_failure')) return 'retryable_failure';
  return 'completed';
}

async function invokeHandler(
  handler: CapabilityNodeHandler,
  context: CapabilityInvocationContext,
): Promise<CapabilityInvocationResult> {
  try {
    return await handler(context);
  } catch (error) {
    return {
      status: 'terminal_failure',
      error: workflowError('capability_exception', errMsg(error), false),
    };
  }
}

function workflowError(code: string, message: string, retryable: boolean): WorkflowErrorState {
  return { code, message, retryable };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
