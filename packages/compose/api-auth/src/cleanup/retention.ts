/**
 * Retention math for the GDPR hard-delete purge.
 *
 * The purge NEVER deletes a tombstone younger than its retention window. Retention is expressed in
 * whole DAYS; this module derives the absolute cutoff INSTANT (`now - retentionDays`) a tombstone's
 * `deleted_at` must be strictly older than to be purgeable, and the inverse (a tombstone's age in whole
 * days) for the dry-run log. Both halves of the purge (the dry-run count + the live delete) derive their
 * cutoff from `retentionCutoff` with the SAME `now`, so the count and the delete agree by construction —
 * a tombstone the dry-run reports as "would purge" is exactly the set the live delete removes.
 *
 * One DAY = 86_400_000 ms (UTC day-length; we operate on absolute timestamps, so DST/calendar-month
 * variance is irrelevant — a retention window is a fixed duration, not a calendar boundary). The
 * MEMBERSHIP SQL reaper (org-store.ts) mirrors this by using `INTERVAL '86400 seconds'` (a fixed-second
 * duration, NOT the DST/wall-clock-aware `INTERVAL '1 day'`) so the "fixed duration, not a calendar
 * boundary" property holds identically for BOTH the JS (this module) and SQL reaper paths.
 */

/** Milliseconds in one retention day. */
export const MS_PER_DAY = 86_400_000;

/**
 * The absolute cutoff: a tombstone is purgeable iff its `deleted_at` is STRICTLY OLDER than this instant
 * (`deleted_at < cutoff`). `retentionDays` MUST be a non-negative finite number; a caller that resolves
 * a per-org override passes the resolved value. `retentionDays = 0` ⇒ cutoff = `now` (a tombstone from a
 * prior instant is purgeable; this is a deliberate operator choice, not a default).
 */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(
      `retentionCutoff: retentionDays must be a non-negative finite number (got ${retentionDays}).`,
    );
  }
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

/**
 * The age (in whole days, floored) of a tombstone whose `deleted_at` is `deletedAt`, relative to NOW.
 * Used only for the dry-run/log line ("oldest tombstone is M days old"); never for the delete decision
 * (that is the SQL cutoff comparison). Clamped at 0 (a future `deleted_at`, which should not occur, reads
 * as age 0 rather than negative).
 *
 * Accepts a `Date` OR a string/number timestamp: a `min(deleted_at)` aggregate read through a raw `sql`
 * expression comes back from postgres-js as a STRING (drizzle only auto-parses mapped COLUMNS, not
 * arbitrary aggregate expressions), so coerce defensively rather than assume a Date.
 */
export function ageInDays(deletedAt: Date | string | number, now: Date = new Date()): number {
  const deletedMs = deletedAt instanceof Date ? deletedAt.getTime() : new Date(deletedAt).getTime();
  const ms = now.getTime() - deletedMs;
  return ms <= 0 ? 0 : Math.floor(ms / MS_PER_DAY);
}
