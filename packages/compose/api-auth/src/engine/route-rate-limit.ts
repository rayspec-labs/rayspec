/**
 * The declared-route throttle — the tier decision falls AFTER the credential is validated.
 *
 * A reverse proxy in front of the app can only see WHETHER an `Authorization` header is present; it
 * cannot see whether the credential inside it validates. Tiering a throttle there is therefore
 * forgeable — arbitrary junk in the header buys the generous tier and switches the protection off.
 * This middleware sits in the backend, on the declared-route chain, BEHIND the global `authenticate`
 * middleware and IN FRONT of `requireAuth()`. At that position the context already answers the only
 * question that matters: did this credential actually validate?
 *
 *   - no principal (no credential, or one that failed validation) ⇒ the STRICT bucket, keyed on the
 *     anti-spoof client source (`clientIpFromContext` — the socket peer unless a CONFIGURED trusted
 *     proxy set the forwarding header), so a forged header is throttled exactly like sending nothing;
 *   - a validated principal ⇒ the GENEROUS bucket, keyed on `${tenant}:${actor}` — the server-derived
 *     tenant carried by the principal itself (`resolveTenant` runs LATER in the chain, so `tenantId`
 *     is not yet on the context) plus the canonical `principalActor` derivation.
 *
 * It runs BEFORE `requireAuth()` on purpose: an unauthenticated caller must stay throttled, and a
 * caller that only ever collects `401`s is exactly the load the strict bucket exists to bound.
 *
 * ONE LIMITER. This reuses the shared injected `deps.rateLimiter` — there is no second limiter, and,
 * unless the limiter it was given was built through `RateLimiter.withSharedStore`, no external store
 * either, so the counters are IN-PROCESS and PER INSTANCE: a deployment running N instances grants
 * each caller N budgets. That is a documented limitation, not an oversight (see the declared-route
 * throttling section of the spec reference), and it is the same posture every other throttle in this
 * codebase already has. The per-route budgets built by `declaredRouteBudget` below share that limiter,
 * that store and therefore that limitation exactly: a declared `rateLimit` is a per-instance budget
 * too, and it additionally multiplies the number of distinct keys the one bounded store tracks.
 * An embedder that DOES hand `createAuthApp` a limiter over a shared store moves all of that at once:
 * the refusal below asks `checkAsync`, which on such a limiter asks the shared store, so the tiers and
 * every per-route budget become cluster-wide together and the bounded in-process key store stops being
 * the thing they are counted in. The shipped server supplies no such store.
 *
 * FAIL-OPEN TRAP. `RateLimiter.check` returns `allowed` for a bucket name that has no entry in the
 * limiter's policy table — an unregistered bucket silently permits everything. There are exactly two
 * safe discharges of that trap, and this module uses both:
 *   - REGISTER the bucket. Both default tiers below are registered in `DEFAULT_POLICIES` (auth-core
 *     `rate-limit.ts`), and a test pins that. A caller passing its OWN tier names must discharge the
 *     trap too — by this route or by the next one, never by neither.
 *   - CARRY the budget. A per-route budget passes its policy explicitly as the third argument to
 *     `check`, so no table lookup happens for those buckets at all and there is no registration to
 *     forget. The `ROUTE_BUDGET_BUCKET_PREFIX` bucket names are therefore DELIBERATELY ABSENT from
 *     `DEFAULT_POLICIES` and must never be added: a registered entry would become a second, shadowing
 *     source of truth for a budget the spec already states, and the two would drift apart silently.
 *     `assertLimiterHonoursExplicitPolicy` closes the remaining hole — see its own doc.
 *
 * CHAIN POSITION. The tiered middleware runs BEFORE `requireAuth()` (see above). The per-route budget
 * middleware runs AFTER it, because a budget keyed on tenant AND principal needs a principal to exist;
 * see the chain rationale in `register-declared-routes.ts`.
 */

import type { RateLimitPolicy } from '@rayspec/auth-core';
import { errorEnvelope, RateLimiter } from '@rayspec/auth-core';
import type { ApiRouteRateLimit } from '@rayspec/spec';
import { MAX_ROUTE_RATE_LIMIT_WINDOW_SECONDS } from '@rayspec/spec';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps, AppEnv } from '../app-context.js';
import { clientIpFromContext } from '../http/client-ip.js';
import { principalActor } from './principal-actor.js';

/**
 * The two bucket names a declared route throttles through. Each MUST discharge the fail-open trap in
 * the module header in ONE of its two safe ways: either the name is REGISTERED in auth-core's
 * `DEFAULT_POLICIES` (what the two default tiers below do), or the budget is CARRIED on the decision
 * call as an explicit policy (what a per-route budget does, which is why the
 * `ROUTE_BUDGET_BUCKET_PREFIX` names are deliberately absent from that table and must stay absent).
 * A name that does neither silently permits everything. Overriding these selects a differently-tuned
 * pair, which is how a per-route limit gets its own window/max and its own counter.
 */
export interface RouteRateTiers {
  /** Bucket for a request with NO validated principal. Keyed on the anti-spoof client source. */
  source: string;
  /** Bucket for a request with a validated principal. Keyed on `${tenant}:${actor}`. */
  principal: string;
}

/** The default tiers — the two buckets registered in auth-core's `DEFAULT_POLICIES`. */
export const DEFAULT_ROUTE_RATE_TIERS: RouteRateTiers = {
  source: 'declared-route-source',
  principal: 'declared-route-principal',
};

/** The `(bucket, id)` pair a request throttles against — what the limiter's decision call consumes. */
export interface RouteRateTarget {
  bucket: string;
  id: string;
}

/**
 * The tenant segment used when a validated principal carries no active org (e.g. a freshly registered
 * user before creating one). A literal placeholder, never an org id, so it cannot collide with one.
 */
const NO_TENANT = '-';

/**
 * Derive the throttle target for a request — the named, testable seam the middleware below is a thin
 * wrapper over.
 *
 * FAIL-CLOSED: a principal that yields no canonical actor string (neither a user id nor an api-key id)
 * is treated as unvalidated and falls to the strict source bucket, so an unexpected principal shape can
 * never buy the generous tier.
 */
export function routeRateTarget(
  c: Context<AppEnv>,
  deps: AppDeps,
  tiers: RouteRateTiers = DEFAULT_ROUTE_RATE_TIERS,
): RouteRateTarget {
  const principal = c.get('principal');
  const actor = principalActor(principal);
  if (principal && actor) {
    return { bucket: tiers.principal, id: `${principal.orgId ?? NO_TENANT}:${actor}` };
  }
  return { bucket: tiers.source, id: clientIpFromContext(c, deps.trustedProxies ?? []) };
}

/** The limiter reports milliseconds; the `Retry-After` header is SECONDS, and never below one. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/**
 * The declared-route throttle middleware. Over budget ⇒ `429` with the retry advice on BOTH channels:
 * a `Retry-After` header in whole seconds, and `error.details.retryAfterMs` in the body.
 *
 * The body is built through the SHARED `errorEnvelope` — the one chokepoint that structurally strips
 * `details` for codes outside `DETAILS_ALLOWED` — so this hand-mounted 429 is not an exception to that
 * invariant, and it carries the SAME `details.retryAfterMs` every other REQUEST-BUDGET throttle emits
 * through the thrown-`ApiError` path (`enforceRate` in routes/auth.ts, and the inline throws in app.ts,
 * invites.ts, triggers.ts and reprocess.ts). The media playback CONCURRENCY cap is the one 429 that
 * carries no `details` — it bounds simultaneous streams, not a time window, so it has no limiter
 * remainder to report.
 *
 * The header is set explicitly because the thrown-`ApiError` path builds its body in `app.onError` and
 * emits no headers; it is listed in the app's CORS `exposeHeaders` so a cross-origin `fetch` client can
 * read it (`Retry-After` is not CORS-safelisted), and the body detail keeps the advice reachable even
 * for a client that never sees the header.
 *
 * `policy`, when passed, is the budget this middleware carries INTO the limiter for its own buckets
 * instead of relying on a registered entry (see the fail-open trap in the module header). It is the
 * only difference between a tiered mount and a per-route one: this function stays THE single refusal
 * path, so a per-route `429` is byte-identical in shape to a tiered one — same envelope, same
 * `details.retryAfterMs`, same whole-second `Retry-After` — and there is exactly one place where the
 * shape of a declared-route throttle refusal is decided.
 */
export function routeRateLimit(
  deps: AppDeps,
  tiers: RouteRateTiers = DEFAULT_ROUTE_RATE_TIERS,
  policy?: RateLimitPolicy,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { bucket, id } = routeRateTarget(c, deps, tiers);
    const { allowed, retryAfterMs } = await deps.rateLimiter.checkAsync(bucket, id, policy);
    if (!allowed) {
      return c.json(
        errorEnvelope('RATE_LIMITED', 'Too many requests.', c.get('requestId') ?? 'unknown', {
          retryAfterMs,
        }),
        429,
        { 'Retry-After': String(retryAfterSeconds(retryAfterMs)) },
      );
    }
    await next();
  };
}

/**
 * The bucket-name prefix every DECLARED per-route budget lives under. Disjoint from every key in
 * auth-core's `DEFAULT_POLICIES`, and deliberately never registered there — a per-route budget carries
 * its policy on the call (see the fail-open trap in the module header), so a registered entry of the
 * same name would be a second, shadowing source of truth for a number the spec already states.
 */
export const ROUTE_BUDGET_BUCKET_PREFIX = 'declared-route-budget';

/** A derived per-route budget: the two bucket names it counts in, and the policy it carries. */
export interface RouteBudget {
  tiers: RouteRateTiers;
  policy: RateLimitPolicy;
}

/**
 * Derive the per-route budget for a route that declares `rateLimit`. PURE and TOTAL: it either returns
 * a budget or throws — it never returns something that would silently not throttle.
 *
 * FAIL-CLOSED on the numbers. The Zod grammar already constrains both members to positive integers,
 * but runtime packages in this repository build `ApiRouteSpec[]` literals directly and never go through
 * that parse, so the guard is restated here — at the one place the numbers are turned into a policy —
 * rather than trusted. `Number.isSafeInteger` is used, NOT `Number.isInteger`: `Number.isInteger(1e300)`
 * is `true`, and a window that large is not a limit. The window is additionally held to
 * `MAX_ROUTE_RATE_LIMIT_WINDOW_SECONDS` — the ceiling the linter reports at authoring time, imported
 * from @rayspec/spec rather than repeated here so the two can never disagree about the number. That
 * ceiling is what keeps the window's millisecond form far inside the safe integer range, so the
 * counter's `resetAt` always arrives and a declared budget can never degrade into a permanent `429`,
 * which would be a worse outcome than no limit at all. Every refusal names the route, because at boot
 * the author needs to know WHICH declaration is wrong.
 *
 * TWO bucket names, not one. `routeRateTarget` picks the `principal` arm for a validated principal and
 * the `source` arm otherwise. Behind `requireAuth()` the source arm is only reachable through that
 * function's own fail-closed "no canonical actor" fallback, and giving it a separate name keeps that
 * fallback visible in the key space instead of quietly merging two different populations into one
 * counter — and keeps the derivation correct if the chain is ever reordered. `${method} ${path}`
 * separates the routes of a PARSED spec, where lint rejects a duplicate method+path pair. It does
 * NOT separate them everywhere, and the exception is precisely the path this guard exists for: a
 * spec assembled in code skips `parseSpec`, and `lintSpec` is only ever called from inside it, so
 * nothing rejects a duplicate there. Two identical declarations would then count into ONE bucket —
 * which drains a single budget twice as fast rather than granting two, so that failure runs strictly
 * stricter and never leaks allowance. Guard and derivation live in ONE function so they cannot drift.
 */
export function declaredRouteBudget(route: {
  method: string;
  path: string;
  rateLimit: ApiRouteRateLimit;
}): RouteBudget {
  const { windowSeconds, max } = route.rateLimit;
  const where = `route ${route.method} ${route.path}`;
  for (const [field, value] of [
    ['windowSeconds', windowSeconds],
    ['max', max],
  ] as const) {
    if (!(Number.isSafeInteger(value) && value > 0)) {
      throw new Error(
        `declaredRouteBudget: ${where} declares rateLimit.${field} = ${String(value)} — it must be a ` +
          'whole positive number of requests/seconds (a safe integer greater than zero). Fail-closed: ' +
          'a budget that cannot be expressed is never silently dropped.',
      );
    }
  }
  if (windowSeconds > MAX_ROUTE_RATE_LIMIT_WINDOW_SECONDS) {
    throw new Error(
      `declaredRouteBudget: ${where} declares rateLimit.windowSeconds = ${String(windowSeconds)}, ` +
        `longer than the ${MAX_ROUTE_RATE_LIMIT_WINDOW_SECONDS} seconds (one day) a per-instance ` +
        'counter can honour. These counters live in the serving process, so a longer window would be ' +
        'voided by any restart rather than enforced — and far beyond it the window would not expire ' +
        'at all, leaving the route answering a permanent 429. Declare a window a caller can wait out.',
    );
  }
  return {
    tiers: {
      principal: `${ROUTE_BUDGET_BUCKET_PREFIX}:${route.method} ${route.path}`,
      source: `${ROUTE_BUDGET_BUCKET_PREFIX}-src:${route.method} ${route.path}`,
    },
    policy: { max, windowMs: windowSeconds * 1000 },
  };
}

/** The reserved key the boot probe below counts against — never a real route's bucket. */
const PROBE_BUCKET = `${ROUTE_BUDGET_BUCKET_PREFIX}-probe`;
const PROBE_ID = 'boot';

/**
 * BOOT PROBE — prove that the injected limiter actually honours an explicit policy before any route is
 * mounted on one.
 *
 * This closes the one hole the type system cannot. A per-route budget is unregistered by design, so a
 * `RateLimiter` subclass, a stub, or a version-skewed `@rayspec/auth-core` whose `check` simply ignores
 * its third argument still TYPE-CHECKS, falls back to the policy table, finds no entry for these
 * deliberately-unregistered buckets, and returns `allowed` for everything — making EVERY budgeted route
 * silently unlimited while the boot and the served OpenAPI document both claim otherwise. So the boot
 * asks the limiter the question directly, with a budget of one, and refuses to register if the answer
 * is wrong.
 *
 * BOTH halves are asserted. `!second.allowed` alone would be satisfied by a limiter that refuses
 * everything — including one whose probe key happens to be locked — and the probe would then be
 * vacuous in exactly the case it exists to catch. The reserved key is `reset` before AND after, so a
 * probe leaves no counter and no lock behind for a later call to trip over.
 *
 * A limiter over a SHARED store cannot be asked any of this here, because it answers asynchronously
 * and this runs inside synchronous route registration. `RateLimiter.withSharedStore` asks it the
 * equivalent questions at construction instead, so all that is left to check is that it WAS asked: a
 * limiter carrying a shared store it never probed reached this boot by some other door, which means
 * the same store-ignores-the-carried-policy hole is wide open and every budgeted route would mount
 * unlimited. Fail closed on that, then return — there is nothing further to drive synchronously.
 */
export function assertLimiterHonoursExplicitPolicy(limiter: RateLimiter): void {
  if (limiter.sharedStore) {
    if (!limiter.sharedStoreProbed) {
      throw new Error(
        'assertLimiterHonoursExplicitPolicy: the injected rate limiter carries a shared store but ' +
          'was not probed, so it did not come through RateLimiter.withSharedStore and the equivalent ' +
          'asynchronous probe never ran. A declared per-route rateLimit carries its budget on the call ' +
          'instead of registering a bucket, so a store that ignores it would leave every budgeted ' +
          'route silently unlimited. Fail-closed at boot rather than ship an unenforced limit.',
      );
    }
    return;
  }
  // The probe below drives `check`, but the middleware decides through `checkAsync`. On a limiter with
  // no shared store those are the same decision — `checkAsync` delegates to `check` — and that
  // delegation is the entire reason driving the synchronous method proves anything about the
  // asynchronous one. A limiter that REPLACES `checkAsync` breaks that link, and the probe would then
  // be interrogating a method the request path no longer calls: measured, a subclass overriding only
  // `checkAsync` passes this probe and then allows 5 of 5 requests against a budget of 1. Nothing can
  // be driven synchronously to close that, so refuse it — the supported way to supply a different
  // decision is `RateLimiter.withSharedStore`, which is probed at construction.
  if (limiter.checkAsync !== RateLimiter.prototype.checkAsync) {
    throw new Error(
      'assertLimiterHonoursExplicitPolicy: the injected rate limiter replaces checkAsync, which is ' +
        'the method the declared-route middleware calls, so driving the synchronous check here would ' +
        'prove nothing about the decision a request actually receives. A declared per-route rateLimit ' +
        'carries its budget on the call instead of registering a bucket, so a decision path that ' +
        'ignores it would leave every budgeted route silently unlimited. Supply alternative behaviour ' +
        'through RateLimiter.withSharedStore, which is probed at construction, rather than by ' +
        'overriding checkAsync. Fail-closed at boot rather than ship an unenforced limit.',
    );
  }
  const probePolicy: RateLimitPolicy = { max: 1, windowMs: 60_000 };
  limiter.reset(PROBE_BUCKET, PROBE_ID);
  const first = limiter.check(PROBE_BUCKET, PROBE_ID, probePolicy);
  const second = limiter.check(PROBE_BUCKET, PROBE_ID, probePolicy);
  limiter.reset(PROBE_BUCKET, PROBE_ID);
  if (!(first.allowed && !second.allowed)) {
    throw new Error(
      'assertLimiterHonoursExplicitPolicy: the injected rate limiter does not honour an explicit ' +
        `per-call policy (a budget of 1 allowed ${String(first.allowed)} then ${String(second.allowed)}, ` +
        'expected true then false). A declared per-route rateLimit carries its budget on the call ' +
        'instead of registering a bucket, so a limiter that ignores it would leave every budgeted ' +
        'route silently unlimited. Fail-closed at boot rather than ship an unenforced limit.',
    );
  }
}
