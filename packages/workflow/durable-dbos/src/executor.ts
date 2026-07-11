/**
 * `DbosDurableExecutor` — the DBOS implementation of the neutral `DurableExecutor`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE PACKAGE THAT KNOWS ABOUT DBOS.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `@rayspec/platform` / `run-core` / the four SDK adapters carry NO `@dbos-inc/dbos-sdk` import —
 * the engine asymmetry is absorbed HERE. This adapter runs the EXISTING `runAgent`
 * off-request, UNCHANGED, inside one DBOS workflow whose single durable step calls it inside
 * `forTenant(db, tenantId).transaction()` (so the `app.current_tenant` GUC is populated → RLS-ready).
 * It adds NO new persistence/streaming layer: events still persist to `run_events` via run-core's
 * pipeline; the client resumes via the shipped `GET /v1/runs/{id}/events?lastEventId=` (F5).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DURABILITY CONTRACT — WHOLE-RUN RE-EXECUTION, HONEST.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DBOS recovers an interrupted workflow by RE-INVOKING the workflow body from the start, replaying
 * only COMPLETED steps from their memoized return values (verified doc-first against the installed
 * 4.21.6: `workflow-tutorial` "resumes the workflow from the last completed step" + steps are "never
 * re-executed after they complete"). Our workflow has ONE big step (the whole `runAgent`), so a
 * crash MID-`runAgent` leaves that step INCOMPLETE → on recovery it would RE-RUN `runAgent` from
 * scratch (the model is re-called; the journal only short-circuits an ALREADY-completed run). There
 * is NO intra-run step-resume.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SAFETY INVARIANT — a crashed run that already fired a side effect is NEVER silently re-fired.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Whole-run re-execution + a non-idempotent (`idempotent:false`) tool = a re-fired side effect
 * (`send_email`/`charge_card` runs twice — a kill-class hazard). Two layers enforce the invariant:
 *
 *  1. `maxRecoveryAttempts: 1` on the workflow — caps DBOS's own crash-recovery so a workflow that
 *     keeps crashing terminates at `MAX_RECOVERY_ATTEMPTS_EXCEEDED` (a terminal dead-letter status,
 *     NOT looped forever; verified in the installed `system_database.js:495-502`). NOTE the exact
 *     semantics: the flip happens only when `recovery_attempts > maxRecoveryAttempts + 1`, so `1`
 *     ALONE would still permit ONE silent recovery re-run before terminating, and `0` is falsy →
 *     defaults to 100 (the executor maps `wConfig.maxRecoveryAttempts ? … : DEFAULT_MAX(100)`). So
 *     layer 1 alone is INSUFFICIENT for the invariant — hence layer 2.
 *  2. A "started-once" guard backed by OUR OWN `idempotency_keys` (the correctness boundary —
 *     DBOS memoizes step OUTPUTS, not our in-step Drizzle writes, so OUR dedup is authoritative for
 *     non-idempotent effects). After resolving the run (a resolve failure must not poison the
 *     runId) and BEFORE running `runAgent`, atomically RESERVE `(tenant, scope='run_started',
 *     key=runId)`: the FIRST execution wins → it runs `runAgent`. A recovery RE-execution LOSES the
 *     reserve (the marker was committed by the first attempt before the crash) and is then resolved
 *     by the TAINT-aware quarantine decision: a run that already fired a non-idempotent tool (its
 *     `run_taint` marker survived the crash) is QUARANTINED terminal via `DurableRunNotRetriedError`
 *     and `runAgent` is NOT re-run, while an untainted (idempotent / no-tool) run is SAFELY re-run
 *     (the safe-class automated retry). This holds regardless of `maxRecoveryAttempts` and is the
 *     REAL guarantee.
 *
 * The honest consequence for a QUARANTINED async run started under an Idempotency-Key: that runId is
 * now permanently un-retryable under the SAME key (the run-surface reservation + the marker both
 * persist), so a same-key retry replays the terminal failure rather than re-running.
 */

import { DBOS, StatusString } from '@dbos-inc/dbos-sdk';
import type { AgentSpec, Backend, NeutralTool } from '@rayspec/core';
import type { Db } from '@rayspec/db';
import { forTenant, schema, type TenantDb } from '@rayspec/db';
import type { DurableExecutor, DurableJobStatus, EnqueueResult, RunJob } from '@rayspec/platform';
import { isRunTainted, runAgent } from '@rayspec/platform';
import { eq } from 'drizzle-orm';

/**
 * The neutral run-resolution the executor needs to turn a `RunJob` back into a runnable run — the
 * SAME shape the sync run surface resolves (an `AgentRegistryEntry`): the base spec, the backend,
 * and EITHER a per-run tenant-bound `toolFactory` (declared agents — its `HandlerDb` closes over the
 * run's TenantDb) OR a static `tools` list. The worker builds the tools from the
 * SAME transactional handle it runs `runAgent` on, so the tools' HandlerDb shares the GUC transaction.
 */
export interface ResolvedRun {
  readonly backend: Backend;
  /** The BASE neutral spec (instructions/model/outputSchema/maxTurns) — `input` is the job's. */
  readonly spec: AgentSpec;
  /** Static neutral tools. Prefer `toolFactory` when both are present. */
  readonly tools?: NeutralTool[];
  /**
   * Build this run's tenant-bound tools from a `TenantDb` (a declared agent's per-run factory — the
   * SAME `entry.toolFactory` the sync path calls). The worker calls it with the run's TRANSACTIONAL
   * TenantDb so the tools' HandlerDb shares the GUC transaction (RLS-ready). Optional (no-tool agent).
   */
  readonly toolFactory?: (tdb: TenantDb) => NeutralTool[];
}

/** What `DbosDurableExecutor` is constructed with: a raw Db + the agent resolver the worker fires. */
export interface DbosExecutorDeps {
  /**
   * The raw Db handle (the composition root's single makeDb). The worker binds `forTenant(db,
   * tenantId)` per job — NEVER a cross-tenant handle. This is the composition root, not a scoped
   * request path, so holding the raw `Db` here is sanctioned (the same posture as the stores).
   */
  readonly db: Db;
  /**
   * Resolve a `RunJob`'s `agentId` → `{ backend, spec, toolFactory|tools }` using the SAME resolution
   * the sync run path uses (the DeclarativeEngine / agent registry). Called at FIRE time (so a
   * serialized job carries no live object graph, and the agent definition is read live, like every
   * run). Throws if the agent id is unknown (fail-closed — the worker surfaces the run as failed).
   */
  readonly resolveRun: (job: RunJob) => ResolvedRun;
}

/** The DBOS config the executor needs (the composition root derives `systemDatabaseUrl` from env). */
export interface DbosExecutorConfig {
  /** The DBOS application name (namespaces the workflow registry). */
  readonly name: string;
  /**
   * The DBOS SYSTEM database url — SEPARATE from the app DB (DBOS auto-creates it; it does NOT touch
   * our `public`/app schema, so `gate:migrate-clean` is unaffected). Derived from DATABASE_URL by
   * swapping the db name (the composition root does this) or set via DBOS_SYSTEM_DATABASE_URL.
   */
  readonly systemDatabaseUrl: string;
  /**
   * The queue's worker concurrency cap (the concurrency-semaphore discipline; a conservative
   * default). Bounds how many `runAgentJob`s this worker runs at once.
   */
  readonly workerConcurrency?: number;
  /** Silence DBOS's own console logging in tests (a DLogger-shaped sink). Optional. */
  readonly logger?: ConstructorLoggerOption;
  /**
   * TEST-ONLY: `shutdown()` passes `{ deregister: true }` to `DBOS.shutdown` so the GLOBAL DBOS
   * workflow/queue registry is cleared, letting a FRESH executor re-register `runAgentJob` in the same
   * process. DBOS is a process-global singleton, so a production deployment has exactly ONE executor for
   * the process lifetime and NEVER sets this (the default, undefined, leaves the registry intact across
   * a normal shutdown). Only the multi-executor reliability test harness sets it. NOT a production path.
   */
  readonly deregisterOnShutdown?: boolean;
}

/**
 * The narrow shape DBOS's `DBOSConfig.logger` accepts (a DLogger). We only ever pass a no-op test
 * logger; typing it loosely here avoids importing DBOS's internal `DLogger` into our config surface.
 */
type ConstructorLoggerOption = NonNullable<Parameters<typeof DBOS.setConfig>[0]['logger']>;

/** The DBOS queue name the off-request agent runs are enqueued onto (the single agent-run queue). */
export const AGENT_RUNS_QUEUE = 'agent-runs';

/** The default per-worker concurrency for `agent-runs`. */
export const DEFAULT_WORKER_CONCURRENCY = 4;

/** The `idempotency_keys` scope for the per-run "started-once" safety marker (the started-once guard). */
export const RUN_STARTED_SCOPE = 'run_started';

/**
 * The `body_hash` sentinel for a `run_started` marker row. The marker's identity is its
 * (tenant, scope, idemKey=runId) UNIQUE key — the body_hash is unused for it (it is NOT an
 * idempotency-key body, just a non-null sentinel for the NOT-NULL column), so we use a stable
 * constant rather than echoing the runId (which read as if the run input were hashed there).
 */
export const RUN_STARTED_BODY_HASH = 'run_started_marker';

/**
 * Thrown by the workflow when a recovery RE-execution of an already-started, TAINTED run is detected
 * and we refuse to re-run `runAgent` (the safety invariant: never silently re-fire a side effect).
 * The workflow ends terminally with this error rather than re-executing the model/tools. An untainted
 * run is instead safely re-run (the safe-class automated retry).
 */
export class DurableRunNotRetriedError extends Error {
  constructor(runId: string) {
    super(
      `durable run '${runId}' was interrupted after it already started, is TAINTED, and is NOT ` +
        'auto-retried (a crashed tainted run is made terminal, never silently re-executed — a ' +
        'whole-run re-run would re-fire non-idempotent tools).',
    );
    this.name = 'DurableRunNotRetriedError';
  }
}

/**
 * Map DBOS's own `WorkflowStatusString` → the neutral `DurableJobStatus` (the asymmetry stays HERE).
 * `unknown` is the fail-safe for an unmapped/absent status — a status read must never throw.
 */
function toNeutralStatus(dbosStatus: string | null | undefined): DurableJobStatus {
  switch (dbosStatus) {
    case StatusString.ENQUEUED:
    case StatusString.DELAYED:
      return 'enqueued';
    case StatusString.PENDING:
      return 'running';
    case StatusString.SUCCESS:
      return 'succeeded';
    case StatusString.ERROR:
    case StatusString.MAX_RECOVERY_ATTEMPTS_EXCEEDED:
      return 'failed';
    case StatusString.CANCELLED:
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/**
 * How many times the worker RE-ATTEMPTS the taint READ on a transient DB error before giving up (fix
 * C). The read decides quarantine-vs-retry for an already-started run; a momentary DB blip must not
 * permanently dead-letter a SAFE (untainted) run, so we absorb a brief outage with a few short-backoff
 * retries. If the read STILL fails, the original DB error propagates (terminal-failed, diagnosable —
 * never a silent re-run on an uncertain taint).
 */
export const TAINT_READ_MAX_ATTEMPTS = 4;
/** Base backoff (ms) between taint-read attempts; doubles per attempt (50, 100, 200). */
export const TAINT_READ_BACKOFF_MS = 50;

/**
 * Read the run's taint status, RETRYING a transient DB read error a bounded number of times (fix C).
 * Returns the boolean on a SUCCESSFUL read (true ⇒ quarantine, false ⇒ safe re-run). RETHROWS the
 * ORIGINAL DB error if every attempt fails — the caller then surfaces it as the terminal step error
 * (the run is NOT re-executed off an unresolved taint read; the safety direction is preserved because
 * an uncertain read NEVER falls through to re-run). This makes the READ retryable in place, which is
 * the correct seam: the surrounding `runAgent` step is `retriesAllowed:false`, so a thrown step error
 * is memoized as terminal and would NOT be re-attempted on recovery — retrying here, not the run, is
 * what lets a momentary blip resolve without dead-lettering a safe run.
 */
export async function readTaintWithBoundedRetry(tdb: TenantDb, runId: string): Promise<boolean> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TAINT_READ_MAX_ATTEMPTS; attempt++) {
    try {
      return await isRunTainted(tdb, runId);
    } catch (e) {
      lastErr = e;
      if (attempt < TAINT_READ_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, TAINT_READ_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
  }
  // Every attempt failed: rethrow the ORIGINAL DB error. The caller does NOT proceed to re-run — an
  // uncertain taint must never enable a silent re-fire — but this surfaces a diagnosable transient DB
  // failure rather than a misleading "quarantine", and it does not dead-letter a healthy run as tainted.
  throw lastErr;
}

/**
 * The terminal-SUCCESS value of the `runs` header `status` column — the `RunResult.status` success
 * literal ('completed', verified doc-first against `@rayspec/core`'s `RunResult = z.object({ status:
 * z.enum(['completed','error']) … })`), persisted VERBATIM by run-core's header upsert
 * (`insert(schema.runs, { status: result.status })`). A recovery re-dispatch of an already-'completed'
 * run must NOT re-run `runAgent` (TEST-FLAKE-2 — the double-model-bill window; see the short-circuit
 * in `#runAgentJobBody`). This is the SAME literal the workflow-durable `agent-node` reconstruct path
 * keys on when it attaches a completed sub-run instead of re-running it.
 */
export const RUN_STATUS_SUCCEEDED = 'completed';

/**
 * Read whether the run's `runs` header is already at the terminal-SUCCESS status (closing TEST-FLAKE-2,
 * the double-model-bill window). Mirrors `readTaintWithBoundedRetry`: it RETRIES a transient DB read
 * error a bounded number of times (reusing the same `TAINT_READ_*` bounded-read policy), and returns
 * `true` iff a SUCCESSFUL read finds a `RUN_STATUS_SUCCEEDED` header for `runId`.
 *
 * SAFETY DIRECTION — deliberately OPPOSITE `readTaintWithBoundedRetry`. On a PERSISTENT read failure
 * this returns **false** (it NEVER throws), so the caller FALLS THROUGH to the existing safe re-run.
 * That is sound because the short-circuit only runs AFTER the taint check has already confirmed the run
 * UNTAINTED — an untainted run is safe to re-run (no non-idempotent side effect fired), so an unreadable
 * header costs at most a possible re-bill, which is EXACTLY today's untainted behavior. An uncertain
 * TAINT must block a re-run (hence that helper rethrows); an uncertain SUCCESS must never SKIP a
 * genuinely-needed retry (hence this one falls through).
 */
export async function readRunSucceededWithBoundedRetry(
  tdb: TenantDb,
  runId: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= TAINT_READ_MAX_ATTEMPTS; attempt++) {
    try {
      const rows = (await tdb
        .select(schema.runs, { status: schema.runs.status })
        .where(eq(schema.runs.runId, runId))
        .limit(1)) as Array<{ status: string }>;
      return rows[0]?.status === RUN_STATUS_SUCCEEDED;
    } catch {
      if (attempt < TAINT_READ_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, TAINT_READ_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
  }
  // Every attempt failed: FALL THROUGH to the existing safe re-run (return false, never throw) — a
  // DELIBERATE, safe swallow: the run is already confirmed UNTAINTED, so re-running only risks a
  // re-bill (exactly today's behavior); an uncertain SUCCESS must never SKIP a genuinely-needed retry.
  // A CODE regression that breaks this read DETERMINISTICALLY is still caught by the short-circuit's
  // own test (a throwing read returns false → the run re-runs → `liveRuns` increments, going red) —
  // the residual uncovered case is only a rare PRODUCTION persistent-DB failure on this read alone.
  return false;
}

export class DbosDurableExecutor implements DurableExecutor {
  readonly #deps: DbosExecutorDeps;
  readonly #config: DbosExecutorConfig;
  #started = false;
  /** Set once `start()` registers it — the registered workflow function used by `startWorkflow`. */
  #runAgentJob?: (job: RunJob) => Promise<void>;
  /**
   * Hooks run AFTER `registerWorkflow` but BEFORE `DBOS.launch()`. DBOS's scheduled-
   * workflow registration (`registerScheduled`) + any other workflow registration MUST happen before
   * launch (the `ScheduledReceiver` lifecycle callback starts the schedule loops at launch). The cron
   * scheduler attaches its `registerScheduledWorkflows()` here so the executor owns the SINGLE
   * `DBOS.launch()` (DBOS is a global singleton — there is exactly one launch) while the scheduler's
   * registration still lands in the correct pre-launch window.
   */
  readonly #preLaunchHooks: Array<() => void> = [];

  constructor(deps: DbosExecutorDeps, config: DbosExecutorConfig) {
    this.#deps = deps;
    this.#config = config;
  }

  /**
   * Attach a hook to run AFTER `registerWorkflow` but BEFORE `DBOS.launch()` (the register-before-
   * launch window). Used by `DbosCronScheduler` to register its DBOS scheduled-workflows on the single
   * shared launch. MUST be called before `start()` (a no-op throw otherwise — a hook attached after
   * launch could never run pre-launch). Idempotent attachment is the caller's concern (the cron
   * scheduler's own `registerScheduledWorkflows` is itself idempotent).
   */
  attachPreLaunchHook(hook: () => void): void {
    if (this.#started) {
      throw new Error(
        'DbosDurableExecutor.attachPreLaunchHook called after start() — a pre-launch hook must be ' +
          'attached before the engine launches (register-before-launch). Wire the cron scheduler ' +
          'before executor.start().',
      );
    }
    this.#preLaunchHooks.push(hook);
  }

  /**
   * The single durable workflow body. Its ONE durable step runs the whole `runAgent` off-request,
   * inside `forTenant(db, tenantId).transaction()`. The started-once guard (layer 2) runs at the top
   * of the step so a recovery re-execution is detected and refused BEFORE `runAgent` re-fires.
   *
   * Defined as an instance method bound at start() so the resolver/db close over `this` cleanly.
   */
  async #runAgentJobBody(job: RunJob): Promise<void> {
    await DBOS.runStep(
      async () => {
        const tdb = forTenant(this.#deps.db, job.tenantId);

        // ── Resolve the run FIRST (before the marker) ─────────────────────────────────────────
        // resolveRun reads the agent definition LIVE (no serialized object graph). It runs BEFORE
        // the started-once reserve on purpose (fix D): a transient resolve failure (e.g. the agent
        // registry is momentarily unbound on a too-early recovery dispatch — see fix F) throws here
        // WITHOUT committing the marker, so the workflow re-runs cleanly on the next recovery attempt
        // instead of poisoning the runId (a marker committed before a resolve failure would make the
        // runId permanently un-retryable). A genuinely-unknown agentId still throws → status 'failed'
        // (fail-closed). The marker is still committed BEFORE runAgent (the side effect) — see below —
        // so the safety invariant (a crashed run is never silently re-fired) is preserved.
        const resolved = this.#deps.resolveRun(job);

        // ── Layer 2: the started-once guard, TAINT-AWARE quarantine ───────────────────────────
        // Atomically reserve the per-run "started" marker AFTER resolveRun but BEFORE runAgent (the
        // marker-before-side-effect ordering the safety invariant depends on). The reserve is a single
        // INSERT..ON CONFLICT DO NOTHING RETURNING over UNIQUE(tenant, scope, idem_key) — the same
        // atomic primitive the run surface uses. The marker row is PERMANENT until pruned.
        const reserved = await tdb
          .insert(schema.idempotencyKeys, {
            scope: RUN_STARTED_SCOPE,
            idemKey: job.runId,
            bodyHash: RUN_STARTED_BODY_HASH,
            snapshot: { runId: job.runId },
          })
          .onConflictDoNothing()
          .returning();
        if (reserved.length === 0) {
          // The marker already exists ⇒ this is a RECOVERY of a run that already started once. The
          // The quarantine decision is keyed on the NON-IDEMPOTENT-TAINT marker:
          //  - TAINTED (a non-idempotent tool already fired ⇒ the chokepoint wrote the `run_taint`
          //    marker on its OWN connection, so it SURVIVED the crash) → QUARANTINE: refuse to re-run
          //    (a whole-run re-execution would re-fire the side effect). Terminal, manual review.
          //  - UNTAINTED (idempotent / no-tool) → the run is SAFELY re-runnable, so ALLOW the recovery
          //    re-execution (automated retry for the safe class) instead of dead-lettering it. We fall
          //    through to run `runAgent` again (run-core upserts the header/journal under the same runId).
          // The taint read goes through the SAME tdb (tenant-scoped). Two DISTINCT terminal outcomes —
          // do NOT collapse a transient READ ERROR into "tainted" (fix C):
          //  - the read SUCCEEDS and returns tainted=true → the run DID fire a non-idempotent tool →
          //    QUARANTINE: throw the terminal `DurableRunNotRetriedError` (refuse the re-run forever).
          //  - the read THROWS (a momentary DB blip) → we must NOT silently re-run on an uncertain taint
          //    (the safety direction holds), but we must ALSO not permanently dead-letter a SAFE run as a
          //    "quarantine": RETRY the READ a bounded number of times first, and only if it STILL fails
          //    rethrow the ORIGINAL DB error. The original error is recorded as the step outcome (terminal-
          //    failed, diagnosable as a transient DB issue — NOT a taint quarantine), and the run is NEVER
          //    re-executed off an unresolved taint read. (Whole-run re-execution memoizes a thrown step
          //    error, so making the READ itself retryable in-place — not the run — is the correct seam.)
          const tainted = await readTaintWithBoundedRetry(tdb, job.runId);
          if (tainted) {
            throw new DurableRunNotRetriedError(job.runId);
          }
          // ── Already-succeeded short-circuit (TEST-FLAKE-2 — the double-MODEL-BILL window) ──────
          // The run is UNTAINTED, but it may have ALREADY SUCCEEDED on the first attempt: run-core
          // commits the `runs` header (status='completed') at the END of the first `runAgent`, yet DBOS
          // can still RE-DISPATCH this workflow afterwards (a step-outcome checkpoint lost under load —
          // the observed cron-scheduler flake where `liveRuns` intermittently saw 2). The untainted
          // fall-through would then re-invoke `runAgent` for a result that is ALREADY DURABLE → the
          // model is BILLED A SECOND TIME. So: if the durable header is already terminal-SUCCESS,
          // complete the step as a NO-OP (the durable result stands; do NOT re-run, do NOT re-bill).
          // On a PERSISTENT header-read failure the helper returns false → we FALL THROUGH to the safe
          // re-run (never SKIP a needed retry): the run is already known untainted, so a re-run is safe
          // and the only cost is a possible re-bill — exactly today's untainted behavior.
          if (await readRunSucceededWithBoundedRetry(tdb, job.runId)) {
            return; // durable success already exists — a no-op success step, NOT a re-bill re-run.
          }
          // else: untainted + no completed header ⇒ a genuinely-interrupted SAFE run — fall through and
          // re-run (the unchanged safe automated retry for the untainted class).
        }

        // ── Run the EXISTING runAgent off-request, inside the GUC transaction ─────────────────
        const effectiveSpec: AgentSpec = {
          ...resolved.spec,
          input: job.input,
          ...(job.instructions !== undefined ? { instructions: job.instructions } : {}),
          ...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
        };
        // The AUTONOMOUS-COMMIT taint handle: a SEPARATE non-transactional forTenant(db, tenantId) so the
        // chokepoint's `run_taint` marker commits on its OWN connection BEFORE the side effect — it
        // SURVIVES a crash that rolls back the run's `tdb.transaction()` below (a crashed-after-side-
        // effect run stays visibly tainted, never re-runnable-as-untainted). This is the off-request
        // analog of the `run_started` reserve, which the executor also commits OUTSIDE the run's tx.
        const taintDb = forTenant(this.#deps.db, job.tenantId);
        // Wrap runAgent in the tenant GUC transaction (RLS-ready). run-core persists the journal /
        // run_events / run header / conversation under this runId, tenant-scoped — UNCHANGED. Build
        // the run's tools from the SAME transactional handle (prefer the tenant-bound factory, like
        // the sync run surface) so a tool handler's HandlerDb shares the GUC transaction.
        await tdb.transaction(async (txTenant) => {
          const tools = resolved.toolFactory ? resolved.toolFactory(txTenant) : resolved.tools;
          await runAgent(txTenant, resolved.backend, effectiveSpec, {
            runId: job.runId,
            taintDb,
            ...(tools ? { tools } : {}),
          });
        });
      },
      // The step is NOT retried in-step (default retriesAllowed:false) — no in-step auto-retry.
      { name: 'runAgent', retriesAllowed: false },
    );
  }

  async start(): Promise<void> {
    if (this.#started) return;
    DBOS.setConfig({
      name: this.#config.name,
      systemDatabaseUrl: this.#config.systemDatabaseUrl,
      // SECURITY (no hidden listener): DISABLE the DBOS admin HTTP server. By default
      // `DBOS.launch()` starts an UNAUTHENTICATED admin HTTP server on `adminPort` (3001) that binds
      // ALL interfaces with wildcard CORS and can cancel/resume/restart/list workflows — and it
      // SWALLOWS an EADDRINUSE (it only `logger.warn`s; verified in the installed 4.21.6
      // dbos.js:235-251). That contradicts the LOCAL/no-hidden-listener/fail-closed posture of
      // @rayspec/server. `runAdminServer`/`adminPort` are TOP-LEVEL fields on the
      // `DBOSConfig` that `DBOS.setConfig` accepts (dbos-executor.d.ts:54-55); at launch
      // `translateRuntimeConfig` reads `config.runAdminServer ?? true` (config.js:171-174) and the
      // launch path only starts the server `if (runtimeConfig.runAdminServer)` (dbos.js:235). Setting
      // it false here means NO admin listener is ever bound. (NOTE: this is NOT the YAML `ConfigFile`
      // `runtimeConfig:{ runAdminServer }` nesting — `DBOSConfig` has no `runtimeConfig` field, so the
      // top-level field is the correct + only typeable shape for the programmatic setConfig surface.)
      runAdminServer: false,
      ...(this.#config.logger ? { logger: this.#config.logger } : {}),
    });

    // Register the SINGLE durable workflow BEFORE launch (so crash-recovery knows about it).
    // maxRecoveryAttempts:1 = layer 1 (cap DBOS recovery so a perpetually-crashing job dead-letters at
    // MAX_RECOVERY_ATTEMPTS_EXCEEDED instead of looping); the started-once guard (layer 2, in the body)
    // is the real never-silently-re-fire guarantee.
    this.#runAgentJob = DBOS.registerWorkflow((job: RunJob) => this.#runAgentJobBody(job), {
      name: 'runAgentJob',
      maxRecoveryAttempts: 1,
    });

    // Run the pre-launch hooks (the cron scheduler registers its DBOS scheduled-workflows
    // HERE — after registerWorkflow, before launch — so the `ScheduledReceiver` lifecycle callback
    // picks them up at launch). Any other future pre-launch registration rides this same window.
    for (const hook of this.#preLaunchHooks) hook();

    // Launch BEFORE registering the queue: `registerQueue` is DB-backed and requires DBOS to be
    // launched first (verified doc-first against 4.21.6 — `ensureDBOSIsLaunched` throws otherwise).
    await DBOS.launch();

    // The off-request queue (DBOS-native worker-concurrency cap — the SAFE-half semaphore).
    await DBOS.registerQueue(AGENT_RUNS_QUEUE, {
      workerConcurrency: this.#config.workerConcurrency ?? DEFAULT_WORKER_CONCURRENCY,
    });

    this.#started = true;
  }

  async enqueue(_tenantId: string, job: RunJob): Promise<EnqueueResult> {
    if (!this.#started || !this.#runAgentJob) {
      throw new Error(
        'DbosDurableExecutor.enqueue called before start() — launch the engine first.',
      );
    }
    // The durable workflow id IS the pre-minted, idempotency-reserved runId: DBOS's workflow-id
    // idempotency law (same id ⇒ at most one workflow) + our reserve interlock to exactly one job
    // per Idempotency-Key. The queue dequeues + runs it off-request with the worker-concurrency cap.
    const handle = await DBOS.startWorkflow(this.#runAgentJob, {
      workflowID: job.runId,
      queueName: AGENT_RUNS_QUEUE,
    })(job);
    return { jobId: handle.workflowID };
  }

  async status(jobId: string): Promise<DurableJobStatus> {
    if (!this.#started) return 'unknown';
    const status = await DBOS.getWorkflowStatus(jobId);
    return toNeutralStatus(status?.status);
  }

  async shutdown(): Promise<void> {
    if (!this.#started) return;
    // GRACEFUL DRAIN (SAFE half): DBOS.shutdown() deactivates the event/queue receivers (stops
    // dequeuing) and then destroys the executor, which AWAITS running workflows to quiescence
    // (`awaitRunningWorkflows` in the installed 4.21.6 dbos-executor.js) — so an in-flight runAgentJob
    // FINISHES before this resolves (no orphaned mid-run job). `deregisterOnShutdown` (TEST-ONLY) also
    // clears the process-global workflow registry so a fresh executor can re-register in the same process.
    await DBOS.shutdown(this.#config.deregisterOnShutdown ? { deregister: true } : undefined);
    this.#started = false;
  }
}
