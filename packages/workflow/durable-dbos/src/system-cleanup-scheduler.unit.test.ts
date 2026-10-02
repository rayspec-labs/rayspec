/**
 * Pure-unit tests for the system cleanup scheduler's log formatting + defaults. No DB / no
 * DBOS — these run in CI and pin the engine-local log line + the default crontab without launching DBOS
 * (the DBOS registration + the runCleanupNow path are in system-cleanup-scheduler.db.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  crontabParseError,
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

describe("crontabParseError — the parse attempt through the scheduler's own parser", () => {
  it('accepts what the scheduler accepts: the default, a 5-field, and a 6-field expression', () => {
    expect(crontabParseError(DEFAULT_CLEANUP_SCHEDULE)).toBeUndefined();
    expect(crontabParseError('30 4 * * *')).toBeUndefined();
    expect(crontabParseError('0 3 * * * *')).toBeUndefined();
  });

  it('names the field count when a shorthand or a short expression is all there is', () => {
    // The parser dies on these with a bare TypeError about `replace`; none of that is passed on.
    for (const [value, count] of [
      ['@daily', '1 field;'],
      ['0 3 * *', '4 fields;'],
      ['every day', '2 fields;'],
      ['', '0 fields;'],
    ] as const) {
      const detail = crontabParseError(value);
      expect(detail).toContain(`it has ${count}`);
      expect(detail).toContain('minute hour day-of-month month day-of-week');
      expect(detail).not.toMatch(/replace|undefined|TypeError/);
    }
  });

  it('names the field the scheduler refuses and its value, not the parser text', () => {
    expect(crontabParseError('99 99 99 99 99')).toBe(
      "its minute field '99' is not a value the scheduler accepts",
    );
    expect(crontabParseError('0 25 * * *')).toBe(
      "its hour field '25' is not a value the scheduler accepts",
    );
    expect(crontabParseError('0 3 * * FOO')).toBe(
      "its day-of-week field 'FOO' is not a value the scheduler accepts",
    );
    // The 6-field form starts with the second.
    expect(crontabParseError('61 0 3 * * *')).toBe(
      "its second field '61' is not a value the scheduler accepts",
    );
    expect(crontabParseError('0 0 3 32 * *')).toBe(
      "its day-of-month field '32' is not a value the scheduler accepts",
    );
    for (const value of ['99 99 99 99 99', '0 3 * * FOO']) {
      expect(crontabParseError(value)).not.toContain('invalid expression');
    }
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
