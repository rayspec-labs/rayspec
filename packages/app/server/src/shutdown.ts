/**
 * BOUNDED GRACEFUL SHUTDOWN.
 *
 * `http.Server.close()` stops accepting connections and then waits for every open one to end — with
 * no bound. One client that keeps a request open (a stalled upload, an event stream, a socket that
 * sent half a request) therefore kept a stopping server alive for as long as it liked, and the
 * entrypoint's exit never came.
 *
 * `shutdownHttpServer` bounds it: stop accepting, close the idle keep-alive connections at once, let
 * in-flight requests finish for up to `drainMs`, then close every connection still open. Only then
 * does it close the application (the durable worker drain and the database pool), itself bounded by
 * the same drain so a job that never finishes cannot hold the process either. It reports what it had
 * to force, so the entrypoint can say so.
 */

/** The part of a Node HTTP server this needs. */
export interface DrainableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export interface ShutdownOutcome {
  /** Connections were still open when the drain ran out and were closed. */
  forcedConnections: boolean;
  /** The application's own close finished within its bound. */
  appClosed: boolean;
}

function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  return Promise.race([work.then((value) => ({ done: true as const, value })), timeout]).finally(
    () => clearTimeout(timer),
  );
}

/**
 * Stop `server` within `drainMs`, then close the application within the same bound. Never rejects:
 * a failing application close counts as not closed.
 */
export async function shutdownHttpServer(
  server: DrainableServer,
  closeApp: () => Promise<void>,
  opts: { drainMs: number; log?: (message: string) => void },
): Promise<ShutdownOutcome> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  server.closeIdleConnections?.();
  let forcedConnections = false;
  const drained = await within(closed, opts.drainMs);
  if (!drained.done) {
    forcedConnections = true;
    log(`[shutdown] connections were still open after the ${opts.drainMs} ms drain; closing them`);
    server.closeAllConnections?.();
    await closed;
  }
  const app = await within(
    closeApp().then(
      () => true,
      () => false,
    ),
    Math.max(opts.drainMs, 1_000),
  );
  const appClosed = app.done && app.value;
  if (!appClosed) log('[shutdown] the application did not close cleanly within the drain');
  return { forcedConnections, appClosed };
}
