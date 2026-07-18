/**
 * Catch-up MODE wiring — pure + mock unit tests (no DB, no DBOS launch). These prove the production
 * mechanism that makes catch-up actually replay missed intervals: a `catchUp` trigger is registered
 * under DBOS's make-up-work mode (`ExactlyOncePerInterval`), so on startup DBOS replays each interval
 * missed while the app was down. The BEHAVIOURAL make-up path (a replayed interval fires once, bounded
 * by the look-back window, deduped by the reserve) is proven over a REAL engine in
 * cron-scheduler.db.test.ts; this file proves (a) the mode SELECTION and (b) that
 * `registerScheduledWorkflows` actually HANDS that mode to DBOS — a bug could pick the right mode yet
 * never pass it, which the behavioural tests (driven via the deterministic `fireScheduled` seam, not
 * DBOS's wall-clock loop) would not catch.
 */
import { DBOS, SchedulerMode } from '@dbos-inc/dbos-sdk';
import {
  invokeTriggerHandler,
  type ResolvedHandler,
  type TriggerDescriptor,
} from '@rayspec/platform';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catchUpSchedulerMode, DbosCronScheduler } from './index.js';

const handlerFn: ResolvedHandler & { kind: 'trigger' } = { kind: 'trigger', fn: async () => {} };

function cron(name: string, catchUp?: boolean): TriggerDescriptor {
  return {
    name,
    kind: 'cron',
    schedule: '0 2 * * *',
    ...(catchUp !== undefined ? { catchUp } : {}),
    action: { kind: 'handler', handlerId: 'h', handler: handlerFn },
  };
}

describe('catchUpSchedulerMode — pure mode selection', () => {
  it('a catch-up trigger selects the make-up-work mode (ExactlyOncePerInterval)', () => {
    expect(catchUpSchedulerMode({ catchUp: true })).toBe(SchedulerMode.ExactlyOncePerInterval);
  });

  it('a non-catch-up trigger selects the when-active mode (no make-up work)', () => {
    expect(catchUpSchedulerMode({ catchUp: false })).toBe(
      SchedulerMode.ExactlyOncePerIntervalWhenActive,
    );
    expect(catchUpSchedulerMode({})).toBe(SchedulerMode.ExactlyOncePerIntervalWhenActive);
  });
});

describe('registerScheduledWorkflows — hands the catch-up mode to DBOS', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers a catch-up trigger under ExactlyOncePerInterval and a plain trigger under ExactlyOncePerIntervalWhenActive', () => {
    // Mock the two static DBOS registration calls so nothing touches a real engine / the global
    // registry. `registerWorkflow` passes its function through; `registerScheduled` captures the config.
    vi.spyOn(DBOS, 'registerWorkflow').mockImplementation(((fn: unknown) => fn) as never);
    const scheduled = vi.spyOn(DBOS, 'registerScheduled').mockImplementation((() => {}) as never);

    const scheduler = new DbosCronScheduler([cron('makeup', true), cron('active', false)], {
      db: {} as never,
      tenantId: '00000000-0000-0000-0000-0000000000aa',
      executor: {} as never,
      productTables: new Map<string, PgTable>(),
      invokeTriggerHandler,
    });
    scheduler.registerScheduledWorkflows();

    const byName = new Map(
      scheduled.mock.calls.map((c) => {
        const cfg = c[1] as { name: string; crontab: string; mode: SchedulerMode };
        return [cfg.name, cfg];
      }),
    );
    // The catch-up trigger is handed the make-up-work mode; the plain one keeps when-active.
    expect(byName.get('cron:makeup')?.mode).toBe(SchedulerMode.ExactlyOncePerInterval);
    expect(byName.get('cron:active')?.mode).toBe(SchedulerMode.ExactlyOncePerIntervalWhenActive);
    // The crontab still flows through unchanged (the mode is additive to the existing registration).
    expect(byName.get('cron:makeup')?.crontab).toBe('0 2 * * *');
    expect(byName.get('cron:active')?.crontab).toBe('0 2 * * *');
  });
});
