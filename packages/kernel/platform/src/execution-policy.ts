/**
 * The execution policy — every bound the platform puts on agent execution, resolved in one place.
 *
 * A run is bounded on four axes:
 *
 *   wall time            RAYSPEC_AGENT_RUN_MAX_MS           how long one whole run may take. When it
 *                                                           expires the run's signal is aborted, so the
 *                                                           backend is told to stop, not only abandoned.
 *   provider call        RAYSPEC_AGENT_REQUEST_TIMEOUT_MS   how long one call to the provider may go
 *                                                           unanswered (per HTTP request for the HTTP
 *                                                           backends; per silence of the stream or child
 *                                                           process for the streaming ones).
 *                        RAYSPEC_AGENT_MAX_ATTEMPTS         attempts per HTTP request (first + retries).
 *                        RAYSPEC_AGENT_KILL_GRACE_MS        how long a child process that was asked to
 *                                                           stop may take before it is killed, and how
 *                                                           long run-core waits for a stopped call to
 *                                                           settle before it records the outcome unknown.
 *   queue admission      RAYSPEC_AGENT_QUEUE_MAX            queued and executing durable runs, globally.
 *                        RAYSPEC_AGENT_QUEUE_MAX_PER_TENANT the same, per tenant.
 *   parallelism          RAYSPEC_AGENT_WORKER_CONCURRENCY   durable runs one worker process executes at
 *                                                           once.
 *                        RAYSPEC_AGENT_SYNC_RUNS_MAX        runs one process holds in-request at once.
 *
 * plus the cross-process cancellation poll (RAYSPEC_RUN_CANCEL_POLL_MS, see agent-bounds.ts).
 *
 * DEFAULTS. Under `RAYSPEC_HOSTING_POSTURE=managed` every bound has a default ({@link MANAGED_DEFAULTS})
 * and a value that is set but unusable refuses the boot. Without the posture the defaults are the
 * behaviour before this policy existed — no wall time, the provider client's own timeout, no queue
 * admission — with two exceptions: the worker concurrency keeps its long-standing default of 4, and
 * the kill grace defaults to 5 s everywhere, because a child process that ignores SIGTERM would
 * otherwise live for ever. The four variables that predate the policy keep their lenient parsing
 * outside the posture (an unusable value means "not set"); the variables the policy adds are refused
 * when set and unusable, in either posture.
 */

/** The largest value any bound may carry: the largest delay a timer can hold (see agent-bounds.ts). */
export const MAX_POLICY_BOUND = 2_147_483_647;

/** The worker concurrency when nothing sets it. */
export const DEFAULT_AGENT_WORKER_CONCURRENCY = 4;

/** The kill grace when nothing sets it, in either posture. */
export const DEFAULT_AGENT_KILL_GRACE_MS = 5_000;

/**
 * The defaults the managed hosting posture applies to every bound the operator leaves unset.
 *
 *  - runMaxMs 15 min: generous for a multi-turn agent run, short enough that a stuck run frees its
 *    worker slot within a quarter of an hour.
 *  - requestTimeoutMs 2 min, maxAttempts 2: one provider call is given up after at most about four
 *    minutes of silence, well inside the run's own bound.
 *  - queue 1000 globally, 100 per tenant: a backlog beyond these is refused rather than queued.
 *  - syncRunsMax 32: in-request runs beyond this per process are refused (async runs are queued).
 *  - cancelPollMs 2 s: a cancellation reaches a run in another worker within about two seconds.
 */
export const MANAGED_DEFAULTS = {
  runMaxMs: 900_000,
  requestTimeoutMs: 120_000,
  maxAttempts: 2,
  queueMax: 1_000,
  queueMaxPerTenant: 100,
  syncRunsMax: 32,
  cancelPollMs: 2_000,
} as const;

/** Where a resolved value came from. */
export type PolicySource = 'explicit' | 'hosting-posture' | 'default' | 'off';

/** One resolved bound: its value (undefined = no bound) and where it came from. */
export interface PolicyValue {
  readonly value: number | undefined;
  readonly source: PolicySource;
}

/** The resolved execution policy. */
export interface ExecutionPolicy {
  /** `managed` when `RAYSPEC_HOSTING_POSTURE=managed`, else `local`. */
  readonly posture: 'local' | 'managed';
  readonly runMaxMs: PolicyValue;
  readonly requestTimeoutMs: PolicyValue;
  readonly maxAttempts: PolicyValue;
  /** Always set: a default applies in every posture. */
  readonly killGraceMs: number;
  readonly queueMax: PolicyValue;
  readonly queueMaxPerTenant: PolicyValue;
  /** Always set: a default applies in every posture. */
  readonly workerConcurrency: number;
  readonly syncRunsMax: PolicyValue;
  readonly cancelPollMs: PolicyValue;
}

/** One variable whose value cannot be used, and why. */
export interface PolicyProblem {
  readonly variable: string;
  readonly value: string;
  readonly reason: string;
}

type Parsed = { kind: 'unset' } | { kind: 'ok'; value: number } | { kind: 'bad'; raw: string };

/** Parse a bound: a positive integer no greater than {@link MAX_POLICY_BOUND}, floored first. */
function parseBound(raw: string | undefined): Parsed {
  const trimmed = raw?.trim();
  if (!trimmed) return { kind: 'unset' };
  const n = Math.floor(Number(trimmed));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_POLICY_BOUND) return { kind: 'bad', raw: trimmed };
  return { kind: 'ok', value: n };
}

const LEGACY = [
  'RAYSPEC_AGENT_RUN_MAX_MS',
  'RAYSPEC_AGENT_REQUEST_TIMEOUT_MS',
  'RAYSPEC_AGENT_MAX_ATTEMPTS',
  'RAYSPEC_RUN_CANCEL_POLL_MS',
] as const;

const ADDED = [
  'RAYSPEC_AGENT_KILL_GRACE_MS',
  'RAYSPEC_AGENT_QUEUE_MAX',
  'RAYSPEC_AGENT_QUEUE_MAX_PER_TENANT',
  'RAYSPEC_AGENT_WORKER_CONCURRENCY',
  'RAYSPEC_AGENT_SYNC_RUNS_MAX',
] as const;

/** Every variable the policy reads, in the order the problems are reported. */
export const EXECUTION_POLICY_VARIABLES: readonly string[] = [...LEGACY, ...ADDED];

function postureOf(env: NodeJS.ProcessEnv): 'local' | 'managed' {
  return env.RAYSPEC_HOSTING_POSTURE?.trim() === 'managed' ? 'managed' : 'local';
}

/**
 * The variables whose values cannot be used. The boot refuses on any of them; {@link
 * resolveExecutionPolicy} never throws, so a caller that only needs the values (run-core, per run)
 * reads them without re-checking.
 *
 * Outside the managed posture the four variables that predate the policy are not reported: their
 * contract has always been that an unusable value means "not set".
 */
export function executionPolicyProblems(env: NodeJS.ProcessEnv = process.env): PolicyProblem[] {
  const managed = postureOf(env) === 'managed';
  const checked: readonly string[] = managed ? EXECUTION_POLICY_VARIABLES : ADDED;
  const problems: PolicyProblem[] = [];
  for (const variable of checked) {
    const parsed = parseBound(env[variable]);
    if (parsed.kind === 'bad') {
      problems.push({
        variable,
        value: parsed.raw,
        reason: `must be a whole number from 1 to ${MAX_POLICY_BOUND}`,
      });
    }
  }
  return problems;
}

/** The boot refusal text for the problems {@link executionPolicyProblems} found. */
export function executionPolicyProblemMessage(problems: readonly PolicyProblem[]): string {
  return (
    'Boot aborted — the execution policy cannot be read: ' +
    problems.map((p) => `${p.variable}='${p.value}' ${p.reason}`).join('; ') +
    '.'
  );
}

function resolveValue(
  env: NodeJS.ProcessEnv,
  variable: string,
  managedDefault: number | undefined,
  managed: boolean,
): PolicyValue {
  const parsed = parseBound(env[variable]);
  if (parsed.kind === 'ok') return { value: parsed.value, source: 'explicit' };
  if (managed && managedDefault !== undefined) {
    return { value: managedDefault, source: 'hosting-posture' };
  }
  return { value: undefined, source: 'off' };
}

/**
 * Resolve the execution policy from the environment. Never throws: an unusable value resolves as if
 * it were unset (the boot is what refuses it, through {@link executionPolicyProblems}).
 */
export function resolveExecutionPolicy(env: NodeJS.ProcessEnv = process.env): ExecutionPolicy {
  const posture = postureOf(env);
  const managed = posture === 'managed';
  const grace = parseBound(env.RAYSPEC_AGENT_KILL_GRACE_MS);
  const concurrency = parseBound(env.RAYSPEC_AGENT_WORKER_CONCURRENCY);
  return {
    posture,
    runMaxMs: resolveValue(env, 'RAYSPEC_AGENT_RUN_MAX_MS', MANAGED_DEFAULTS.runMaxMs, managed),
    requestTimeoutMs: resolveValue(
      env,
      'RAYSPEC_AGENT_REQUEST_TIMEOUT_MS',
      MANAGED_DEFAULTS.requestTimeoutMs,
      managed,
    ),
    maxAttempts: resolveValue(
      env,
      'RAYSPEC_AGENT_MAX_ATTEMPTS',
      MANAGED_DEFAULTS.maxAttempts,
      managed,
    ),
    killGraceMs: grace.kind === 'ok' ? grace.value : DEFAULT_AGENT_KILL_GRACE_MS,
    queueMax: resolveValue(env, 'RAYSPEC_AGENT_QUEUE_MAX', MANAGED_DEFAULTS.queueMax, managed),
    queueMaxPerTenant: resolveValue(
      env,
      'RAYSPEC_AGENT_QUEUE_MAX_PER_TENANT',
      MANAGED_DEFAULTS.queueMaxPerTenant,
      managed,
    ),
    workerConcurrency:
      concurrency.kind === 'ok' ? concurrency.value : DEFAULT_AGENT_WORKER_CONCURRENCY,
    syncRunsMax: resolveValue(
      env,
      'RAYSPEC_AGENT_SYNC_RUNS_MAX',
      MANAGED_DEFAULTS.syncRunsMax,
      managed,
    ),
    cancelPollMs: resolveValue(
      env,
      'RAYSPEC_RUN_CANCEL_POLL_MS',
      MANAGED_DEFAULTS.cancelPollMs,
      managed,
    ),
  };
}

/**
 * The limits a backend applies to its own provider calls, as run-core threads them onto
 * `RunContext.limits`: the provider-call timeout (absent = the backend's own default) and the kill
 * grace.
 */
export function runLimitsOf(policy: ExecutionPolicy): {
  providerCallTimeoutMs?: number;
  killGraceMs: number;
} {
  return {
    ...(policy.requestTimeoutMs.value === undefined
      ? {}
      : { providerCallTimeoutMs: policy.requestTimeoutMs.value }),
    killGraceMs: policy.killGraceMs,
  };
}
