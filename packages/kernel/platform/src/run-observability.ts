/**
 * Run/job observability READ-PATH (SAFE half) — derived ENTIRELY from what is already
 * persisted (the run header + journal + `run_events` + the `run_taint` / `run_started` markers). It adds
 * NO new store and NO new write — it is a tenant-scoped reader that surfaces a run's status plus its
 * taint / quarantine state for an operator or a status endpoint. (A metrics dashboard beyond this raw
 * read is a RESERVED SEAM.)
 *
 * "QUARANTINED" is a DERIVED state, not a stored column: a run is quarantined when it is TAINTED (a
 * non-idempotent tool fired — the `run_taint` marker exists) AND it did not complete successfully
 * (`status !== 'completed'`). That is exactly the run the automated-retry quarantine refuses to silently
 * re-run (it needs manual review). A tainted-but-completed run is NOT quarantined (it finished cleanly).
 *
 * Tenant-scoped via the `TenantDb` chokepoint: every read carries the tenant predicate structurally, so
 * this can never surface another tenant's run (a foreign/absent runId reads as `exists:false`).
 */

import { schema, type TenantDb } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { isRunTainted } from './run-taint.js';

/**
 * The neutral observability snapshot for one run — derived from the already-persisted state. `exists`
 * is false (and the rest are zero/false/null) for a foreign or absent runId (no leak). `tainted` is the
 * `run_taint` marker presence; `quarantined` is the derived "tainted AND not completed" state an
 * automated re-run path refuses; `stepCount`/`eventCount` are the journal + `run_events` row counts.
 */
export interface RunObservability {
  readonly runId: string;
  readonly exists: boolean;
  /** The run header status (`completed` / `error` / …), or null when there is no header yet. */
  readonly status: string | null;
  /** A non-idempotent tool fired in this run (the `run_taint` marker is present). */
  readonly tainted: boolean;
  /** Derived: tainted AND not completed ⇒ an automated re-run is refused (manual review). */
  readonly quarantined: boolean;
  readonly stepCount: number;
  readonly eventCount: number;
}

/**
 * READ a run's observability snapshot, tenant-scoped. Reads the run header (status), the `run_taint`
 * marker (taint), and the journal + `run_events` counts — all through the `TenantDb` chokepoint, so a
 * foreign/absent runId returns `exists:false` (no cross-tenant leak). Pure read; no writes, no new store.
 */
export async function getRunObservability(tdb: TenantDb, runId: string): Promise<RunObservability> {
  const headerRows = (await tdb.select(schema.runs).where(eq(schema.runs.runId, runId))) as Array<{
    status: string;
  }>;
  const header = headerRows[0];

  const tainted = await isRunTainted(tdb, runId);

  const steps = (await tdb
    .select(schema.journalSteps)
    .where(eq(schema.journalSteps.runId, runId))) as Array<unknown>;
  const events = (await tdb
    .select(schema.runEvents)
    .where(eq(schema.runEvents.runId, runId))) as Array<unknown>;

  const status = header?.status ?? null;
  // Quarantined = a side effect fired (tainted) AND the run did not complete cleanly. That is the run
  // the automated-retry quarantine refuses to silently re-run (it is surfaced for manual review). A
  // run with no header at all but a taint marker (a crash before the header persisted) also qualifies.
  const quarantined = tainted && status !== 'completed';

  return {
    runId,
    exists: Boolean(header) || tainted,
    status,
    tainted,
    quarantined,
    stepCount: steps.length,
    eventCount: events.length,
  };
}
