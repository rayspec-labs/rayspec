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
import { DEFAULT_POLICIES, RateLimiter } from '@rayspec/auth-core';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppDeps, AppEnv, AuthContext } from '../app-context.js';
import {
  DEFAULT_ROUTE_RATE_TIERS,
  retryAfterSeconds,
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

    const limiter = new RateLimiter();
    for (let i = 0; i < source.max; i++) {
      expect(limiter.check(DEFAULT_ROUTE_RATE_TIERS.source, 'a').allowed).toBe(true);
    }
    const refused = limiter.check(DEFAULT_ROUTE_RATE_TIERS.source, 'a');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    // A different id under the same tier is untouched.
    expect(limiter.check(DEFAULT_ROUTE_RATE_TIERS.source, 'b').allowed).toBe(true);
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
