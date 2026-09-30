/**
 * THE HTTP HALF OF A SOURCE FENCE — what the app does while the runtime is fenced for an export or
 * a migration.
 *
 *  - A MUTATION is refused with 503 `SERVICE_UNAVAILABLE` and a `Retry-After` header, before
 *    authentication and before any handler runs. A mutation is any request whose method is not GET,
 *    HEAD or OPTIONS (store writes, uploads, trigger fires, run starts, auth changes, the OIDC token
 *    endpoint) — and any request to a declared route whose ACTION can write, whatever its method: a
 *    store create, update or delete, an agent run, a handler that is not declared read-only, a stream
 *    ingest. Those routes carry their own guard (`writeRouteGuard`), because only the route knows its
 *    action. Reads continue.
 *  - A STREAMING response (`text/event-stream`) is closed after the chunk in flight when the drain
 *    starts; a new read stream that would start while the runtime is fenced is refused with the same
 *    503.
 *  - Every admitted mutation is counted from admission until its work has ENDED. For a streaming one
 *    that is when the handler behind the stream finishes, not when the client's stream closes: the
 *    drain (or a client that goes away) closes the client's stream at once, while the handler keeps
 *    running to its end — a run that was started is never cut off half way — and stays counted, so
 *    the drain does not report the process drained while it still writes.
 *
 * The middleware sits in front of every route, so no route can forget it. The fence itself — its
 * state, the drain and the resume — belongs to the runtime; the app sees only this interface.
 */
import { errorEnvelope } from '@rayspec/auth-core';
import type { Context, MiddlewareHandler, Next } from 'hono';
import type { AppEnv } from '../app-context.js';

/** The runtime's source fence, as the HTTP surface sees it. */
export interface WriteFence {
  /** Whether a mutation, or a new stream, may start now. */
  admitsWrites(): boolean;
  /** Whole seconds a refused client should wait before it retries (the `Retry-After` value). */
  retryAfterSeconds(): number;
  /** Count one admitted request as in flight; the returned function ends it (idempotent). */
  begin(): () => void;
  /** Aborts when the runtime starts draining: every open stream closes on it. */
  drainSignal(): AbortSignal;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The message a fenced runtime answers with. It names no topology and no reason. */
export const FENCED_MESSAGE =
  'The service is paused for maintenance and accepts no changes right now. Retry later.';

function isEventStream(res: Response): boolean {
  const type = res.headers.get('content-type') ?? '';
  return type.toLowerCase().startsWith('text/event-stream');
}

/**
 * Wrap a stream so it closes, after the chunk in flight, when `signal` aborts; `onEnd` runs once when
 * the stream ends. By default the stream behind it is cancelled on the drain or when the client goes
 * away, and `onEnd` runs then. With `runToEnd` (a mutation's stream) the client's stream still closes
 * at once, but the stream behind it is read to its end and discarded, and `onEnd` runs only when it
 * has ended — when the handler producing it has finished.
 */
export function closeOnDrain(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEnd: () => void,
  options: { runToEnd?: boolean } = {},
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const runToEnd = options.runToEnd === true;
  let ended = false;
  let closed = false;
  let discarding = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const end = () => {
    if (ended) return;
    ended = true;
    signal.removeEventListener('abort', onAbort);
    onEnd();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      controller?.close();
    } catch {
      // already closed or errored
    }
  };
  /** Read the stream behind to its end without passing anything on, then end. */
  const discardRest = () => {
    if (discarding) return;
    discarding = true;
    void (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // the producer failed: its work has ended all the same
      }
      end();
    })();
  };
  const stopReading = (reason?: unknown): Promise<void> => {
    if (runToEnd) {
      discardRest();
      return Promise.resolve();
    }
    end();
    return reader.cancel(reason).catch(() => {});
  };
  function onAbort(): void {
    close();
    void stopReading();
  }
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(c) {
      if (closed) return;
      try {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) {
          close();
          end();
          return;
        }
        c.enqueue(value);
      } catch (err) {
        end();
        if (!closed) {
          closed = true;
          c.error(err);
        }
      }
    },
    cancel(reason) {
      closed = true;
      return stopReading(reason);
    },
  });
}

/**
 * The fence around one request. `writes` says whether the request can write: a refused one gets the
 * 503, an admitted one is counted until its work ends. A read's stream is closed on the drain and,
 * when it would start while fenced, refused.
 */
async function fenced(
  fence: WriteFence,
  c: Context<AppEnv>,
  next: Next,
  writes: boolean,
): Promise<Response | undefined> {
  const refuse = () => {
    const rid = c.get('requestId') ?? 'unknown';
    return c.json(errorEnvelope('SERVICE_UNAVAILABLE', FENCED_MESSAGE, rid), 503, {
      'Retry-After': String(fence.retryAfterSeconds()),
    });
  };
  if (writes && !fence.admitsWrites()) return refuse();
  const done = writes ? fence.begin() : () => {};
  let handedToStream = false;
  try {
    await next();
    // A declared writing route fenced this request itself (`writeRouteGuard`): nothing is left here.
    if (!writes && c.get('fenceGuarded') === true) return undefined;
    const res = c.res;
    if (res.body !== null && isEventStream(res)) {
      if (!writes && !fence.admitsWrites()) {
        await res.body.cancel().catch(() => {});
        c.res = undefined;
        c.res = refuse();
        return undefined;
      }
      // An admitted mutation's stream is passed on even when the drain began after it was admitted:
      // its work is running and stays counted until it ends; the client's stream closes at once.
      handedToStream = true;
      const stream = closeOnDrain(res.body, fence.drainSignal(), done, { runToEnd: writes });
      c.res = undefined;
      c.res = new Response(stream, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
    return undefined;
  } finally {
    if (!handedToStream) done();
  }
}

/** The middleware: refuse mutations and new streams while fenced; count and close what runs. */
export function writeFenceMiddleware(fence: WriteFence): MiddlewareHandler<AppEnv> {
  return (c, next) => fenced(fence, c, next, !SAFE_METHODS.has(c.req.method.toUpperCase()));
}

/**
 * The guard a declared route whose action can write carries in front of its chain: a GET, HEAD or
 * OPTIONS request to it is fenced as a mutation (refused while fenced, counted while it runs). Any
 * other method is a mutation to the app-wide middleware already, so the guard passes it through.
 */
export function writeRouteGuard(fence: WriteFence): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }
    c.set('fenceGuarded', true);
    return fenced(fence, c, next, true);
  };
}
