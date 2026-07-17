/**
 * DB-backed replay transcript PARITY.
 *
 * Exercises the REAL path end-to-end (NOT a stubbed rehydrate, which masked the bug): a live
 * `runAgent` persists the re-derived conversation via run-core, then a replay of the SAME runId
 * rebuilds the transcript via the GENUINE `rehydrateConversation` (tenant-scoped read + the
 * untrusted-content-boundary coerceRole, which downgrades the stored 'system' row to 'user'). The
 * OpenAI adapter's replay
 * must re-attach the TRUSTED system turn so replay.conversation matches the live one — first turn
 * role='system' from spec.instructions, no duplicate / no leftover coerced 'user' instructions turn.
 *
 * The SDK `run()` is mocked (real Agent/tool kept) so the test is deterministic + offline; run-core
 * + the journal + the conversation store + rehydrate are all REAL Postgres.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, NeutralTool } from '@rayspec/core';
import { runAgent } from '@rayspec/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const runSpy = vi.fn();
vi.mock('@openai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return { ...actual, run: (...args: unknown[]) => runSpy(...args) };
});

const { OpenAIAdapter } = await import('./index.js');

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'openai-tool-run.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  instructions: string;
  input: string;
  finalOutput: string;
  history: unknown[];
  rawResponses: unknown[];
  stateUsage: Record<string, number>;
};

const db = makeTestDb();

beforeAll(async () => {
  await resetRunSchema(db);
});
beforeEach(async () => {
  await db.$client.unsafe('TRUNCATE journal_steps, conversation_items, run_events, runs CASCADE');
  await seedOrgs(db, TENANT_A);
  runSpy.mockReset();
});
afterAll(async () => {
  await db.$client.end();
});

const weatherTool: NeutralTool = {
  spec: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
  handler: (args: unknown) => ({ city: (args as { city: string }).city, tempC: 18 }),
  timeoutMs: 1000,
  idempotent: true,
};

const spec: AgentSpec = {
  name: 'weather-agent',
  instructions: fixture.instructions,
  model: 'gpt-4.1-mini',
  input: fixture.input,
  tools: [weatherTool.spec],
  maxTurns: 8,
};

function fakeRunImpl() {
  return async (agent: { tools?: unknown[] }) => {
    for (const t of agent.tools ?? []) {
      const invoke = (t as { invoke?: (...a: unknown[]) => Promise<string> }).invoke;
      if (typeof invoke === 'function') {
        await invoke({ context: {} }, JSON.stringify({ city: 'Berlin' }), {
          toolCall: { callId: 'call_OAEM0aPEoTnxkd11KGkfc3BH' },
        });
      }
    }
    return {
      finalOutput: fixture.finalOutput,
      history: fixture.history,
      rawResponses: fixture.rawResponses,
      state: { usage: fixture.stateUsage },
    };
  };
}

describe('DB-backed replay transcript parity (real rehydrateConversation)', () => {
  it('replay.conversation matches live (first turn role=system from trusted instructions)', async () => {
    runSpy.mockImplementation(fakeRunImpl());
    const tdb = forTenant(db, TENANT_A);
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });

    // LIVE run via run-core (persists the re-derived conversation through the REAL store).
    const live = await runAgent(tdb, adapter, spec, { tools: [weatherTool] });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(live.conversation[0]?.role).toBe('system');
    expect(live.conversation[0]?.parts).toEqual([{ kind: 'text', text: spec.instructions }]);

    // REPLAY the same runId via run-core: rehydrate runs the GENUINE untrusted-content read-path (the stored
    // 'system' row is coerced to 'user'); the adapter must re-attach the trusted system turn.
    const replay = await runAgent(tdb, adapter, spec, {
      replayRunId: live.runId,
      tools: [weatherTool],
    });
    // No second SDK call on replay.
    expect(runSpy).toHaveBeenCalledTimes(1);

    // PARITY: the first turn is the trusted system turn — IDENTICAL to live (the bug was role='user').
    expect(replay.conversation[0]?.role).toBe('system');
    expect(replay.conversation[0]?.parts).toEqual([{ kind: 'text', text: spec.instructions }]);
    // Exactly one system turn; no coerced 'user' turn carrying the instructions text survived.
    expect(replay.conversation.filter((t) => t.role === 'system')).toHaveLength(1);
    expect(
      replay.conversation.some(
        (t) =>
          t.role === 'user' &&
          t.parts.length === 1 &&
          t.parts[0]?.kind === 'text' &&
          t.parts[0].text === spec.instructions,
      ),
    ).toBe(false);

    // The structural transcript (roles + part kinds) matches live exactly.
    const shape = (conv: typeof live.conversation) =>
      conv.map((t) => ({ role: t.role, kinds: t.parts.map((p) => p.kind) }));
    expect(shape(replay.conversation)).toEqual(shape(live.conversation));
  });
});

describe('run-core is the single seq authority — one-tool run has contiguous monotonic seq', () => {
  it('run_started/tool_called/tool_result/run_completed carry strictly monotonic, contiguous seq', async () => {
    runSpy.mockImplementation(fakeRunImpl());
    const tdb = forTenant(db, TENANT_A);
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });

    const events: { type: string; seq: number }[] = [];
    await runAgent(tdb, adapter, spec, {
      tools: [weatherTool],
      onEvent: (e) => {
        events.push({ type: e.type, seq: e.seq });
      },
    });

    // The adapter emits run_started + run_completed (seq-less); the dispatcher emits
    // tool_called + tool_result (seq-less). run-core's SINGLE wrapper stamps ALL of them.
    const types = events.map((e) => e.type);
    expect(types).toEqual(['run_started', 'tool_called', 'tool_result', 'run_completed']);
    // Strictly monotonic + contiguous from 0 (the bug: dispatchTool hard-coded seq:0 + each adapter
    // had its own counter, so a one-tool run produced 0,0,0,1 — incoherent).
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });
});
