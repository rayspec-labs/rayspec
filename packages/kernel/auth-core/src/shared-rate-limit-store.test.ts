/**
 * The OPTIONAL shared rate-limit store port — the facade, the boot probe, and the synchronous guard.
 *
 * The in-process store stays the default and this suite's first concern is proving that it is
 * untouched: with no shared store configured, each async method is a call to its synchronous twin and
 * nothing else. That is asserted by IDENTITY rather than by deep equality — the spy replaces the
 * INSTANCE property, records the three arguments it was handed, and the object the async method
 * resolves with is compared with `toBe` against the object the synchronous method returned. A
 * deep-equality assertion would stay green against a facade that re-derived an equal-looking decision
 * of its own, which is exactly the divergence worth catching.
 *
 * The rest pins the factory. `RateLimiter.withSharedStore` is the ONLY door onto the port, and it
 * refuses to hand back a limiter whose store did not answer the probe correctly: a store that ignores
 * the carried budget would leave every counter in the system silently unlimited, and a store that
 * refuses with a zero retry hint would degrade every refusal to the minimum `Retry-After` regardless
 * of how much of the window is left. Both are wired into the probe and both are falsified here, next
 * to a store that refuses everything — without that third arm the probe could be vacuous in precisely
 * the case it exists to catch.
 */
import { describe, expect, it } from 'vitest';
import type { RateLimitDecision, RateLimitPolicy, SharedRateLimitStore } from './rate-limit.js';
import {
  DEFAULT_POLICIES,
  InMemoryRateLimitStore,
  RateLimiter,
  REUSE_LOCK_MS,
  SHARED_STORE_PROBE_BUCKET,
} from './rate-limit.js';

/** A shared store that also reports how many keys it is holding (windows + locks). */
type CountingStore = SharedRateLimitStore & { size: () => number };

/**
 * A CORRECT in-process implementation of the port — the reference the broken fakes below are varied
 * from. It reproduces `RateLimiter.check`'s ordering exactly: the lock short-circuits first, an absent
 * policy then fails open without creating a window, and only after both does the window count.
 */
function correctStore(): CountingStore {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const locks = new Map<string, number>();
  return {
    async consume(key: string, policy: RateLimitPolicy | undefined): Promise<RateLimitDecision> {
      const now = Date.now();
      const until = locks.get(key);
      if (until !== undefined && until > now) {
        return { allowed: false, retryAfterMs: REUSE_LOCK_MS };
      }
      if (!policy) return { allowed: true, retryAfterMs: 0 };
      const cur = windows.get(key);
      const next =
        !cur || cur.resetAt <= now
          ? { count: 1, resetAt: now + policy.windowMs }
          : { count: cur.count + 1, resetAt: cur.resetAt };
      windows.set(key, next);
      if (next.count > policy.max) {
        return { allowed: false, retryAfterMs: Math.max(1, next.resetAt - now) };
      }
      return { allowed: true, retryAfterMs: 0 };
    },
    async lock(key: string, ms: number): Promise<void> {
      locks.set(key, Date.now() + ms);
    },
    async reset(key: string): Promise<void> {
      windows.delete(key);
      locks.delete(key);
    },
    async clearAll(): Promise<void> {
      windows.clear();
      locks.clear();
    },
    size: () => windows.size + locks.size,
  };
}

/** Replace a store's `consume` while keeping its lock/reset/clearAll behaviour intact. */
function withConsume(
  store: CountingStore,
  consume: SharedRateLimitStore['consume'],
): CountingStore {
  return { ...store, consume };
}

describe('an unconfigured limiter — every async method IS its synchronous twin (acceptance 1)', () => {
  it('drives checkAsync through the INSTANCE check, same arguments, same decision object', async () => {
    const limiter = new RateLimiter();
    const calls: unknown[][] = [];
    const real = limiter.check.bind(limiter);
    let handedBack: RateLimitDecision | undefined;
    limiter.check = ((bucket: string, id: string, policy?: RateLimitPolicy) => {
      calls.push([bucket, id, policy]);
      handedBack = real(bucket, id, policy);
      return handedBack;
    }) as RateLimiter['check'];

    const policy: RateLimitPolicy = { max: 3, windowMs: 60_000 };
    const decision = await limiter.checkAsync('login', '203.0.113.1', policy);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('login');
    expect(calls[0]?.[1]).toBe('203.0.113.1');
    // The carried policy arrives as the SAME object, never a copy — the limiter must not reshape it.
    expect(calls[0]?.[2]).toBe(policy);
    // And the caller gets back the very object the synchronous path built.
    expect(decision).toBe(handedBack);
  });

  it('passes NO policy through when the caller carried none', async () => {
    const limiter = new RateLimiter();
    const calls: unknown[][] = [];
    const real = limiter.check.bind(limiter);
    limiter.check = ((bucket: string, id: string, policy?: RateLimitPolicy) => {
      calls.push([bucket, id, policy]);
      return real(bucket, id, policy);
    }) as RateLimiter['check'];

    await limiter.checkAsync('register', '203.0.113.2');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toBeUndefined();
  });

  it('drives resetAsync and lockSourceAsync through their instance twins, same arguments', async () => {
    const limiter = new RateLimiter();
    const resets: unknown[][] = [];
    const locks: unknown[][] = [];
    const realReset = limiter.reset.bind(limiter);
    const realLock = limiter.lockSource.bind(limiter);
    limiter.reset = ((bucket: string, id: string) => {
      resets.push([bucket, id]);
      realReset(bucket, id);
    }) as RateLimiter['reset'];
    limiter.lockSource = ((bucket: string, id: string, ms?: number) => {
      locks.push([bucket, id, ms]);
      realLock(bucket, id, ms);
    }) as RateLimiter['lockSource'];

    await limiter.resetAsync('login', '203.0.113.3');
    await limiter.lockSourceAsync('refresh', '203.0.113.4');
    await limiter.lockSourceAsync('refresh', '203.0.113.5', 1_000);

    expect(resets).toEqual([['login', '203.0.113.3']]);
    // The default lock duration is the one the synchronous twin applies, not a second copy of it.
    expect(locks).toEqual([
      ['refresh', '203.0.113.4', REUSE_LOCK_MS],
      ['refresh', '203.0.113.5', 1_000],
    ]);
  });

  it('drives clearAllAsync through the instance twin', async () => {
    const limiter = new RateLimiter();
    let calls = 0;
    const real = limiter.clearAll.bind(limiter);
    limiter.clearAll = (() => {
      calls++;
      real();
    }) as RateLimiter['clearAll'];

    await limiter.clearAllAsync();
    expect(calls).toBe(1);
  });

  it('counts and refuses exactly as the synchronous path does', async () => {
    const limiter = new RateLimiter();
    const registered = DEFAULT_POLICIES.register;
    if (!registered) throw new Error("bucket 'register' has no registered policy");
    for (let i = 0; i < registered.max; i++) {
      expect((await limiter.checkAsync('register', 'ip')).allowed).toBe(true);
    }
    expect((await limiter.checkAsync('register', 'ip')).allowed).toBe(false);
    // A clean reset returns the full budget, and a lock refuses with the shared constant.
    await limiter.resetAsync('register', 'ip');
    expect((await limiter.checkAsync('register', 'ip')).allowed).toBe(true);
    await limiter.lockSourceAsync('register', 'ip');
    expect(await limiter.checkAsync('register', 'ip')).toEqual({
      allowed: false,
      retryAfterMs: REUSE_LOCK_MS,
    });
  });

  it('reports no shared store and no probe', () => {
    const limiter = new RateLimiter();
    expect(limiter.sharedStore).toBeUndefined();
    expect(limiter.sharedStoreProbed).toBe(false);
  });
});

describe('RateLimiter.withSharedStore — the boot probe is the only door onto the port', () => {
  it('accepts a correct store, reports it, and leaves NOTHING behind', async () => {
    const store = correctStore();
    const limiter = await RateLimiter.withSharedStore(store);
    expect(limiter.sharedStore).toBe(store);
    expect(limiter.sharedStoreProbed).toBe(true);
    // The probe resets its key on the way out, so a successful boot costs the store no residue —
    // neither a window a later caller would be charged for nor a lock that would refuse one.
    expect(store.size()).toBe(0);
  });

  it('reserves the probe bucket name, and a carried budget outranks the table anyway', async () => {
    // The name must never resolve as a registered bucket, so no probe call can ever be answered from
    // the table instead of from the budget it carries.
    expect(Object.keys(DEFAULT_POLICIES)).not.toContain(SHARED_STORE_PROBE_BUCKET);

    // Precedence, pinned: with an entry registered for a bucket AND a policy carried on the call, the
    // CARRIED one is what reaches the store. That is why a registration could not change what the
    // probe measures today, and why the rule above reserves the name rather than protecting the probe
    // from a lookup it never performs.
    const seen: (RateLimitPolicy | undefined)[] = [];
    const store = correctStore();
    const watched = withConsume(store, async (key, policy) => {
      seen.push(policy);
      return store.consume(key, policy);
    });
    const limiter = await RateLimiter.withSharedStore(watched, {
      generous: { max: 1_000_000, windowMs: 60_000 },
    });
    seen.length = 0; // drop the probe's own questions
    const carried: RateLimitPolicy = { max: 1, windowMs: 60_000 };
    expect((await limiter.checkAsync('generous', 'a', carried)).allowed).toBe(true);
    expect((await limiter.checkAsync('generous', 'a', carried)).allowed).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(carried);
    expect(seen[1]).toBe(carried);
  });

  it('REFUSES a store that ignores the carried budget and allows everything', async () => {
    const store = correctStore();
    const broken = withConsume(store, async () => ({ allowed: true, retryAfterMs: 0 }));
    await expect(RateLimiter.withSharedStore(broken)).rejects.toThrow(
      /does not honour an explicit per-call policy/,
    );
  });

  it('REFUSES a store that refuses EVERYTHING (so the probe is never vacuous)', async () => {
    const store = correctStore();
    const broken = withConsume(store, async () => ({ allowed: false, retryAfterMs: 1_000 }));
    await expect(RateLimiter.withSharedStore(broken)).rejects.toThrow(
      /does not honour an explicit per-call policy/,
    );
  });

  it('REFUSES a store that refuses correctly but advises a ZERO retry (acceptance 3)', async () => {
    // Correct on the decision, useless on the advice: every refusal would then be reported as the
    // minimum whole second regardless of how much of the window is actually left.
    const store = correctStore();
    let seen = 0;
    const broken = withConsume(store, async (key, policy) => {
      const decision = await store.consume(key, policy);
      seen++;
      return decision.allowed ? decision : { allowed: false, retryAfterMs: 0 };
    });
    await expect(RateLimiter.withSharedStore(broken)).rejects.toThrow(/a zero retry hint/);
    expect(seen).toBeGreaterThan(0);
  });

  it('REFUSES a store that lets a locked key through', async () => {
    const store = correctStore();
    const broken: CountingStore = { ...store, lock: async () => {} };
    await expect(RateLimiter.withSharedStore(broken)).rejects.toThrow(/locked key/);
  });

  it('REFUSES a store whose locked refusal advises anything but the shared lock constant', async () => {
    const store = correctStore();
    const broken = withConsume(store, async (key, policy) => {
      const decision = await store.consume(key, policy);
      if (!decision.allowed && decision.retryAfterMs === REUSE_LOCK_MS) {
        return { allowed: false, retryAfterMs: REUSE_LOCK_MS - 1 };
      }
      return decision;
    });
    await expect(RateLimiter.withSharedStore(broken)).rejects.toThrow(/locked refusal/);
  });

  it('gives each boot its OWN probe key, so two instances booting at once do not race', async () => {
    // A FIXED probe key would make the probe self-racing on exactly the substrate it validates: with a
    // budget of one, two instances booting against one shared store consume each other's single token
    // and a perfectly healthy instance aborts its boot. Per-boot ids remove the interference.
    const store = correctStore();
    const both = await Promise.all([
      RateLimiter.withSharedStore(store),
      RateLimiter.withSharedStore(store),
    ]);
    expect(both.map((l) => l.sharedStoreProbed)).toEqual([true, true]);
    expect(store.size()).toBe(0);
  });

  it('carries a caller-supplied policy table onto the limiter', async () => {
    const policies: Record<string, RateLimitPolicy> = { custom: { max: 1, windowMs: 60_000 } };
    const limiter = await RateLimiter.withSharedStore(correctStore(), policies);
    // The registered budget is looked up and carried into the store, so the second call is refused.
    expect((await limiter.checkAsync('custom', 'a')).allowed).toBe(true);
    expect((await limiter.checkAsync('custom', 'a')).allowed).toBe(false);
  });
});

describe('a shared limiter refuses every SYNCHRONOUS method rather than answering from memory', () => {
  it('runs all five synchronous methods normally on a plain limiter', () => {
    const limiter = new RateLimiter();
    expect(() => {
      limiter.check('login', 'a');
      limiter.lockSource('login', 'a');
      limiter.isLocked('login', 'a');
      limiter.reset('login', 'a');
      limiter.clearAll();
    }).not.toThrow();
  });

  it('throws from each of them on a shared limiter, naming the async twin', async () => {
    const limiter = await RateLimiter.withSharedStore(correctStore());
    // Falling back to the in-process store here would hand this instance a PRIVATE budget, which is
    // the defect a shared store exists to remove — so the guard refuses instead of degrading.
    expect(() => limiter.check('login', 'a')).toThrow(/checkAsync/);
    expect(() => limiter.lockSource('login', 'a')).toThrow(/lockSourceAsync/);
    expect(() => limiter.reset('login', 'a')).toThrow(/resetAsync/);
    expect(() => limiter.clearAll()).toThrow(/clearAllAsync/);
    // `isLocked` has no async twin of its own: a shared limiter reports its lock state through the
    // decision `checkAsync` returns, which is the operation that acts on it.
    expect(() => limiter.isLocked('login', 'a')).toThrow(/checkAsync/);
  });
});

describe('the shared path forwards an UNDEFINED policy instead of short-circuiting fail-open', () => {
  it('a LOCKED key in an UNREGISTERED bucket still refuses — the invariant the in-memory path pins', async () => {
    // `check` does the lock short-circuit BEFORE it looks a policy up, so a locked key in a bucket
    // nobody registered still refuses. `checkAsync` reproduces that only because it hands the store the
    // `undefined` policy rather than returning `{allowed:true}` first. Three docblocks state that and
    // nothing tested it: adding the fail-open short-circuit to the shared arm left the whole package
    // green. This arm is what makes the divergence visible.
    const store = correctStore();
    // A custom table WITHOUT `refresh`, so the bucket is genuinely unregistered on this limiter.
    const limiter = await RateLimiter.withSharedStore(store, {
      custom: { max: 5, windowMs: 1000 },
    });
    await limiter.lockSourceAsync('refresh', '203.0.113.9');
    const decision = await limiter.checkAsync('refresh', '203.0.113.9');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(REUSE_LOCK_MS);
    // And the in-memory twin agrees, which is the point — the two backends must not diverge here.
    const inMemory = new RateLimiter(new InMemoryRateLimitStore(), {
      custom: { max: 5, windowMs: 1000 },
    });
    inMemory.lockSource('refresh', '203.0.113.9');
    expect(inMemory.check('refresh', '203.0.113.9')).toEqual({
      allowed: false,
      retryAfterMs: REUSE_LOCK_MS,
    });
  });
});
