import { createHash } from 'node:crypto';

/**
 * Derive the DURABLE workflow-run id — a DETERMINISTIC, TENANT-DISJOINT id for one workflow run.
 *
 * A workflow run's natural identity is `(tenant, workflow_id, idempotency_key)`: re-delivery of the
 * SAME trigger event resolves to the SAME idempotency key, so it must map to the SAME run (the
 * single-flight lesson — one run per shared-keyed scope). But the id must ALSO be tenant-disjoint:
 * two tenants that declare the same `(workflow_id, idempotency_key)` must NOT collide on one run row
 * or one DBOS workflow id (a deterministic id must be tenant-namespaced, else
 * one tenant can dedup its run onto another's). Namespacing by the SERVER-DERIVED tenant makes it
 * disjoint BY CONSTRUCTION: same `(tenant, workflowId, idempotencyKey)` → same id (single-flight +
 * crash reconciliation preserved WITHIN a tenant); different tenant, same key → different id.
 *
 * Formatted as a v5-shaped UUID over a SHA-256 of `${tenantId}:${workflowId}:${idempotencyKey}`
 * (mirrors the run surface's `deterministicTenantRunId` + cron's `cronRunId`) so it reads as a normal
 * UUID while staying a pure function of the inputs. NOT security-sensitive — just a stable,
 * collision-resistant, tenant-disjoint id. It is BOTH the `workflow_runs.workflow_run_id` PK AND the
 * DBOS `workflowID` in the durable path, so single-flight holds at both layers by construction.
 */
export function durableWorkflowRunId(
  tenantId: string,
  workflowId: string,
  idempotencyKey: string,
): string {
  const h = createHash('sha256')
    .update(`${tenantId}:${workflowId}:${idempotencyKey}`)
    .digest('hex');
  // Lay the first 32 hex chars out as a UUID (8-4-4-4-12); set the version nibble to 5 and the variant
  // nibble to 8 so it is a well-formed v5-shaped UUID (cosmetic — determinism + disjointness is the
  // contract, not RFC-4122 namespace semantics).
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
