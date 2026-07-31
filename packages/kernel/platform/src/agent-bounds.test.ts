/**
 * Agent-run bounds resolved from the environment — the parsing contract.
 *
 * Each of the three variables is OPTIONAL and OFF by default: an absent, non-numeric, or
 * out-of-range value resolves to `undefined`, which every consumer treats as "no bound" — the
 * behaviour that applied before these variables existed.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveAgentMaxAttempts,
  resolveAgentRequestTimeoutMs,
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

  it('is undefined for an empty, non-numeric, zero, or negative value', () => {
    for (const v of ['', '   ', 'abc', '10s', 'NaN', 'Infinity', '0', '-1']) {
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

  it('is undefined for an empty, non-numeric, zero, or negative value', () => {
    for (const v of ['', '   ', 'abc', 'NaN', 'Infinity', '0', '-3']) {
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

  it('is undefined for an empty, non-numeric, zero, or negative value', () => {
    for (const v of ['', '   ', 'abc', 'NaN', 'Infinity', '0', '-1']) {
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
