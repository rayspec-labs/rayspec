/**
 * Agent-run bounds — the per-run bounds run-core and the composition root read.
 *
 *   RAYSPEC_AGENT_REQUEST_TIMEOUT_MS  per provider call (the adapters carry it onto their clients,
 *                                     streams and child processes)
 *   RAYSPEC_AGENT_MAX_ATTEMPTS        how many attempts an HTTP model client makes for one request
 *   RAYSPEC_AGENT_RUN_MAX_MS          wall clock for one whole run; when it expires the run's signal
 *                                     is aborted, so the backend is told to stop
 *   RAYSPEC_RUN_CANCEL_POLL_MS        how often an executing run re-reads its own cancellation
 *                                     marker, so a cancellation issued in another process reaches it
 *
 * The resolution rule — parsing, the managed posture's defaults, what an unusable value means — is the
 * execution policy's (execution-policy.ts); the functions here read one value off it. Outside the
 * managed posture all four are off unless set, so a deployment that sets none behaves as it did
 * before they existed, and an absent, non-numeric or out-of-range value (anything outside 1 …
 * 2147483647 after flooring) leaves the run as unbounded as an unset one.
 */
import { MANAGED_DEFAULTS, resolveExecutionPolicy } from './execution-policy.js';

/**
 * The per-request timeout for the model client, in milliseconds (`RAYSPEC_AGENT_REQUEST_TIMEOUT_MS`,
 * or the managed posture's default — see execution-policy.ts). Undefined ⇒ the client keeps its own
 * default.
 */
export function resolveAgentRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  return resolveExecutionPolicy(env).requestTimeoutMs.value;
}

/**
 * How many attempts the model client makes for one request (`RAYSPEC_AGENT_MAX_ATTEMPTS`, or the
 * managed posture's default) — the first try plus its retries, so 1 means a single attempt.
 * Undefined ⇒ the client keeps its own default.
 */
export function resolveAgentMaxAttempts(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return resolveExecutionPolicy(env).maxAttempts.value;
}

/**
 * The wall-clock upper bound for one whole run, in milliseconds (`RAYSPEC_AGENT_RUN_MAX_MS`, or the
 * managed posture's default). Undefined ⇒ run-core waits for the backend as long as it takes (the
 * behaviour of a local posture without the variable).
 */
export function resolveRunMaxMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return resolveExecutionPolicy(env).runMaxMs.value;
}

/**
 * The cancellation poll interval under the managed hosting posture when `RAYSPEC_RUN_CANCEL_POLL_MS`
 * does not set one: a cancellation issued anywhere reaches a run executing in another worker process
 * within about two seconds, for one indexed read per executing run per interval.
 */
export const MANAGED_RUN_CANCEL_POLL_MS = MANAGED_DEFAULTS.cancelPollMs;

/** Where the cancellation poll interval came from. */
export type RunCancelPollSource = 'explicit' | 'hosting-posture' | 'off';

/**
 * How often a run that is EXECUTING re-reads its own persisted cancellation marker, and why: the value
 * of `RAYSPEC_RUN_CANCEL_POLL_MS` when it is set (`explicit`); otherwise, under
 * `RAYSPEC_HOSTING_POSTURE=managed`, {@link MANAGED_RUN_CANCEL_POLL_MS} (`hosting-posture`), because a
 * managed runtime must stop a run wherever it executes; otherwise undefined (`off`).
 *
 * The posture value is read raw here: the boot validates it (`parseHostingPosture` refuses anything
 * but `local` and `managed`), and a value that is not exactly `managed` leaves the default off.
 */
export function resolveRunCancelPoll(env: NodeJS.ProcessEnv = process.env): {
  intervalMs: number | undefined;
  source: RunCancelPollSource;
} {
  const resolved = resolveExecutionPolicy(env).cancelPollMs;
  if (resolved.source === 'explicit') return { intervalMs: resolved.value, source: 'explicit' };
  if (resolved.source === 'hosting-posture') {
    return { intervalMs: resolved.value, source: 'hosting-posture' };
  }
  return { intervalMs: undefined, source: 'off' };
}

/**
 * How often a run that is EXECUTING re-reads its own persisted cancellation marker, in milliseconds
 * (`RAYSPEC_RUN_CANCEL_POLL_MS`, or the managed posture's default — {@link resolveRunCancelPoll}).
 * Undefined ⇒ it is never re-read while the run waits, which is the behaviour of a local posture
 * without the variable: a cancellation reaches an executing run only through the process-local
 * signal, so a run executing in ANOTHER process is not interrupted by it.
 *
 * There is deliberately NO floor and NO clamp: the parser above is the whole rule. A floor would
 * silently substitute a longer interval than the operator wrote — the same surprise the out-of-range
 * rule refuses to inflict — and would quietly disable the feature for anyone who asked for something
 * shorter than it.
 */
export function resolveRunCancelPollMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return resolveRunCancelPoll(env).intervalMs;
}

/**
 * Raised when a run outlives `RAYSPEC_AGENT_RUN_MAX_MS`. The class NAME is load-bearing:
 * `classifyUpstreamError` keys the neutral `timeout` class off `/Timeout|MaxTurnsExceeded/`, so a
 * bounded run surfaces as `timeout` rather than a generic internal error.
 */
export class RunBoundTimeoutError extends Error {
  readonly runId: string;
  readonly boundMs: number;
  constructor(runId: string, boundMs: number) {
    super(runBoundTimeoutMessage(runId, boundMs));
    this.name = 'RunBoundTimeoutError';
    this.runId = runId;
    this.boundMs = boundMs;
  }
}

/**
 * Why a run was given up on. Both reasons leave the SAME situation — `runAgent` has rejected while the
 * backend call it stopped waiting for is still in flight and still holding the RunContext — so both
 * make the run's seams inert; they differ only in what the refusal says happened.
 */
export type RunAbandonReason = 'bound' | 'cancelled';

/**
 * Raised when a seam of an ABANDONED run is used: `runAgent` has rejected — because the wall-clock
 * bound fired, or because the run was cancelled — and the backend call it stopped waiting for is still
 * in flight and still holding the RunContext. A run that was given up on writes nothing further: its
 * outcome is recorded once, by run-core, and a late write from the call it abandoned would contradict
 * it — so run-core refuses the call.
 */
export class RunAbandonedError extends Error {
  readonly runId: string;
  /** The seam that was called, e.g. `journal.record` — named so the refusal is diagnosable. */
  readonly seam: string;
  /** Why the run was given up on — so the refusal names the real cause, not a presumed one. */
  readonly reason: RunAbandonReason;
  constructor(runId: string, seam: string, reason: RunAbandonReason = 'bound') {
    super(
      reason === 'cancelled'
        ? `${seam} was called for run ${runId} after the run was cancelled and given up on. The ` +
            'call is refused: a cancelled run writes nothing further.'
        : `${seam} was called for run ${runId} after the RAYSPEC_AGENT_RUN_MAX_MS bound fired and ` +
            'the run was given up on. The call is refused: an abandoned run writes nothing further.',
    );
    this.name = 'RunAbandonedError';
    this.runId = runId;
    this.seam = seam;
    this.reason = reason;
  }
}

/** The operator-facing message: what expired, and what it did and did not stop. */
export function runBoundTimeoutMessage(runId: string, boundMs: number): string {
  return (
    `run ${runId} exceeded the RAYSPEC_AGENT_RUN_MAX_MS bound of ${boundMs}ms and was ended. The ` +
    "run's signal was aborted, so a backend that honours it stops its provider call; the run's " +
    'record says whether the call was stopped. Raise RAYSPEC_AGENT_RUN_MAX_MS if legitimate runs ' +
    'need longer.'
  );
}

/**
 * Race `work` against a `boundMs` deadline. Resolves with `work`'s value when it finishes in time;
 * rejects with a {@link RunBoundTimeoutError} when the deadline fires first. The timer is cleared
 * once the race settles and is unref'd, so it can never on its own keep the process alive.
 *
 * When the deadline wins, `work` is still pending. `Promise.race` has already subscribed to it, so
 * its eventual rejection counts as handled and cannot surface as an unhandled rejection.
 */
export async function withRunBound<T>(
  work: PromiseLike<T>,
  boundMs: number,
  runId: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunBoundTimeoutError(runId, boundMs)), boundMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
