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

/** In-process store. NOT shared across processes — fine for single-node. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly locks = new Map<string, number>();

  hit(key: string, windowMs: number): { count: number; resetAt: number } {
    const now = Date.now();
    const cur = this.windows.get(key);
    if (!cur || cur.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, fresh);
      return fresh;
    }
    cur.count += 1;
    return cur;
  }

  lock(key: string, ms: number): void {
    this.locks.set(key, Date.now() + ms);
  }

  isLocked(key: string): boolean {
    const until = this.locks.get(key);
    if (until === undefined) return false;
    if (until <= Date.now()) {
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
