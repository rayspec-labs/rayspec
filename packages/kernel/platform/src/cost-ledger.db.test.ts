/**
 * Cost-ledger productionization — DB-backed tests.
 *
 * Proves run-core's journal sink finalizes cost AT record() time from the effective-dated registry
 * (the single source of truth): the COMPUTED cost is the registry value (not the adapter's
 * claimed number), the PROVIDER cost is reconciled (drift flag trips on a REAL divergence), the
 * Decision-#7 SUBSCRIPTION rule writes billed=0 with a non-zero attributed cost, provenance is
 * recorded, and the run→tenant roll-ups aggregate the journal tenant-scoped.
 *
 * Uses a REAL Postgres-backed journal/db + a FAKE backend that reports a chosen auth mode + provider
 * cost. No network.
 */
import type { AgentSpec, AuthMode, Backend, RunContext, RunResult } from '@rayspec/core';
import { computeCost } from '@rayspec/core';
import { schema } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rollupRunCost, rollupTenantCost, runAgent } from './run-core.js';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
  TENANT_B,
} from './test-support/test-db.js';

const db = makeTestDb();

/**
 * A fake backend that journals ONE llm step reporting a chosen auth mode + (optionally) a provider
 * cost + usage. It does NOT pre-compute a faithful cost — run-core re-computes it from the registry,
 * which is exactly what we assert. The adapter's claimed costUsd is deliberately a LIE (999) so a test
 * that found 999 in the ledger would catch run-core trusting the adapter instead of the registry.
 */
class CostBackend implements Backend {
  readonly id = 'openai' as const;
  constructor(
    private readonly opts: {
      authMode: AuthMode;
      providerCostUsd?: number;
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    },
  ) {}
  async resolveAuth() {
    return this.opts.authMode;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const usage = this.opts.usage ?? { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 };
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText: 'ok' },
      usage,
      // A deliberately WRONG adapter cost — run-core must IGNORE it and re-compute from the registry.
      costUsd: 999,
      ...(this.opts.providerCostUsd !== undefined
        ? { providerCostUsd: this.opts.providerCostUsd }
        : {}),
      model: spec.model,
      producedBy: 'test-cost-backend@1.0.0',
      latencyMs: 1,
      status: 'ok',
      authMode: this.opts.authMode,
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: this.opts.authMode,
      status: 'completed',
      finalText: 'ok',
      output: null,
      error: null,
      errorClass: null,
      conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'ok' }] }],
      usage,
      // The adapter's RunResult cost is ALSO a lie — run-core rolls up the journal, not this.
      costUsd: 999,
      stepCount: 1,
    };
  }
}

function spec(name: string, model = 'gpt-4.1-mini'): AgentSpec {
  return { name, instructions: 'i', model, input: `in-${name}`, tools: [], maxTurns: 8 };
}

/** Read the single journal step for a run (the per-step ledger row). */
async function stepRow(runId: string) {
  const rows = await db
    .select()
    .from(schema.journalSteps)
    .where(eq(schema.journalSteps.runId, runId));
  return rows[0];
}

/** Read the run header row. */
async function runRow(runId: string) {
  const rows = await db.select().from(schema.runs).where(eq(schema.runs.runId, runId));
  return rows[0];
}

beforeAll(async () => {
  await resetRunSchema(db);
});
beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A, TENANT_B);
});
afterAll(async () => {
  await db.$client.end();
});

describe('per-step cost is RE-COMPUTED from the registry at record() time', () => {
  it('the journaled cost is the registry cost for the usage+model, NOT the adapter’s claimed number', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(tdb, new CostBackend({ authMode: 'api-key' }), spec('reg'), {});
    const step = await stepRow(res.runId);
    // computeCost('gpt-4.1-mini', {1000,500}) = (1000*0.4 + 500*1.6)/1e6 = (400+800)/1e6 = 0.0012.
    const expected = computeCost('gpt-4.1-mini', { inputTokens: 1000, outputTokens: 500 }).costUsd;
    expect(Number(step?.costUsd)).toBeCloseTo(expected, 12);
    // The adapter LIED with 999 — it must NOT be in the ledger.
    expect(Number(step?.costUsd)).not.toBe(999);
    // Provenance: produced_by is the SDK+adapter tag; pricing_version is the pricing entry.
    expect(step?.producedBy).toBe('test-cost-backend@1.0.0');
    // pricing_version records WHICH effective-dated entry computed the cost (`<model>@<effectiveFrom>`).
    expect(step?.pricingVersion).toBe('gpt-4.1-mini@2025-04-14');
  });
});

describe('pricing-version provenance is PERSISTED + a FALLBACK step is distinguishable', () => {
  it('a KNOWN-model step records pricing_version=`<model>@<effectiveFrom>`', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(
      tdb,
      new CostBackend({ authMode: 'api-key' }),
      spec('known', 'claude-haiku-4-5'),
      {},
    );
    const step = await stepRow(res.runId);
    // claude-haiku-4-5's only entry is effective 2025-10-15 → the recorded provenance tag.
    expect(step?.pricingVersion).toBe('claude-haiku-4-5@2025-10-15');
  });

  it('a FALLBACK-priced (UNKNOWN model) step records pricing_version=FALLBACK — distinguishable', async () => {
    const tdb = forTenant(db, TENANT_A);
    // An unknown model has NO registry entry → the visible FALLBACK price + the FALLBACK provenance tag.
    const res = await runAgent(
      tdb,
      new CostBackend({ authMode: 'api-key' }),
      spec('fallback', 'totally-unknown-model-zzz'),
      {},
    );
    const step = await stepRow(res.runId);
    expect(step?.pricingVersion).toBe('FALLBACK');
    // It is NOW distinguishable from a known-priced step in the ledger (the auditability is the point).
    expect(step?.pricingVersion).not.toContain('@');
    // The cost is still the visible non-zero fallback (never silently 0).
    expect(Number(step?.costUsd)).toBeGreaterThan(0);
  });
});

describe('computed-vs-provider reconciliation + drift flag', () => {
  it('provider cost CLOSE to computed → recorded, NO drift', async () => {
    const tdb = forTenant(db, TENANT_A);
    // computed = 0.0012; provider 0.00121 is within 5%.
    const res = await runAgent(
      tdb,
      new CostBackend({ authMode: 'api-key', providerCostUsd: 0.00121 }),
      spec('close'),
      {},
    );
    const step = await stepRow(res.runId);
    expect(Number(step?.providerCostUsd)).toBeCloseTo(0.00121, 12);
    expect(step?.costDrift).toBe(false);
  });

  it('provider cost FAR from computed → drift flag TRIPS (a real divergence, not a tautology)', async () => {
    const tdb = forTenant(db, TENANT_A);
    // computed = 0.0012; provider 0.05 is ~40x — well beyond the threshold.
    const res = await runAgent(
      tdb,
      new CostBackend({ authMode: 'api-key', providerCostUsd: 0.05 }),
      spec('drift'),
      {},
    );
    const step = await stepRow(res.runId);
    expect(Number(step?.providerCostUsd)).toBe(0.05);
    expect(step?.costDrift).toBe(true);
    // The run header rolls the drift up.
    const header = await runRow(res.runId);
    expect(header?.costDrift).toBe(true);
  });

  it('NO provider cost reported (OpenAI) → provider_cost_usd is NULL (never fabricated), no drift', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(tdb, new CostBackend({ authMode: 'api-key' }), spec('noprov'), {});
    const step = await stepRow(res.runId);
    expect(step?.providerCostUsd).toBeNull();
    expect(step?.costDrift).toBe(false);
    const header = await runRow(res.runId);
    // The run rollup provider cost is NULL when NO step reported one.
    expect(header?.providerCostUsd).toBeNull();
  });
});

describe('subscription-run ledger semantics — billed=0 + attributed cost', () => {
  it('a SUBSCRIPTION step records billed_cost_usd=0 but a NON-ZERO attributed (computed) cost', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(
      tdb,
      new CostBackend({
        authMode: 'subscription-oauth-official-harness',
        providerCostUsd: 0.0012,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      }),
      // Anthropic is the subscription backend; use one of its models for a realistic price.
      spec('sub', 'claude-haiku-4-5'),
      {},
    );
    const step = await stepRow(res.runId);
    // Billed is 0 on a subscription run (draws subscription limits, no per-token billing).
    expect(Number(step?.billedCostUsd)).toBe(0);
    // ...but the ATTRIBUTED (computed) cost is non-zero — the value metric is still recorded.
    expect(Number(step?.costUsd)).toBeGreaterThan(0);
    expect(step?.authMode).toBe('subscription-oauth-official-harness');
    // The run header rolls up billed=0 with a non-zero computed cost.
    const header = await runRow(res.runId);
    expect(Number(header?.billedCostUsd)).toBe(0);
    expect(Number(header?.costUsd)).toBeGreaterThan(0);
  });

  it('an API-KEY step records billed_cost_usd = the computed cost (NOT 0)', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(tdb, new CostBackend({ authMode: 'api-key' }), spec('apikey'), {});
    const step = await stepRow(res.runId);
    const computed = Number(step?.costUsd);
    expect(computed).toBeGreaterThan(0);
    // billed == computed for an api-key run.
    expect(Number(step?.billedCostUsd)).toBeCloseTo(computed, 12);
  });

  it('a CODEX-SUBSCRIPTION step (codex-subscription-oauth) records billed_cost_usd=0 too', async () => {
    // The codex ChatGPT-OAuth subscription draws the subscription, not the API — isSubscriptionBilling
    // must treat it as billed=$0 exactly like the anthropic official-harness path, while still recording
    // the attributed (computed) cost as a value metric. (Fail-the-fix: if isSubscriptionBilling had not
    // been extended to codex-subscription-oauth, billed would equal the non-zero computed cost here.)
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(
      tdb,
      new CostBackend({
        authMode: 'codex-subscription-oauth',
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      }),
      // gpt-5.5 is the codex subscription model (a real registry entry → a non-zero computed cost).
      spec('codex-sub', 'gpt-5.5'),
      {},
    );
    const step = await stepRow(res.runId);
    expect(Number(step?.billedCostUsd)).toBe(0); // billed $0 on the subscription
    expect(Number(step?.costUsd)).toBeGreaterThan(0); // attributed value metric still recorded
    expect(step?.authMode).toBe('codex-subscription-oauth');
    const header = await runRow(res.runId);
    expect(Number(header?.billedCostUsd)).toBe(0);
    expect(Number(header?.costUsd)).toBeGreaterThan(0);
  });
});

describe('run→tenant cost roll-up (tenant-scoped via TenantDb)', () => {
  it('the run header cost is the journal roll-up; rollupRunCost matches', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(
      tdb,
      new CostBackend({ authMode: 'api-key', providerCostUsd: 0.0013 }),
      spec('rollup'),
      {},
    );
    const header = await runRow(res.runId);
    const computed = computeCost('gpt-4.1-mini', { inputTokens: 1000, outputTokens: 500 }).costUsd;
    expect(Number(header?.costUsd)).toBeCloseTo(computed, 12);

    const ru = await rollupRunCost(tdb, res.runId);
    expect(ru.computedCostUsd).toBeCloseTo(computed, 12);
    expect(ru.providerCostUsd).toBeCloseTo(0.0013, 12);
    expect(ru.billedCostUsd).toBeCloseTo(computed, 12);
  });

  it('rollupTenantCost sums a tenant’s runs AND is tenant-scoped (never sees another tenant)', async () => {
    const tA = forTenant(db, TENANT_A);
    const tB = forTenant(db, TENANT_B);
    // Two runs for A, one for B.
    await runAgent(tA, new CostBackend({ authMode: 'api-key' }), spec('a1'), {});
    await runAgent(tA, new CostBackend({ authMode: 'api-key' }), spec('a2'), {});
    await runAgent(tB, new CostBackend({ authMode: 'api-key' }), spec('b1'), {});

    const per = computeCost('gpt-4.1-mini', { inputTokens: 1000, outputTokens: 500 }).costUsd;
    const aTotal = await rollupTenantCost(tA);
    const bTotal = await rollupTenantCost(tB);
    // A has two runs (each one step) → 2x; B has one → 1x. The predicate is structural: A never sees B.
    expect(aTotal.computedCostUsd).toBeCloseTo(per * 2, 9);
    expect(bTotal.computedCostUsd).toBeCloseTo(per * 1, 9);
  });

  it('rollupTenantCost: provider null when NO step reported a provider cost (OpenAI-only tenant)', async () => {
    const tA = forTenant(db, TENANT_A);
    await runAgent(tA, new CostBackend({ authMode: 'api-key' }), spec('noprovider'), {});
    const total = await rollupTenantCost(tA);
    expect(total.providerCostUsd).toBeNull();
  });

  it('a SUBSCRIPTION tenant: rollup billed=0 but computed > 0 (value metric retained)', async () => {
    const tA = forTenant(db, TENANT_A);
    await runAgent(
      tA,
      new CostBackend({ authMode: 'subscription-oauth-official-harness' }),
      spec('subtenant', 'claude-haiku-4-5'),
      {},
    );
    const total = await rollupTenantCost(tA);
    expect(total.billedCostUsd).toBe(0);
    expect(total.computedCostUsd).toBeGreaterThan(0);
  });
});

describe('cross-tenant: rollupRunCost carries the tenant predicate (cannot read a foreign run)', () => {
  it('rollupRunCost for B over A’s runId returns an empty roll-up (predicate, not a leak)', async () => {
    const tA = forTenant(db, TENANT_A);
    const res = await runAgent(tA, new CostBackend({ authMode: 'api-key' }), spec('foreign'), {});
    // B asks for A's runId — the tenant predicate filters it out → an all-zero roll-up.
    const tB = forTenant(db, TENANT_B);
    const ru = await rollupRunCost(tB, res.runId);
    expect(ru.computedCostUsd).toBe(0);
    expect(ru.billedCostUsd).toBe(0);
    expect(ru.providerCostUsd).toBeNull();
  });
});
