/**
 * Scheduled workflows whose schedule outlives an unreachable workflow system database.
 *
 * DBOS's own scheduler (`DBOS.registerScheduled`) starts each instant's workflow from a loop that
 * nothing awaits until shutdown and that does not catch: when the system database refuses a
 * connection at an instant (a failover, a restart, a database that stopped accepting connections),
 * `DBOS.startWorkflow` rejects, the loop ends, and the rejection is unhandled, so Node ends the
 * process. Every deployment with a durable worker schedules at least the system cleanup, so a brief
 * outage of the workflow database took the whole server down instead of making it not ready.
 *
 * This is that loop, run by this package, with what a failure does changed and nothing else:
 *  - the same slot arithmetic: DBOS's own crontab matcher, loaded from the installed SDK;
 *  - the same workflow id per instant, `sched-<class>.<name>-<ISO>` (a function registered with
 *    `DBOS.registerWorkflow` has an empty class name), started on the same internal queue, with the
 *    same jitter, so an instant is deduplicated exactly as it was;
 *  - for `ExactlyOncePerInterval` (make-up work), the same persisted watermark under the same key, so
 *    a deployment upgraded from DBOS's scheduler resumes where that scheduler stopped.
 *
 * WHEN AN INSTANT CANNOT BE STARTED, the loop says so once per failure streak, waits
 * {@link SCHEDULE_RETRY_MS} and tries again; it says so again when a start succeeds. In
 * `ExactlyOncePerIntervalWhenActive` (no make-up work) the instants that passed while the database
 * was unreachable are not made up: the loop continues from the current time. In
 * `ExactlyOncePerInterval` it retries the same instant, and then makes up every later one, which is
 * what that mode promises for time the deployment could not fire. The loop ends only on shutdown.
 *
 * Registration is pre-launch, like DBOS's: the schedule is associated with the registered workflow
 * in DBOS's own registry (so `DBOS.shutdown({ deregister: true })` clears it with everything else),
 * and one lifecycle listener starts the loops at `DBOS.launch()` and stops them at `DBOS.shutdown()`,
 * before the system database closes.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { DBOS, type DBOSLifecycleCallback, SchedulerMode } from '@dbos-inc/dbos-sdk';

/** How long a loop waits before it tries an instant again after a start failed. */
export const SCHEDULE_RETRY_MS = 1_000;

/** The registry key this package's schedules are associated under. */
const SCHEDULE_SERVICE = 'rayspec.schedule';
/** The service DBOS's scheduler keeps its make-up watermark under; kept so an upgrade resumes it. */
const WATERMARK_SERVICE = 'dbos.scheduler';

/** The body DBOS calls for an instant: `(scheduledTime, startTime)`. */
export type ScheduledWorkflowBody = (scheduledTime: Date, startTime: Date) => Promise<void>;

/** Where a loop reports a failure streak and its end (defaults to `console`). */
export interface ScheduleLogger {
  warn(message: string): void;
}

interface ScheduleConfig {
  crontab: string;
  mode: SchedulerMode;
  logger: ScheduleLogger;
}

/** DBOS's crontab matcher, as its scheduler uses it. */
interface TimeMatcher {
  nextWakeupTime(date: Date | number): Date;
  match(date: Date | number): boolean;
}

interface SchedulerInternals {
  validateCrontab: (pattern: string) => string;
  TimeMatcher: new (pattern: string) => TimeMatcher;
  internalQueueName: string;
}

let internals: SchedulerInternals | undefined;

/**
 * The parts of the installed SDK its scheduler runs on, loaded lazily. The SDK's `exports` map exposes
 * only `.` and `./datasource`, so its crontab and utility modules have no bare specifier — resolve the
 * SDK entrypoint FILE and load them beside it (an absolute path is outside the map's jurisdiction, and
 * they are the identical installed files DBOS's own scheduler runs). Lazy + memoized so an SDK-layout
 * change on upgrade fails the first call loudly instead of breaking every import of this package.
 *
 * A load failure is its OWN, self-describing error, never the underlying `MODULE_NOT_FOUND`: this is
 * an INSTALLATION fault (a moved/renamed module in an upgraded SDK), never a fault in a crontab value.
 */
export function loadSchedulerInternals(): SchedulerInternals {
  if (internals === undefined) {
    try {
      const req = createRequire(import.meta.url);
      const sdkDir = path.dirname(req.resolve('@dbos-inc/dbos-sdk'));
      const crontab = req(path.join(sdkDir, 'scheduler', 'crontab.js')) as {
        validateCrontab: SchedulerInternals['validateCrontab'];
        TimeMatcher: SchedulerInternals['TimeMatcher'];
      };
      const utils = req(path.join(sdkDir, 'utils.js')) as { INTERNAL_QUEUE_NAME: string };
      if (
        typeof crontab.TimeMatcher !== 'function' ||
        typeof utils.INTERNAL_QUEUE_NAME !== 'string'
      ) {
        throw new Error('the crontab matcher or the internal queue name is missing');
      }
      internals = {
        validateCrontab: crontab.validateCrontab,
        TimeMatcher: crontab.TimeMatcher,
        internalQueueName: utils.INTERNAL_QUEUE_NAME,
      };
    } catch (e) {
      throw new Error(
        "the scheduler's crontab parser could not be loaded from the installed " +
          `'@dbos-inc/dbos-sdk' (expected 'scheduler/crontab.js' beside its entrypoint): ` +
          `${e instanceof Error ? e.message : String(e)}. This is an SDK-layout fault, not a fault ` +
          'in any crontab value.',
      );
    }
  }
  return internals;
}

/** What one loop needs from the engine; injectable so the loop's failure handling is unit-testable. */
export interface ScheduleLoopDeps {
  /** Start the instant's workflow under its id (rejects when the system database refuses). */
  start(workflowId: string, scheduledTime: Date): Promise<void>;
  /** The persisted make-up watermark (epoch ms), if any. */
  readWatermark(): Promise<number | undefined>;
  /** Persist the make-up watermark; resolves to the watermark to continue from. */
  writeWatermark(time: number): Promise<number>;
  logger: ScheduleLogger;
  /** Default {@link SCHEDULE_RETRY_MS}. */
  retryMs?: number;
  /** Default `Date.now`. */
  now?: () => number;
}

/** Resolve after `ms`, or at once when the signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One schedule's loop: DBOS's `#schedulerLoop`, except that a failed start is retried instead of
 * ending the loop (see the module header). Never rejects; returns once `signal` aborts.
 */
export async function runScheduleLoop(
  name: string,
  matcher: TimeMatcher,
  mode: SchedulerMode,
  deps: ScheduleLoopDeps,
  signal: AbortSignal,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? SCHEDULE_RETRY_MS;
  let failing = false;
  const failed = (what: string, e: unknown) => {
    if (!failing) {
      deps.logger.warn(
        `[schedule] ${what} of the scheduled workflow '${name}' failed (${message(e)}); the ` +
          `schedule keeps running and tries again every ${retryMs} ms`,
      );
    }
    failing = true;
  };
  const recovered = () => {
    if (failing) deps.logger.warn(`[schedule] the scheduled workflow '${name}' starts again`);
    failing = false;
  };

  let lastExec = new Date(now()).setMilliseconds(0);
  if (mode === SchedulerMode.ExactlyOncePerInterval) {
    for (;;) {
      if (signal.aborted) return;
      try {
        const stored = await deps.readWatermark();
        if (stored) lastExec = stored;
        break;
      } catch (e) {
        failed('reading the last fired instant', e);
        await pause(retryMs, signal);
      }
    }
  }

  while (!signal.aborted) {
    const nextExec = matcher.nextWakeupTime(lastExec).getTime();
    let sleepTime = nextExec - now();
    // The jitter DBOS applies: up to 10% of the sleep, at most 10 s.
    if (sleepTime > 0) sleepTime += Math.random() * Math.min(sleepTime / 10, 10_000);
    if (sleepTime > 0) await pause(sleepTime, signal);
    if (signal.aborted) return;
    // The matcher has not found the next occurrence yet: let it take another step.
    if (!matcher.match(nextExec)) {
      lastExec = nextExec;
      continue;
    }
    try {
      await deps.start(`sched-${name}-${new Date(nextExec).toISOString()}`, new Date(nextExec));
    } catch (e) {
      failed(`starting the instant ${new Date(nextExec).toISOString()}`, e);
      await pause(retryMs, signal);
      // No make-up work in this mode: continue from now, not from the instant that failed.
      if (mode !== SchedulerMode.ExactlyOncePerInterval) {
        lastExec = Math.max(nextExec, new Date(now()).setMilliseconds(0));
      }
      continue;
    }
    recovered();
    lastExec = await deps.writeWatermark(nextExec);
  }
}

/** The registered workflow and its schedule, as DBOS's registry returns them. */
interface ScheduleRegistration {
  methodReg: {
    className: string;
    name: string;
    registeredFunction?: ScheduledWorkflowBody;
    workflowConfig?: unknown;
  };
  methodConfig: Partial<ScheduleConfig>;
}

/** Starts every registered schedule's loop at launch and stops them at shutdown. */
class ScheduleLoops implements DBOSLifecycleCallback {
  #controller = new AbortController();
  #loops: Promise<void>[] = [];

  async initialize(): Promise<void> {
    this.#controller = new AbortController();
    const { TimeMatcher, internalQueueName } = loadSchedulerInternals();
    for (const reg of DBOS.getAssociatedInfo(SCHEDULE_SERVICE) as readonly ScheduleRegistration[]) {
      const { methodReg, methodConfig } = reg;
      const fn = methodReg.registeredFunction;
      if (!methodConfig.crontab || !methodReg.workflowConfig || fn === undefined) continue;
      const name = `${methodReg.className}.${methodReg.name}`;
      const logger = methodConfig.logger ?? console;
      const deps: ScheduleLoopDeps = {
        start: async (workflowID, scheduledTime) => {
          await DBOS.startWorkflow(fn, { workflowID, queueName: internalQueueName })(
            scheduledTime,
            new Date(),
          );
        },
        readWatermark: async () => {
          const state = await DBOS.getEventDispatchState(WATERMARK_SERVICE, name, 'lastState');
          return state?.value ? Number.parseFloat(state.value) : undefined;
        },
        writeWatermark: async (time) => {
          // Not essential to firing (DBOS's scheduler treats it the same way): a failed write is
          // reported and the loop continues from the instant it just started.
          try {
            const stored = await DBOS.upsertEventDispatchState({
              service: WATERMARK_SERVICE,
              workflowFnName: name,
              key: 'lastState',
              value: `${time}`,
              updateTime: time,
            });
            const storedTime = Number.parseFloat(stored.value ?? '');
            return storedTime > time ? storedTime : time;
          } catch (e) {
            logger.warn(
              `[schedule] recording the last fired instant of '${name}' failed (${message(e)})`,
            );
            return time;
          }
        },
        logger,
      };
      this.#loops.push(
        runScheduleLoop(
          name,
          new TimeMatcher(methodConfig.crontab),
          methodConfig.mode ?? SchedulerMode.ExactlyOncePerIntervalWhenActive,
          deps,
          this.#controller.signal,
        ),
      );
    }
  }

  async destroy(): Promise<void> {
    this.#controller.abort();
    await Promise.allSettled(this.#loops.splice(0));
  }
}

const loops = new ScheduleLoops();

/**
 * Schedule a workflow registered with `DBOS.registerWorkflow` on a crontab. MUST run BEFORE
 * `DBOS.launch()`, like `DBOS.registerScheduled`, which it replaces (see the module header).
 */
export function registerScheduledWorkflow(
  body: ScheduledWorkflowBody,
  config: { name: string; crontab: string; mode?: SchedulerMode; logger?: ScheduleLogger },
): void {
  const { regInfo } = DBOS.associateFunctionWithInfo(SCHEDULE_SERVICE, body, { name: config.name });
  Object.assign(regInfo, {
    crontab: config.crontab,
    mode: config.mode ?? SchedulerMode.ExactlyOncePerIntervalWhenActive,
    ...(config.logger ? { logger: config.logger } : {}),
  });
  // Idempotent: DBOS keeps one entry per listener, and a deregistering shutdown clears it.
  DBOS.registerLifecycleCallback(loops);
}
