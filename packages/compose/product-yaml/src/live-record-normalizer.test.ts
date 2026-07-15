/**
 * The LIVE record normalizer — unit proofs with `runAgent` mocked (the REAL runAgent path is proven
 * by the platform's own run tests). Fail-the-fix pins:
 *  - the DETERMINISTIC normalize run id (same tenant+record ⇒ same id; different ⇒ different; UUID-shaped);
 *  - the EXACT structured-output AgentSpec shape (tools: [], maxTurns: 1, the declared outputSchema, the
 *    raw record framed as untrusted DATA input) + the runId threading;
 *  - ATTACH-BEFORE-RUN: a completed header reuses the persisted structured output WITHOUT re-invoking
 *    the model (the crash-window convergence — no double-bill);
 *  - error mapping (a returned error RunResult, a thrown runAgent, AND a non-object structured output
 *    all become the neutral `error` outcome the submit path fail-closes on).
 */
import type { RunResult } from '@rayspec/core';
import { describe, expect, it, vi } from 'vitest';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('@rayspec/platform', () => ({ runAgent: runAgentMock }));
// Override ONLY drizzle's `eq` (spread the real module so @rayspec/db's table builders stay intact) so
// the run-id-keyed ATTACH fake below can read the EXACT run id loadCompletedNormalize queries on
// (where(runs.runId == runId)) — reproducing the real payload-keyed attach contract.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: (_col: unknown, value: unknown) => ({ __runId: value }) };
});

const { makeLiveRecordNormalizer, normalizeRunId } = await import('./live-record-normalizer.js');
type LiveRecordNormalizerConfig = import('./live-record-normalizer.js').LiveRecordNormalizerConfig;

const TENANT = 'tenant-a';
const RECORD_ID = 'rec-1';

type HeaderRow = { status: string; output: unknown };

/** A fake tenant-bound db whose runs-header read returns the queued row (the ATTACH probe). */
function fakeTdb(header: HeaderRow[] = []) {
  return {
    select: () => ({ where: () => ({ limit: async () => header }) }),
  } as unknown as ReturnType<LiveRecordNormalizerConfig['tdbFor']>;
}

/**
 * A fake tenant-bound db whose runs-header read returns a COMPLETED header ONLY for the exact run id
 * queried (via the overridden `eq` → `{ __runId }`) — reproducing the real payload-keyed attach: a run
 * id with no committed header returns [] and the normalizer runs fresh.
 */
function fakeTdbByRunId(outputsByRunId: Map<string, unknown>) {
  return {
    select: () => ({
      where: (cond: { __runId: string }) => ({
        limit: async () => {
          const output = outputsByRunId.get(cond.__runId);
          return output === undefined ? [] : [{ status: 'completed', output }];
        },
      }),
    }),
  } as unknown as ReturnType<LiveRecordNormalizerConfig['tdbFor']>;
}

function cfg(header: HeaderRow[] = []): LiveRecordNormalizerConfig {
  return {
    agentId: 'field_normalizer',
    backend: { id: 'openai' } as LiveRecordNormalizerConfig['backend'],
    model: 'test-model',
    instructions: 'NORMALIZE THE FIELDS',
    outputSchema: { name: 'normalized_record', schema: { type: 'object' } },
    requireNativeStructuredOutput: true,
    tdbFor: () => fakeTdb(header),
  };
}

function completedRun(output: unknown): RunResult {
  return {
    runId: 'r',
    backend: 'openai',
    authMode: 'api-key',
    status: 'completed',
    finalText: '',
    output,
    error: null,
    errorClass: null,
    conversation: [],
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    costUsd: 0.01,
    stepCount: 1,
  } as RunResult;
}

describe('normalizeRunId', () => {
  const REC = { title: 'a' };
  it('is deterministic per (tenant, record, payload), distinct across records/tenants, and UUID-shaped', () => {
    const a1 = normalizeRunId(TENANT, RECORD_ID, REC);
    const a2 = normalizeRunId(TENANT, RECORD_ID, REC);
    const b = normalizeRunId(TENANT, 'rec-2', REC);
    const c = normalizeRunId('tenant-b', RECORD_ID, REC);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(c); // tenant-disjoint
    expect(a1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is PAYLOAD-dependent — a DIFFERENT raw record for the same (tenant, record) derives a DIFFERENT run id (no stale-output reuse across a corrected-payload retry), while key-order is not a difference (canonical hash)', () => {
    const base = normalizeRunId(TENANT, RECORD_ID, { title: 'a', priority: 'high' });
    const different = normalizeRunId(TENANT, RECORD_ID, { title: 'b', priority: 'high' });
    const reordered = normalizeRunId(TENANT, RECORD_ID, { priority: 'high', title: 'a' });
    expect(different).not.toBe(base); // a corrected payload → a fresh run (the crash-window fix)
    expect(reordered).toBe(base); // canonical: key order is not a payload change (convergence holds)
  });
});

describe('makeLiveRecordNormalizer', () => {
  it('runs FRESH under the deterministic id with the exact tool-less single-turn structured spec; returns the structured output as the normalized record', async () => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue(completedRun({ title: 'FIXED', normalized: true }));
    const normalizer = makeLiveRecordNormalizer(cfg())(TENANT);

    const outcome = await normalizer.normalize({ record: { title: 'fixed' }, recordId: RECORD_ID });
    expect(outcome).toEqual({ status: 'normalized', record: { title: 'FIXED', normalized: true } });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const [, backend, spec, opts] = runAgentMock.mock.calls[0] as unknown[];
    expect((backend as { id: string }).id).toBe('openai');
    expect(spec).toMatchObject({
      name: 'field_normalizer',
      instructions: 'NORMALIZE THE FIELDS',
      model: 'test-model',
      tools: [],
      maxTurns: 1,
      outputSchema: { name: 'normalized_record', schema: { type: 'object' } },
    });
    // The raw record is framed as untrusted DATA in the input (serialized, never as instructions).
    expect((spec as { input: string }).input).toContain('UNTRUSTED DATA');
    expect((spec as { input: string }).input).toContain('"title":"fixed"');
    expect(opts).toMatchObject({
      runId: normalizeRunId(TENANT, RECORD_ID, { title: 'fixed' }),
      requireNativeStructuredOutput: true,
    });
  });

  it('CRASH-WINDOW: a completed run for raw payload A is NOT reused for a corrected payload B (payload-keyed run id) — B runs fresh; a retry of A still ATTACHES (convergence, no double-bill)', async () => {
    runAgentMock.mockReset();
    const A = { title: 'raw-a' };
    const B = { title: 'corrected-b' };
    const idA = normalizeRunId(TENANT, RECORD_ID, A);
    const idB = normalizeRunId(TENANT, RECORD_ID, B);
    expect(idA).not.toBe(idB); // the fix: a corrected payload derives a distinct run

    // The crash state: A's normalize run header committed (output = normalized(A)) but the submission
    // row did NOT persist — so a corrected-payload retry reaches this attach path. Only idA is completed.
    const outputs = new Map<string, unknown>([[idA, { title: 'NORMALIZED-A' }]]);
    const config: LiveRecordNormalizerConfig = { ...cfg(), tdbFor: () => fakeTdbByRunId(outputs) };

    // B (corrected) → idB has NO committed header → a FRESH run produces normalized(B), NEVER the stale
    // normalized(A) (which would be stored under B's hash — silent data loss).
    runAgentMock.mockResolvedValueOnce(completedRun({ title: 'NORMALIZED-B' }));
    const outB = await makeLiveRecordNormalizer(config)(TENANT).normalize({
      record: B,
      recordId: RECORD_ID,
    });
    expect(outB).toEqual({ status: 'normalized', record: { title: 'NORMALIZED-B' } });
    expect(runAgentMock).toHaveBeenCalledTimes(1); // ran fresh — did NOT attach A's output
    const [, , , opts] = runAgentMock.mock.calls[0] as unknown[];
    expect((opts as { runId: string }).runId).toBe(idB);

    // A (identical raw payload) → idA → ATTACHES to the completed header — no re-run, no double-bill.
    const outA = await makeLiveRecordNormalizer(config)(TENANT).normalize({
      record: A,
      recordId: RECORD_ID,
    });
    expect(outA).toEqual({ status: 'normalized', record: { title: 'NORMALIZED-A' } });
    expect(runAgentMock).toHaveBeenCalledTimes(1); // STILL 1 — A attached, the model was not re-invoked
  });

  it('ATTACHES to a completed run header — the model is NOT re-invoked (no double-bill)', async () => {
    runAgentMock.mockReset();
    const normalizer = makeLiveRecordNormalizer(
      cfg([{ status: 'completed', output: { title: 'PERSISTED' } }]),
    )(TENANT);
    const outcome = await normalizer.normalize({ record: { title: 'x' }, recordId: RECORD_ID });
    expect(outcome).toEqual({ status: 'normalized', record: { title: 'PERSISTED' } });
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('maps a returned error RunResult to the neutral error outcome (class + message)', async () => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue({
      ...completedRun(null),
      status: 'error',
      error: 'rate limited upstream',
      errorClass: 'rate_limited',
    });
    const outcome = await makeLiveRecordNormalizer(cfg())(TENANT).normalize({
      record: { t: 1 },
      recordId: RECORD_ID,
    });
    expect(outcome).toEqual({
      status: 'error',
      errorClass: 'rate_limited',
      message: 'rate limited upstream',
    });
  });

  it('maps a THROWN runAgent to the neutral error outcome (never an unhandled throw from the normalizer)', async () => {
    runAgentMock.mockReset();
    runAgentMock.mockRejectedValue(new Error('socket hang up'));
    const outcome = await makeLiveRecordNormalizer(cfg())(TENANT).normalize({
      record: { t: 1 },
      recordId: RECORD_ID,
    });
    expect(outcome).toEqual({ status: 'error', message: 'socket hang up' });
  });

  it('maps a non-object structured output to the typed invalid_output error (fail-closed — the submit persists nothing)', async () => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue(completedRun(['not', 'an', 'object']));
    const outcome = await makeLiveRecordNormalizer(cfg())(TENANT).normalize({
      record: { t: 1 },
      recordId: RECORD_ID,
    });
    expect(outcome).toMatchObject({ status: 'error', errorClass: 'invalid_output' });
  });
});
