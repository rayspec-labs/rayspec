/**
 * `SystemCleanupScheduler` — the daily PLATFORM/SYSTEM housekeeping scheduled-workflow.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS (a SYSTEM job, NOT a tenant cron trigger).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `DbosCronScheduler` fires a deployment's DECLARED cron TRIGGERS under one tenant. This is
 * different: ONE platform-WIDE housekeeping job, across ALL tenants + the global tables, that no spec
 * declares. It prunes expired OIDC token rows (LIVE) and runs the operator-gated GDPR tombstone purge
 * (DRY-RUN by default). It does NOT use `RAYSPEC_CRON_TENANT_ID` (that is for tenant cron triggers) —
 * the OIDC prune + user-tombstone purge are GLOBAL; the membership purge iterates orgs for per-org
 * retention via its own join. The concrete cleanup logic is INJECTED as a neutral `runCleanup()` callback
 * (exactly like `DbosCronScheduler` injects `invokeTriggerHandler`) so THIS engine package stays
 * api-auth-free / engine-only — it owns ONLY the DBOS scheduled-workflow registration + logging.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE GUARANTEE — at-MOST-once-per-instant via the DBOS scheduled-workflow id; NO reserve marker needed.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DBOS's scheduled-workflow id (`sched-{name}-{ISO}`, default mode `ExactlyOncePerIntervalWhenActive` —
 * no make-up work for missed intervals) runs the body at most once per (schedule, instant). Unlike the
 * cron scheduler, the cleanup OPS ARE NATURALLY IDEMPOTENT: each deletes ALREADY-eligible rows (expired
 * tokens / past-retention tombstones), so a duplicate or replayed tick deletes the same (now-empty) set —
 * a harmless no-op. Therefore this job needs NO tenant-scoped `idempotency_keys` reserve (the cron
 * scheduler needs one only because its handler/agent dispatch is NOT idempotent). Documented so a fresh
 * session does not "fix" a missing reserve that is correctly absent.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HONEST LIMITATION — runs ONLY when a durable worker is wired (`deployment.durableWorker:true`).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DBOS scheduled-workflows only fire after `DBOS.launch()`, and the ONLY boot path that launches DBOS is
 * the durable-worker wiring in the composition root. So an AUTH-ONLY boot (no durable worker) does NOT run
 * this cleanup — expired OIDC rows + GDPR tombstones would accumulate there until a worker boot. This is
 * the accepted LOCAL posture: the cleanup rides on the durable worker by design (the composition root
 * registers this whenever the executor exists, INDEPENDENT of whether the spec declares cron triggers).
 * A future auth-only-also-cleans path (e.g. a lightweight in-process timer) is a build-on-demand follow-up.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import type { DurableExecutor } from '@rayspec/platform';

/** The default crontab — 3am daily (a quiet hour). Overridable via `RAYSPEC_CLEANUP_SCHEDULE`. */
export const DEFAULT_CLEANUP_SCHEDULE = '0 3 * * *';

/** The DBOS scheduled-workflow name for the single system cleanup job (namespaced under the app name). */
export const SYSTEM_CLEANUP_WORKFLOW_NAME = 'system:cleanup';

/**
 * The neutral cleanup RESULT the injected `runCleanup()` returns. The scheduler only LOGS it (count +
 * mode), so it keeps the engine package decoupled from api-auth's richer `CleanupResult` — this is the
 * minimal shape the scheduler reads for its log line. `runCleanup` may return a superset (the api-auth
 * `CleanupResult` structurally satisfies this).
 */
export interface SystemCleanupOutcome {
  /** Expired OIDC token rows hard-deleted (LIVE). */
  readonly oidcPruned: number;
  readonly gdpr: {
    readonly mode: 'disabled' | 'enabled';
    readonly users: number;
    readonly memberships: number;
    readonly oldestTombstoneAgeDays: number;
  };
}

/** A minimal logger sink (the composition root passes the platform logger; defaults to `console`). */
export interface CleanupLogger {
  info(message: string): void;
  error(message: string): void;
}

/** The dependencies the system cleanup scheduler runs with — all neutral (no api-auth/DBOS leakage). */
export interface SystemCleanupSchedulerDeps {
  /**
   * The injected cleanup function (the composition root binds `runScheduledCleanup` over the worker Db +
   * the gate/retention config). Kept injected so this engine package does NOT import @rayspec/api-auth —
   * the concrete logic stays the single source of truth there, exactly like the cron scheduler injects
   * `invokeTriggerHandler`. Returns the outcome the scheduler logs.
   */
  readonly runCleanup: () => Promise<SystemCleanupOutcome>;
  /** The crontab the job fires on (composition root resolves `RAYSPEC_CLEANUP_SCHEDULE` → default 3am daily). */
  readonly schedule?: string;
  /** Where the per-run summary line is logged (default `console`). */
  readonly logger?: CleanupLogger;
  /**
   * The durable executor — accepted ONLY so the scheduler's wiring mirrors `DbosCronScheduler`'s
   * shape (the composition root passes the same instance). The system cleanup body does NOT enqueue agent
   * runs (it is pure housekeeping), so this is currently unused beyond shape-parity; kept for a future op
   * that might dispatch a run. Optional.
   */
  readonly executor?: DurableExecutor;
}

/** The default crontab + console logger when not supplied. */
const CONSOLE_LOGGER: CleanupLogger = {
  info: (m) => console.info(m),
  error: (m) => console.error(m),
};

/**
 * Register + fire the daily system cleanup as a DBOS scheduled-workflow. Wired by the composition root via
 * `executor.attachPreLaunchHook(() => scheduler.registerScheduledWorkflow())` — DBOS's `registerScheduled`
 * is static + pre-launch by design (the `ScheduledReceiver` lifecycle callback starts the schedule loop at
 * launch). The body runs the injected `runCleanup()` and logs one summary line; `runCleanupNow()` is the
 * deterministic on-demand seam (tests + ops) that goes through the EXACT SAME `#run` path.
 */
export class SystemCleanupScheduler {
  readonly #deps: SystemCleanupSchedulerDeps;
  readonly #schedule: string;
  readonly #logger: CleanupLogger;
  #registered = false;

  constructor(deps: SystemCleanupSchedulerDeps) {
    this.#deps = deps;
    this.#schedule = deps.schedule ?? DEFAULT_CLEANUP_SCHEDULE;
    this.#logger = deps.logger ?? CONSOLE_LOGGER;
  }

  /** The crontab this scheduler fires on (for the boot banner / tests). */
  get schedule(): string {
    return this.#schedule;
  }

  /**
   * Register the ONE DBOS scheduled-workflow for the daily cleanup. MUST run BEFORE `DBOS.launch()` (the
   * pre-launch window the executor exposes). Idempotent: a second call is a no-op (a second register would
   * duplicate the schedule loop). The body is a registered DBOS workflow so a crash-replay re-invokes it —
   * and because the cleanup ops are naturally idempotent, that replay is harmless (no reserve needed).
   */
  registerScheduledWorkflow(): void {
    if (this.#registered) return;
    const body = DBOS.registerWorkflow(
      async (_scheduledTime: Date): Promise<void> => {
        await this.#run();
      },
      { name: SYSTEM_CLEANUP_WORKFLOW_NAME },
    );
    DBOS.registerScheduled(body as (scheduledTime: Date, startTime: Date) => Promise<void>, {
      name: SYSTEM_CLEANUP_WORKFLOW_NAME,
      crontab: this.#schedule,
    });
    this.#registered = true;
  }

  /**
   * Fire the cleanup IMMEDIATELY through the EXACT SAME path as a scheduled fire (for tests, the demo, and
   * an operator who must run housekeeping now). Returns the cleanup outcome so a test asserts on the
   * structured result (robust, not log-spying). Naturally idempotent — calling twice is harmless.
   */
  async runCleanupNow(): Promise<SystemCleanupOutcome> {
    return this.#run();
  }

  /** The shared run path: invoke the injected cleanup, log one summary line, return the outcome. */
  async #run(): Promise<SystemCleanupOutcome> {
    try {
      const outcome = await this.#deps.runCleanup();
      this.#logger.info(formatSystemCleanupLog(outcome));
      return outcome;
    } catch (e) {
      // A cleanup failure must be LOUD (a silently-failing housekeeping job lets expired rows / tombstones
      // accumulate unnoticed) but must NOT crash the worker. Log + rethrow so the DBOS workflow records a
      // terminal failure for the instant (the next daily tick retries cleanly — the ops are idempotent).
      this.#logger.error(
        `[cleanup] FAILED: ${e instanceof Error ? e.message : String(e)} (the next daily tick retries; ops are idempotent)`,
      );
      throw e;
    }
  }
}

/**
 * Format the scheduler's one-line summary from the neutral outcome. Mirrors api-auth's
 * `formatCleanupLogLine` but over the minimal engine-local shape (so the engine package needs no api-auth
 * import). Pure + exported so it is testable.
 */
export function formatSystemCleanupLog(outcome: SystemCleanupOutcome): string {
  const { oidcPruned, gdpr } = outcome;
  const verb = gdpr.mode === 'enabled' ? 'purged' : 'would purge (DRY-RUN, gate OFF)';
  return (
    `[cleanup] oidc: pruned ${oidcPruned} expired token row(s); ` +
    `gdpr[${gdpr.mode}]: ${verb} ${gdpr.users} user + ${gdpr.memberships} membership tombstone(s), ` +
    `oldest ${gdpr.oldestTombstoneAgeDays} day(s) old`
  );
}
