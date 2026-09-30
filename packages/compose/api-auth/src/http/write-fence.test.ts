/**
 * The HTTP half of the source fence, driven through a real Hono app.
 *
 *  - Open: a mutation runs and is counted in flight until it ends (for a streaming one, until the
 *    stream ends); a read is never counted.
 *  - Fenced: a mutation is refused with 503 SERVICE_UNAVAILABLE, a Retry-After header and the platform
 *    envelope, and its handler never runs; a read still answers; a new event stream is refused.
 *  - Draining: an open event stream closes after the chunk in flight. A read stream is cancelled; a
 *    mutation's stream keeps running behind the closed client stream and stays counted until the
 *    handler producing it has finished — the drain waits for the run it started, not for its client.
 *  - A declared route whose action writes carries `writeRouteGuard`, so a GET to it is fenced like a
 *    mutation: refused while fenced, counted while it runs.
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
  writeRouteGuard,
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
  // A run behind a stream: it takes about 300 ms and does not stop when its client goes away.
  const runSteps: number[] = [];
  let runFinished = false;
  let releaseRunStart: () => void = () => {};
  let holdRunStart = false;
  const run = (c: Parameters<Parameters<typeof a.get>[1]>[0]) =>
    streamSSE(c, async (s) => {
      for (let i = 0; i < 30; i++) {
        runSteps.push(i);
        await s.writeSSE({ data: String(i) });
        await s.sleep(10);
      }
      runFinished = true;
    });
  a.post('/run-stream', async (c) => {
    if (holdRunStart) {
      await new Promise<void>((r) => {
        releaseRunStart = r;
      });
    }
    return run(c);
  });
  // Declared routes whose action writes, on a safe method: the route guard fences them.
  const guard = writeRouteGuard(fence);
  a.get('/notes/1/remove', guard, (c) => {
    ran.push('get-remove');
    return c.json({ removed: true });
  });
  a.get('/notes/run', guard, run);
  return {
    a,
    ran,
    releaseSlow: () => releaseSlow(),
    runSteps,
    runFinished: () => runFinished,
    holdRunStart: () => {
      holdRunStart = true;
    },
    releaseRunStart: () => releaseRunStart(),
  };
}

const until = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

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

  it('closes a mutation stream when the drain starts, and counts it until the run behind it has ended', async () => {
    const fence = new TestFence();
    const { a, runSteps, runFinished } = app(fence);
    const res = await a.request('/run-stream', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // A POST stream is a mutation: counted for as long as its work runs, not just its handler.
    expect(fence.inFlight).toBe(1);
    setTimeout(() => fence.startDrain(), 60);
    const text = await readAll(res);
    // The client's stream closed at the drain, long before the run's 30 steps were written.
    expect(text).toContain('data: 0');
    expect(text).not.toContain('data: 29');
    expect(runFinished()).toBe(false);
    // The run keeps going behind it and is still counted: the drain is not over.
    expect(fence.inFlight).toBe(1);
    await until(() => fence.inFlight === 0);
    expect(runFinished()).toBe(true);
    expect(runSteps).toHaveLength(30);
  });

  it('counts a mutation stream until its run ends when the client goes away first', async () => {
    const fence = new TestFence();
    const { a, runFinished } = app(fence);
    const res = await a.request('/run-stream', { method: 'POST' });
    const reader = res.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(runFinished()).toBe(false);
    expect(fence.inFlight).toBe(1);
    await until(() => fence.inFlight === 0);
    expect(runFinished()).toBe(true);
  });

  it('passes on the stream of a mutation admitted before the fence, counted, instead of a false 503', async () => {
    const fence = new TestFence();
    const { a, holdRunStart, releaseRunStart, runFinished } = app(fence);
    holdRunStart();
    const pending = a.request('/run-stream', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 20));
    expect(fence.inFlight).toBe(1);
    // The fence is taken after the request was admitted and before its stream is formed.
    fence.startDrain();
    releaseRunStart();
    const res = await pending;
    expect(res.status).toBe(200);
    await readAll(res);
    await until(() => fence.inFlight === 0);
    expect(runFinished()).toBe(true);
  });

  it('fences a declared writing route on a safe method as a mutation', async () => {
    const fence = new TestFence();
    const { a, ran, runFinished } = app(fence);
    // Open: admitted and counted until its run ends.
    const res = await a.request('/notes/run');
    expect(res.status).toBe(200);
    expect(fence.inFlight).toBe(1);
    await readAll(res);
    await until(() => fence.inFlight === 0);
    expect(runFinished()).toBe(true);
    expect((await a.request('/notes/1/remove')).status).toBe(200);
    expect(ran).toEqual(['get-remove']);

    // Fenced: refused before the handler, for GET and HEAD alike; a plain read still answers.
    fence.admits = false;
    for (const method of ['GET', 'HEAD']) {
      const refused = await a.request('/notes/1/remove', { method });
      expect(refused.status).toBe(503);
      expect(refused.headers.get('retry-after')).toBe('7');
    }
    expect((await a.request('/notes/run')).status).toBe(503);
    expect(ran).toEqual(['get-remove']);
    expect(fence.inFlight).toBe(0);
    expect((await a.request('/items')).status).toBe(200);
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
