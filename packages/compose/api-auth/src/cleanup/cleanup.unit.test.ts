/**
 * Pure-unit tests for the cleanup retention math + the log line. No DB — these pin the
 * load-bearing retention boundary + the structured-result→log formatting that the scheduler logs:
 *
 *  - `retentionCutoff(now, days)` = now - days (a fixed-duration window, not a calendar boundary);
 *  - `ageInDays` floors + clamps at 0 (a future deleted_at reads as age 0, never negative);
 *  - retention is fail-closed on a bad `retentionDays` (negative / NaN throws);
 *  - the log line reflects mode (DRY-RUN vs purged) + the counts.
 *
 * These run in CI (no DATABASE_URL gate); the DB-backed delete behavior is in cleanup.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { type CleanupResult, formatCleanupLogLine } from './index.js';
import { ageInDays, MS_PER_DAY, retentionCutoff } from './retention.js';

describe('retention math', () => {
  const NOW = new Date('2026-06-26T12:00:00.000Z');

  it('retentionCutoff subtracts exactly `days` (fixed-duration window)', () => {
    expect(retentionCutoff(NOW, 30).getTime()).toBe(NOW.getTime() - 30 * MS_PER_DAY);
    expect(retentionCutoff(NOW, 0).getTime()).toBe(NOW.getTime()); // 0 ⇒ cutoff = now
  });

  it('retentionCutoff fail-closes on a negative or non-finite retention', () => {
    expect(() => retentionCutoff(NOW, -1)).toThrow(/non-negative/i);
    expect(() => retentionCutoff(NOW, Number.NaN)).toThrow(/non-negative/i);
    expect(() => retentionCutoff(NOW, Number.POSITIVE_INFINITY)).toThrow(/non-negative/i);
  });

  it('ageInDays floors to whole days and clamps a future timestamp at 0', () => {
    expect(ageInDays(new Date(NOW.getTime() - 40 * MS_PER_DAY), NOW)).toBe(40);
    // 40 days + 23h still floors to 40.
    expect(ageInDays(new Date(NOW.getTime() - (40 * MS_PER_DAY + 82_800_000)), NOW)).toBe(40);
    // A future deletedAt (should not occur) reads as 0, not negative.
    expect(ageInDays(new Date(NOW.getTime() + MS_PER_DAY), NOW)).toBe(0);
    expect(ageInDays(NOW, NOW)).toBe(0);
  });
});

describe('cleanup log line', () => {
  it('reflects DRY-RUN (gate OFF) — "would purge"', () => {
    const r: CleanupResult = {
      oidcPruned: 3,
      gdpr: { mode: 'disabled', users: 2, memberships: 5, oldestTombstoneAgeDays: 41 },
    };
    const line = formatCleanupLogLine(r);
    expect(line).toContain('pruned 3 expired token');
    expect(line).toContain('gdpr[disabled]');
    expect(line).toContain('would purge (DRY-RUN, gate OFF)');
    expect(line).toContain('2 user + 5 membership');
    expect(line).toContain('oldest 41 day');
  });

  it('reflects an ENABLED purge — "purged"', () => {
    const r: CleanupResult = {
      oidcPruned: 0,
      gdpr: { mode: 'enabled', users: 1, memberships: 0, oldestTombstoneAgeDays: 31 },
    };
    const line = formatCleanupLogLine(r);
    expect(line).toContain('gdpr[enabled]');
    expect(line).toMatch(/purged 1 user \+ 0 membership/);
    expect(line).not.toContain('DRY-RUN');
  });
});
