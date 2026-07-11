/**
 * Pure-unit tests for the system cleanup scheduler's log formatting + defaults. No DB / no
 * DBOS — these run in CI and pin the engine-local log line + the default crontab without launching DBOS
 * (the DBOS registration + the runCleanupNow path are in system-cleanup-scheduler.db.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLEANUP_SCHEDULE,
  formatSystemCleanupLog,
  type SystemCleanupOutcome,
  SystemCleanupScheduler,
} from './index.js';

describe('system cleanup defaults', () => {
  it('the default crontab is 3am daily', () => {
    expect(DEFAULT_CLEANUP_SCHEDULE).toBe('0 3 * * *');
  });

  it('the scheduler defaults its schedule to the daily crontab when none is supplied', () => {
    const s = new SystemCleanupScheduler({ runCleanup: async () => zero() });
    expect(s.schedule).toBe(DEFAULT_CLEANUP_SCHEDULE);
  });

  it('an explicit schedule overrides the default', () => {
    const s = new SystemCleanupScheduler({
      runCleanup: async () => zero(),
      schedule: '30 4 * * *',
    });
    expect(s.schedule).toBe('30 4 * * *');
  });
});

describe('formatSystemCleanupLog', () => {
  it('renders the DRY-RUN (disabled) line', () => {
    const o: SystemCleanupOutcome = {
      oidcPruned: 4,
      gdpr: { mode: 'disabled', users: 1, memberships: 2, oldestTombstoneAgeDays: 50 },
    };
    const line = formatSystemCleanupLog(o);
    expect(line).toContain('pruned 4 expired token');
    expect(line).toContain('gdpr[disabled]');
    expect(line).toContain('would purge (DRY-RUN, gate OFF)');
    expect(line).toContain('1 user + 2 membership');
    expect(line).toContain('oldest 50 day');
  });

  it('renders the ENABLED (purged) line', () => {
    const o: SystemCleanupOutcome = {
      oidcPruned: 0,
      gdpr: { mode: 'enabled', users: 3, memberships: 0, oldestTombstoneAgeDays: 31 },
    };
    const line = formatSystemCleanupLog(o);
    expect(line).toContain('gdpr[enabled]');
    expect(line).toMatch(/purged 3 user \+ 0 membership/);
    expect(line).not.toContain('DRY-RUN');
  });
});

function zero(): SystemCleanupOutcome {
  return {
    oidcPruned: 0,
    gdpr: { mode: 'disabled', users: 0, memberships: 0, oldestTombstoneAgeDays: 0 },
  };
}
