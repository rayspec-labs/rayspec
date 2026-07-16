/**
 * Rate limiter: credential-stuffing + argon2id-DoS + the refresh-reuse
 * anti-DoS lock. In-process fixed-window counter NOW, behind a pluggable interface so a
 * Redis/Postgres store can replace it later without touching call sites (deployment topology is
 * not yet pinned — Open decisions).
 */

/** The store contract — swap in Redis/Postgres later. */
export interface RateLimitStore {
  /** Increment the counter for `key`, returning the new count. The window resets after windowMs. */
  hit(key: string, windowMs: number): { count: number; resetAt: number };
  /** Force a temporary lock for `key` until now+ms (the refresh-reuse anti-DoS lock). */
  lock(key: string, ms: number): void;
  /** True if `key` is currently locked. */
  isLocked(key: string): boolean;
  /** Reset a key (e.g. on a successful login). */
  reset(key: string): void;
}

/**
 * The default hard cap on the number of tracked (window / lock) keys. Bounds the store's memory so a
 * flood of distinct keys (high-cardinality traffic) cannot grow it without limit — the OOM vector a
 * never-pruned per-key Map otherwise carried. 100k keys is far above any single node's legitimate
 * concurrent-source cardinality yet a trivial memory footprint.
 */
export const DEFAULT_MAX_RATE_LIMIT_ENTRIES = 100_000;

/**
 * In-process store. NOT shared across processes — fine for single-node. BOUNDED + SELF-PRUNING: each
 * time a new/expired window (or a lock) is (re)inserted at or above the cap, expired entries are swept
 * and, if still full, the oldest are evicted — so the maps never exceed `maxEntries`. The clock is
 * injectable (defaults to `Date.now`) so the expiry paths are deterministically testable.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly locks = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(maxEntries: number = DEFAULT_MAX_RATE_LIMIT_ENTRIES, now: () => number = Date.now) {
    this.maxEntries = Math.max(1, maxEntries);
    this.now = now;
  }

  hit(key: string, windowMs: number): { count: number; resetAt: number } {
    const now = this.now();
    const cur = this.windows.get(key);
    if (!cur || cur.resetAt <= now) {
      // A NEW or expired key is about to (re)enter the map — the only growth path — so bound it here.
      this.prune(this.windows, now, (v) => v.resetAt);
      const fresh = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, fresh);
      return fresh;
    }
    cur.count += 1;
    return cur;
  }

  lock(key: string, ms: number): void {
    const now = this.now();
    this.prune(this.locks, now, (until) => until);
    this.locks.set(key, now + ms);
  }

  isLocked(key: string): boolean {
    const until = this.locks.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.locks.delete(key);
      return false;
    }
    return true;
  }

  reset(key: string): void {
    this.windows.delete(key);
    this.locks.delete(key);
  }

  /** Clear ALL windows + locks (test isolation; not used on the hot path). */
  clearAll(): void {
    this.windows.clear();
    this.locks.clear();
  }

  /** The number of tracked windows (observability + makes the max-size bound assertable). */
  size(): number {
    return this.windows.size;
  }

  /**
   * Bound `map` to `maxEntries`: a no-op until it reaches the cap, then sweep every entry whose
   * `expiryOf(value) <= now` and — if still at/over the cap (all live) — evict the OLDEST-inserted
   * (a Map iterates in insertion order, so the front is the oldest) until it is under the cap. Called
   * only on the (re)insert path, so the steady-state hot path (incrementing a live counter) pays
   * nothing.
   */
  private prune<V>(map: Map<string, V>, now: number, expiryOf: (value: V) => number): void {
    if (map.size < this.maxEntries) return;
    for (const [k, v] of map) {
      if (expiryOf(v) <= now) map.delete(k);
    }
    while (map.size >= this.maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

/** A named limit policy. */
export interface RateLimitPolicy {
  /** Max hits allowed within the window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

/** Default per-route policies (tuneable). Keyed by a logical bucket name. */
export const DEFAULT_POLICIES: Record<string, RateLimitPolicy> = {
  login: { max: 10, windowMs: 60_000 },
  register: { max: 5, windowMs: 60_000 },
  refresh: { max: 30, windowMs: 60_000 },
  'oauth-token': { max: 30, windowMs: 60_000 },
};

/** Duration of the refresh-reuse anti-DoS lock (a stale token cannot be a repeatable DoS). */
export const REUSE_LOCK_MS = 5 * 60_000;

/**
 * The limiter facade used by the HTTP layer. `check(bucket, id)` returns whether the call is
 * allowed; `lockSource`/`isLocked` back the refresh-reuse anti-DoS lock.
 */
export class RateLimiter {
  private readonly store: RateLimitStore;
  private readonly policies: Record<string, RateLimitPolicy>;

  constructor(store: RateLimitStore = new InMemoryRateLimitStore(), policies = DEFAULT_POLICIES) {
    this.store = store;
    this.policies = policies;
  }

  /** True if this (bucket,id) is within its rate budget AND not locked. */
  check(bucket: string, id: string): { allowed: boolean; retryAfterMs: number } {
    const key = `${bucket}:${id}`;
    if (this.store.isLocked(key)) return { allowed: false, retryAfterMs: REUSE_LOCK_MS };
    const policy = this.policies[bucket];
    if (!policy) return { allowed: true, retryAfterMs: 0 };
    const { count, resetAt } = this.store.hit(key, policy.windowMs);
    if (count > policy.max)
      return { allowed: false, retryAfterMs: Math.max(0, resetAt - Date.now()) };
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Lock a source bucket (the refresh-reuse anti-DoS per-source lock). */
  lockSource(bucket: string, id: string, ms = REUSE_LOCK_MS): void {
    this.store.lock(`${bucket}:${id}`, ms);
  }

  /** True if a source bucket is locked. */
  isLocked(bucket: string, id: string): boolean {
    return this.store.isLocked(`${bucket}:${id}`);
  }

  /** Reset a bucket (e.g. on a successful authentication). */
  reset(bucket: string, id: string): void {
    this.store.reset(`${bucket}:${id}`);
  }

  /** Clear ALL state (test isolation). No-op if the store does not support it. */
  clearAll(): void {
    if (this.store instanceof InMemoryRateLimitStore) this.store.clearAll();
  }
}
