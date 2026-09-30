/**
 * THE HTTP HALF OF A SOURCE FENCE — what the app does while the runtime is fenced for an export or
 * a migration.
 *
 *  - A MUTATION (any method other than GET, HEAD and OPTIONS: store writes, uploads, trigger fires,
 *    run starts, auth changes, the OIDC token endpoint) is refused with 503 `SERVICE_UNAVAILABLE` and
 *    a `Retry-After` header, before authentication and before any handler runs. Reads continue.
 *  - A STREAMING response (`text/event-stream`) is closed after the chunk in flight when the drain
 *    starts; one that would start while the runtime is fenced is refused with the same 503.
 *  - Every admitted mutation is counted from admission to its end (the end of its body, for a
 *    streaming one), so the drain knows when the requests already running have finished.
 *
 * The middleware sits in front of every route, so no route can forget it. The fence itself — its
 * state, the drain and the resume — belongs to the runtime; the app sees only this interface.
 */
import { errorEnvelope } from '@rayspec/auth-core';
import type { MiddlewareHandler } from 'hono';
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
 * the stream ends for any reason (finished, cancelled by the client, or closed by the drain).
 */
export function closeOnDrain(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEnd: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  let closed = false;
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
  function onAbort(): void {
    reader.cancel().catch(() => {});
    close();
    end();
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
      end();
      return reader.cancel(reason);
    },
  });
}

/** The middleware: refuse mutations and new streams while fenced; count and close what runs. */
export function writeFenceMiddleware(fence: WriteFence): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const mutation = !SAFE_METHODS.has(c.req.method.toUpperCase());
    const refuse = () => {
      const rid = c.get('requestId') ?? 'unknown';
      return c.json(errorEnvelope('SERVICE_UNAVAILABLE', FENCED_MESSAGE, rid), 503, {
        'Retry-After': String(fence.retryAfterSeconds()),
      });
    };
    if (mutation && !fence.admitsWrites()) return refuse();

    const done = mutation ? fence.begin() : () => {};
    let handedToStream = false;
    try {
      await next();
      const res = c.res;
      if (res.body !== null && isEventStream(res)) {
        if (!fence.admitsWrites()) {
          await res.body.cancel().catch(() => {});
          c.res = undefined;
          c.res = refuse();
          return;
        }
        handedToStream = true;
        const stream = closeOnDrain(res.body, fence.drainSignal(), done);
        c.res = undefined;
        c.res = new Response(stream, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
    } finally {
      if (!handedToStream) done();
    }
  };
}
