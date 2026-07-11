/**
 * The PLAYBACK route's own middleware tuple — the SECOND auth path + the
 * per-user streaming semaphore. Mounted on the playback route via `registerOn` (its OWN tuple), so it
 * does NOT run on any other route and does NOT touch `resolveTenant`/`tenant-db.ts` (byte-unchanged).
 *
 * Two middlewares, in order:
 *   1. `mediaAuth(service)` — verify the `?token=` media-JWT (HS256, distinct key; alg-pinned), and on
 *      success set `principal` + `tenantId` from the TOKEN (never from `resolveTenant`). The playback
 *      route is NOT on the RS256/Bearer chain — a normal API token does not authenticate it, and a
 *      media token does not authenticate any API route (the two key chains are disjoint).
 *   2. `perUserStreamSemaphore(...)` — bound the number of CONCURRENT playback streams per user
 *      (in-process `Map<userId,count>`); saturation → 429 + `Retry-After`. A permit is released when
 *      the streamed response body ends OR the client disconnects (a `finally`/close hook — never leak a
 *      permit on a mid-stream abort).
 *
 * The tenant the media token asserts is NOT trusted to serve bytes: the playback HANDLER re-validates
 * the requested resource's ACTUAL owning tenant against the DB (through the tenant-bound `init.db`)
 * before streaming. This middleware only AUTHENTICATES the token + bounds concurrency.
 */

import { ApiError, unauthenticated } from '@rayspec/auth-core';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app-context.js';
import type { MediaTokenService } from './media-token.js';

/** The query-param name carrying the media token (`?token=...`). */
const MEDIA_TOKEN_PARAM = 'token';

/**
 * The media-JWT verifier middleware. Reads `?token=`, verifies it (alg-pinned HS256, signature, exp,
 * denylist), and on success sets `principal` (a synthetic `apikey`-kind principal scoped to nothing —
 * it carries NO API scopes, so even if it somehow reached an API authz check it would be denied) +
 * `tenantId` from the verified claims. A missing/invalid/expired/forged/revoked token → a UNIFORM 401
 * (no enumeration: forged, expired, wrong-alg, and absent all return the same generic failure). The
 * verified `resource` + `sub` are stashed for the handler/semaphore via context vars.
 */
export function mediaAuth(service: MediaTokenService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = c.req.query(MEDIA_TOKEN_PARAM);
    if (!token) throw unauthenticated();
    const result = await service.verify(token);
    if (!result.ok) {
      // result.reason is logged-out-of-band-worthy (malformed/bad_signature/alg_rejected/expired/
      // revoked) but the client sees ONE uniform 401 — never which check failed (no oracle).
      throw unauthenticated();
    }
    const { tenantId, resource, sub } = result.claims;
    // The media principal: a synthetic, API-powerless principal. It carries NO scopes + the apikey kind
    // (so the normal authz path, were it ever reached, would deny every API permission — the media key
    // is for THIS route only). `userId` = the token's sub (the per-user semaphore keys off it).
    c.set('principal', { kind: 'apikey', orgId: tenantId, userId: sub, scopes: [] });
    // tenantId set DIRECTLY from the token (this route does NOT run resolveTenant). The handler
    // RE-VALIDATES resource ownership in the DB before serving bytes — the claim is not trusted alone.
    c.set('tenantId', tenantId);
    // The resource the token authorizes (opaque) — the handler reads it to scope the DB ownership check.
    c.set('mediaResource', resource);
    await next();
  };
}

/**
 * A per-user, per-node CONCURRENT-stream semaphore. Bounds how many playback streams ONE user may have
 * open at once (default `maxPerUser`); the (N+1)th request is rejected 429 + `Retry-After` rather than
 * piling unbounded streams onto the node. A permit is acquired BEFORE the handler runs and released
 * when the response body finishes OR the client disconnects.
 *
 * PER-NODE (honest): the counter is an in-process `Map` — a future multi-node deploy would need a
 * shared/distributed counter (like the per-user rate limiter). Documented as a per-node bound.
 *
 * PERMIT RELEASE (no leak on disconnect, no hold on error): a permit is held across the response only
 * for a GENUINE streaming SUCCESS (a 200/206 with a body). For such a response the body is a
 * `ReadableStream`; we wrap it so the permit is released exactly once when the stream CLOSES (normal
 * end), ERRORS, or is CANCELLED (the client disconnected mid-stream — Hono/undici cancel the response
 * body's reader). EVERY other outcome releases the permit immediately after `next()`:
 *   - a non-2xx error envelope (304/400/403/404/416/500) — these carry a tiny body that the client may
 *     never consume, so we must NOT gate release on body consumption (else a self-DoS: a user who fires
 *     N+ unread 416/403/404 pins their own per-user budget until each tiny body is read);
 *   - the throw-after-`next()` case: when a downstream handler THROWS and a global `onError` is
 *     registered (it is — app.ts), Hono catches the throw INTERNALLY, routes it to `onError`, and
 *     `await next()` RETURNS (it does NOT reject) — so the local `catch` below never fires. Hono exposes
 *     the thrown error on `c.error` before `onError` runs; we detect it and release immediately.
 * Idempotent release (a guard flag) means double signals (cancel-then-error) never under-count.
 */
export function perUserStreamSemaphore(opts: {
  /** Max concurrent streams per user (default 4). */
  maxPerUser?: number;
  /** Retry-After seconds advertised on a 429 (default 5). */
  retryAfterSeconds?: number;
  /** Shared in-process counter (inject for tests; default a fresh Map). */
  counts?: Map<string, number>;
}): MiddlewareHandler<AppEnv> {
  const maxPerUser = opts.maxPerUser ?? DEFAULT_MAX_STREAMS_PER_USER;
  const retryAfter = String(opts.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS);
  const counts = opts.counts ?? new Map<string, number>();

  return async (c, next) => {
    // mediaAuth ran first → a user id is present (the token's sub). Defensive: no principal ⇒ 401.
    const userId = c.get('principal')?.userId;
    if (!userId) throw unauthenticated();

    const current = counts.get(userId) ?? 0;
    if (current >= maxPerUser) {
      // Saturated: do NOT acquire; reject with 429 + Retry-After (set the header explicitly — the
      // generic ApiError→envelope path does not emit Retry-After, and the contract requires it).
      return c.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many concurrent streams for this user.',
            requestId: c.get('requestId') ?? 'unknown',
          },
        },
        429,
        { 'Retry-After': retryAfter },
      );
    }
    // Acquire a permit.
    counts.set(userId, current + 1);
    let released = false;
    const release = (): void => {
      if (released) return; // idempotent — cancel + error can both signal.
      released = true;
      const n = (counts.get(userId) ?? 1) - 1;
      if (n <= 0) counts.delete(userId);
      else counts.set(userId, n);
    };

    try {
      await next();
    } catch (err) {
      // Residual throw path ONLY: a throw raised BEFORE the response is dispatched, or a non-Error that
      // Hono re-throws past its onError. With a global onError registered, a normal downstream throw is
      // caught by Hono internally and `next()` RETURNS (see the c.error branch below) — this catch does
      // NOT fire for that case. Kept so a pre-dispatch throw still frees the permit immediately.
      release();
      throw err;
    }

    // The handler threw AND Hono's global onError swallowed it (the common case): `await next()` returned
    // without rejecting, but `c.error` is set (Hono stashes the thrown error there before onError runs).
    // The error envelope is a non-200/206 response, so the success-gate below would also release it — but
    // detect c.error explicitly so the intent (a thrown handler must not hold a permit) is unambiguous.
    if (c.error) {
      release();
      return;
    }

    // Hold the permit across the response body ONLY for a GENUINE streaming SUCCESS (a 200 full GET or a
    // 206 Range — the client could still be reading those bytes). EVERY other status — an error envelope
    // (304/400/403/404/416/500) or a bodyless response — releases NOW: those tiny bodies may never be
    // consumed, so gating their release on consumption would let a user pin their own per-user budget
    // with unread error responses (a bounded self-DoS).
    const body = c.res.body;
    const isStreamingSuccess = c.res.status === 200 || c.res.status === 206;
    if (body && isStreamingSuccess) {
      // Wrap the response body in a passthrough whose end/error/cancel release the permit. We pull the
      // original through a fresh ReadableStream so a normal end (done), an error, AND a client cancel
      // (disconnect) all funnel to `release` — exactly once. The wrapped stream is set back as the body.
      c.res = new Response(wrapBodyForRelease(body, release), c.res);
    } else {
      release();
    }
  };
}

/**
 * Wrap a response `ReadableStream` so `release` fires exactly once when the stream ends, errors, or is
 * cancelled (client disconnect). Returns a NEW stream piped from the source; the source is fully
 * consumed/cancelled in lockstep, so no bytes are lost and no permit is leaked.
 */
function wrapBodyForRelease(
  source: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          release(); // normal end of stream.
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        // The source errored mid-stream → surface it + free the permit.
        controller.error(err);
        release();
      }
    },
    cancel(reason) {
      // The CONSUMER cancelled (the client disconnected mid-stream). Cancel the source + free the
      // permit — this is the no-leak-on-disconnect guarantee.
      release();
      return reader.cancel(reason);
    },
  });
}

/** Default per-user concurrent-stream cap (a generous bound for a single human's parallel players). */
export const DEFAULT_MAX_STREAMS_PER_USER = 4;
/** Default Retry-After (seconds) advertised when a user saturates their stream budget. */
export const DEFAULT_RETRY_AFTER_SECONDS = 5;

// A typed context-var augmentation for the resource the media token authorizes (read by the handler).
declare module 'hono' {
  interface ContextVariableMap {
    /** The OPAQUE resource reference the verified media token authorizes (playback). */
    mediaResource?: string;
  }
}

// Re-export ApiError so the registration site can reference the same error class without a second import.
export { ApiError };
