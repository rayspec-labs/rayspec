/**
 * Rate limiter: credential-stuffing + argon2id-DoS + the refresh-reuse
 * anti-DoS lock. In-process fixed-window counter by DEFAULT, behind a pluggable interface so a
 * Redis/Postgres store can replace it without touching call sites.
 *
 * TWO store contracts live here, and the difference between them is the whole point. `RateLimitStore`
 * is the SYNCHRONOUS in-process one: it is the default, it is what every construction in this
 * repository gets, and nothing about it changes. `SharedRateLimitStore` is the OPTIONAL asynchronous
 * one an embedder can supply for cluster-wide enforcement, reachable only through
 * `RateLimiter.withSharedStore`. A limiter holds one or the other, never both at once.
 */
import { randomUUID } from 'node:crypto';

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
  // Session reprocess mints a FRESH durable run each call (dedup is deliberately bypassed), so an
  // unthrottled caller can re-drive the same session's workflow without bound — a cost-DoS. Cap the
  // reprocesses of one (tenant, session) per window; the route keys the bucket by `${tenant}:${session}`.
  reprocess: { max: 5, windowMs: 60_000 },
  // A manual trigger fire dispatches a declared action (agent run / handler). Within one firing-instant
  // bucket a re-fire dedups, but distinct instants each dispatch — so an unthrottled caller could fire a
  // named trigger repeatedly (a cost-DoS). Cap the fires of one (tenant, trigger) per window; the route
  // keys the bucket by `${tenant}:${name}`.
  'trigger-fire': { max: 30, windowMs: 60_000 },
  // The invite-accept endpoint is UNAUTHENTICATED (a token bearer redeems) and can PROVISION an
  // account, so throttle it per source IP to bound token-probing / account-creation abuse. The token
  // is 256-bit (brute-force is infeasible regardless), but a per-source cap is cheap defense-in-depth.
  'invite-accept': { max: 10, windowMs: 60_000 },
  // The two declared-route tiers. The tier is chosen AFTER the credential is validated, so a caller
  // whose credential is absent or does not validate lands in the STRICT bucket keyed on the anti-spoof
  // client source, and only a VALIDATED principal reaches the generous one (keyed by tenant+principal).
  // The strict cap is deliberately close to the unauthenticated caps above — a declared route requires
  // auth, so the only traffic in this bucket is credential-less or forged. The generous cap is sized for
  // first-party automation calling in bursts, which is what the tiering exists to stop locking out.
  'declared-route-source': { max: 30, windowMs: 60_000 },
  'declared-route-principal': { max: 600, windowMs: 60_000 },
};

/** Duration of the refresh-reuse anti-DoS lock (a stale token cannot be a repeatable DoS). */
export const REUSE_LOCK_MS = 5 * 60_000;

/**
 * One rate-limit answer: whether the call passes, and how long the caller should wait if it does not.
 * `retryAfterMs` is meaningful only when `allowed` is false; an allowed call reports zero.
 */
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * The OPTIONAL shared-store port — the seam a deployment crosses to turn every counter in this
 * process into a cluster-wide one. It is not implemented here and nothing in the shipped server
 * supplies it; a limiter with no shared store behaves exactly as it always has.
 *
 * ATOMIC CONSUME. `consume` both makes the decision and reports the retry hint, in ONE operation, and
 * that is the contract's load-bearing clause. Splitting it — decide, then ask how long to wait — would
 * let two instances each observe "one token left" before either had taken it, which is the very defect
 * a shared store exists to remove, and would let the hint describe a window state that no longer holds
 * by the time the caller reads it. An implementation that cannot make its decision and its advice one
 * operation cannot satisfy this port.
 *
 * `policy` is the budget for THIS call, already resolved by the facade: either the one the caller
 * carried or the limiter's registered entry for the bucket. It is `undefined` when the bucket has
 * neither, and that case is NOT an error — it is the in-process store's fail-open behaviour, which an
 * implementation must reproduce: allow, advise zero, and create no counter. The lock, however, is
 * still checked first, exactly as `RateLimiter.check` checks it before looking a policy up, so a
 * locked key in an unregistered bucket is still refused.
 *
 * A refusal caused by a LOCK must report `REUSE_LOCK_MS`, matching what the in-process path reports —
 * not the true remaining lock time. The lock duration is a constant of this module; reporting the
 * remainder instead would create a second observable on which two backends could disagree, and would
 * let a caller poll a locked key to learn how much of its lock is left.
 */
export interface SharedRateLimitStore {
  /** Count one hit against `key` under `policy` and return the decision AND its retry hint together. */
  consume(key: string, policy: RateLimitPolicy | undefined): Promise<RateLimitDecision>;
  /** Force a temporary lock for `key` until now+ms (the refresh-reuse anti-DoS lock). */
  lock(key: string, ms: number): Promise<void>;
  /** Reset a key — its window AND its lock, matching the in-process `reset`. */
  reset(key: string): Promise<void>;
  /** Clear ALL state (test isolation); not used on the hot path. */
  clearAll(): Promise<void>;
}

/**
 * The bucket name `RateLimiter.withSharedStore`'s boot probe counts against.
 *
 * A RESERVED name: DELIBERATELY ABSENT from `DEFAULT_POLICIES` and it must stay absent. Every question
 * the probe asks carries its budget on the call, and `checkAsync` prefers a carried policy over the
 * table, so a registration would not change what the probe measures today. What it would add is a
 * second source of truth for the probe's budget, under the probe's own name — one that takes over
 * silently the moment a probe question is added that carries none, answering from the table the very
 * call whose carried budget is the thing being tested. Keeping the name unregistered means no probe
 * call can ever be answered that way.
 */
export const SHARED_STORE_PROBE_BUCKET = 'shared-rate-limit-store-probe';

/**
 * The limiter facade used by the HTTP layer. `check(bucket, id)` returns whether the call is
 * allowed; `lockSource`/`isLocked` back the refresh-reuse anti-DoS lock.
 *
 * TWO FACADES, ONE OBJECT. The synchronous methods are the original ones and their bodies are
 * untouched. Four of them — `check`, `lockSource`, `reset` and `clearAll` — have an `…Async` twin
 * beside them, and the HTTP layer calls THOSE. On a limiter with no shared store, which is every
 * construction in this repository, each twin is a call to its synchronous partner and nothing else,
 * so the served behaviour is unchanged down to the returned object's identity. On a limiter built by
 * `withSharedStore` the twins go to that store instead and every synchronous method refuses to answer:
 * falling back to the in-process store there would hand this instance a PRIVATE budget, which is
 * precisely the defect a shared store exists to remove. `isLocked` gets no twin because it has no
 * caller outside this module — a shared limiter's lock state is reported by the decision `checkAsync`
 * returns, which is the operation that acts on it.
 */
export class RateLimiter {
  private readonly store: RateLimitStore;
  private readonly policies: Record<string, RateLimitPolicy>;
  /** The optional shared store. Set by `withSharedStore` only — the constructor never takes one. */
  private shared: SharedRateLimitStore | undefined;
  /** True once the shared store has answered the boot probe correctly. */
  private probed = false;

  constructor(store: RateLimitStore = new InMemoryRateLimitStore(), policies = DEFAULT_POLICIES) {
    this.store = store;
    this.policies = policies;
  }

  /** The shared store this limiter decides through, or `undefined` for an in-process limiter. */
  get sharedStore(): SharedRateLimitStore | undefined {
    return this.shared;
  }

  /** True when a shared store is present AND answered the boot probe below. */
  get sharedStoreProbed(): boolean {
    return this.probed;
  }

  /**
   * Build a limiter that decides through a SHARED store — the only door onto that port.
   *
   * The constructor deliberately does not take a shared store. A store this limiter cannot interrogate
   * is worse than no store: the buckets a declared per-route budget uses are unregistered by design and
   * carry their policy on the call, so a store that quietly ignores that argument would leave every
   * budgeted route unlimited while the boot and the served OpenAPI document both claimed a limit. A
   * factory that ALWAYS probes before handing the limiter back makes that state unreachable.
   *
   * The probe runs THROUGH THIS FACADE rather than against the store directly, so it proves the wiring
   * as well as the store: a `checkAsync` that dropped its policy, or a `lockSourceAsync` that keyed
   * differently from `checkAsync`, fails here too. It asks four questions, all of which have a
   * behavioural consequence if answered wrongly: a budget of one allows once and then refuses; that
   * refusal advises a non-zero wait (a zero would degrade every `429` in the deployment to the minimum
   * whole second no matter how much of the window is left); a locked key is refused; and a locked
   * refusal advises exactly `REUSE_LOCK_MS`, the same constant the in-process path reports.
   *
   * THE PROBE KEY IS PER BOOT. It has to be. With a fixed key the probe is self-racing on exactly the
   * substrate it validates: a budget of one is a single token, so two instances booting against one
   * shared store at the same moment consume each other's and a perfectly healthy instance aborts its
   * boot. A fresh id per boot removes the interference without weakening any of the four questions.
   * The key is reset before AND after, so a probe leaves neither a counter nor a lock behind — the
   * trailing reset runs BEFORE the assertions, so a FAILED probe cleans up too.
   */
  static async withSharedStore(
    store: SharedRateLimitStore,
    policies?: Record<string, RateLimitPolicy>,
  ): Promise<RateLimiter> {
    const limiter = new RateLimiter(new InMemoryRateLimitStore(), policies ?? DEFAULT_POLICIES);
    limiter.shared = store;
    const bucket = SHARED_STORE_PROBE_BUCKET;
    const id = `boot:${randomUUID()}`;
    const budgetOfOne: RateLimitPolicy = { max: 1, windowMs: 60_000 };

    await limiter.resetAsync(bucket, id);
    const first = await limiter.checkAsync(bucket, id, budgetOfOne);
    const second = await limiter.checkAsync(bucket, id, budgetOfOne);
    await limiter.lockSourceAsync(bucket, id);
    const locked = await limiter.checkAsync(bucket, id, { max: 1_000_000, windowMs: 1_000 });
    await limiter.resetAsync(bucket, id);

    if (!(first.allowed && !second.allowed)) {
      throw new Error(
        'RateLimiter.withSharedStore: the shared store does not honour an explicit per-call policy ' +
          `(a budget of 1 allowed ${String(first.allowed)} then ${String(second.allowed)}, expected ` +
          'true then false). Both halves matter: a store that refuses everything would satisfy the ' +
          'second half alone and leave the probe vacuous in the case it exists to catch.',
      );
    }
    if (!(second.retryAfterMs > 0)) {
      throw new Error(
        'RateLimiter.withSharedStore: the shared store refused with a zero retry hint ' +
          `(${String(second.retryAfterMs)}ms). The decision and the hint must come from one operation, ` +
          'and a zero hint degrades every 429 in the deployment to the minimum whole second no matter ' +
          'how much of the window is actually left.',
      );
    }
    if (locked.allowed) {
      throw new Error(
        'RateLimiter.withSharedStore: the shared store allowed a locked key. The refresh-reuse ' +
          'anti-DoS lock short-circuits before any budget is consulted, so a carried budget must ' +
          'never buy a caller past it.',
      );
    }
    if (locked.retryAfterMs !== REUSE_LOCK_MS) {
      throw new Error(
        `RateLimiter.withSharedStore: the shared store advised ${String(locked.retryAfterMs)}ms on a ` +
          `locked refusal, expected exactly ${String(REUSE_LOCK_MS)}ms. Reporting anything else — the ` +
          'true remainder included — makes the two backends disagree on an observable and lets a ' +
          'caller poll a locked key to learn how much of its lock is left.',
      );
    }
    limiter.probed = true;
    return limiter;
  }

  /**
   * Refuse a SYNCHRONOUS call on a limiter whose store is shared, naming the twin to call instead.
   *
   * On every `new RateLimiter(...)` in this repository there is no shared store, so this returns
   * immediately and the body below it is unchanged. It is only a shared limiter that reaches the
   * throw, and the throw is the correct answer: the alternative — answering from the in-process store
   * — would silently give that instance its own budget, which is the defect the shared store was
   * introduced to remove.
   */
  private assertSyncUsable(
    method: 'check' | 'lockSource' | 'isLocked' | 'reset' | 'clearAll',
  ): void {
    if (!this.shared) return;
    // `isLocked` has no async twin of its own: a shared limiter reports its lock state through the
    // decision `checkAsync` returns, which is the operation that acts on the lock.
    const twin = method === 'isLocked' ? 'checkAsync' : `${method}Async`;
    throw new Error(
      `RateLimiter.${method}: this limiter decides through a SHARED store, whose answers are ` +
        `asynchronous. Call ${twin} instead. Answering from the in-process store here would give ` +
        'this instance a private budget, which is exactly what a shared store exists to prevent.',
    );
  }

  /**
   * True if this (bucket,id) is within its rate budget AND not locked.
   *
   * `policy` is the OPTIONAL per-call budget a caller carries with the call instead of registering a
   * bucket up front. When present it is AUTHORITATIVE: it is never merged with a registered policy of
   * the same bucket name, never registered and never stored — nothing here writes to `this.policies`,
   * which for a default-constructed limiter IS the module-level `DEFAULT_POLICIES` object BY
   * REFERENCE, so a write would mutate the shared table every other limiter in the process reads.
   * An explicit policy also makes the `if (!effective)` fail-open branch below unreachable for that
   * call, which is the point: a caller that carries its budget cannot be silently unlimited by having
   * forgotten to register its bucket name.
   *
   * The lock short-circuit stays FIRST and is shared by both paths — an explicit budget is a request
   * ceiling, never a way around the refresh-reuse anti-DoS lock. That sharing is also why the budget
   * is a parameter here rather than a second method: a parallel method would have to re-implement both
   * this lock check and the `${bucket}:${id}` key construction, and the two would silently drift.
   */
  check(bucket: string, id: string, policy?: RateLimitPolicy): RateLimitDecision {
    this.assertSyncUsable('check');
    const key = `${bucket}:${id}`;
    if (this.store.isLocked(key)) return { allowed: false, retryAfterMs: REUSE_LOCK_MS };
    const effective = policy ?? this.policies[bucket];
    if (!effective) return { allowed: true, retryAfterMs: 0 };
    const { count, resetAt } = this.store.hit(key, effective.windowMs);
    if (count > effective.max)
      return { allowed: false, retryAfterMs: Math.max(0, resetAt - Date.now()) };
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Lock a source bucket (the refresh-reuse anti-DoS per-source lock). */
  lockSource(bucket: string, id: string, ms = REUSE_LOCK_MS): void {
    this.assertSyncUsable('lockSource');
    this.store.lock(`${bucket}:${id}`, ms);
  }

  /** True if a source bucket is locked. */
  isLocked(bucket: string, id: string): boolean {
    this.assertSyncUsable('isLocked');
    return this.store.isLocked(`${bucket}:${id}`);
  }

  /** Reset a bucket (e.g. on a successful authentication). */
  reset(bucket: string, id: string): void {
    this.assertSyncUsable('reset');
    this.store.reset(`${bucket}:${id}`);
  }

  /** Clear ALL state (test isolation). No-op if the store does not support it. */
  clearAll(): void {
    this.assertSyncUsable('clearAll');
    if (this.store instanceof InMemoryRateLimitStore) this.store.clearAll();
  }

  /**
   * The asynchronous twin of `check` — what the HTTP layer calls.
   *
   * With no shared store this IS `check`: the call is forwarded through `this.check`, so a caller that
   * has replaced the instance property (as the throttle tests do) still sees exactly one call with
   * exactly the arguments it was given, and the decision object it returns is the one handed back.
   * Dynamic dispatch is the point — resolving the method statically would push a second, invisible
   * decision through the underlying store on every request.
   *
   * With a shared store the budget is resolved HERE, in the same order `check` resolves it, and passed
   * on: a carried policy wins, otherwise the registered entry for the bucket, otherwise `undefined`.
   * That `undefined` is forwarded rather than short-circuited, because `check` takes the LOCK before it
   * looks a policy up — so a locked key in an unregistered bucket is still refused, and a facade that
   * answered "allowed" first would diverge from the in-process path on exactly that invariant.
   */
  async checkAsync(
    bucket: string,
    id: string,
    policy?: RateLimitPolicy,
  ): Promise<RateLimitDecision> {
    if (!this.shared) return this.check(bucket, id, policy);
    return this.shared.consume(`${bucket}:${id}`, policy ?? this.policies[bucket]);
  }

  /** The asynchronous twin of `lockSource`. Without a shared store it IS `lockSource`. */
  async lockSourceAsync(bucket: string, id: string, ms = REUSE_LOCK_MS): Promise<void> {
    if (!this.shared) return this.lockSource(bucket, id, ms);
    return this.shared.lock(`${bucket}:${id}`, ms);
  }

  /** The asynchronous twin of `reset`. Without a shared store it IS `reset`. */
  async resetAsync(bucket: string, id: string): Promise<void> {
    if (!this.shared) return this.reset(bucket, id);
    return this.shared.reset(`${bucket}:${id}`);
  }

  /** The asynchronous twin of `clearAll`. Without a shared store it IS `clearAll`. */
  async clearAllAsync(): Promise<void> {
    if (!this.shared) return this.clearAll();
    return this.shared.clearAll();
  }
}
