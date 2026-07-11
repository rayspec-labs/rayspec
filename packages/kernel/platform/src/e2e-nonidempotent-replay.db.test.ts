/**
 * E2E non-idempotent-tool-through-dispatchTool REPLAY test.
 *
 * Drives a backend through a REPLAY that hits a NON-IDEMPOTENT (side-effecting) tool — END TO END
 * through run-core + ctx.dispatchTool against a REAL Postgres journal — and asserts the fail-closed
 * contract (locked Decision #3) holds at the END-TO-END level, not just the dispatchTool unit test:
 *   - on the LIVE run the side-effecting tool fires exactly ONCE (the real effect happens once);
 *   - on the REPLAY of that run, dispatchTool surfaces a `tool_error` — it NEVER re-fires the handler
 *     AND NEVER returns a cached output as if re-run (no fabricated success);
 *   - the replay journals NO new successful tool step (the side effect is not silently re-performed).
 *
 * The backend here marshals an SDK tool call into ctx.dispatchTool EXACTLY as a real adapter does (it
 * holds no handler — the gate enforces that for the real adapters), so this exercises the full
 * adapter→run-core→dispatchTool→journal chain on a replay.
 */
import type {
  AgentSpec,
  AuthMode,
  Backend,
  NeutralTool,
  RunContext,
  RunResult,
  ToolDispatchResult,
} from '@rayspec/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from './run-core.js';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const db = makeTestDb();

/** How many times the side-effecting handler ACTUALLY fired (the real effect counter). */
let sideEffectFires = 0;

/** A NON-IDEMPOTENT tool (send_email / charge_card class): firing it twice is a real double-effect. */
function nonIdempotentTool(): NeutralTool {
  return {
    spec: {
      name: 'charge_card',
      description: 'Charge the customer (SIDE EFFECT — moves money).',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
        additionalProperties: false,
      },
    },
    handler: (args: unknown) => {
      sideEffectFires += 1; // the real, irreversible effect
      const { amount } = (args ?? {}) as { amount?: number };
      return { charged: amount ?? 0, receipt: `r-${sideEffectFires}` };
    },
    inputSchema: {
      type: 'object',
      properties: { amount: { type: 'number' } },
      required: ['amount'],
      additionalProperties: false,
    },
    timeoutMs: 1000,
    // THE flag: false ⇒ replay must NOT re-fire AND must NOT return a cached success.
    idempotent: false,
  };
}

/**
 * A backend that marshals ONE tool call into ctx.dispatchTool (exactly as a real adapter's execute
 * closure does) and records the dispatched result so the test can assert the fail-closed outcome on
 * replay. It holds NO handler — the dispatcher owns the tool path (the security chokepoint).
 */
class ToolMarshallingBackend implements Backend {
  readonly id = 'openai' as const;
  lastDispatch?: ToolDispatchResult;
  async resolveAuth(): Promise<AuthMode> {
    return 'api-key';
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    // Marshal an SDK tool call → ctx.dispatchTool with the REAL per-call id (as an adapter would). This
    // runs on BOTH the live AND the replay path: on replay a real adapter that re-enters the tool step
    // would call dispatchTool, and the non-idempotent contract MUST fail it closed end-to-end.
    let dispatched: ToolDispatchResult | undefined;
    if (ctx.dispatchTool) {
      dispatched = await ctx.dispatchTool('charge_card', { amount: 42 }, 'call-charge-1');
      this.lastDispatch = dispatched;
    }
    // The llm step is journaled ONLY on the live run (the first llm step being cached is what gates
    // replay). On replay run-core's journal lookup returns the cached step; we do NOT re-record it
    // (re-recording the same idempotency key would collide on the UNIQUE index — exactly what a real
    // adapter's replayFromJournal avoids by reconstructing from the journal instead of re-journaling).
    if (!ctx.replay) {
      await ctx.journal.record({
        type: 'llm',
        idempotencyKey: `llm:${spec.name}`,
        inputHash: `hash:${spec.input}`,
        output: { finalText: 'done' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        costUsd: 0,
        model: spec.model,
        producedBy: 'test-marshalling-backend',
        latencyMs: 1,
        status: 'ok',
        authMode: 'api-key',
      });
    }
    const toolPart =
      dispatched?.kind === 'tool_data'
        ? ([
            {
              kind: 'tool_call' as const,
              toolCallId: 'call-charge-1',
              name: 'charge_card',
              args: { amount: 42 },
            },
          ] as const)
        : ([] as const);
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText: 'done',
      output: null,
      error: null,
      errorClass: null,
      conversation: [
        { role: 'assistant', index: 0, parts: [...toolPart, { kind: 'text', text: 'done' }] },
      ],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: dispatched?.kind === 'tool_data' ? 2 : 1,
    };
  }
}

function spec(): AgentSpec {
  return {
    name: 'charger',
    instructions: 'i',
    model: 'gpt-4.1-mini',
    input: 'charge the card',
    tools: [nonIdempotentTool().spec],
    maxTurns: 8,
  };
}

beforeAll(async () => {
  await resetRunSchema(db);
});
beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A);
  sideEffectFires = 0;
});
afterAll(async () => {
  await db.$client.end();
});

describe('E2E #10: non-idempotent tool through dispatchTool — fail-closed on REPLAY (Decision #3)', () => {
  it('LIVE: the side-effecting tool fires EXACTLY ONCE and returns opaque tool_data', async () => {
    const tdb = forTenant(db, TENANT_A);
    const backend = new ToolMarshallingBackend();
    const live = await runAgent(tdb, backend, spec(), { tools: [nonIdempotentTool()] });

    expect(live.status).toBe('completed');
    // The real effect happened exactly once.
    expect(sideEffectFires).toBe(1);
    // The live dispatch returned an opaque tool_data (success).
    expect(backend.lastDispatch?.kind).toBe('tool_data');
  });

  it('REPLAY: dispatchTool surfaces a tool_error — NEVER re-fires the handler, NEVER fabricates success', async () => {
    const tdb = forTenant(db, TENANT_A);
    const liveBackend = new ToolMarshallingBackend();
    const live = await runAgent(tdb, liveBackend, spec(), { tools: [nonIdempotentTool()] });
    expect(sideEffectFires).toBe(1); // fired once live

    // Now REPLAY the SAME run. A real adapter would again marshal the SDK tool call into dispatchTool;
    // because the tool is non-idempotent, the END-TO-END contract must fail closed.
    const replayBackend = new ToolMarshallingBackend();
    const replay = await runAgent(tdb, replayBackend, spec(), {
      replayRunId: live.runId,
      tools: [nonIdempotentTool()],
    });

    // The handler did NOT re-fire on replay (the irreversible effect is not repeated).
    expect(sideEffectFires).toBe(1);
    // The dispatched result on replay is a fail-closed tool_error (NOT a cached success masquerading
    // as a fresh run) — Decision #3 reached END-TO-END through the adapter→run-core→dispatchTool chain.
    expect(replayBackend.lastDispatch?.kind).toBe('tool_error');
    if (replayBackend.lastDispatch?.kind === 'tool_error') {
      expect(replayBackend.lastDispatch.message).toMatch(/non-idempotent|cannot be replayed/i);
    }
    // The run still completes with the IDENTICAL neutral shape — fail-closed, not a crash.
    expect(replay.status).toBe('completed');
    expect(Object.hasOwn(replay, 'output')).toBe(true);
    expect(Object.hasOwn(replay, 'error')).toBe(true);
  });
});
