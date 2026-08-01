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
import type { RateLimitPolicy } from './rate-limit.js';
import {
  DEFAULT_POLICIES,
  InMemoryRateLimitStore,
  RateLimiter,
  REUSE_LOCK_MS,
} from './rate-limit.js';

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

/**
 * `RateLimiter.check` with an EXPLICIT per-call policy — the seam a declared per-route budget rides on.
 *
 * The budget travels as a VALUE on the call rather than as a registration, which is what makes the
 * bucket-registration fail-open trap unreachable for those buckets. These arms pin the three properties
 * that has to have: it is authoritative (never merged with a registered policy of the same name), it is
 * never written back into the shared policy table, and it does not get a caller past the lock.
 */
describe('RateLimiter.check — an explicit policy is authoritative and never registered', () => {
  it('enforces a budget on a bucket that is NOT in the policy table (no fail-open)', () => {
    const limiter = new RateLimiter();
    const policy: RateLimitPolicy = { max: 2, windowMs: 60_000 };
    // Without the explicit policy this bucket allows everything — that is the trap the parameter closes.
    expect(limiter.check('never-registered', 'a').allowed).toBe(true);
    const fresh = new RateLimiter();
    expect(fresh.check('never-registered', 'a', policy).allowed).toBe(true);
    expect(fresh.check('never-registered', 'a', policy).allowed).toBe(true);
    const refused = fresh.check('never-registered', 'a', policy);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    // A different id under the same bucket keeps its own counter.
    expect(fresh.check('never-registered', 'b', policy).allowed).toBe(true);
  });

  it('OVERRIDES a registered policy of the same bucket name rather than merging with it', () => {
    // `login` is registered at max 10. An explicit max of 1 must win outright for this call series.
    expect(DEFAULT_POLICIES.login?.max).toBeGreaterThan(1);
    const limiter = new RateLimiter();
    expect(limiter.check('login', 'u', { max: 1, windowMs: 60_000 }).allowed).toBe(true);
    expect(limiter.check('login', 'u', { max: 1, windowMs: 60_000 }).allowed).toBe(false);
  });

  it('never writes the explicit policy into the shared table (which IS DEFAULT_POLICIES by reference)', () => {
    const before = JSON.stringify(DEFAULT_POLICIES);
    const limiter = new RateLimiter();
    limiter.check('carried-budget-bucket', 'a', { max: 1, windowMs: 1_000 });
    limiter.check('carried-budget-bucket', 'a', { max: 1, windowMs: 1_000 });
    expect(JSON.stringify(DEFAULT_POLICIES)).toBe(before);
    expect(Object.keys(DEFAULT_POLICIES)).not.toContain('carried-budget-bucket');
    // And a SECOND limiter — one that shares the module-level table by reference — is unaffected: the
    // bucket is still unregistered for it, so a call carrying no policy still fails open there.
    expect(new RateLimiter().check('carried-budget-bucket', 'a').allowed).toBe(true);
  });

  it('does not let an explicit budget past the refresh-reuse LOCK (the short-circuit stays first)', () => {
    const limiter = new RateLimiter();
    limiter.lockSource('carried-budget-bucket', 'locked-id');
    const refused = limiter.check('carried-budget-bucket', 'locked-id', {
      max: 1_000_000,
      windowMs: 1_000,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(REUSE_LOCK_MS);
  });

  it('behaves exactly as before when no policy is passed', () => {
    const limiter = new RateLimiter();
    const registered = DEFAULT_POLICIES.register;
    if (!registered) throw new Error("bucket 'register' has no registered policy");
    for (let i = 0; i < registered.max; i++) {
      expect(limiter.check('register', 'ip').allowed).toBe(true);
    }
    expect(limiter.check('register', 'ip').allowed).toBe(false);
  });
});
