/**
 * Neutral abort plumbing — one helper, shared by the adapters that own a cancellable resource.
 *
 * `AbortSignal` is already the neutral vocabulary at this boundary (a tool handler receives one, and a
 * RunContext carries the run's), so an adapter that owns an `AbortController` — for the SDK call, the
 * spawned child process, or the session it holds — needs exactly one thing: link the run's signal to
 * the controller it already has, so ending a run tears that resource down instead of waiting for the
 * run to finish. Three adapters need it; writing it three times is how the already-aborted case gets
 * forgotten in one of them.
 */

/**
 * Link `source` to `target`: abort the target when the source aborts, INCLUDING when the source has
 * already aborted by the time this is called. Returns an unlink function the caller runs in its
 * teardown; it is safe to call more than once, and a no-op when there was no source signal.
 */
export function linkAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    target.abort();
    return () => {};
  }
  const onAbort = () => target.abort();
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

/**
 * Run `onAbort` when `source` aborts (including when it already has) — for a resource whose stop is a
 * CALL rather than a controller (a session's `abort()`). Returns the same unlink contract as
 * {@link linkAbort}. The callback is invoked at most once and must not throw: an adapter's teardown is
 * the wrong place to surface a new failure, so the caller swallows what the stop reports.
 */
export function onAbortSignal(source: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    onAbort();
    return () => {};
  }
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

/**
 * Raised (or recorded) when a provider call outlives `RunLimits.providerCallTimeoutMs`. The class NAME
 * carries `Timeout`, which is what `classifyUpstreamError` keys the neutral `timeout` class off.
 */
export class ProviderCallTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(backend: string, timeoutMs: number) {
    super(
      `the ${backend} provider call did not answer within ${timeoutMs}ms ` +
        '(RAYSPEC_AGENT_REQUEST_TIMEOUT_MS) and was stopped.',
    );
    this.name = 'ProviderCallTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** A running provider-call watchdog (see {@link startCallWatchdog}). */
export interface CallWatchdog {
  /** The call produced output: start the silence window again. */
  touch(): void;
  /** Stop counting (a tool call the platform bounds itself is in progress). */
  pause(): void;
  /** Count again after {@link pause}, from a fresh window. */
  resume(): void;
  /** Whether the watchdog fired. */
  readonly fired: boolean;
  /** Stop the watchdog for good. Idempotent. */
  dispose(): void;
}

/**
 * Watch a provider call for SILENCE: when `timeoutMs` passes with no {@link CallWatchdog.touch},
 * `onTimeout` runs once. For a backend whose call is a stream or a child process, silence is the one
 * measure of "the provider stopped answering" that does not also cut off a long but productive run.
 * `timeoutMs` undefined yields an inert watchdog. The timer is unref'd, so it never holds a process
 * open on its own.
 */
export function startCallWatchdog(
  timeoutMs: number | undefined,
  onTimeout: () => void,
): CallWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  let live = timeoutMs !== undefined;
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!live || timeoutMs === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!live) return;
      live = false;
      fired = true;
      onTimeout();
    }, timeoutMs);
    timer.unref?.();
  };
  let paused = 0;
  arm();
  return {
    touch() {
      if (paused === 0) arm();
    },
    pause() {
      paused += 1;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    resume() {
      paused = Math.max(0, paused - 1);
      if (paused === 0) arm();
    },
    get fired() {
      return fired;
    },
    dispose() {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
