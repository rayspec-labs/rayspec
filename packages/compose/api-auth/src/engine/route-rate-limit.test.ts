/**
 * Unit tests for the declared-route throttle seam — the key derivation and the tier choice, without
 * a server or a database.
 *
 * Two things are pinned here that the served acceptance suite cannot show as sharply:
 *
 *  - the KEY FORMAT. The generous tier is keyed on tenant AND principal (`${tenant}:${actor}`) from
 *    the principal itself — `resolveTenant` runs LATER in the declared-route chain, so `tenantId` is
 *    not yet on the context — and the strict tier on the anti-spoof client source. A principal that
 *    yields no canonical actor falls back to the strict tier (fail-closed).
 *  - the FAIL-OPEN TRAP. `RateLimiter.check` ALLOWS every call for a bucket name absent from its
 *    policy table, so a tier name that is not registered would silently switch the throttle off. Both
 *    default tier names are asserted to be registered, next to a demonstration of what an
 *    unregistered name does — the reason the assertion exists.
 */

import type { RateLimitPolicy } from '@rayspec/auth-core';
import { DEFAULT_POLICIES, InMemoryRateLimitStore, RateLimiter } from '@rayspec/auth-core';
import type { Context, MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppDeps, AppEnv, AuthContext } from '../app-context.js';
import {
  assertLimiterHonoursExplicitPolicy,
  DEFAULT_ROUTE_RATE_TIERS,
  declaredRouteBudget,
  ROUTE_BUDGET_BUCKET_PREFIX,
  retryAfterSeconds,
  routeRateLimit,
  routeRateTarget,
} from './route-rate-limit.js';

/** A minimal stand-in for the request context the seam reads (principal + the client-source inputs). */
function fakeContext(opts: {
  principal?: AuthContext;
  peer?: string;
  forwardedFor?: string;
}): Context<AppEnv> {
  const headers: Record<string, string | undefined> = { 'x-forwarded-for': opts.forwardedFor };
  return {
    env:
      opts.peer === undefined ? undefined : { incoming: { socket: { remoteAddress: opts.peer } } },
    req: { header: (name: string) => headers[name.toLowerCase()] },
    get: (key: string) => (key === 'principal' ? opts.principal : undefined),
  } as unknown as Context<AppEnv>;
}

/** Only `trustedProxies` is read on this path. */
function fakeDeps(trustedProxies: readonly string[] = []): AppDeps {
  return { trustedProxies } as unknown as AppDeps;
}

const USER: AuthContext = { kind: 'user', userId: 'u-1', orgId: 'org-1', scopes: [] };
const API_KEY: AuthContext = { kind: 'apikey', orgId: 'org-2', apiKeyId: 'k-9', scopes: [] };

describe('routeRateTarget — the tier is chosen on whether the credential validated', () => {
  it('sends a request with NO principal to the strict bucket, keyed on the client source', () => {
    const target = routeRateTarget(fakeContext({ peer: '198.51.100.4' }), fakeDeps());
    expect(target).toEqual({ bucket: DEFAULT_ROUTE_RATE_TIERS.source, id: '198.51.100.4' });
  });

  it('honours a forwarding header ONLY behind a configured trusted proxy', () => {
    const c = fakeContext({ peer: '10.0.0.1', forwardedFor: '203.0.113.9' });
    // Untrusted peer: the header is ignored and the socket peer is the identity.
    expect(routeRateTarget(c, fakeDeps()).id).toBe('10.0.0.1');
    // Trusted peer: the forwarded client becomes the identity.
    expect(routeRateTarget(c, fakeDeps(['10.0.0.0/8'])).id).toBe('203.0.113.9');
  });

  it('sends a validated user principal to the generous bucket, keyed on tenant AND principal', () => {
    const target = routeRateTarget(
      fakeContext({ principal: USER, peer: '198.51.100.4' }),
      fakeDeps(),
    );
    expect(target).toEqual({ bucket: DEFAULT_ROUTE_RATE_TIERS.principal, id: 'org-1:user:u-1' });
  });

  it('keys a validated api-key principal by its key id under the same tenant segment', () => {
    const target = routeRateTarget(fakeContext({ principal: API_KEY }), fakeDeps());
    expect(target).toEqual({ bucket: DEFAULT_ROUTE_RATE_TIERS.principal, id: 'org-2:key:k-9' });
  });

  it('separates two principals of the same tenant, and one principal across two tenants', () => {
    const other: AuthContext = { kind: 'user', userId: 'u-2', orgId: 'org-1', scopes: [] };
    const elsewhere: AuthContext = { kind: 'user', userId: 'u-1', orgId: 'org-3', scopes: [] };
    const idOf = (p: AuthContext) => routeRateTarget(fakeContext({ principal: p }), fakeDeps()).id;
    expect(idOf(USER)).not.toBe(idOf(other));
    expect(idOf(USER)).not.toBe(idOf(elsewhere));
  });

  it('uses a placeholder tenant segment for a principal with no active org', () => {
    const noOrg: AuthContext = { kind: 'user', userId: 'u-7', scopes: [] };
    expect(routeRateTarget(fakeContext({ principal: noOrg }), fakeDeps()).id).toBe('-:user:u-7');
  });

  it('falls back to the strict bucket for a principal that yields no canonical actor', () => {
    // Fail-closed: neither a user id nor an api-key id ⇒ nothing to key a generous budget on.
    const shapeless = { kind: 'user', orgId: 'org-1', scopes: [] } as AuthContext;
    const target = routeRateTarget(
      fakeContext({ principal: shapeless, peer: '198.51.100.4' }),
      fakeDeps(),
    );
    expect(target).toEqual({ bucket: DEFAULT_ROUTE_RATE_TIERS.source, id: '198.51.100.4' });
  });

  it('collapses to the no-peer identity when there is no socket peer at all', () => {
    // An in-process request has no peer; a forwarding header is never trusted without one.
    expect(
      routeRateTarget(fakeContext({ forwardedFor: '203.0.113.9' }), fakeDeps(['0.0.0.0/0'])).id,
    ).toBe('unknown');
  });
});

describe('the default tiers must be REGISTERED policies (the limiter fails open otherwise)', () => {
  it('registers both tier names in the shared policy table', () => {
    expect(Object.keys(DEFAULT_POLICIES)).toEqual(
      expect.arrayContaining([DEFAULT_ROUTE_RATE_TIERS.source, DEFAULT_ROUTE_RATE_TIERS.principal]),
    );
  });

  it('enforces a real budget on each tier, and gives the strict one the smaller allowance', () => {
    const policyOf = (bucket: string): RateLimitPolicy => {
      const policy = DEFAULT_POLICIES[bucket];
      if (!policy) throw new Error(`bucket '${bucket}' has no registered policy`);
      return policy;
    };
    const source = policyOf(DEFAULT_ROUTE_RATE_TIERS.source);
    const principal = policyOf(DEFAULT_ROUTE_RATE_TIERS.principal);
    expect(source.max).toBeLessThan(principal.max);

    // BOTH tiers are driven to refusal. The generous one matters as much as the strict one: a tier
    // that never refuses is not a budget, and a policy retune that silently dropped its ceiling would
    // otherwise leave the whole declared surface unbounded for any caller holding a valid credential.
    for (const [name, policy] of [
      [DEFAULT_ROUTE_RATE_TIERS.source, source],
      [DEFAULT_ROUTE_RATE_TIERS.principal, principal],
    ] as const) {
      const limiter = new RateLimiter();
      for (let i = 0; i < policy.max; i++) {
        expect(limiter.check(name, 'a').allowed).toBe(true);
      }
      const refused = limiter.check(name, 'a');
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterMs).toBeGreaterThan(0);
      // A different id under the same tier is untouched.
      expect(limiter.check(name, 'b').allowed).toBe(true);
    }
  });

  it('shows what an UNREGISTERED bucket name would do — allow everything', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 1000; i++) {
      expect(limiter.check('declared-route-not-registered', 'a').allowed).toBe(true);
    }
  });
});

describe('retryAfterSeconds — the header unit is seconds, never below one', () => {
  it('rounds a millisecond budget up to whole seconds', () => {
    expect(retryAfterSeconds(60_000)).toBe(60);
    expect(retryAfterSeconds(1_001)).toBe(2);
  });

  it('never advertises a zero or negative delay', () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(-5)).toBe(1);
    expect(retryAfterSeconds(1)).toBe(1);
  });
});

/**
 * The DECLARED per-route budget — the derivation, its fail-closed guard, and the two structural
 * properties that keep it from silently not throttling.
 *
 * A per-route budget is deliberately NOT registered in the limiter's policy table: it travels as a
 * value on the `check` call instead, which is what makes the fail-open trap unreachable for its
 * buckets. That choice has two consequences worth pinning here, because neither is visible in a
 * behavioural "it throttles" assertion:
 *  - the bucket names must STAY unregistered, or a registered entry becomes a second, shadowing
 *    source of truth for a number the spec already states;
 *  - a limiter that ignores the carried policy would make every budgeted route silently unlimited,
 *    which is exactly what the boot probe refuses to let happen.
 */
describe('declaredRouteBudget — the derivation is total, and fail-closed on the numbers', () => {
  const route = { method: 'GET', path: '/pings', rateLimit: { windowSeconds: 60, max: 5 } };

  it('converts the declared window to milliseconds and carries the declared max', () => {
    expect(declaredRouteBudget(route).policy).toEqual({ max: 5, windowMs: 60_000 });
  });

  it('derives TWO distinct bucket names, both under the route-budget prefix and naming the route', () => {
    const { tiers } = declaredRouteBudget(route);
    expect(tiers.principal).not.toBe(tiers.source);
    for (const bucket of [tiers.principal, tiers.source]) {
      expect(bucket.startsWith(ROUTE_BUDGET_BUCKET_PREFIX)).toBe(true);
      expect(bucket).toContain('GET /pings');
    }
  });

  it("gives two different routes disjoint buckets, so one route cannot spend another route's budget", () => {
    const other = declaredRouteBudget({ ...route, path: '/pongs' });
    const mine = declaredRouteBudget(route);
    expect(mine.tiers.principal).not.toBe(other.tiers.principal);
    expect(mine.tiers.source).not.toBe(other.tiers.source);
    // The same method+path always derives the same buckets — the counter is stable across a restart
    // of the derivation, not a fresh one per call.
    expect(declaredRouteBudget(route).tiers).toEqual(mine.tiers);
  });

  // The GRAMMAR already rejects each of these, but runtime packages build `ApiRouteSpec[]` literals
  // directly and never go through `parseSpec` — so this guard is the only one those documents meet.
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer (Number.isInteger says true)', 1e300],
  ])('THROWS on a %s max, naming the route', (_label, max) => {
    expect(() => declaredRouteBudget({ ...route, rateLimit: { windowSeconds: 60, max } })).toThrow(
      /GET \/pings.*rateLimit\.max/s,
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 0.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer (Number.isInteger says true)', 1e300],
  ])('THROWS on a %s windowSeconds, naming the route', (_label, windowSeconds) => {
    expect(() => declaredRouteBudget({ ...route, rateLimit: { windowSeconds, max: 5 } })).toThrow(
      /GET \/pings.*rateLimit\.windowSeconds/s,
    );
  });

  it('THROWS on a window whose MILLISECOND form overflows the safe range', () => {
    // Number.MAX_SAFE_INTEGER is a perfectly good safe integer, so the per-field guard passes it — but
    // ×1000 it is not, and a resetAt that never arrives is a permanent 429, not a limit.
    const windowSeconds = Number.MAX_SAFE_INTEGER;
    expect(Number.isSafeInteger(windowSeconds)).toBe(true);
    expect(() => declaredRouteBudget({ ...route, rateLimit: { windowSeconds, max: 5 } })).toThrow(
      /millisecond form leaves the safe integer range/,
    );
  });

  it('rejects 1e300 for the reason Number.isInteger would have missed', () => {
    // Documents WHY the guard is Number.isSafeInteger: the weaker predicate accepts this value.
    expect(Number.isInteger(1e300)).toBe(true);
    expect(Number.isSafeInteger(1e300)).toBe(false);
  });
});

describe('a per-route budget bucket is DELIBERATELY not a registered policy', () => {
  it('adds no key to DEFAULT_POLICIES — the shared table is exactly the auth/tier set', () => {
    // Pinned as an exact set, so a later "helpful" registration of a route-budget bucket is caught
    // here rather than silently becoming a second source of truth for a declared number.
    expect(Object.keys(DEFAULT_POLICIES).sort()).toEqual(
      [
        'declared-route-principal',
        'declared-route-source',
        'invite-accept',
        'login',
        'oauth-token',
        'reprocess',
        'refresh',
        'register',
        'trigger-fire',
      ].sort(),
    );
  });

  it("registers NEITHER of a declared route budget's bucket names", () => {
    const { tiers } = declaredRouteBudget({
      method: 'GET',
      path: '/pings',
      rateLimit: { windowSeconds: 60, max: 5 },
    });
    expect(DEFAULT_POLICIES[tiers.principal]).toBeUndefined();
    expect(DEFAULT_POLICIES[tiers.source]).toBeUndefined();
    expect(
      Object.keys(DEFAULT_POLICIES).some((k) => k.startsWith(ROUTE_BUDGET_BUCKET_PREFIX)),
    ).toBe(false);
  });
});

describe('routeRateLimit carries the budget INTO the limiter rather than looking it up', () => {
  /** A limiter that records every `check` call, including the third argument. */
  function recordingLimiter(): { limiter: RateLimiter; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const limiter = new RateLimiter();
    const real = limiter.check.bind(limiter);
    limiter.check = ((bucket: string, id: string, policy?: RateLimitPolicy) => {
      calls.push([bucket, id, policy]);
      return real(bucket, id, policy);
    }) as RateLimiter['check'];
    return { limiter, calls };
  }

  /** Drive the middleware once against a principal-less request (the strict/source arm). */
  function runMiddleware(mw: MiddlewareHandler<AppEnv>): Promise<unknown> {
    const c = fakeContext({ peer: '198.51.100.4' });
    return Promise.resolve(mw(c, async () => {}));
  }

  it('passes NO policy when the route declares none (today behaviour, unchanged)', async () => {
    const { limiter, calls } = recordingLimiter();
    const deps = { rateLimiter: limiter, trustedProxies: [] } as unknown as AppDeps;
    await runMiddleware(routeRateLimit(deps));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toBeUndefined();
  });

  it("passes the derived policy and the route's own bucket when the route declares one", async () => {
    const { limiter, calls } = recordingLimiter();
    const deps = { rateLimiter: limiter, trustedProxies: [] } as unknown as AppDeps;
    const { tiers, policy } = declaredRouteBudget({
      method: 'GET',
      path: '/pings',
      rateLimit: { windowSeconds: 30, max: 7 },
    });
    await runMiddleware(routeRateLimit(deps, tiers, policy));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(tiers.source);
    expect(calls[0]?.[2]).toEqual({ max: 7, windowMs: 30_000 });
  });
});

describe('assertLimiterHonoursExplicitPolicy — the boot probe that closes the last fail-open hole', () => {
  it('passes for the shipped limiter and leaves NO counter behind', () => {
    const store = new InMemoryRateLimitStore();
    const limiter = new RateLimiter(store);
    expect(() => assertLimiterHonoursExplicitPolicy(limiter)).not.toThrow();
    // The trailing reset matters: a probe that left its own window behind would charge the next
    // caller of that key, and a repeated boot would accumulate them.
    expect(store.size()).toBe(0);
  });

  it('THROWS for a limiter whose check IGNORES the explicit policy (the version-skew case)', () => {
    // This is the subclass that still type-checks: it drops the third argument, falls back to the
    // policy table, finds no entry for a deliberately-unregistered bucket, and allows everything.
    class IgnoresPolicy extends RateLimiter {
      override check(bucket: string, id: string): { allowed: boolean; retryAfterMs: number } {
        return super.check(bucket, id);
      }
    }
    expect(() => assertLimiterHonoursExplicitPolicy(new IgnoresPolicy())).toThrow(
      /does not honour an explicit per-call policy/,
    );
  });

  it('THROWS for a limiter that refuses EVERYTHING, so the probe can never be vacuous', () => {
    // Asserting only `!second.allowed` would accept this one — including the case where the probe key
    // simply happens to be locked — and the probe would pass while proving nothing.
    class RefusesEverything extends RateLimiter {
      override check(): { allowed: boolean; retryAfterMs: number } {
        return { allowed: false, retryAfterMs: 1_000 };
      }
    }
    expect(() => assertLimiterHonoursExplicitPolicy(new RefusesEverything())).toThrow(
      /does not honour an explicit per-call policy/,
    );
  });
});
