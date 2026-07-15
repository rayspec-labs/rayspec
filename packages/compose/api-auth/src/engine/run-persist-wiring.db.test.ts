/**
 * Output-persistence WIRING on the REAL composed HTTP path (DB-backed, fake backend — NO LLM).
 *
 * The platform-level persist acceptance (run-core-persist.db.test.ts) drives `runAgent` DIRECTLY. This
 * suite closes the gap it cannot see: it deploys a fixture spec whose `api` agent-action declares a
 * `persistTo`, mounts it through the ACTUAL declared-route registration, and drives a REAL HTTP request —
 * so the whole shipping chain is exercised end to end:
 *
 *   register-declared-routes (threads `action.persistTo`) → executeAgentRun (assembles `persistOpts`
 *   from the engine's `productTables`) → runAgent (writes the validated output).
 *
 * The row landing in the store after a real `POST` is the ground truth. A regression that dropped
 * `persistTo` at ANY of those hops would leave this RED — the persist would silently no-op while the run
 * still returned 200 (the exact false-green the direct-runAgent test cannot catch). Verified fail-the-fix:
 * reverting the `action.persistTo` pass-through in register-declared-routes makes the row absent → RED.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run.
 */
import type { AgentSpec, Backend, RunContext, RunResult } from '@rayspec/core';
import type { RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let wiringTestsRan = 0;

/** The validated structured output the fake agent produces — maps 1:1 to the store's columns. */
const OUTPUT = { title: 'Q3 review', score: 7, verified: true, details: { source: 'report' } };

/**
 * A fake backend that ALWAYS returns a COMPLETED run carrying `OUTPUT` as its structured output and
 * journals one ok step (so the run header/journal persist exactly as a real off-request run would).
 */
class PersistWiringBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    await ctx.onEvent?.({ type: 'run_started', runId: ctx.runId } as never);
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText: 'done' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      model: spec.model,
      producedBy: 'persist-wiring-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    await ctx.onEvent?.({
      type: 'run_completed',
      runId: ctx.runId,
      status: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as never);
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText: 'done',
      output: OUTPUT,
      error: null,
      errorClass: null,
      conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'done' }] }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

const agentSpec: AgentSpec = {
  name: 'fact_extractor',
  instructions: 'extract the facts',
  model: 'gpt-4o-mini',
  input: '',
  tools: [],
  outputSchema: { name: 'Facts', schema: { type: 'object' } },
  maxTurns: 8,
};

/** The declared deployment: a store + an agent-action route that persists the run's output into it. */
const engineSpec: RaySpec = {
  version: '1.0',
  metadata: { name: 'persist-wiring-test' },
  stores: [
    {
      name: 'extracted_facts',
      columns: [
        { name: 'title', type: 'text', nullable: false, unique: false },
        { name: 'score', type: 'integer', nullable: true, unique: false },
        { name: 'verified', type: 'boolean', nullable: true, unique: false },
        { name: 'details', type: 'jsonb', nullable: true, unique: false },
      ],
      foreignKeys: [],
    },
  ],
  api: [
    {
      method: 'POST',
      path: '/extract',
      action: { kind: 'agent', agent: 'fact-extractor', persistTo: 'extracted_facts' },
    },
  ],
  agents: [],
  tooling: [],
  triggers: [],
  handlers: [],
  extensions: [],
};

const registry: AgentRegistry = new Map<string, AgentRegistryEntry>([
  ['fact-extractor', { spec: agentSpec, backend: new PersistWiringBackend(), tools: [] }],
]);

describe.skipIf(!hasDb)(
  'persistTo wiring on the composed HTTP path (register-declared-routes → executeAgentRun → runAgent)',
  () => {
    let h: Harness;

    beforeAll(async () => {
      h = await createHarness({
        engineSpec,
        agentRegistry: registry,
        schema: 'rayspec_test_persist_wiring',
      });
    });
    beforeEach(async () => {
      await h.reset();
    });
    afterAll(async () => {
      await h.close();
    });

    /** A principal (register → org → switch) — the default scopes include agent:run + store:write. */
    async function principal(
      email: string,
      orgName: string,
    ): Promise<{ orgId: string; token: string }> {
      const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
        body: { email, password: 'a-long-enough-password' },
      });
      const t0 = (await reg.json()).accessToken as string;
      const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
        body: { name: orgName },
        headers: { authorization: `Bearer ${t0}` },
      });
      const orgId = (await orgRes.json()).id as string;
      const switchRes = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
        headers: { authorization: `Bearer ${t0}` },
      });
      const token = (await switchRes.json()).accessToken as string;
      return { orgId, token };
    }

    async function factRows(orgId: string): Promise<Record<string, unknown>[]> {
      return (await h.db.$client.unsafe(
        'SELECT title, score, verified, details, tenant_id::text AS tenant_id, created_by FROM extracted_facts WHERE tenant_id = $1',
        [orgId],
      )) as unknown as Record<string, unknown>[];
    }

    it('a real POST to the declared agent-action route persists the run output as a tenant-scoped row', async () => {
      wiringTestsRan += 1;
      const { orgId, token } = await principal('persist-wiring-a@example.com', 'PersistWiringOrgA');

      const res = await jsonRequest(h.app, 'POST', '/extract', {
        body: { input: 'a transcript' },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      expect(res.status).toBe(200);
      const run = await res.json();
      expect(run.status).toBe('completed');

      // GROUND TRUTH: the row LANDED through the real wiring. Drop persistTo at any hop and this is 0 rows.
      const rows = await factRows(orgId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe('Q3 review');
      expect(Number(rows[0]?.score)).toBe(7);
      expect(rows[0]?.verified).toBe(true);
      expect(rows[0]?.details).toEqual({ source: 'report' });
      // Tenant-scoped through the store-facade chokepoint; created_by unset (uniform sync+durable posture).
      expect(rows[0]?.tenant_id).toBe(orgId);
      expect(rows[0]?.created_by ?? null).toBeNull();
    });

    it('CROSS-TENANT: the persisted row is only visible to the run’s own tenant', async () => {
      wiringTestsRan += 1;
      const a = await principal('persist-wiring-b@example.com', 'PersistWiringOrgB');
      const b = await principal('persist-wiring-c@example.com', 'PersistWiringOrgC');

      const res = await jsonRequest(h.app, 'POST', '/extract', {
        body: { input: 'a transcript' },
        headers: { authorization: `Bearer ${a.token}`, accept: 'application/json' },
      });
      expect(res.status).toBe(200);

      expect(await factRows(a.orgId)).toHaveLength(1);
      expect(await factRows(b.orgId)).toHaveLength(0);
    });
  },
);

/** Ran-guard: hard-fail a REQUIRED run (CI / opt-in) that silently skipped the wiring proof. */
describe('persistTo wiring — ran-guard (no silent CI skip)', () => {
  it('ran the wiring proofs when the DB is required', () => {
    if (dbRequired) expect(wiringTestsRan).toBeGreaterThan(0);
    else expect(true).toBe(true);
  });
});
