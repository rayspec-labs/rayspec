/**
 * Agent-run bounds resolved from the environment — the parsing contract.
 *
 * Each of the four variables is OPTIONAL and OFF by default: an absent, non-numeric, or
 * out-of-range value resolves to `undefined`, which every consumer treats as "no bound" — the
 * behaviour that applied before these variables existed.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveAgentMaxAttempts,
  resolveAgentRequestTimeoutMs,
  resolveRunCancelPollMs,
  resolveRunMaxMs,
} from './agent-bounds.js';

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;

describe('resolveAgentRequestTimeoutMs (RAYSPEC_AGENT_REQUEST_TIMEOUT_MS)', () => {
  it('is undefined when the variable is unset', () => {
    expect(resolveAgentRequestTimeoutMs(env({}))).toBeUndefined();
  });

  it('reads a positive integer', () => {
    expect(resolveAgentRequestTimeoutMs(env({ RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: '90000' }))).toBe(
      90_000,
    );
  });

  it('trims surrounding whitespace', () => {
    expect(resolveAgentRequestTimeoutMs(env({ RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: ' 250 ' }))).toBe(
      250,
    );
  });

  it('floors a fractional value', () => {
    expect(resolveAgentRequestTimeoutMs(env({ RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: '1500.9' }))).toBe(
      1_500,
    );
  });

  it('never resolves to 0 — a fractional value below 1 floors to the "not set" sentinel', () => {
    // The floor is applied BEFORE the range check, so a value that would floor to 0 is unset, not a
    // live bound of zero. All three resolvers share the parser, so this pins the rule for all of
    // them: 0 would be a 0ms run ceiling, a 0ms request timeout, and 0 attempts.
    for (const v of ['0.5', '0.9', '0.001']) {
      expect(resolveAgentRequestTimeoutMs(env({ RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: v }))).not.toBe(
        0,
      );
      expect(resolveAgentMaxAttempts(env({ RAYSPEC_AGENT_MAX_ATTEMPTS: v }))).not.toBe(0);
      expect(resolveRunMaxMs(env({ RAYSPEC_AGENT_RUN_MAX_MS: v }))).not.toBe(0);
    }
  });

  it('never resolves above 2147483647 — a larger value is "not set", not a live bound', () => {
    // 2_147_483_647 is the largest delay a timer can hold. Node collapses a larger one to 1ms
    // (TimeoutOverflowWarning), so accepting it would INVERT the bound: a ceiling meant to be
    // generous would abandon every run after a millisecond. Out-of-range is therefore treated like
    // sub-1 — unset, i.e. UNBOUNDED. All three resolvers share the parser, so the rule holds for all
    // of them, and one rule is the one an operator has to remember.
    expect(
      resolveAgentRequestTimeoutMs(env({ RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: '2147483647' })),
    ).toBe(2_147_483_647);
    expect(resolveAgentMaxAttempts(env({ RAYSPEC_AGENT_MAX_ATTEMPTS: '2147483647' }))).toBe(
      2_147_483_647,
    );
    expect(resolveRunMaxMs(env({ RAYSPEC_AGENT_RUN_MAX_MS: '2147483647' }))).toBe(2_147_483_647);

    for (const v of ['2147483648', '3000000000', '1e12']) {
      expect(
        resolveAgentRequestTimeoutMs(env({ RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: v })),
      ).toBeUndefined();
      expect(resolveAgentMaxAttempts(env({ RAYSPEC_AGENT_MAX_ATTEMPTS: v }))).toBeUndefined();
      expect(resolveRunMaxMs(env({ RAYSPEC_AGENT_RUN_MAX_MS: v }))).toBeUndefined();
    }
  });

  it('is undefined for an empty, non-numeric, zero, sub-1, or negative value', () => {
    for (const v of [
      '',
      '   ',
      'abc',
      '10s',
      'NaN',
      'Infinity',
      '0',
      '0.5',
      '0.9',
      '0.001',
      '-1',
    ]) {
      expect(
        resolveAgentRequestTimeoutMs(env({ RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: v })),
      ).toBeUndefined();
    }
  });
});

describe('resolveAgentMaxAttempts (RAYSPEC_AGENT_MAX_ATTEMPTS)', () => {
  it('is undefined when the variable is unset', () => {
    expect(resolveAgentMaxAttempts(env({}))).toBeUndefined();
  });

  it('reads a positive integer', () => {
    expect(resolveAgentMaxAttempts(env({ RAYSPEC_AGENT_MAX_ATTEMPTS: '2' }))).toBe(2);
  });

  it('accepts 1 — a single attempt, no retry', () => {
    expect(resolveAgentMaxAttempts(env({ RAYSPEC_AGENT_MAX_ATTEMPTS: '1' }))).toBe(1);
  });

  it('is undefined for an empty, non-numeric, zero, sub-1, or negative value', () => {
    for (const v of ['', '   ', 'abc', 'NaN', 'Infinity', '0', '0.5', '0.9', '0.001', '-3']) {
      expect(resolveAgentMaxAttempts(env({ RAYSPEC_AGENT_MAX_ATTEMPTS: v }))).toBeUndefined();
    }
  });
});

describe('resolveRunMaxMs (RAYSPEC_AGENT_RUN_MAX_MS)', () => {
  it('is undefined when the variable is unset', () => {
    expect(resolveRunMaxMs(env({}))).toBeUndefined();
  });

  it('reads a positive integer', () => {
    expect(resolveRunMaxMs(env({ RAYSPEC_AGENT_RUN_MAX_MS: '300000' }))).toBe(300_000);
  });

  it('is undefined for an empty, non-numeric, zero, sub-1, or negative value', () => {
    for (const v of ['', '   ', 'abc', 'NaN', 'Infinity', '0', '0.5', '0.9', '0.001', '-1']) {
      expect(resolveRunMaxMs(env({ RAYSPEC_AGENT_RUN_MAX_MS: v }))).toBeUndefined();
    }
  });

  it('defaults to process.env when no environment is passed', () => {
    const saved = process.env.RAYSPEC_AGENT_RUN_MAX_MS;
    try {
      delete process.env.RAYSPEC_AGENT_RUN_MAX_MS;
      expect(resolveRunMaxMs()).toBeUndefined();
      process.env.RAYSPEC_AGENT_RUN_MAX_MS = '4321';
      expect(resolveRunMaxMs()).toBe(4_321);
    } finally {
      if (saved === undefined) delete process.env.RAYSPEC_AGENT_RUN_MAX_MS;
      else process.env.RAYSPEC_AGENT_RUN_MAX_MS = saved;
    }
  });
});

describe('resolveRunCancelPollMs (RAYSPEC_RUN_CANCEL_POLL_MS)', () => {
  it('is undefined when the variable is unset', () => {
    expect(resolveRunCancelPollMs(env({}))).toBeUndefined();
  });

  it('reads a positive integer', () => {
    expect(resolveRunCancelPollMs(env({ RAYSPEC_RUN_CANCEL_POLL_MS: '2000' }))).toBe(2_000);
  });

  it('accepts a very short interval — there is no floor', () => {
    // Deliberate: a floor would silently disable the feature for an operator who asked for a shorter
    // interval than the floor, which is the opposite of what they configured. The parser's contract is
    // the whole rule, exactly as it is for the other three variables.
    expect(resolveRunCancelPollMs(env({ RAYSPEC_RUN_CANCEL_POLL_MS: '1' }))).toBe(1);
  });

  it('is undefined for an empty, non-numeric, zero, sub-1, or negative value', () => {
    for (const v of ['', '   ', 'abc', 'NaN', 'Infinity', '0', '0.5', '0.9', '0.001', '-1']) {
      expect(resolveRunCancelPollMs(env({ RAYSPEC_RUN_CANCEL_POLL_MS: v }))).toBeUndefined();
    }
  });

  it('defaults to process.env when no environment is passed', () => {
    const saved = process.env.RAYSPEC_RUN_CANCEL_POLL_MS;
    try {
      delete process.env.RAYSPEC_RUN_CANCEL_POLL_MS;
      expect(resolveRunCancelPollMs()).toBeUndefined();
      process.env.RAYSPEC_RUN_CANCEL_POLL_MS = '1234';
      expect(resolveRunCancelPollMs()).toBe(1_234);
    } finally {
      if (saved === undefined) delete process.env.RAYSPEC_RUN_CANCEL_POLL_MS;
      else process.env.RAYSPEC_RUN_CANCEL_POLL_MS = saved;
    }
  });
});
