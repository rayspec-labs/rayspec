/**
 * The boot refusal for a limiter that carries a SHARED rate-limit store.
 *
 * `assertLimiterHonoursExplicitPolicy` asks the injected limiter, at boot and before any budgeted
 * route is mounted, whether it actually honours a per-call budget — the question a declared
 * `rateLimit` depends on, because those bucket names are deliberately never registered. A shared
 * store cannot answer that question synchronously, so for a limiter built over one the equivalent
 * question is asked by `RateLimiter.withSharedStore` at construction instead, and what remains here
 * is to verify that it WAS asked. A limiter that carries a shared store but never went through the
 * factory has skipped the probe entirely, and mounting a budgeted route on it would ship an
 * unenforced limit — so the boot refuses.
 *
 * The refusal is driven end to end through `createAuthApp`, not only through the assertion helper:
 * what matters operationally is that the server declines to start, not that a function throws when
 * called directly.
 *
 * No database: every path here throws (or completes) while WIRING routes, before any handler runs.
 */
import type { RateLimitDecision, RateLimitPolicy, SharedRateLimitStore } from '@rayspec/auth-core';
import { RateLimiter, REUSE_LOCK_MS } from '@rayspec/auth-core';
import type { RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthApp } from '../app.js';
import type { AppDeps } from '../app-context.js';
import { assertLimiterHonoursExplicitPolicy } from './route-rate-limit.js';

/** A correct in-process implementation of the port — enough to satisfy the factory's probe. */
function correctStore(): SharedRateLimitStore {
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
  };
}

/**
 * A limiter that carries a shared store WITHOUT having been probed — the shape a version-skewed
 * `@rayspec/auth-core`, a stub, or a second construction door would present. The factory is the only
 * door in this tree, so this subclass is how the unprobed state is reached at all.
 */
class UnprobedSharedLimiter extends RateLimiter {
  private readonly injected: SharedRateLimitStore;

  constructor(injected: SharedRateLimitStore) {
    super();
    this.injected = injected;
  }

  override get sharedStore(): SharedRateLimitStore | undefined {
    return this.injected;
  }

  override get sharedStoreProbed(): boolean {
    return false;
  }
}

/** A minimal, shape-valid spec whose single declared route carries a per-route budget. */
function budgetedSpec(): RaySpec {
  return {
    version: '1.0',
    metadata: { name: 'shared-store-boot', description: 'boot refusal fixture' },
    stores: [],
    api: [
      {
        method: 'GET',
        path: '/tight',
        action: { kind: 'handler', handler: 'h' },
        rateLimit: { windowSeconds: 60, max: 3 },
      },
    ],
    agents: [],
    tooling: [],
    triggers: [],
    handlers: [],
  } as RaySpec;
}

/** Build the app the shipped boot builds, with only the limiter and the declared spec varied. */
function bootWith(limiter: RateLimiter): void {
  const noop = () => {
    throw new Error('the fake db must not be queried in the boot-refusal suite');
  };
  const deps = {
    rateLimiter: limiter,
    allowedOrigins: [],
    db: { select: noop, transaction: noop },
    engine: {
      spec: budgetedSpec(),
      productTables: new Map() as ReadonlyMap<string, PgTable>,
      handlers: new Map([['h', { kind: 'route', fn: async () => ({ ok: true }) }]]),
    },
  } as unknown as AppDeps;
  createAuthApp(deps);
}

let savedKey: string | undefined;
let savedPepper: string | undefined;

beforeAll(() => {
  // `createAuthApp` refuses to construct without both boot secrets present; it only checks presence.
  savedKey = process.env.RAYSPEC_JWT_SIGNING_KEY;
  savedPepper = process.env.RAYSPEC_API_KEY_PEPPER;
  process.env.RAYSPEC_JWT_SIGNING_KEY = 'boot-secret-present-for-shared-store-suite';
  process.env.RAYSPEC_API_KEY_PEPPER = 'boot-pepper-present-for-shared-store-suite';
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.RAYSPEC_JWT_SIGNING_KEY;
  else process.env.RAYSPEC_JWT_SIGNING_KEY = savedKey;
  if (savedPepper === undefined) delete process.env.RAYSPEC_API_KEY_PEPPER;
  else process.env.RAYSPEC_API_KEY_PEPPER = savedPepper;
});

describe('assertLimiterHonoursExplicitPolicy — the shared-store arm', () => {
  it('accepts a limiter built through the factory without asking it anything synchronously', async () => {
    const limiter = await RateLimiter.withSharedStore(correctStore());
    // Every synchronous method on a shared limiter throws, so the only way this can pass is by
    // returning on the probed flag rather than by driving the synchronous probe below it.
    expect(() => assertLimiterHonoursExplicitPolicy(limiter)).not.toThrow();
  });

  it('REFUSES a limiter that carries a shared store it never probed', () => {
    expect(() =>
      assertLimiterHonoursExplicitPolicy(new UnprobedSharedLimiter(correctStore())),
    ).toThrow(/shared store .* was not probed/s);
  });

  it('still drives the synchronous probe for a plain limiter', () => {
    expect(() => assertLimiterHonoursExplicitPolicy(new RateLimiter())).not.toThrow();
  });
});

describe('createAuthApp — a budgeted route will not mount on an unproved shared limiter', () => {
  it('ABORTS the boot rather than serving a route whose declared budget nothing enforces', () => {
    expect(() => bootWith(new UnprobedSharedLimiter(correctStore()))).toThrow(
      /shared store .* was not probed/s,
    );
  });

  it('boots once the limiter came through the factory', async () => {
    const limiter = await RateLimiter.withSharedStore(correctStore());
    expect(() => bootWith(limiter)).not.toThrow();
  });

  it('boots on a plain limiter exactly as it does today', () => {
    expect(() => bootWith(new RateLimiter())).not.toThrow();
  });
});
