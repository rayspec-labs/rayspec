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
  it('is deterministic per (tenant, record), distinct across records, and UUID-shaped', () => {
    const a1 = normalizeRunId(TENANT, RECORD_ID);
    const a2 = normalizeRunId(TENANT, RECORD_ID);
    const b = normalizeRunId(TENANT, 'rec-2');
    const c = normalizeRunId('tenant-b', RECORD_ID);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(c); // tenant-disjoint
    expect(a1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
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
      runId: normalizeRunId(TENANT, RECORD_ID),
      requireNativeStructuredOutput: true,
    });
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
