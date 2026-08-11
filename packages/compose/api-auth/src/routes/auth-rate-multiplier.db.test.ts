/**
 * The register bucket under the auth rate multiplier — six registrations from ONE source inside one
 * window, driven through the REAL Hono app against Postgres.
 *
 * The production `register` bucket allows 5 registrations per source per minute (DEFAULT_POLICIES),
 * which is right for production but has no dev/CI override: a harness that provisions several orgs
 * in one run trips the bucket, and the failure surfaces far from its cause (the 6th account's token
 * is never minted, so the suite's later assertions fail 401). RAYSPEC_AUTH_RATE_MULTIPLIER exists
 * for exactly that run: the composition root turns it into effective policies via
 * `scaledAuthPolicies` and hands them to the limiter. This suite injects the SAME function's output
 * through the harness policy seam — never a hand-built policies object — so what it proves is the
 * production scaling path:
 *  1. ACCEPT CONTROL: the DEFAULT limiter (multiplier 1) is unchanged — five registrations answer
 *     201 and the sixth answers 429 RATE_LIMITED;
 *  2. under `scaledAuthPolicies(100)` — the multiplier the issue names — ALL SIX answer 201.
 *
 * MECHANICS: an in-process `app.request()` has no socket peer, so `clientIpFromContext` collapses
 * every caller to `'unknown'` — which is precisely the fixture here: all six registrations share
 * ONE register bucket, the harness-suite shape the multiplier exists to unbreak.
 *
 * Skips without DATABASE_URL — but HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * yet absent (un-skippable ran-guard at the bottom).
 */
import { scaledAuthPolicies } from '@rayspec/auth-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'auth-rate-multiplier.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the auth rate-multiplier acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

let testsRan = 0;

/** Register `count` users (distinct emails, one auto-created org each) back-to-back — well inside
 * the 60s window — and collect the six statuses in order. */
async function registerStatuses(h: Harness, prefix: string, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 1; i <= count; i++) {
    const res = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: {
        email: `${prefix}-${i}@example.com`,
        password: 'correct horse battery',
        orgName: `${prefix}-org-${i}`,
      },
    });
    statuses.push(res.status);
  }
  return statuses;
}

describeDb('the register bucket under the auth rate multiplier', () => {
  let production: Harness; // the DEFAULT policies — multiplier 1, byte-identical to today
  let scaled: Harness; // scaledAuthPolicies(100) — the dev/CI posture the issue names

  beforeAll(async () => {
    production = await createHarness({ schema: 'rayspec_test_apiauth_ratemult_default' });
    scaled = await createHarness({
      schema: 'rayspec_test_apiauth_ratemult_scaled',
      rateLimitPolicies: scaledAuthPolicies(100),
    });
  });
  afterAll(async () => {
    await production.close();
    await scaled.close();
  });

  it('ACCEPT CONTROL: the DEFAULT limiter answers 201 five times, then 429 RATE_LIMITED on the sixth', async () => {
    testsRan++;
    const statuses = await registerStatuses(production, 'ctrl', 6);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    // The refusal is the throttle envelope — not some other 4xx that happens to block the flood.
    const refused = await jsonRequest(production.app, 'POST', '/v1/auth/register', {
      body: {
        email: 'ctrl-7@example.com',
        password: 'correct horse battery',
        orgName: 'ctrl-org-7',
      },
    });
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe('RATE_LIMITED');
  });

  it('under scaledAuthPolicies(100) ALL SIX registrations inside one window answer 201', async () => {
    testsRan++;
    const statuses = await registerStatuses(scaled, 'scaled', 6);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 201]);
  });
});

// Un-skippable ran-guard: when the DB is REQUIRED, this suite must actually have run its arms — a
// silently skipped multiplier acceptance would be a false green on both sides of the scaling.
describe('auth rate-multiplier suite ran', () => {
  it('executed its arms when the DB is required', () => {
    if (requireDb) expect(testsRan).toBe(2);
    else expect(true).toBe(true);
  });
});
