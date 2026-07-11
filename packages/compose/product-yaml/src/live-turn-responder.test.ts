/**
 * The LIVE turn responder — unit proofs with `runAgent` mocked (the REAL runAgent path is proven
 * by the server conversation e2e's live-reply arm). Fail-the-fix pins:
 *  - the DETERMINISTIC reply run id (same turnRef ⇒ same id; different ⇒ different; UUID-shaped);
 *  - ATTACH-BEFORE-RUN: a completed header reuses the persisted final_text with the model NOT
 *    re-invoked (the crashed-after-model window — the sharpening-2 convergence arm's unit half);
 *  - the EXACT AgentSpec shape (tools: [], maxTurns: 1, config model/instructions, input VERBATIM)
 *    and the runId threading (reserve-the-deterministic-id);
 *  - error mapping (a returned error RunResult AND a thrown runAgent both become the typed error
 *    outcome CARRYING the deterministic run id);
 *  - the S4 seam: a supplied onEvent threads into runAgent's opts.
 */
import type { RunResult } from '@rayspec/core';
import { describe, expect, it, vi } from 'vitest';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('@rayspec/platform', () => ({ runAgent: runAgentMock }));

const { makeLiveTurnResponder, replyAttemptRunId, replyRunId, REPLY_RUN_MAX_ATTEMPTS } =
  await import('./live-turn-responder.js');
type LiveTurnResponderConfig = import('./live-turn-responder.js').LiveTurnResponderConfig;

const TURN_REF = 'tenant-a:conv-1:m-1';

type HeaderRow = { status: string; finalText: string | null };

/**
 * A fake tenant-bound db whose runs-header reads return the queued result per SUCCESSIVE select
 * (the TF-F1 attempt walk reads attempt 0, 1, … in order — a queue is a faithful per-id fake).
 */
function fakeTdb(perCall: HeaderRow[][] = []) {
  let call = 0;
  return {
    select: () => ({ where: () => ({ limit: async () => perCall[call++] ?? [] }) }),
  } as unknown as ReturnType<LiveTurnResponderConfig['tdbFor']>;
}

function cfg(perCall: HeaderRow[][] = []): LiveTurnResponderConfig {
  return {
    agentId: 'support_responder',
    backend: { id: 'openai' } as LiveTurnResponderConfig['backend'],
    model: 'test-model',
    instructions: 'BE HELPFUL',
    historyWindow: { turns: 10, chars: 4096 },
    tdbFor: () => fakeTdb(perCall),
  };
}

function completedRun(text: string): RunResult {
  return {
    runId: 'r',
    backend: 'openai',
    authMode: 'api-key',
    status: 'completed',
    finalText: text,
    output: null,
    error: null,
    errorClass: null,
    conversation: [],
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    costUsd: 0.01,
    stepCount: 1,
  } as RunResult;
}

describe('replyRunId / replyAttemptRunId', () => {
  it('is deterministic per turn_ref, distinct across turn_refs, and UUID-shaped', () => {
    const a1 = replyRunId(TURN_REF);
    const a2 = replyRunId(TURN_REF);
    const b = replyRunId('tenant-a:conv-1:m-2');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('TF-F1: attempt 0 IS replyRunId (byte-compatible with the pre-fix derivation + the e2e oracle); later attempts are distinct, deterministic, UUID-shaped', () => {
    expect(replyAttemptRunId(TURN_REF, 0)).toBe(replyRunId(TURN_REF));
    const a1 = replyAttemptRunId(TURN_REF, 1);
    expect(a1).toBe(replyAttemptRunId(TURN_REF, 1));
    expect(a1).not.toBe(replyRunId(TURN_REF));
    expect(a1).not.toBe(replyAttemptRunId(TURN_REF, 2));
    expect(a1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('makeLiveTurnResponder', () => {
  it('runs FRESH under the deterministic id with the exact tool-less single-turn spec', async () => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue(completedRun('the reply'));
    const responder = makeLiveTurnResponder(cfg())('tenant-a');
    const outcome = await responder.respond({ input: 'ASSEMBLED INPUT', turnRef: TURN_REF });

    expect(outcome).toEqual({
      status: 'completed',
      runId: replyRunId(TURN_REF),
      text: 'the reply',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const [, backend, spec, opts] = runAgentMock.mock.calls[0] as unknown[];
    expect((backend as { id: string }).id).toBe('openai');
    expect(spec).toMatchObject({
      name: 'support_responder',
      instructions: 'BE HELPFUL',
      model: 'test-model',
      input: 'ASSEMBLED INPUT',
      tools: [],
      maxTurns: 1,
    });
    expect((spec as { outputSchema?: unknown }).outputSchema).toBeUndefined();
    expect(opts).toMatchObject({ runId: replyRunId(TURN_REF) });
    expect((opts as { onEvent?: unknown }).onEvent).toBeUndefined();
  });

  it('ATTACHES to a completed header — the model is NOT re-invoked (no double-bill)', async () => {
    runAgentMock.mockReset();
    const responder = makeLiveTurnResponder(
      cfg([[{ status: 'completed', finalText: 'persisted reply' }]]),
    )('tenant-a');
    const outcome = await responder.respond({ input: 'whatever', turnRef: TURN_REF });
    expect(outcome).toEqual({
      status: 'completed',
      runId: replyRunId(TURN_REF),
      text: 'persisted reply',
    });
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('TF-F1: a terminal-FAILED header advances to the NEXT deterministic attempt id (fresh header + clean journal — never a re-run under the failed id)', async () => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue(completedRun('second attempt'));
    // Attempt 0's header is terminally failed; attempt 1 has no header → run fresh THERE.
    const responder = makeLiveTurnResponder(cfg([[{ status: 'error', finalText: null }], []]))(
      'tenant-a',
    );
    const outcome = await responder.respond({ input: 'retry input', turnRef: TURN_REF });
    expect(outcome).toMatchObject({
      status: 'completed',
      text: 'second attempt',
      runId: replyAttemptRunId(TURN_REF, 1),
    });
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    // ★ THE PIN: the fresh run is reserved under the ATTEMPT-1 id, NOT the failed attempt-0 id
    // (pre-fix the retry re-used the failed id: its header stayed 'error' forever and the new
    // events deduped against the failed attempt's seqs — the journal-mixing wart).
    expect((runAgentMock.mock.calls[0] as unknown[])[3]).toMatchObject({
      runId: replyAttemptRunId(TURN_REF, 1),
    });
    expect(replyAttemptRunId(TURN_REF, 1)).not.toBe(replyRunId(TURN_REF));
  });

  it('TF-F1: a COMPLETED header at a LATER attempt ATTACHES (any attempt — never a second model call)', async () => {
    runAgentMock.mockReset();
    const responder = makeLiveTurnResponder(
      cfg([
        [{ status: 'error', finalText: null }],
        [{ status: 'completed', finalText: 'attempt-1 reply' }],
      ]),
    )('tenant-a');
    const outcome = await responder.respond({ input: 'whatever', turnRef: TURN_REF });
    expect(outcome).toEqual({
      status: 'completed',
      runId: replyAttemptRunId(TURN_REF, 1),
      text: 'attempt-1 reply',
    });
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it(`TF-F1: the bounded walk caps at ${REPLY_RUN_MAX_ATTEMPTS} — all-failed headers yield the TYPED error naming the cap, ZERO model calls`, async () => {
    runAgentMock.mockReset();
    const allFailed = Array.from({ length: REPLY_RUN_MAX_ATTEMPTS }, () => [
      { status: 'error', finalText: null },
    ]);
    const responder = makeLiveTurnResponder(cfg(allFailed))('tenant-a');
    const outcome = await responder.respond({ input: 'x', turnRef: TURN_REF });
    expect(outcome).toMatchObject({
      status: 'error',
      errorClass: 'reply_attempts_exhausted',
      runId: replyAttemptRunId(TURN_REF, REPLY_RUN_MAX_ATTEMPTS - 1),
    });
    expect((outcome as { message: string }).message).toContain(String(REPLY_RUN_MAX_ATTEMPTS));
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('maps a returned error RunResult to the typed error outcome carrying the class + run id', async () => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue({
      ...completedRun(''),
      status: 'error',
      error: 'rate limited upstream',
      errorClass: 'rate_limited',
    });
    const responder = makeLiveTurnResponder(cfg())('tenant-a');
    const outcome = await responder.respond({ input: 'x', turnRef: TURN_REF });
    expect(outcome).toEqual({
      status: 'error',
      runId: replyRunId(TURN_REF),
      errorClass: 'rate_limited',
      message: 'rate limited upstream',
    });
  });

  it('maps a THROWN runAgent to the typed error outcome (never an unhandled 500 from the responder)', async () => {
    runAgentMock.mockReset();
    runAgentMock.mockRejectedValue(new Error('socket hang up'));
    const responder = makeLiveTurnResponder(cfg())('tenant-a');
    const outcome = await responder.respond({ input: 'x', turnRef: TURN_REF });
    expect(outcome).toEqual({
      status: 'error',
      runId: replyRunId(TURN_REF),
      message: 'socket hang up',
    });
  });

  it('threads a supplied onEvent into runAgent opts (the S4 seam — no restructuring later)', async () => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue(completedRun('ok'));
    const responder = makeLiveTurnResponder(cfg())('tenant-a');
    const sink = (): void => {};
    await responder.respond({ input: 'x', turnRef: TURN_REF, onEvent: sink });
    expect((runAgentMock.mock.calls[0] as unknown[])[3]).toMatchObject({ onEvent: sink });
  });
});
