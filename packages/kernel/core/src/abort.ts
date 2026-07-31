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
