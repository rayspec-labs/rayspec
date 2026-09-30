/**
 * The HTTP half of the source fence, driven through a real Hono app.
 *
 *  - Open: a mutation runs and is counted in flight until it ends (for a streaming one, until the
 *    stream ends); a read is never counted.
 *  - Fenced: a mutation is refused with 503 SERVICE_UNAVAILABLE, a Retry-After header and the platform
 *    envelope, and its handler never runs; a read still answers; a new event stream is refused.
 *  - Draining: an open event stream closes after the chunk in flight, and its count ends with it.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../app-context.js';
import { requestId } from './middleware.js';
import {
  closeOnDrain,
  FENCED_MESSAGE,
  type WriteFence,
  writeFenceMiddleware,
} from './write-fence.js';

class TestFence implements WriteFence {
  admits = true;
  inFlight = 0;
  #drain = new AbortController();
  admitsWrites(): boolean {
    return this.admits;
  }
  retryAfterSeconds(): number {
    return 7;
  }
  begin(): () => void {
    this.inFlight += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.inFlight -= 1;
    };
  }
  drainSignal(): AbortSignal {
    return this.#drain.signal;
  }
  startDrain(): void {
    this.admits = false;
    this.#drain.abort();
  }
}

function app(fence: TestFence) {
  const ran: string[] = [];
  let releaseSlow: () => void = () => {};
  const a = new Hono<AppEnv>();
  a.use('*', requestId);
  a.use('*', writeFenceMiddleware(fence));
  a.get('/items', (c) => c.json({ items: [] }));
  a.post('/items', (c) => {
    ran.push('post');
    return c.json({ ok: true }, 201);
  });
  a.delete('/items/1', (c) => {
    ran.push('delete');
    return c.body(null, 204);
  });
  a.post('/slow', async (c) => {
    await new Promise<void>((r) => {
      releaseSlow = r;
    });
    return c.json({ ok: true });
  });
  const stream = (c: Parameters<Parameters<typeof a.get>[1]>[0]) =>
    streamSSE(c, async (s) => {
      for (let i = 0; i < 1000 && !s.aborted; i++) {
        await s.writeSSE({ data: String(i) });
        await s.sleep(10);
      }
    });
  a.get('/events', stream);
  a.post('/run-stream', stream);
  return { a, ran, releaseSlow: () => releaseSlow() };
}

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

describe('the write fence middleware', () => {
  it('admits a mutation while open and counts it until its handler ends', async () => {
    const fence = new TestFence();
    const { a, releaseSlow } = app(fence);
    const pending = a.request('/slow', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fence.inFlight).toBe(1);
    releaseSlow();
    expect((await pending).status).toBe(200);
    expect(fence.inFlight).toBe(0);
    // A read is never counted.
    expect((await a.request('/items')).status).toBe(200);
    expect(fence.inFlight).toBe(0);
  });

  it('refuses every mutating method with 503, Retry-After and the envelope, before the handler', async () => {
    const fence = new TestFence();
    fence.admits = false;
    const { a, ran } = app(fence);
    for (const [path, method] of [
      ['/items', 'POST'],
      ['/items/1', 'DELETE'],
      ['/items', 'PUT'],
      ['/items', 'PATCH'],
    ] as const) {
      const res = await a.request(path, { method, headers: { 'x-request-id': 'req-1' } });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('7');
      expect(await res.json()).toEqual({
        error: { code: 'SERVICE_UNAVAILABLE', message: FENCED_MESSAGE, requestId: 'req-1' },
      });
    }
    expect(ran).toEqual([]);
    expect(fence.inFlight).toBe(0);
  });

  it('keeps answering reads while fenced', async () => {
    const fence = new TestFence();
    fence.admits = false;
    const { a } = app(fence);
    const res = await a.request('/items');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect((await a.request('/items', { method: 'HEAD' })).status).toBe(200);
  });

  it('refuses a new event stream while fenced', async () => {
    const fence = new TestFence();
    fence.admits = false;
    const { a } = app(fence);
    const res = await a.request('/events');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('7');
  });

  it('closes an open stream when the drain starts, and ends its in-flight count with it', async () => {
    const fence = new TestFence();
    const { a } = app(fence);
    const res = await a.request('/run-stream', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // A POST stream is a mutation: counted for as long as its body runs, not just its handler.
    expect(fence.inFlight).toBe(1);
    setTimeout(() => fence.startDrain(), 60);
    const started = Date.now();
    const text = await readAll(res);
    // Closed by the drain long before the producer's 1000 events (about 10 s) would have ended it.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(text).toContain('data: 0');
    expect(text).not.toContain('data: 999');
    expect(fence.inFlight).toBe(0);
  });

  it('closes a read stream on the drain too, without ever counting it', async () => {
    const fence = new TestFence();
    const { a } = app(fence);
    const res = await a.request('/events');
    expect(fence.inFlight).toBe(0);
    setTimeout(() => fence.startDrain(), 40);
    const text = await readAll(res);
    expect(text).toContain('data: 0');
    expect(text).not.toContain('data: 999');
  });
});

describe('closeOnDrain', () => {
  it('passes a stream through untouched when no drain comes, and ends once', async () => {
    let ends = 0;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('a'));
        c.enqueue(new TextEncoder().encode('b'));
        c.close();
      },
    });
    const wrapped = closeOnDrain(source, new AbortController().signal, () => {
      ends += 1;
    });
    expect(await new Response(wrapped).text()).toBe('ab');
    expect(ends).toBe(1);
  });

  it('closes at once when the drain already started', async () => {
    let cancelled = false;
    let ends = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const drain = new AbortController();
    drain.abort();
    const wrapped = closeOnDrain(source, drain.signal, () => {
      ends += 1;
    });
    expect(await new Response(wrapped).text()).toBe('');
    expect(cancelled).toBe(true);
    expect(ends).toBe(1);
  });
});
