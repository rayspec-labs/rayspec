/**
 * The shared rate-limit store, proved against a real concurrent substrate.
 *
 * The port exists so that two serving instances can enforce ONE combined limit instead of one budget
 * each. That property is only observable against a store several connections can reach at the same
 * moment, so this suite drives the Postgres implementation from `test-support` over TWO independent
 * connection pools onto ONE table, and alternates a large burst of concurrent calls between the two
 * limiters built over them.
 *
 * What it proves:
 *  1. ATOMICITY — a burst of N concurrent calls against a budget of M grants exactly M, and the
 *     stored hit count equals N, so no update was lost;
 *  2. its ANTI-TAUTOLOGY CONTROL — the same burst, the same table, the same facade, but a store whose
 *     consume is a SELECT followed by an UPDATE, over-grants wildly. Read the two together: if the
 *     control ever goes green the atomic arm is proving nothing, and the answer is to raise the
 *     concurrency, never to weaken the assertion;
 *  3. the RETRY HINT comes from the operation that made the decision — every refusal advises between
 *     one millisecond and the whole window, never zero, and the store's injected executor records
 *     exactly ONE round trip for that consume. The round-trip count is the load-bearing half: a range
 *     assertion alone cannot tell a hint computed by the deciding statement from one fetched by a
 *     second statement afterwards;
 *  4. the LOCK crosses instances — a source locked through one limiter is refused by the other, with
 *     the same constant the in-memory path returns, and a carried budget cannot buy past it;
 *  5. the whole thing at the HTTP surface — two apps mounting the real declared-route middleware over
 *     the two limiters share one per-route budget;
 *  6. the two edges that must match the in-memory store exactly — an unregistered bucket carrying no
 *     budget is allowed with a zero hint and creates no row at all, and an expired window rolls over.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * yet absent (un-skippable ran-guard at the bottom).
 */
import { randomUUID } from 'node:crypto';
import type { RateLimitPolicy, SharedRateLimitStore } from '@rayspec/auth-core';
import { RateLimiter, REUSE_LOCK_MS } from '@rayspec/auth-core';
import type { Db } from '@rayspec/db';
import { makeDbWithSchema } from '@rayspec/db/testing';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps, AppEnv, AuthContext } from '../app-context.js';
import {
  type PgRateLimitExecutor,
  PgSharedRateLimitStore,
  pgRateLimitExecutor,
  SHARED_RATE_LIMIT_TABLE,
  SHARED_RATE_LIMIT_TABLE_SQL,
} from '../test-support/pg-rate-limit-store.js';
import { declaredRouteBudget, routeRateLimit } from './route-rate-limit.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'shared-rate-limit-store.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
      'but absent — refusing to silently skip the only proof that the shared store decides atomically.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_shared_rate_limit';

/** The burst size every concurrency arm drives. Far above the budget, so a leak is unmissable. */
const CONCURRENCY = 200;
/** The budget the concurrency arms enforce, and the window they enforce it over. */
const BUDGET: RateLimitPolicy = { max: 5, windowMs: 60_000 };

let testsRan = 0;

describeDb('the shared rate-limit store over one Postgres table', () => {
  let dbA: Db;
  let dbB: Db;
  let execA: PgRateLimitExecutor;
  let limiterA: RateLimiter;
  let limiterB: RateLimiter;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL absent');
    const boot = makeDbWithSchema(url, 'public', 1);
    await boot.$client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await boot.$client.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    await boot.$client.end();

    // TWO pools, each with its own connections, both pinned to the one schema — the closest a single
    // process gets to two serving instances sharing a database.
    dbA = makeDbWithSchema(url, SCHEMA, 8);
    dbB = makeDbWithSchema(url, SCHEMA, 8);
    execA = pgRateLimitExecutor(dbA);
    await execA(SHARED_RATE_LIMIT_TABLE_SQL, []);

    limiterA = await RateLimiter.withSharedStore(new PgSharedRateLimitStore(execA));
    limiterB = await RateLimiter.withSharedStore(
      new PgSharedRateLimitStore(pgRateLimitExecutor(dbB)),
    );
  });

  afterAll(async () => {
    await dbA?.$client.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await dbA?.$client.end();
    await dbB?.$client.end();
  });

  beforeEach(async () => {
    await limiterA.clearAllAsync();
  });

  /** The stored hit count for a key, or null when the store holds no row for it. */
  async function storedHits(key: string): Promise<number | null> {
    const rows = await execA(`SELECT hits FROM ${SHARED_RATE_LIMIT_TABLE} WHERE key = $1`, [key]);
    const row = rows[0];
    return row === undefined ? null : Number(row.hits);
  }

  it('grants EXACTLY the budget across two instances under a concurrent burst (acceptance 2)', async () => {
    testsRan++;
    const id = randomUUID();
    const decisions = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        (i % 2 === 0 ? limiterA : limiterB).checkAsync('shared', id, BUDGET),
      ),
    );
    const allowed = decisions.filter((d) => d.allowed).length;
    // One combined limit, not one per instance: two limiters, one table, exactly the declared budget.
    expect(allowed).toBe(BUDGET.max);
    // And NO LOST UPDATES: every one of the concurrent calls is counted, which is what makes the
    // grant count above a consequence of the store rather than of calls quietly vanishing.
    expect(await storedHits(`shared:${id}`)).toBe(CONCURRENCY);
  });

  it('ANTI-TAUTOLOGY CONTROL — a SELECT-then-UPDATE store over the same race OVER-GRANTS', async () => {
    testsRan++;
    // The control exists to prove the burst above is genuinely concurrent. It shares the table, the
    // facade and the arguments; the ONLY difference is that its decision is not one statement.
    const naive = await RateLimiter.withSharedStore(naiveStore(execA));
    const id = randomUUID();
    const decisions = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => naive.checkAsync('shared', id, BUDGET)),
    );
    const allowed = decisions.filter((d) => d.allowed).length;
    expect(allowed).toBeGreaterThan(BUDGET.max);
    // The lost updates are visible in the row itself: far fewer hits stored than calls made.
    const hits = await storedHits(`shared:${id}`);
    expect(hits).not.toBeNull();
    expect(hits ?? 0).toBeLessThan(CONCURRENCY);
  });

  it('advises a retry from the SAME operation that refused — one round trip, never zero (acceptance 3)', async () => {
    testsRan++;
    const id = randomUUID();
    const decisions = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        (i % 2 === 0 ? limiterA : limiterB).checkAsync('shared', id, BUDGET),
      ),
    );
    const refusals = decisions.filter((d) => !d.allowed);
    expect(refusals).toHaveLength(CONCURRENCY - BUDGET.max);
    for (const refusal of refusals) {
      expect(typeof refusal.retryAfterMs).toBe('number');
      // Never zero — a zero hint degrades every 429 to the minimum whole second regardless of how
      // much of the window is actually left — and never beyond the window it is advising about.
      expect(refusal.retryAfterMs).toBeGreaterThanOrEqual(1);
      expect(refusal.retryAfterMs).toBeLessThanOrEqual(BUDGET.windowMs);
    }

    // ONE ROUND TRIP. A range assertion alone cannot distinguish a hint computed by the deciding
    // statement from one fetched by a second statement afterwards; the count can.
    let roundTrips = 0;
    const counted: PgRateLimitExecutor = (text, params) => {
      roundTrips++;
      return execA(text, params);
    };
    const metered = await RateLimiter.withSharedStore(new PgSharedRateLimitStore(counted));
    const meteredId = randomUUID();
    await metered.checkAsync('shared', meteredId, { max: 1, windowMs: 60_000 });
    roundTrips = 0;
    const refused = await metered.checkAsync('shared', meteredId, { max: 1, windowMs: 60_000 });
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThanOrEqual(1);
    expect(roundTrips).toBe(1);
  });

  it('carries the refresh-reuse LOCK across instances, with the shared constant and no extra count', async () => {
    testsRan++;
    const id = randomUUID();
    expect((await limiterA.checkAsync('refresh', id, BUDGET)).allowed).toBe(true);
    expect((await limiterA.checkAsync('refresh', id, BUDGET)).allowed).toBe(true);
    const before = await storedHits(`refresh:${id}`);
    expect(before).toBe(2);

    await limiterA.lockSourceAsync('refresh', id);

    // The OTHER instance sees the lock, and reports the same constant the in-memory path reports —
    // deliberately not the true remaining lock time, which would be a second observable the two
    // backends could disagree on and would let a caller poll a lock to learn how much is left.
    expect(await limiterB.checkAsync('refresh', id, BUDGET)).toEqual({
      allowed: false,
      retryAfterMs: REUSE_LOCK_MS,
    });
    // A carried budget is a request ceiling, never a way around the lock.
    expect(await limiterB.checkAsync('refresh', id, { max: 1_000_000, windowMs: 1_000 })).toEqual({
      allowed: false,
      retryAfterMs: REUSE_LOCK_MS,
    });
    // A locked key is refused BEFORE the window is touched, so neither refusal spent budget.
    expect(await storedHits(`refresh:${id}`)).toBe(before);

    // And a reset clears the window AND the lock together, exactly as the in-memory reset does.
    await limiterB.resetAsync('refresh', id);
    expect(await storedHits(`refresh:${id}`)).toBeNull();
    expect((await limiterA.checkAsync('refresh', id, BUDGET)).allowed).toBe(true);
  });

  it('enforces ONE per-route budget across two apps at the HTTP surface (acceptance 2, end to end)', async () => {
    testsRan++;
    // The real declared-route middleware, built from a real declared budget, mounted on two bare apps
    // over the two limiters. Both apps present the SAME validated principal, so both key on the same
    // tenant-and-actor pair — which is what makes the second app's refusal mean "one combined limit".
    const routeMax = 3;
    const { tiers, policy } = declaredRouteBudget({
      method: 'GET',
      path: `/tight-${randomUUID()}`,
      rateLimit: { windowSeconds: 60, max: routeMax },
    });
    const appA = mountBudgetedRoute(limiterA, tiers, policy);
    const appB = mountBudgetedRoute(limiterB, tiers, policy);

    for (let i = 0; i < routeMax; i++) {
      expect((await appA.request('/tight')).status).toBe(200);
    }
    // The budget is spent — on the OTHER app, which shares no memory with the first.
    const throttled = await appB.request('/tight');
    expect(throttled.status).toBe(429);
    const body = (await throttled.json()) as {
      error: { code: string; details: { retryAfterMs: number } };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(typeof body.error.details.retryAfterMs).toBe('number');
    expect(body.error.details.retryAfterMs).toBeGreaterThan(0);
    const retryAfter = Number(throttled.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('fails OPEN for an unregistered bucket carrying no budget, and creates NO row', async () => {
    testsRan++;
    // `RateLimiter.check` never reaches the counter for a bucket with no policy, so neither may the
    // shared store: a row here would be an unbounded key-space the in-memory path does not have.
    const id = randomUUID();
    expect(await limiterA.checkAsync('never-registered', id)).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
    expect(await storedHits(`never-registered:${id}`)).toBeNull();
  });

  it('rolls the window over once it has expired', async () => {
    testsRan++;
    const id = randomUUID();
    for (let i = 0; i < BUDGET.max; i++) {
      expect((await limiterA.checkAsync('shared', id, BUDGET)).allowed).toBe(true);
    }
    expect((await limiterA.checkAsync('shared', id, BUDGET)).allowed).toBe(false);
    // Force the window into the past rather than waiting a minute for it.
    await execA(
      `UPDATE ${SHARED_RATE_LIMIT_TABLE} SET window_ends_at = now() - interval '1 millisecond' WHERE key = $1`,
      [`shared:${id}`],
    );
    expect((await limiterA.checkAsync('shared', id, BUDGET)).allowed).toBe(true);
    expect(await storedHits(`shared:${id}`)).toBe(1);
  });
});

/** The validated principal both apps in the HTTP arm present, so both key on one bucket. */
const PRINCIPAL: AuthContext = { kind: 'user', userId: 'u-1', orgId: 'org-1', scopes: [] };

/** A bare app mounting the REAL declared-route throttle over `limiter`, behind a fixed principal. */
function mountBudgetedRoute(
  limiter: RateLimiter,
  tiers: ReturnType<typeof declaredRouteBudget>['tiers'],
  policy: RateLimitPolicy,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const deps = { rateLimiter: limiter, trustedProxies: [] } as unknown as AppDeps;
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-shared-store');
    c.set('principal', PRINCIPAL);
    await next();
  });
  app.use('*', routeRateLimit(deps, tiers, policy));
  app.get('/tight', (c) => c.json({ ok: true }));
  return app;
}

/**
 * The anti-tautology control: the SAME table and the same lock/reset/clearAll, but a consume that
 * reads the counter and then writes it back — the shape every shared-counter implementation reaches
 * for first, and the one the single-statement consume exists to replace.
 */
function naiveStore(exec: PgRateLimitExecutor): SharedRateLimitStore {
  const atomic = new PgSharedRateLimitStore(exec);
  return {
    lock: atomic.lock.bind(atomic),
    reset: atomic.reset.bind(atomic),
    clearAll: atomic.clearAll.bind(atomic),
    async consume(key, policy) {
      if (!policy) return atomic.consume(key, policy);
      const rows = await exec(
        `SELECT hits, window_ends_at, locked_until FROM ${SHARED_RATE_LIMIT_TABLE} WHERE key = $1`,
        [key],
      );
      const row = rows[0];
      const now = Date.now();
      if (row?.locked_until && new Date(String(row.locked_until)).getTime() > now) {
        return { allowed: false, retryAfterMs: REUSE_LOCK_MS };
      }
      const live = row !== undefined && new Date(String(row.window_ends_at)).getTime() > now;
      const hits = live ? Number(row?.hits ?? 0) + 1 : 1;
      await exec(
        `INSERT INTO ${SHARED_RATE_LIMIT_TABLE} (key, hits, window_ends_at, locked_until)
         VALUES ($1, $2, now() + ($3::double precision * interval '1 millisecond'), NULL)
         ON CONFLICT (key) DO UPDATE
           SET hits = EXCLUDED.hits, window_ends_at = EXCLUDED.window_ends_at`,
        [key, hits, policy.windowMs],
      );
      return hits > policy.max
        ? { allowed: false, retryAfterMs: policy.windowMs }
        : { allowed: true, retryAfterMs: 0 };
    },
  };
}

// Un-skippable ran-guard: when the DB is REQUIRED, this suite must actually have run its arms — it is
// the ONLY proof that the shared store decides atomically and advises from the deciding operation, so
// a silent skip would be a false green on exactly the two acceptance criteria that need a database.
describe('shared rate-limit store suite ran', () => {
  it('executed its arms when the DB is required', () => {
    if (requireDb) expect(testsRan).toBeGreaterThanOrEqual(7);
    else expect(true).toBe(true);
  });
});
