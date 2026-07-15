/**
 * DBOS wire-shape TYPE assertions (doc-first against the INSTALLED @dbos-inc/dbos-sdk).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A NON-TEST SOURCE FILE (and not `expectTypeOf` in dbos-wire-shape.test.ts).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The `typecheck` gate runs `tsc -b`, whose tsconfig EXCLUDES test files (the `.test.ts` glob), and
 * the `test` gate runs `vitest run` WITHOUT `--typecheck` (so a `expectTypeOf(...)` in a test file is
 * a runtime NO-OP — it would assert NOTHING in CI). To make the field-name pins ACTUALLY enforced,
 * they live HERE, in a file `tsc -b` compiles: a DBOS config-key rename (e.g.
 * maxRecoveryAttempts→maxAttempts, retriesAllowed→…, workerConcurrency→…, workflowID/queueName→…, or
 * dropping the top-level runAdminServer) BREAKS THE BUILD here, loudly, instead of failing only at
 * runtime under load. The runtime dbos-wire-shape.test.ts golden still pins the FUNCTION existence +
 * the StatusString enum.
 *
 * Every assertion below references the EXACT field `executor.ts` depends on. These are compile-time
 * only: `Assert<…>` resolves to `true` or fails to compile; the exported `WIRE_SHAPE_PINNED` makes the
 * module non-empty so it is part of the build graph (and importing it is a no-op).
 */

import type { DBOS, DBOSConfig, StepConfig, WorkflowConfig } from '@dbos-inc/dbos-sdk';

/** Resolves to `true` iff `Key` is a property of `T` (a rename/removal makes this `false` → break). */
type HasKey<T, Key extends PropertyKey> = Key extends keyof T ? true : false;
/** Compile-time assertion: fails to compile unless `T` is exactly `true`. */
type AssertTrue<T extends true> = T;

// 1. WorkflowConfig.maxRecoveryAttempts — the executor's layer-1 crash-recovery cap.
type _MaxRecoveryAttempts = AssertTrue<HasKey<WorkflowConfig, 'maxRecoveryAttempts'>>;

// 2. StepConfig.retriesAllowed — the executor sets `retriesAllowed:false` (no in-step auto-retry).
type _RetriesAllowed = AssertTrue<HasKey<StepConfig, 'retriesAllowed'>>;

// 3. DBOSConfig.runAdminServer — the TOP-LEVEL field fix A sets false (NO admin HTTP listener).
//    (Pinned here so a rename/move of this security-load-bearing field breaks the build, not just
//    silently re-enables the admin server at runtime.) Also pin the systemDatabaseUrl the executor
//    derives + passes, and the optional logger sink.
type _RunAdminServer = AssertTrue<HasKey<DBOSConfig, 'runAdminServer'>>;
type _SystemDatabaseUrl = AssertTrue<HasKey<DBOSConfig, 'systemDatabaseUrl'>>;
type _Logger = AssertTrue<HasKey<DBOSConfig, 'logger'>>;

// 4. registerQueue's params carry `workerConcurrency` — the worker-concurrency cap. We derive
//    the param type from the INSTALLED function signature (QueueParameters is not publicly exported),
//    so this pins exactly what the executor passes.
type RegisterQueueParams = NonNullable<Parameters<typeof DBOS.registerQueue>[1]>;
type _WorkerConcurrency = AssertTrue<HasKey<RegisterQueueParams, 'workerConcurrency'>>;

// 5. startWorkflow's params carry `workflowID` (the durable id == runId) + `queueName` (the off-request
//    queue). Derived from the installed signature (StartWorkflowParams is not publicly exported).
type StartWorkflowParams = NonNullable<Parameters<typeof DBOS.startWorkflow>[1]>;
type _WorkflowID = AssertTrue<HasKey<StartWorkflowParams, 'workflowID'>>;
type _QueueName = AssertTrue<HasKey<StartWorkflowParams, 'queueName'>>;

// 6. The SCHEDULED-WORKFLOW API the cron scheduler depends on (doc-first). The cron
//    scheduler uses the FUNCTIONAL pre-launch path: `DBOS.registerWorkflow(fn, {name})` then
//    `DBOS.registerScheduled(fn, {name, crontab})`. We pin BOTH the function existence (a rename of
//    registerScheduled → createSchedule/applySchedules breaks the build here, not just at runtime when
//    the cron silently never fires) AND the `crontab` config key (the scheduler passes
//    `{ name, crontab: descriptor.schedule }`). `SchedulerConfig` is not publicly exported, so we
//    derive the config param type from the INSTALLED `registerScheduled` signature.
/** Resolves to `true` iff `Fn` is callable (`never[]`→`unknown` tests callability without `any`). */
type IsFn<Fn> = Fn extends (...args: never[]) => unknown ? true : false;
type _RegisterScheduled = AssertTrue<IsFn<typeof DBOS.registerScheduled>>;
type RegisterScheduledConfig = Parameters<typeof DBOS.registerScheduled>[1];
type _Crontab = AssertTrue<HasKey<RegisterScheduledConfig, 'crontab'>>;
// The scheduled body is registered as a workflow first; pin the deterministic-id workflow id law's
// entry point (registerWorkflow → a recovery-safe scheduled body). Already pinned at 1/the golden, but
// keep the cron-relevant assertion local so a future split of the scheduled path is caught here too.
type _RegisterWorkflowForScheduled = AssertTrue<IsFn<typeof DBOS.registerWorkflow>>;

/**
 * References every wire-shape assertion above in one tuple so each is a USED symbol (each still
 * resolves to `true` or fails to compile — the guard is unchanged). Without this, an unused-locals
 * typecheck would flag the assertions, tempting their deletion and silently dropping the pins.
 */
type _WireShapeAssertions = [
  _MaxRecoveryAttempts,
  _RetriesAllowed,
  _RunAdminServer,
  _SystemDatabaseUrl,
  _Logger,
  _WorkerConcurrency,
  _WorkflowID,
  _QueueName,
  _RegisterScheduled,
  _Crontab,
  _RegisterWorkflowForScheduled,
];

/**
 * References the assertion tuple so it (and, transitively, each assertion above) counts as used.
 * `declare` is ambient: it emits no runtime code and is exempt from unused-locals, so this keeps the
 * compile-time pins live without changing any behavior.
 */
declare const _wireShapeAssertions: _WireShapeAssertions;

/**
 * A non-empty export so the module is part of the build graph (the type assertions above are erased
 * at emit; this keeps the file from being tree-shaken out of the typecheck). It carries no behavior.
 */
export const WIRE_SHAPE_PINNED = true as const;
