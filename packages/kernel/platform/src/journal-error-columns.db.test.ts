/**
 * Journal error classification + retry advice as COLUMNS — DB-backed tests.
 *
 * The classification and the retry advice used to exist only INSIDE the step's `output` jsonb, in a
 * shape that DIFFERED per step type: an llm error step carried `{ error, errorClass, retryAfter }`
 * while a tool error step carried the opaque `{ kind: 'tool_error', … }` and NO class at all. This
 * suite proves the journal sink now lifts both onto dedicated columns at record() time, for BOTH step
 * types:
 *   - an llm error step records the neutral class the adapter reported, and its Retry-After converted
 *     from the journaled unit (SECONDS) into the column's unit (MILLISECONDS);
 *   - a tool error step — the case that carried no class at ALL — records `tool_error`, a value the
 *     neutral `ErrorClass` enum deliberately does not contain (the column vocabulary is WIDER than
 *     the API-facing one, so a tool failure is filterable without being reportable as an upstream class);
 *   - a successful step records neither, and an error→ok heal CLEARS both, so a healed row never keeps
 *     the classification of the attempt it superseded;
 *   - the `output` jsonb keys are left UNTOUCHED (this is additive, not a move).
 *
 * Real Postgres + a fake backend and a real tool dispatch (no network, no model call).
 */
import type {
  AgentSpec,
  AuthMode,
  Backend,
  ErrorClass,
  NeutralTool,
  RunContext,
  RunResult,
} from '@rayspec/core';
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
} from './test-support/test-db.js';

const db = makeTestDb();

/** A tool whose handler ALWAYS throws — the dispatcher fail-closes it into a journaled tool_error step. */
const boomTool: NeutralTool = {
  spec: {
    name: 'boom',
    description: 'a tool that always fails',
    parameters: { type: 'object', properties: {} },
  },
  handler: () => {
    throw new Error('the tool blew up');
  },
  timeoutMs: 1000,
  // Idempotent so the dispatch needs no taint writer — the failure path is what this suite is about.
  idempotent: true,
};

/**
 * A fake backend that reproduces the two journaled failure shapes verbatim:
 *  - `fireFailingTool` dispatches `boom` through the REAL central dispatcher, so the tool_error step is
 *    written by the shipped `recordToolStep` path, not hand-forged here;
 *  - `errorClass` (+ optional `retryAfterSeconds`) writes the adapter-shaped `{ error, errorClass,
 *    retryAfter }` into the failing llm step's output jsonb, exactly as every adapter does;
 *  - `healToOk` re-records the SAME idempotency key as a SUCCESS afterwards (the error→ok heal).
 */
class ErrorShapeBackend implements Backend {
  readonly id = 'openai' as const;
  constructor(
    private readonly opts: {
      errorClass?: ErrorClass;
      /**
       * An errorClass written into the step output that is NOT a member of the neutral vocabulary —
       * what a newer adapter, an older row or a hand-edited journal would leave behind. Deliberately
       * typed `string` (not `ErrorClass`), because the whole point is a value the type system would
       * have refused; the sink has to refuse it at runtime instead.
       */
      rawErrorClass?: string;
      retryAfterSeconds?: number;
      fireFailingTool?: boolean;
      healToOk?: boolean;
    } = {},
  ) {}
  async resolveAuth(): Promise<AuthMode> {
    return 'api-key';
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    if (this.opts.fireFailingTool && ctx.dispatchTool) {
      await ctx.dispatchTool('boom', { q: spec.input }, 'boom-call-1');
    }
    const failing = this.opts.errorClass !== undefined || this.opts.rawErrorClass !== undefined;
    const key = `llm:${spec.name}:0`;
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: key,
      inputHash: `hash:${spec.input}`,
      output: failing
        ? {
            error: 'the upstream rejected the call',
            errorClass: this.opts.errorClass ?? this.opts.rawErrorClass,
            ...(this.opts.retryAfterSeconds !== undefined
              ? { retryAfter: this.opts.retryAfterSeconds }
              : {}),
          }
        : { finalText: 'ok' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      model: spec.model,
      producedBy: 'test-error-shape-backend@1.0.0',
      latencyMs: 1,
      status: failing ? 'error' : 'ok',
      authMode: 'api-key',
    });
    if (this.opts.healToOk) {
      // The SAME idempotency key, now succeeding — the conditional upsert replaces the error row.
      await ctx.journal.record({
        type: 'llm',
        idempotencyKey: key,
        inputHash: `hash:${spec.input}`,
        output: { finalText: 'ok' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        costUsd: 0,
        model: spec.model,
        producedBy: 'test-error-shape-backend@1.0.0',
        latencyMs: 1,
        status: 'ok',
        authMode: 'api-key',
      });
    }
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: failing && !this.opts.healToOk ? 'error' : 'completed',
      finalText: 'ok',
      output: null,
      error: failing && !this.opts.healToOk ? 'the upstream rejected the call' : null,
      errorClass: failing && !this.opts.healToOk ? (this.opts.errorClass ?? null) : null,
      conversation: [{ role: 'assistant', index: 0, parts: [{ kind: 'text', text: 'ok' }] }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

function spec(name: string): AgentSpec {
  return {
    name,
    instructions: 'i',
    model: 'gpt-4.1-mini',
    input: `in-${name}`,
    tools: [boomTool.spec],
    maxTurns: 4,
  };
}

/** The run's journal rows, oldest first (the order they were recorded in). */
async function stepRows(runId: string) {
  const rows = await db
    .select()
    .from(schema.journalSteps)
    .where(eq(schema.journalSteps.runId, runId));
  return [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

beforeAll(async () => {
  await resetRunSchema(db);
});
beforeEach(async () => {
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A);
});
afterAll(async () => {
  await db.$client.end();
});

describe('the failing step records its class + retry advice as columns, for BOTH step types', () => {
  it('a rate-limited llm step records its class and the Retry-After converted seconds→ms', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(
      tdb,
      new ErrorShapeBackend({ errorClass: 'rate_limited', retryAfterSeconds: 17 }),
      spec('rate-limited'),
      {},
    );
    const [step] = await stepRows(res.runId);
    expect(step?.status).toBe('error');
    expect(step?.errorClass).toBe('rate_limited');
    // The journaled advice is in SECONDS (ClassifiedError.retryAfter); the column says milliseconds,
    // so the sink converts on write. 17s → 17000ms.
    expect(step?.retryAfterMs).toBe('17000');
    // ADDITIVE, not a move: the jsonb keys the readers and every existing consumer use are untouched.
    expect(step?.output).toMatchObject({ errorClass: 'rate_limited', retryAfter: 17 });
  });

  it('an llm error class with NO retry advice records the class and leaves retry_after_ms null', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(
      tdb,
      new ErrorShapeBackend({ errorClass: 'upstream_4xx' }),
      spec('no-advice'),
      {},
    );
    const [step] = await stepRows(res.runId);
    expect(step?.errorClass).toBe('upstream_4xx');
    // The advice is ADVICE — never invented when the upstream sent none.
    expect(step?.retryAfterMs).toBeNull();
  });

  it('a tool-error step — which carries no class in its output at all — records `tool_error`', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(
      tdb,
      new ErrorShapeBackend({ errorClass: 'internal', fireFailingTool: true }),
      spec('tool-fail'),
      { tools: [boomTool] },
    );
    const rows = await stepRows(res.runId);
    const tool = rows.find((r) => r.type === 'tool');
    expect(tool?.status).toBe('error');
    // `tool_error` is deliberately NOT a member of the neutral ErrorClass enum: the COLUMN vocabulary
    // is wider than the API-facing one, so post-hoc triage can filter tool failures without them ever
    // becoming reportable as an upstream class.
    expect(tool?.errorClass).toBe('tool_error');
    expect(tool?.retryAfterMs).toBeNull();
    // The opaque tool_error output is unchanged — still no `errorClass` key in the jsonb.
    expect(tool?.output).toMatchObject({ kind: 'tool_error', name: 'boom' });
    expect((tool?.output as Record<string, unknown>).errorClass).toBeUndefined();
    // The llm step alongside it keeps its OWN class — the two are classified independently.
    expect(rows.find((r) => r.type === 'llm')?.errorClass).toBe('internal');
  });

  it('an UNRECOGNISED stored class records NULL — the column never asserts a class the platform cannot vouch for', async () => {
    // The sink promotes the adapter's class only through `isErrorClass`. Without that guard the column
    // would carry whatever a step output happened to hold — a newer adapter's class, an older row, a
    // hand-edited journal — and every consumer filtering on `error_class` would be reading a value the
    // platform never validated. Nothing else in the suite fails if the guard is replaced by a
    // truthiness check, which is why this case exists.
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(
      tdb,
      new ErrorShapeBackend({ rawErrorClass: 'not_a_class', retryAfterSeconds: 30 }),
      spec('bogus-class'),
      {},
    );
    const [step] = await stepRows(res.runId);
    expect(step?.status).toBe('error');
    // Refused: null, not the unvalidated string.
    expect(step?.errorClass).toBeNull();
    // The advice alongside it is still recorded — the two reads are independent, so refusing the class
    // must not also discard a perfectly good Retry-After.
    expect(step?.retryAfterMs).toBe('30000');
    // And the jsonb is untouched: the raw value stays verbatim for whoever wrote it. The column
    // declines to promote it; it does not rewrite history.
    expect((step?.output as Record<string, unknown>).errorClass).toBe('not_a_class');
  });

  it('a SUCCESSFUL step records neither column', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(tdb, new ErrorShapeBackend(), spec('ok'), {});
    const [step] = await stepRows(res.runId);
    expect(step?.status).toBe('ok');
    expect(step?.errorClass).toBeNull();
    expect(step?.retryAfterMs).toBeNull();
  });

  it('an error→ok heal CLEARS both columns (the healed row keeps nothing of the failed attempt)', async () => {
    const tdb = forTenant(db, TENANT_A);
    const res = await runAgent(
      tdb,
      new ErrorShapeBackend({ errorClass: 'rate_limited', retryAfterSeconds: 5, healToOk: true }),
      spec('heal'),
      {},
    );
    const rows = await stepRows(res.runId);
    // One row: the conditional upsert REPLACED the error attempt under the same idempotency key.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ok');
    expect(rows[0]?.errorClass).toBeNull();
    expect(rows[0]?.retryAfterMs).toBeNull();
  });
});
