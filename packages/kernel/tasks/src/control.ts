/**
 * Operator control — the workforce-level verbs (pause / resume / halt) and the cancel cascade.
 *
 * `pause` is a FLAG on the workforce_runtime row, deliberately not a task status: a paused
 * workforce's tasks stay visibly `queued` (the scheduler just stops reserving them), so an
 * operator who pauses at night and resumes in the morning loses nothing and burns nothing. With
 * `drain: true` the call returns only when every `working` task has ended its own turn — drained,
 * never killed. `halt` is pause-with-drain followed by a root-first cancel of every non-terminal
 * task. All three journal `workforce.control.*` events on the workforce's own stream.
 *
 * The cancel cascade is root-first and never mid-flight: a parked task transitions to `cancelled`
 * immediately; a `working` task gets a `cancel` signal its own turn absorbs at the boundary (the
 * turn finishes and settles, then its outcome IS the cancellation, and its descendants cascade
 * from there).
 */
import { schema, type TenantDb } from '@rayspec/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterTaskTerminal, cancelDescendants, lockRootFirst } from './apply-intents.js';
import { applyTransition, type TaskRecord } from './apply-transition.js';
import { TaskNotFoundError, TaskRowCorruptError, TaskVersionConflictError } from './errors.js';
import { appendWorkforceEvents } from './events.js';
import { ensureWorkforceRuntime, type WorkforceRuntimeRecord } from './runtime.js';
import { deliverSignal } from './signals.js';
import { isTaskStatus, isTerminalStatus } from './status.js';

export interface CancelCascadeOutcome {
  /** Task ids transitioned to `cancelled` in this call. */
  readonly cancelled: string[];
  /** Working task ids that received the absorb-at-turn-boundary cancel signal instead. */
  readonly signalled: string[];
}

/** A cascade re-reads and retries a bounded number of times rather than 500ing on a lost race. */
const CASCADE_RETRIES = 3;

/**
 * A cascade's outcome PLUS the one fact its caller cannot re-derive afterwards: whether the target
 * was ALREADY TERMINAL at the instant this call held its row lock.
 *
 * Stated explicitly rather than inferred from an empty outcome. Empty currently does mean terminal
 * — a live target always pushes ITSELF (the signal below, or the cancel below that) — but nothing
 * enforces that, and both directions of drift are silent skips: a future path that returns
 * non-empty on a terminal target stops the halt re-routing, and one that returns empty on a LIVE
 * target re-routes into `cancelSubtreeUnderTerminalRoot`, whose non-terminal guard then returns
 * empty as well. A flag set beside the branch it describes cannot drift away from it.
 *
 * INTERNAL. The public `cancelTaskCascade` projects it away, so the exported surface is unchanged
 * and no caller of the public cancel verb can start branching on a halt-internal fact.
 */
interface CascadeAttempt extends CancelCascadeOutcome {
  readonly targetWasTerminal: boolean;
}

/** The public cancel verb. See `attemptCancelTaskCascade` for the body and its contract. */
export async function cancelTaskCascade(
  tdb: TenantDb,
  input: { readonly taskId: string; readonly actor: string; readonly reason?: string },
): Promise<CancelCascadeOutcome> {
  const { cancelled, signalled } = await attemptCancelTaskCascade(tdb, input);
  return { cancelled, signalled };
}

async function attemptCancelTaskCascade(
  tdb: TenantDb,
  input: { readonly taskId: string; readonly actor: string; readonly reason?: string },
): Promise<CascadeAttempt> {
  // A cancel races the reserve pass by construction — the pass rewrites `planned`/`queued` rows
  // every few seconds — so a lost compare-and-swap re-reads and retries (the `transitionWithRetry`
  // pattern approvals.ts establishes), on a FRESH transaction because the losing one is spent.
  // With the whole subtree locked root-first the race is nearly closed already; this is what keeps
  // the remainder an honest retry instead of a 500 that did nothing.
  for (let attempt = 1; attempt <= CASCADE_RETRIES; attempt++) {
    try {
      return await tdb.transaction(async (tx) => {
        const rows = (await tx
          .select(schema.workforceTasks)
          .where(eq(schema.workforceTasks.taskId, input.taskId))) as TaskRecord[];
        const snapshot = rows[0];
        if (!snapshot) throw new TaskNotFoundError(input.taskId);
        if (!isTaskStatus(snapshot.status)) {
          throw new TaskRowCorruptError(input.taskId, `status '${snapshot.status}'`);
        }
        // Root-first before the first transition (apply-intents.ts's module header): this cascade
        // and a completing turn inside the same subtree walk the same rows in the same order.
        const task = await lockRootFirst(tx, snapshot);
        if (!isTaskStatus(task.status)) {
          throw new TaskRowCorruptError(input.taskId, `status '${task.status}'`);
        }
        // THE ONE PLACE `targetWasTerminal` IS TRUE, and it is decided on the LOCKED row — the
        // caller's own pre-lock read of this task may be arbitrarily stale (see `haltWorkforce`).
        if (isTerminalStatus(task.status)) {
          return { cancelled: [], signalled: [], targetWasTerminal: true };
        }

        const outcome: { cancelled: string[]; signalled: string[]; targetWasTerminal: boolean } = {
          cancelled: [],
          signalled: [],
          targetWasTerminal: false,
        };
        if (task.status === 'working') {
          // Never kill a turn mid-flight: the target absorbs the cancel at its own boundary (and
          // its turn's cancellation cascades to the descendants it still owns then). Descendants
          // that are NOT mid-turn cancel now — schedules are cancelled, in-flight work is not.
          await deliverSignal(tx, {
            taskId: task.taskId,
            kind: 'cancel',
            signalKey: `cancel:${input.taskId}`,
            payload: { requestedBy: input.actor, reason: input.reason ?? null },
            actor: input.actor,
          });
          outcome.signalled.push(task.taskId);
          const cascade = await cancelDescendants(tx, task, input.actor);
          outcome.cancelled.push(...cascade.cancelled);
          outcome.signalled.push(...cascade.signalled);
          return outcome;
        }
        const done = await applyTransition(tx, {
          taskId: task.taskId,
          expectedVersion: task.version,
          to: 'cancelled',
          reason: 'cancelled_by_user',
          actor: input.actor,
        });
        outcome.cancelled.push(done.taskId);
        const cascade = await cancelDescendants(tx, done, input.actor);
        outcome.cancelled.push(...cascade.cancelled);
        outcome.signalled.push(...cascade.signalled);
        await afterTaskTerminal(tx, done);
        return outcome;
      });
    } catch (err) {
      if (err instanceof TaskVersionConflictError && attempt < CASCADE_RETRIES) continue;
      throw err;
    }
  }
  // Unreachable: the loop either returns or rethrows on its final attempt.
  throw new TaskVersionConflictError(input.taskId, -1, -1);
}

/** How long a drain politely waits for in-flight turns before refusing (fail-loud, not forever). */
const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
/**
 * The drain's poll interval. EXPORTED so the suite that asserts "a quiet drain never sleeps" can
 * recognise this wait by its own value rather than by a copied literal — a hard-coded `250` there
 * would keep passing, testing nothing, the moment this number moved.
 */
export const DRAIN_POLL_MS = 250;

export class WorkforceDrainTimeoutError extends Error {
  readonly workforceId: string;
  readonly stillWorking: number;
  constructor(workforceId: string, stillWorking: number, timeoutMs: number) {
    super(
      `workforce '${workforceId}' still has ${stillWorking} working task(s) after draining for ` +
        `${timeoutMs}ms — the pause is in force (nothing new reserves) but the drain did not ` +
        'complete in time. Re-issue the drain, or wait for the turns to end. Fail-closed.',
    );
    this.name = 'WorkforceDrainTimeoutError';
    this.workforceId = workforceId;
    this.stillWorking = stillWorking;
  }
}

/** Counted IN the database — a drain poll must not materialize the working set to size it. */
async function workingCount(tdb: TenantDb, workforceId: string): Promise<number> {
  const rows = (await tdb
    .select(schema.workforceTasks, { count: sql<number>`count(*)::int` })
    .where(
      and(
        eq(schema.workforceTasks.workforceId, workforceId),
        eq(schema.workforceTasks.status, 'working'),
      ),
    )) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

export interface PauseWorkforceInput {
  readonly workforceId: string;
  readonly actor: string;
  /** With drain, the call returns only when every working task has ended its turn. */
  readonly drain?: boolean;
  readonly drainTimeoutMs?: number;
}

/**
 * Stop reserving for this workforce. The flag write and the control event commit together; the
 * optional drain then POLLS (outside any transaction — a held transaction would block the very
 * turns it waits for) until no task is `working`.
 *
 * WHY COUNTING `working` ROWS IS A COMPLETE ANSWER, and where that completeness is enforced.
 * A turn is dispatched without touching the task row (the dispatcher's dispatch law: the workflow
 * id IS the claim), so a dispatched-but-unclaimed turn is still `queued` and this count cannot see
 * it. On its own that would make the drain a race — it could return while a turn was about to
 * start. What closes it is the ORDER THE FLAG WRITE ABOVE IMPOSES: the claim transaction
 * (@rayspec/durable-dbos task-scheduler.ts `#claimTurn`) takes THIS workforce's `workforce_runtime`
 * row lock — through `ensureWorkforceRuntime`, whose upsert is a real write for exactly this kind
 * of reason — in the same transaction as its `queued -> working` compare-and-swap, and re-reads
 * `paused` there. The transaction above writes that same row and COMMITS BEFORE THE FIRST POLL, so
 * every claim either commits ahead of it (and is `working` by the time the loop below runs its
 * first count) or refuses. There is no third ordering; `#claimTurn` carries the full argument.
 *
 * The consequence for a reader of this function: the loop below is the whole drain, and it is
 * complete — but only while that claim-side refusal exists. Removing it turns this back into a
 * race, silently.
 */
export async function pauseWorkforce(
  tdb: TenantDb,
  input: PauseWorkforceInput,
): Promise<WorkforceRuntimeRecord> {
  const runtime = await tdb.transaction(async (tx) => {
    await ensureWorkforceRuntime(tx, input.workforceId);
    const rows = (await tx
      .update(schema.workforceRuntime, {
        paused: true,
        pausedAt: new Date(),
        pausedBy: input.actor,
      })
      .where(eq(schema.workforceRuntime.workforceId, input.workforceId))
      .returning()) as WorkforceRuntimeRecord[];
    await appendWorkforceEvents(tx, input.workforceId, [
      {
        type: 'workforce.control.paused',
        payload: {
          workforceId: input.workforceId,
          actor: input.actor,
          drain: input.drain === true,
        },
      },
    ]);
    return rows[0] as WorkforceRuntimeRecord;
  });
  if (input.drain === true) {
    const timeoutMs = input.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const working = await workingCount(tdb, input.workforceId);
      if (working === 0) break;
      if (Date.now() >= deadline) {
        throw new WorkforceDrainTimeoutError(input.workforceId, working, timeoutMs);
      }
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  }
  return runtime;
}

/** Reserving restarts. Nothing needs re-queueing, because nothing ever left `queued`. */
export async function resumeWorkforce(
  tdb: TenantDb,
  input: { readonly workforceId: string; readonly actor: string },
): Promise<WorkforceRuntimeRecord> {
  return tdb.transaction(async (tx) => {
    await ensureWorkforceRuntime(tx, input.workforceId);
    const rows = (await tx
      .update(schema.workforceRuntime, {
        paused: false,
        pausedAt: null,
        pausedBy: null,
      })
      .where(eq(schema.workforceRuntime.workforceId, input.workforceId))
      .returning()) as WorkforceRuntimeRecord[];
    await appendWorkforceEvents(tx, input.workforceId, [
      {
        type: 'workforce.control.resumed',
        payload: { workforceId: input.workforceId, actor: input.actor },
      },
    ]);
    return rows[0] as WorkforceRuntimeRecord;
  });
}

export interface HaltWorkforceOutcome {
  readonly cancelled: string[];
  readonly signalled: string[];
}

/**
 * Cancel the live subtree beneath a root that has ALREADY reached a terminal status, without
 * touching the root itself.
 *
 * A terminal root does not imply a terminated subtree. A buffered create (`createdChildren`) is
 * deliberately not bound to its parent's join, so a parent can complete with that child still
 * running; `applyBudgetExhausted` already branches on "a root that has already ended" while
 * handling a LIVE descendant's denial; and `#failOnDecidedDependency` (task-scheduler.ts)
 * terminates a task outside any fan-in. The halt's root scan reads ROOTS ONLY, so skipping such a
 * root skips its whole subtree at every depth — and a halt that returns having left live work
 * running is the one thing a halt may not do.
 *
 * The ROOT ROW IS NOT WRITTEN. It is already terminal, `applyTransition` is the single status
 * writer, and every terminal row of `ALLOWED_TRANSITIONS` is all-false — re-terminalising it is a
 * write the state machine must refuse, not one this function should attempt. `cancelTaskCascade`
 * cannot serve this case for the same reason: it returns early on a terminal target by design, and
 * relaxing that would change cancellation semantics for every caller of the public cancel verb.
 *
 * SAME LOCKS, SAME ORDER as `cancelTaskCascade`, on a strict subset of its rows: `lockRootFirst`
 * (one row here — a root's `ancestryPath` is empty) then `lockDescendants` inside
 * `cancelDescendants`, shallowest first, ties by task id. No ledger row is touched, so the
 * tasks -> ledger rank cannot be inverted. The retry mirrors the cascade's for the same reason it
 * exists there.
 *
 * WHAT THE ROOT LOCK IS FOR, stated precisely because it is NOT what it looks like. It is not
 * protecting a re-read: terminal is absorbing (every terminal row of `ALLOWED_TRANSITIONS` is
 * all-false), so a terminal snapshot is already a terminal row — the same reasoning
 * `lockDescendants` states for skipping terminal descendants. It is protecting the ORDER. Every
 * other operation on this subtree holds the root before it touches a descendant, so a transaction
 * that locked descendants WITHOUT the root would hold a different row set from everything it can
 * race, which is how a cycle opens. Taking it makes this path's acquisition a prefix of
 * `cancelTaskCascade`'s, not a new order. The terminality re-check below is fail-closed defence on
 * top of that, and is unreachable while the state machine holds.
 */
async function cancelSubtreeUnderTerminalRoot(
  tdb: TenantDb,
  input: { readonly root: TaskRecord; readonly actor: string },
): Promise<CancelCascadeOutcome> {
  for (let attempt = 1; attempt <= CASCADE_RETRIES; attempt++) {
    try {
      return await tdb.transaction(async (tx) => {
        const locked = await lockRootFirst(tx, input.root);
        if (!isTaskStatus(locked.status)) {
          throw new TaskRowCorruptError(locked.taskId, `status '${locked.status}'`);
        }
        // Unreachable while the state machine holds (terminal is absorbing), so this is defence,
        // not a race handler: if a row ever did leave a terminal status, the live case is the
        // caller's other branch and this function must write nothing rather than guess.
        if (!isTerminalStatus(locked.status)) return { cancelled: [], signalled: [] };
        return await cancelDescendants(tx, locked, input.actor);
      });
    } catch (err) {
      if (err instanceof TaskVersionConflictError && attempt < CASCADE_RETRIES) continue;
      throw err;
    }
  }
  // Unreachable: the loop either returns or rethrows on its final attempt.
  throw new TaskVersionConflictError(input.root.taskId, -1, -1);
}

/**
 * Cancel a root the halt's scan read as LIVE — and handle the case where it is not live any more.
 *
 * The scan's read is UNLOCKED (`haltWorkforce` below reads roots with a plain select), so the
 * branch it picks can be stale by the time the cascade holds the row. A root that reaches a
 * terminal status in that window hits `attemptCancelTaskCascade`'s terminal early return, which is
 * BEFORE `cancelDescendants` — so the halt would move on having done nothing for that subtree
 * while believing it had handled it. That is the same subtree loss `cancelSubtreeUnderTerminalRoot`
 * exists to prevent, arrived at through a race instead of through a stale scan; the halt reaches
 * descendants only through their root, so it is the whole subtree at every depth.
 *
 * The window is reachable, not theoretical: `sweepApprovalTimeouts` (approvals.ts) is NOT
 * pause-gated and drives a task parked on an overdue approval to `failed`, and the drain above
 * waits only on `working` rows — so a root parked `waiting_for_user(approval_pending)` can go
 * terminal at any point during a halt. `#failOnDecidedDependency` (task-scheduler.ts) is a second
 * such producer.
 *
 * WHY THIS CLOSES THE WINDOW RATHER THAN NARROWING IT. `attemptCancelTaskCascade` decides on the
 * row it holds under `lockRootFirst`'s `FOR UPDATE`, and every writer of a task's status is
 * `applyTransition`, whose compare-and-swap takes that same exclusive row lock and holds it to
 * commit. Two transactions writing one row have a total order, so at the instant the cascade reads
 * the root there are exactly two cases and no third:
 *
 *   1. NON-TERMINAL — it cancels or signals the root and cascades to the descendants inside that
 *      same transaction, under that same lock. Nothing is left to re-check.
 *   2. TERMINAL — it reports `targetWasTerminal` having written nothing, and the subtree is
 *      cancelled by the re-route below, which re-takes the root lock and re-reads. The root is
 *      STILL terminal there: terminal is absorbing (every terminal row of `ALLOWED_TRANSITIONS` is
 *      all-false, and the exhaustiveness gate fails the build if that changes), so no writer
 *      between the two transactions can move it back out. The re-route therefore lands on exactly
 *      the path #501 established for a root that was terminal all along.
 *
 * It is a SECOND transaction rather than a re-entry into the first because case 2's row is
 * absorbing — the fact the re-route depends on cannot expire while it waits.
 *
 * The residual, stated rather than implied: this is a claim about the roots the scan READ. A root
 * created after that read is not visited by this halt, and closing that needs a pause gate on root
 * creation, which is not this function's to take. And the descendant set the re-route cancels is
 * final only because nothing can go `working` after the drain — `#claimTurn` refuses the
 * `queued -> working` claim while the runtime row says `paused`, and `applyTurnOutcome` (the only
 * path that inserts children) refuses a task that is not `working`. Removing that refusal re-opens
 * this alongside the drain.
 */
async function cancelLiveRoot(
  tdb: TenantDb,
  input: { readonly root: TaskRecord; readonly actor: string; readonly reason: string },
): Promise<CancelCascadeOutcome> {
  const attempt = await attemptCancelTaskCascade(tdb, {
    taskId: input.root.taskId,
    actor: input.actor,
    reason: input.reason,
  });
  if (!attempt.targetWasTerminal) return attempt;
  return cancelSubtreeUnderTerminalRoot(tdb, { root: input.root, actor: input.actor });
}

/**
 * Pause with drain, then cancel every non-terminal task ROOT-FIRST (cascades cannot race their
 * parents). Drained first, never killed mid-turn: with the drain complete nothing is `working`, so
 * the cascade transitions parked rows only. The halt event carries the affected count.
 *
 * The roots read is a DELIBERATE full scan: a halt that stopped at a page would leave the rest of
 * the workforce running, which is the one thing a halt may not do. Each LIVE root's cancellation
 * runs through `cancelTaskCascade`, so the halt inherits its root-first locking and its bounded
 * retry — a version race with the reserve pass no longer aborts a halt midway with nothing
 * journaled.
 *
 * A root that is ALREADY TERMINAL is still visited, through `cancelSubtreeUnderTerminalRoot`,
 * which takes the same locks in the same order and leaves the root row itself untouched: the scan
 * reads roots only, so skipping one skips its live descendants too, and "every non-terminal task"
 * is a claim about the WORKFORCE, not about its roots.
 *
 * The read below is UNLOCKED, so the branch it picks is a HYPOTHESIS, not a fact: a root that goes
 * terminal between this read and the cascade's lock is neither already-terminal nor still-live.
 * `cancelLiveRoot` is where that is resolved — on the LOCKED row, by re-routing rather than by
 * trusting the read. Deciding here from a re-read would only move the same window; deciding there
 * cannot, because the decision and the lock are the same instant.
 */
export async function haltWorkforce(
  tdb: TenantDb,
  input: {
    readonly workforceId: string;
    readonly actor: string;
    readonly reason: string;
    readonly drainTimeoutMs?: number;
  },
): Promise<HaltWorkforceOutcome> {
  await pauseWorkforce(tdb, {
    workforceId: input.workforceId,
    actor: input.actor,
    drain: true,
    drainTimeoutMs: input.drainTimeoutMs,
  });
  const roots = (await tdb
    .select(schema.workforceTasks)
    .where(
      and(
        eq(schema.workforceTasks.workforceId, input.workforceId),
        isNull(schema.workforceTasks.parentTaskId),
      ),
    )) as TaskRecord[];
  const outcome: { cancelled: string[]; signalled: string[] } = { cancelled: [], signalled: [] };
  for (const root of roots) {
    if (!isTaskStatus(root.status)) continue;
    const cascade = isTerminalStatus(root.status)
      ? await cancelSubtreeUnderTerminalRoot(tdb, { root, actor: input.actor })
      : await cancelLiveRoot(tdb, { root, actor: input.actor, reason: input.reason });
    outcome.cancelled.push(...cascade.cancelled);
    outcome.signalled.push(...cascade.signalled);
  }
  await tdb.transaction(async (tx) => {
    await tx
      .update(schema.workforceRuntime, { haltReason: input.reason, haltedAt: new Date() })
      .where(eq(schema.workforceRuntime.workforceId, input.workforceId));
    await appendWorkforceEvents(tx, input.workforceId, [
      {
        type: 'workforce.control.halted',
        payload: {
          workforceId: input.workforceId,
          actor: input.actor,
          reason: input.reason,
          affectedTaskCount: outcome.cancelled.length + outcome.signalled.length,
        },
      },
    ]);
  });
  return outcome;
}
