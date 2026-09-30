/**
 * The producer gate on both schedulers — pure unit tests (no DB, no DBOS launch).
 *
 * A source fence closes the gate; a resume opens it again. Closed, NEW work must not start: an
 * on-demand fire is refused with `ProducerPausedError` (its caller learns it did not happen), and a
 * scheduled tick dispatches nothing and says so in one line. The gate is asked BEFORE anything else,
 * which these tests get for free: the cron scheduler's `db` throws on any access. Work that starts
 * while the gate is open is counted in `inFlight` until it ends, which is what a drain waits on.
 */
import {
  invokeTriggerHandler,
  type ResolvedHandler,
  type TriggerDescriptor,
} from '@rayspec/platform';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  cronPausedLog,
  DbosCronScheduler,
  type ProducerGate,
  ProducerPausedError,
  type SystemCleanupOutcome,
  SystemCleanupScheduler,
} from './index.js';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const INSTANT = new Date('2026-06-24T03:00:00.000Z');
const handlerFn: ResolvedHandler & { kind: 'trigger' } = { kind: 'trigger', fn: async () => {} };

function descriptor(name: string, kind: 'cron' | 'manual'): TriggerDescriptor {
  return {
    name,
    kind,
    ...(kind === 'cron' ? { schedule: '0 3 * * *' } : {}),
    action: { kind: 'handler', handlerId: 'h', handler: handlerFn },
  } as TriggerDescriptor;
}

function switchGate(open: boolean): ProducerGate & { set(v: boolean): void } {
  let state = open;
  return {
    open: () => state,
    set(v: boolean) {
      state = v;
    },
  };
}

function cronScheduler(gate: ProducerGate, tenantExists: () => Promise<boolean>) {
  const logged: string[] = [];
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('a closed gate must decide before any database handle is used');
      },
    },
  );
  const scheduler = new DbosCronScheduler(
    [descriptor('nightly', 'cron'), descriptor('by-hand', 'manual')],
    {
      db: db as never,
      tenantId: TENANT,
      executor: {} as never,
      productTables: new Map<string, PgTable>(),
      invokeTriggerHandler,
      tenantExists,
      logger: { warn: (m: string) => logged.push(m) },
      gate,
    },
  );
  return { scheduler, logged };
}

describe('the cron scheduler behind a closed gate', () => {
  it('refuses an on-demand fire of a cron or manual trigger with ProducerPausedError', async () => {
    const asked: string[] = [];
    const { scheduler } = cronScheduler(switchGate(false), async () => {
      asked.push('tenant');
      return false;
    });
    await expect(scheduler.fireNow('nightly', INSTANT)).rejects.toBeInstanceOf(ProducerPausedError);
    await expect(scheduler.fireNowWithOutcome('by-hand', INSTANT)).rejects.toBeInstanceOf(
      ProducerPausedError,
    );
    // Not even the tenant probe ran: the gate is the first question.
    expect(asked).toEqual([]);
    expect(scheduler.inFlight).toBe(0);
  });

  it('turns a scheduled fire into a logged no-op that dispatches nothing', async () => {
    const { scheduler, logged } = cronScheduler(switchGate(false), async () => true);
    expect(await scheduler.fireScheduled('nightly', INSTANT)).toBe(false);
    expect(logged).toEqual([cronPausedLog('nightly', INSTANT)]);
  });

  it('fires again once the gate opens, and counts the fire in flight while it runs', async () => {
    const gate = switchGate(false);
    let release: () => void = () => {};
    let probed = false;
    const { scheduler } = cronScheduler(gate, () => {
      probed = true;
      // Hold the fire inside the scheduler (the tenant probe is its first await) to observe it.
      return new Promise<boolean>((resolve) => {
        release = () => resolve(false);
      });
    });
    await expect(scheduler.fireNow('nightly', INSTANT)).rejects.toBeInstanceOf(ProducerPausedError);
    gate.set(true);
    const fire = scheduler.fireNow('nightly', INSTANT);
    await new Promise((r) => setTimeout(r, 0));
    expect(probed).toBe(true);
    expect(scheduler.inFlight).toBe(1);
    release();
    // The tenant is reported absent, so this fire dispatched nothing — but it did run.
    expect(await fire).toBe(false);
    expect(scheduler.inFlight).toBe(0);
  });

  it('names the pause in its log line and says when firing resumes', () => {
    const line = cronPausedLog('nightly', INSTANT);
    expect(line).toContain("trigger 'nightly'");
    expect(line).toContain('fenced');
    expect(line).toContain('resumes at the next instant');
  });
});

describe('the system cleanup scheduler behind a closed gate', () => {
  const outcome: SystemCleanupOutcome = {
    oidcPruned: 0,
    gdpr: { mode: 'disabled', users: 0, memberships: 0, oldestTombstoneAgeDays: 0 },
  } as SystemCleanupOutcome;

  it('refuses an on-demand run and does not call the cleanup', async () => {
    let calls = 0;
    const scheduler = new SystemCleanupScheduler({
      runCleanup: async () => {
        calls += 1;
        return outcome;
      },
      gate: switchGate(false),
      logger: { info: () => {}, error: () => {} },
    });
    await expect(scheduler.runCleanupNow()).rejects.toBeInstanceOf(ProducerPausedError);
    expect(calls).toBe(0);
  });

  it('runs once the gate opens, counted in flight while it runs', async () => {
    const gate = switchGate(false);
    let release: () => void = () => {};
    const scheduler = new SystemCleanupScheduler({
      runCleanup: () =>
        new Promise<SystemCleanupOutcome>((resolve) => {
          release = () => resolve(outcome);
        }),
      gate,
      logger: { info: () => {}, error: () => {} },
    });
    gate.set(true);
    const run = scheduler.runCleanupNow();
    expect(scheduler.inFlight).toBe(1);
    release();
    await expect(run).resolves.toBe(outcome);
    expect(scheduler.inFlight).toBe(0);
  });
});
