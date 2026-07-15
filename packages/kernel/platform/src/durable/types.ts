/**
 * The NEUTRAL durable-execution seam — engine-agnostic.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES HERE (and carries NO engine reference).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This adds an ORCHESTRATOR above the run-journal + `run_events`: it changes only WHERE
 * `runAgent` runs (a durable worker vs the HTTP request), not how events persist or stream. The
 * concrete engine (DBOS) lives in its OWN package `@rayspec/durable-dbos`; this neutral
 * interface is what the api-auth run surface depends on, so `@rayspec/platform` / `run-core` / the
 * three adapters stay completely DBOS-free. The engine asymmetry (DBOS's `WorkflowStatus`, queues,
 * recovery semantics) is absorbed INSIDE the adapter, never leaked into these neutral types — the
 * the anti-LCD-collapse discipline applied to the off-request spine.
 *
 * The `RunJob` payload is a plain JSON-serializable bag sufficient to RECONSTRUCT an off-request run
 * (the durable engine persists it; on recovery it re-hydrates from this, not from in-memory state).
 * It deliberately carries NO `Backend`/`AgentSpec`/`TenantDb` handle — those are RESOLVED inside the
 * worker from `job.agentId` + `job.tenantId` (so a serialized job has no live object graph). The
 * engine adapter is constructed with a resolver (`{ db, resolveRun }`) that turns a `RunJob` back
 * into `{ backend, spec, tools }` at fire time.
 */

/**
 * A JSON-serializable payload sufficient to reconstruct + execute an off-request agent run. The
 * durable engine persists THIS (not a live object graph) and re-hydrates from it on recovery — so
 * every field must be a plain JSON value. The `runId` is PRE-MINTED + idempotency-reserved by the
 * HTTP run surface BEFORE enqueue (reserve-before-execute), and the engine uses it as the durable
 * workflow id, so DBOS's own workflow-id idempotency law and our `idempotency_keys` reservation
 * interlock to exactly one job per Idempotency-Key.
 */
export interface RunJob {
  /** The pre-minted, idempotency-reserved runId — also the durable workflow id (one job per key). */
  readonly runId: string;
  /** The server-derived tenant the run executes under (the worker binds `forTenant(db, tenantId)`). */
  readonly tenantId: string;
  /** The declared agent id — resolved to `{ backend, spec, tools }` at fire time (no live handle). */
  readonly agentId: string;
  /** The per-request runtime task value (the agent's `input`). */
  readonly input: string;
  /** Optional per-run override of the base spec's instructions. */
  readonly instructions?: string;
  /** Optional per-run override of maxTurns. */
  readonly maxTurns?: number;
  /**
   * Optional declared store name: when set, the run's validated `outputSchema` output is written as one
   * row into this store after a successful run (the agent action's `persistTo`). The worker resolves the
   * store's runtime table from the deployment's product tables at fire time. Exactly-once across a
   * durable recovery re-dispatch (the run-header completing-transition gate).
   */
  readonly persistTo?: string;
}

/**
 * The NEUTRAL job status — a small closed enum mapped FROM the engine's own status by the adapter
 * (so DBOS's `WorkflowStatusString` never leaks here). `unknown` is the fail-safe fallback for a
 * status the adapter cannot map (never a thrown — status reads must not crash a poller).
 */
export type DurableJobStatus =
  | 'enqueued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

/** The result of enqueueing a job — the engine's durable job id (== the run's pre-minted runId). */
export interface EnqueueResult {
  readonly jobId: string;
}

/**
 * The neutral durable-execution engine. ONE method to enqueue an off-request run, ONE to read its
 * status, plus lifecycle. An implementation (the DBOS adapter) runs the EXISTING `runAgent`
 * off-request inside `forTenant(db, tenantId).transaction()` — it adds NO new persistence/streaming
 * layer (events still persist to `run_events`; the client resumes via the shipped
 * `GET /v1/runs/{id}/events?lastEventId=`).
 *
 * Durability contract (HONEST): a crashed job RE-EXECUTES the whole `runAgent` from
 * the start (the model is re-called; the journal only short-circuits an ALREADY-COMPLETED run). It
 * is NOT step-resume. The SAFETY posture is that a crashed/interrupted run is NOT silently
 * re-fired (it is made terminal, never auto-retried) — automated retry + the non-idempotent-taint
 * quarantine are a later step.
 */
export interface DurableExecutor {
  /**
   * Enqueue a run for off-request execution. Returns the durable job id (the adapter uses `job.runId`
   * as the workflow id, so a re-enqueue of the same runId is idempotent at the engine level too).
   * Must be called only after the run surface has reserved `job.runId` (reserve-before-execute).
   */
  enqueue(tenantId: string, job: RunJob): Promise<EnqueueResult>;
  /** Read the neutral status of a previously-enqueued job (by its jobId == runId). */
  status(jobId: string): Promise<DurableJobStatus>;
  /** Start the engine (launch the worker) BEFORE the server accepts requests. */
  start(): Promise<void>;
  /** Drain + stop the engine (graceful shutdown). */
  shutdown(): Promise<void>;
}
