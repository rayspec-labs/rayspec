/**
 * @rayspec/durable-dbos — the DBOS adapter for the neutral `DurableExecutor`.
 *
 * The ONLY package that imports `@dbos-inc/dbos-sdk`. It runs the EXISTING `runAgent` off-request
 * inside one durable workflow; the neutral `DurableExecutor`/`RunJob`/`DurableJobStatus` types live
 * in `@rayspec/platform` and carry NO DBOS reference (the engine asymmetry stays here).
 */

// The CRON firing runtime (cron-only; webhook/event/manual reserved per-kind).
export {
  assertCronOnly,
  type CronSchedulerDeps,
  catchUpSchedulerMode,
  cronAgentInput,
  cronRunId,
  DbosCronScheduler,
  DEFAULT_CATCHUP_LOOKBACK_MS,
  FIRING_INSTANT_GRANULARITY_MS,
  firingInstantIso,
  firingKey,
  TRIGGER_FIRE_BODY_HASH,
  TRIGGER_FIRE_SCOPE,
  TriggerKindNotBuiltError,
} from './cron-scheduler.js';
export {
  AGENT_RUNS_QUEUE,
  DbosDurableExecutor,
  type DbosExecutorConfig,
  type DbosExecutorDeps,
  DEFAULT_WORKER_CONCURRENCY,
  DurableRunNotRetriedError,
  type ResolvedRun,
  RUN_STARTED_BODY_HASH,
  RUN_STARTED_SCOPE,
} from './executor.js';
// The daily SYSTEM/PLATFORM housekeeping scheduled-workflow (OIDC prune LIVE + the
// operator-gated GDPR purge). A SYSTEM job (NOT a tenant cron trigger); engine-only — the concrete
// cleanup logic is INJECTED as a neutral `runCleanup()` callback so this package stays api-auth-free.
export {
  type CleanupLogger,
  DEFAULT_CLEANUP_SCHEDULE,
  formatSystemCleanupLog,
  SYSTEM_CLEANUP_WORKFLOW_NAME,
  type SystemCleanupOutcome,
  SystemCleanupScheduler,
  type SystemCleanupSchedulerDeps,
} from './system-cleanup-scheduler.js';
// Compile-time DBOS wire-shape pins (doc-first): re-exported so the type assertions in this module
// are part of the build graph (a DBOS config-key rename breaks `tsc -b` here). Erased at runtime.
export { WIRE_SHAPE_PINNED } from './wire-shape-assertions.js';
// The DBOS durable path for the declarative WORKFLOW runtime (the workflow half of the engine
// asymmetry; the neutral engine lives in @rayspec/workflow-durable and is DBOS-free). Attaches to the
// SAME shared executor launch via attachPreLaunchHook (like the cron scheduler).
export {
  DbosWorkflowExecutor,
  type DbosWorkflowExecutorDeps,
  DEFAULT_WORKFLOW_WORKER_CONCURRENCY,
  type ResolvedWorkflowRun,
  reconcileWorkflowLiveness,
  WORKFLOW_RUNS_QUEUE,
  type WorkflowJob,
  type WorkflowRunLiveness,
} from './workflow-executor.js';
