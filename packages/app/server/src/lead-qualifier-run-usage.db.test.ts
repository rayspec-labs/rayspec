/**
 * A durable agent run journals the token usage its backend reports, and that usage is in the journal
 * once the run has ENDED — not when its tool's effect first becomes visible.
 *
 * The lead-qualifier example boots through the real server entrypoint on a throwaway database with a
 * real DBOS launch, exactly as its acceptance suite does, with a fake Backend shaped like a real
 * tool-calling run: a first model response that calls `save_qualification`, the tool dispatched
 * through the unchanged `ctx.dispatchTool` chokepoint, then the model's CLOSING turn — and only after
 * that turn has returned does the backend journal its model calls, one `llm` step per response, each
 * with its own usage. That ordering is the OpenAI adapter's: it journals from the finished run.
 *
 * The run commits each statement as it is made, so between the tool call and the closing turn the lead
 * already reads `qualified` while the run's journal holds ONE step — the tool's, with no tokens. The
 * closing turn is held open here until the test lets it go, so that window is pinned rather than raced:
 *
 *   (a) in the window, the header is `running` and the journal carries the tool step and nothing else;
 *   (b) the usage of an ended run is the backend's, step by step and summed, with the cost computed
 *       from the pricing registry, billed in full for an api-key run, and rolled up onto the header;
 *   (c) a run that does not end is refused by the reader, never reported as a run that used nothing.
 *
 * Skips without DATABASE_URL; the ran-guard hard-fails a REQUIRED run.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentSpec,
  type Backend,
  type BackendId,
  computeCost,
  type RunContext,
  type RunResult,
  type Usage,
} from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';
import { readEndedAgentRunUsage } from './live-smoke-run-usage.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, '../../../../examples/lead-qualifier/lead-qualifier.rayspec.yaml');

const SUITE_DB = `rayspec_lead_qualifier_usage_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-00000000c901';

// Ran-guard: skipIf(!baseUrl) must never let a REQUIRED run (CI / RAYSPEC_REQUIRE_DB_TESTS) read
// green after silently skipping.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let usageTestsRan = 0;

/** The model the example's `qualifier` agent declares — the key its steps are priced under. */
const MODEL = 'gpt-4o-mini';
/** The usage of the two model responses of one run: the one that calls the tool, and the closing one. */
const TOOL_CALL_TURN: Usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };
const CLOSING_TURN: Usage = { inputTokens: 180, outputTokens: 20, totalTokens: 200 };
const RUN_USAGE: Usage = { inputTokens: 300, outputTokens: 50, totalTokens: 350 };

/** The closing turn of each run in flight, by run id: resolved when the test lets the run finish. */
const closingTurns = new Map<string, () => void>();

/** Let the held run finish. Throws when the run is not being held — a test must not wait on nothing. */
function releaseClosingTurn(runId: string): void {
  const release = closingTurns.get(runId);
  if (!release) throw new Error(`run ${runId} is not holding a closing turn`);
  closingTurns.delete(runId);
  release();
}

/**
 * A fake Backend with the shape of a real tool-calling run. It reports what a provider would: usage
 * per model response, journaled once the run's last response is in.
 */
function usageReportingBackend(): Backend {
  return {
    id: 'openai',
    resolveAuth: async () => 'api-key',
    run: async (spec: AgentSpec, ctx: RunContext): Promise<RunResult> => {
      const lead = JSON.parse(spec.input) as { id?: unknown };
      if (typeof lead.id !== 'string') {
        throw new Error(`run input did not carry the lead: ${spec.input}`);
      }
      if (!ctx.dispatchTool) {
        throw new Error('ctx.dispatchTool is not wired — the declared tool never reached the run.');
      }
      const closingTurn = new Promise<void>((r) => closingTurns.set(ctx.runId, r));
      // First model response: the tool call. Its effect and its journal step commit here.
      const res = await ctx.dispatchTool('save_qualification', {
        lead_id: lead.id,
        tier: 'mid_market',
        fit_score: 64,
        owning_queue: 'inside_sales',
        rationale: 'A mid-sized team with a stated rollout.',
      });
      if (res.kind !== 'tool_data') {
        throw new Error(`save_qualification dispatch failed: ${JSON.stringify(res)}`);
      }
      // Second model response: the closing turn, still out until the test releases it.
      await closingTurn;
      const authMode = ctx.authMode ?? 'api-key';
      const turns = [TOOL_CALL_TURN, CLOSING_TURN];
      for (let i = 0; i < turns.length; i++) {
        const usage = turns[i] as Usage;
        await ctx.journal.record({
          type: 'llm',
          idempotencyKey: `llm:${spec.name}:${i}`,
          inputHash: `usage-test:${lead.id}:${i}`,
          output: { responseIndex: i, isFinal: i === turns.length - 1 },
          usage,
          // A number the ledger must NOT take over: the journal computes the cost itself.
          costUsd: 999,
          model: spec.model,
          producedBy: 'usage-reporting-backend',
          latencyMs: 1,
          status: 'ok',
          authMode,
        });
      }
      return {
        runId: ctx.runId,
        backend: 'openai',
        authMode,
        status: 'completed',
        finalText: `qualified ${lead.id}`,
        output: null,
        error: null,
        errorClass: null,
        conversation: [],
        usage: RUN_USAGE,
        costUsd: 999,
        stepCount: 3,
      };
    },
  };
}

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('a durable agent run journals the usage its backend reports', () => {
  let server: BootedServer | undefined;
  let appDbUrl = '';
  let dbosSysDb = '';
  let tokenA = '';
  let unregisterTables: (() => void) | undefined;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'DBOS_SYSTEM_DATABASE_URL',
  ] as const;

  async function drop(admin: postgres.Sql): Promise<void> {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);
    dbosSysDb = `${SUITE_DB}_dbos_sys`;
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await drop(admin);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV) saved[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'lead-qualifier-usage-pepper';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8819';
    process.env.RAYSPEC_SPEC_PATH = SPEC_PATH;
    delete process.env.DBOS_SYSTEM_DATABASE_URL; // exercise the derived <appdb>_dbos_sys path

    const config = loadServerConfig();
    server = await assembleServer(config, {
      registerProductTables: (tables) => {
        unregisterTables = registerScopedTables([...tables.values()]);
      },
      agentBackendsFactory: () =>
        new Map<BackendId, Backend>([['openai', usageReportingBackend()]]),
    });

    const client = postgres(appDbUrl, { max: 2 });
    try {
      await client.unsafe(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, 'LeadUsage', 'lead-usage')`,
        [TENANT],
      );
    } finally {
      await client.end();
    }
    tokenA = await tokenFor(TENANT);
  }, 180_000);

  afterAll(async () => {
    // A run a failed arm left held must not keep the worker's shutdown waiting on it.
    for (const release of closingTurns.values()) release();
    closingTurns.clear();
    await server?.close();
    unregisterTables?.();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await drop(admin);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  async function tokenFor(tenant: string): Promise<string> {
    const email = `lead-${tenant.slice(-4)}-${Date.now()}@example.com`;
    const reg = await server!.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-long-enough-password' }),
    });
    expect([200, 201]).toContain(reg.status);
    const client = postgres(appDbUrl, { max: 2 });
    try {
      const rows = (await client.unsafe('SELECT id FROM users WHERE email = $1', [
        email,
      ])) as unknown as Array<{ id: string }>;
      await client.unsafe(
        `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
        [tenant, rows[0]!.id],
      );
    } finally {
      await client.end();
    }
    const sw = await server!.app.request(`/v1/orgs/${tenant}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${(await reg.json()).accessToken}` },
    });
    expect(sw.status).toBe(200);
    return (await sw.json()).accessToken as string;
  }

  /** POST one lead and return its id and the id of the durable run that qualifies it. */
  async function postLead(company: string): Promise<{ id: string; runId: string }> {
    const res = await server!.app.request('/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        company,
        contact_email: 'ops@example.com',
        message: 'We want to roll this out to the whole operations team.',
        headcount: 240,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    expect(typeof created.run_id).toBe('string');
    return { id: String(created.id), runId: String(created.run_id) };
  }

  /** Poll GET /leads/{id} until the tool's write is served — the run is then held at its closing turn. */
  async function waitForQualified(id: string): Promise<void> {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const res = await server!.app.request(`/leads/${id}`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      if (res.status === 200) {
        const row = (await res.json()) as Record<string, unknown>;
        if (row.status === 'qualified') return;
      }
      if (Date.now() > deadline)
        throw new Error(`lead ${id} was not qualified before the deadline`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  interface StepRow {
    type: string;
    idempotency_key: string;
    input_tokens: string;
    output_tokens: string;
    total_tokens: string;
    cost_usd: string;
    billed_cost_usd: string;
    provider_cost_usd: string | null;
    pricing_version: string | null;
    auth_mode: string;
    status: string;
  }

  async function withClient<T>(fn: (client: postgres.Sql) => Promise<T>): Promise<T> {
    const client = postgres(appDbUrl, { max: 1 });
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  function stepsOf(client: postgres.Sql, runId: string): Promise<StepRow[]> {
    return client.unsafe(
      `SELECT type, idempotency_key, input_tokens, output_tokens, total_tokens, cost_usd,
              billed_cost_usd, provider_cost_usd, pricing_version, auth_mode, status
         FROM journal_steps WHERE run_id = $1 ORDER BY type, idempotency_key`,
      [runId],
    ) as unknown as Promise<StepRow[]>;
  }

  async function headerOf(
    client: postgres.Sql,
    runId: string,
  ): Promise<{ status: string; cost_usd: string; billed_cost_usd: string } | undefined> {
    const rows = (await client.unsafe(
      'SELECT status, cost_usd, billed_cost_usd FROM runs WHERE run_id = $1',
      [runId],
    )) as unknown as Array<{ status: string; cost_usd: string; billed_cost_usd: string }>;
    return rows[0];
  }

  const maybe = baseUrl ? it : it.skip;

  maybe(
    'a run with a tool call journals each model response with its usage and cost, read once the run has ended',
    async () => {
      usageTestsRan += 1;
      const { id, runId } = await postLead('Usage Works');
      await waitForQualified(id);

      await withClient(async (client) => {
        // (a) The tool's effect is served, and the run has not ended: its closing turn is still out.
        // The journal holds the tool step alone, and a tool step carries no tokens.
        expect((await headerOf(client, runId))?.status).toBe('running');
        const during = await stepsOf(client, runId);
        expect(during.map((s) => s.type)).toEqual(['tool']);
        expect(Number(during[0]?.total_tokens)).toBe(0);
        expect(Number(during[0]?.cost_usd)).toBe(0);

        // (b) Let the closing turn return a moment from now, and read the usage the way a caller
        // does. The reader is asked while the run is still held, so it only passes by waiting for
        // the run to end.
        const release = setTimeout(() => releaseClosingTurn(runId), 400);
        let usage: Awaited<ReturnType<typeof readEndedAgentRunUsage>>;
        try {
          usage = await readEndedAgentRunUsage(client, runId, { timeoutMs: 60_000, pollMs: 50 });
        } finally {
          clearTimeout(release);
        }

        const toolCallCost = computeCost(MODEL, TOOL_CALL_TURN).costUsd;
        const closingCost = computeCost(MODEL, CLOSING_TURN).costUsd;
        expect(toolCallCost).toBeGreaterThan(0);
        expect(closingCost).toBeGreaterThan(0);

        expect(usage.status).toBe('completed');
        expect(usage.steps).toBe(3);
        expect(usage.llmSteps).toBe(2);
        expect(usage.inputTokens).toBe(RUN_USAGE.inputTokens);
        expect(usage.outputTokens).toBe(RUN_USAGE.outputTokens);
        expect(usage.totalTokens).toBe(RUN_USAGE.totalTokens);
        expect(usage.costUsd).toBeCloseTo(toolCallCost + closingCost, 12);
        // An api-key run is billed what it cost.
        expect(usage.billedCostUsd).toBeCloseTo(toolCallCost + closingCost, 12);

        // Step by step: each model response keeps its OWN usage and its own registry cost — never
        // the 999 the backend claimed — and the tool step stays at zero.
        const steps = await stepsOf(client, runId);
        expect(steps.map((s) => s.type)).toEqual(['llm', 'llm', 'tool']);
        const [first, second, tool] = steps;
        expect(Number(first?.input_tokens)).toBe(TOOL_CALL_TURN.inputTokens);
        expect(Number(first?.output_tokens)).toBe(TOOL_CALL_TURN.outputTokens);
        expect(Number(first?.total_tokens)).toBe(TOOL_CALL_TURN.totalTokens);
        expect(Number(first?.cost_usd)).toBeCloseTo(toolCallCost, 12);
        expect(Number(first?.billed_cost_usd)).toBeCloseTo(toolCallCost, 12);
        expect(Number(second?.input_tokens)).toBe(CLOSING_TURN.inputTokens);
        expect(Number(second?.output_tokens)).toBe(CLOSING_TURN.outputTokens);
        expect(Number(second?.total_tokens)).toBe(CLOSING_TURN.totalTokens);
        expect(Number(second?.cost_usd)).toBeCloseTo(closingCost, 12);
        expect(Number(second?.billed_cost_usd)).toBeCloseTo(closingCost, 12);
        for (const llm of [first, second]) {
          expect(llm?.status).toBe('ok');
          expect(llm?.auth_mode).toBe('api-key');
          expect(llm?.provider_cost_usd).toBeNull();
          expect(llm?.pricing_version).toBe(computeCost(MODEL, TOOL_CALL_TURN).pricingVersion);
          expect(llm?.pricing_version).not.toBe('FALLBACK');
        }
        expect(Number(tool?.total_tokens)).toBe(0);
        expect(Number(tool?.cost_usd)).toBe(0);

        // The header's cost is the roll-up of those steps.
        const header = await headerOf(client, runId);
        expect(header?.status).toBe('completed');
        expect(Number(header?.cost_usd)).toBeCloseTo(toolCallCost + closingCost, 12);
        expect(Number(header?.billed_cost_usd)).toBeCloseTo(toolCallCost + closingCost, 12);
      });
    },
    150_000,
  );

  maybe(
    'a run that has not ended is refused by the reader, and so is a run that does not exist',
    async () => {
      usageTestsRan += 1;
      const { id, runId } = await postLead('Still Running');
      await waitForQualified(id);

      await withClient(async (client) => {
        // (c) The closing turn is held: the reader gives up at its deadline and says where the run
        // stood, instead of answering with the zero-token tool step.
        await expect(
          readEndedAgentRunUsage(client, runId, { timeoutMs: 300, pollMs: 50 }),
        ).rejects.toThrow(/did not end before the deadline \(header status: running\)/);
        await expect(
          readEndedAgentRunUsage(client, 'no-such-run', { timeoutMs: 100, pollMs: 50 }),
        ).rejects.toThrow(/header status: <no run row>/);

        // Released, the same run reads complete.
        releaseClosingTurn(runId);
        const usage = await readEndedAgentRunUsage(client, runId, {
          timeoutMs: 60_000,
          pollMs: 50,
        });
        expect(usage.status).toBe('completed');
        expect(usage.totalTokens).toBe(RUN_USAGE.totalTokens);
      });
    },
    150_000,
  );
});

// The un-skippable ran-guard: a REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) run that lost DATABASE_URL
// would otherwise SILENTLY skip this suite and still read GREEN.
describe('durable agent run usage — ran-guard (must not silently skip in CI)', () => {
  it('both arms actually ran when the DB was required', () => {
    if (dbRequired) expect(usageTestsRan).toBe(2);
    else expect(dbRequired).toBe(false);
  });
});
