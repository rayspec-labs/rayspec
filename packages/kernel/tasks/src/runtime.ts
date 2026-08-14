/**
 * The per-workforce runtime row — declared ceilings + operator control state, ONE row per
 * (tenant, workforce id). Created on first use through `ensureWorkforceRuntime` (an idempotent
 * upsert on the UNIQUE (tenant_id, workforce_id) key), read fail-closed everywhere else: an engine
 * path that cannot find the runtime row refuses rather than assuming defaults, because a missing
 * row means nobody ever declared what this workforce may spend.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { eq, sql } from 'drizzle-orm';
import { WorkforceUnknownError } from './errors.js';

export type WorkforceRuntimeRecord = typeof schema.workforceRuntime.$inferSelect;

/**
 * Workforce ids the HTTP surface spends on its own collections, so a workforce may not carry one:
 * `/v1/workforce/tasks/:id` and `/v1/workforce/:workforceId/status` are the same shape, and a
 * workforce called `tasks` would answer for the wrong resource. The routes refuse these on the
 * `:workforceId` path — but a refusal at the READ side only produces a workforce that exists and is
 * permanently un-pausable and un-queryable, so the set lives HERE, beside the runtime row, and
 * binds at the one place a workforce id is minted (create-task.ts) as well as at the edge.
 */
export const RESERVED_WORKFORCE_SEGMENTS = ['tasks', 'approvals', 'reviews', 'cost'] as const;

export function isReservedWorkforceSegment(workforceId: string): boolean {
  return (RESERVED_WORKFORCE_SEGMENTS as readonly string[]).includes(workforceId);
}

/** Read the runtime row; a workforce nobody initialized is a typed refusal. */
export async function readWorkforceRuntime(
  tdb: TenantDb,
  workforceId: string,
): Promise<WorkforceRuntimeRecord> {
  const rows = (await tdb
    .select(schema.workforceRuntime)
    .where(eq(schema.workforceRuntime.workforceId, workforceId))) as WorkforceRuntimeRecord[];
  const row = rows[0];
  if (!row) throw new WorkforceUnknownError(workforceId);
  return row;
}

/**
 * Create the runtime row if absent; update the declared budgets when given. The caller passes an
 * ALREADY-VALIDATED budgets object (budget.ts's strict schema) — this function persists, it does
 * not re-interpret. Idempotent under the UNIQUE (tenant_id, workforce_id) key: a concurrent ensure
 * takes the existing row's lock and updates it rather than duplicating.
 */
export async function ensureWorkforceRuntime(
  tdb: TenantDb,
  workforceId: string,
  budgets?: Readonly<Record<string, unknown>>,
): Promise<WorkforceRuntimeRecord> {
  const rows = (await tdb
    .insert(schema.workforceRuntime, {
      workforceId,
      ...(budgets !== undefined ? { budgets } : {}),
    })
    .onConflictDoUpdate({
      target: [schema.workforceRuntime.tenantId, schema.workforceRuntime.workforceId],
      set: {
        // A REAL write — `DO NOTHING` would not lock the existing row, and an empty set throws.
        updatedAt: sql`now()`,
        ...(budgets !== undefined ? { budgets } : {}),
      },
      setWhere: eq(schema.workforceRuntime.tenantId, tdb.tenantId),
    })
    .returning()) as WorkforceRuntimeRecord[];
  const row = rows[0];
  if (!row) throw new WorkforceUnknownError(workforceId);
  return row;
}
