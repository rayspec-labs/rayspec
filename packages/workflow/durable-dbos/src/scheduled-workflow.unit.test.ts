/**
 * The schedule loop keeps running when an instant cannot be started.
 *
 * DBOS's own scheduler loop ends, with an unhandled rejection that ends the process, the first time
 * `DBOS.startWorkflow` rejects (the workflow system database refusing a connection). These arms drive
 * `runScheduleLoop` with a matcher that has an instant every 100 ms and a start that fails for a while,
 * and check what each mode then does:
 *  1. the loop never rejects, reports the failure once per streak and the recovery once, and fires
 *     again once starts succeed;
 *  2. `ExactlyOncePerIntervalWhenActive` does not make up the instants that passed while starts failed;
 *  3. `ExactlyOncePerInterval` retries the instant that failed, then makes up every later one, in order;
 *  4. a watermark that cannot be read at start is retried, and the loop then continues from it;
 *  5. the loop ends when its signal aborts, also while it waits to retry.
 */
import { SchedulerMode } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';
import { runScheduleLoop, type ScheduleLoopDeps } from './scheduled-workflow.js';

const STEP = 100;
/** An instant every STEP ms, on the same contract as DBOS's crontab matcher. */
const everyStep = {
  nextWakeupTime: (t: Date | number) => new Date((Math.floor(Number(t) / STEP) + 1) * STEP),
  match: () => true,
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(failWhile: () => boolean, watermark?: () => Promise<number | undefined>) {
  const started: number[] = [];
  const attempts: number[] = [];
  const warnings: string[] = [];
  const deps: ScheduleLoopDeps = {
    start: async (workflowId, scheduledTime) => {
      attempts.push(scheduledTime.getTime());
      if (failWhile()) throw new Error('database "sys" is not currently accepting connections');
      expect(workflowId).toBe(`sched-.probe-${scheduledTime.toISOString()}`);
      started.push(scheduledTime.getTime());
    },
    readWatermark: watermark ?? (async () => undefined),
    writeWatermark: async (time) => time,
    logger: { warn: (m) => warnings.push(m) },
    retryMs: 30,
  };
  return { deps, started, attempts, warnings };
}

describe('runScheduleLoop — a start that fails does not end the schedule', () => {
  it('keeps firing, says so once per streak, and makes nothing up in when-active mode', async () => {
    let failing = false;
    const h = harness(() => failing);
    const controller = new AbortController();
    const loop = runScheduleLoop(
      '.probe',
      everyStep,
      SchedulerMode.ExactlyOncePerIntervalWhenActive,
      h.deps,
      controller.signal,
    );
    await pause(3 * STEP);
    const beforeOutage = h.started.length;
    expect(beforeOutage).toBeGreaterThan(0);

    failing = true;
    const outageFrom = Date.now();
    await pause(5 * STEP);
    const outageTo = Date.now();
    failing = false;
    await pause(4 * STEP);
    controller.abort();
    await expect(loop).resolves.toBeUndefined();

    // It tried during the outage and started again after it.
    expect(h.attempts.length).toBeGreaterThan(h.started.length);
    expect(h.started.length).toBeGreaterThan(beforeOutage);
    // One line for the streak, one for its end.
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[0]).toMatch(/scheduled workflow '\.probe' failed .*not currently accepting/);
    expect(h.warnings[1]).toContain("'.probe' starts again");
    // No instant from inside the outage was started afterwards (no make-up work in this mode).
    const madeUp = h.started.filter((t) => t > outageFrom + STEP && t < outageTo - STEP);
    expect(madeUp).toEqual([]);
    // Every instant started at most once, in order.
    expect([...h.started].sort((a, b) => a - b)).toEqual(h.started);
    expect(new Set(h.started).size).toBe(h.started.length);
  });

  it('retries the failed instant and makes up every later one in make-up mode', async () => {
    let failing = false;
    const h = harness(() => failing);
    const controller = new AbortController();
    const loop = runScheduleLoop(
      '.probe',
      everyStep,
      SchedulerMode.ExactlyOncePerInterval,
      h.deps,
      controller.signal,
    );
    await pause(2 * STEP);
    failing = true;
    await pause(5 * STEP);
    failing = false;
    await pause(4 * STEP);
    controller.abort();
    await loop;

    // Consecutive instants with no gap: the outage's instants were started once it ended.
    const gaps = h.started.slice(1).map((t, i) => t - (h.started[i] as number));
    expect(gaps.every((g) => g === STEP)).toBe(true);
    // The first instant that failed is the first one started afterwards.
    const firstFailed = h.attempts.find((t, i) => h.attempts.indexOf(t) !== i);
    expect(firstFailed).toBeDefined();
    expect(h.started).toContain(firstFailed);
    expect(h.warnings).toHaveLength(2);
  });

  it('retries a watermark it cannot read, then continues from it', async () => {
    let reads = 0;
    const from = (Math.floor(Date.now() / STEP) - 3) * STEP;
    const h = harness(
      () => false,
      async () => {
        reads += 1;
        if (reads < 3) throw new Error('the system database is unreachable');
        return from;
      },
    );
    const controller = new AbortController();
    const loop = runScheduleLoop(
      '.probe',
      everyStep,
      SchedulerMode.ExactlyOncePerInterval,
      h.deps,
      controller.signal,
    );
    await pause(3 * STEP);
    controller.abort();
    await loop;
    expect(reads).toBe(3);
    expect(h.started[0]).toBe(from + STEP);
    expect(h.warnings[0]).toMatch(/reading the last fired instant .* failed/);
  });

  it('ends when its signal aborts, also while it waits to retry', async () => {
    const h = harness(() => true);
    h.deps.retryMs = 60_000;
    const controller = new AbortController();
    const loop = runScheduleLoop(
      '.probe',
      everyStep,
      SchedulerMode.ExactlyOncePerIntervalWhenActive,
      h.deps,
      controller.signal,
    );
    await pause(2 * STEP);
    expect(h.attempts.length).toBe(1);
    const aborted = Date.now();
    controller.abort();
    await loop;
    expect(Date.now() - aborted).toBeLessThan(STEP);
  });
});
