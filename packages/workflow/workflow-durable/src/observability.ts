import { schema, type TenantDb } from '@rayspec/db';
import type { WorkflowNodeStatus, WorkflowRunStatus } from '@rayspec/foundation';
import { desc, eq } from 'drizzle-orm';
import { TenantDbWorkflowJournalStore } from './journal-store.js';
import type { DurableNodeState, WorkflowRunView } from './types.js';

/**
 * The observability read model — a workflow run + its node journal made
 * queryable, tenant-scoped, derived ENTIRELY from the persisted `workflow_runs` / `workflow_node_states`
 * (no new store). Mirrors `@rayspec/platform` `getRunObservability`: a store-level read model the
 * operator/debug surface (or a later declarative view) can serve. Every read goes through the TenantDb
 * chokepoint, so an operator can never read another tenant's workflow run.
 */
export interface WorkflowRunObservability {
  run: WorkflowRunView['run'];
  nodes: DurableNodeState[];
  /** A per-status node count (a compact health summary for a dashboard cell). */
  nodeStatusCounts: Partial<Record<WorkflowNodeStatus, number>>;
  /** True iff the run is in a resumable state (paused / quarantined) a worker/operator can resume. */
  resumable: boolean;
}

/** Load one workflow run's full observability view (undefined if absent for this tenant). */
export async function getWorkflowRunObservability(
  tdb: TenantDb,
  workflowRunId: string,
): Promise<WorkflowRunObservability | undefined> {
  const store = new TenantDbWorkflowJournalStore(tdb);
  const view = await store.loadRun(workflowRunId);
  if (!view) return undefined;
  return {
    run: view.run,
    nodes: view.nodes,
    nodeStatusCounts: countNodeStatuses(view.nodes),
    resumable: view.run.resumable,
  };
}

/** A compact listing row for the run index (tenant-scoped). */
export interface WorkflowRunSummary {
  workflowRunId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  resumable: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * List a tenant's recent workflow runs (newest-first), optionally filtered by status. Tenant-scoped
 * via the chokepoint (`.all()`/`.where()` both carry the tenant predicate).
 */
export async function listWorkflowRuns(
  tdb: TenantDb,
  opts: { status?: WorkflowRunStatus; limit?: number } = {},
): Promise<WorkflowRunSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const builder = tdb.select(schema.workflowRuns);
  const base = opts.status
    ? builder.where(eq(schema.workflowRuns.status, opts.status))
    : builder.all();
  const rows = (await base.orderBy(desc(schema.workflowRuns.createdAt)).limit(limit)) as Array<{
    workflowRunId: string;
    workflowId: string;
    status: string;
    resumable: boolean;
    createdAt: Date | string;
    updatedAt: Date | string;
  }>;
  return rows.map((r) => ({
    workflowRunId: r.workflowRunId,
    workflowId: r.workflowId,
    status: r.status as WorkflowRunStatus,
    resumable: r.resumable,
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
  }));
}

function countNodeStatuses(nodes: DurableNodeState[]): Partial<Record<WorkflowNodeStatus, number>> {
  const counts: Partial<Record<WorkflowNodeStatus, number>> = {};
  for (const node of nodes) {
    counts[node.status] = (counts[node.status] ?? 0) + 1;
  }
  return counts;
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
