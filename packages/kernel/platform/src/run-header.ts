/**
 * The `runs` HEADER lifecycle — the statuses a run's header row carries, and the two NON-TERMINAL
 * writes that create it BEFORE the run finishes.
 *
 * The header used to be written ONLY by run-core's completing upsert, so the runId an async `202`
 * hands out did not resolve on `GET /v1/runs/{id}` — nor on the `/events` path that same `202`
 * advertises — until the run ended (#121). Two additive writes close that:
 *
 *   1. `insertEnqueuedRunHeader` — written by the enqueue path BEFORE the job is handed to the durable
 *      executor, so that job cannot yet be executing anywhere. It first READS the header and returns
 *      without writing when one is already visible; the write itself is an `onConflictDoNothing`, so a
 *      concurrent enqueue of the same runId still resolves to one row.
 *   2. `markRunHeaderRunning` — written by run-core when execution actually starts. It INSERTS the
 *      header when none exists (the sync run surface has no enqueue write) and otherwise performs
 *      ONLY the `enqueued` → `running` transition (`setWhere eq(status,'enqueued')`), so it can never
 *      overwrite a header that already carries a run's own outcome.
 *
 * NEITHER write is a completion transition. run-core's completing upsert
 * (`setWhere ne(status,'completed')`) stays the ONE write that puts a run into a terminal status, and
 * the `.returning()` gate on it stays the exactly-once seam for output persistence.
 *
 * ROW-LOCK, stated exactly: on the durable path run-core runs inside the executor's transaction, so
 * the `running` write holds the header row's lock until that transaction commits — for the whole run.
 * Two things keep the enqueue path off that lock: it runs before its job exists (so that job's run
 * transaction cannot be open yet), and its pre-read — a plain SELECT, which under MVCC does not wait
 * on another transaction's uncommitted write — skips the INSERT for a runId whose header it can
 * already see, which is the PINNED-runId case where an earlier run under that id is still in flight.
 * Two dispatches of the SAME runId do serialize on the lock: a recovery re-dispatch blocks at run
 * start until the in-flight run's transaction ends.
 *
 * VISIBILITY, stated exactly: because the durable path's `running` write is inside that transaction,
 * an external reader sees the enqueue-time `enqueued` header for the whole run and then the terminal
 * one. The sync run surface runs `runAgent` outside a transaction, so there the `running` header is
 * visible while the run is in flight.
 *
 * NON-TERMINAL RESIDUAL: a run that THROWS (crash, timeout, an exception out of the backend) reaches
 * no completing write, so on the sync path its `running` header stays there — nothing reaps it. A
 * consumer that walks headers must therefore test TERMINALITY (`isTerminalRunStatus`), not presence.
 */
import { type AuthMode, RunResult } from '@rayspec/core';
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq } from 'drizzle-orm';

/** The header status of a run that is enqueued on the durable worker and has not started executing. */
export const RUN_STATUS_ENQUEUED = 'enqueued';

/** The header status of a run whose execution has started and has not reached a terminal status. */
export const RUN_STATUS_RUNNING = 'running';

/**
 * Every value the `runs.status` column takes: the two terminal `RunResult` statuses run-core persists
 * at completion, plus the two non-terminal ones above.
 */
export type RunHeaderStatus =
  | RunResult['status']
  | typeof RUN_STATUS_ENQUEUED
  | typeof RUN_STATUS_RUNNING;

/**
 * The TERMINAL header statuses — exactly the `RunResult.status` values run-core's completing upsert
 * writes. Read off the neutral schema so the set cannot drift from it.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(RunResult.shape.status.options);

/** True iff `status` is a terminal header status, i.e. the run has finished (completed or error). */
export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * The auth mode recorded on a header written before the run has started. No credential has been
 * resolved at enqueue time, and `unauthenticated` is the neutral vocabulary for exactly that; the
 * `enqueued` → `running` transition rewrites it with the mode the run actually resolved.
 */
const UNRESOLVED_AUTH_MODE: AuthMode = 'unauthenticated';

/** The run-header identity columns: the backend, agent and model the run executes under. */
export interface RunHeaderIdentity {
  runId: string;
  backend: string;
  agentName: string;
  model: string;
}

/**
 * Create the header for a run that is being ENQUEUED on the durable worker, so its runId resolves
 * through the run-read routes for the whole run instead of 404ing until it finishes. Returns true iff
 * THIS call created the row (the caller uses that to remove it again if the enqueue provably never
 * created a job).
 *
 * The pre-READ is what keeps this write off any run's row lock: a runId may be PINNED by the caller,
 * so an EARLIER run under it can be in flight and holding its header row inside the run transaction —
 * an `INSERT … ON CONFLICT DO NOTHING` would then WAIT for that whole run. The plain SELECT is an MVCC
 * read that never waits, and a header this call can already see is one it has nothing to add to. The
 * INSERT keeps `onConflictDoNothing` for the remaining race (a concurrent enqueue of the same runId,
 * whose write commits in a single statement).
 *
 * Tenant-scoped through the `TenantDb` chokepoint, which stamps the tenant on the row and scopes the
 * read — a foreign runId reads as absent, and the insert would then conflict on the runId PK and do
 * nothing (never a cross-tenant overwrite).
 */
export async function insertEnqueuedRunHeader(
  tdb: TenantDb,
  identity: RunHeaderIdentity,
): Promise<boolean> {
  const seen = await tdb
    .select(schema.runs, { runId: schema.runs.runId })
    .where(eq(schema.runs.runId, identity.runId))
    .limit(1);
  if (seen.length > 0) return false;
  const created = await tdb
    .insert(schema.runs, {
      ...identity,
      authMode: UNRESOLVED_AUTH_MODE,
      status: RUN_STATUS_ENQUEUED,
    })
    .onConflictDoNothing()
    .returning({ runId: schema.runs.runId });
  return created.length > 0;
}

/**
 * Remove an enqueue-time header again — for the caller that created one and then learned the job was
 * NEVER durably created, so the runId will never run.
 *
 * Deletes ONLY a still-`enqueued` row: if anything has moved the header on (a worker started it, or a
 * run under this id finished), that outcome is the authoritative record and this leaves it alone.
 */
export async function deleteEnqueuedRunHeader(tdb: TenantDb, runId: string): Promise<void> {
  await tdb
    .delete(schema.runs)
    .where(and(eq(schema.runs.runId, runId), eq(schema.runs.status, RUN_STATUS_ENQUEUED)));
}

/**
 * Put the run's header into `running` as execution starts: an INSERT when no header exists (the sync
 * path), and otherwise ONLY the `enqueued` → `running` transition.
 *
 * `setWhere eq(status,'enqueued')` is what keeps this additive. It is false for a `completed` header
 * (so a completed run stays authoritative and terminal — the property run-core's completing upsert
 * relies on), false for an `error` header (a re-dispatch of a finished run leaves that outcome exactly
 * where it was), and false for a `running` one (a recovery re-dispatch is a no-op). The only header it
 * rewrites is the one `insertEnqueuedRunHeader` wrote — which is why the identity columns are
 * refreshed here: they carry the values the run RESOLVED, superseding the enqueue-time ones.
 */
export async function markRunHeaderRunning(
  tdb: TenantDb,
  identity: RunHeaderIdentity & { authMode: AuthMode },
): Promise<void> {
  await tdb.insert(schema.runs, { ...identity, status: RUN_STATUS_RUNNING }).onConflictDoUpdate({
    target: schema.runs.runId,
    set: {
      backend: identity.backend,
      authMode: identity.authMode,
      agentName: identity.agentName,
      model: identity.model,
      status: RUN_STATUS_RUNNING,
    },
    setWhere: eq(schema.runs.status, RUN_STATUS_ENQUEUED),
  });
}
