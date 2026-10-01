/**
 * The execution policy resolved from the environment: the defaults of each posture, explicit values,
 * and which unusable values refuse the boot.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_KILL_GRACE_MS,
  DEFAULT_AGENT_WORKER_CONCURRENCY,
  executionPolicyProblemMessage,
  executionPolicyProblems,
  MANAGED_DEFAULTS,
  resolveExecutionPolicy,
  runLimitsOf,
} from './execution-policy.js';

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
const MANAGED = { RAYSPEC_HOSTING_POSTURE: 'managed' };

describe('resolveExecutionPolicy — local posture (no RAYSPEC_HOSTING_POSTURE)', () => {
  it('keeps the behaviour before the policy existed: no wall time, no call timeout, no admission', () => {
    const p = resolveExecutionPolicy(env({}));
    expect(p.posture).toBe('local');
    expect(p.runMaxMs).toEqual({ value: undefined, source: 'off' });
    expect(p.requestTimeoutMs).toEqual({ value: undefined, source: 'off' });
    expect(p.maxAttempts).toEqual({ value: undefined, source: 'off' });
    expect(p.queueMax).toEqual({ value: undefined, source: 'off' });
    expect(p.queueMaxPerTenant).toEqual({ value: undefined, source: 'off' });
    expect(p.syncRunsMax).toEqual({ value: undefined, source: 'off' });
    expect(p.cancelPollMs).toEqual({ value: undefined, source: 'off' });
  });

  it('applies the two defaults that hold in every posture: the worker concurrency and the kill grace', () => {
    const p = resolveExecutionPolicy(env({}));
    expect(p.workerConcurrency).toBe(DEFAULT_AGENT_WORKER_CONCURRENCY);
    expect(p.killGraceMs).toBe(DEFAULT_AGENT_KILL_GRACE_MS);
  });

  it('reads every explicit value', () => {
    const p = resolveExecutionPolicy(
      env({
        RAYSPEC_AGENT_RUN_MAX_MS: '60000',
        RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: '30000',
        RAYSPEC_AGENT_MAX_ATTEMPTS: '1',
        RAYSPEC_AGENT_KILL_GRACE_MS: '250',
        RAYSPEC_AGENT_QUEUE_MAX: '50',
        RAYSPEC_AGENT_QUEUE_MAX_PER_TENANT: '5',
        RAYSPEC_AGENT_WORKER_CONCURRENCY: '8',
        RAYSPEC_AGENT_SYNC_RUNS_MAX: '3',
        RAYSPEC_RUN_CANCEL_POLL_MS: '500',
      }),
    );
    expect(p.runMaxMs).toEqual({ value: 60_000, source: 'explicit' });
    expect(p.requestTimeoutMs).toEqual({ value: 30_000, source: 'explicit' });
    expect(p.maxAttempts).toEqual({ value: 1, source: 'explicit' });
    expect(p.killGraceMs).toBe(250);
    expect(p.queueMax).toEqual({ value: 50, source: 'explicit' });
    expect(p.queueMaxPerTenant).toEqual({ value: 5, source: 'explicit' });
    expect(p.workerConcurrency).toBe(8);
    expect(p.syncRunsMax).toEqual({ value: 3, source: 'explicit' });
    expect(p.cancelPollMs).toEqual({ value: 500, source: 'explicit' });
  });

  it('reports no problem for an unusable value of a variable that predates the policy (it means unset)', () => {
    const problems = executionPolicyProblems(
      env({ RAYSPEC_AGENT_RUN_MAX_MS: 'later', RAYSPEC_AGENT_REQUEST_TIMEOUT_MS: '0' }),
    );
    expect(problems).toEqual([]);
    expect(resolveExecutionPolicy(env({ RAYSPEC_AGENT_RUN_MAX_MS: 'later' })).runMaxMs.value).toBe(
      undefined,
    );
  });

  it('refuses an unusable value of a variable the policy adds, in either posture', () => {
    for (const variable of [
      'RAYSPEC_AGENT_KILL_GRACE_MS',
      'RAYSPEC_AGENT_QUEUE_MAX',
      'RAYSPEC_AGENT_QUEUE_MAX_PER_TENANT',
      'RAYSPEC_AGENT_WORKER_CONCURRENCY',
      'RAYSPEC_AGENT_SYNC_RUNS_MAX',
    ]) {
      for (const bad of ['zero', '0', '-3', '0.5', '2147483648']) {
        const problems = executionPolicyProblems(env({ [variable]: bad }));
        expect(problems).toHaveLength(1);
        expect(problems[0]?.variable).toBe(variable);
        expect(executionPolicyProblems(env({ ...MANAGED, [variable]: bad }))).toHaveLength(1);
      }
    }
  });
});

describe('resolveExecutionPolicy — managed posture', () => {
  it('applies every default the posture documents', () => {
    const p = resolveExecutionPolicy(env(MANAGED));
    expect(p.posture).toBe('managed');
    expect(p.runMaxMs).toEqual({ value: MANAGED_DEFAULTS.runMaxMs, source: 'hosting-posture' });
    expect(p.requestTimeoutMs).toEqual({
      value: MANAGED_DEFAULTS.requestTimeoutMs,
      source: 'hosting-posture',
    });
    expect(p.maxAttempts).toEqual({
      value: MANAGED_DEFAULTS.maxAttempts,
      source: 'hosting-posture',
    });
    expect(p.queueMax).toEqual({ value: MANAGED_DEFAULTS.queueMax, source: 'hosting-posture' });
    expect(p.queueMaxPerTenant).toEqual({
      value: MANAGED_DEFAULTS.queueMaxPerTenant,
      source: 'hosting-posture',
    });
    expect(p.syncRunsMax).toEqual({
      value: MANAGED_DEFAULTS.syncRunsMax,
      source: 'hosting-posture',
    });
    expect(p.cancelPollMs).toEqual({
      value: MANAGED_DEFAULTS.cancelPollMs,
      source: 'hosting-posture',
    });
  });

  it('an explicit value wins over the posture default', () => {
    const p = resolveExecutionPolicy(env({ ...MANAGED, RAYSPEC_AGENT_RUN_MAX_MS: '1000' }));
    expect(p.runMaxMs).toEqual({ value: 1_000, source: 'explicit' });
  });

  it('refuses an unusable value of EVERY variable, including those that predate the policy', () => {
    const problems = executionPolicyProblems(
      env({
        ...MANAGED,
        RAYSPEC_AGENT_RUN_MAX_MS: 'later',
        RAYSPEC_RUN_CANCEL_POLL_MS: '-1',
      }),
    );
    expect(problems.map((p) => p.variable)).toEqual([
      'RAYSPEC_AGENT_RUN_MAX_MS',
      'RAYSPEC_RUN_CANCEL_POLL_MS',
    ]);
    const message = executionPolicyProblemMessage(problems);
    expect(message).toContain("RAYSPEC_AGENT_RUN_MAX_MS='later'");
    expect(message).toContain("RAYSPEC_RUN_CANCEL_POLL_MS='-1'");
  });

  it('a posture value other than exactly `managed` is the local posture', () => {
    expect(resolveExecutionPolicy(env({ RAYSPEC_HOSTING_POSTURE: 'Managed' })).posture).toBe(
      'local',
    );
  });
});

describe('runLimitsOf — what run-core hands a backend', () => {
  it('carries the call timeout and the kill grace', () => {
    expect(runLimitsOf(resolveExecutionPolicy(env(MANAGED)))).toEqual({
      providerCallTimeoutMs: MANAGED_DEFAULTS.requestTimeoutMs,
      killGraceMs: DEFAULT_AGENT_KILL_GRACE_MS,
    });
  });

  it('omits the call timeout when none applies, so the backend keeps its own default', () => {
    expect(runLimitsOf(resolveExecutionPolicy(env({})))).toEqual({
      killGraceMs: DEFAULT_AGENT_KILL_GRACE_MS,
    });
  });
});
