/**
 * Agent-run bounds — the optional upper bounds an operator can put on an agent run.
 *
 * Four variables, all OFF unless set, so a deployment that sets none behaves exactly as it did
 * before they existed:
 *
 *   RAYSPEC_AGENT_REQUEST_TIMEOUT_MS  per HTTP request the model client makes (the OpenAI adapter
 *                                     carries it onto the client it registers)
 *   RAYSPEC_AGENT_MAX_ATTEMPTS        how many attempts that client makes for one request
 *   RAYSPEC_AGENT_RUN_MAX_MS          wall clock run-core waits for one whole run
 *   RAYSPEC_RUN_CANCEL_POLL_MS        how often an executing run re-reads its own cancellation
 *                                     marker, so a cancellation issued in another process reaches it
 *
 * The parsing rule is the one `resolveBootTimeoutMs` uses for RAYSPEC_BOOT_TIMEOUT_MS: trim, parse,
 * and fall back to the default on anything unusable. Here the default is "off", so an absent or
 * non-numeric value — and any value outside 1 … {@link MAX_BOUND} after flooring — leaves the run
 * exactly as unbounded, and as unwatched, as it is today.
 */

/**
 * The largest value any of these variables may carry: the largest delay a timer can hold.
 *
 * A timer given a longer delay does not wait longer — it fires after 1ms (Node warns
 * `TimeoutOverflowWarning: … does not fit into a 32-bit signed integer. Timeout duration was set to
 * 1.`). Accepting such a value would therefore INVERT the bound it configures: a ceiling meant to be
 * generous would abandon every run after a millisecond. The same ceiling is applied to the attempt
 * COUNT, which no timer holds, so that one rule covers all four variables — and a request-attempt
 * count above two billion is not a configuration anyone means.
 */
const MAX_BOUND = 2_147_483_647;

/**
 * Parse a bound value: a positive integer no greater than {@link MAX_BOUND}. Anything else — absent,
 * non-numeric, 0, negative, or too large — is "not set", which every consumer reads as NO bound.
 *
 * The floor runs BEFORE the range check, so the number that is range-checked is exactly the number
 * the caller gets. Checking first would let any 0 < v < 1 (`0.5`, `0.001`) pass the check and then
 * floor to 0 — the sentinel this contract calls "not set", but as a NUMBER, so every consumer would
 * take it as a live bound of zero: a run ceiling of 0ms, an attempt count of 0 that maps to a
 * negative retry count, or a cancellation poll that re-reads its marker as fast as the event loop
 * will hand it a turn.
 *
 * Out-of-range collapses to "not set" rather than clamping to {@link MAX_BOUND}: a ceiling above
 * 24.8 days and no ceiling at all express the same intent, so treating them alike keeps the contract
 * to one sentence, and silently substituting a different number than the operator wrote is the kind
 * of surprise these variables exist to remove.
 */
function positiveInt(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const n = Math.floor(Number(trimmed));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_BOUND) return undefined;
  return n;
}

/**
 * The per-request timeout for the model client, in milliseconds (`RAYSPEC_AGENT_REQUEST_TIMEOUT_MS`).
 * Undefined ⇒ the client keeps its own default.
 */
export function resolveAgentRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  return positiveInt(env.RAYSPEC_AGENT_REQUEST_TIMEOUT_MS);
}

/**
 * How many attempts the model client makes for one request (`RAYSPEC_AGENT_MAX_ATTEMPTS`) — the
 * first try plus its retries, so 1 means a single attempt. Undefined ⇒ the client keeps its own
 * default.
 */
export function resolveAgentMaxAttempts(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveInt(env.RAYSPEC_AGENT_MAX_ATTEMPTS);
}

/**
 * The wall-clock upper bound for one whole run, in milliseconds (`RAYSPEC_AGENT_RUN_MAX_MS`).
 * Undefined ⇒ run-core waits for the backend as long as it takes (the behaviour before this
 * variable existed).
 */
export function resolveRunMaxMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveInt(env.RAYSPEC_AGENT_RUN_MAX_MS);
}

/**
 * How often a run that is EXECUTING re-reads its own persisted cancellation marker, in milliseconds
 * (`RAYSPEC_RUN_CANCEL_POLL_MS`). Undefined ⇒ it is never re-read while the run waits, which is the
 * behaviour before this variable existed: a cancellation reaches an executing run only through the
 * process-local signal, so a run executing in ANOTHER process is not interrupted by it.
 *
 * There is deliberately NO floor and NO clamp: the parser above is the whole rule. A floor would
 * silently substitute a longer interval than the operator wrote — the same surprise the out-of-range
 * rule refuses to inflict — and would quietly disable the feature for anyone who asked for something
 * shorter than it.
 */
export function resolveRunCancelPollMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveInt(env.RAYSPEC_RUN_CANCEL_POLL_MS);
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
 * in flight and still holding the RunContext. Every seam on that context is bound to the run's
 * `TenantDb` — on the durable path the run's transaction, which is rolled back the moment `runAgent`
 * rejects — so run-core refuses the call rather than issuing a statement through a handle the run no
 * longer owns.
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
    `run ${runId} exceeded the RAYSPEC_AGENT_RUN_MAX_MS bound of ${boundMs}ms and was given up on. ` +
    'The bound stops run-core waiting; it does not cancel the model call, which continues until it ' +
    'settles on its own. Raise RAYSPEC_AGENT_RUN_MAX_MS if legitimate runs need longer.'
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
