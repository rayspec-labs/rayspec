/**
 * The per-workforce runtime row — declared ceilings + operator control state, ONE row per
 * (tenant, workforce id). Created on first use through `ensureWorkforceRuntime` (an idempotent
 * upsert on the UNIQUE (tenant_id, workforce_id) key), read fail-closed everywhere else: an engine
 * path that cannot find the runtime row refuses rather than assuming defaults, because a missing
 * row means nobody ever declared what this workforce may spend.
 */
import { schema, type TenantDb } from '@rayspec/db';
import { eq, sql } from 'drizzle-orm';
import { WorkforcePausedError, WorkforceUnknownError } from './errors.js';

export type WorkforceRuntimeRecord = typeof schema.workforceRuntime.$inferSelect;

/**
 * The reserved workforce id segments now live in @rayspec/core beside the other closed name sets
 * (spec validation consumes them too, and spec cannot import this package — the db → spec edge
 * direction). Re-exported here so the engine's own consumers (create-task.ts, the HTTP edge) keep
 * their import path; the semantics are unchanged.
 */
export { isReservedWorkforceSegment, RESERVED_WORKFORCE_SEGMENTS } from '@rayspec/core';

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

/**
 * ADMISSION CONTROL: refuse NEW WORK while the operator has this workforce paused, and take the
 * runtime row's lock while deciding so the answer cannot be overtaken.
 *
 * WHY THIS EXISTS. `pauseWorkforce` stops the workforce two ways — the reserve pass skips it, and
 * `#claimTurn` (@rayspec/durable-dbos task-scheduler.ts) refuses the `queued -> working` claim — but
 * neither stops a root from being CREATED. A root born into a paused workforce runs nothing, yet it
 * makes `haltWorkforce`'s `affectedTaskCount` and its "every non-terminal task" claim untrue for
 * that row, and a later resume starts work the operator believed they had stopped. This is the door
 * those two refusals do not cover.
 *
 * IT GATES ON `paused`, NOT ON `halt_reason`, AND THAT IS DELIBERATE. A halt IS a pause — the first
 * act of `haltWorkforce` is `pauseWorkforce(..., drain: true)` — so `paused` already covers both
 * verbs. `halt_reason`/`halted_at` are the HISTORICAL RECORD of the last halt and `resumeWorkforce`
 * does not clear them (it writes `paused`, `paused_at`, `paused_by` and nothing else). Gating on
 * `halt_reason` would therefore keep intake shut FOREVER after the first halt of a workforce's
 * life, with no operator verb able to reopen it. `paused` is the live state; resume means go.
 *
 * WHY THE LOCK, AND NOT A PLAIN READ. The upsert above is a REAL write (`DO NOTHING` would not lock
 * the existing row), so this transaction holds the runtime row's exclusive lock from before it reads
 * `paused` until it commits, and `pauseWorkforce` writes that same row. Two transactions writing one
 * row have a total order, so there are exactly two cases and no third:
 *
 *   1. THIS SUBMISSION GOT THE ROW FIRST — the pause blocks until this transaction commits, so the
 *      new root is committed BEFORE the pause is. A halt reads its roots only after its own pause
 *      has committed, so that scan SEES this root and cancels it: the halt's count stays honest.
 *   2. THE PAUSE GOT IT FIRST — this read sees `paused = true` and throws. The caller's transaction
 *      aborts: no task row, no journal entry, no cost.
 *
 * A plain read would leave case 1 open — the submission could read `paused = false`, then commit
 * AFTER the pause and after the halt's roots scan, which is the original defect rather than a
 * narrowing of it.
 *
 * The upsert is also what makes case 1 hold for a workforce that has NO runtime row yet: two
 * concurrent upserts serialize on the UNIQUE (tenant_id, workforce_id) key, whereas a
 * `SELECT ... FOR UPDATE` locks nothing when there is no row to lock.
 *
 * LOCK RANK: this takes `workforce_runtime` and its caller then writes `workforce_tasks` — the
 * documented rank order (task-scheduler.ts states that rank and names this call site), never an
 * inversion. Call it BEFORE the first task write, in the SAME transaction as that write, or it
 * guarantees nothing.
 */
export async function assertWorkforceAcceptsWork(
  tdb: TenantDb,
  workforceId: string,
): Promise<WorkforceRuntimeRecord> {
  const runtime = await ensureWorkforceRuntime(tdb, workforceId);
  if (runtime.paused) throw new WorkforcePausedError(workforceId);
  return runtime;
}
