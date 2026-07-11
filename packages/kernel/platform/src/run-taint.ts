/**
 * The NON-IDEMPOTENT-TAINT marker — the safety mechanism for whole-run re-execution.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (the hazard, in one paragraph).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The durability contract is WHOLE-RUN re-execution: a crashed durable run re-runs the whole
 * `runAgent` from the start, and a transient-failed sync run can be RE-RUN under the same Idempotency-
 * Key (the transient-release). Either re-run is FRESH (`replay=false`), so the `dispatch.ts`
 * non-idempotent guard (which only blocks on `replay===true`) does NOT fire — a previously-fired
 * `send_email`/`charge_card` (a tool flagged `idempotent:false`) would FIRE AGAIN. There is no intra-run
 * step-resume to make a re-run safe, so the disciplined answer is to QUARANTINE: a run that has
 * already fired a non-idempotent tool is never silently re-run — it is surfaced for manual review.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE MECHANISM — a persisted, tenant-scoped taint marker, written BEFORE the side effect.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The marker is a row in the EXISTING `idempotency_keys` table (no new table, no migration) under a
 * dedicated `scope='run_taint'`, keyed by the runId. It is the durable evidence "this run did something
 * irreversible". The chokepoint (`dispatch.ts`) writes it via {@link markRunTainted} — passed in as the
 * `markRunTainted` callback on `DispatchDeps` — IMMEDIATELY BEFORE it runs a non-idempotent tool's
 * handler (the marker-before-side-effect ordering the quarantine depends on: a crash AFTER the marker
 * commits but BEFORE/DURING the side effect must leave the run visibly tainted, so a re-run is refused;
 * a re-fired side effect with no marker is exactly the hazard). The write is FAIL-CLOSED: if it throws,
 * dispatch refuses to run the handler (a tool_error), so a side effect never fires un-recorded.
 *
 * Because it is an `idempotency_keys` row, the write is tenant-scoped STRUCTURALLY (the `TenantDb`
 * chokepoint stamps `tenant_id`) and atomic (`INSERT .. ON CONFLICT DO NOTHING`) — a second non-idempotent
 * tool in the same run is a harmless no-op (the run is already tainted). The reader {@link isRunTainted}
 * is the quarantine gate every AUTOMATED re-run path consults (the in-request transient-release, the
 * worker's at-least-once retry, an at-least-once cron handler) before deciding whether a silent re-run
 * is safe.
 *
 * SCOPE (do NOT over-build): this is the cheap, correct safety. It does NOT enable safe automated
 * retry of a tainted run — that needs intra-run step-journaling (the escalation, only on a concrete
 * consumer). A tainted run is QUARANTINED (terminal, manual review), an untainted (idempotent / no-tool)
 * run re-runs freely. Marker rows grow unbounded until pruned (a future cron prune
 * worker — same posture as `run_started` / `trigger`).
 */

import { schema, type TenantDb } from '@rayspec/db';
import { and, eq } from 'drizzle-orm';

/**
 * The `idempotency_keys` scope for the per-run non-idempotent-taint marker. A row
 * `(tenant, scope='run_taint', idem_key=runId)` means "this run has fired a non-idempotent tool" — the
 * durable evidence the quarantine gates key off. Distinct from `agent_run` (the run-level idempotency
 * reservation) and `run_started` (the durable started-once guard) so the three never collide.
 */
export const RUN_TAINT_SCOPE = 'run_taint';

/**
 * The `body_hash` sentinel for a `run_taint` marker row. The marker's identity is its
 * `(tenant, scope, idem_key=runId)` UNIQUE key; `body_hash` is unused for it (a non-null sentinel for
 * the NOT-NULL column), so a stable constant rather than a derived hash that would read as if a body
 * were hashed there.
 */
export const RUN_TAINT_BODY_HASH = 'run_taint_marker';

/**
 * MARK a run as non-idempotent-tainted (the chokepoint calls this BEFORE a non-idempotent tool's side
 * effect fires). An atomic `INSERT .. ON CONFLICT DO NOTHING` over the `idempotency_keys`
 * `UNIQUE(tenant, scope, idem_key)` index — idempotent (a second non-idempotent tool in the same run is
 * a no-op; the run is already tainted). Tenant-scoped via the `TenantDb` chokepoint (the predicate is
 * structural — a marker can never land on or read another tenant's row).
 *
 * FAIL-CLOSED CONTRACT: the caller (dispatch.ts) MUST await this and NOT run the handler if it rejects —
 * a side effect that fires without a committed taint marker is the exact double-fire hazard this guards.
 */
export async function markRunTainted(tdb: TenantDb, runId: string): Promise<void> {
  await tdb
    .insert(schema.idempotencyKeys, {
      scope: RUN_TAINT_SCOPE,
      idemKey: runId,
      bodyHash: RUN_TAINT_BODY_HASH,
      snapshot: { runId },
    })
    .onConflictDoNothing();
}

/**
 * READ whether a run is non-idempotent-tainted (the quarantine gate: any AUTOMATED re-run/retry path —
 * the in-request transient-release, the worker's at-least-once retry, an at-least-once cron handler —
 * consults this BEFORE a silent re-run). Tenant-scoped via the `TenantDb` chokepoint: a foreign runId
 * reads ZERO rows (returns false) exactly like every other tenant-scoped read — there is no cross-tenant
 * taint leak. A run with no non-idempotent tool fired returns false (it is safely re-runnable).
 */
export async function isRunTainted(tdb: TenantDb, runId: string): Promise<boolean> {
  const rows = await tdb
    .select(schema.idempotencyKeys)
    .where(
      and(
        eq(schema.idempotencyKeys.scope, RUN_TAINT_SCOPE),
        eq(schema.idempotencyKeys.idemKey, runId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
