import { schema, type TenantDb } from '@rayspec/db';
import type {
  ArtifactRef,
  WorkflowErrorState,
  WorkflowInputEvent,
  WorkflowNodeAttempt,
  WorkflowNodeStatus,
  WorkflowRunStatus,
} from '@rayspec/foundation';
import { eq } from 'drizzle-orm';
import type {
  DurableNodeState,
  DurableWorkflowRun,
  WorkflowJournalStore,
  WorkflowRunFinalizePatch,
  WorkflowRunHeaderInput,
  WorkflowRunView,
} from './types.js';

/**
 * The real durable journal store — persists `workflow_runs` / `workflow_node_states` through the
 * TenantDb chokepoint, so EVERY read/write carries the tenant predicate STRUCTURALLY (a workflow run's
 * header + node journal can never be read/written cross-tenant). It holds ONLY a `TenantDb` (bound to
 * one tenant by the caller) — no raw handle, no `.unscoped()`.
 */
export class TenantDbWorkflowJournalStore implements WorkflowJournalStore {
  constructor(private readonly tdb: TenantDb) {}

  async ensureRun(
    header: WorkflowRunHeaderInput,
  ): Promise<{ run: DurableWorkflowRun; created: boolean }> {
    // Single-flight: the deterministic tenant-namespaced workflowRunId is the PK, so a concurrent
    // / redelivered start of the same (tenant, workflow, idempotency) collides on it. INSERT .. ON
    // CONFLICT DO NOTHING RETURNING — the FIRST caller creates it (created:true); a loser gets [] and
    // reads the existing header (created:false). No in-tx 23505 recovery (single-flight is the fix).
    const inserted = (await this.tdb
      .insert(schema.workflowRuns, {
        workflowRunId: header.workflowRunId,
        workflowId: header.workflowId,
        idempotencyKey: header.idempotencyKey,
        triggerEvent: header.triggerEvent,
        inputEvent: header.inputEvent as unknown as Record<string, unknown>,
        status: 'running',
        resumable: false,
        error: null,
        attempts: '0',
      })
      .onConflictDoNothing()
      .returning()) as unknown[];

    if (inserted.length > 0) {
      const existing = await this.loadRun(header.workflowRunId);
      if (!existing)
        throw new Error('workflow-durable: run header vanished immediately after insert');
      return { run: existing.run, created: true };
    }
    const existing = await this.loadRun(header.workflowRunId);
    if (!existing) {
      throw new Error(
        'workflow-durable: run header insert lost the conflict but no existing row was found ' +
          '(a concurrent delete or a non-idempotent key collision — fail-closed).',
      );
    }
    return { run: existing.run, created: false };
  }

  async loadRun(workflowRunId: string): Promise<WorkflowRunView | undefined> {
    const headerRows = (await this.tdb
      .select(schema.workflowRuns)
      .where(eq(schema.workflowRuns.workflowRunId, workflowRunId))) as unknown as WorkflowRunRow[];
    const header = headerRows[0];
    if (!header) return undefined;

    const nodeRows = (await this.tdb
      .select(schema.workflowNodeStates)
      .where(
        eq(schema.workflowNodeStates.workflowRunId, workflowRunId),
      )) as unknown as WorkflowNodeRow[];

    const nodes = nodeRows.map(rowToNodeState).sort((a, b) => a.position - b.position);
    return { run: rowToRun(header), nodes };
  }

  async upsertNodeState(workflowRunId: string, node: DurableNodeState): Promise<void> {
    const now = new Date();
    await this.tdb
      .insert(schema.workflowNodeStates, {
        workflowRunId,
        nodeId: node.nodeId,
        position: String(node.position),
        capability: node.capability,
        operation: node.operation,
        status: node.status,
        attempts: node.attempts as unknown as Record<string, unknown>,
        attemptCount: String(node.attemptCount),
        artifactRefs: node.artifactRefs as unknown as Record<string, unknown>,
        output: node.output ?? null,
        error: node.error ?? null,
        skippedReason: node.skippedReason ?? null,
        producedBy: node.producedBy ?? null,
        costUsd: String(node.costUsd),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.workflowNodeStates.tenantId,
          schema.workflowNodeStates.workflowRunId,
          schema.workflowNodeStates.nodeId,
        ],
        set: {
          status: node.status,
          position: String(node.position),
          capability: node.capability,
          operation: node.operation,
          attempts: node.attempts as unknown as Record<string, unknown>,
          attemptCount: String(node.attemptCount),
          artifactRefs: node.artifactRefs as unknown as Record<string, unknown>,
          output: node.output ?? null,
          error: node.error ?? null,
          skippedReason: node.skippedReason ?? null,
          producedBy: node.producedBy ?? null,
          costUsd: String(node.costUsd),
          updatedAt: now,
        },
      });
  }

  async finalizeRun(workflowRunId: string, patch: WorkflowRunFinalizePatch): Promise<void> {
    await this.tdb
      .update(schema.workflowRuns, {
        status: patch.status,
        resumable: patch.resumable,
        error: patch.error ?? null,
        attempts: String(patch.attempts),
        updatedAt: new Date(),
      })
      .where(eq(schema.workflowRuns.workflowRunId, workflowRunId));
  }
}

interface WorkflowRunRow {
  workflowRunId: string;
  tenantId: string;
  workflowId: string;
  idempotencyKey: string;
  triggerEvent: string;
  inputEvent: unknown;
  status: string;
  resumable: boolean;
  error: unknown;
  attempts: string;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkflowNodeRow {
  nodeId: string;
  position: string;
  capability: string;
  operation: string;
  status: string;
  attempts: unknown;
  attemptCount: string;
  artifactRefs: unknown;
  output: unknown;
  error: unknown;
  skippedReason: string | null;
  producedBy: string | null;
  costUsd: string;
}

function rowToRun(row: WorkflowRunRow): DurableWorkflowRun {
  return {
    workflowRunId: row.workflowRunId,
    tenantId: row.tenantId,
    workflowId: row.workflowId,
    idempotencyKey: row.idempotencyKey,
    triggerEvent: row.triggerEvent,
    inputEvent: row.inputEvent as WorkflowInputEvent,
    status: row.status as WorkflowRunStatus,
    resumable: row.resumable,
    error: (row.error ?? undefined) as WorkflowErrorState | undefined,
    attempts: Number(row.attempts),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function rowToNodeState(row: WorkflowNodeRow): DurableNodeState {
  return {
    nodeId: row.nodeId,
    position: Number(row.position),
    capability: row.capability,
    operation: row.operation,
    status: row.status as WorkflowNodeStatus,
    attempts: (row.attempts ?? []) as WorkflowNodeAttempt[],
    attemptCount: Number(row.attemptCount),
    artifactRefs: (row.artifactRefs ?? []) as ArtifactRef[],
    output: row.output ?? null,
    error: (row.error ?? undefined) as WorkflowErrorState | undefined,
    skippedReason: row.skippedReason ?? undefined,
    producedBy: row.producedBy ?? undefined,
    costUsd: Number(row.costUsd),
  };
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
