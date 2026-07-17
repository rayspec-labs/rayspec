/**
 * Pure-unit tests for the cron firing-KEY derivation. No DB / no DBOS — these
 * pin the load-bearing DETERMINISM of `firingInstantIso`/`firingKey`/`cronRunId`:
 *
 *  - the firing instant is TRUNCATED to a stable granularity (whole seconds) so two fires within the
 *    SAME bucket (e.g. the scheduler's second-aligned tick vs a `fireNow` a few ms later) yield the
 *    SAME key → they CROSS-DEDUP at the reserve (the at-MOST-once-per-instant guarantee);
 *  - two genuinely-distinct cron slots (≥1 minute apart) yield DISTINCT keys (the dedup is per-instant,
 *    NOT per-trigger — guards against an over-broad bucket that would dedup all fires forever);
 *  - `cronRunId` is a pure, deterministic function of (trigger, truncated-instant) with the UUID shape.
 *
 * These run in CI (no `DATABASE_URL` gate) — the DB-backed behavioral dedup is in cron-scheduler.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { cronRunId, FIRING_INSTANT_GRANULARITY_MS, firingInstantIso, firingKey } from './index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('cron firing-key derivation — truncation + determinism', () => {
  it('truncates the firing instant DOWN to whole seconds (the firing granularity)', () => {
    expect(FIRING_INSTANT_GRANULARITY_MS).toBe(1000);
    // 02:00:00.0xx all floor to 02:00:00.000Z.
    expect(firingInstantIso(new Date('2026-06-24T02:00:00.000Z'))).toBe('2026-06-24T02:00:00.000Z');
    expect(firingInstantIso(new Date('2026-06-24T02:00:00.999Z'))).toBe('2026-06-24T02:00:00.000Z');
    expect(firingInstantIso(new Date('2026-06-24T02:00:00.001Z'))).toBe('2026-06-24T02:00:00.000Z');
    // The next whole second is a DIFFERENT bucket.
    expect(firingInstantIso(new Date('2026-06-24T02:00:01.000Z'))).toBe('2026-06-24T02:00:01.000Z');
  });

  it('two instants within the SAME truncation bucket produce the SAME firing key + the SAME runId', () => {
    // The scheduler tick (whole second) and a fireNow a few ms later are the SAME logical instant.
    const tick = new Date('2026-06-24T02:00:00.000Z');
    const fewMsLater = new Date('2026-06-24T02:00:00.742Z');
    expect(firingKey('nightly-digest', tick)).toBe(firingKey('nightly-digest', fewMsLater));
    expect(cronRunId('agent-cron', tick)).toBe(cronRunId('agent-cron', fewMsLater));
  });

  it('the bucket boundary is a NEW key — a fire one whole second later is a DISTINCT instant', () => {
    const t = new Date('2026-06-24T02:00:00.000Z');
    const oneSecLater = new Date('2026-06-24T02:00:01.000Z');
    expect(firingKey('nightly-digest', t)).not.toBe(firingKey('nightly-digest', oneSecLater));
  });

  it('two distinct cron slots (a minute apart) yield DISTINCT keys (dedup is per-instant, not per-trigger)', () => {
    const slot1 = new Date('2026-06-24T02:00:00.000Z');
    const slot2 = new Date('2026-06-24T02:01:00.000Z');
    expect(firingKey('nightly-digest', slot1)).not.toBe(firingKey('nightly-digest', slot2));
  });

  it('the firing key carries the trigger name (DATA — server-derived) and the truncated ISO instant', () => {
    expect(firingKey('nightly-digest', new Date('2026-06-24T02:00:00.123Z'))).toBe(
      'trigger:nightly-digest:2026-06-24T02:00:00.000Z',
    );
  });

  it('cronRunId is a deterministic, UUID-shaped pure function of (trigger, truncated-instant)', () => {
    const t = new Date('2026-06-24T00:05:00.456Z');
    const id = cronRunId('agent-cron', t);
    expect(id).toMatch(UUID_RE);
    expect(cronRunId('agent-cron', t)).toBe(id); // deterministic
    // Different trigger or different bucket ⇒ different runId.
    expect(cronRunId('other', t)).not.toBe(id);
    expect(cronRunId('agent-cron', new Date('2026-06-24T00:05:01.000Z'))).not.toBe(id);
  });
});
