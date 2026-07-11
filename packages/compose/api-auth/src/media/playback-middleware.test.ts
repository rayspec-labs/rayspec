/**
 * `perUserStreamSemaphore` permit-RELEASE unit tests (hardening). The semaphore's documented
 * contract is "a permit is held only across a GENUINE streaming success; every non-stream/error/throw
 * outcome releases immediately." These tests prove that contract on the in-process `app.request()` path
 * (which does NOT auto-drain a response body), driving the permit `counts` Map directly so the assertion
 * is on ground truth: the per-user count returns to 0.
 *
 * fail-the-fix: each test goes RED on the OLD release-gating (which held the permit
 * whenever `c.res.body` was truthy — including a non-2xx error envelope and the onError-swallowed-throw
 * 500 envelope — until the client CONSUMED that tiny body → a bounded per-user self-DoS).
 */
import { type ErrorCode, errorEnvelope } from '@rayspec/auth-core';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../app-context.js';
import { perUserStreamSemaphore } from './playback-middleware.js';

/** The outcomes the test handler can produce — an error envelope, a throw, or a streaming success. */
type Outcome =
  | { kind: 'error'; status: 403 | 404 | 416; code: ErrorCode }
  | { kind: 'throw' }
  | { kind: 'stream'; bytes: number[] };

/**
 * Build a minimal app: pre-set a `principal` (the semaphore keys off `userId`), then the semaphore with
 * an INJECTED counts Map, then a handler that produces the requested outcome. A GLOBAL onError is
 * registered (as production does in app.ts) so the throw-after-next path is exercised faithfully.
 */
function buildApp(outcome: Outcome, counts: Map<string, number>, maxPerUser = 4) {
  const app = new Hono<AppEnv>();
  // Pre-set the principal (mediaAuth would do this in production; here we stub it).
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-req');
    c.set('principal', { kind: 'apikey', userId: 'user-1', orgId: 'org-1', scopes: [] });
    await next();
  });
  app.use('*', perUserStreamSemaphore({ counts, maxPerUser }));
  app.get('/p', (c) => {
    if (outcome.kind === 'error') {
      return c.json(
        errorEnvelope(outcome.code, 'denied', 'test-req'),
        outcome.status as ContentfulStatusCode,
      );
    }
    if (outcome.kind === 'throw') {
      throw new Error('handler exploded');
    }
    // A genuine streaming success: a 200 with a ReadableStream body.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(outcome.bytes));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  });
  // The production-faithful global error handler: swallows the throw → a 500 envelope.
  app.onError((_err, c) =>
    c.json(errorEnvelope('INTERNAL', 'Internal server error.', 'test-req'), 500),
  );
  return app;
}

describe('perUserStreamSemaphore — permit release (hardening)', () => {
  it('releases the permit for an UNREAD error response (416/403/404) — no self-DoS pin', async () => {
    // RED on the OLD gating: an error envelope has a truthy body → it was wrapped-and-held until the
    // tiny body was consumed; firing cap+N unread errors pinned the per-user budget.
    const counts = new Map<string, number>();
    const cap = 4;
    for (const o of [
      { kind: 'error', status: 416, code: 'VALIDATION_ERROR' },
      { kind: 'error', status: 403, code: 'FORBIDDEN' },
      { kind: 'error', status: 404, code: 'NOT_FOUND' },
      { kind: 'error', status: 416, code: 'VALIDATION_ERROR' },
      { kind: 'error', status: 403, code: 'FORBIDDEN' },
      { kind: 'error', status: 404, code: 'NOT_FOUND' },
    ] as const) {
      const app = buildApp(o, counts, cap);
      const res = await app.request('/p');
      expect(res.status).toBe(o.status);
      // Deliberately do NOT read res.body — the OLD code held the permit until consumption.
    }
    // After cap+2 unread error responses the per-user permit count must be back to 0 (the key is deleted).
    expect(counts.get('user-1') ?? 0).toBe(0);
  });

  it('releases the permit when the handler THROWS and the global onError swallows it (unread 500)', async () => {
    // RED on the OLD gating: with a global onError, `await next()` RETURNS (the local catch never fires),
    // c.res is the 500 envelope (truthy body) → it was held until the client consumed the 500 body.
    const counts = new Map<string, number>();
    const app = buildApp({ kind: 'throw' }, counts);
    const res = await app.request('/p');
    expect(res.status).toBe(500);
    // Do NOT read the 500 body — the permit must already be released via the c.error / non-2xx path.
    expect(counts.get('user-1') ?? 0).toBe(0);
  });

  it('HOLDS the permit across a streaming 200, then releases when the body is fully consumed', async () => {
    const counts = new Map<string, number>();
    const app = buildApp({ kind: 'stream', bytes: [1, 2, 3, 4] }, counts);
    const res = await app.request('/p');
    expect(res.status).toBe(200);
    // The stream success holds a permit while the body is still readable.
    expect(counts.get('user-1') ?? 0).toBe(1);
    // Consume the whole body → the wrapped stream's `done` releases the permit.
    const back = new Uint8Array(await res.arrayBuffer());
    expect([...back]).toEqual([1, 2, 3, 4]);
    expect(counts.get('user-1') ?? 0).toBe(0);
  });

  it('releases the permit on a client DISCONNECT (reader.cancel mid-stream) — no leak', async () => {
    const counts = new Map<string, number>();
    const app = buildApp({ kind: 'stream', bytes: [9, 9, 9] }, counts);
    const res = await app.request('/p');
    expect(res.status).toBe(200);
    expect(counts.get('user-1') ?? 0).toBe(1);
    // Simulate the client disconnecting mid-stream: cancel the response body's reader without draining.
    const reader = res.body?.getReader();
    await reader?.cancel('client gone');
    expect(counts.get('user-1') ?? 0).toBe(0);
  });

  it('the (N+1)th concurrent permit is rejected 429 + Retry-After; the rejection does NOT consume a slot', async () => {
    const counts = new Map<string, number>();
    const cap = 2;
    // Pre-fill the per-user count to the cap (two streams already open).
    counts.set('user-1', cap);
    const app = buildApp({ kind: 'stream', bytes: [1] }, counts, cap);
    const res = await app.request('/p');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    // The 429 must NOT have acquired a permit (the count is unchanged at the cap, not cap+1).
    expect(counts.get('user-1')).toBe(cap);
  });
});
