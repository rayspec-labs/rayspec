/**
 * The `runs` HEADER lifecycle — the statuses a run's header row carries, and the two NON-TERMINAL
 * writes that create it BEFORE the run finishes.
 *
 * The header used to be written ONLY by run-core's completing upsert, so the runId an async `202`
 * hands out did not resolve on `GET /v1/runs/{id}` — nor on the `/events` path that same `202`
 * advertises — until the run ended (#121). Two additive writes close that:
 *
 *   1. `insertEnqueuedRunHeader` — written at ENQUEUE, before any worker picks the job up. A plain
 *      `onConflictDoNothing`: by the time it lands the worker may already have written its own
 *      header, and every later header write is authoritative over this one.
 *   2. `markRunHeaderRunning` — written by run-core when execution actually starts. It INSERTS the
 *      header when none exists (the sync run surface has no enqueue write) and otherwise performs
 *      ONLY the `enqueued` → `running` transition (`setWhere eq(status,'enqueued')`), so it can never
 *      overwrite a header that already carries a run's own outcome.
 *
 * NEITHER write is a completion transition. run-core's completing upsert
 * (`setWhere ne(status,'completed')`) stays the ONE write that puts a run into a terminal status, and
 * the `.returning()` gate on it stays the exactly-once seam for output persistence.
 *
 * VISIBILITY, stated exactly: the durable executor runs `runAgent` inside `tdb.transaction()`, so on
 * that path the `running` transition and the terminal write commit TOGETHER — an external reader sees
 * the enqueue-time `enqueued` header for the whole run and then the terminal one. The sync run surface
 * runs `runAgent` outside a transaction, so there the `running` header is visible while it is in flight.
 */
import { type AuthMode, RunResult } from '@rayspec/core';
import { schema, type TenantDb } from '@rayspec/db';
import { eq } from 'drizzle-orm';

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
 * Create the header for a run that has just been ENQUEUED on the durable worker, so its runId
 * resolves through the run-read routes for the whole run instead of 404ing until it finishes.
 *
 * `onConflictDoNothing`: the enqueued job may already be executing (or done) when this lands, and its
 * own header writes are authoritative — this write only fills the gap where no header exists yet.
 * Tenant-scoped through the `TenantDb` chokepoint, which stamps the tenant on the row.
 */
export async function insertEnqueuedRunHeader(
  tdb: TenantDb,
  identity: RunHeaderIdentity,
): Promise<void> {
  await tdb
    .insert(schema.runs, {
      ...identity,
      authMode: UNRESOLVED_AUTH_MODE,
      status: RUN_STATUS_ENQUEUED,
    })
    .onConflictDoNothing();
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
