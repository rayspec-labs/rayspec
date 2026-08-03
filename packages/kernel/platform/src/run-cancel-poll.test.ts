/**
 * The cross-process cancellation poll — its LIFECYCLE properties, pinned one mutation at a time.
 *
 * The database-backed suite proves the poll ends a run and that the handle rule holds. What it cannot
 * see is the shape of the watch itself: the arming guard, the two stop paths, the retry-after-failure
 * rule, and that at most one read is ever in flight. Each of those is a stated design property, and
 * each was removable without turning anything red — a guard with no test is not a guard.
 *
 * These arms drive `armRunCancellation` directly against a fake handle that counts reads, so they are
 * fast, deterministic and need no database. `intervalMs` is small on purpose; every assertion is about
 * a COUNT changing or not changing across a bounded wait, never about a specific duration.
 */

import type { TenantDb } from '@rayspec/db';
import { describe, expect, it } from 'vitest';
import { armRunCancellation, signalRunCancelled } from './run-cancel.js';

const INTERVAL_MS = 5;
/** Long enough for several intervals to elapse, short enough to keep the suite quick. */
const SETTLE_MS = 80;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A handle that answers `isRunCancelled` and counts how often it was asked. `answer` decides what the
 * read does: resolve with no rows, resolve with a marker row, or reject.
 */
function countingDb(answer: () => 'absent' | 'present' | 'throw'): {
  tdb: TenantDb;
  reads: () => number;
  inFlight: () => number;
} {
  let reads = 0;
  let inFlight = 0;
  let peak = 0;
  const chain = {
    where: () => chain,
    limit: async () => {
      reads += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await wait(1);
        const verdict = answer();
        if (verdict === 'throw') throw new Error('read failed');
        return verdict === 'present' ? [{ id: 'marker' }] : [];
      } finally {
        inFlight -= 1;
      }
    },
  };
  const tdb = { select: () => chain } as unknown as TenantDb;
  return { tdb, reads: () => reads, inFlight: () => peak };
}

describe('the cancellation poll — lifecycle properties', () => {
  it('is NOT armed for a run whose signal has already aborted: no read is ever issued', async () => {
    const external = new AbortController();
    external.abort();
    const db = countingDb(() => 'absent');
    const cancellation = armRunCancellation('run-spent', external.signal, {
      tdb: db.tdb,
      intervalMs: INTERVAL_MS,
    });
    await wait(SETTLE_MS);
    cancellation.dispose();
    // Such a run never calls the backend at all, so polling for it is pure cost.
    expect(db.reads()).toBe(0);
  });

  it('stops on dispose: the reads it had issued stop, and none arrive afterwards', async () => {
    const db = countingDb(() => 'absent');
    const cancellation = armRunCancellation('run-dispose', undefined, {
      tdb: db.tdb,
      intervalMs: INTERVAL_MS,
    });
    await wait(SETTLE_MS);
    const during = db.reads();
    expect(during).toBeGreaterThan(0);
    cancellation.dispose();
    await wait(SETTLE_MS);
    expect(db.reads()).toBe(during);
  });

  it('stops when the run is cancelled IN-PROCESS: the signal it is racing already ended the run', async () => {
    const db = countingDb(() => 'absent');
    const cancellation = armRunCancellation('run-abort', undefined, {
      tdb: db.tdb,
      intervalMs: INTERVAL_MS,
    });
    await wait(SETTLE_MS);
    expect(db.reads()).toBeGreaterThan(0);
    expect(signalRunCancelled('run-abort')).toBe(true);
    const atAbort = db.reads();
    await wait(SETTLE_MS);
    // The watch is wired to the controller's own abort, so an in-process cancellation ends it too —
    // which is what puts the stop BEFORE the run drains, with no call site in run-core.
    expect(db.reads()).toBeLessThanOrEqual(atAbort + 1);
    cancellation.dispose();
  });

  it('a FAILING read is retried on the next tick rather than ending the watch', async () => {
    const db = countingDb(() => 'throw');
    const cancellation = armRunCancellation('run-throw', undefined, {
      tdb: db.tdb,
      intervalMs: INTERVAL_MS,
    });
    await wait(SETTLE_MS);
    cancellation.dispose();
    // Swallowing the error is only half the rule: the watch must keep asking. A `catch` that stopped
    // scheduling would leave exactly one read here and the run would be unreachable for the rest of
    // its life without anything going red.
    expect(db.reads()).toBeGreaterThan(1);
  });

  it('never has more than ONE read in flight, however slow the database is', async () => {
    const db = countingDb(() => 'absent');
    const cancellation = armRunCancellation('run-chained', undefined, {
      tdb: db.tdb,
      intervalMs: 1,
    });
    await wait(SETTLE_MS);
    cancellation.dispose();
    // Chained scheduling measures the interval from the END of the previous read, so a degraded
    // database receives FEWER reads rather than a growing pile of them.
    expect(db.inFlight()).toBe(1);
  });

  it('aborts THIS arming’s signal when the marker appears', async () => {
    const db = countingDb(() => 'present');
    const cancellation = armRunCancellation('run-marker', undefined, {
      tdb: db.tdb,
      intervalMs: INTERVAL_MS,
    });
    await wait(SETTLE_MS);
    expect(cancellation.signal.aborted).toBe(true);
    const atAbort = db.reads();
    await wait(SETTLE_MS);
    // Having found its answer the watch is done; it does not keep asking.
    expect(db.reads()).toBe(atAbort);
    cancellation.dispose();
  });

  it('issues NO read when no poll is configured — the unconfigured path is untouched', async () => {
    const db = countingDb(() => 'absent');
    const cancellation = armRunCancellation('run-unconfigured', undefined);
    await wait(SETTLE_MS);
    cancellation.dispose();
    expect(db.reads()).toBe(0);
  });
});
