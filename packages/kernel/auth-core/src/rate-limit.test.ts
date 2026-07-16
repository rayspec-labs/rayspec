/**
 * InMemoryRateLimitStore — unit tests for the BOUNDED, self-pruning in-process store.
 *
 * The store must not grow without bound: a flood of distinct keys (spoofed identities before the
 * trusted-proxy fix, or just high-cardinality traffic) previously accreted one never-freed Map entry
 * each — an OOM vector. The store now (1) SWEEPS expired entries and (2) enforces a hard MAX-SIZE,
 * evicting the oldest, while preserving the fixed-window counting behavior. A deterministic injected
 * clock drives the expiry paths without a wall-clock sleep.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryRateLimitStore } from './rate-limit.js';

/** A controllable clock: `t.now` is read by the store; `t.set(ms)` advances it. */
function fakeClock() {
  let t = 0;
  return { now: () => t, set: (ms: number) => (t = ms) };
}

describe('InMemoryRateLimitStore — fixed-window counting (behavior preserved)', () => {
  it('increments the count within a window and resets after it expires', () => {
    const clk = fakeClock();
    const store = new InMemoryRateLimitStore(100, clk.now);
    expect(store.hit('k', 1000).count).toBe(1);
    expect(store.hit('k', 1000).count).toBe(2);
    clk.set(1001); // past the window
    expect(store.hit('k', 1000).count).toBe(1); // fresh window
  });

  it('a lock expires on read and is self-deleted', () => {
    const clk = fakeClock();
    const store = new InMemoryRateLimitStore(100, clk.now);
    store.lock('k', 500);
    expect(store.isLocked('k')).toBe(true);
    clk.set(501);
    expect(store.isLocked('k')).toBe(false);
  });
});

describe('InMemoryRateLimitStore — bounded + self-pruning', () => {
  it('enforces the max-size cap, evicting the oldest live entries', () => {
    const clk = fakeClock();
    const store = new InMemoryRateLimitStore(3, clk.now);
    // Five distinct live keys (long window) under a cap of 3 → the store holds at most 3.
    for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) store.hit(k, 10_000);
    expect(store.size()).toBeLessThanOrEqual(3);
    // The OLDEST (k1) was evicted → hitting it again starts a FRESH window (count 1), not a resume.
    expect(store.hit('k1', 10_000).count).toBe(1);
  });

  it('sweeps expired entries before enforcing the cap (a wave of expiries frees the whole map)', () => {
    const clk = fakeClock();
    const store = new InMemoryRateLimitStore(3, clk.now);
    store.hit('a', 100);
    store.hit('b', 100);
    store.hit('c', 100); // size 3, all resetAt = 100
    clk.set(200); // all three windows have expired
    store.hit('d', 100); // inserting a 4th trips the bound → expired a/b/c are swept first
    expect(store.size()).toBe(1); // only the fresh 'd' remains
  });

  it('never exceeds the cap no matter how many distinct keys arrive', () => {
    const clk = fakeClock();
    const store = new InMemoryRateLimitStore(10, clk.now);
    for (let i = 0; i < 1000; i++) store.hit(`key-${i}`, 10_000);
    expect(store.size()).toBeLessThanOrEqual(10);
  });
});
