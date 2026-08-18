/**
 * `renewTurnLease()` — the only write to `workforce_tasks.claim_expires_at` outside
 * `applyTransition`, and the only thing in this module.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE. Do not fold it back into `apply-transition.ts`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `scripts/check-state-machine-exhaustive.mjs` exempts exactly one path from its status-write
 * detector — `UPDATE_MONOPOLY = 'packages/kernel/tasks/src/apply-transition.ts'` (`:56`) — and the
 * exemption is per FILE, not per function: the whole chokepoint / raw-builder / raw-SQL update
 * check sits inside `if (rel !== UPDATE_MONOPOLY)` (`:170`), with no compensating within-file scan
 * (`:456` only asserts the file still exists). That exemption is honest only while the file holds
 * exactly the sanctioned writer. A second `workforce_tasks` writer living there would inherit the
 * exemption silently — its SET could grow a `status:` key in some later edit and `STATUS_KEY_RE`
 * would never see it.
 *
 * So this function lives in a sibling module and stays inside the detector's scan. Nothing about
 * the kernel boundary changes — it is still engine mechanics in `@rayspec/tasks`, re-exported from
 * the barrel, so the scheduler grows no bespoke task-row write of its own. Only the file-level
 * exemption is given up, which is the point.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A durable-engine recovery re-executes a turn body from the top and finds its own committed claim
 * (`working`, stamped with this workflow's id) WITHOUT taking a new transition — so it would
 * otherwise inherit whatever remains of the ORIGINAL lease and could be reaped mid-flight through
 * no fault of its own. Recovery is a legitimate fresh execution of the whole body and gets a fresh
 * window.
 *
 * Deliberately NOT a status write, and scoped so it cannot become one by accident: the SET carries
 * `claimExpiresAt` and nothing else, and the WHERE is pinned to the leaseholder (`task_id` plus the
 * current `working` status). It therefore cannot resurrect a terminal row, cannot move the
 * compare-and-swap token, and cannot extend a claim someone else has taken over — an intervening
 * reap moves the row out of `working` and this renew matches nothing, returning `false`.
 */

import { schema, type TenantDb } from '@rayspec/db';
import { and, eq } from 'drizzle-orm';

/** Extend the claim lease on a `working` row. Returns false when the row no longer holds a claim. */
export async function renewTurnLease(
  tdb: TenantDb,
  taskId: string,
  expiresAt: Date,
): Promise<boolean> {
  const rows = await tdb
    .update(schema.workforceTasks, { claimExpiresAt: expiresAt })
    .where(
      and(eq(schema.workforceTasks.taskId, taskId), eq(schema.workforceTasks.status, 'working')),
    )
    .returning({ taskId: schema.workforceTasks.taskId });
  return rows.length > 0;
}
