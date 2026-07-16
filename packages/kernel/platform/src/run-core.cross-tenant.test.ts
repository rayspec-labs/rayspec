/**
 * run-core CROSS-TENANT regression — the security boundary test.
 *
 * This is the test the security critique proved necessary: the lookup() tenant predicate
 * alone is NOT sufficient. A B-context replay of A's runId would otherwise produce
 * replay=true + a cache-miss (predicate now filters A's step out) + a LIVE re-run whose
 * header upsert silently no-ops against A's runs row (PK + onConflictDoNothing) and whose
 * conversation is never persisted — leaving A's header authoritative for later reads of R
 * (a stored cross-tenant read leak through the runs table).
 *
 * The run-HEADER pre-check in runAgent closes it: a foreign runId is rejected as a
 * cache-miss BEFORE backend.run, so the model never runs and A's row is untouched.
 *
 * It is RED against the pre-fix run-core (the model runs, A's row stays authoritative) and
 * GREEN only with the lookup predicate + run-header pre-check together.
 */
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';
import { schema } from '@rayspec/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from './run-core.js';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
  TENANT_B,
} from './test-support/test-db.js';

const db = makeTestDb();

const SECRET_A = 'SECRET_A_top_secret_value_42';
const RUN_ID = 'cross-tenant-run-R';
const IDEM_KEY = 'llm:extract';

const spec: AgentSpec = {
  name: 'extract',
  instructions: 'extract fields',
  model: 'gpt-4.1-mini',
  input: 'tenant B input',
  tools: [],
  maxTurns: 8,
};

/**
 * Mirrors a real adapter (e.g. Pi): on replay it consults the journal first and, on a
 * cache HIT, returns the cached output without re-calling the model; on a cache MISS it
 * falls through to a LIVE model call and journals a fresh step.
 *
 *  - `entered`     — run() was invoked at all (false ⇒ rejected by the pre-check).
 *  - `modelCalled` — the live model path executed (the actual cross-tenant leak vector).
 */
class TripwireBackend implements Backend {
  readonly id = 'openai' as const;
  entered = false;
  modelCalled = false;

  async resolveAuth() {
    return 'api-key' as const;
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    this.entered = true;
    if (ctx.replay) {
      const cached = await ctx.journal.lookup(IDEM_KEY);
      if (cached) {
        const co = cached.output as { finalText?: string } | null;
        return this.completed(ctx, co?.finalText ?? '', 0);
      }
    }
    // LIVE path — on a cross-tenant replay the pre-check must prevent us reaching here.
    this.modelCalled = true;
    const finalText = `B re-ran the model for ${spec.input}`;
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: IDEM_KEY,
      inputHash: 'hashB',
      output: { finalText },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    return this.completed(ctx, finalText, 1);
  }

  private completed(ctx: RunContext, finalText: string, stepCount: number): RunResult {
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText,
      output: null,
      error: null,
      errorClass: null,
      conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: finalText }] }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount,
    };
  }
}

beforeAll(async () => {
  await resetRunSchema(db);
});

beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A, TENANT_B);

  // Seed tenant A's journaled step + run header + conversation for runId R, key K.
  await db.insert(schema.journalSteps).values({
    runId: RUN_ID,
    tenantId: TENANT_A,
    backend: 'openai',
    type: 'llm',
    idempotencyKey: IDEM_KEY,
    inputHash: 'hashA',
    output: { finalText: SECRET_A } as never,
    inputTokens: '10',
    outputTokens: '5',
    totalTokens: '15',
    costUsd: '0.0001',
    latencyMs: '1',
    status: 'ok',
    authMode: 'api-key',
  });
  await db.insert(schema.runs).values({
    runId: RUN_ID,
    tenantId: TENANT_A,
    backend: 'openai',
    authMode: 'api-key',
    agentName: 'extract',
    model: 'gpt-4.1-mini',
    status: 'completed',
    finalText: SECRET_A,
    output: { secret: SECRET_A } as never,
    costUsd: '0.0001',
  });
  await db.insert(schema.conversationItems).values({
    runId: RUN_ID,
    tenantId: TENANT_A,
    seq: '0',
    role: 'assistant',
    content: SECRET_A,
  });
});

afterAll(async () => {
  await db.$client.end();
});

describe('run-core cross-tenant replay rejection', () => {
  it('rejects a B-context replay of A’s runId BEFORE the model runs and never leaks SECRET_A', async () => {
    // Capture A's runs row exactly as seeded (byte-for-byte baseline).
    const before = await db.select().from(schema.runs).where(eq(schema.runs.runId, RUN_ID));
    expect(before).toHaveLength(1);
    const aRowBefore = before[0];

    const backend = new TripwireBackend();
    const result = await runAgent(forTenant(db, TENANT_B), backend, spec, {
      replayRunId: RUN_ID,
    });

    // 1) backend.run was NEVER entered (rejected before backend.run), so the model
    //    could not have been called.
    expect(backend.entered).toBe(false);
    expect(backend.modelCalled).toBe(false);

    // 2) The result is a rejection (cache-miss / error), not a success carrying A's data.
    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain(SECRET_A);

    // 3) Tenant B sees NO runs row and NO conversation row for R.
    const bRuns = await db.select().from(schema.runs).where(eq(schema.runs.tenantId, TENANT_B));
    expect(bRuns).toHaveLength(0);
    const bConv = await db
      .select()
      .from(schema.conversationItems)
      .where(eq(schema.conversationItems.tenantId, TENANT_B));
    expect(bConv).toHaveLength(0);
    const bSteps = await db
      .select()
      .from(schema.journalSteps)
      .where(eq(schema.journalSteps.tenantId, TENANT_B));
    expect(bSteps).toHaveLength(0);

    // 4) A's runs row is byte-for-byte unchanged.
    const after = await db.select().from(schema.runs).where(eq(schema.runs.runId, RUN_ID));
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(aRowBefore);
    expect(after[0]?.tenantId).toBe(TENANT_A);
    expect(after[0]?.finalText).toBe(SECRET_A);

    // 5) SECRET_A never appears in any tenant-B-visible journal/conversation row.
    const allBVisible = JSON.stringify([...bRuns, ...bConv, ...bSteps]);
    expect(allBVisible).not.toContain(SECRET_A);
  });

  it('a same-tenant replay of A’s runId still returns A’s cached step (no false rejection)', async () => {
    const backend = new TripwireBackend();
    const result = await runAgent(forTenant(db, TENANT_A), backend, spec, {
      replayRunId: RUN_ID,
    });
    // Same tenant: the pre-check passes, run() is entered, the journal lookup HITS, and
    // the model is NOT re-called (returns A's cached step to A).
    expect(backend.entered).toBe(true);
    expect(backend.modelCalled).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe(SECRET_A);
  });
});
