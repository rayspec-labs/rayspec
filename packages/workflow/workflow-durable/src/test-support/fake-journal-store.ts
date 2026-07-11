import type {
  DurableNodeState,
  DurableWorkflowRun,
  WorkflowJournalStore,
  WorkflowRunFinalizePatch,
  WorkflowRunHeaderInput,
  WorkflowRunView,
} from '../types.js';

/**
 * An in-memory `WorkflowJournalStore` for engine unit tests. It REPRODUCES THE REAL CONSTRAINTS so a
 * test proves behaviour, not a shape (a fake must enforce the real constraint, or it proves nothing):
 *  - `ensureRun` is SINGLE-FLIGHT on the run id (the PK): a second ensureRun for the same id returns
 *    the existing header with `created:false` (never a second run) — the single-flight the real
 *    store gets from the UNIQUE(tenant, workflow, idempotency) index / deterministic PK.
 *  - `upsertNodeState` enforces ONE ROW PER (run, node) (the UNIQUE index): a re-write of the same node
 *    OVERWRITES (the resume/retry memoization boundary), it does not append a duplicate.
 * State is a deep clone on the way in AND out so a test can't mutate the store's copy by reference.
 */
export class FakeWorkflowJournalStore implements WorkflowJournalStore {
  private readonly runs = new Map<string, DurableWorkflowRun>();
  private readonly nodes = new Map<string, Map<string, DurableNodeState>>();

  constructor(private readonly tenantId = '00000000-0000-0000-0000-0000000000fa') {}

  async ensureRun(
    header: WorkflowRunHeaderInput,
  ): Promise<{ run: DurableWorkflowRun; created: boolean }> {
    const existing = this.runs.get(header.workflowRunId);
    if (existing) return { run: structuredClone(existing), created: false };
    const now = new Date().toISOString();
    const run: DurableWorkflowRun = {
      workflowRunId: header.workflowRunId,
      tenantId: this.tenantId,
      workflowId: header.workflowId,
      idempotencyKey: header.idempotencyKey,
      triggerEvent: header.triggerEvent,
      inputEvent: header.inputEvent,
      status: 'running',
      resumable: false,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(header.workflowRunId, run);
    this.nodes.set(header.workflowRunId, new Map());
    return { run: structuredClone(run), created: true };
  }

  async loadRun(workflowRunId: string): Promise<WorkflowRunView | undefined> {
    const run = this.runs.get(workflowRunId);
    if (!run) return undefined;
    const nodeMap = this.nodes.get(workflowRunId) ?? new Map();
    const nodes = [...nodeMap.values()].sort((a, b) => a.position - b.position);
    return { run: structuredClone(run), nodes: structuredClone(nodes) };
  }

  async upsertNodeState(workflowRunId: string, node: DurableNodeState): Promise<void> {
    const nodeMap = this.nodes.get(workflowRunId);
    if (!nodeMap)
      throw new Error(`FakeWorkflowJournalStore: no run '${workflowRunId}' for node upsert`);
    // ONE ROW PER (run, node): a re-write OVERWRITES (the UNIQUE index behaviour), never appends.
    nodeMap.set(node.nodeId, structuredClone(node));
  }

  async finalizeRun(workflowRunId: string, patch: WorkflowRunFinalizePatch): Promise<void> {
    const run = this.runs.get(workflowRunId);
    if (!run) throw new Error(`FakeWorkflowJournalStore: no run '${workflowRunId}' to finalize`);
    run.status = patch.status;
    run.resumable = patch.resumable;
    run.error = patch.error;
    run.attempts = patch.attempts;
    run.updatedAt = new Date().toISOString();
  }
}
