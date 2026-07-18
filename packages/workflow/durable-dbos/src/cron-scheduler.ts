/**
 * `DbosCronScheduler` — the IDEMPOTENT CRON firing runtime (at-MOST-once-per-instant by default;
 * opt-in missed-interval CATCH-UP per trigger).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS (cron ONLY — per-kind build-on-demand).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The triggers PARSE/REGISTER seam (`registerTriggers` → `TriggerRegistry` →
 * `TriggerDescriptor`/`ResolvedTriggerAction`) carries a fail-closed `fireTrigger():never` runtime edge.
 * This module is the FIRING runtime for the ONE trigger kind a consumer declares: **cron** (e.g. a
 * `nightly-digest`). webhook/event/manual stay RESERVED per-kind (a `webhook`/`event`/
 * `manual` descriptor is NOT fired here — see `assertCronOnly`); building them for a single consumer is premature.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE GUARANTEE — IDEMPOTENT, at-MOST-once-per-instant (NOT at-least-once; read this carefully).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This runtime guarantees a (trigger, instant) NEVER double-fires — exactly one dispatch per logical
 * firing instant. It does NOT guarantee at-least-once DELIVERY: there is a window where a fire can be
 * DROPPED (see the crash-window note below). "At-MOST-once-per-instant" is the honest, precise claim;
 * the reserve is an IDEMPOTENCY / exactly-once-cap guard, NOT an "at-least-once backstop".
 *
 * For a given cron trigger firing at instant T:
 *  1. DBOS's scheduled-workflow gives a deterministic workflow id `sched-{name}-{ISO}` whose
 *     workflow-id idempotency law runs the SCHEDULED-WORKFLOW BODY at most once per (schedule, T)
 *     across the engine (verified doc-first against the installed 4.21.6 scheduler source:
 *     `scheduler_decorator.js:121` derives `sched-${name}-${date.toISOString()}` and starts the
 *     workflow under that id; default mode `ExactlyOncePerIntervalWhenActive` = fire once per interval
 *     WHILE THE APP IS ACTIVE, NO make-up work for intervals missed while the app was down. A trigger
 *     that opts into CATCH-UP (`descriptor.catchUp`) is instead registered in `ExactlyOncePerInterval`,
 *     the make-up-work mode — see the CATCH-UP section below; verified doc-first against
 *     `scheduler_decorator.d.ts:5-17` + the `#schedulerLoop` replay in `scheduler_decorator.js:72-131`).
 *  2. INSIDE the body, BEFORE any dispatch, we RESERVE our OWN tenant-scoped marker
 *     `idempotency_keys(scope='trigger', key='trigger:{name}:{ISO}')` via the atomic
 *     INSERT..ON CONFLICT DO NOTHING RETURNING. This is the IDEMPOTENCY / exactly-once-cap guard —
 *     it makes a duplicate body invocation (a second ticker, a `fireTrigger` racing the scheduler, a
 *     crash-replay of the body) a harmless NO-OP, and it is the layer the on-demand `fireNow` seam
 *     reuses (where DBOS's scheduled-workflow id is NOT in the loop). LOSE the reserve ⇒ no dispatch.
 *  3. For an AGENT action, the enqueued run's `runId` is DETERMINISTIC from the firing key, so the
 *     `run_started` reserve + DBOS's workflow-id law dedup the run itself even if (2) were
 *     bypassed — defense-in-depth, never relied on alone (proven in executor.db.test.ts).
 *
 * So a SECOND fire of the same (trigger, instant) dispatches ZERO additional work: exactly one
 * `idempotency_keys` row, exactly one handler invocation / one `runAgentJob` (the
 * whole invariant — the at-MOST-once cap).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE CRASH WINDOW (the honest at-MOST-once caveat — NOT at-least-once; reliability work).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `#fire` RESERVES (commits the marker) BEFORE it dispatches, and the reserve is NOT wrapped in a
 * `DBOS.runStep`/durable step. So if the process CRASHES — or the handler/enqueue THROWS — in the
 * window AFTER the reserve commits but BEFORE the handler/enqueue completes, that one occurrence is
 * DROPPED: on recovery the scheduled-workflow body re-runs, LOSES the (now-committed) reserve, and
 * SKIPS the dispatch → no make-up work for that instant. This is CONSISTENT with DBOS's default
 * `ExactlyOncePerIntervalWhenActive` (no catch-up for missed intervals), and it is why the precise
 * claim is at-MOST-once, not at-least-once.
 *
 * TRUE at-least-once DELIVERY (retry-until-dispatched, surviving that crash window) is RELIABILITY
 * work — NOT built here. It cannot be bolted on naively: making cron at-least-once for a
 * NON-IDEMPOTENT handler re-fires the side effect on a crash-after-dispatch, which is exactly the
 * non-idempotent-taint quarantine's job. Until then, a cron handler/agent must be written to
 * tolerate a rare DROPPED instant (the at-MOST-once posture), and the dispatch must NOT be assumed to
 * have happened just because the reserve row exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * CATCH-UP (opt-in, per trigger — make up intervals missed while the deployment was DOWN).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A trigger with `descriptor.catchUp === true` is registered in DBOS's `ExactlyOncePerInterval` mode
 * (the make-up-work mode). On startup DBOS reads the schedule's persisted last-execution watermark and
 * REPLAYS every interval that should have fired between it and now — calling THIS scheduler's fire body
 * once per missed slot (verified doc-first: `#schedulerLoop` sets `lastExec` from the persisted
 * `lastState` and iterates `nextWakeupTime(lastExec)` up to now, firing each `sched-{name}-{ISO}` with
 * NO sleep/jitter for past slots, `scheduler_decorator.js:72-131`). DBOS owns the slot math — there is
 * no second cron parser here, so a replayed instant is BYTE-IDENTICAL to what the live tick would have
 * fired (no divergence, no same-slot double).
 *
 * The net contract for a catch-up trigger is EXACTLY-ONCE-WITH-CATCH-UP:
 *  - AT-LEAST-ONCE for a DOWNTIME-missed interval — one that never got a reserve because the app was
 *    down at its instant. The replay RESERVES it (a fresh firing key) and DISPATCHES it → recovered.
 *  - AT-MOST-ONCE preserved — the replay reuses the SAME tenant-scoped `idempotency_keys` reserve, so
 *    a slot that ALREADY fired (its reserve exists) is a deduped no-op on replay. An active-and-firing
 *    deployment is UNAFFECTED: its live-tick reserve makes the boot replay of that same slot a no-op.
 *  - BOUNDED look-back — the make-up dispatch is capped to a look-back window
 *    ({@link CronSchedulerDeps.catchUpLookbackMs}, default {@link DEFAULT_CATCHUP_LOOKBACK_MS}). A
 *    replayed slot OLDER than that window is RESERVED (consumed, so it never fires later) but NOT
 *    dispatched — unbounded history is never replayed. The bound applies ONLY to a scheduled replay of
 *    a catch-up trigger; an active fire (instant ≈ now) and an explicit `fireNow` are never bounded.
 *
 * HONEST BOUNDARY (what catch-up does NOT recover): the reserve-commit-then-crash DROP above stays
 * at-most-once even under catch-up. That interval's reserve row EXISTS (it fired, then the dispatch was
 * lost), so a replay sees the reserve and no-ops. Catch-up recovers intervals the app was DOWN for (no
 * reserve was ever written), NOT a fire that reserved and then crashed before dispatching.
 *
 * QUARANTINE COUPLING (the non-idempotent-taint quarantine — documented, not built here). The
 * quarantine (the `run_taint` marker — `@rayspec/platform` `markRunTainted` /
 * `isRunTainted`, written by the chokepoint before a non-idempotent tool fires, consulted by every
 * AUTOMATED re-run path) is the EXACT mechanism that would gate an at-least-once cron upgrade: a
 * cron→agent fire already runs through the durable spine, so its non-idempotent tools are taint-marked
 * and a retry is quarantined the same way an HTTP/worker re-run is. A cron→HANDLER fire does NOT go
 * through `dispatchTool`, so it has NO taint marker — therefore an at-least-once cron upgrade is
 * permissible ONLY for an IDEMPOTENT (non-side-effecting) handler; a side-effecting handler stays
 * at-MOST-once until either it is expressed as a tool-firing agent (so the taint marker covers it) or
 * intra-run journaling exists. This coupling is recorded so a future at-least-once
 * upgrade is built on the quarantine, never around it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DISPATCH — both action kinds (the named consumer `nightly-digest` is a HANDLER, not an agent run).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  - `handler` → `invokeTriggerHandler(handler.fn, forTenant(db, tenantId), productTables, name)` —
 *    the invocation point, which opens its OWN `tdb.transaction()` (the GUC seam). This is the
 *    build-now path (`nightly-digest`).
 *  - `agent`   → `enqueueAgentRun(...)` onto the `DurableExecutor` (`runAgentJob`), with a
 *    DETERMINISTIC runId derived from the firing key (so a double-fire dedups at the engine too).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TENANT — single-deployment LOCAL posture (multi-tenant cron fan-out is RESERVED, out of scope).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The scheduler is constructed with the deployment's `tenantId`; every fire dispatches under
 * `forTenant(db, tenantId)`. A different tenant can neither observe nor trigger it (the reserve +
 * dispatch are tenant-scoped structurally). Multi-tenant cron fan-out (one schedule fanning across
 * tenants) is a hosted-SaaS concern, NOT built here.
 *
 * SECURITY NOTE (reserved kinds): when webhook/event are LATER built, their payload is DATA fed to the
 * agent/handler via the opaque path — NEVER instructions. Recorded as a reserved-seam note; not built.
 */

import { createHash } from 'node:crypto';
import { DBOS, SchedulerMode } from '@dbos-inc/dbos-sdk';
import type { Db } from '@rayspec/db';
import { forTenant, schema } from '@rayspec/db';
import type {
  DurableExecutor,
  invokeTriggerHandler as InvokeTriggerHandlerFn,
  TriggerDescriptor,
} from '@rayspec/platform';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * The narrow trigger-handler shape the cron worker passes to `invokeTriggerHandler`. The platform
 * `ResolvedTriggerAction` carries the broad `ResolvedHandler` union (tool|route|trigger) on its
 * `handler`, but the registry GUARANTEES a handler trigger action's resolved handler is `kind:
 * 'trigger'` (it throws `TriggerRegistrationError` otherwise at boot). We re-assert that narrowing at
 * dispatch (defense-in-depth) before extracting `fn` — `Parameters<typeof InvokeTriggerHandlerFn>[0]`
 * is the platform's `TriggerHandler` type without this engine package importing `@rayspec/handler-sdk`.
 */
type TriggerHandlerFn = Parameters<typeof InvokeTriggerHandlerFn>[0];

/** The `idempotency_keys` scope for a cron firing-instant marker (the tenant-scoped idempotency key). */
export const TRIGGER_FIRE_SCOPE = 'trigger';

/**
 * The `body_hash` sentinel for a `trigger` firing marker. Its identity is its (tenant, scope,
 * idemKey=firingKey) UNIQUE key; `body_hash` is unused for it (just the non-null sentinel the column
 * needs), so a stable constant rather than a derived hash that would read as if a body were hashed.
 */
export const TRIGGER_FIRE_BODY_HASH = 'trigger_fire_marker';

/**
 * The fixed `input` a cron-fired AGENT run carries. A cron fire has no client request body; the
 * agent's declared instructions drive it. The neutral `AgentSpec.input` is `z.string().min(1)`, so a
 * non-empty, self-describing marker (rather than an empty string) satisfies the schema and reads
 * honestly in the journal/run header. Includes the trigger name (DATA — server-derived, not a tenant
 * signal). Kept small + deterministic so the same firing instant always produces the same `RunJob`.
 */
export function cronAgentInput(triggerName: string): string {
  return `(cron trigger: ${triggerName})`;
}

/**
 * The granularity (ms) the firing instant is truncated to before it becomes a firing key. Cron
 * resolution is one MINUTE (the finest crontab slot), so any sub-second/sub-minute difference between
 * the scheduler's `scheduledTime` and a `fireNow(name, instant)` for the "same" logical instant must
 * NOT produce a different key. We truncate to whole SECONDS — coarse enough that the scheduler's
 * second-aligned tick and a `fireNow` a few ms apart land in the SAME bucket (so they cross-dedup),
 * fine enough that two genuinely-distinct cron slots (≥1 minute apart) never collide.
 */
export const FIRING_INSTANT_GRANULARITY_MS = 1000;

/**
 * The DEFAULT look-back window (ms) a catch-up trigger will make up missed intervals within — 26 hours.
 * A replayed interval OLDER than this is reserved (consumed) but NOT dispatched, so unbounded history is
 * never replayed. 26h comfortably covers a daily (`nightly-digest`) trigger missing ONE scheduled day of
 * downtime plus slack, while refusing to fan out weeks of stale digests after a long outage. A deployment
 * with a coarser cadence (or that wants a wider make-up window) overrides via
 * {@link CronSchedulerDeps.catchUpLookbackMs}. Bounds the DISPATCH; DBOS's own replay iteration is
 * separately bounded by the actual downtime (its watermark advances as it replays each slot).
 */
export const DEFAULT_CATCHUP_LOOKBACK_MS = 26 * 60 * 60 * 1000;

/**
 * The DBOS scheduler mode a descriptor registers under — a PURE function of its `catchUp` opt-in:
 *  - `catchUp: true`  → `ExactlyOncePerInterval` (the make-up-work mode: on startup DBOS replays every
 *    interval missed while the app was down, calling the fire body once per missed slot).
 *  - otherwise        → `ExactlyOncePerIntervalWhenActive` (fire once per interval while active; NO
 *    make-up work — the historical default, byte-behaviourally unchanged for a non-catch-up trigger).
 * Exported so the mode selection is directly assertable (the make-up-work mode is what actually drives
 * the startup replay in production — the behavioural fire-path tests then prove the replay is
 * exactly-once + bounded).
 */
export function catchUpSchedulerMode(descriptor: { catchUp?: boolean }): SchedulerMode {
  return descriptor.catchUp === true
    ? SchedulerMode.ExactlyOncePerInterval
    : SchedulerMode.ExactlyOncePerIntervalWhenActive;
}

/**
 * Truncate a firing instant DOWN to {@link FIRING_INSTANT_GRANULARITY_MS} (whole seconds) and emit its
 * UTC ISO string. Deterministic + monotonic-flooring (`Math.floor`), so the same logical instant always
 * yields the same bucket regardless of the sub-second offset the body happened to run on. This is the
 * single normalization both `firingKey` and `cronRunId` key off (so they agree by construction).
 */
export function firingInstantIso(instant: Date): string {
  const truncatedMs =
    Math.floor(instant.getTime() / FIRING_INSTANT_GRANULARITY_MS) * FIRING_INSTANT_GRANULARITY_MS;
  return new Date(truncatedMs).toISOString();
}

/**
 * Derive the tenant-scoped firing KEY for a (trigger, instant): `trigger:{name}:{ISO}`. The instant is
 * normalized via `firingInstantIso` (truncated to whole seconds — the firing granularity) so the
 * scheduler's `(scheduledTime)` and an on-demand `fireNow(name, instant)` for the SAME logical instant
 * produce the SAME key even if they differ by a few ms (the at-most-once boundary is the truncated
 * instant, not the exact wall-clock the body happened to run on).
 */
export function firingKey(triggerName: string, instant: Date): string {
  return `trigger:${triggerName}:${firingInstantIso(instant)}`;
}

/**
 * Derive a DETERMINISTIC runId (UUID text) for a cron→agent fire from the firing key. Deterministic so
 * a double-fire of the SAME (trigger, instant) maps to the SAME runId → the `run_started`
 * reserve + DBOS's workflow-id law dedup the run itself (layer 3). Formatted as a v5-shaped UUID over
 * a SHA-256 of the firing key (the namespace is the scope) so `runs.run_id` (text) carries the
 * familiar UUID shape while staying a pure function of the instant. NOT security-sensitive — just a
 * stable, collision-resistant id; SHA-256 truncation is ample (the keyspace is one tenant's triggers).
 */
export function cronRunId(triggerName: string, instant: Date): string {
  const h = createHash('sha256')
    .update(`${TRIGGER_FIRE_SCOPE}:${firingKey(triggerName, instant)}`)
    .digest('hex');
  // Lay the first 32 hex chars out as a UUID (8-4-4-4-12). Set the version nibble to 5 and the
  // variant nibble to 8 so it is a well-formed v5-shaped UUID (purely cosmetic — determinism is the
  // contract, not RFC-4122 namespace semantics).
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The DEPENDENCIES the cron scheduler dispatches with. The scheduler is engine-aware (it owns the DBOS
 * scheduled-workflow registration) but its dispatch deps are NEUTRAL — the executor for agent runs,
 * `invokeTriggerHandler` + `productTables` for handler runs. Injected (not imported concretely beyond
 * the executor) so the platform's handler-invocation path stays the single source of truth.
 */
export interface CronSchedulerDeps {
  /** The raw Db handle (the composition root's makeDb). The scheduler binds `forTenant(db, tenantId)`. */
  readonly db: Db;
  /** The deployment tenant every cron fire dispatches under (single-deployment LOCAL posture). */
  readonly tenantId: string;
  /**
   * The durable executor — a cron→AGENT action enqueues a `runAgentJob` onto it (the agent run
   * runs off-request, journaled, exactly like an `async:true` HTTP run). The executor resolves the
   * `RunJob.agentId` against its live registry at fire time.
   */
  readonly executor: DurableExecutor;
  /**
   * The product tables map a cron→HANDLER action's `HandlerDb` facade is built over (the same map the
   * route/trigger handlers use). Empty for a stores-free deployment (a handler that touches no store).
   */
  readonly productTables: ReadonlyMap<string, PgTable>;
  /**
   * The platform's `invokeTriggerHandler` (injected so this engine package does not re-implement the
   * GUC-tx handler-invocation seam — it stays the single source of truth in `@rayspec/platform`).
   */
  readonly invokeTriggerHandler: typeof InvokeTriggerHandlerFn;
  /**
   * The look-back window (ms) a CATCH-UP trigger makes up missed intervals within (default
   * {@link DEFAULT_CATCHUP_LOOKBACK_MS}). A scheduled REPLAY of a catch-up interval older than this is
   * reserved (consumed) but NOT dispatched — bounding the make-up so an outage never fans out unbounded
   * stale history. Ignored for triggers that did not opt into `catchUp`, and never applied to an active
   * fire or an explicit `fireNow`. Optional; deployment-level (like `tenantId`).
   */
  readonly catchUpLookbackMs?: number;
}

/** Thrown when a NON-cron trigger reaches the cron scheduler (per-kind reservation — fail-closed). */
export class TriggerKindNotBuiltError extends Error {
  constructor(triggerName: string, kind: string) {
    super(
      `trigger '${triggerName}' is kind '${kind}', which the cron worker does NOT fire ` +
        '(only `cron` is built — webhook/event/manual are RESERVED per-kind, build-on-demand). ' +
        'This is a fail-closed rejection, not a silent no-op.',
    );
    this.name = 'TriggerKindNotBuiltError';
  }
}

/**
 * Assert a descriptor is a `cron` trigger with a schedule (the only kind this worker fires). A
 * webhook/event/manual descriptor THROWS `TriggerKindNotBuiltError` — never a silent fire (the
 * per-kind reservation). A cron descriptor missing `schedule` is a malformed registration (lint should
 * have caught it) → a loud throw, not a dangling schedule.
 */
export function assertCronOnly(
  descriptor: TriggerDescriptor,
): asserts descriptor is TriggerDescriptor & {
  kind: 'cron';
  schedule: string;
} {
  if (descriptor.kind !== 'cron') {
    throw new TriggerKindNotBuiltError(descriptor.name, descriptor.kind);
  }
  if (!descriptor.schedule) {
    throw new Error(
      `cron trigger '${descriptor.name}' has no schedule (a cron trigger must carry a crontab; ` +
        'this should have been lint-rejected at parse). Fail-closed.',
    );
  }
}

/**
 * The cron firing runtime over the DBOS spine. Construct it with the deployment's cron descriptors +
 * the dispatch deps, REGISTER its DBOS scheduled-workflows BEFORE `DBOS.launch()` (the executor drives
 * this ordering — see `DbosDurableExecutor`), and production fires on the crontab while tests + the
 * demo fire deterministically via `fireNow`.
 */
export class DbosCronScheduler {
  readonly #deps: CronSchedulerDeps;
  /** The cron descriptors this scheduler fires, keyed by name (cron-only — others rejected at add). */
  readonly #crons: Map<string, TriggerDescriptor & { kind: 'cron'; schedule: string }>;
  /** The bounded catch-up look-back window (ms) — a scheduled replay older than this is not made up. */
  readonly #catchUpLookbackMs: number;
  #registered = false;

  /**
   * @param descriptors EVERY registered descriptor (the full `TriggerRegistry.list()`). Cron ones are
   *   scheduled; a webhook/event/manual one is recorded as RESERVED and is fail-closed on a fire
   *   attempt (it is NOT scheduled — the per-kind reservation). We filter cron here so a mixed spec
   *   schedules only its cron triggers without rejecting the whole deployment.
   */
  constructor(descriptors: readonly TriggerDescriptor[], deps: CronSchedulerDeps) {
    this.#deps = deps;
    this.#catchUpLookbackMs = deps.catchUpLookbackMs ?? DEFAULT_CATCHUP_LOOKBACK_MS;
    this.#crons = new Map();
    for (const d of descriptors) {
      if (d.kind === 'cron') {
        // assertCronOnly also validates the schedule is present (a malformed cron is a loud throw).
        assertCronOnly(d);
        this.#crons.set(d.name, d);
      }
      // Non-cron descriptors are intentionally NOT scheduled (RESERVED per-kind). They remain in the
      // platform `TriggerRegistry`; this worker simply does not fire them. A direct fire attempt via
      // `fireNow` for a non-cron name is a clear "not a registered cron trigger" error.
    }
  }

  /** The names of the cron triggers this scheduler will fire (for the boot banner / tests). */
  get cronTriggerNames(): string[] {
    return [...this.#crons.keys()];
  }

  /**
   * Register one DBOS scheduled-workflow per cron trigger. MUST run BEFORE `DBOS.launch()` (DBOS's
   * `registerScheduled` is static + pre-launch by design; the `ScheduledReceiver` lifecycle callback
   * starts each schedule loop at launch). Each scheduled workflow is a registered DBOS workflow whose
   * body is the scheduled-fire path (`#fire(..., { fromSchedule: true })`) — so a crash-replay OR a
   * catch-up make-up replay of the body still hits the same idempotent reserve (and, for catch-up, the
   * bounded look-back). Idempotent: calling twice is a no-op (a second register would duplicate the
   * schedule loop).
   */
  registerScheduledWorkflows(): void {
    if (this.#registered) return;
    for (const [name, descriptor] of this.#crons) {
      // The scheduled-workflow body for THIS cron trigger. DBOS calls it `(scheduledTime, startTime)`;
      // we fire for the SCHEDULED instant (not the wall-clock the body ran on) so the firing key is
      // deterministic per slot. Wrapped as a registered DBOS workflow so a recovery re-invokes it (and
      // the idempotent reserve makes that a no-op). `fromSchedule` applies the catch-up look-back bound
      // for a catch-up trigger's make-up replay (an active fire, instant ≈ now, is never bounded).
      const workflowName = `cron:${name}`;
      const body = DBOS.registerWorkflow(
        async (scheduledTime: Date): Promise<void> => {
          await this.#fire(descriptor, scheduledTime, { fromSchedule: true });
        },
        { name: workflowName },
      );
      // Associate the registered workflow with the crontab. A catch-up trigger uses ExactlyOncePerInterval
      // (make-up work — DBOS replays missed intervals on startup); every other trigger keeps the historical
      // ExactlyOncePerIntervalWhenActive (no make-up work). The scheduled-workflow id `sched-{workflowName}
      // -{ISO}` gives engine-level at-most-once-per-instant; our reserve is the tenant-scoped idempotency /
      // exactly-once-cap guard (and, for a catch-up replay, the at-least-once make-up + dedup — see header).
      DBOS.registerScheduled(body as (scheduledTime: Date, startTime: Date) => Promise<void>, {
        name: workflowName,
        crontab: descriptor.schedule,
        mode: catchUpSchedulerMode(descriptor),
      });
    }
    this.#registered = true;
  }

  /**
   * Fire a registered cron trigger IMMEDIATELY for a given instant, through the EXACT SAME path as a
   * scheduled fire (same firing-key derivation, same reserve → dispatch). For tests + the CEO demo,
   * which cannot wait until 2am and need a deterministic fire. The exactly-once invariant is testable:
   * `fireNow(name, T)` twice for the same `T` dispatches ZERO additional work (the second loses the
   * reserve). `instant` defaults to `now` (millisecond-truncated to a stable slot); pass an explicit
   * `instant` to make the firing key fully deterministic.
   *
   * @returns whether THIS call won the reserve and dispatched (`true`) or was a deduped no-op (`false`).
   */
  async fireNow(name: string, instant: Date = new Date()): Promise<boolean> {
    const descriptor = this.#crons.get(name);
    if (!descriptor) {
      // Not a registered CRON trigger. If it is a registered non-cron trigger somewhere, it is RESERVED
      // (per-kind) — either way this worker does not fire it. A loud error, never a silent no-op.
      throw new Error(
        `fireNow: '${name}' is not a registered cron trigger on this scheduler ` +
          '(unknown, or a RESERVED webhook/event/manual kind not built here). Fail-closed.',
      );
    }
    return this.#fire(descriptor, instant);
  }

  /**
   * Fire a registered cron trigger through the EXACT scheduled-fire path DBOS drives (same firing-key
   * derivation, same reserve → dispatch), INCLUDING the catch-up look-back bound. This is the body the
   * registered DBOS scheduled-workflow runs — for an ACTIVE tick, a crash-recovery re-invocation, AND a
   * catch-up MAKE-UP replay of a missed interval. Exposed as a deterministic seam so a test can drive
   * the make-up path (a past `instant`) without waiting for DBOS's wall-clock loop:
   *  - a within-look-back missed interval → dispatched once (the reserve makes a re-replay a no-op);
   *  - a beyond-look-back interval on a catch-up trigger → reserved (consumed) but NOT dispatched.
   * The bound applies ONLY to a `catchUp` trigger; a non-catch-up trigger's scheduled fire is
   * byte-behaviourally identical to `fireNow` (reserve → dispatch, no bound).
   *
   * @returns `true` iff this call won the reserve and DISPATCHED; `false` if it was a deduped no-op OR a
   *   bounded (beyond-look-back) make-up skip.
   */
  async fireScheduled(name: string, instant: Date = new Date()): Promise<boolean> {
    const descriptor = this.#crons.get(name);
    if (!descriptor) {
      throw new Error(
        `fireScheduled: '${name}' is not a registered cron trigger on this scheduler ` +
          '(unknown, or a RESERVED webhook/event/manual kind not built here). Fail-closed.',
      );
    }
    return this.#fire(descriptor, instant, { fromSchedule: true });
  }

  /**
   * The shared fire path — reserve the tenant-scoped firing marker, then (iff we won, and — for a
   * catch-up make-up replay — within the look-back window) dispatch by action kind. The
   * reserve-BEFORE-dispatch ordering is the IDEMPOTENCY / at-MOST-once-per-instant guarantee (it can
   * never DOUBLE-fire). By DEFAULT it is NOT at-least-once: a crash/throw in the window between the
   * reserve commit and the dispatch completing DROPS that one occurrence (on recovery the body re-runs,
   * LOSES the committed reserve, and skips the dispatch — no make-up work). A `catchUp` trigger fired
   * `fromSchedule` gets at-least-once for DOWNTIME-missed intervals via DBOS's make-up replay (bounded
   * to `catchUpLookbackMs`); see the file header's crash-window + CATCH-UP notes.
   *
   * @param opts.fromSchedule whether this fire came from the DBOS scheduled-workflow body (an active
   *   tick, a crash-recovery replay, or a catch-up make-up replay). Only a `fromSchedule` fire of a
   *   `catchUp` trigger applies the bounded look-back; a `fireNow` (opts absent) never does.
   * @returns `true` iff this call won the reserve and dispatched; `false` if it was a deduped no-op OR a
   *   bounded make-up skip.
   */
  async #fire(
    descriptor: TriggerDescriptor & { kind: 'cron'; schedule: string },
    instant: Date,
    opts?: { fromSchedule?: boolean },
  ): Promise<boolean> {
    const { db, tenantId } = this.#deps;
    const key = firingKey(descriptor.name, instant);
    const tdb = forTenant(db, tenantId);

    // ── Reserve the firing marker BEFORE dispatch (the idempotency / exactly-once-cap guard) ──────
    // A single INSERT..ON CONFLICT DO NOTHING RETURNING over UNIQUE(tenant, scope, idem_key). The
    // FIRST fire of this (trigger, instant) wins → it dispatches; a duplicate (second ticker / a
    // fireNow racing the scheduler / a body crash-replay / a catch-up make-up replay of an
    // ALREADY-fired slot) LOSES → no-op (at-MOST-once-per-instant). This is the SAME reserve the
    // catch-up replay reuses, so a slot that already fired while the app was active is a no-op on the
    // startup make-up sweep (an active-and-firing deployment is unaffected).
    // NOTE (the at-MOST-once caveat): the reserve commits HERE, before the dispatch below, and is not
    // a durable step — so a crash/throw between this commit and the dispatch completing DROPS this
    // occurrence (recovery re-runs the body, loses this committed reserve, skips the dispatch). This is
    // NOT at-least-once; do not assume the dispatch fired just because this row exists.
    const reserved = await tdb
      .insert(schema.idempotencyKeys, {
        scope: TRIGGER_FIRE_SCOPE,
        idemKey: key,
        bodyHash: TRIGGER_FIRE_BODY_HASH,
        // Record the TRUNCATED firing instant (the dedup bucket) — not the raw sub-second wall-clock —
        // so the snapshot matches the key the reserve deduped on.
        snapshot: { trigger: descriptor.name, firedForInstant: firingInstantIso(instant) },
      })
      .onConflictDoNothing()
      .returning();
    if (reserved.length === 0) {
      // Already fired for this instant ⇒ deduped no-op (the whole point of the idempotency guard).
      return false;
    }

    // ── Bounded catch-up look-back (a make-up replay of a stale missed interval) ───────────────────
    // Only a SCHEDULED fire of a CATCH-UP trigger is bounded. DBOS's ExactlyOncePerInterval replay calls
    // this body once per interval missed while the app was down; a replayed interval OLDER than the
    // look-back window is RESERVED above (consumed — a later replay is a deduped no-op) but NOT
    // dispatched, so an outage never fans out unbounded stale history. An ACTIVE fire (instant ≈ now) is
    // within the window and dispatches; a non-catch-up trigger and an explicit `fireNow` never reach here.
    if (opts?.fromSchedule === true && descriptor.catchUp === true) {
      const ageMs = Date.now() - instant.getTime();
      if (ageMs > this.#catchUpLookbackMs) {
        return false;
      }
    }

    // ── Dispatch by action kind (the worker drives BOTH) ──────────────────────────────────────────
    if (descriptor.action.kind === 'handler') {
      // HANDLER action (the build-now `nightly-digest` path): invoke the resolved trigger handler via
      // the platform's seam — it opens its OWN forTenant(db,tenantId).transaction() (the GUC seam). We
      // pass a freshly-bound forTenant handle (NOT a transactional one) because invokeTriggerHandler
      // owns the transaction boundary.
      const resolved = descriptor.action.handler;
      // Defense-in-depth: the registry already guaranteed kind:'trigger' (it throws otherwise at
      // boot), but re-assert before invoking so a registry-shape regression fails loud, not silently
      // running a tool/route fn through the trigger path.
      if (resolved.kind !== 'trigger') {
        throw new Error(
          `cron trigger '${descriptor.name}' resolved to a '${resolved.kind}' handler, expected ` +
            "'trigger' (the registry should have fail-closed this at boot). Fail-closed.",
        );
      }
      await this.#deps.invokeTriggerHandler(
        resolved.fn as TriggerHandlerFn,
        forTenant(db, tenantId),
        this.#deps.productTables,
        descriptor.name,
      );
      return true;
    }

    // AGENT action: enqueue a runAgentJob onto the durable executor with a DETERMINISTIC runId
    // (a double-fire of the same instant maps to the same runId → the engine dedups too — layer 3).
    const runId = cronRunId(descriptor.name, instant);
    await this.#deps.executor.enqueue(tenantId, {
      runId,
      tenantId,
      agentId: descriptor.action.agentId,
      input: cronAgentInput(descriptor.name),
      // Carry the action's optional output-persist target so the off-request run writes its validated
      // output into the declared store (exactly-once via the run-header completing-transition gate).
      ...(descriptor.action.persistTo !== undefined
        ? { persistTo: descriptor.action.persistTo }
        : {}),
    });
    return true;
  }
}
