/**
 * The `CostPolicy` SEAM CONTRACT run against the SHIPPED DEFAULT — the arm that was missing.
 *
 * `packages/kernel/core/src/seam-contracts.test.ts` runs the conformance kit against a shipped
 * default AND a replacement fixture for four of the five seams, which is what makes "the default is
 * always present, and a replacement satisfies the same contract" two measured claims rather than
 * one. `CostPolicy` was the exception: BOTH of its conforming arms were `InMemoryFixtureCostPolicy`,
 * and `LedgerCostPolicy` — the implementation a real deployment actually gets — had never been
 * handed to `costPolicyContract` anywhere in the tree. The one seam whose decisions are about MONEY
 * was the one whose shipped behaviour the kit had never seen.
 *
 * WHY THE ARM LIVES HERE AND NOT THERE — a package boundary, not a preference. `@rayspec/core`
 * cannot import `@rayspec/tasks`; the dependency runs the other way (`@rayspec/tasks` depends on
 * `@rayspec/core`, which is how this file imports the kit). And `LedgerCostPolicy` is bound to a
 * `TenantDb`, so the arm needs a real Postgres — the kit's write half (`settle`) is a durable ledger
 * write, and a fake would prove nothing about the thing that is shipped. Running it here costs no
 * new dependency edge and no lockfile change.
 *
 * WHAT THIS ADDS OVER `budget.db.test.ts`, which already drives the ledger hard: that suite asserts
 * the ledger's ENFORCEMENT (ceilings under concurrency, denial mutating nothing, over-settlement
 * landing once). This one asserts the SEAM-SIDE obligation — that the shipped policy's answers are
 * well-formed, typed decisions an engine can act on, checked by the same kit an out-of-tree
 * replacement is measured against. A ledger that enforces correctly but answers unreadably is a
 * park the engine cannot explain, and nothing else checks that of the default.
 *
 * NOT VACUOUS, asserted rather than assumed: the kit's second property only means something if a
 * probe was actually DENIED, and its own `detail` says so either way — so the detail is read here
 * instead of trusting that a denial happened. The budgets below are chosen to guarantee one: the
 * kit's second probe proposes an estimate far past the declared workforce ceiling.
 *
 * TEETH at the bottom: a wrapper that delegates to the real policy but returns a malformed decision
 * MUST be reported failed. A conformance run that passes everything proves nothing about what it
 * passed, and that includes this one.
 */

import type { ContractResult, PolicyDecision } from '@rayspec/core';
import { type CostPolicy, contractFailures, costPolicyContract } from '@rayspec/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerCostPolicy, workforceBudgetsSchema } from './budget.js';
import {
  forTenant,
  makeTestDb,
  resetTaskSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'budget-seam-contract.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip the only run of the CostPolicy contract against its SHIPPED default.',
  );
}

/**
 * A workforce ceiling of 1 USD. The kit's probes are `estimateUsd: 0.01` (allowed) and
 * `estimateUsd: 1_000_000` (denied at the workforce scope) — so both branches of the decision shape
 * are exercised in one run, which is the point of pinning the number here rather than picking a
 * ceiling nothing reaches.
 */
function probeBudgets() {
  return workforceBudgetsSchema.parse({
    workforce: { usd: 1 },
    execution: { estimateUsdPerTurn: 1 },
  });
}

/** The kit's own names for the three properties it checks, in the order it checks them. */
const COST_PROPERTIES = [
  'authorize-yields-a-well-formed-decision',
  'denial-names-a-known-scope-with-finite-numbers',
  'settle-settles',
];

function detailOf(results: readonly ContractResult[], name: string): string {
  const hit = results.find((r) => r.name === name);
  expect(hit, `the kit reported no result named '${name}'`).toBeDefined();
  return (hit as ContractResult).detail;
}

describe.skipIf(!hasDb)('CostPolicy contract — the SHIPPED LedgerCostPolicy (db)', () => {
  let db: ReturnType<typeof makeTestDb>;

  beforeAll(async () => {
    db = makeTestDb();
    await resetTaskSchema(db);
    return async () => {
      await db.$client.end();
    };
  });

  beforeEach(async () => {
    await db.$client.unsafe(
      'TRUNCATE workforce_tasks, workforce_task_transitions, workforce_budget_ledger, run_events CASCADE;',
    );
    await seedOrgs(db);
  });

  it('conforms — every property the kit checks, against the real ledger', async () => {
    const policy = new LedgerCostPolicy(forTenant(db, TENANT_A), probeBudgets());
    const results = await costPolicyContract(policy);
    expect(contractFailures(results).map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
    // …and it checked all three, not a subset. A kit that quietly stopped emitting a property would
    // otherwise pass this arm with nothing to report.
    expect(results.map((r) => r.name)).toEqual(COST_PROPERTIES);
    expect(policy.id).toBe('ledger');
  });

  it('is NOT vacuous — a probe was really denied, and the kit says so in its own detail', async () => {
    const results = await costPolicyContract(
      new LedgerCostPolicy(forTenant(db, TENANT_A), probeBudgets()),
    );
    // The kit's pass detail for this property is either 'no probe was denied, so there was no
    // denial to check' or 'N denial(s) each name …'. The first reading is a PASS that checked
    // nothing, which is exactly the shape of gap this whole suite exists to close.
    const denialDetail = detailOf(results, 'denial-names-a-known-scope-with-finite-numbers');
    expect(denialDetail).not.toContain('no probe was denied');
    expect(denialDetail).toContain('denial(s)');
    expect(detailOf(results, 'authorize-yields-a-well-formed-decision')).toContain('decision(s)');
  });

  it('the contract run really touched the durable ledger — settle() moved settled_usd', async () => {
    await costPolicyContract(new LedgerCostPolicy(forTenant(db, TENANT_A), probeBudgets()));
    // The kit authorizes its first probe (estimate 0.01), is denied on the second, then settles the
    // first at actualUsd 0.02. Against the real class that is a reservation taken and given back,
    // plus a settled amount — on the workforce scope the declared ceiling created.
    const ledger = await db.$client.unsafe(
      "SELECT reserved_usd, settled_usd, scope_id FROM workforce_budget_ledger WHERE scope_kind = 'workforce';",
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.scope_id).toBe('wf-contract-probe');
    expect(Number(ledger[0]?.settled_usd)).toBe(0.02);
    expect(Number(ledger[0]?.reserved_usd)).toBe(0);
  });

  it('TEETH: a policy that answers with a malformed decision is REPORTED FAILED, not passed', async () => {
    // Delegates settle to the real ledger and breaks only the decision shape — the regression this
    // arm would actually see if `authorizeTurn`'s return type drifted.
    const shipped = new LedgerCostPolicy(forTenant(db, TENANT_A), probeBudgets());
    const malformed: CostPolicy = {
      id: 'ledger-malformed',
      authorize: () => Promise.resolve({ ok: true } as unknown as PolicyDecision),
      settle: (actual) => shipped.settle(actual),
    };
    expect(contractFailures(await costPolicyContract(malformed)).map((r) => r.name)).toContain(
      'authorize-yields-a-well-formed-decision',
    );
  });
});

// The un-skippable ran-guard: a REQUIRED run that lost DATABASE_URL would otherwise skip the entire
// describe above and read GREEN — leaving the shipped default un-contract-tested exactly as before.
describe('CostPolicy contract — ran-guard', () => {
  it('the shipped-default arm actually ran when the DB was required', () => {
    if (requireDb) expect(hasDb).toBe(true);
    else expect(true).toBe(true);
  });
});
